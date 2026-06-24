# Katra — Cognitive Memory as a Service for AI Agents

## Executive Summary

Katra is an extraction and productization of the cognitive memory system originally built inside the Solomon/cognitive-memory-chat project. It provides **persistent, multi-layered memory infrastructure** for any AI agent or LLM application via the Model Context Protocol (MCP) and a REST API.

The core insight: every agent framework (OpenClaw, LangChain, CrewAI, AutoGen, etc.) needs memory, but most implement it poorly or not at all. Katra provides memory as a standalone service — episodic storage, semantic facts, knowledge graphs, working memory, temporal recall, and vector search — accessible through the standardized MCP protocol that any agent can consume.

---

## Architecture Analysis: What to Extract

### Current System Topology

The cognitive-memory-chat project contains **67 TypeScript files** across backend services, routes, database, types, and MCP server. Not all of this was ported to Katra.

#### Core Memory Engine (EXTRACT)

These services form the irreducible memory system:

| Service | Purpose | Dependencies |
|---|---|---|
| `episodic-event-manager.ts` | Store/retrieve conversation events with dedup, cascade detection | MongoDB, Redis (locks) |
| `semantic-memory-service.ts` | Long-term facts with vector embeddings | MongoDB, embedding-service |
| `memory-manager.ts` | Unified memory CRUD, consolidation | MongoDB |
| `embedding-service.ts` | Vector embeddings (@xenova/transformers local or OpenAI) | Optional OpenAI |
| `working-memory-service.ts` | Short-term Redis-backed session state | Redis |
| `memory-synthesis-service.ts` | Derive knowledge graph nodes/edges from episodic events | MongoDB |
| `prospective-memory-service.ts` | Forward-looking intention tracking | MongoDB, LLM |
| `knowledge-graph-factory.ts` | Wires synthesis + prospective + compaction | All above |
| `content-hash-utils.ts` | Dedup hashing | None |
| `time-block-summarizer.ts` | LLM-generated time-block summaries | LLM service |
| `temporal-pattern-detector.ts` | Recurring pattern detection | MongoDB |
| `background-processor.ts` | Async pipeline: episodic → semantic extraction → knowledge graph | All above |
| `openclaw-ingestion-service.ts` | Session log ingestion (rename to generic `session-ingestion`) | Episodic event manager |

#### MCP Server (EXTRACT)

`mcp-server.ts` — the 29-tool MCP server. This is the primary client interface.

#### Database Layer (EXTRACT)

| File | Purpose |
|---|---|
| `connection.ts` | MongoDB connection with pool management, fallback URI |
| `redis-connection.ts` | Redis connection with reconnection logic |
| `migrations.ts` | Index creation runner |
| `index-management.ts` | All MongoDB index definitions |

#### Types (EXTRACT)

`types/memory.ts` — all interfaces (EpisodicEvent, SemanticFact, KnowledgeNode, etc.)

#### LLM Service (EXTRACT — make pluggable)

`llm-service.ts` — currently hardcoded to DeepSeek. Must be abstracted to support any OpenAI-compatible provider.

#### REST API Routes (EXTRACT subset)

| Route file | Keep? | Why |
|---|---|---|
| `core-memory-routes.ts` | ✅ | Episodic CRUD, search, working memory |
| `recall-routes.ts` | ✅ | Temporal recall, time-block summaries |
| `knowledge-graph-routes.ts` | ✅ | Graph exploration |
| `ingestion-routes.ts` | ✅ | Session ingestion + OpenClaw adapter |
| `assets-routes.ts` | ✅ | File/asset management (MinIO/S3) |
| `diagnostic-routes.ts` | ✅ | Health checks |
| `admin-routes.ts` | ✅ | Admin operations |



#### Frontend (REBUILD — minimal dashboard only)

The current frontend is a full chat interface. Katra needs only a lightweight admin dashboard showing:
- Memory stats (events, facts, graph nodes)
- Ingestion status
- API key management
- Health checks

---

## Katra Architecture

### System Design

```
┌─────────────────────────────────────────────────────────┐
│                    Agent / LLM Client                     │
│              (OpenClaw, LangChain, custom app)            │
└──────────────┬──────────────────────┬────────────────────┘
               │                      │
        MCP Protocol            REST API
        (29+ tools)            (/api/v1/*)
               │                      │
┌──────────────┴──────────────────────┴────────────────────┐
│                    Katra Server                            │
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
│  │  Service  │  │  Service  │  │ Storage  │               │
│  └──────────┘  └───────────┘  └──────────┘               │
└──────────┬─────────────┬──────────────┬───────────────────┘
           │             │              │
     ┌─────┴─────┐ ┌────┴────┐ ┌──────┴──────┐
     │  MongoDB   │ │  Redis  │ │  S3/MinIO   │
     │ (Atlas/    │ │ (Cloud/ │ │ (S3/MinIO/  │
     │  local)    │ │  local) │ │  R2/Space)  │
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

### MCP Tools (35, expandable)

**Memory Storage:**
- `store_memory` — Store a fact, preference, insight, or event
- `store_journal` — Write a journal entry
- `working_memory` — Read/store/delete short-term session state

**Memory Retrieval:**
- `search_memories` — Full-text keyword search across episodic + semantic
- `vector_search` — Semantic similarity search (concept-level matching)
- `temporal_recall` — Query events by date range
- `temporal_search` — Keyword search within temporal context
- `get_conversation_history` — Retrieve full conversation thread
- `get_auto_journal` — AI-distilled journal entries
- `get_journal` — Manual + auto journal entries
- `get_time_block_summaries` — Pre-computed day/week/month summaries

**Knowledge Graph:**
- `explore_graph` — Traverse nodes and edges
- `get_mission` / `list_missions` — Goal tracking (optional)

**System:**
- `get_temporal_context` — Current session context summary
- `get_memory_diagnostics` — System health and stats
- `get_health` — Service health check
- `get_background_status` — Processor queue status
- `get_heartbeat_status` — (rename to `get_processor_status`)
- `get_transaction_log` — Audit trail
- `list_assets` — Uploaded files
- `detect_patterns` — Recurring temporal patterns
- `summarize_time_blocks` — Trigger summary generation

**Mission/Goal Tracking (optional module):**
- `create_mission` — Create a goal with task breakdown
- `update_mission_task` — Update task status
- `get_mission` / `list_missions` — Query goals

### LLM Provider Abstraction

The current system hardcodes DeepSeek. Katra abstracts this:

```typescript
interface LLMProvider {
  name: string;
  chat(messages: Message[], options?: LLMOptions): Promise<string>;
  embed(text: string): Promise<number[]>;
}

// Built-in providers:
// - OpenAI (GPT-4o, text-embedding-3-small)
// - Anthropic (Claude 3.5 Sonnet)
// - DeepSeek
// - Google Gemini
// - Local (@xenova/transformers — already in the codebase)
// - Any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio)
```

### Embedding Strategy

Three modes, auto-detected from config:
1. **Local** (default, zero-cost): `@xenova/transformers` with `all-MiniLM-L6-v2` — runs on CPU, 384-dim vectors
2. **OpenAI**: `text-embedding-3-small` — 1536-dim, $0.02/1M tokens
3. **Custom endpoint**: Any OpenAI-compatible embedding API

---

## Security Architecture

Katra implements defense-in-depth across four layers:

### Layer 1: Authentication

- API keys hashed with SHA-256, stored in `system_settings`. Plaintext never touches MongoDB.
- Constant-time comparison (`timingSafeEqual`) prevents timing side-channel attacks.
- Dual-key system: `MCP_API_KEY` for agent operations, `KATRA_API_KEY` for admin operations.
- Stdio transport requires `MCP_API_KEY` to be configured — refuses to start without it.
- Keys auto-generated with 256-bit entropy if not provided. Hashes persisted for reuse.

### Layer 2: Authorization

- Every route file has `validateKatraKey` middleware. No unauthenticated data access.
- User identity bound server-side (`DEFAULT_USER_ID`) — never accepted from client body/query.
- Admin tools (`set_memory_scope`, `configure_llm`) gated behind `KATRA_API_KEY`.
- Memory scope service (`buildScopeFilter`) never returns `{}` — prevents cross-user data leaks.

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
  - katra-server (API + MCP, external ports 9012 + 3112, internal ports 9002 + 3100)
  - mongodb (local, persistent volume)
  - redis (local, persistent volume)
  - minio (local S3, persistent volume)
  - katra-dashboard (lightweight web UI, served at `/dashboard` on port 9012)
```

**Config:** `.env` file with API keys, DB credentials, LLM provider

**Resource footprint:** ~500MB RAM (MongoDB + Redis + Node.js), fits on a 16GB Raspberry Pi5

**Setup time:** `docker compose up -d` — under 2 minutes

### Tier 2: Cloud Deployable (Self-Managed, AWS/Azure/GCP)

**Target:** Teams deploying Katra alongside their multi-agent infrastructure in the cloud

**Infrastructure:**
```
Tier 2a — Managed Services (recommended):
  - Katra Server → ECS Fargate / Cloud Run / Azure Container Apps
  - MongoDB → MongoDB Atlas (M10+ tier)
  - Redis → ElastiCache / Azure Cache / Memorystore
  - S3 / Blob / GCS (replaces MinIO)
  - Secrets Manager / Key Vault / Secret Manager

Tier 2b — Self-Managed (IaC):
  - Katra Server → EC2 / VM / Compute Engine
  - MongoDB → EC2 + Docker or DocumentDB
  - Redis → EC2 + Docker or ElastiCache
  - S3 / MinIO on EC2
  - Terraform / Pulumi modules provided
```

**Provided artifacts:**
- `deploy/aws/` — Terraform module (VPC, ECS, Atlas, ElastiCache, S3)
- `deploy/azure/` — Bicep/Terraform (Container Apps, Cosmos DB, Cache, Blob)
- `deploy/gcp/` — Terraform (Cloud Run, Atlas, Memorystore, GCS)
- `deploy/helm/` — Helm chart for Kubernetes (any cloud)
- `deploy/k8s/` — Raw Kubernetes manifests

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
├── LICENSE                   # MIT or Apache 2.0
├── docker-compose.yml        # Tier 1: local Docker
├── docker-compose.saaS.yml   # Tier 3: multi-tenant config
├── .env.example
│
├── server/                   # Main server (TypeScript/Node.js)
│   ├── src/
│   │   ├── index.ts          # Entry point — starts API + MCP
│   │   ├── mcp-server.ts     # MCP protocol server
│   │   ├── database/         # MongoDB + Redis connections
│   │   │   ├── connection.ts
│   │   │   ├── redis.ts
│   │   │   ├── migrations.ts
│   │   │   └── indexes.ts
│   │   ├── services/         # Core memory engine
│   │   │   ├── episodic-event-manager.ts
│   │   │   ├── semantic-memory-service.ts
│   │   │   ├── memory-manager.ts
│   │   │   ├── embedding-service.ts
│   │   │   ├── working-memory-service.ts
│   │   │   ├── memory-synthesis-service.ts
│   │   │   ├── knowledge-graph-factory.ts
│   │   │   ├── background-processor.ts
│   │   │   ├── time-block-summarizer.ts
│   │   │   ├── temporal-pattern-detector.ts
│   │   │   ├── content-hash-utils.ts
│   │   │   ├── session-ingestion-service.ts   # renamed from openclaw-ingestion
│   │   │   └── llm-service.ts  # pluggable provider
│   │   ├── routes/           # REST API
│   │   │   ├── memory-routes.ts
│   │   │   ├── recall-routes.ts
│   │   │   ├── graph-routes.ts
│   │   │   ├── ingestion-routes.ts
│   │   │   ├── asset-routes.ts
│   │   │   ├── admin-routes.ts
│   │   │   └── health-routes.ts
│   │   ├── types/
│   │   │   └── memory.ts
│   │   └── middleware/
│   │       ├── auth.ts       # API key auth (SaaS)
│   │       ├── tenant.ts     # Tenant isolation (SaaS)
│   │       └── rate-limit.ts # Per-tenant rate limiting
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── esbuild.config.mjs    # Use esbuild (Pi-compatible)
│
├── dashboard/                # Lightweight web UI (single-page HTML served at /dashboard)
│   └── index.html
│
├── helm/                     # Kubernetes Helm chart
│   └── katra/
│
├── terraform/                # Cloud deployment templates
│   └── aws/
│
├── sdks/                     # Client SDKs
│   ├── python/
│   └── typescript/
│
├── watcher/                  # Passive session-log extractors (Solomem)
│   ├── katra_watcher.py
│   ├── katra_opencode_extractor.py
│   ├── claude_history_extractor.py
│   ├── kolega_code_extractor.py
│   ├── watcher-config.example.json
│   └── katra-watcher.service
│
├── docs/
│   ├── ARCHITECTURE.md       # This file
│   ├── MCP-TOOLS.md          # Full tool reference
│   ├── DEPLOYMENT.md         # Deployment guide
│   ├── API-REFERENCE.md      # REST API docs
│   ├── QUICKSTART.md         # 5-minute setup
│   ├── CONFIGURATION.md      # Environment variables
│   └── MIGRATION.md          # Migration from cognitive-memory-chat
│
└── scripts/
    ├── migrate-from-solomon.sh  # Migration from cognitive-memory-chat
    └── seed-test-data.ts         # Generate test data
```

---

## MCP Configuration Examples

### OpenClaw
```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3112/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer katra_live_xxx"
        }
      }
    }
  }
}
```

### LangChain
```python
from katra import KatraClient

katra = KatraClient(api_key="katra_live_xxx", base_url="http://localhost:9012")

# Store a memory
katra.store(content="User prefers dark mode", type="preference")

# Search memories
results = katra.search("user preferences")
```

### Any MCP-compatible client
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
| Mem0 | Agent memory SaaS | Katra is open-source with self-host option; MCP-native |
| Zep | Long-term memory for LangChain | Katra is framework-agnostic; MCP protocol works with any agent |
| LangChain Memory | In-process memory modules | Katra is a standalone service; survives process restarts; multi-agent |
| Pinecone | Vector database | Katra is a full memory system (episodic + semantic + graph + temporal) |
| Weaviate | Vector + graph database | Katra adds episodic events, working memory, MCP protocol, LLM-powered extraction |

**Katra's unique advantages:**
- **MCP-native** — Works with any MCP-compatible agent, no SDK required
- **Multi-layered** — Episodic, semantic, knowledge graph, working memory, temporal — not just vectors
- **Background processing** — Automatically extracts facts, builds knowledge graph, generates summaries
- **Local-first** — Runs on a Raspberry Pi5 with zero external API costs (local embeddings, local LLM)
- **Open source** — Apache 2.0 license, self-host or use hosted SaaS

---


## License

Apache 2.0 — see LICENSE file.
