# REST API Reference

Satori exposes a REST API under `/api/v1/` on port 9012 (host-mapped from container port 9002).

## Authentication

All endpoints (except `/api/v1/health`) require a valid API key:

```
Authorization: Bearer <your-katra-api-key>
```

API keys are stored as SHA-256 hashes in MongoDB — plaintext keys never touch the database. Keys can be set via:
- `.env` (`KATRA_API_KEY` / `MCP_API_KEY`)
- Auto-generated on first boot (printed to logs, persisted as hashes)
- Admin dashboard at `http://localhost:9012/dashboard/`

Timing-safe comparison is used for all key validation — resistant to timing side-channel attacks.

## Response Format

All responses are JSON. Standard envelope:

```json
{"success": true, "data": {...}}
```

Error responses:
```json
{"success": false, "error": "Error message", "code": "ERROR_CODE"}
```

## Rate Limiting

Admin endpoints and ingestion routes are rate-limited (sliding window, Redis-backed). Default: 120 req/min for ingestion, per-endpoint limits for admin operations.

---

## Health & Diagnostics

### GET /api/v1/health

Health check — no auth required. Returns service status.

**Response:**
```json
{"status": "ok", "services": {"mongodb": "connected", "redis": "connected", "llm": "deepseek", "embeddings": "available"}}
```

### GET /healthz

Admin health — includes Docker availability. Requires `KATRA_API_KEY`.

### GET /api/v1/admin/diagnostics

Full diagnostics — document counts, processing backlog, embedding coverage, index status. Requires auth.

### GET /api/v1/memory/status

Memory system status — collection counts, processing state, LLM/embedding availability.

---

## Memory — Episodic Events

### POST /api/v1/memory/episodic/events

Store a new episodic event. Content-hash deduplicated.

**Body:**
```json
{
  "user_id": "my-agent",
  "session_id": "session-1",
  "event_type": "user_message",
  "content": {"role": "user", "message": "Hello Satori"},
  "metadata": {}
}
```

### GET /api/v1/memory/episodic/events

List episodic events. Scoped to authenticated user.

**Query params:** `user_id`, `limit` (default 20), `session_id`, `event_type`

### POST /api/v1/memory/episodic/search

Search episodic events.

**Body:**
```json
{"query": "search terms", "user_id": "my-agent", "limit": 10}
```

---

## Memory — Working Memory

### POST /api/v1/memory/working

Store working memory. Content validated: rejects `__proto__`, `constructor`, `prototype` keys. Max 5MB per item.

**Body:**
```json
{"session_id": "session-1", "content": "Current task: building dashboard"}
```

### GET /api/v1/memory/working/:session_id

Get working memory for a session.

### DELETE /api/v1/memory/working/:session_id

Delete working memory for a session.

---

## Memory — Recall

### POST /api/v1/memory/recall/search

Advanced recall search with context synthesis.

### POST /api/v1/memory/recall/remember

Enhanced recall for "remember" queries with LLM-augmented memory retrieval.

### GET /api/v1/memory/recall/timeline

Chronological event timeline. Scoped to authenticated user.

### GET /api/v1/memory/recall/session/:sessionId

Full session context and history. User-scoped.

### GET /api/v1/memory/recall/entity/:nodeId

Entity relationships and context. User-scoped.

---

## Memory — Consolidation & Patterns

### POST /api/v1/memory/consolidate

Trigger memory consolidation.

### POST /api/v1/memory/synthesize

Generate synthesized response from memory context.

### POST /api/v1/memory/summarize-time-blocks

Generate time-block summaries.

### POST /api/v1/memory/detect-patterns

Detect temporal patterns in user activity.

---

## Sleep Consolidation / Reflection

### GET /api/v1/reflection/journal

Get reflective journals. Query: `period_type`, `limit`.

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

### POST /api/v1/memory/enhance/graph/nodes

Search knowledge graph nodes.

### POST /api/v1/memory/enhance/explore

Explore the knowledge graph (nodes + edges). User-scoped.

### GET /api/v1/memory/enhance/graph/stats

Knowledge graph statistics.

---

## Ingestion

### POST /api/v1/ingestion/ingest

Ingest a single message for extraction + dispatch.

### POST /api/v1/ingestion/ingest/batch

Batch ingestion. Rate limited: 120 req/min.

### POST /api/v1/ingestion/sessions/ingest

Trigger session file ingestion.

---

## Assets

### GET /api/v1/assets

List assets. Requires auth. Scoped to authenticated user.

### POST /api/v1/assets/upload-url

Get presigned upload URL.

### DELETE /api/v1/assets/:asset_id

Delete an asset. Requires auth.

---

## Tenant Management (Multi-Tenant Mode)

### GET /api/v1/tenants

List all tenants. Admin only.

### POST /api/v1/tenants

Create a tenant. Admin only.

### PATCH /api/v1/tenants/:id

Update tenant settings.

### POST /api/v1/tenants/:id/regenerate-key

Regenerate tenant API key. Requires `?confirm=true`.

### DELETE /api/v1/tenants/:id

Delete tenant and all its data. Requires `?confirm=true`.

---

## Admin

### GET /api/v1/admin/diagnostics

Full system diagnostics. Admin only.

### POST /api/v1/admin/trigger-reflection

Trigger a sleep consolidation run. Admin only.

### POST /api/v1/admin/sync-dns

Trigger GoDaddy DDNS sync. Admin only.

---

## Error Codes

| Code | Meaning |
|---|---|
| 400 | Bad request — missing or invalid parameters |
| 401 | Unauthorized — invalid or missing API key |
| 404 | Not found — resource doesn't exist |
| 422 | Unprocessable — validation failed |
| 429 | Too many requests — rate limit exceeded |
| 500 | Internal server error |
| 503 | Service unavailable — database or Redis offline |
