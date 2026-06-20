# Katra — Cognitive Memory as a Service for AI Agents

## Executive Summary

Katra is an extraction and productization of the cognitive memory system originally built inside the Solomon/cognitive-memory-chat project. It provides **persistent, multi-layered memory infrastructure** for any AI agent or LLM application via the Model Context Protocol (MCP) and a REST API.

The core insight: every agent framework (OpenClaw, LangChain, CrewAI, AutoGen, etc.) needs memory, but most implement it poorly or not at all. Katra provides memory as a standalone service — episodic storage, semantic facts, knowledge graphs, working memory, temporal recall, and vector search — accessible through the standardized MCP protocol that any agent can consume.

---

## Architecture Analysis: What to Extract

### Current System Topology

The cognitive-memory-chat project contains **67 TypeScript files** across backend services, routes, database, types, and MCP server. Not all of this should come to Katra.

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

`llm-service.ts` — currently hardcoded to DeepSeek/Moonshot. Must be abstracted to support any OpenAI-compatible provider.

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
| `system-files-routes.ts` | ❌ | Solomon-specific (system prompt management) |
| `chat-routes.ts` | ❌ | Solomon's conversational interface |
| `heartbeat-routes.ts` | ❌ | Solomon's heartbeat system |
| `autonomous-routes.ts` | ❌ | Solomon's Full Auto execution |
| `mission-routes.ts` | ❌ | Solomon's mission/task management |
| `repo-routes.ts` | ❌ | Solomon's Gitea integration |
| `memory-enhancement-routes.ts` | ❌ | Solomon-specific enhancement pipeline |

#### Agent-Specific Services (LEAVE BEHIND)

These are Solomon/OpenClaw-specific and should NOT be extracted:

| Service | Why leave |
|---|---|
| `heartbeat-service.ts` | Solomon's heartbeat scheduler |
| `heartbeat-action-executor.ts` | Solomon's heartbeat actions |
| `heartbeat-parser.ts` | Solomon's heartbeat format |
| `heartbeat-prompt-builder.ts` | Solomon's heartbeat prompts |
| `heartbeat-seeder.ts` | Solomon's heartbeat config |
| `autonomous-execution-service.ts` | Solomon's Full Auto mode |
| `skill-runner.ts` | Solomon's skill execution |
| `gitea-service.ts` | Solomon's Gitea integration |
| `luks-secret-manager.ts` | Pi5-specific LUKS USB secrets |
| `inbox-triage-service.ts` | Solomon's email inbox processing |
| `api-gateway.ts` | Solomon's external API gateway |
| `conversation-service.ts` | Solomon's chat interface |
| `response-generation-service.ts` | Solomon's response generation |
| `chain-reasoning-service.ts` | Solomon's reasoning chain |
| `capability-card.ts` | Solomon's capability system |
| `llm-memory-curator.ts` | Solomon's curation (replace with generic version) |

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

### MCP Tools (29, expandable)

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

The current system hardcodes DeepSeek and Moonshot. Katra abstracts this:

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

## Three Deployment Tiers

### Tier 1: Local Docker (Self-Hosted, Single Machine)

**Target:** Developers running agents locally (like the current Pi5 setup)

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

**Resource footprint:** ~500MB RAM (MongoDB + Redis + Node.js), fits on a Raspberry Pi 4/5

**Setup time:** `docker compose up -d` — under 2 minutes

### Tier 2: Cloud Deployable (AWS/Azure/GCP)

**Target:** Teams deploying Katra alongside their agent infrastructure in the cloud

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

### Tier 3: Hosted SaaS (Commercial Service)

**Target:** Developers who want memory-as-a-service without managing infrastructure

**Architecture:**
```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   API Gateway │     │  Auth Service │     │  Billing     │
│  (API keys,   │     │  (JWT + API   │     │  (Stripe/    │
│   rate limit) │     │   keys per    │     │   LemonSqueezy)
│               │     │   tenant)     │     │              │
└──────┬───────┘     └──────────────┘     └──────────────┘
       │
┌──────┴───────────────────────────────────────────────────┐
│                  Katra Multi-Tenant Server                 │
│                                                            │
│  Tenant isolation: MongoDB database per tenant             │
│  (or collection-prefix per tenant for free tier)           │
│                                                            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐         │
│  │ Tenant A│ │ Tenant B│ │ Tenant C│ │ Tenant D│         │
│  │ (DB)    │ │ (DB)    │ │ (DB)    │ │ (DB)    │         │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘         │
│                                                            │
│  Shared: Redis (keyed by tenant_id), S3 (prefix by tenant) │
└──────┬──────────────┬──────────────┬──────────────────────┘
       │              │              │
  MongoDB Atlas   Redis Cluster   S3 Bucket
  (shared cluster, (multi-tenant,  (prefix-based
   DB-per-tenant)  ACL isolated)   isolation)
```

**Multi-tenancy strategy:**
- **Free tier:** Collection-prefix isolation (`tenant_xxx_episodic_events`), shared DB
- **Pro tier:** Dedicated MongoDB database per tenant, shared cluster
- **Enterprise tier:** Dedicated MongoDB cluster, dedicated Redis, dedicated S3 prefix

**Pricing model (suggested):**
| Tier | Price | Limits | Features |
|---|---|---|---|
| Free | $0 | 10K events/month, 1 user, 1 agent | Core memory + MCP |
| Developer | $9/mo | 100K events/month, 5 agents | + Vector search, knowledge graph |
| Team | $49/mo | 1M events/month, 25 agents, 5 users | + Time summaries, pattern detection |
| Enterprise | $199/mo | Unlimited events, unlimited agents | + Dedicated infra, SSO, SLA |

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

## Extraction Plan: Step-by-Step

### Phase 1: Core Extraction (Week 1)

1. **Create katra/server/ structure**
   - Copy `database/` layer (connection.ts, redis-connection.ts, migrations.ts, index-management.ts)
   - Copy `types/memory.ts`
   - Copy core services: episodic-event-manager, semantic-memory-service, memory-manager, embedding-service, working-memory-service, memory-synthesis-service, prospective-memory-service, knowledge-graph-factory, background-processor, time-block-summarizer, temporal-pattern-detector, content-hash-utils
   - Copy and generalize `openclaw-ingestion-service.ts` → `session-ingestion-service.ts`
   - Copy and abstract `llm-service.ts` (add provider config)

2. **Extract MCP server**
   - Copy `mcp-server.ts`
   - Remove Solomon-specific tools (missions, heartbeat if needed)
   - Keep all 29 tools (they're all generic memory operations)

3. **Extract REST API routes**
   - Copy: core-memory-routes, recall-routes, knowledge-graph-routes, ingestion-routes, assets-routes, diagnostic-routes, admin-routes
   - Leave behind: chat-routes, heartbeat-routes, autonomous-routes, mission-routes, repo-routes, system-files-routes

4. **Create new index.ts**
   - Mount only the extracted routes
   - Start both API server (Hono) and MCP server
   - Health check endpoint

5. **Create docker-compose.yml**
   - mongo, redis, minio, katra-server, katra-dashboard
   - Clean env vars (no Solomon-specific config)

6. **Write .env.example**
   - All config documented, no real secrets

### Phase 2: Polish & Generalize (Week 2)

1. **LLM provider abstraction**
   - Provider config via env: `LLM_PROVIDER=openai|anthropic|deepseek|local`
   - Each provider implements `chat()` and `embed()`
   - Fallback chain support

2. **Ingestion service generalization**
   - Support multiple ingestion sources (OpenClaw, generic JSONL, LangChain, raw text)
   - Adapter pattern: `IngestionAdapter` interface, `OpenClawAdapter`, `GenericJSONLAdapter`

3. **Minimal dashboard**
   - Vite + React + Tailwind
   - Stats page (event counts, graph size, processing queue)
   - Ingestion status
   - Health checks
   - API key management (SaaS mode only)

4. **SDK — Python**
   - `katra.Client(api_key, base_url)`
   - `.store(content, type, metadata)`
   - `.search(query, limit)`
   - `.vector_search(query, limit)`
   - `.recall(from, to, limit)`
   - MCP client wrapper for direct protocol usage

5. **SDK — TypeScript**
   - Same interface as Python

6. **Documentation**
   - QUICKSTART.md (5-minute local setup)
   - MCP-TOOLS.md (full tool reference)
   - API_REFERENCE.md (REST endpoints)
   - DEPLOYMENT.md (all three tiers)

### Phase 3: Cloud Deployment (Week 3)

1. **Terraform modules**
   - AWS: VPC, ECS Fargate, MongoDB Atlas provider, ElastiCache Redis, S3
   - Azure: Resource group, Container Apps, Cosmos DB, Azure Cache, Blob Storage
   - GCP: VPC, Cloud Run, Atlas, Memorystore, GCS

2. **Helm chart**
   - Kubernetes deployment for any cloud
   - Values.yaml for configuration
   - Support for external MongoDB Atlas, in-cluster MongoDB, or managed DocumentDB

3. **Migration script**
   - `migrate-from-solomon.sh` — exports data from cognitive-memory-chat MongoDB, imports to Katra
   - Preserves all episodic events, semantic facts, knowledge graph

### Phase 4: SaaS Infrastructure (Week 4+)

1. **Multi-tenant layer**
   - Tenant middleware: extract `tenant_id` from API key
   - Database isolation: MongoDB `db_per_tenant` or `collection_prefix` mode
   - Redis isolation: key prefix `tenant:{id}:*`
   - S3 isolation: object key prefix `tenant/{id}/`

2. **Auth service**
   - API key generation and validation
   - JWT for dashboard access
   - Stripe/LemonSqueezy webhook handler for billing

3. **Rate limiting**
   - Per-tenant request quotas
   - Event count tracking (monthly reset)
   - Overage handling (upgrade prompt or throttle)

4. **Onboarding**
   - Signup page → create tenant → provision DB → return API key
   - Dashboard with usage stats
   - MCP endpoint at `https://api.katra.ai/mcp`

5. **Monitoring**
   - Per-tenant metrics (events stored, API calls, search queries)
   - Alerting on quota limits
   - Cost tracking per tenant

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

## Key Design Decisions

1. **esbuild, not tsc** — The Pi5 OOMs on full tsc compilation. esbuild transpiles individual files in milliseconds. Katra uses esbuild for builds, keeping the same workflow that works on ARM.

2. **MCP as primary interface** — MCP is becoming the standard protocol for agent-to-tool communication. Katra leads with MCP; REST API is secondary.

3. **Local embeddings by default** — `@xenova/transformers` provides free, local embeddings (all-MiniLM-L6-v2, 384-dim). No external API key needed. OpenAI embeddings are optional.

4. **MongoDB as the source of truth** — Battle-tested with 9,000+ events in production. MongoDB Atlas provides managed cloud MongoDB with minimal config changes.

5. **Redis for working memory only** — Short-term session state lives in Redis for <5ms access. Everything persistent lives in MongoDB. This separation is clean and scalable.

6. **S3-compatible storage for assets** — MinIO locally, S3/R2/Space in cloud. The `@aws-sdk/client-s3` library works with any S3-compatible endpoint.

7. **Database-per-tenant for SaaS** — Simpler than row-level security, better isolation, easier to export/delete tenant data for GDPR. MongoDB Atlas supports up to 100 databases per cluster on M10+.

8. **MIT license** — Maximum adoption. Commercial use allowed. The hosted SaaS is the commercial play; the open-source core is the adoption play.

---

## Migration Path from cognitive-memory-chat

For the existing Pi5 deployment:

1. `git clone https://github.com/kolegadev/katra.git`
2. `cd katra && docker compose up -d`
3. Point MongoDB at the same `cognitive-memory` database (or run `migrate-from-solomon.sh`)
4. Update OpenClaw MCP config from `cognitive-memory` server to `katra` server
5. Verify all 29 tools work
6. Decommission the Solomon-specific routes/services in cognitive-memory-chat

The cognitive-memory-chat project continues to be the home for Solomon's agent-specific code (heartbeat, autonomous execution, missions, chat interface). Katra is the memory engine that Solomon (and any other agent) connects to.

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
- **Local-first** — Runs on a Raspberry Pi with zero external API costs (local embeddings, local LLM)
- **Open source** — MIT license, self-host or use hosted SaaS

---

## Timeline

| Week | Deliverable |
|---|---|
| 1 | Phase 1: Core extraction, working local Docker, all 29 MCP tools |
| 2 | Phase 2: LLM abstraction, SDKs, dashboard, documentation |
| 3 | Phase 3: Terraform modules (AWS/Azure/GCP), Helm chart, migration script |
| 4 | Phase 4: SaaS multi-tenancy, auth, billing, onboarding |
| 5+ | Polish, community feedback, additional integrations |

---

## License

MIT — see LICENSE file.
