# MCP Tools Reference

Katra (the self-hosted cognitive memory appliance) exposes **81 tools** via the Model Context Protocol (MCP) on a default deployment — every feature flag off, i.e. exactly what `tools/list` returns out of the box (see [Registered surface](#registered-surface-and-what-the-flags-add)). All tools are accessible through the MCP endpoint at `http://<host>:3112/mcp` (host port 3112 → container port 3100). The transport is **POST-only streamable HTTP** — `GET /mcp` returns 405 (standalone SSE streams are not supported). A plain `GET /health` on the same port (3112) reports service health without authentication.

## Registered surface (and what the flags add)

`tools/list` reports **81 tools** on a default deployment: `COGNITIVE_CONTROL_ENABLED` off,
`COGNITIVE_SCHEDULER_MODE` off, `PER_IDENTITY_PERSONALITY` off, `FOCUSED_IMAGINATION` off,
`CREATIVE_BATON_PROMOTION` off, `COGNITIVE_TEAM_ALLOCATION` off. That
number is *measured, not hand-maintained* — `server/tests/unit/mcp-tool-surface-docs.test.ts` counts
the registered tools in `server/src/mcp-server.ts` and fails if this page or the README states
anything else.

Those 81 are **66 catalogued tools** (every `###` entry below except the flag-gated
`get_my_personality`, `run_focused_consolidation`, `get_salience_trace`,
`generate_imagination_seeds`, `get_idea_archive`, `run_imagination_cycle`, `get_creative_baton`,
`promote_creative_baton`, `baton_candidates_to_work_items`, `record_candidate_outcome`,
`assign_thinking_mode`, `get_active_mode`, `create_inheritance_envelope`,
`allocate_cognitive_portfolio`, `plan_independent_first_pass` and `synthesize_portfolios`) plus
**15 tools in two families that have their own reference** instead of a catalogue entry:

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
| `FOCUSED_IMAGINATION=1` | **89** | +8 — `run_focused_consolidation`, `get_salience_trace`, `generate_imagination_seeds`, `get_idea_archive`, `run_imagination_cycle`, `get_creative_baton`, `baton_candidates_to_work_items`, `record_candidate_outcome` (catalogued below) |
| `FOCUSED_IMAGINATION=1` + `CREATIVE_BATON_PROMOTION=1` | **90** | +1 — `promote_creative_baton` (the promotion flag on its own adds nothing: it is meaningless without the family flag) |
| `COGNITIVE_TEAM_ALLOCATION=1` | **87** | +6 — `assign_thinking_mode`, `get_active_mode`, `create_inheritance_envelope`, `allocate_cognitive_portfolio`, `plan_independent_first_pass`, `synthesize_portfolios` (catalogued below; the family is gated on its own flag, so a deployment may run the single-agent imagination surface without ever assembling a team) |
| `COGNITIVE_CONTROL_ENABLED=read` or `write` | **106** | +25 — mission state, state deltas, epistemic ledger, batons, allocator evidence/counterfactuals, skill-candidate lifecycle (`server/src/services/mission-cognition/`) |
| `COGNITIVE_SCHEDULER_MODE=shadow` or `recommend` or `allocate_internal` (with the row above) | **119** | +13 more — scheduler queue/decision, uncertainty, trigger and experiment tools |
| `PER_IDENTITY_PERSONALITY=1` with a cognitive-control row | **82 / 107 / 120** | both — the flags are independent |

`FOCUSED_IMAGINATION` is independent of every row above: it adds its **8** (and its **9th** with
`CREATIVE_BATON_PROMOTION`) wherever it is set — **89 / 90** for the family on the promotion flag
off and on, **90** with `PER_IDENTITY_PERSONALITY=1`, **91** with both, **115** with the
cognitive-control row, **128** with a scheduler mode, and **129** with all of them on. (ITER-5
contributed the salience trace pair, ITER-6 the imagination pair, ITER-7 the
cycle/baton/adapter/outcome quartet and — behind the second flag — the promotion; the default
surface is unchanged because every one of them is flag-gated.)

`COGNITIVE_TEAM_ALLOCATION` is independent of every other row as well: it adds its **6**
wherever it is set — **87** on its own, **88** with `PER_IDENTITY_PERSONALITY=1`, **95** with
`FOCUSED_IMAGINATION=1`, **96** with the promotion flag too, **112** with the cognitive-control row,
**125** with a scheduler mode and **135** with everything on. (ITER-8 contributed the team layer:
expiring thinking modes, the bounded inheritance envelope, the portfolio allocator, the independent
first pass and synthesis.)

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

---

## Creative Baton — plateau cycles, promotion, adapter, outcomes (`FOCUSED_IMAGINATION` + `CREATIVE_BATON_PROMOTION`, both default off)

Phase 5 of the imagination engine. A **stalled** mission runs **exactly one** imagination cycle,
receives a **sanitised, versioned Creative Baton**, has its candidates turned into work the
controller can pick up, and records what happened — with the cooldown, the budget and the claim
state **persisted per mission**, so a restart cannot re-trigger early.

**The gates, in order** (`runImaginationCycle`): single-flight (a concurrent caller joins the run
instead of starting a second one) → the **persisted** cooldown (`imagination_cycle_states`, one row
per `{user_id, mission_id}`) → the per-mission **window budget** (cycles *and* measured tokens, from
the usage ledger) → the **plateau evaluation**. `force: true` bypasses the plateau gate only —
never the cooldown or the budget. A skipped cycle writes **nothing at all**: no cycle row, no state
change, no baton, no model call.

**The plateau** is five conditions from the brief's §4.1, each reported with the evidence that
decided it: below-minimum active candidates (`IMAGINATION_PLATEAU_MIN_CANDIDATES`, 3), novelty gain
below ε over N rounds (`IMAGINATION_PLATEAU_NOVELTY_EPSILON`, 0.05, `..._NOVELTY_ROUNDS`, 2), a
repeated failure signature, archive coverage below a floor (`IMAGINATION_PLATEAU_COVERAGE_FLOOR`,
6 cells), and contradiction pressure above a threshold
(`IMAGINATION_PLATEAU_CONTRADICTION_THRESHOLD`, 2 live contradictions).

**The cycle** records one row in `imagination_cycles`, unique per **`{user_id, mission_id,
cycle_id}`** with a **derived** `cycle_id` (`imagination_cycle_<scope16hex>_v<version>_c<ordinal>`,
where the scope digest covers the identity AND the mission): two concurrent callers of ONE mission
compute the same id and exactly one runs, while two DIFFERENT missions that share (version, ordinal)
derive different ids and each run their own cycle — the claim lookup is scoped to the same key, so no
mission can read, replay or inherit another's trace, baton or counts. The row carries the counts, the
effective budget and what was spent, the novelty mean, the coverage view **with its scan bounds and a
`truncated` flag**, and the **stop condition that fired** — `budget_exhausted`,
`coverage_target_reached`, `no_candidate_above_floor`, `no_new_cells_two_rounds`,
`promoted_inventory_restored`, `privacy_validation_failed`, `mission_cancelled_or_superseded`, or
`completed`. Every condition is reported with whether it was met; the first met one in precedence
order is the reason. The **returned `status` agrees with the stored row**: `ran` only for a cycle that
completed, `failed` (with `reason`, `stop_reason` and `error`) for one whose row is `failed` — an
upstream failure, a privacy-validation failure, a cancelled/superseded mission — so a caller reading
only `status` is never told a failed cycle ran.

**The baton** is a compiled allow-list (brief §4.3): `creative_baton_version`, `mission_id`,
`cycle_id`, `trigger {type, evidence}`, `problem_state_digest`, `excluded_regions` (kind + ordinal +
a **hash** of the ruled-out text — never the text), `attention_targets` (derived from each signal's
kind and calibration, never its statement or its own `why_operationally_relevant`),
`candidate_portfolio` (seed id, hypothesis, mechanism, descriptor bins, scores, cheapest test,
lineage ref, `privacy_safe: true`), `coverage_gaps`, `coverage_summary` (with the scan bounds),
`next_round_budget`, `privacy {raw_reflections_included: false, shared}` and `payload_hash`.
`coverage_gaps[].unoccupied_bins` is **re-validated against the archive's closed `DESCRIPTOR_BINS`
vocabulary** (and each gap's dimension against `DESCRIPTOR_DIMENSIONS`), with anything unknown dropped
and counted, so a marker cannot be injected through the coverage view. Nothing else is copied: no
evidence ref, no changed premise, no bridge path, no parent link, no cell key. It is validated against
`creative-baton.schema.json` (registered in the mission-cognition registry) and secret-scanned
**before** it is written — and that schema is **closed** (`additionalProperties: false` at the top
level and on every object), so an extra key anywhere in the packet fails validation at compile,
promote and read time even for a writer who recomputed the payload hash.

**Promotion** is the one operation that writes a team scope, and it happens through a separate,
gated call: both flags on **and** a trusted caller, plus a **re-validation of the stored document**
(schema, secret scan, `creative_baton_version`, and the payload hash the compiler wrote — a tampered
baton is refused with a named reason rather than shared). **The re-validation runs on EVERY call,
before the idempotency answer**: an existing `shared_id` records that the payload validated once,
which is not the same as validating now, so a baton tampered with *after* its promotion is refused
rather than reported as an unchanged no-op. It records the promoting identity, the timestamp, the
schema version and the payload hash in `creative_baton_promotions`, stamps `shared_id` on the baton,
and is idempotent: promoting the same payload twice reports the existing promotion and writes
nothing. Reads are verified too — `getCreativeBaton`/`readCreativeBaton` and the controller adapter
run the same `verifyStoredBaton` check and refuse a tampered row **by name**
(`payload_hash_mismatch`, `schema_invalid`, `secret_material`, `version_unsupported`). `imagination_cycle_states`, `imagination_cycles` and
`idea_candidate_outcomes` are **personal kinds** (no `shared_id`, ever); `creative_batons` is the
one artifact that may carry a shared scope, and only after a promotion.

### run_imagination_cycle

Run ONE imagination cycle for a mission, or evaluate the plateau without writing. With
`mode: "evaluate_only"` (alias `dry_run: true`) it returns the five plateau conditions with their
evidence, the persisted cycle state, the window budget and the cooldown remaining — with **zero
writes and no model call**. Otherwise it runs the gates in order and, when they allow it, runs
focused consolidation, generates and admits seeds, reads the bounded coverage view, compiles the
Creative Baton and (only with `CREATIVE_BATON_PROMOTION=1` and a trusted caller) promotes it.
Idempotent per `cycle_id`: a repeat replays the recorded cycle. The returned `status` is `ran`,
`failed` (with `reason`/`error`), `skipped` or `replayed`. **Write** (evaluate-only: read). An
untrusted caller may only run a mission it owns; trusted callers may name another identity with
`user_id`.

| Parameter | Type | Required | Default |
|---|---|---|---|
| mission_id | string | Yes | — |
| cycle_id | string | No | derived from the scope of the mission (identity + mission id), the mission version and the mission's next cycle ordinal — a repeat replays the recorded cycle, and no two missions share one |
| trigger | string | No | `plateau` (sanitised, ≤40 characters) |
| force | boolean | No | `false` — bypasses the PLATEAU gate only (never the cooldown or the budget) |
| mode | `run` \| `evaluate_only` | No | `run` |
| dry_run | boolean | No | `false` — alias for `mode: "evaluate_only"` |
| user_id | string | No | caller's identity (trusted callers only may override) |

### get_creative_baton

Read a Creative Baton, caller/scope-aware: pass a `baton_id`, or a `mission_id` for its newest
**visible** baton. An untrusted caller sees its own batons plus batons **promoted** to the team
scope; another identity's unpromoted baton is reported exactly like a missing one. Every stored baton
is **integrity-checked before it is served** (format version, the closed schema, the secret scan and
the payload hash recomputed over the stored document), so a row tampered with after it was written —
including one tampered with after it was **promoted** — is refused by name (`payload_hash_mismatch`,
`schema_invalid`, `secret_material`, `version_unsupported`) instead of being rendered as a baton; when
a `mission_id` is given, the recorded candidate outcomes for that mission are listed alongside.
**Read.**

| Parameter | Type | Required | Default |
|---|---|---|---|
| baton_id | string | No (one of `baton_id` / `mission_id` is required) | — |
| mission_id | string | No | — |
| limit | number (1–20) | No | 5 (batons listed for a mission) |
| user_id | string | No | caller's identity (trusted callers only may override) |

### promote_creative_baton

Promote a baton to the team scope — the only operation in this feature that writes shared state.
Requires `FOCUSED_IMAGINATION=1` **and** `CREATIVE_BATON_PROMOTION=1` (with either off the tool is
`Unknown tool` — the promotion flag on its own adds no tool at all) and a **trusted** caller. The
stored baton is re-validated (schema + secret scan), its `creative_baton_version` is checked, and
its payload hash is recomputed and compared with the one the compiler wrote — a tampered stored
baton is refused with a named reason (`payload_hash_mismatch`, `schema_invalid`, `secret_material`,
`version_unsupported`, `not_owner`, `untrusted_caller`, `flag_off`). The promotion writes the audit
row (identity, timestamp, schema version, payload hash) and stamps `shared_id`; promoting twice is a
no-op that reports the existing promotion. **Write** (team scope).

| Parameter | Type | Required | Default |
|---|---|---|---|
| baton_id | string | Yes | — |
| user_id | string | No | caller's identity (the baton must belong to it) |

### baton_candidates_to_work_items

Turn a baton's eligible candidates into **controller work items** through the existing scheduler
funnel (`SchedulerService.upsertWorkItems` → `generateWorkItems`): no new write path, the same
priority feature vector and the same `{mission_id, trigger, description}` dedupe — so re-running
inserts nothing and reports the same items as reused. Each item carries `[creative_baton <id> seed
<id>]` in its description and a `provenance` field (`{source, baton_id, seed_id, cycle_id,
requested_by}`) on the row. The trigger reuses the existing `manual` value (the item exists because
a caller explicitly asked for it) and the mode is `explore`. An untrusted caller may only adapt a
**promoted** baton (the work queue is shared state); a trusted caller may adapt its own. The stored
baton is **integrity-checked before a single candidate is copied**, so a tampered row reaches neither
the queue nor the caller (refused by name). The result counts what the call actually added:
`created`/`reused` describe the **baton-derived** items and `work_items_added_total` (with
`funnel_derived_added`) describes **every** row the funnel added, including the items it derives from
mission state itself — the baton-derived number alone understates the call. **Write.**

| Parameter | Type | Required | Default |
|---|---|---|---|
| baton_id | string | Yes | — |
| user_id | string | No | caller's identity (trusted callers only may override) |

### record_candidate_outcome

Record what a candidate turned out to be: `useful_information`, `mere_variance` or
`unnecessary_cost`. Three consumers: the archive's identity-bound `recordOutcome` (the seed is
looked up by seed id **and** identity, so no caller can write into another identity's lineage and a
cross-identity call is reported exactly like an unknown id), the existing trigger telemetry
(measured token cost from the usage ledger, grouped under the `imagination_candidate` trigger; the
telemetry note carries ids only, never the caller's `detail`), and a **capped** novelty-drive
replenishment: `+0.05` per useful outcome, at most `0.2` per identity and mission per rolling 24
hours, computed from the **stored** outcome rows so a restart cannot refill the same budget.
Idempotent per `{seed, outcome}`: a repeat is recorded once and reported as a repeat (a *different*
outcome for the same seed is a new record). **Write.**

| Parameter | Type | Required | Default |
|---|---|---|---|
| seed_id | string | Yes | — |
| outcome | `useful_information` \| `mere_variance` \| `unnecessary_cost` | Yes | — |
| baton_id | string | No | — (recorded on the outcome row when given) |
| detail | string (≤2000) | No | — (stays on the PRIVATE outcome row; never in telemetry) |
| user_id | string | No | caller's identity (trusted callers only may override) |

## Cognitive team — modes, inheritance, allocation, first pass, synthesis (`COGNITIVE_TEAM_ALLOCATION`, default off)

Phase 6 turns one identity into a **team** of cognitive roles without letting any of them read a
peer's ideas or a parent's private memory. Everything is mission-scoped, ephemeral and private: the
three collections this family owns (`thinking_mode_assignments`, `inheritance_envelopes`,
`cognitive_portfolios`) are **personal kinds**, so no row of theirs can ever carry a `shared_id` —
and nothing in this iteration writes a shared scope at all.

**Modes expire.** A thinking mode is an assignment with a **required reason**, a start, an explicit
`expires_at`, the policy version, the inheritance policy, the parent's disposition snapshot
**version** and a reset behaviour. Expiry is **computed at READ** — there is no cron, no sweep and
no background timer — and the transition to `expired` is recorded **once** (a guarded update that
pins both the row's status and the exact `expires_at` the read computed from, so a renewal landing
between a read's snapshot and its write is never reverted by the stale read; a guard that loses
re-reads the row and reports the state that is actually stored). The only code that moves
`expires_at` is an explicit `renew` (which requires a reason and extends from `max(now, current
expiry)`); an assignment whose window has passed cannot be renewed at all, so a lapsed mode is
replaced by a new assignment rather than revived in place. Nothing silently extends a mode: reads
never touch the window, and the assignment's GRANT (mode, reason, actor, start, TTL, policy names,
snapshot version, reset behaviour) is hashed, so a tampered grant is refused by name. The bounds are
enforced in the **service**, not only in this surface's schema: a reason is capped at 500 characters
(refused rather than truncated), a TTL must be a **number** inside the documented window (the string
`'60000'` is refused, never coerced), and a mode is only granted or renewed on a mission that is
still runnable — `completed`, `cancelled`, a draft or any other state is refused by name
(`mission_not_runnable`) before anything is written.

**The catalogue is the brief's Appendix C, verbatim** — the eight modes with the attention bias and
the obligation the brief states, each declaring which **approved dimensions** it may bias (`k` — the
retrieval relevance multiplier within ±25% of the parent's own value; `vector_fetch_limit` — 1..20;
`cap_pct` — the per-source cap, which a child may tighten and never widen) and never a hard
invariant. The approved vocabulary does not CONTAIN an invariant, so "a mode may bias an approved
dimension and never a hard invariant" is a property of the vocabulary rather than a rule to remember.
A mode also carries the descriptor bins it tends to occupy (which is what the allocator's coverage
term reads), the engine spread it drives (`explore` / `balanced` / `exploit`) and the operator-family
budget of its generation round — the two knobs through which a mode reaches the ITER-6 engine
without reimplementing it.

**Inheritance is bounded.** An envelope is an IMMUTABLE REFERENCE: `parent_identity_id` plus a
disposition snapshot (profile, version and a hash over an allow-listed subset of the parent's
configuration), the immutable bounds (the agent-message priority **10.0**, the working-memory/vector
floors, the per-source cap bounds and the privacy policy), the approved dimensions this scope may
bias, the parent's baseline values and an expiry. It carries no journal, reflection, trace, seed or
belief — a taint suite plants markers in every one of those stores and proves none reaches an
envelope, its hash input or any tool output. A bounded mutation is **clamped** into its documented
range and recorded in the envelope's `mutations` history (requested → applied, the range, and where
it came from); a request that cannot be honoured is refused **by name**:

| Refusal | What it means |
| --- | --- |
| `immutable_invariant` | the message priority (and every alias of it), the floors, the cap bounds or the privacy policy |
| `dimension_not_approved` | a dimension outside the approved vocabulary, or one this envelope's MODE may not bias |
| `out_of_bounds` | not a finite number, or an attempt to WIDEN a per-source cap above the parent's own bound |

A mutation produces a **new derived envelope** (the parent's row is never rewritten, and the derived
scope expires with its parent — a mutation never moves a window). `verifyEnvelope` is the Creative
Baton's discipline: the version, a CLOSED registered schema (`inheritance-envelope.schema.json`), the
recomputed `policy_hash`, and the invariants re-checked on the decoded values — so a tamperer who
recomputed the hash is still refused for the cap it widened, the band it stretched or the weight it
lowered. The parent's own configuration is never touched: this family has no write path to
`system_settings` at all.

**Allocation builds a PORTFOLIO, not one winner.** The brief's §4.5 score, with every term and input
reported in `allocation_report`: `0.35 * emotional_proximity + 0.25 * task_skill_fit + 0.20 *
missing_approach_coverage + 0.10 * recent_success + 0.10 * availability - convergence_penalty -
load_penalty`. `missing_approach_coverage` is read from the archive's coverage gaps, so the portfolio
targets the descriptor bins NOTHING occupies; `recent_success` comes from the identity's recorded
candidate outcomes; `availability` from its live mode assignments; the convergence penalty punishes
sharing a mode with peers AND picking one more agent of a mode the portfolio already holds — the
duplicate-pick cost is measured against the portfolio AS IT STANDS on every comparison, so it
decides the pick rather than being reported after it; the load penalty punishes an identity that has
just been cycling inside the persisted window. Selection is a documented greedy pass — coverage,
then the reserved evaluator, then fill — with identity-order tie-breaks, so equal inputs always
produce the same portfolio, and the `portfolio_id` is derived from the candidate **set** (identities
and modes, normalised and sorted), so re-ordering the same candidates reuses the stored row instead
of writing a second, identical one. One **verifier/critic that is not among the generators** is
reserved with the reason `independent evaluator`; when the team holds none, the portfolio says so by
name instead of inventing one.

**The first pass is independent.** `plan_independent_first_pass` turns the team into per-agent
generation requests carrying ONLY the mission digest (ids, version, title, intent, the trace's
problem-state digest, a summary of signal SHAPES, the coverage gaps and the exclusions as
`{ref, kind, reason, text_hash}` fingerprints), the agent's OWN envelope and mode, and the engine
settings derived from them — no peer seeds, no peer identities, no peer envelope, no private memory.
With `run: true` each READY request runs through ITER-6's engine, which reads that agent's OWN trace
and archive (both `{user_id, mission_id}`-keyed, so the isolation is structural rather than a filter
that could be forgotten). Each agent's stream is derived from the pass, its MODE and its envelope
scoring — never from a peer and never from the identity's private state. A request whose agent has no
trace, or whose envelope is missing, expired, tampered with or granted for another mode, comes back
`blocked` with the named reason and makes zero model calls.

**Synthesis preserves.** `synthesize_portfolios` merges the portfolios with provenance intact: a
candidate several agents produced keeps EVERY source in its `provenance` (the merge collapses the
statement, never the lineage), the exclusions ride along VERBATIM as fingerprints, and supplying a
list that DROPS one is refused (`exclusion_dropped`) or REWRITES one (`exclusion_rewritten`). A
synthesizer **cannot add** an exclusion either: one that is supplied but NOT on record is IGNORED —
it never reaches the artifact, and the tool names it back under *Ignored* rather than dropping it
silently — because an exclusion is the mission's record of what it ruled out, and a merge preserves
that record instead of extending it. The merged artifact appends a `synthesis` lineage record and
**cannot promote**: it is a private row carrying `promoted: false`, and no promotion path exists in
this family.

### assign_thinking_mode

Assign, renew or expire an ephemeral thinking mode for a mission. `action: "assign"` (the default)
records the reason (≤500 characters — refused, never truncated), the TTL (default 4h; a NUMBER of
milliseconds, refused outside the documented 1 minute..7 day window rather than clamped, and never
coerced from a string), the policy version, the inheritance policy, the parent's disposition
snapshot version and the reset behaviour, and returns the catalogue entry with the mode's attention
bias and obligation **verbatim**. A mode is working state, so assigning or renewing one on a mission
that is not runnable (`completed`, `cancelled`, a draft or any other state) is refused by name
(`mission_not_runnable`) before anything is written. `action: "renew"` is the ONLY path that moves
`expires_at` — it requires a reason and extends from `max(now, current expiry)`; an expired
assignment cannot be renewed (assign the mode again with a fresh reason). `action: "expire"` ends a
mode early, with a reason, and is idempotent (a second attempt reports `already_expired` and rewrites
nothing). An untrusted caller may only act for its own identity. **Write.**

| Parameter | Type | Required | Default |
|---|---|---|---|
| action | `assign` \| `renew` \| `expire` | No | `assign` |
| mission_id | string | Yes | — |
| mode | one of the eight Appendix C modes | Yes for `assign` | — |
| reason | string (≤500) | Yes | — (every transition needs one) |
| ttl_ms | integer | No | 4 hours (`renew` reuses the assignment's TTL) |
| assignment_id | string | Yes for `renew`/`expire` | — |
| user_id | string | No | caller's identity (trusted callers only may override) |

### get_active_mode

Read the thinking mode in force for a mission, with **expiry computed at read**: an assignment past
its window is reported `expired` (and recorded as expired exactly once — there is no cron anywhere),
together with the catalogue entry (attention bias, obligation, the approved dimensions it may bias,
its attention bins and its engine spread), the window, the renewals and the recorded expiry. It also
lists the newest recorded assignments. Reads are **pinned**: an untrusted caller is served its OWN
mode, and NAMING another identity is refused by name rather than silently answered for the caller —
a mission's owner reads the mode it holds on its mission under its own identity, and another
identity's assignment needs a trusted caller. **Read.**

| Parameter | Type | Required | Default |
|---|---|---|---|
| mission_id | string | Yes | — |
| limit | integer (1..50) | No | 10 (the recorded-assignment list) |
| user_id | string | No | caller's identity (trusted callers only may override) |

### create_inheritance_envelope

Create the bounded inheritance grant a spawned cognitive scope receives, or apply bounded MUTATIONS
to one (`envelope_id`). The envelope is an immutable reference (parent identity + disposition
snapshot + immutable bounds + approved dimensions + the parent's baseline + an expiry) and carries
no private memory of any kind. A mutation is clamped into its documented range and recorded in the
envelope's history; anything else is refused BY NAME — `immutable_invariant` (the message priority,
the floors, the cap bounds, the privacy policy and every alias), `dimension_not_approved` (an unknown
dimension, or one this envelope's mode may not bias) or `out_of_bounds` (not a finite number, or an
attempt to widen a per-source cap). Refused mutations are reported together with the envelope the
accepted ones produced, and the parent's own configuration is never modified. **Write.**

| Parameter | Type | Required | Default |
|---|---|---|---|
| mission_id | string | Yes | — |
| child_label | string (≤120) | Yes to create | — |
| envelope_id | string | Yes to mutate | — |
| mode | one of the eight modes | No | no mode (every approved dimension is open) |
| ttl_ms | integer | No | 4 hours |
| mutations | `[{dimension, value}]` (≤16) | No | — (the mode's own default bias is applied either way) |
| user_id | string | No | caller's identity (trusted callers only may override) |

### allocate_cognitive_portfolio

Allocate a portfolio — not one winner — for a mission, with every score component and penalty
reported with its inputs. `missing_approach_coverage` comes from the archive's coverage gaps unless
`missing_bins` is supplied, so the allocation targets the bins nothing occupies; `recent_success` is
derived from the identity's recorded candidate outcomes; `availability` from its live mode
assignments; the convergence penalty punishes sharing a mode with peers and picking a further agent
of a mode the portfolio already holds; the load penalty punishes recent cycling. The result reserves
one verifier/critic that is **not** among the generators, recorded with the reason `independent
evaluator`. Deterministic: equal inputs produce the same portfolio, and re-allocating returns the
stored one. **Write.**

| Parameter | Type | Required | Default |
|---|---|---|---|
| mission_id | string | Yes | — |
| candidates | `[{identity, mode, emotional_proximity?, task_skill_fit?, availability?, covered_bins?, recent_cycles?}]` (1..24) | Yes | — |
| missing_bins | string[] (≤64) | No | the archive's coverage gaps |
| max_agents | integer (1..12) | No | 6 |
| user_id | string | No | caller's identity (trusted callers only may override) |

### plan_independent_first_pass

Plan — and with `run: true` execute — an independent first pass. Each agent gets its OWN generation
request: the mission digest (ids, version, title, intent, the trace's problem-state digest, a summary
of signal SHAPES, the coverage gaps and the exclusions as fingerprints), its OWN envelope and mode
definition, and the engine settings derived from them. With `run: true` each ready request runs
through ITER-6's engine against that agent's own trace and archive, and each agent's stream is
derived from the pass, its mode and its envelope scoring — never from a peer. A request whose agent
has no trace, or whose envelope is missing, expired, tampered with or granted for another mode, is
returned `blocked` with the named reason. **Write** (`run: false` plans and writes only the pass
record; no model call is made). 

| Parameter | Type | Required | Default |
|---|---|---|---|
| mission_id | string | Yes | — |
| team | `[{identity, mode, envelope_id?}]` (1..12) | Yes | — |
| run | boolean | No | `false` (plan only) |
| user_id | string | No | caller's identity (trusted callers only may override) |

### synthesize_portfolios

Merge the portfolios of an independent first pass into ONE synthesized portfolio with provenance
intact. A candidate several agents produced keeps every source in its `provenance` — the merge
collapses the statement, never the lineage — and the exclusions ride along verbatim as fingerprints.
Supplying an `exclusions` list that drops one on record is refused (`exclusion_dropped`), and
rewriting one is refused (`exclusion_rewritten`). A synthesizer cannot ADD one either: an exclusion
supplied that is not on record is **ignored** — it never reaches the artifact and the output lists it
under *Ignored* — because a synthesis preserves the mission's exclusions instead of extending them.
The artifact appends a `synthesis` lineage record, carries `promoted: false` and cannot promote.
**Write.**

| Parameter | Type | Required | Default |
|---|---|---|---|
| mission_id | string | Yes | — |
| pass_id | string | Yes | — |
| exclusions | `[{ref, kind, reason, text_hash}]` | No | the source portfolios' own exclusions, carried verbatim |
| synthesizer_identity | string | No | the caller's identity |
| user_id | string | No | caller's identity (trusted callers only may override) |
