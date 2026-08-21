# MCP Tools Reference

Katra (the self-hosted cognitive memory appliance whose inhabitant is **Satori**) exposes **66 tools** via the Model Context Protocol (MCP). All tools are accessible through the MCP endpoint at `http://<host>:3112/mcp` (host port 3112 → container port 3100). The transport is **POST-only streamable HTTP** — `GET /mcp` returns 405 (standalone SSE streams are not supported). A plain `GET /health` on the same port (3112) reports service health without authentication.

## Authentication & Identity Separation

Katra resolves **who is calling** from the API key presented on the request — never from anything the client self-reports. One Katra hosts three named identities plus one tool actor:

| user_id | Identity | Notes |
|---|---|---|
| `satori` | Satori | This machine's agent. Loopback requests and the admin key (`KATRA_API_KEY`) authenticate as **trusted** satori. |
| `shoshin` | Shoshin | iMac trading Kolega Code. |
| `zanshin` | Zanshin | iMac OpenCode desktop. |
| `gas-law-watcher` | (tool actor) | Writes team memory only; never allocated autonomous tasks. |

**Key presentation** — any one of:
- `X-MCP-Auth: <key>` header
- `Authorization: Bearer <key>` header (REST-style)
- `?token=<key>` URL query parameter

**Key resolution:**
- Keys live in `system_settings.client_keys` as **sha256 hashes only** — plaintext is never stored. Comparison is timing-safe.
- Client keys are provisioned idempotently at boot by `ensureClientKeys()`. The shoshin/zanshin keys are generated once and their plaintext printed exactly once in the "Client keys (identity separation)" block of the server log.
- Loopback callers (127.0.0.1/::1) authenticate as trusted satori without a key — host-side tools (bridge hooks, CLI scripts) rely on this.
- The admin key (`KATRA_API_KEY`) authenticates as **trusted** satori.
- A key mapped in `client_keys` authenticates as that identity, **untrusted** (see *Trusted vs untrusted callers* below).
- A key that validates but has **no identity mapping** is rejected with **401** — loud failure with a logged sha256 prefix of the presented key, never a silent fallback to a default identity.
- **Legacy env keys are retired**: the pre-cutover shared keys (`MCP_API_KEY`, `BACKUP_MCP_KEYS`) are no longer validated as MCP credentials in their own right. The only legacy material consulted at boot is the seeding of satori's own `client_keys` record from the legacy key hash; unmapped keys — including the retired backup keys — fail with 401.
- Stdio transport (local `--stdio` mode) refuses to start unless `MCP_API_KEY` is configured.

**Trusted vs untrusted callers:**
- Trusted callers (loopback, admin key) may supply `user_id` and act on behalf of any identity.
- Untrusted callers (client keys) are pinned to their own identity for **every** scoped read and write — `resolveUserId()` ignores a supplied `user_id` and uses the caller's own, so another identity's private data is never visible. (2026-08-21 hardening extended this to `vector_search`, `temporal_recall`/`temporal_search`, journals, missions, time-block and pattern tools, diagnostics, transaction log, assets, and `trigger_reflection`.)

## Memory Scoping (write-scope policy)

Implemented in `server/src/services/memory/write-scope-policy.ts`:

- **Personal kinds** — `journal`, `reflection`, `emotional`, `insight` — are **always private** to the writer's `user_id`. A shared write requested for these kinds is forced private (the `shared_id` is stripped).
- **All other `store_memory` writes** default to the shared scope **`my-team`**, still stamped with the writer's `user_id`. Passing `private: true` opts out.
- **Reads** are scope-filtered to the caller's own private memories plus the `my-team` shared scope. Every scoped read tool pins untrusted callers via `resolveUserId()` — a supplied `user_id` from an untrusted caller is ignored, so cross-identity private reads are impossible.

## Security

- **Caller-bound scoping**: every tool invocation runs inside the resolved caller identity (`runWithCaller`). Memory writes (`store_memory`, `store_journal`) and every scoped read tool pin untrusted callers to their own identity (`resolveWriteScope` / `resolveUserId`) — supplied `user_id` values are ignored. Since 2026-08-21 this covers `vector_search`, `temporal_recall`, `temporal_search`, `get_journal`, `get_auto_journal`, missions, time-block and pattern tools, `get_memory_diagnostics`, `get_transaction_log`, `list_assets`, and `trigger_reflection`.
- **Admin tools**: `set_memory_scope` and `configure_llm` are admin-level operations — their handlers refuse to run unless a Katra admin key (`KATRA_API_KEY`) is configured.
- **Input validation**: Working memory rejects prototype-pollution keys (`__proto__`, `constructor`, `prototype`). MCP request bodies are capped at 10MB.
- **Key storage**: only sha256 digests persist; the database never holds a value that grants access directly.

## JSON-RPC Call Pattern

```bash
# 1. Initialize
SESSION_ID=$(curl -s -X POST http://localhost:3112/mcp \
  -H "X-MCP-Auth: YOUR_IDENTITY_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -D - | grep -i "mcp-session-id" | awk '{print $2}' | tr -d '\r')

# 2. Call a tool (include session ID header)
curl -X POST http://localhost:3112/mcp \
  -H "X-MCP-Auth: YOUR_IDENTITY_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"store_memory","arguments":{"content":"Hello Satori"}}}'
```

`YOUR_IDENTITY_KEY` is the caller's own identity key (its hash in `client_keys`), or `KATRA_API_KEY` for trusted-satori access. A server restart invalidates session IDs; the server falls back to a stateless transport for non-initialize requests it cannot map to a session.

---

## Storage

### store_memory

Store a memory (fact, preference, insight, event, or general).

| Parameter | Type | Required | Default |
|---|---|---|---|
| content | string | Yes | — |
| user_id | string | No | caller's identity (trusted callers only may override) |
| shared_id | string | No | `my-team` (see scope policy; ignored for personal kinds / `private: true`) |
| private | boolean | No | `false` — set `true` to store with no shared scope |
| category | enum: `fact`, `preference`, `insight`, `event`, `general` | No | `general` |
| confidence | number (0–1) | No | 0.8 |
| session_id | string | No | — (required for episodic event routing) |
| source | string | No | `mcp_store` |
| tags | string[] | No | `[]` |

**Notes:**
- `category: "event"` routes the memory through the episodic event pipeline and uses `session_id` for grouping. Episodic events are content-hash deduplicated.
- `category: "insight"` is a personal kind — always private to the writer, even when a shared scope is requested.
- Every other write defaults to the shared scope `my-team` (stamped with the writer's `user_id`) unless `private: true`.
- `source` and `tags` help downstream filtering and audit trails.

**Example:**
```json
{"name":"store_memory","arguments":{"content":"User prefers dark mode","category":"preference","confidence":0.95}}
```

**Episodic event example:**
```json
{"name":"store_memory","arguments":{"content":"User asked about Satori memory fixes","category":"event","session_id":"thread-123","source":"kolega-code","tags":["conversation"]}}
```

**Private opt-out example:**
```json
{"name":"store_memory","arguments":{"content":"Local scratch note for myself only","category":"fact","private":true}}
```

### retract_memory

Retract a previously stored memory by ID. Retracted memories are excluded from `search_memories` and `vector_search` results by default (pass `include_retracted: true` to view them) and remain in the database for full auditability.

| Parameter | Type | Required | Default |
|---|---|---|---|
| memory_id | string | Yes | — (the `_id` returned by `store_memory`) |
| reason | string | Yes | — (stored as audit trail) |
| superseded_by_id | string | No | — (replacement memory — creates a correction chain) |

### store_journal

Save a journal entry (reflection, milestone, observation). Journals are a **personal kind** — always private to the writer's `user_id`, even when a `shared_id` is requested.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes | caller's identity (trusted callers only may override) |
| entry | string | Yes (max 4000 chars) | — |
| shared_id | string | No | ignored (journals are always private) |
| source | enum: `manual`, `system` | No | `manual` |
| tags | string[] | No | `[]` |

### working_memory

Read, store, or delete short-term session memory (Redis-backed, <5ms access).

| Parameter | Type | Required |
|---|---|---|
| session_id | string | Yes |
| action | enum: `get`, `store`, `delete` | Yes |
| content | string | No (required for `store`) |
| limit | number | No (default 10, max 50, for `get`) |

### create_mission

Create a goal with optional task breakdown.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes (pass your own identity) | — |
| goal | string | Yes | — |
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

### decompose_goal

Decompose a goal into a dependency-ordered subtask graph. The Goal Manager (PFC proxy) uses the LLM to break the goal into 3–7 subtasks with dependencies and returns the next unblocked action. Use for planning multi-step work.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (caller-bound for untrusted callers) |
| goal | string | Yes |

---

## Recall

### search_memories

Full-text + vector search across **11 memory collections** (episodic, semantic, manual/auto journals, knowledge graph nodes/relationships, memory nodes/edges, missions, assets, working memory). Supports OR-queries (`"Attention: Satori" OR "Attention: Shoshin"`).

| Parameter | Type | Required | Default |
|---|---|---|---|
| query | string | Yes | — |
| user_id | string | No | caller's identity (trusted callers only may override) |
| limit | number (1–50) | No | 10 |
| include_retracted | boolean | No | `false` |

Results respect the read-scope policy: the caller's own private memories plus the `my-team` shared scope.

### vector_search

Semantic similarity search (finds related concepts even without keyword match). Falls back to keyword search if the local embedding model is unavailable.

| Parameter | Type | Required | Default |
|---|---|---|---|
| query | string | Yes | — |
| user_id | string | No | — (filter by user ID — pass your own identity) |
| limit | number (1–20) | No | 10 |
| include_retracted | boolean | No | `false` |

### get_conversation_history

Retrieve the full conversation history for a session, chronologically ordered.

| Parameter | Type | Required | Default |
|---|---|---|---|
| session_id | string | Yes | — |
| limit | number | No | 20 |

### temporal_recall

Query episodic events within a date/time range.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes (pass your own identity) | — |
| from | ISO 8601 date | No | 24h ago |
| to | ISO 8601 date | No | now |
| limit | number (1–200) | No | 50 |
| event_type | string | No | — |
| role | enum: `user`, `assistant` | No | — |

### temporal_search

Search episodic events by keyword with time context (text index with regex fallback).

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes (pass your own identity) | — |
| query | string | Yes | — |
| limit | number (1–50) | No | 20 |

### get_temporal_context

Get the current temporal context for a session (recent events + working memory state + session metadata).

| Parameter | Type | Required |
|---|---|---|
| user_id | string | Yes |
| session_id | string | Yes |

### get_journal

Read journal entries (manual and/or auto-generated).

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes (pass your own identity) | — |
| source | enum: `auto`, `manual`, `all` | No | `all` |
| limit | number (1–50) | No | 20 |

### get_auto_journal

Query AI-distilled journal entries generated from conversations.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes (pass your own identity) | — |
| since | ISO 8601 date | No | — |
| limit | number (1–50) | No | 20 |

### list_missions

List all missions for a user.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes (pass your own identity) | — |
| limit | number (1–50) | No | 10 |

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
| user_id | string | Yes (pass your own identity) | — |
| lookback_weeks | number (1–52) | No | 12 |
| min_confidence | number (0–1) | No | 0.5 |
| dormant_threshold_days | number (1–365) | No | 14 |

### get_time_block_summaries

Query AI-generated time-block summaries (day, week, or month granularity).

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes (pass your own identity) | — |
| block_type | enum: `day`, `week`, `month` | No | — |
| from | ISO 8601 date | No | 30 days ago |
| to | ISO 8601 date | No | now |
| limit | number (1–50) | No | 20 |

### summarize_time_blocks

Trigger LLM summarization of conversation activity across time blocks.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | Yes (pass your own identity) | — |
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

Set memory scope mode and configuration. **Admin-level** — the handler refuses to run unless a Katra admin key is configured.

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

Configure the LLM provider for semantic extraction, auto-journaling, and summaries. Applies live without restart. **Admin-level** — the handler refuses to run unless a Katra admin key is configured.

| Parameter | Type | Required | Default |
|---|---|---|---|
| provider | enum: `deepseek`, `openai`, `moonshot`, `ollama`, `custom` | Yes | — |
| api_key | string | No for `ollama`; Yes otherwise | — |
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
| user_id | string | No (pass your own identity) |

### get_daily_reflection

Get the most recent reflective journal entry from sleep consolidation.

| Parameter | Type | Required |
|---|---|---|
| period_type | enum: `daily`, `weekly`, `monthly` | No (default: `daily`) |
| user_id | string | No (caller-bound for untrusted callers) |

### get_emotional_context

How the system "feels" about a specific entity — emotional signature and all emotional edges.

| Parameter | Type | Required |
|---|---|---|
| entity_name | string | Yes |
| user_id | string | No (caller-bound for untrusted callers) |

### get_philosophical_insights

Query philosophical insights that have emerged across reflection periods.

| Parameter | Type | Required | Default |
|---|---|---|---|
| domain | string | No | — |
| status | enum: `emerging`, `strengthening`, `stable`, `challenged` | No | — |
| limit | number (1–50) | No | 10 |
| user_id | string | No (caller-bound for untrusted callers) | — |

### get_unresolved_threads

Get unresolved questions and tensions that persist across reflection periods.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (caller-bound for untrusted callers) |

### resolve_thread

Resolve an unresolved thread by its exact text. The thread is marked resolved so it no longer appears in `get_unresolved_threads` and stops being re-allocated by the heartbeat.

| Parameter | Type | Required |
|---|---|---|
| thread_text | string | Yes |
| user_id | string | No (caller-bound for untrusted callers) |

### get_reflection_arc

Trace the emotional trajectory for an entity over time.

| Parameter | Type | Required |
|---|---|---|
| entity_name | string | Yes |
| user_id | string | No (caller-bound for untrusted callers) |
| limit | number (1–50) | No (default: 10) |

---

## Identity & Self-Model

### get_my_identity

Who am I? Returns the **caller's own** identity record (`name`, `user_id`, `established`, `chosen_by`, optional `rationale`). Pinned to the resolved caller identity — an untrusted caller can never read another agent's identity, even with a `user_id` argument.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (ignored for untrusted callers — always pinned to the caller) |

### get_identity_kernel

Returns the "I am the kind of agent who..." narrative distilled from stable philosophical insights, plus the top 5 supporting insights sorted by confidence.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (caller-bound for untrusted callers) |

### get_mind_wander

Performs a random walk on the knowledge graph (weighted by relationship strength), returns the traversal path and associative narrative, and stores the result as a low-salience event.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (caller-bound for untrusted callers) |

### get_agent_beliefs

Returns Theory of Mind beliefs about a named entity: proposition, confidence, source, and last updated timestamp.

| Parameter | Type | Required |
|---|---|---|
| entity_name | string | Yes |
| user_id | string | No (currently unused — beliefs are entity-keyed) |

### get_procedural_templates

Returns cached tool-call patterns that have been observed 5+ times: tool name, input shape, frequency, and average success rate.

Takes no arguments.

---

## Katra Skill Library

Procedural muscle memory: operational and decision distillations converted into executable skills (`SKILL.md`), stored in the server's skills directory.

### search_katra_skills

Search the skill library for relevant procedural skills. Returns ranked results with relevance scores.

| Parameter | Type | Required | Default |
|---|---|---|---|
| query | string | Yes | — |
| top_k | number (1–20) | No | 10 |
| category | enum: `operational`, `decision`, `troubleshooting` | No | — |

### load_katra_skill

Load the full `SKILL.md` content for a specific skill by name, with frontmatter metadata.

| Parameter | Type | Required |
|---|---|---|
| name | string | Yes (e.g., `"deploy-remote-service"`) |

### list_katra_skills

List all available skills, optionally filtered by category or lifecycle status.

| Parameter | Type | Required |
|---|---|---|
| category | enum: `operational`, `decision`, `troubleshooting` | No |
| status | enum: `observed`, `candidate`, `stable`, `challenged` | No |

### request_skill

Request synthesis of a new skill from operational memory. Queues the request for the operational distillation pipeline; the skill is auto-generated once enough patterns are observed.

| Parameter | Type | Required | Default |
|---|---|---|---|
| description | string | Yes | — |
| category | enum: `operational`, `decision`, `troubleshooting` | No | `operational` |

### get_skill_feedback

Get the feedback history for a specific skill — usage count, success/failure breakdown, and recent outcome notes.

| Parameter | Type | Required |
|---|---|---|
| skill_name | string | Yes |

### get_skill_activation_context

Given a task description, return relevant skills ranked by relevance (Path A context pre-seeding). Use before complex tasks to discover applicable procedural skills.

| Parameter | Type | Required | Default |
|---|---|---|---|
| task_description | string | Yes | — |
| max_skills | number (1–20) | No | 5 |

### run_operational_distillation

Run the operational distillation pipeline — scan episodic memory for repeatable tool-call patterns, identify candidate skills, and optionally auto-synthesize `SKILL.md` files.

| Parameter | Type | Required | Default |
|---|---|---|---|
| min_observations | number (2–20) | No | 3 |
| auto_synthesize | boolean | No | true |

### list_skill_candidates

List candidate skills identified by the operational distillation pipeline — patterns observed but not yet promoted to stable skills.

Takes no arguments.

### record_skill_outcome

Record the outcome of using a loaded skill. Persists to MongoDB and updates the skill's confidence score — the feedback loop that enables automatic skill refinement.

| Parameter | Type | Required |
|---|---|---|
| skill_name | string | Yes (e.g., `"deploy-remote-service"`) |
| outcome | enum: `success`, `partial`, `failure` | Yes |
| notes | string | No |
| task_description | string | No |

### list_skill_feedback

List detailed feedback records from MongoDB for a specific skill — session, outcome, confidence delta, notes, timestamp. Supports pagination.

| Parameter | Type | Required | Default |
|---|---|---|---|
| skill_name | string | Yes | — |
| limit | number (1–100) | No | 20 |
| offset | number (≥0) | No | 0 |

### refine_skill

Refine a challenged or degraded skill using LLM analysis of its feedback history. Generates an improved `SKILL.md`; the old version is backed up as `SKILL.md.bak`.

| Parameter | Type | Required |
|---|---|---|
| skill_name | string | Yes |

---

## Code Graph (Satori Graph)

The native code-graph toolchain replaces the legacy Graphify toolchain. Documented in `scripts/README-code-graph.md`. Roots are resolved on the server container filesystem (use the container mount paths, e.g. `/repos/<name>`).

### scan_codebase

Scan a local codebase directory (file discovery honoring `.gitignore`/`.katraignore`) and report what changed vs the last scan (added/modified/deleted/unchanged). Does **not** write to the knowledge graph — use before `sync_code_graph` to preview changes.

| Parameter | Type | Required | Default |
|---|---|---|---|
| root | string | Yes | — |
| followSymlinks | boolean | No | — |

### sync_code_graph

Scan a codebase, extract structure (classes, functions, methods, imports, calls) with tree-sitter, and merge it into the Katra knowledge graph. Deleted files are retracted. Returns counts of nodes/edges upserted and retracted.

| Parameter | Type | Required |
|---|---|---|
| root | string | Yes |

### code_graph_status

Report the current state of a codebase in the Katra knowledge graph: node/edge counts and last sync time for the given root.

| Parameter | Type | Required |
|---|---|---|
| root | string | Yes |

---

## System

### get_memory_diagnostics

Get storage stats, index health, embedding coverage, and overall health.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (pass your own identity) |

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
| limit | number (1–100) | No | 50 |

### list_assets

List uploaded assets stored in MinIO/S3.

| Parameter | Type | Required | Default |
|---|---|---|---|
| user_id | string | No | — |
| content_type | string | No | — |
| limit | number (1–100) | No | 20 |

---

## Cognitive Architecture

### get_memory_decay_stats

Returns per-type memory decay statistics: total, active, decaying, forgotten counts, average strength, and half-life remaining for each memory type.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (caller-bound for untrusted callers) |

### get_anomaly_report

Returns anomaly detection report: total ingested count, breakdown by normal/suspect/anomalous/quarantined, average z-score, and list of recent anomalies.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (caller-bound for untrusted callers) |

### get_quarantined_memories

Lists quarantined memories with metadata: z-score, type, corroboration count, and quarantine date.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (caller-bound for untrusted callers) |

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

| Parameter | Type | Required |
|---|---|---|
| source_id | string | Yes |

### get_error_report

Returns ACC error monitor: prediction accuracy, average TD error, surprise rate, conflict count, and recent errors tracked.

Takes no arguments.

### get_action_policy

Returns learned Q-values and softmax selection probabilities for each available action in the given state.

| Parameter | Type | Required |
|---|---|---|
| state_key | string | Yes |
