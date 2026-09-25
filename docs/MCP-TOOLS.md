# MCP Tools Reference

Katra (the self-hosted cognitive memory appliance) exposes **81 tools** via the Model Context Protocol (MCP) on a default deployment — every feature flag off, i.e. exactly what `tools/list` returns out of the box (see [Registered surface](#registered-surface-and-what-the-flags-add)). All tools are accessible through the MCP endpoint at `http://<host>:3112/mcp` (host port 3112 → container port 3100). The transport is **POST-only streamable HTTP** — `GET /mcp` returns 405 (standalone SSE streams are not supported). A plain `GET /health` on the same port (3112) reports service health without authentication.

## Registered surface (and what the flags add)

`tools/list` reports **81 tools** on a default deployment: `COGNITIVE_CONTROL_ENABLED` off,
`COGNITIVE_SCHEDULER_MODE` off, `PER_IDENTITY_PERSONALITY` off, `FOCUSED_IMAGINATION` off. That
number is *measured, not hand-maintained* — `server/tests/unit/mcp-tool-surface-docs.test.ts` counts
the registered tools in `server/src/mcp-server.ts` and fails if this page or the README states
anything else.

Those 81 are **66 catalogued tools** (every `###` entry below except the flag-gated
`get_my_personality`, `run_focused_consolidation`, `get_salience_trace`,
`generate_imagination_seeds` and `get_idea_archive`) plus **15 tools in two
families that have their own reference** instead of a catalogue entry:

| Family | Tools | Names |
| --- | --- | --- |
| **Katra Vault** (`vault_*`) — encrypted-at-rest secrets, approvals, and the approval-gated capability calls | 11 | `vault_put_secret`, `vault_list_secrets`, `vault_get_secret`, `vault_delete_secret`, `vault_rotate_secret`, `vault_audit`, `vault_approve_service`, `vault_revoke_approval`, `vault_list_approvals`, `vault_http`, `vault_instagram_login` |
| **Vault agent auth** (`auth_*`) — TOTP enrolment and short-lived agent sessions | 4 | `auth_enroll_totp`, `auth_issue_session`, `auth_revoke_session`, `auth_session_status` |

A secret value never crosses this interface: `vault_http` / `vault_instagram_login` open it
server-side and refuse to run without an active per-service approval, writes and approvals are
operator-only (untrusted callers are rejected before any store work), and the list/get calls return
metadata only. Design and usage: `docs/katra-vault-design.md`, `docs/katra-vault-usage.md`.

Feature flags grow the same surface. Totals are `tools/list` counts:

| Flags | `tools/list` | Added over the default |
| --- | --- | --- |
| all off (**default**) | **81** | — |
| `PER_IDENTITY_PERSONALITY=1` | **82** | +1 — `get_my_personality` (catalogued below) |
| `FOCUSED_IMAGINATION=1` | **85** | +4 — `run_focused_consolidation`, `get_salience_trace`, `generate_imagination_seeds`, `get_idea_archive` (catalogued below) |
| `COGNITIVE_CONTROL_ENABLED=read` or `write` | **106** | +25 — mission state, state deltas, epistemic ledger, batons, allocator evidence/counterfactuals, skill-candidate lifecycle (`server/src/services/mission-cognition/`) |
| `COGNITIVE_SCHEDULER_MODE=shadow` or `recommend` or `allocate_internal` (with the row above) | **119** | +13 more — scheduler queue/decision, uncertainty, trigger and experiment tools |
| `PER_IDENTITY_PERSONALITY=1` with a cognitive-control row | **82 / 107 / 120** | both — the flags are independent |

`FOCUSED_IMAGINATION` is independent of every row above: it adds its **4** wherever it is set —
**85** alone, **86** with `PER_IDENTITY_PERSONALITY=1`, **110** with the cognitive-control row,
**123** with a scheduler mode, and **124** with all of them on. (ITER-5 contributed the salience
trace pair, ITER-6 the imagination pair; the default surface is unchanged because every one of the
four is flag-gated.)

`COGNITIVE_ACTIVATION_KILL_SWITCH=1` forces the scheduler mode back to `off` (those last 13 tools
disappear again); the cognitive-control plane is off in production by default.

## Authentication & Identity Separation

Katra resolves **who is calling** from the API key presented on the request — never from anything the client self-reports. One Katra hosts any number of named identities (one per machine or agent) plus optional tool actors that write team memory only.

**Key presentation** — any one of:
- `X-MCP-Auth: <key>` header
- `Authorization: Bearer <key>` header (REST-style)
- `?token=<key>` URL query parameter

**Key resolution:**
- Keys live in `system_settings.client_keys` as **sha256 hashes only** — plaintext is never stored. Comparison is timing-safe.
- Client keys are provisioned idempotently at boot by `ensureClientKeys()`. Keys for additional identities are generated once and their plaintext printed exactly once in the "Client keys (identity separation)" block of the server log.
- Loopback callers (127.0.0.1/::1) authenticate as the trusted machine identity without a key — host-side tools (bridge hooks, CLI scripts) rely on this.
- The admin key (`KATRA_API_KEY`) authenticates as the **trusted** machine identity.
- A key mapped in `client_keys` authenticates as that identity, **untrusted** (see *Trusted vs untrusted callers* below).
- A key that validates but has **no identity mapping** is rejected with **401** — loud failure with a logged sha256 prefix of the presented key, never a silent fallback to a default identity.
- **Legacy env keys are retired**: the pre-cutover shared keys (`MCP_API_KEY`, `BACKUP_MCP_KEYS`) are no longer validated as MCP credentials in their own right. The only legacy material consulted at boot is the seeding of the machine identity's own `client_keys` record from the legacy key hash; unmapped keys — including the retired backup keys — fail with 401.
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

- **Caller-bound scoping**: every tool invocation runs inside the resolved caller identity (`runWithCaller`). Memory writes (`store_memory`, `store_journal`) and every scoped read tool pin untrusted callers to their own identity (`resolveWriteScope` / `resolveUserId`) — supplied `user_id` values are ignored. Since 2026-08-21 this covers `vector_search`, `temporal_recall`, `temporal_search`, `get_journal`, `get_auto_journal`, missions, time-block and pattern tools, `get_memory_diagnostics`, `get_transaction_log`, `list_assets`, and `trigger_reflection`; `get_my_identity` and `get_my_personality` are pinned to the caller's own identity record either way.
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
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"store_memory","arguments":{"content":"Hello Katra"}}}'
```

`YOUR_IDENTITY_KEY` is the caller's own identity key (its hash in `client_keys`), or `KATRA_API_KEY` for trusted-machine-identity access. A server restart invalidates session IDs; the server falls back to a stateless transport for non-initialize requests it cannot map to a session.

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
{"name":"store_memory","arguments":{"content":"User asked about Katra memory fixes","category":"event","session_id":"thread-123","source":"kolega-code","tags":["conversation"]}}
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

Full-text + vector search across **11 memory collections** (episodic, semantic, manual/auto journals, knowledge graph nodes/relationships, memory nodes/edges, missions, assets, working memory). Supports OR-queries (e.g. `"Attention: Alex" OR "Attention: Dana"`).

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

### get_my_personality

Returns the **caller's own** resolved memory personality: profile, effective source weights (profile defaults merged with the saved overrides; `agent_message` pinned at 10.0), scoring, `max_context_tokens`, `version`, `origin` (`identity` | `legacy` | `default`), `updated_at`, and `active_mode` (reported `null` — thinking modes arrive in Phase 6). Pinned to the resolved caller identity: an untrusted caller always reads its own configuration, even with a `user_id` argument.

Registered only when `PER_IDENTITY_PERSONALITY` is on (**default off**) — with the flag off, calling it returns `Unknown tool`. With the flag off overall the saved personality is the single legacy global record, so every identity resolves the same configuration with `origin: "legacy"`.

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

Returns the caller's Theory of Mind beliefs about a named entity: proposition, confidence, source, and last updated timestamp. Identity-scoped: an untrusted caller reads its own beliefs about the entity even when it passes another identity's `user_id`.

| Parameter | Type | Required |
|---|---|---|
| entity_name | string | Yes |
| user_id | string | No (caller-bound for untrusted callers) |

### get_procedural_templates

Returns the caller's procedural memory templates — tool-call patterns observed 5+ times (tool name, input shape, frequency, average success rate) that survive a server restart. Identity-scoped: an untrusted caller reads its own patterns.

| Parameter | Type | Required |
|---|---|---|
| user_id | string | No (caller-bound for untrusted callers) |

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

## Code Graph (Katra Graph)

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

---

## Focused Consolidation — private Salience Trace (`FOCUSED_IMAGINATION`, default off)

A mission-scoped analogue of sleep consolidation. Given a mission's **real operational state** it
privately produces an **evidence-linked, calibrated Salience Trace** — what feels important about
this mission right now and why — with its own run ledger (`salience_traces` +
`focused_consolidation_runs`, both **personal kinds**: written without a `shared_id`, never exposed
through a shared/team read path).

Privacy is the point: the gather reads the identity's reflection state as **counts only** (journal
and reflection rows are counted, never copied) and the stored trace is built field by field from
the model output, so no journal or reflection text can reach the model or the store. The trace's
own attestation says so (`privacy.raw_reflections_included: false`, `privacy.shared: false`).

One bounded model call per run (retried at most once, token ceiling and hard timeout), one run per
`{mission_id, cycle_id}` — a repeat **replays** the recorded run instead of calling the model again,
and a failure is recorded as a failed run with **no trace**. Every `evidence_refs` entry must
resolve against the mission's own collections (`mission_states`, `state_deltas`,
`epistemic_entries`, `cognitive_work_items`, `cognitive_batons`); refs that do not resolve are kept,
flagged (`unresolved_evidence`), counted on the trace and on the run, and more than half the signals
carrying unresolved evidence records a **warning** rather than passing silently. Calibration values
the model did not supply as plain in-range numbers are adjusted and counted — `clamped_values`
counts every adjustment (an out-of-range number pulled into range, a value defaulted to 0, or a
numeric **string** coerced with `Number()`), with `coerced_values` isolating the coercions — and
signals below the 0.2 confidence floor are kept but marked `low_confidence`. Model text longer than
its schema bound is **truncated to fit** it (the ellipsis is inside the limit) and counted as
`truncated_fields` on the run ledger rather than failing the run. The trace/ledger window is
compensated: if the run row cannot be completed after the trace is written, the trace is deleted
(bounded retry); if that delete also fails, the failed run row names the surviving trace in
`orphan_trace_id` and the mismatch is logged loudly.

Both tools are registered only when `FOCUSED_IMAGINATION` is on (**default off**) — with the flag
off they return `Unknown tool`, write nothing and call no model.

### run_focused_consolidation

Run one focused consolidation cycle for a mission. Gathers the mission state at its current version,
the active Context Baton (if any), the epistemic ledger (hypotheses/uncertainties/decisions), open
uncertainties via the existing deterministic detectors, the work-item queue, accepted state deltas
since the last checkpoint, and the identity's reflection state **as counts only**; then makes ONE
bounded model call under the mission's usage origin and stores the resulting trace plus its run row.
Idempotent per `{mission_id, cycle_id}`: a repeat returns the existing trace with no model call and
no duplicate documents, and a concurrent duplicate runs exactly once. **Write.** An untrusted caller
may only run a mission it owns (the trace is always attributed to that caller); trusted callers may
name another identity with `user_id`.

| Parameter | Type | Required | Default |
|---|---|---|---|
| mission_id | string | Yes | — |
| cycle_id | string | No | `cycle_v<mission_version>` — repeats without one replay instead of double-running |
| trigger | string | No | `manual` (sanitised; Phase 5 adds the plateau trigger) |
| user_id | string | No | caller's identity (trusted callers only may override) |

### get_salience_trace

Read the caller's **own** salience traces, newest first — by `trace_id` or for a `mission_id` — each
with its full signal set (kind, statement, `why_operationally_relevant`, calibration, evidence refs
and the unresolved/low-confidence flags), the calibration and evidence summaries, the privacy
attestation, and the run-ledger line of the run that produced it (status, model, calls, tokens,
duration, signal/unresolved/clamped counts). **Caller-pinned:** an untrusted caller only ever reads
traces written under its own identity — never another identity's, even when it names that identity's
`user_id`. A `mission_id` an untrusted caller cannot see is refused before any read.

| Parameter | Type | Required | Default |
|---|---|---|---|
| trace_id | string | No | — (with neither id nor mission_id: the caller's newest traces) |
| mission_id | string | No | — |
| limit | number (1–50) | No | 10 |
| user_id | string | No | caller's identity (trusted callers only may override) |

---

## Imagination Engine — idea seeds + quality-diversity archive (`FOCUSED_IMAGINATION`, default off)

Phase 4 turns a Salience Trace into a **diverse, reproducible portfolio of testable hypothesis
seeds** and admits it into a quality-diversity archive that rejects duplicates and paraphrases,
preserves exclusions, and lets a ruled-out idea back only with an explicitly stated changed premise.

The brief's **ten operator families** — `assumption_inversion`, `representation_shift`,
`distant_analogy`, `constraint_mutation`, `boundary_extreme`, `causal_reversal`,
`contradiction_preservation`, `tool_invention`, `random_semantic_bridge`, `counterfactual_world` —
are selected **from the trace itself**: tensions and persistent pulls drive constraint mutation and
contradiction preservation, absences invert assumptions, surprises reverse causes, attractions shift
representations, and questions bridge distant associations. Intensity decides the score order and a
**seeded** tie-break decides the rest, so the run's `operator_plan` records which operators ran, on
which signal ids, and why. Operators that cannot run (no bridge path in the caller's knowledge graph)
are recorded as *skipped* rather than run as a fabrication.

**Determinism is not decoration.** Every random choice comes from a seeded PRNG (mulberry32 over a
hash of the run's seed) and every id is **derived** — `sha256` over the seed's content plus the seed
and the mission — never a random UUID. Two runs with the same seed over the same inputs produce a
byte-identical portfolio (the run records a `portfolio_digest` over the payload with timing and
bookkeeping fields stripped), and a different seed produces a different, still schema-valid one.
Evidence is validated the same way: a seed may only cite the trace signal ids and the mission's
ledger/delta/work-item/baton ids, an unresolvable ref is **dropped and counted**, and a seed left
with no evidence is dropped with a counted reason. Novelty is measured against the **archive**
(`min(model claim, 1 − max similarity)`), not taken on faith — through the archive's own
containment-aware similarity, so padding a restatement with extra characters cannot turn it into a
novel claim.

The archive's cells are the tuple of five descriptor bins (`mechanism`, `representation`,
`violated_assumption`, `evidence_family`, `test_strategy`); the incumbent of a cell is its
highest-quality seed (`quality = f(novelty, coherence, testability, information_gain)`, documented
fixed weights). Dedupe is deterministic and documented, and exact duplicates → `duplicate_of` while
near-duplicates → `paraphrase_of` are decided by **content-token containment**
(`|A ∩ B| / min(|A|, |B|)` over stopword-filtered tokens, `CONTAINMENT_THRESHOLD = 0.7`) as well as
by **Jaccard over the normalised token sets** (`PARAPHRASE_THRESHOLD = 0.72`, with the length guard
applied only where containment is genuinely low) — so a stored statement padded with hundreds of
extra characters is still a restatement, not a new idea. Matches against the mission's exclusion
list (rejected hypotheses and the trace's low-confidence regions) are `excluded_region`; rejections
are **stored with their reason**, so an exclusion is durable and re-enterable. A changed-premise
re-entry is admitted only with a **valid** premise — a complete sentence that is **not** a no-change
assertion (`nothing has changed`, `no change`, `unchanged`, `as before`, …) and that introduces at
least two content tokens the excluded text does not already contain — **and** a lineage link to the
prior rejection, and the cell's history records it.

**Privacy.** `idea_seeds` and `idea_lineages` are **personal kinds** and `imagination_runs` is the
run ledger; `idea_archive_cells` is *identity-owned but mission-indexed* (it is written with the
scope policy's explicit private opt-out), so **no document in any of the four can carry a
`shared_id`**. The shareable surface is the sanitized coverage view: bins, counts, quality and ids —
never a statement, a mechanism, an evidence text or reflection material. Nothing is promoted: there
is no promotion path in this iteration.

**Budgets** (env-overridable, safe defaults; a caller may ask for less and never for more):
`FOCUSED_IMAGINATION_MAX_SEEDS` (8), `FOCUSED_IMAGINATION_MAX_OPERATORS` (6),
`FOCUSED_IMAGINATION_MAX_LLM_CALLS` (3 — two operators share one call),
`FOCUSED_IMAGINATION_MAX_TOKENS` (3000) and `FOCUSED_IMAGINATION_TIMEOUT_MS` (60000). One bounded
model call per operator batch, all through `llmService.extractJson` under the mission's usage
origin, retried at most once and never beyond the call budget; the run records the effective budget
and the **planned vs actual** operator and call counts.

Both tools are registered only when `FOCUSED_IMAGINATION` is on (**default off**) — with the flag
off they return `Unknown tool`, write nothing and call no model.

### generate_imagination_seeds

Run one imagination cycle for a mission: read its newest private Salience Trace, plan the operator
families from the trace's own signals, walk the caller's knowledge graph for **distant associations
with their path**, make one bounded model call per operator batch, then admit the resulting seeds
into the mission's idea archive. Returns the portfolio summary — seed ids, descriptor bins, scores,
the operator plan, the per-reason drop counts and the **rejections with their reasons** — and does
**not** promote anything. Idempotent per `{mission_id, cycle_id, seed}`: a repeat replays the
recorded run with no model call and no new documents. **Write.** An untrusted caller may only run a
mission it owns; trusted callers may name another identity with `user_id`.

| Parameter | Type | Required | Default |
|---|---|---|---|
| mission_id | string | Yes | — |
| cycle_id | string | No | `imagination_v<mission_version>` — a repeat replays instead of double-running |
| seed | string \| number | No | derived from the trace's `problem_state_digest` (so the default is reproducible too) |
| trigger | string | No | `manual` (sanitised) |
| mode | `explore` \| `exploit` \| `balanced` | No | `balanced` (`explore` spreads the plan across families) |
| disposition | string | No | — (recorded on the run as a hint; never a source of evidence) |
| max_seeds | number ≥1 | No | the environment cap (`FOCUSED_IMAGINATION_MAX_SEEDS`, 8) — a larger request is clamped |
| max_operators | number ≥1 | No | the environment cap (`FOCUSED_IMAGINATION_MAX_OPERATORS`, 6) |
| max_llm_calls | number ≥1 | No | the environment cap (`FOCUSED_IMAGINATION_MAX_LLM_CALLS`, 3) |
| user_id | string | No | caller's identity (trusted callers only may override) |

### get_idea_archive

Read the caller's **own** idea archive for a mission: the sanitized **coverage view** (`cells_total`,
`cells_by_dimension`, `new_cells_this_cycle`, `occupancy` and `gaps`) plus the sanitized incumbent
summaries — cell key, descriptor bins, quality, seed count and the incumbent's **seed id** only. It
never returns a seed statement, a mechanism, an evidence ref or any reflection material, and it
never crosses identities: an untrusted caller only ever sees its own archive, and a mission it
cannot see is refused before any read. **Read.**

| Parameter | Type | Required | Default |
|---|---|---|---|
| mission_id | string | Yes | — |
| limit | number (1–200) | No | 50 |
| user_id | string | No | caller's identity (trusted callers only may override) |
