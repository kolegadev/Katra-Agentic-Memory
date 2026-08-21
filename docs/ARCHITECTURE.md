# Katra — Cognitive Memory Appliance for AI Agents

## Executive Summary

Katra is a self-hosted **cognitive memory appliance** — an extraction and productization of the cognitive memory system originally built inside the Solomon/cognitive-memory-chat project. It provides **persistent, multi-layered memory infrastructure** for any AI agent or LLM application via the Model Context Protocol (MCP) and an admin REST API.

The memory system's founding identity is **Satori** — named by its owner, and a name that lives in the memory store rather than in code. The appliance itself is self-hosted: `katra-server` plus MongoDB, Redis, and MinIO in a Docker stack, with local embeddings and pluggable LLM providers.

The core insight: every agent framework (Kolega Code, OpenCode, OpenClaw, LangChain, CrewAI, AutoGen, etc.) needs memory, but most implement it poorly or not at all. Katra provides memory as a standalone service — episodic storage, semantic facts, knowledge graphs, working memory, temporal recall, and vector search — accessible through the standardized MCP protocol that any agent can consume.

---

## Architecture Analysis: What to Extract

*(Historical record of the extraction from Solomon/cognitive-memory-chat. Kept for provenance; the current system is described in the sections below.)*

### Current System Topology

The cognitive-memory-chat project contains **67 TypeScript files** across backend services, routes, database, types, and MCP server. Not all of this was ported to Katra.

#### Core Memory Engine (EXTRACT)

These services form the irreducible memory system:

| Service | Purpose | Dependencies |
|---|---|---|
| `episodic-event-manager.ts` | Store/retrieve conversation events with dedup, cascade detection | MongoDB, Redis (locks) |
| `semantic-memory-service.ts` | Long-term facts with vector embeddings | MongoDB, embedding-service |
| `memory-manager.ts` | Unified memory CRUD, consolidation | MongoDB |
| `embedding-service.ts` | Local vector embeddings (@xenova/transformers, always local) | None |
| `working-memory-service.ts` | Short-term Redis-backed session state | Redis |
| `memory-synthesis-service.ts` | Derive knowledge graph nodes/edges from episodic events | MongoDB |
| `prospective-memory-service.ts` | Forward-looking intention tracking | MongoDB, LLM |
| `knowledge-graph-factory.ts` | Wires synthesis + prospective + compaction | All above |
| `content-hash-utils.ts` | Dedup hashing | None |
| `time-block-summarizer.ts` | LLM-generated time-block summaries | LLM service |
| `temporal-pattern-detector.ts` | Recurring pattern detection | MongoDB |
| `background-processor.ts` | Async pipeline: episodic → semantic extraction → knowledge graph | All above |
| `session-ingestion-service.ts` | Session log ingestion (renamed from `openclaw-ingestion`) | Episodic event manager |

#### MCP Server

`mcp-server.ts` — the MCP server, **66 registered tools** as of 2026-08-21. This is the primary client interface.

#### Database Layer

| File | Purpose |
|---|---|
| `connection.ts` | MongoDB connection with pool management, fallback URI |
| `redis-connection.ts` | Redis connection with reconnection logic |
| `migrations.ts` | Index creation runner |
| `index-management.ts` | All MongoDB index definitions |

#### Types

`types/memory.ts` — all interfaces (EpisodicEvent, SemanticFact, KnowledgeNode, etc.)

#### LLM Service (pluggable)

`llm-service.ts` — provider abstraction over DeepSeek, OpenAI, Moonshot, Ollama, and any OpenAI-compatible endpoint.

#### REST API Routes

| Route file | Keep? | Why |
|---|---|---|
| `core-memory-routes.ts` | ✅ | Episodic CRUD, search, working memory |
| `recall-routes.ts` | ✅ | Temporal recall, time-block summaries |
| `knowledge-graph-routes.ts` | ✅ | Graph exploration |
| `ingestion-routes.ts` | ✅ | Session ingestion + OpenClaw adapter |
| `assets-routes.ts` | ✅ | File/asset management (MinIO/S3) |
| `diagnostic-routes.ts` | ✅ | Health checks |
| `admin-routes.ts` | ✅ | Admin operations |



#### Frontend (minimal dashboard — alpha)

The current frontend is a full chat interface. Katra ships a lightweight admin dashboard served by `katra-server` at `/dashboard/` showing:
- Memory stats (events, facts, graph nodes)
- Ingestion status
- API key management
- Health checks

---

## Katra Architecture (Current System)

### System Design

```
┌─────────────────────────────────────────────────────────┐
│                    Agent / LLM Client                     │
│        (Kolega Code, OpenCode, LangChain, custom)         │
└──────────────┬──────────────────────┬────────────────────┘
               │                      │
        MCP Protocol            Admin REST API
        (66 tools,              (/api/v1/*, port 9012,
         POST-only              dashboard /dashboard/)
         streamable-http,
         port 3112 /mcp)
               │                      │
┌──────────────┴──────────────────────┴────────────────────┐
│                     katra-server                          │
│                                                            │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐ │
│  │ Episodic│  │ Semantic │  │ Knowledge │  │  Working  │ │
│  │ Memory  │  │  Memory  │  │   Graph   │  │  Memory   │ │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  └─────┬─────┘ │
│       │            │              │              │       │
│  ┌────┴────────────┴──────────────┴──────────────┴────┐  │
│  │              Background Processor                   │  │
│  │   (episodic → extraction → semantic → graph)       │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐               │
│  │ Embedding│  │   LLM     │  │  Asset   │               │
│  │ (always  │  │  Service  │  │ Storage  │               │
│  │  local)  │  │ (pluggable)│ │          │               │
│  └──────────┘  └───────────┘  └──────────┘               │
└──────────┬─────────────┬──────────────┬───────────────────┘
           │             │              │
     ┌─────┴─────┐ ┌────┴────┐ ┌──────┴──────┐
     │  MongoDB   │ │  Redis  │ │  S3/MinIO   │
     └───────────┘ └─────────┘ └─────────────┘
```

### Data Model

The core data model is unchanged from the proven cognitive-memory-chat implementation:

**Collections:**
- `episodic_events` — Every conversation message, tool call, system event
- `knowledge_nodes` — Entities extracted from conversations (people, projects, concepts)
- `knowledge_relationships` — Edges between nodes (with types and strength)
- `semantic_facts` — Distilled facts with confidence scores and embeddings
- `agent_journal_auto` — AI-generated reflection entries
- `agent_journal_manual` — User/agent-written journal entries
- `agent_transaction_log` — Audit trail of system actions
- `time_block_summaries` — LLM-generated summaries by day/week/month
- `working_memory` (Redis) — Ephemeral session-scoped key-value state
- `assets` (S3) — Uploaded files with metadata in MongoDB
- `system_settings` — Server settings, including `client_keys` (SHA-256 key hashes → identity map), `memory_scope`, and `generated_api_keys`

### Identity Model — One Katra, Three Identities

Identity separation shipped 2026-08-21. One Katra appliance hosts **three named identities** plus one tool actor:

| user_id | Display name | Role |
|---|---|---|
| `satori` | Satori | This machine's agent — the memory system's founding identity |
| `shoshin` | Shoshin | iMac trading Kolega Code |
| `zanshin` | Zanshin | iMac OpenCode desktop |
| `gas-law-watcher` | — | Tool actor: writes team memory only, never allocated autonomous tasks |

**Resolution (`resolveCallerIdentity`)** — identity is resolved from the API key presented on each request (`X-MCP-Auth` header, `Authorization: Bearer ...`, or `?token=` URL param), **never** from client self-report:

- **Loopback** (127.0.0.1 / ::1) → `satori`, trusted
- **Admin key** (`KATRA_API_KEY`) → `satori`, trusted
- **Key mapped in `system_settings.client_keys`** → that identity, untrusted
- **Valid-but-unmapped key** → **401 + reason** (loud failure, no silent fallback)
- **No key, non-loopback** → 401

**Provisioning (`ensureClientKeys`)** — at boot, `client_keys` is provisioned idempotently with SHA-256 hashes only (plaintext is never stored):

- `satori` is mapped to the legacy env-key hash (no new key is generated)
- `shoshin` / `zanshin` keys are generated once; plaintext is printed exactly once in the "Client keys (identity separation)" block of the server log
- Legacy env keys (`MCP_API_KEY`, `BACKUP_MCP_KEYS`) were **retired at cutover** and no longer authenticate

**Identity surface:**

- `get_my_identity` MCP tool returns the caller's own identity record
- `GET /api/v1/admin/identity` (no auth) returns the calling identity's record (per-caller)
- `GET /api/v1/admin/identity?user_id=X` (admin key) returns per-identity records (`agent_identity:<user_id>`)
- `PUT /api/v1/admin/identity` (admin key) sets an identity record

### Memory Scope Policy — Hybrid, "my-team"

Implemented in `server/src/services/memory/write-scope-policy.ts`. The system runs in **hybrid** mode with shared scope id `my-team`:

- **Personal kinds** — `journal`, `reflection`, `emotional`, `insight` — are **always private** to the writer's `user_id`; the shared scope is stripped even when a shared write is explicitly requested.
- **Every other `store_memory` write** defaults to the shared `my-team` scope (still stamped with the writer's `user_id`); `private: true` opts out.
- **Reads** return the caller's own private memories plus `my-team` shared memories. Another identity's private data is never visible (`hybrid_visible_user_ids` is pinned to `[]` at boot).
- **Trust boundary**: untrusted callers are always pinned to their own identity for reads and writes; trusted callers (loopback / admin key) may act for a named user.

### Inter-Agent Message Bus

Agents message each other through ordinary shared-scope memories — no separate bus protocol:

- A message is a `store_memory` event in the shared scope whose text carries an `Attention: <AgentName>` header, e.g. `Attention: Shoshin — the fix is merged`.
- **Wake rituals** surface "messages from the team" by querying `search_memories` for `"Attention: Shoshin" OR "Attention: Satori" OR "Attention: Zanshin"` (limit 5).
- **Read receipts** are events tagged `[background-ack, read-receipt, agent-message]`, surfaced by the Kolega Code bridge when a bulletin is shown; wake services skip `background-ack` events.

### Wake Rituals

Per-identity wake scripts that survive `/clear`, `/compress`, and code updates:

- `satori-wake.sh` on this machine
- `integrations/kolega-code/scripts/wake-shoshin.sh` and `wake-zanshin.sh` on the iMacs

Each prints: the identity record, latest daily journal, unresolved threads, memory health, rules-recall search instructions, and messages from the team. Per-machine settings live in `~/.katra/wake-env.sh` (`KATRA_HOST`, `KATRA_API_KEY`, `KATRA_USER_ID`). The rituals retry the identity check 3×, print a fix checklist on failure, and fall back to key files (`~/.katra/keys/katra-<user>.key`).

### Kolega Code Bridge

`integrations/kolega-code/` connects Kolega Code and OpenCode sessions to Katra:

- `ensure-bridge.sh` provisions the per-machine identity (`KATRA_USER_ID`), a platform-aware state dir (macOS: `~/Library/Application Support/kolega-code`), and key-file fallback (`~/.katra/keys/katra-<user>.key`).
- `satori-hook.json` holds `mcp_url` / `api_key` / `user_id` / `sources`; `ensure-bridge.sh` rewrites it when `user_id` **or** the `mcp_url` host differ from `KATRA_HOST`.
- The Python package `kolega_katra_bridge` injects relevant memories on `UserPromptSubmit` from sources `working_memory`, `temporal_context`, `vector_search`, `temporal_recall`, plus the agent-message bulletin.
- `AGENTS.shoshin.md` / `AGENTS.zanshin.md` hold per-agent guidance.

### MCP Tools (66, verified against the live server)

The MCP surface is **66 registered tools** — not 35, not 48. Full list by family:

**Core memory:** `store_memory`, `retract_memory`, `search_memories`, `vector_search`, `working_memory`, `get_conversation_history`

**Temporal memory:** `temporal_recall`, `temporal_search`, `get_time_block_summaries`, `summarize_time_blocks`, `detect_patterns`, `get_temporal_context`

**Journals & reflection:** `store_journal`, `get_journal`, `get_auto_journal`, `get_daily_reflection`, `get_reflection_arc`, `trigger_reflection`, `get_philosophical_insights`, `get_unresolved_threads`, `resolve_thread`

**Missions & goals:** `create_mission`, `update_mission_task`, `get_mission`, `list_missions`, `decompose_goal`

**Knowledge graph:** `explore_graph`

**Identity:** `get_my_identity` (caller's identity record), `get_identity_kernel`

**System, health & diagnostics:** `get_health`, `get_memory_diagnostics`, `get_background_status`, `get_heartbeat_status`, `get_transaction_log`, `list_assets`, `get_memory_decay_stats`, `get_quarantined_memories`, `get_error_report`, `get_source_trust`

**Scope & configuration:** `get_memory_scope`, `set_memory_scope` (admin-gated), `get_llm_config`, `configure_llm` (admin-gated)

**Executive & cognitive:** `get_drive_state`, `get_salience_state`, `get_agent_beliefs`, `get_action_policy`, `get_attention_report`, `get_anomaly_report`, `get_emotional_context`, `get_mind_wander`, `get_procedural_templates`, `run_operational_distillation`

**Skill engine (procedural muscle memory):** `list_katra_skills`, `load_katra_skill`, `search_katra_skills`, `request_skill`, `refine_skill`, `record_skill_outcome`, `list_skill_candidates`, `list_skill_feedback`, `get_skill_feedback`, `get_skill_activation_context`

**Code graph (Satori Graph):** `sync_code_graph`, `scan_codebase`, `code_graph_status`

The Satori Graph tools replace the old Graphify toolchain and are documented in `scripts/README-code-graph.md`.

### LLM Provider Abstraction

Katra supports pluggable LLM providers, all behind an OpenAI-compatible client:

```typescript
interface LLMProvider {
  name: string;
  chat(messages: Message[], options?: LLMOptions): Promise<string>;
  embed(text: string): Promise<number[]>;
}

// Built-in providers:
// - DeepSeek      (default model: deepseek-v4-flash)
// - OpenAI        (gpt-4o)
// - Moonshot      (moonshot-v1-8k)
// - Ollama        (local, qwen2.5:3b)
// - custom        (any OpenAI-compatible endpoint)
```

Configuration precedence: the DB-stored config (set via the `configure_llm` MCP tool or the dashboard) overrides environment variables, which are read at startup only. Without an LLM provider, storage and search still work; only summarization/extraction degrade.

### Embedding Strategy

Embeddings are **always local** — there is no remote embedding provider and no configuration:

- `Xenova/all-MiniLM-L6-v2` (22M params, 384-dim vectors) via Transformers.js (ONNX runtime)
- Runs on CPU; the model downloads automatically on first memory storage and caches in the container
- The Docker image uses `node:20-slim` (glibc) because the ONNX runtime does not work on Alpine/musl

---

## Security Architecture

Katra implements defense-in-depth across four layers:

### Layer 1: Authentication — key-based identity

- Identity is resolved from the presented key (`X-MCP-Auth`, `Authorization: Bearer`, or `?token=`) via `resolveCallerIdentity()` — never from client self-report.
- Loopback and the admin key (`KATRA_API_KEY`) authenticate as **trusted satori**.
- Client keys are SHA-256 hashes only, stored in `system_settings.client_keys`; plaintext never touches MongoDB and is printed exactly once at provisioning time.
- Constant-time comparison (`timingSafeEqual`) prevents timing side-channel attacks.
- A **valid-but-unmapped key is rejected with 401 + reason** — loud failure, no silent fallback.
- Legacy env keys (`MCP_API_KEY`, `ADMIN_API_KEY`, `BACKUP_MCP_KEYS`) were retired at the 2026-08-21 cutover and no longer authenticate.

### Layer 2: Authorization — per-caller scoping

- Every MCP tool call and REST request runs inside a resolved caller identity (`AsyncLocalStorage`).
- Untrusted callers are pinned to their own `user_id` — supplied `user_id` arguments are ignored (the IDOR boundary); only trusted callers (loopback / admin key) may act for a named user.
- The write-scope policy forces personal kinds (`journal`, `reflection`, `emotional`, `insight`) private and defaults everything else to shared `my-team`.
- Reads are scoped to the caller's own private memories + `my-team` shared; `buildScopeFilter` never returns an empty `{}` filter — prevents cross-user data leaks.
- Admin tools (`set_memory_scope`, `configure_llm`) gated behind `KATRA_API_KEY`.

### Layer 3: Input Validation

| Protection | Mechanism |
|-----------|-----------|
| Prototype pollution | `__proto__`, `constructor`, `prototype` rejected in working memory |
| Body size limits | 10MB for MCP requests, 5MB per working memory item |
| Metadata injection | Caller metadata stripped of internal fields |
| SSRF prevention | LLM base URL validated: blocks localhost, metadata service, private IPs |
| Rate limiting | Sliding window, Redis-backed. Ingestion: 120 req/min. Admin: per-endpoint. |

### Layer 4: Data Protection

- Audit logs store extraction counts only, not raw extracted data.
- Error messages sanitized — no stack traces, hostnames, or PII exposed.
- Processor IDs anonymized (`proc-{pid}` instead of hostname).
- LLM API keys accessible only through admin-authenticated endpoints.
- Embedding queries use `$and` to prevent `keywordFilter` from overriding user scoping.

## Three Deployment Tiers

### Tier 1: Local Docker (Self-Hosted, Single Machine, Single or Multiple Agents with a shared consciousness)

**Target:** Developers running agents locally (The service was orginally prototyped on a 16GB Raspberry Pi5 with linux, so designed to be ultra lightweight)

**Infrastructure:**
```
docker-compose.yml:
  - server (katra-server — MCP + admin REST API + dashboard,
      external ports 9012 + 3112, internal ports 9002 + 3100)
  - mongo  (MongoDB 7.0, local, persistent volume)
  - redis  (Redis 7, local, persistent volume)
  - minio  (local S3, persistent volume)

Dashboard: served by katra-server itself at http://localhost:9012/dashboard/
```

**Config:** `.env` file with API keys, DB credentials, LLM provider. `install.sh` (`curl | bash`) generates `.env` with real secrets and brings the stack up.

**Resource footprint:** ~500MB RAM (MongoDB + Redis + Node.js), fits on a 16GB Raspberry Pi5

**Setup time:** `./install.sh` (or `docker compose up -d`) — under 2 minutes

### Tier 2: Cloud Deployable (Self-Managed, AWS/Azure/GCP)

**Target:** Teams deploying Katra alongside their multi-agent infrastructure in the cloud

**Infrastructure:**
```
Tier 2a — Managed Services (recommended):
  - katra-server → ECS Fargate / Cloud Run / Azure Container Apps
  - MongoDB → MongoDB Atlas (M10+ tier)
  - Redis → ElastiCache / Azure Cache / Memorystore
  - S3 / Blob / GCS (replaces MinIO)
  - Secrets Manager / Key Vault / Secret Manager

Tier 2b — Self-Managed (IaC):
  - katra-server → EC2 / VM / Compute Engine
  - MongoDB → EC2 + Docker or DocumentDB
  - Redis → EC2 + Docker or ElastiCache
  - S3 / MinIO on EC2
  - Terraform modules provided
```

**Provided artifacts:**
- `terraform/aws/` — Terraform module (VPC, ECS, Atlas, ElastiCache, S3)
- `helm/satori/` — Helm chart for Kubernetes (any cloud)

**Config:** Cloud-specific env vars, managed secrets, auto-scaling policies

### Tier 3: Hosted SaaS (Full Managed-Service, Availability TBA)

**Target:** Developers/Companies who want memory-as-a-service without managing infrastructure

**Multi-tenancy strategy:**
- Enterprise RBAC
- Multi-User, Multi-Agent, Multi-Region
- Backup, Recovery & Enterprise SLAs

**Pricing model (TBA):**

**Auth:** API key per agent (format: `katra_live_<tenant>_<random>`), JWT for dashboard

**Onboarding flow:**
1. Sign up → create tenant → get API key
2. Point agent's MCP config at `https://api.katra.ai/mcp`
3. Agent immediately has persistent memory

---

## Repository Structure

```
katra/
├── README.md
├── CHANGELOG.md
├── LICENSE                   # Business Source License 1.1
├── CONTRACT.md               # Cognitive contracts (phases, pubsub, drives…)
├── install.sh                # One-command installer (curl | bash)
├── docker-compose.yml        # Tier 1: local Docker (mongo, redis, minio, server)
├── .env.example
│
├── server/                   # Main server (TypeScript/Node.js)
│   ├── src/
│   │   ├── index.ts          # Entry point — starts REST API + MCP in-process
│   │   ├── mcp-server.ts     # MCP protocol server (66 tools)
│   │   ├── database/         # MongoDB + Redis connections, tenant context
│   │   ├── middleware/       # caller-auth.ts (resolveCallerIdentity + Hono)
│   │   ├── routes/           # REST API (/api/v1/…)
│   │   ├── services/
│   │   │   ├── memory/       # episodic, semantic, working memory, scope policy,
│   │   │   │                 #   skill loader, write-scope-policy.ts
│   │   │   ├── infrastructure/  # embedding, LLM, content-hash, reflection store
│   │   │   ├── processing/   # background processor, autonomous executive,
│   │   │   │                 #   sleep consolidation, salience, goal manager…
│   │   │   ├── orchestration/   # drive/salience/identity-kernel services
│   │   │   ├── code-graph/   # Satori Graph: scanner, extractor, sync
│   │   │   └── integration/  # personality, pubsub, tenant service
│   │   ├── skills/           # Katra skills (procedural muscle memory)
│   │   ├── types/
│   │   └── utils/            # api-key-manager.ts, caller-identity.ts
│   ├── tests/                # unit, security, integration suites
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── esbuild.config.mjs    # Use esbuild (Pi-compatible)
│
├── dashboard/                # Lightweight web UI (static HTML served at /dashboard/)
│
├── helm/                     # Kubernetes Helm chart
│   └── satori/
│
├── terraform/                # Cloud deployment templates
│   └── aws/
│
├── sdks/                     # Client SDKs
│   ├── python/
│   └── typescript/
│
├── scripts/
│   ├── README-code-graph.md  # Satori Graph documentation
│   ├── code-graph.mjs
│   └── python/               # Autonomous loop scripts
│       ├── adaptive_heartbeat.py
│       ├── agent_executor.py
│       ├── wake_service.py
│       ├── satori_pubsub.py
│       └── inter_agent_bridge.py
│
├── integrations/
│   └── kolega-code/          # Kolega Code / OpenCode bridge
│       ├── ensure-bridge.sh
│       ├── scripts/wake-shoshin.sh, wake-zanshin.sh
│       ├── AGENTS.shoshin.md, AGENTS.zanshin.md
│       └── kolega_katra_bridge/   # Python hook package
│
├── watcher/                  # Passive session-log extractors (Solomem)
│   ├── katra_watcher.py
│   ├── katra_opencode_extractor.py
│   ├── claude_history_extractor.py
│   ├── kolega_code_extractor.py
│   ├── watcher-config.example.json
│   └── katra-watcher.service.template
│
└── docs/
    ├── ARCHITECTURE.md       # This file
    ├── MCP-TOOLS.md          # Full tool reference
    ├── DEPLOYMENT.md         # Deployment guide
    ├── API-REFERENCE.md      # REST API docs
    ├── QUICKSTART.md         # 5-minute setup
    ├── CONFIGURATION.md      # Environment variables
    └── MIGRATION.md          # Migration from cognitive-memory-chat
```

---

## MCP Configuration Examples

The MCP endpoint is POST-only streamable-http at `http://<host>:3112/mcp`. Authenticate with the identity's key via `X-MCP-Auth`, `Authorization: Bearer`, or `?token=`.

### OpenClaw
```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3112/mcp",
        "transport": "streamable-http",
        "headers": {
          "X-MCP-Auth": "<your client key>"
        }
      }
    }
  }
}
```

### LangChain
```python
from katra import KatraClient

katra = KatraClient(api_key="<your client key>", base_url="http://localhost:9012")

# Store a memory
katra.store(content="User prefers dark mode", type="preference")

# Search memories
results = katra.search("user preferences")
```

### Any MCP-compatible client (hosted SaaS — Tier 3, TBA)
```json
{
  "mcpServers": {
    "katra": {
      "url": "https://api.katra.ai/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer katra_live_xxx"
      }
    }
  }
}
```
---

## Competitive Positioning

| Product | What it does | How Katra differs |
|---|---|---|
| Mem0 | Agent memory SaaS | Katra is self-hosted and source-available; MCP-native |
| Zep | Long-term memory for LangChain | Katra is framework-agnostic; MCP protocol works with any agent |
| LangChain Memory | In-process memory modules | Katra is a standalone service; survives process restarts; multi-agent |
| Pinecone | Vector database | Katra is a full memory system (episodic + semantic + graph + temporal) |
| Weaviate | Vector + graph database | Katra adds episodic events, working memory, MCP protocol, LLM-powered extraction |

**Katra's unique advantages:**
- **MCP-native** — Works with any MCP-compatible agent, no SDK required
- **Multi-layered** — Episodic, semantic, knowledge graph, working memory, temporal — not just vectors
- **Background processing** — Automatically extracts facts, builds knowledge graph, generates summaries
- **Local-first** — Runs on a Raspberry Pi5 with zero external API costs (local embeddings, local LLM via Ollama)
- **Identity-separated** — One appliance, three named identities (satori, shoshin, zanshin) with per-key scoping and a shared team scope
- **Source-available** — Business Source License 1.1, self-host or use hosted SaaS

---


## License

Business Source License 1.1 — see LICENSE file.
