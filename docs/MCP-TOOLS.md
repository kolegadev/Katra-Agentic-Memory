# MCP Tools Reference

Katra exposes **29 tools** via the Model Context Protocol (MCP). All tools are accessible through the MCP endpoint at `http://localhost:3112/mcp` (the host-mapped port; inside the container this is `3100`).

## Authentication

All MCP requests require:
```
Authorization: Bearer <your-mcp-api-key>
Accept: application/json, text/event-stream
```

## JSON-RPC Call Pattern

```bash
# 1. Initialize
SESSION_ID=$(curl -s -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -D - | grep -i "mcp-session-id" | awk '{print $2}' | tr -d '\r')

# 2. Call a tool (include session ID header)
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
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
| shared_id | string | No | — |
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
| shared_id | string | No | — |
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

### create_mission

Create a goal with optional task breakdown.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | Yes |
| goal | string | Yes |
| shared_id | string | No | — |
| title | string | No | — |
| tasks | string[] | No | — |

### update_mission_task

Update the status of a task within a mission.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | Yes |
| mission_id | string | Yes |
| task_id | string | Yes |
| status | enum: `pending`, `in_progress`, `completed`, `blocked` | Yes |

---

## Recall

### search_memories

Full-text + vector search across **11 memory collections**.

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

### get_journal

Read journal entries (manual and/or auto-generated).

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| source | enum: `auto`, `manual`, `all` | No | `all` |
| limit | number | No | 20 |

### get_auto_journal

Query AI-distilled journal entries generated from conversations.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | — |
| since | ISO 8601 date | No | — |
| limit | number | No | 20 |

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

### explore_graph

Explore the knowledge graph — entities and relationships extracted from conversations.

| Parameter | Type | Required | Default |
|---|---|---|---|
| query | string | No | — |
| limit | number (1–100) | No | 20 |
| include_edges | boolean | No | true |

---

## Memory Scope

### get_memory_scope

Get the current memory scope settings: mode, shared_id, and visible user IDs.

Takes no arguments.

### set_memory_scope

Set memory scope mode and configuration.

| Parameter | Type | Required | Default |
|---|---|---|---|
| mode | enum: `personal`, `shared`, `hybrid` | Yes | — |
| shared_id | string | No | — |
| hybrid_visible_user_ids | string[] | No | — |

**Example:**
```json
{"name":"set_memory_scope","arguments":{"mode":"shared","shared_id":"my-team"}}
```

---

## LLM Configuration

### get_llm_config

Get the current LLM provider configuration. API key is masked.

Takes no arguments.

### configure_llm

Configure the LLM provider for semantic extraction, auto-journaling, and summaries. Applies live without restart.

| Parameter | Type | Required | Default |
|---|---|---|---|
| provider | enum: `deepseek`, `openai`, `moonshot`, `ollama`, `custom` | Yes | — |
| api_key | string | Yes | — |
| base_url | string | No | per-provider default |
| model | string | No | per-provider default |

**Example:**
```json
{"name":"configure_llm","arguments":{"provider":"deepseek","api_key":"sk-...","base_url":"https://api.deepseek.com/v1","model":"deepseek-v4-flash"}}
```

---

## System

### get_memory_diagnostics

Get storage stats, index health, embedding coverage, and overall health.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No |

### get_background_status

Check background processor queue depth, last run time, and errors.

Takes no arguments.

### get_health

Check all backend services: MongoDB, Redis, LLM, and embedding model status.

Takes no arguments.

### get_heartbeat_status

Check heartbeat scheduler state.

Takes no arguments.

### get_transaction_log

Query the audit trail of agent actions.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |
| action | string | No | — |
| since | ISO 8601 date | No | — |
| limit | number | No | 50 |

### list_assets

List uploaded assets stored in MinIO/S3.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |
| content_type | string | No | — |
| limit | number | No | 20 |
