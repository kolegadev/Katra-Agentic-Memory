# REST API Reference

Katra exposes a REST API under `/api/v1/` on port 9002 (configurable).

## Authentication

All endpoints require:
```
Authorization: Bearer <your-katra-api-key>
```

## Response Format

All responses are JSON. Standard envelope:

```json
{"success": true, "data": {...}}
```

Error responses:
```json
{"success": false, "error": "Error message", "code": "ERROR_CODE"}
```

---

## Health & Diagnostics

### GET /

Server info (name, version, description, endpoints).

### GET /api/v1/health

Health check — returns service status.

**Response:**
```json
{"status": "ok", "services": {"mongodb": "connected", "redis": "connected", "llm": "deepseek", "embeddings": "available"}}
```

### GET /api/v1/memory/stats/database

Database statistics — query performance, index usage, connection pool, cache stats.

### GET /api/v1/admin/diagnostics

Full diagnostics — document counts by collection, processing backlog, embedding coverage, index status.

---

## Memory — Episodic Events

### POST /api/v1/memory/episodic/events

Store a new episodic event.

**Body:**
```json
{
  "user_id": "my-agent",
  "session_id": "session-1",
  "event_type": "user_message",
  "content": {"role": "user", "message": "Hello Katra"},
  "timestamp": "2026-06-18T12:00:00Z",
  "metadata": {}
}
```

### GET /api/v1/memory/episodic/events

List episodic events.

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

Store working memory for a session.

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

**Body:**
```json
{
  "informationNeed": "What did we discuss about trading?",
  "context": {},
  "maxTokens": 2000,
  "includeMetadata": true
}
```

---

## Memory — Consolidation

### POST /api/v1/memory/consolidate

Trigger memory consolidation (merge similar memories, extract facts).

### POST /api/v1/memory/synthesize

Generate synthesized response from memory context.

### POST /api/v1/memory/summarize-time-blocks

Generate time-block summaries.

**Body:**
```json
{"user_id": "my-agent", "block_type": "week", "lookback_days": 30}
```

### POST /api/v1/memory/detect-patterns

Detect temporal patterns in user activity.

**Body:**
```json
{"user_id": "my-agent", "lookback_weeks": 12}
```

---

## Knowledge Graph

### POST /api/v1/memory/enhance/graph/nodes

Search knowledge graph nodes.

**Body:**
```json
{"query": "trading", "limit": 20}
```

### POST /api/v1/memory/enhance/explore

Explore the knowledge graph (nodes + edges).

---

## Ingestion

### POST /api/v1/ingestion/openclaw/ingest

Trigger session ingestion (reads JSONL files from configured session directory).

### GET /api/v1/ingestion/openclaw/status

Get ingestion status — sessions processed, events stored, errors, last run.

### POST /api/v1/ingestion/openclaw/reset

Reset ingestion state (re-ingest all sessions on next run).

---

## Assets

### GET /api/v1/assets

List uploaded assets.

**Query params:** `user_id`, `content_type`, `limit`

### POST /api/v1/assets/upload

Upload an asset (multipart form data).

---

## Admin

### GET /api/v1/admin/diagnostics

Full system diagnostics.

### POST /api/v1/admin/indexes/rebuild

Rebuild database indexes.

### POST /api/v1/admin/cache/clear

Clear Redis cache.

---

## Error Codes

| Code | Meaning |
|---|---|
| 400 | Bad request — missing or invalid parameters |
| 401 | Unauthorized — invalid or missing API key |
| 404 | Not found — resource doesn't exist |
| 422 | Unprocessable — validation failed (e.g., protected file guard) |
| 500 | Internal server error |
| 503 | Service unavailable — database or Redis offline |
