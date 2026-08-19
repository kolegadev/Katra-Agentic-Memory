# MCP Tools Reference

Satori exposes **48 tools** via the Model Context Protocol (MCP). All tools are accessible through the MCP endpoint at `http://localhost:3112/mcp`.

## Authentication

All MCP requests require:
```
X-MCP-Auth: <your-mcp-api-key>
Accept: application/json, text/event-stream
```

API keys are SHA-256 hashed with timing-safe comparison. Keys can also be passed via:
- `Authorization: Bearer <key>` (REST-style, also supported)
- `?token=<key>` query parameter (URL-based, also supported)

## Security

- **Stdio transport**: Requires `MCP_API_KEY` to be configured (refuses to start without it)
- **Admin tools**: `set_memory_scope`, `configure_llm` require `KATRA_API_KEY` (admin), not just `MCP_API_KEY`
- **User scoping**: All memory operations are scoped to the authenticated user — cross-user data access is prevented at the database query level
- **Input validation**: Working memory rejects prototype pollution keys. Request body capped at 10MB.

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
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"store_memory","arguments":{"content":"Hello Satori","user_id":"my-agent"}}}'
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
| session_id | string | No | — |
| source | string | No | `mcp_store` |
| tags | string[] | No | `[]` |

**Notes:**
- `category: "event"` routes the memory through the episodic event pipeline and uses `session_id` for grouping.
- `source` and `tags` help downstream filtering and audit trails.
- Memories are content-hash deduplicated.

**Example:**
```json
{"name":"store_memory","arguments":{"content":"User prefers dark mode","user_id":"my-agent","category":"preference","confidence":0.95}}
```

**Episodic event example:**
```json
{"name":"store_memory","arguments":{"content":"User asked about Satori memory fixes","user_id":"my-agent","category":"event","session_id":"thread-123","source":"kolega-code","tags":["conversation"]}}
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
| block_type | enum: `day`, `week`, `month` | No | — |
| from | ISO 8601 date | No | 30 days ago |
| to | ISO 8601 date | No | now |
| limit | number (1–50) | No | 20 |

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

## Sleep Consolidation / Reflection

### trigger_reflection

Manually trigger a sleep consolidation run for a specific time period. The system gathers all memory data from the period and distills it into emotional understanding, philosophical insights, and reflective narrative.

| Parameter | Type | Required |
|---|---|---|
| period_type | enum: `daily`, `weekly`, `monthly` | Yes |
| user_id | string | No |

### get_daily_reflection

Get the most recent reflective journal entry from sleep consolidation.

| Parameter | Type | Required |
|---|---|---|
| period_type | enum: `daily`, `weekly`, `monthly` | No (default: `daily`) |
| user_id | string | No |

### get_emotional_context

How the system "feels" about a specific entity — emotional signature and all emotional edges.

| Parameter | Type | Required |
|---|---|---|
| entity_name | string | Yes |
| user_id | string | No |

### get_philosophical_insights

Query philosophical insights that have emerged across reflection periods.

| Parameter | Type | Required | Default |
|---|---|---|---|
| domain | string | No | — |
| status | enum: `emerging`, `strengthening`, `stable`, `challenged` | No | — |
| limit | number | No | 10 |
| user_id | string | No | — |

### get_reflection_arc

Trace the emotional trajectory for an entity over time.

| Parameter | Type | Required |
|---|---|---|
| entity_name | string | Yes |
| user_id | string | No |
| limit | number | No (default: 10) |

### get_unresolved_threads

Get unresolved questions and tensions that persist across reflection periods.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No |

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

---

## Cognitive Architecture

### get_memory_decay_stats

Returns per-type memory decay statistics: total, active, decaying, forgotten counts, average strength, and half-life remaining for each memory type.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |

### get_anomaly_report

Returns anomaly detection report: total ingested count, breakdown by normal/suspect/anomalous/quarantined, average z-score, and list of recent anomalies.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |

### get_quarantined_memories

Lists quarantined memories with metadata: z-score, type, corroboration count, and quarantine date.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |

### get_salience_state

Returns current meta-state (exploration/task_execution/reflection/alert/idle), attention threshold, average salience score, and score distribution.

Takes no arguments.

### get_attention_report

Comprehensive attention report: processing distribution by salience tier (high/medium/low counts), current threshold, and active goals.

Takes no arguments.

### get_drive_state

Returns the 4 homeostatic drives (coherence, novelty, connection, growth) with current level, strength, trend, and the dominant drive.

Takes no arguments.

### get_source_trust

Returns trust metrics for a source: trust score, corroboration count, contradiction count, and last updated timestamp.

| Parameter | Type | Required | Default |
|---|---|---|---|
| source_id | string | Yes | — |

### get_error_report

Returns ACC error monitor: prediction accuracy, average TD error, surprise rate, conflict count, and recent errors tracked.

Takes no arguments.

### get_action_policy

Returns learned Q-values and softmax selection probabilities for each available action in the given state.

| Parameter | Type | Required | Default |
|---|---|---|---|
| state_key | string | Yes | — |

### get_identity_kernel

Returns the "I am the kind of agent who..." narrative distilled from stable philosophical insights, plus the top 5 supporting insights.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |

### get_mind_wander

Performs a random walk on the knowledge graph, returns the traversal path and associative narrative, and stores the result as a low-salience event.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |

### get_agent_beliefs

Returns Theory of Mind beliefs about a named entity: proposition, confidence, source, and last updated timestamp.

| Parameter | Type | Required | Default |
|---|---|---|---|
| entity_name | string | Yes | — |
| user_id | string | No | — |

### get_procedural_templates

Returns cached tool-call patterns that have been observed 5+ times: tool name, input shape, frequency, and average success rate.

Takes no arguments.
