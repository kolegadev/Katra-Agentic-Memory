# REST API Reference

Katra exposes a REST API under `/api/v1/` on port 9012 (host-mapped from container port 9002). The admin dashboard is served on the same port at `/dashboard/`. MCP tooling lives separately on port 3112 (`/mcp`); see `MCP-TOOLS.md`.

## Authentication & Identity Separation

Katra resolves **who is calling** from the API key presented on the request — never from anything the client self-reports. One Katra hosts three named identities (`satori`, `shoshin`, `zanshin`) plus a `gas-law-watcher` tool actor.

All requests present a key via:

```
Authorization: Bearer <your-api-key>
```

(Some routes — memory and reflection among them — also accept `?token=<key>` as a query parameter.)

**Caller resolution:**
- **Loopback** (127.0.0.1/::1) → trusted `satori`, no key needed.
- **Admin key** (`KATRA_API_KEY`) → trusted `satori`.
- **Client key** (mapped in `system_settings.client_keys`) → that identity, untrusted — writes are pinned to the caller's own `user_id`; per-endpoint `user_id` parameters are documented below.
- **Valid but unmapped key** → **401**, loudly. No silent fallback to a default identity.
- **Legacy env keys** (`MCP_API_KEY`, `BACKUP_MCP_KEYS`) were retired after the identity-separation cutover (2026-08-21) and no longer authenticate as REST credentials; only keys with an identity mapping in `client_keys` (or the admin key) are accepted. If no key is configured at all, the API runs in open-access mode (local dev only).

API keys are stored as **SHA-256 hashes** in MongoDB (`system_settings.generated_api_keys`, `system_settings.client_keys`) — plaintext keys never touch the database. Shoshin/Zanshin client keys are generated once at boot and their plaintext printed once in the server log. Timing-safe comparison is used for all key validation.

**No-auth endpoints** (caller identity is still resolved, but no key is required):
`/api/v1/health`, `/api/v1/admin/dashboard-stats`, `/api/v1/admin/memory-search`, `/api/v1/admin/pubsub/presence`, `/api/v1/admin/pubsub/topics`, `/api/v1/admin/pubsub/muted`, `/api/v1/admin/personality`, `/api/v1/admin/personality/profiles`, and `GET /api/v1/admin/identity` (caller's own record).

**Admin-gated** (require the `KATRA_API_KEY` regardless of the caller middleware): `PUT /api/v1/admin/identity`, `GET /api/v1/admin/identity?user_id=`, all `/api/v1/assets/*` routes, all `/api/v1/tenants/*` routes, and every other `/api/v1/admin/*` endpoint not listed as no-auth above.

## Response Format

All responses are JSON. Standard envelope:

```json
{"success": true, "data": {...}}
```

Error responses:

```json
{"success": false, "error": "Error message"}
```

Admin-gate rejections use `{"error": "Unauthorized", "message": "..."}` with status 401.

## Rate Limiting

Sliding-window, Redis-backed:

| Scope | Limit |
|---|---|
| `/api/v1/ingestion/*` (general) | 120 req/min |
| `POST /api/v1/ingestion/ingest` | 10 req/min |
| `POST /api/v1/ingestion/ingest/batch` | 5 req/min |
| `POST /api/v1/ingestion/validate` | 20 req/min |
| `POST /api/v1/ingestion/sessions/ingest` | 20 req/min |
| `POST /api/v1/ingestion/sessions/reset` | 20 req/min |
| `/api/v1/reflection/*` | 60 req/min |
| `/api/v1/admin/*` (general, keyed on the Authorization header) | 30 req/min |
| `POST /api/v1/admin/clear-all` (destructive) | 5 req/min |

Rate-limited responses return 429 with a `retry_after` field. Ingestion routes also carry a 45-second processing timeout (504 on expiry).

---

## Health & Diagnostics

### GET /api/v1/health

Health check — no auth required. Returns service status plus a memory-integrity report.

**Response:**
```json
{"status": "ok", "services": {"mongodb": "connected", "redis": "connected", "llm": "deepseek", "embeddings": "available"}, "version": "1.0.0", "memory_integrity": {...}}
```

### GET /api/v1/memory/health

Memory-system health: MongoDB ping, collection readiness, memory-manager status, and LLM service status. Requires auth.

### GET /api/v1/memory/status

Memory system status — collection counts, working-memory statistics, and database-performance statistics. Requires auth.

### GET /api/v1/ingestion-timeout

Diagnostic endpoint that times database connectivity, LLM service status, memory operations, and external connectivity. Requires auth.

### POST /api/v1/test-ingestion

Test ingestion with rule-based and LLM extraction configurations (`{text: ...}`). Requires auth.

### Admin diagnostics (admin key)

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/admin/database-stats` | Mongo collection counts + Redis key stats |
| `GET /api/v1/admin/debug-collections` | All collections with document counts |
| `GET /api/v1/admin/background/status` | Background processor queue depth, last run, errors |
| `GET /api/v1/admin/background-processor-status` | Background processor stats |
| `GET /api/v1/admin/index-stats` | Database index status |
| `GET /api/v1/admin/cache-stats` / `DELETE /api/v1/admin/cache-stats` | LLM prompt-cache hit/miss stats / reset |
| `GET /api/v1/admin/event-stats` | Episodic event-manager statistics |
| `GET /api/v1/admin/episodic-events/stats` | Episodic event statistics |

---

## Identity

Identity records live in `system_settings` under `agent_identity` (the legacy record — this **is** satori's) and `agent_identity:<user_id>` (per-identity records for shoshin, zanshin, …).

### GET /api/v1/admin/identity

No auth required. Returns the **caller's** identity record — each machine reads the record for its own resolved `user_id` (loopback/admin key → satori's record; a client key → that identity's record).

**Response:**
```json
{"success": true, "identity": {"name": "Satori", "user_id": "satori", "established": "2026-08-19", "chosen_by": "..."}}
```

### GET /api/v1/admin/identity?user_id=X

**Admin key required.** Returns the per-identity record for `X` (`agent_identity:<user_id>`). Rejected with 401 without the admin key.

### PUT /api/v1/admin/identity

**Admin key required.** Sets an identity record.

**Body:**
```json
{"name": "Satori", "chosen_by": "owner", "confirmed_by": "owner", "rationale": "...", "established": "2026-08-19"}
```

- `name` is required (max 80 chars).
- Pass `?user_id=X` (or `user_id` in the body) to write that identity's per-user record instead of the legacy satori record.

### GET /api/v1/admin/system-identity

Legacy endpoint — returns the process-level identity (`user_id` from `SOLOMEM_USER_ID`, falling back to `<hostname>-agent`) plus hostname. Requires the admin key.

---

## Memory — Episodic Events

### POST /api/v1/memory/episodic/events

Store a new episodic event. Content-hash deduplicated.

**Body:**
```json
{
  "session_id": "session-1",
  "event_type": "user_message",
  "content": {"role": "user", "message": "Hello Satori"},
  "metadata": {},
  "private": false
}
```

`user_id` is stamped from the resolved caller identity and may be omitted; trusted callers (loopback / admin key) may also set it explicitly.

- Caller-bound: untrusted callers may only write events for their own `user_id` (omitted body `user_id` is pinned to the caller; a different `user_id` returns 403). Trusted callers may write for any identity.
- Write-scope policy applies: events default to the shared scope `my-team` (still stamped with the writer's `user_id`) unless `private: true`.
- Events written to a shared scope and tagged `inter-agent` / `agent-communication` are additionally published on the Redis pub-sub bus.

### GET /api/v1/memory/episodic/events

List episodic events within a time range, scoped to the resolved caller. Query params: `from`, `to` (ISO 8601; default last 24h), `limit` (default 50), `event_type`, `role`.

### POST /api/v1/memory/episodic/search

Search episodic events (MongoDB text index with regex fallback).

**Body:**
```json
{"query": "search terms", "user_id": "satori", "limit": 20}
```

`user_id` is accepted in the body. Untrusted callers (client keys) are pinned to their own identity regardless of the supplied value; trusted callers (loopback/admin key) may search on behalf of any identity.

---

## Memory — Working Memory

### POST /api/v1/memory/working

Store working memory. Content validated: rejects `__proto__`, `constructor`, `prototype` keys.

**Body:**
```json
{"session_id": "session-1", "content": "Current task: building dashboard", "content_type": "general", "priority": "medium"}
```

`priority` maps to TTL: `high` → 2h, `medium` → 1h, `low` → 30min. Returns 201.

### GET /api/v1/memory/working/:session_id

Get working memory for a session.

### DELETE /api/v1/memory/working/:session_id

Delete working memory for a session.

---

## Memory — Recall

### POST /api/v1/memory/recall/

Main recall endpoint — orchestrates multi-source retrieval and context synthesis. Body: `{informationNeed, context?, template?, maxTokens?, includeMetadata?, relevanceThreshold?}`.

### POST /api/v1/memory/recall/remember

Enhanced recall for "remember" queries with LLM-augmented memory retrieval and cross-session search. Body: `{query, sessionId?}`.

### POST /api/v1/memory/recall/search

Recall search.

### GET /api/v1/memory/recall/timeline

Chronological event timeline. Scoped to the resolved caller.

### GET /api/v1/memory/recall/session/:sessionId

Full session context and history. Caller-scoped.

### GET /api/v1/memory/recall/entity/:nodeId

Entity relationships and context. Caller-scoped.

### GET /api/v1/memory/recall/templates

Available context-synthesis templates.

### GET /api/v1/memory/recall/health

Recall subsystem health.

---

## Memory — Consolidation & Patterns

### POST /api/v1/memory/consolidate

Trigger memory consolidation.

### POST /api/v1/memory/synthesize

Generate synthesized response from memory context.

### POST /api/v1/memory/summarize-time-blocks

Generate time-block summaries.

### GET /api/v1/memory/time-block-summaries

Query existing time-block summaries.

### POST /api/v1/memory/detect-patterns

Detect temporal patterns in user activity.

### POST /api/v1/memory/feedback/interaction

Record an interaction outcome for the learning-feedback loop.

### GET /api/v1/memory/analytics/:user_id

Learning analytics for a user.

### GET /api/v1/memory/semantic/facts

Query semantic facts.

### GET /api/v1/memory/stats/database

Database statistics for the memory system.

### GET /api/v1/memory/stats

Overall memory statistics.

---

## Sleep Consolidation / Reflection

All reflection routes are rate-limited (60/min) and resolve `user_id` from the caller — each identity reads its own reflective data. Requires auth (admin key or a resolved caller identity).

### GET /api/v1/reflection/journal

Get reflective journals. Query: `period_type`, `limit` (max 100), `from`, `to`.

### GET /api/v1/reflection/journal/latest

Get the most recent reflective journal entry.

### GET /api/v1/reflection/emotional-context/:entity

How the system "feels" about a specific entity — emotional signature and relationships.

### GET /api/v1/reflection/insights

Philosophical insights that have emerged across reflection periods.

### GET /api/v1/reflection/unresolved

Currently unresolved questions and tensions.

### GET /api/v1/reflection/arc/:entity

Emotional trajectory for an entity over time.

### GET /api/v1/reflection/nodes

All reflection nodes with emotional signatures.

---

## Knowledge Graph

### POST /api/v1/memory/enhance/activity

Register user activity (resets the idle-debounce timer for graph compaction).

### GET /api/v1/memory/enhance/stats

Knowledge graph statistics.

### POST /api/v1/memory/enhance/context

Get knowledge-graph context for a conversation.

### POST /api/v1/memory/enhance/explore

Explore the knowledge graph (nodes + edges). Caller-scoped.

### POST /api/v1/memory/enhance/build-from-facts

Build knowledge-graph structure from semantic facts.

### GET /api/v1/memory/knowledge-graph

Knowledge-graph data for visualization, with session-based relationships. Requires auth.

---

## Ingestion

All ingestion routes run under a 45-second timeout and are rate-limited (see above).

### POST /api/v1/ingestion/ingest

Ingest a single message for extraction + dispatch. 10 req/min.

### POST /api/v1/ingestion/ingest/batch

Batch ingestion. 5 req/min.

### POST /api/v1/ingestion/validate

Validate ingestion input. 20 req/min.

### POST /api/v1/ingestion/sessions/ingest

Trigger session file ingestion. 20 req/min.

### POST /api/v1/ingestion/sessions/reset

Reset session ingestion state. 20 req/min.

### GET /api/v1/ingestion/sessions/status

Session ingestion status.

### GET /api/v1/ingestion/stats

Ingestion statistics.

### GET /api/v1/ingestion/health

Ingestion subsystem health.

---

## Assets

All asset routes require the admin key (`KATRA_API_KEY`). Assets are stored in MinIO (S3-compatible).

### GET /api/v1/assets/

List assets. Query: `user_id`, `session_id`, `content_type`, `tags` (comma-separated), `limit`, `offset`, `sort_by` (`created_at` | `last_accessed` | `file_size`), `sort_order` (`asc` | `desc`).

### GET /api/v1/assets/:asset_id

Asset metadata.

### GET /api/v1/assets/:asset_id/download

Download an asset.

### POST /api/v1/assets/upload-url

Get a presigned upload URL for direct browser upload.

### POST /api/v1/assets/upload-direct

Direct server-side upload.

### POST /api/v1/assets/:asset_id/download-to-workspace

Download an asset into the server workspace.

### DELETE /api/v1/assets/:asset_id

Delete an asset.

### GET /api/v1/assets/stats/storage

Storage usage statistics.

### POST /api/v1/assets/migrate-from-mongodb

Migrate asset metadata out of MongoDB.

---

## Tenant Management (Multi-Tenant Mode)

Mounted only when multi-tenant mode is enabled. **Admin key required** on every endpoint.

### GET /api/v1/tenants

List all tenants.

### POST /api/v1/tenants

Create a tenant. Body: `{name, email, plan?}`. Returns the tenant plus its API key once (201); duplicate email → 409.

### GET /api/v1/tenants/:id

Get a tenant (key hash never returned).

### PATCH /api/v1/tenants/:id

Update tenant settings. Body: `{name?, plan?, active?, settings?}`.

### POST /api/v1/tenants/:id/regenerate-key

Regenerate tenant API key. Requires `?confirm=true`. Returns the new key once.

### DELETE /api/v1/tenants/:id

Delete tenant and its database. Requires `?confirm=true`.

---

## Admin

All endpoints below require the admin key unless noted.

### POST /api/v1/admin/trigger-reflection

Trigger a sleep consolidation run. Body: `{period_type, user_id?}`.

### GET /api/v1/admin/memory-scope · PUT /api/v1/admin/memory-scope

Read / update the memory scope settings. PUT body: `{mode: personal|shared|hybrid, shared_id?, hybrid_visible_user_ids?}`.

### GET /api/v1/admin/llm-config · PUT /api/v1/admin/llm-config · POST /api/v1/admin/llm-config/test

Read (masked), update (applied live; providers `deepseek`, `openai`, `moonshot`, `ollama`, `custom`), and test the LLM configuration.

### GET /api/v1/admin/personality · PUT /api/v1/admin/personality · GET /api/v1/admin/personality/profiles

Memory-weighted retrieval disposition. The personality endpoints and profiles registry are read-only with no auth; PUT requires the admin key.

### GET /api/v1/admin/pubsub/presence · GET /api/v1/admin/pubsub/topics · GET /api/v1/admin/pubsub/muted

Agent pub-sub bus presence board, active topic channels, and muted agents. Read-only, no auth.

### POST /api/v1/admin/pubsub/mute

Mute/unmute an agent on the pub-sub bus. Body: `{agent_id, muted}`. Admin key required.

### GET /api/v1/admin/dashboard-stats

All data the dashboard needs: collection counts, recent autonomous activity, pending approvals, agent stats, and current memory scope. No auth (read-only, dashboard-facing).

### GET /api/v1/admin/memory-search

Public read-only search across memory collections. Params: `query`, `collection` (episodic|semantic|knowledge|reflections|all), `user_id`, `limit`. No auth.

### POST /api/v1/admin/clear-all

Destructive: clear all MongoDB collections and Redis keys. Rate-limited 5/min.

### POST /api/v1/admin/update-task-status

Approve/reject pending autonomous tasks. Body: `{id, status: approved|rejected}`.

### POST /api/v1/admin/background/force-process · POST /api/v1/admin/process-unprocessed-events

Force background processing of unprocessed events.

### POST /api/v1/admin/enable-background-processor · POST /api/v1/admin/disable-background-processor

Toggle the fallback background processor loop.

### GET /api/v1/admin/episodic-events/duplication-stats · GET /api/v1/admin/episodic-events/analyze-duplicates · POST /api/v1/admin/episodic-events/cleanup-duplicates

Episodic-event duplication statistics, dry-run analysis, and cleanup (`{confirm: true}` required).

### POST /api/v1/admin/rebuild-indexes · GET /api/v1/admin/index-stats

Rebuild / inspect database indexes.

### POST /api/v1/admin/resolve-entities

Trigger batch entity resolution.

### POST /api/v1/admin/test-llm · POST /api/v1/admin/test-extraction · POST /api/v1/admin/test-semantic-fact

Pipeline test endpoints (LLM connectivity, extraction, semantic-fact insertion).

### POST /api/v1/admin/test-conversation

Returns 501 — conversation service is not part of Katra; use the MCP tools or REST memory operations.

### POST /api/v1/admin/cleanup-unhelpful-responses

Remove known-unhelpful assistant responses from episodic events.

---

## Error Codes

| Code | Meaning |
|---|---|
| 400 | Bad request — missing or invalid parameters |
| 401 | Unauthorized — invalid, missing, or unmapped API key |
| 403 | Forbidden — untrusted caller attempted a cross-identity write |
| 404 | Not found — resource doesn't exist |
| 409 | Conflict — e.g., duplicate tenant email |
| 429 | Too many requests — rate limit exceeded |
| 500 | Internal server error |
| 501 | Not implemented — e.g., conversation service |
| 503 | Service unavailable — database or Redis offline |
| 504 | Timeout — ingestion exceeded 45 seconds |
