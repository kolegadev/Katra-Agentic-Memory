# OpenClaw ↔ Katra Integration — Configuration & Lessons Learned

> **Last updated:** 2026-06-24
> **Katra version:** 3.0.0
> **Key features:** 35 MCP tools, sleep consolidation, security hardening, test suite (87 tests)

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        OpenClaw Gateway                               │
│                                                                       │
│  MCP Client ──→ http://localhost:3112/mcp ──→ katra-server:3100/mcp │
│  (X-MCP-Auth: <MCP_API_KEY>)                                         │
│                                                                       │
│  Admin API ──→ http://localhost:9012/api/v1/admin ──→ katra:9002     │
│  (Authorization: Bearer <KATRA_API_KEY>)                             │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Docker stack (katra):                                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐           │
│  │ MongoDB  │ │  Redis   │ │  MinIO   │ │ katra-server   │           │
│  │ 7.0      │ │ 7-alpine │ │ latest   │ │ :latest (Node) │           │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘           │
│       │            │            │              │                      │
│    port:27017  port:6379   port:9000      port:3100 (MCP)            │
│                                    :9001   port:9002 (REST)           │
└──────────────────────────────────────────────────────────────────────┘
```

## Key Concepts: Memory Scope & `shared_id`

Katra's memory scoping is **server-side** — configured once via `set_memory_scope` and applied globally to all queries. Agents do NOT pass `shared_id` per-message.

### Scope Modes

| Mode | Behavior | Query Filter |
|------|----------|-------------|
| **personal** (default) | Each agent's memories are isolated by `user_id` | `{ user_id: ... }` |
| **shared** | Communal memory via `shared_id` — all agents with same scope see everything | `{ shared_id: "group-1" }` |
| **hybrid** | Personal (`user_id`) + shared (`shared_id`) + other visible users | `{ $or: [{ user_id }, { shared_id }, { user_id: { $in: visible }] }` |

**Why `shared_id` is NOT passed by agents/watchers:** The server's `resolveSharedId()` determines the correct `shared_id` based on the global scope mode. Passing it per-message creates a mismatch risk — if an agent sends `shared_id: "A"` but the server is configured for `"B"`, the document becomes invisible to queries. The scope is set once server-side via the admin API or `set_memory_scope` MCP tool.

Set the scope via admin API:
```bash
curl -X PUT \
  -H "Authorization: Bearer <KATRA_API_KEY>" \
  -H "Content-Type: application/json" \
  http://localhost:9012/api/v1/admin/memory-scope \
  -d '{"mode": "hybrid", "shared_id": "barca-agentgroup1"}'
```

## Data Processing Pipeline

### Path A: MCP Tools (primary agent-facing)

Agent calls `katra__store_memory(content)` → recorded as episodic event → background processor extracts semantic facts via LLM.

### Path B: REST Ingestion API

`POST /api/v1/ingestion/ingest` — used for bulk or test ingestion. Same processing pipeline as Path A.

### Background Processor

```
episodic_events (unprocessed)
        │
        ▼
┌──────────────────────┐
│ extraction-service.ts │ ◄── deepseek-chat LLM
│                      │
│  Short (<200 chars): light regex patterns   (no LLM cost)
│  Long  (≥200 chars): LLM distillation       (max 2 durable facts)
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ dispatch-service.ts  │
│  → semantic_facts    │ ◄── embeddings computed via all-MiniLM-L6-v2
│  → knowledge_nodes   │      (384-dim vectors, ~80MB model)
│  → relationships     │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Deduplication        │
│  • Exact: content_hash upsert (same user + content = same doc)
│  • Near: cosine similarity > 0.92 (merges rephrased duplicates)
└──────────────────────┘
```

### Auto-Journaling & Sleep Consolidation

**Time-block summaries:** Every 30 background processor cycles (~15 min), groups events by day/week/month and generates LLM-powered summaries via `semantic_facts`.

**Sleep consolidation:** Scheduled nightly (2am daily, 3am weekly Sunday, 4am monthly 1st). Distills all memory data into reflective journals, emotional signatures, and philosophical insights. See [SLEEP-CONSOLIDATION.md](SLEEP-CONSOLIDATION.md).

## Configuration Reference

### Katra `.env` (gitignored — contains secrets)

```bash
# Required: API keys for MCP and Admin access
MCP_API_KEY=katra-local-mcp-2026
KATRA_API_KEY=katra-local-admin-2026

# Set in .env to avoid auto-generation on startup.
# If unset, Katra generates random keys (256-bit) and persists SHA-256 hashes
# to MongoDB system_settings. Keys survive restarts but NOT MongoDB resets.
```

### OpenClaw `openclaw.json` — MCP Server Config

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3112/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer katra-local-mcp-2026"
        }
      }
    }
  }
}
```

> **Critical: `transport` must be `"streamable-http"`, NOT `"sse"`.**  
> The MCP SDK's `StreamableHTTPServerTransport` has a bug in its Node.js adapter where GET SSE streams produce an empty response. Katra rejects GET requests on `/mcp` with HTTP 405 to force POST-only mode. If you use `"sse"` transport, OpenClaw will fail with `"Server not initialized"` or silent timeouts. Only `"streamable-http"` (POST) works correctly.

> **Note:** The `Authorization` header in the OpenClaw MCP config is protected — it can't be modified via `gateway config.patch`. To rotate the API key, edit `openclaw.json` directly and restart the gateway.

### Memory Migration — Phased Cutover (CRITICAL ORDER)

> **Do NOT disable OpenClaw's built-in memory first.** If you disable `memory_search` and `memory-core` before Katra is wired in, your agent becomes memory-less — losing `MEMORY.md`, session notes, drafts, and preferences. Migrate in this order:

#### Phase 1: Wire Katra into OpenClaw

Add the MCP server config (see above) and restart the gateway. Verify Katra is reachable:

```bash
# From the Pi5:
curl -H "Authorization: Bearer <MCP_API_KEY>" http://localhost:3112/health
# Expected: { "status": "ok", "version": "3.0.0", "transport": "http-sse", ... }
```

Confirm MCP tools are visible in the agent session — the agent should see `katra__store_memory`, `katra__search_memories`, and other Katra tools in its tool list.

#### Phase 2: Backfill Existing Memory Files

Have your agent read and store its existing local memory into Katra:

```
Agent prompt: "Read MEMORY.md, memory/2026-06-25.md, memory/katra-project.md,
and any other memory files you have. Store each one in Katra with appropriate
tags and categories."
```

Verify backfill with a search:
```bash
curl -H "Authorization: Bearer <MCP_API_KEY>" \
  "http://localhost:3112/mcp" -d '{
    "jsonrpc":"2.0","method":"tools/call",
    "params":{"name":"katra__search_memories","arguments":{"query":"preferences"}},
    "id":1
  }'
```

#### Phase 3: Verify Katra Handles Recall

Test that the agent can recall backfilled memories before cutting over:

```
Agent prompt: "What are my preferences and project context? Use Katra tools only."
```

If the agent correctly recalls your identity, preferences, and project details from Katra, proceed to cutover.

#### Phase 4: Cut Over — Disable OpenClaw's Local Memory

Only now, after Katra is verified working with backfilled data, disable the local memory system. Add to `openclaw.json`:

```json
{
  "tools": {
    "deny": ["memory_search"]
  },
  "plugins": {
    "entries": {
      "memory-core": {
        "enabled": false
      }
    }
  }
}
```

Without this, agents see two competing memory systems — OpenClaw's broken local memory (0/0 chunks, "index metadata is missing") and Katra — causing confusion.

Restart the gateway after adding this config.

## Agent Katra Tool Allocation

| Agent | Minimum Tools | Notes |
|---|---|---|
| **main** (user-facing) | All Katra tools | Primary user-facing, queries Katra before responding |
| **admin-ops** | `katra__store_memory`, `katra__search_memories`, `katra__vector_search`, `katra__get_temporal_context`, `katra__get_memory_diagnostics`, `katra__get_background_status` | Provisions agents, stores system events |
| **prospectors** | `katra__store_memory`, `katra__search_memories`, `katra__vector_search`, `katra__get_temporal_context` | Systemic discoveries only, not raw data |
| **mail handler** | `katra__store_memory`, `katra__search_memories`, `katra__vector_search`, `katra__get_temporal_context` | Email task completion, contact patterns |
| **katra-caretaker** | All Katra tools + `katra__summarize_time_blocks`, `katra__get_time_block_summaries`, `katra__get_heartbeat_status`, `katra__get_health`, `katra__store_journal`, `katra__get_auto_journal`, `katra__trigger_reflection` | Health checks, summarization, journaling, sleep consolidation |

## Katra Caretaker Agent (Mnemosyne)

- **Persona:** Lighthouse-keeper, calm and methodical
- **Heartbeat routine:** Health check → background processor status → summarize time blocks → store journal → store status
- **Sleep consolidation:** Trigger `trigger_reflection(daily)` for reflective memory distillation

## Operational Commands

### Check Health
```bash
curl http://localhost:9012/api/v1/health
```

### Check API Health (authenticated)
```bash
curl -H "Authorization: Bearer <KATRA_API_KEY>" http://localhost:9012/api/v1/health
```

### Reset Everything
```bash
# Drop MongoDB collections
docker exec katra-mongo mongosh -u admin -p katra-local-dev --authenticationDatabase admin \
  --eval 'db.getSiblingDB("katra").getCollectionNames().forEach(c => db.getSiblingDB("katra")[c].drop())'

# Flush Redis
docker exec katra-redis redis-cli FLUSHALL

# Recreate container (picks up .env changes)
cd /path/to/katra && docker compose up -d --force-recreate server
```

### Update LLM Config
```bash
curl -X PUT -H "Authorization: Bearer <KATRA_API_KEY>" \
  -H "Content-Type: application/json" \
  http://localhost:9012/api/v1/admin/llm-config \
  -d '{"provider":"deepseek","api_key":"<key>","model":"deepseek-chat"}'
```

### Run Test Suite
```bash
cd server && npm test
```

## Common Pitfalls

1. **LLM shows "unavailable" after config update:** Wait 5-8s for async validation. Check `docker logs katra-server | grep "Provider validated"`. 401 = bad API key; timeout = network issue.

2. **Auth fails after MongoDB reset:** `ensureApiKeys()` falls back to DB-stored key hashes if env vars are missing. After a Mongo reset, set `MCP_API_KEY` + `KATRA_API_KEY` in `.env` and `docker compose up -d --force-recreate`. See [SECURITY.md](SECURITY.md) for key lifecycle details.

3. **Short messages (< 200 chars) don't use LLM:** By design — the extraction service uses lightweight regex patterns for short messages to save API costs. Only substantial content triggers LLM distillation.

4. **`memory_search` returns "disabled" after configuring memory-core:** That's OpenClaw's local memory, NOT Katra. It was intentionally disabled. Use `katra__search_memories` or `katra__vector_search` instead.

5. **Time-block summaries show 0/0 even with events:** The summarizer is idempotent — it skips time blocks that already have summaries. New summaries are generated for new days/weeks/months only.

6. **Use `docker compose up -d --force-recreate` not `docker restart`:** A restart preserves the original container environment; only force-recreate picks up new `.env` values after changes.

7. **API keys are SHA-256 hashed in MongoDB:** Plaintext keys never touch the database. Generated keys are printed to `docker logs` on first boot. Store these securely.

## Related Documentation

- [MCP Tools Reference](MCP-TOOLS.md) — All 35 MCP tools
- [REST API Reference](API-REFERENCE.md) — HTTP endpoints
- [Security Policy](SECURITY.md) — Key lifecycle, input validation, auth architecture
- [Sleep Consolidation](SLEEP-CONSOLIDATION.md) — Reflective memory distillation
- [Data Processing Pipelines](Data-Processing-Pipelines.md) — Full pipeline architecture
- [Quick Start Guide](QUICKSTART.md) — Get running in 5 minutes
