# MCP Tools Reference

Katra exposes 25 tools via the Model Context Protocol (MCP). All tools are accessible through the MCP endpoint at `http://localhost:3100/mcp`.

## Authentication

All MCP requests require:
```
Authorization: Bearer <your-katra-api-key>
Accept: application/json, text/event-stream
```

## JSON-RPC Call Pattern

```bash
# 1. Initialize
curl -X POST http://localhost:3100/mcp \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# Response header contains: mcp-session-id: <session-id>

# 2. Call a tool (include session ID header)
curl -X POST http://localhost:3100/mcp \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"store_memory","arguments":{"content":"Hello Katra","user_id":"my-agent"}}}'
```

---

## Storage

### store_memory

Store a memory (fact, preference, insight, event, or general).

| Parameter | Type | Required | Default |
|---|---|---|---|
| content | string | Yes | — |
| user_id | string | No | — |
| category | enum: `fact`, `preference`, `insight`, `event`, `general` | No | `general` |
| confidence | number (0–1) | No | 0.8 |

**Example:**
```json
{"name":"store_memory","arguments":{"content":"User prefers dark mode","user_id":"my-agent","category":"preference","confidence":0.95}}
```

### store_journal

Save a journal entry (reflection, milestone, observation).

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| entry | string | Yes | — |
| source | enum: `manual`, `system` | No | `manual` |
| tags | string[] | No | `[]` |

### working_memory

Read, store, or delete short-term session memory (Redis-backed, <5ms access).

| Parameter | Type | Required |
|---|---|---|
| session_id | string | Yes |
| action | enum: `get`, `store`, `delete` | Yes |
| content | string | No (required for `store`) |
| limit | number | No (default 10, for `get`) |

---

## Recall

### search_memories

Full-text search across all stored memories.

| Parameter | Type | Required | Default |
|---|---|---|---|
| query | string | Yes | — |
| user_id | string | No | — |
| limit | number | No | 10 |

### vector_search

Semantic similarity search (finds related concepts even without keyword match).

| Parameter | Type | Required | Default |
|---|---|---|---|
| query | string | Yes | — |
| user_id | string | No | — |
| limit | number | No | 10 |

### temporal_recall

Query episodic events within a date/time range.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| from | ISO 8601 date | No | 24h ago |
| to | ISO 8601 date | No | now |
| limit | number | No | 50 |
| event_type | string | No | — |
| role | enum: `user`, `assistant` | No | — |

### temporal_search

Search episodic events by keyword with time context.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| query | string | Yes | — |
| limit | number | No | 20 |

### get_conversation_history

Retrieve the full conversation history for a session.

| Parameter | Type | Required | Default |
|---|---|---|---|
| session_id | string | Yes | — |
| limit | number | No | 20 |

### get_temporal_context

Get the current temporal context for a session (recent events + working memory state).

| Parameter | Type | Required |
|---|---|---|
| user_id | string | Yes |
| session_id | string | Yes |

---

## Analysis

### detect_patterns

Detect recurring topics, session rhythms, topic regressions, and dormant topics.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| lookback_weeks | number (1–52) | No | 12 |
| min_confidence | number (0–1) | No | 0.5 |
| dormant_threshold_days | number (1–365) | No | 14 |

### get_time_block_summaries

Query AI-generated time-block summaries (day, week, or month granularity).

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| block_type | enum: `day`, `week`, `month` | No | `week` |
| from | ISO 8601 date | No | 30 days ago |
| to | ISO 8601 date | No | now |
| limit | number | No | 20 |

### summarize_time_blocks

Trigger LLM summarization of conversation activity across time blocks.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| block_type | enum: `day`, `week`, `month` | No | `week` |
| lookback_days | number (1–365) | No | 90 |
| max_blocks | number (1–52) | No | 20 |
| dry_run | boolean | No | false |

### get_auto_journal

Query AI-distilled journal entries (auto-generated from conversations).

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| since | ISO 8601 date | No | — |
| limit | number | No | 20 |

### get_journal

Read journal entries (manual and/or auto-generated).

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| source | enum: `auto`, `manual`, `all` | No | `all` |
| limit | number | No | 20 |

---

## Knowledge Graph

### explore_graph

Explore the knowledge graph — entities and relationships extracted from conversations.

| Parameter | Type | Required | Default |
|---|---|---|---|
| query | string | No | — |
| limit | number (1–100) | No | 20 |
| include_edges | boolean | No | true |

---

## Missions

### create_mission

Create a goal with optional task breakdown.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | Yes |
| goal | string | Yes |
| title | string | No |
| tasks | string[] | No |

### list_missions

List all missions for a user.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| limit | number | No | 10 |

### get_mission

Get full mission details including task tree and progress.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | Yes |
| mission_id | string | Yes |

### update_mission_task

Update a task's status within a mission.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | Yes |
| mission_id | string | Yes |
| task_id | string | Yes |
| status | enum: `pending`, `in_progress`, `completed`, `blocked` | Yes |

---

## System

### get_memory_diagnostics

Get storage stats, index health, embedding coverage, and overall health.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No |

### get_background_status

Check background processor queue depth, last run time, and errors.

### get_health

Check all backend services: MongoDB, Redis, LLM, embedding model.

### get_heartbeat_status

Check heartbeat scheduler: running state, last run, next scheduled, interval, history.

### list_assets

List uploaded assets stored in MinIO/S3.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |
| content_type | string | No | — |
| limit | number | No | 20 |

### get_transaction_log

Query the audit trail of agent actions.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |
| action | string | No | — |
| since | ISO 8601 date | No | — |
| limit | number | No | 50 |
