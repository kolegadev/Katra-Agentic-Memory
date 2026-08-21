# OpenClaw ↔ Satori Integration — Configuration & Lessons Learned

> **Last updated:** 2026-08-21
> **Server version:** katra-server 1.0.0 (Satori identity)
> **Key features:** 66 MCP tools, sleep consolidation, security hardening, test suite (87 tests)

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        OpenClaw Gateway                               │
│                                                                       │
│  MCP Client ──→ http://localhost:3112/mcp ──→ katra-server:3100/mcp │
│  (Authorization: Bearer <CLIENT_KEY> | X-MCP-Auth | ?token=)         │
│                                                                       │
│  Admin API ──→ http://localhost:9012/api/v1/admin ──→ katra-server:9002 │
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

## Identity separation (2026-08-21)

Katra resolves **who is calling** from the API key presented — never from client self-report. Today there is one Katra with three named identities plus tool actors:

- **satori** — this machine's own agent identity (the `KATRA_API_KEY` admin key authenticates as trusted satori);
- **shoshin** — iMac trading Kolega Code;
- **zanshin** — iMac OpenCode desktop.

Client keys are provisioned idempotently at server boot by `ensureClientKeys()`; only their sha256 hashes are stored (`system_settings.client_keys`), and the plaintext is printed **once** in the "Client keys (identity separation)" block of the server log. A valid-but-unmapped key is rejected with 401 + reason — no silent fallback. The legacy env keys (`MCP_API_KEY`, `BACKUP_MCP_KEYS`) no longer authenticate.

For this OpenClaw integration, the gateway presents **one** client key — the identity its agent fleet speaks as — on every MCP call. Use it wherever the examples below show `<CLIENT_KEY>` (older revisions of this doc used the retired `<MCP_API_KEY>` env key there).

## Key Concepts: Memory Scope & `shared_id`

Katra's write scope is **server-side policy** (`server/src/services/memory/write-scope-policy.ts`), shipped with identity separation (2026-08-21). The system runs in hybrid mode with the team scope `shared_id: "my-team"`:

- **Personal kinds** — `journal`, `reflection`, `emotional`, `insight` — are **always private**. Even when a shared write is requested, these are forced to the writer's `user_id` with no `shared_id`.
- **Everything else** defaults to the shared `my-team` scope, still stamped with the writer's `user_id`. Passing `private: true` opts out.
- **Reads** return the caller's own private memories plus `my-team` shared memories. Another identity's private data is never visible.

This replaced the legacy global-scope model (a personal/shared/hybrid mode configured once via `set_memory_scope`, with the server's `resolveSharedId()` picking the `shared_id` and agents never passing one per-message). The admin scope endpoint still exists for inspection/adjustment; the system is configured to hybrid with `hybrid_visible_user_ids` pinned to `[]`:

```bash
curl -X PUT \
  -H "Authorization: Bearer <KATRA_API_KEY>" \
  -H "Content-Type: application/json" \
  http://localhost:9012/api/v1/admin/memory-scope \
  -d '{"mode": "hybrid", "shared_id": "my-team"}'
```

## Data Processing Pipeline

### Path A: MCP Tools (primary agent-facing)

Agent calls `store_memory(content)` → recorded as episodic event → background processor extracts semantic facts via LLM.

### Path B: REST Ingestion API

`POST /api/v1/ingestion/ingest` — used for bulk or test ingestion. Same processing pipeline as Path A.

### Background Processor

```
episodic_events (unprocessed)
        │
        ▼
┌──────────────────────┐
│ extraction-service.ts │ ◄── deepseek-v4-flash LLM (default)
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

### Satori `.env` (gitignored — contains secrets)

```bash
# Admin key — authenticates as trusted satori (the appliance's own identity)
KATRA_API_KEY=katra-local-admin-2026

# Client keys (shoshin / zanshin) are NOT env vars. ensureClientKeys() generates
# them once at boot and prints them in the "Client keys (identity separation)"
# log block; only sha256 hashes are persisted (system_settings.client_keys).
# The legacy MCP_API_KEY / BACKUP_MCP_KEYS env vars no longer authenticate.
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
          "Authorization": "Bearer <CLIENT_KEY>"
        }
      }
    }
  }
}
```

> **Critical: `transport` must be `"streamable-http"`, NOT `"sse"`.**  
> The MCP SDK's `StreamableHTTPServerTransport` has a bug in its Node.js adapter where GET SSE streams produce an empty response. Satori rejects GET requests on `/mcp` with HTTP 405 to force POST-only mode. If you use `"sse"` transport, OpenClaw will fail with `"Server not initialized"` or silent timeouts. Only `"streamable-http"` (POST) works correctly.

> **Note:** `<CLIENT_KEY>` is the client key of the identity this gateway presents (shoshin or zanshin, or a tool-actor key) — printed once at server boot in the "Client keys (identity separation)" log block. `X-MCP-Auth: <key>` and the `?token=<key>` URL parameter are equivalent alternatives to the `Authorization: Bearer` header.
>
> The `Authorization` header in the OpenClaw MCP config is protected — it can't be modified via `gateway config.patch`. To rotate the API key, edit `openclaw.json` directly and restart the gateway.

### Memory Migration — Phased Cutover (CRITICAL ORDER)

> **Do NOT disable OpenClaw's built-in memory first.** If you disable `memory_search` and `memory-core` before Satori is wired in, your agent becomes memory-less — losing `MEMORY.md`, session notes, drafts, and preferences. Migrate in this order:

#### Phase 1: Wire Satori into OpenClaw

Add the MCP server config (see above) and restart the gateway. Verify Satori is reachable:

```bash
# From the Pi5:
curl -H "Authorization: Bearer <CLIENT_KEY>" http://localhost:3112/health
# Expected: { "status": "ok", "version": "1.0.0", "services": { "mongodb": "connected", ... } }
```

Confirm MCP tools are visible in the agent session — the agent should see `store_memory`, `search_memories`, and other Katra tools in its tool list (tools are registered without a `katra__` prefix).

#### Phase 2: Backfill Existing Memory Files

Have your agent read and store its existing local memory into Satori:

```
Agent prompt: "Read MEMORY.md, memory/2026-06-25.md, memory/katra-project.md,
and any other memory files you have. Store each one in Satori with appropriate
tags and categories."
```

Verify backfill with a search:
```bash
curl -H "Authorization: Bearer <CLIENT_KEY>" \
  "http://localhost:3112/mcp" -d '{
    "jsonrpc":"2.0","method":"tools/call",
    "params":{"name":"search_memories","arguments":{"query":"preferences"}},
    "id":1
  }'
```

#### Phase 3: Verify Satori Handles Recall

Test that the agent can recall backfilled memories before cutting over:

```
Agent prompt: "What are my preferences and project context? Use Satori tools only."
```

If the agent correctly recalls your identity, preferences, and project details from Satori, proceed to cutover.

#### Phase 4: Cut Over — Disable OpenClaw's Local Memory

Only now, after Satori is verified working with backfilled data, disable the local memory system. Add to `openclaw.json`:

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

Without this, agents see two competing memory systems — OpenClaw's broken local memory (0/0 chunks, "index metadata is missing") and Satori — causing confusion.

Restart the gateway after adding this config.

## Agent Satori Tool Allocation

> **Historical note:** this table reflects the pre-identity-separation OpenClaw deployment (June 2026), when all gateway agents shared one MCP key. Under identity separation (2026-08-21), each agent maps to a named identity (satori / shoshin / zanshin) authenticated by its own client key; the per-agent tool allocation guidance is unchanged. MCP tools are registered **without** the `katra__` prefix.

| Agent | Minimum Tools | Notes |
|---|---|---|
| **main** (user-facing) | All Satori tools | Primary user-facing, queries Satori before responding |
| **admin-ops** | `store_memory`, `search_memories`, `vector_search`, `get_temporal_context`, `get_memory_diagnostics`, `get_background_status` | Provisions agents, stores system events |
| **prospectors** | `store_memory`, `search_memories`, `vector_search`, `get_temporal_context` | Systemic discoveries only, not raw data |
| **mail handler** | `store_memory`, `search_memories`, `vector_search`, `get_temporal_context` | Email task completion, contact patterns |
| **katra-caretaker** | All Satori tools + `summarize_time_blocks`, `get_time_block_summaries`, `get_heartbeat_status`, `get_health`, `store_journal`, `get_auto_journal`, `trigger_reflection` | Health checks, summarization, journaling, sleep consolidation |

## Satori Caretaker Agent (Mnemosyne)

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

2. **Auth fails after MongoDB reset:** Client-key hashes live in `system_settings.client_keys`. After a Mongo reset, `ensureClientKeys()` regenerates the shoshin/zanshin keys at next boot and prints them once in the "Client keys (identity separation)" log block — copy the new key into `openclaw.json` (and set `KATRA_API_KEY` in `.env`), then `docker compose up -d --force-recreate`. See [SECURITY.md](SECURITY.md) for key lifecycle details.

3. **Short messages (< 200 chars) don't use LLM:** By design — the extraction service uses lightweight regex patterns for short messages to save API costs. Only substantial content triggers LLM distillation.

4. **`memory_search` returns "disabled" after configuring memory-core:** That's OpenClaw's local memory, NOT Satori. It was intentionally disabled. Use `search_memories` or `vector_search` instead.

5. **Time-block summaries show 0/0 even with events:** The summarizer is idempotent — it skips time blocks that already have summaries. New summaries are generated for new days/weeks/months only.

6. **Use `docker compose up -d --force-recreate` not `docker restart`:** A restart preserves the original container environment; only force-recreate picks up new `.env` values after changes.

7. **API keys are SHA-256 hashed in MongoDB:** Plaintext keys never touch the database — `system_settings.client_keys` stores sha256 hashes only. Client keys are printed once, in the "Client keys (identity separation)" log block on boot. Store these securely.

## Related Documentation

- [MCP Tools Reference](MCP-TOOLS.md) — All 66 MCP tools
- [REST API Reference](API-REFERENCE.md) — HTTP endpoints
- [Security Policy](SECURITY.md) — Key lifecycle, input validation, auth architecture
- [Sleep Consolidation](SLEEP-CONSOLIDATION.md) — Reflective memory distillation
- [Data Processing Pipelines](Data-Processing-Pipelines.md) — Full pipeline architecture
- [Quick Start Guide](QUICKSTART.md) — Get running in 5 minutes
