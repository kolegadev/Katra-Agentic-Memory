# Changelog

All notable changes to Katra-Agentic-Memory are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> ⚠️ **Deployment precondition — ship this server change and the bridge update together.**
> `GET /api/v1/admin/personality` is **caller-pinned and authenticated**: it resolves the
> caller's own identity record and requires a key (it left the no-auth allowlists), and
> `?user_id=<another identity>` requires the admin key. From this iteration the Kolega Code
> bridge does exactly that — `kolega_katra_bridge/config.py` (`_fetch_server_personality`) sends
> `Authorization: Bearer <api_key>` with `?user_id=<its identity>`, caches per identity, and
> reports a rejected key once per cache window ("personality sync rejected the bridge key;
> continuing with the local personality") instead of failing open in silence. A bridge still
> running the pre-iteration fetch (a plain `client.get(url)`, no `Authorization` header) is
> rejected by this server and **fails open**, so the dashboard silently stops governing its
> retrieval. Deploy the bridge with — or before — the server change.

### Added
- **Durable, identity-scoped self-model (ITER-4)** — the cognitive identity stops leaking and stops evaporating. `agent_beliefs` rows carry a `user_id` on every write and every read (`trackBelief(userId, …)` / `getAgentBeliefs(userId, …)`, `user_id` part of the upsert filter, no hardcoded `default` any more) and are guarded by a unique `{user_id, entity_name, proposition}` index; because older deployments hold duplicate keys under the legacy identity-less value, that index is built by an **idempotent, logged migration** (`dedupeAgentBeliefs()`, run by `runDatabaseMigrations()` *before* index initialisation) which counts the duplicates, collapses each key group deterministically (highest `confidence`, then newest `last_updated`, then lowest `_id`), logs *and returns* the documents removed and groups touched, and only then creates the index — a second run reports zeros and writes nothing, and lone legacy rows are left exactly as they are. Procedural patterns are no longer process-local: the new `procedural_patterns` collection holds one row per `{user_id, tool_name, input_shape}` (`frequency`, `successes`, `avg_success`, `last_seen`, unique triple, `{user_id, last_seen: -1}` for reads, indexes created lazily by `ensureSelfModelIndexes()`); the in-process map is a cache that hydrates per identity and never returns another identity's rows; writes persist best-effort after a short debounce (`flushProceduralPatterns()` for the shutdown path, `resetProceduralCache()` to re-read). The MCP tool-outcome wrapper records every observation under the *resolved* caller identity, and `get_agent_beliefs` / `get_procedural_templates` are caller-pinned (the latter gains the optional `user_id` only trusted callers can point at another identity); `OperationalDistillationService.runDistillation({ userId })` reads patterns through the scoped API instead of reaching into the private map. No flag — these are safety corrections, and an agent's habits now survive a restart
- **Bridge: a hostile identity cannot inject** — the personality fetch URL-encodes its identity (`urllib.parse.quote(identity, safe='')`), so a crafted `user_id` such as `bob&user_id=agent-b` stays ONE query parameter and cannot name another identity, and the 401/403 warning renders the identity with `%r` escaping, so a newline-bearing identity can no longer forge a log record. `integrations/kolega-code/scripts/test_bridge_personality_fetch.py` proves both (110 checks, stdlib only)
- **Agent identity separation** — one Katra serves multiple named identities (one per machine/agent) plus optional tool actors. Identity is resolved from the presented API key (loopback/admin key → trusted machine identity; client keys → their identity); valid-but-unmapped keys are rejected with a loud 401. `get_my_identity` MCP tool; per-user `agent_identity:<user_id>` records; `GET /api/v1/admin/identity?user_id=` for per-identity records
- **Hybrid scope policy** — personal kinds (journal, reflection, emotional, insight) are always private; all other writes default to `my-team` (`private: true` opts out); reads return the caller's private memories plus the team scope
- **Inter-agent message bus** — `Attention: <Agent>` messages through shared memory, surfaced by wake rituals and the Kolega Code bridge, with read receipts tagged `background-ack` / `read-receipt` (wake services skip them)
- **Per-agent wake rituals** — identity, latest journal, unresolved threads, memory health, rules recall, messages from the team; identity retry ×3 with a fix checklist; per-machine `~/.katra/wake-env.sh`
- **Katra Graph code tools** — `sync_code_graph`, `scan_codebase`, `code_graph_status` (replaces the Graphify toolchain in the bug-fix and loop-director skills)
- **Client key provisioning** — `ensureClientKeys()` generates per-identity client keys at boot, printed once, stored as sha256 hashes only; `resolveCallerIdentity` pins every write to the caller
- **Personality registry parity tests** — `server/tests/unit/personality-registry-parity.test.ts` (artifact freshness, the agent-message invariant, and a zero-drift proof computed from `git show 48ba7e6:`) and `integrations/kolega-code/scripts/test_personality_registry.py` (bridge-vs-registry parity, stdlib only, run in CI)
- **Per-identity Memory Personality** (`PER_IDENTITY_PERSONALITY`, default **off**) — the saved personality is no longer process-wide: each identity resolves and writes its own `personality_config:<user_id>` record, with the legacy global record as the migration fallback and the built-in `balanced` defaults last. Off (default) keeps today's global behaviour byte-for-byte. New `personality-config-service` (`resolve` / `update` / `snapshot`, read-only resolution, extracted PUT sanitiser); the dashboard's Personality tab gains an identity selector and shows the resolved origin, version and `updated_at`, with a notice while the flag is off
- **`get_my_personality` MCP tool** — the caller's resolved profile, effective source weights, scoring, version and origin, caller-pinned (`user_id` supplied by an untrusted caller is ignored), registered only when `PER_IDENTITY_PERSONALITY` is on; `active_mode` is reported `null` until thinking modes land in Phase 6
- **Kolega Code bridge: per-identity, authenticated personality sync** — `_fetch_server_personality(cfg, client=None)` now asks for *its own* record (`GET {rest_base}/admin/personality?user_id=<cfg.user_id>`) with `Authorization: Bearer <cfg.api_key>` (the header is omitted entirely when the key is empty — never a bare `Bearer `), so the per-identity record actually reaches agents. The result cache is keyed per `(REST base, identity)` (two identities never share an entry; TTL unchanged at 60 s), and `BridgeConfig` gains optional `personality_version` / `personality_origin` reporting which record was served. `client` is an injectable seam, so the new stdlib-only regression script `integrations/kolega-code/scripts/test_bridge_personality_fetch.py` proves the request, the cache isolation and the fail-open paths without httpx (run in CI next to the registry parity check)

### Changed
- **Personality endpoints are caller-pinned and authenticated** — `GET`/`PUT /api/v1/admin/personality` left the no-auth allowlists (`middleware/caller-auth.ts`, `admin-routes.ts`): the record now resolves for the resolved caller, `?user_id=<id>` (another identity) requires the admin key, and the dashboard sends `Authorization`. `GET /api/v1/admin/personality/profiles` stays public — it is a static catalogue. Resolution never writes or migrates, so no identity inherits another's configuration and the legacy record is untouched
- **Naming your OWN identity is not naming another one** — `GET`/`PUT /api/v1/admin/personality?user_id=<the caller's own id>` now behaves exactly like omitting the parameter (200, resolved and pinned to the caller), so a client can always state who it is; the comparison is made against the resolved caller, so any other id stays admin-gated (401 without the admin key). This is what lets the Kolega Code bridge send its identity unconditionally
- **Bridge: a rejected personality sync is now visible** — a 401/403 from the personality fetch is logged as one operational warning per cache window (60 s) per identity ("personality sync rejected the bridge key; continuing with the local personality"), naming the identity and the status, instead of falling back to the local personality in silence; other failures stay at debug. Fail-open is unchanged: any failure returns `None` and the hook keeps its locally-configured personality. A successful sync is logged with the profile, `version` and `origin` when the bridge's `debug` flag is on
- **Personality profiles now come from one registry** — `shared/personality/registry.json` is the single source of truth for the ten memory personality profiles; `server/src/services/integration/personality-profiles.ts` and `integrations/kolega-code/kolega_katra_bridge/personality.py` keep their public APIs and behaviour unchanged and now consume generated artifacts (`personality-profiles.generated.ts`, `personality_registry.generated.py`) rendered by `scripts/generate-personality-registry.mjs` (`--check` runs in CI, so a hand edit fails the build). Every profile's names, weights, floors and scoring are byte-for-byte what they were — verified against `48ba7e6`
- **README + documentation overhaul** — identity separation, message bus, wake rituals, MCP tool reference, retired legacy keys, license section cleanup
- **MCP tool counts corrected to the measured surface** — `README.md` and `docs/MCP-TOOLS.md` now state **81** registered tools (every feature flag off), not the stale 67: the 15-tool gap was the undocumented `vault_*` (11) and `auth_*` (4) families, now documented in a *Registered surface* section that also spells out the flag-gated additions (`PER_IDENTITY_PERSONALITY=1` → 82; the cognitive-control plane → 106, or 119 with a scheduler mode). `server/tests/unit/mcp-tool-surface-docs.test.ts` counts the surface from `server/src/mcp-server.ts` itself and fails on any drift between the docs and reality
- **The four documents the sweep missed now state the same measured surface** — `docs/ARCHITECTURE.md` (5 mentions), `docs/Data-Processing-Pipelines.md`, `sdks/python/README.md` and `sdks/typescript/README.md` still said 66, so the drift class is closed rather than the instance: `server/tests/unit/mcp-tool-surface-docs.test.ts` now extracts **every** tool-count mention from all four (and asserts the mentions are still there, so deleting one fails too), requires each to equal the measured count, and rejects the pre-fix totals in every shape they used to appear. `docs/MCP-TOOLS.md` no longer claims `get_agent_beliefs`' `user_id` is unused and `get_procedural_templates` now documents that it takes one
- Legacy `MCP_API_KEY` / `BACKUP_MCP_KEYS` environment keys retired — they no longer authenticate
- `kolega-agent` / `opencode-agent` user ids rekeyed to the named identities; ~1.3M documents migrated
- Kolega Code bridge: per-machine `KATRA_USER_ID`, platform-aware state dir, `mcp_url` vs `KATRA_HOST` self-healing, key-file fallback
- Helm chart directory `helm/katra/` → `helm/katra/`

### Fixed
- **Beliefs leaked between identities and evaporated on restart** — `trackBelief` hardcoded `user_id: 'default'` on insert while `getAgentBeliefs` filtered by `entity_name` alone, so every identity read (and overwrote) the same rows, and the whole procedural map died with the process. Beliefs are now written and read per identity (a write without an identity is refused, never attributed to anyone) and procedural patterns are persisted per identity, so an untrusted caller can no longer read or write another identity's beliefs or habits, and a restart no longer forgets them. `server/tests/unit/self-model-identity.test.ts` proves both, including the restart and the migration's second-run no-op; `tests/security/user-id-scoping.test.ts` covers the beliefs/procedures cases
- **Concurrent personality writes lost a version increment** — the flag-on `PUT` read the record and then wrote `version + 1` unconditionally, so two simultaneous updates both reported the same version and the second silently overwrote the first. The write is now a bounded compare-and-set on the observed version (`updateOne({key, version: observed})`, re-read and retry on a miss), so interleaved updates land as sequential increments with the last writer's payload; exhausted retries return **409** rather than a version that was never stored
- **Two identities creating their first personality record at once silently discarded a payload** — the create branch upserted on the key alone, so a record another writer created between our read and our write was matched and overwritten with `version: 1`, losing that writer's payload and its increments. The create is now guarded with `{ key, version: { $exists: false } }` and a create that *matches instead of inserting* (or that the unique `key` index refuses as a duplicate) is retried through the guarded update path: `version` is the number of successful writes, and every landed write moves it by exactly one
- **A hand-written or pre-versioned identity record was permanently unwritable** — the write guard asked for the *absence* of `version` whenever the stored value was not a finite number, which a record that has the field never satisfies: every attempt missed and the write returned **409** forever. The guard now pins the observed raw value (equality on whatever is stored, including `null` and a string), and `resolve()` keeps reporting `version: 0` for a non-finite or absent version, so a repaired write lands as version 1
- **A retried personality write recorded a stale `updated_at`** — the timestamp was captured before the retry loop, so a write that lost a race and landed on a later attempt claimed the time the request started. It is now stamped inside the loop, per attempt
- **Dashboard Personality tab interpolated server values into `innerHTML()` unescaped** — `resolved_for` (and the origin label built from it), the identity selector's ids, profile names and the weight grid are HTML-escaped through a shared `escHtml()` helper, closing a self-XSS in `renderPersonalityResolution()`
- `vector_search` scored a frozen candidate slice — `find(...).limit(50)` with no sort meant every query re-ranked the same documents (measured: a four-day window of mid-July, 0 of 50 newer than seven days, out of 45k embedded facts in scope). Candidates are now the newest-in-scope ∪ query-matched documents; undated documents no longer score `NaN`
- Long documents were truncated at the model's 512 positions and mean-pooled once, so everything past the first window was invisible to search. Embedding now splits into overlapping windows (1,000 chars, measured ≤350 tokens) and averages their vectors; `server/scripts/reembed-long-docs.mjs` refreshes documents embedded before the change
- `ensure-bridge.sh` step-3 rewrite condition now also compares `mcp_url` against `KATRA_HOST` (a non-login run could pin `localhost` permanently)
- Cross-identity semantic leak in `search_memories` — vector pass scoped to the caller's view
- Hybrid scope regression in `search_memories` keyword pass — `$or` nested under `$and`
- Agent-message pickup missed newly provisioned identity attention names; OR-aware search + vector fallback
- Wake scripts now handle missing `KATRA_HOST`, legacy keys, and whitespace-padded config values

## [0.1.0] — 2026-06-26

### Added
- **Autonomous agent loop** — salience-driven neural action potential cadence with adaptive heartbeat, task allocation by emotional proximity, execution authority matrix, and terminal prompt injection for KolegaCode
- **Dashboard redesign** — admin panel with memory search, agent management, pending approvals flow, read-only public stats, and click-to-expand memory row inspection
- **Multi-collection search endpoint** — public search across all memory stores
- **Sleep consolidation service** — reflective memory distillation with daily/weekly/monthly cycles for emotional understanding, philosophical insights, and self-narrative
- **Post-install deep-read prompt** — agent self-discovers setup steps from documentation
- **OpenClaw integration guide** — full config reference with transport fixes

### Fixed
- **Embedding coverage** — three bugs resolved increasing coverage from ~2.9% to near 100% (race condition, metadata path, missing storage on semantic facts)
- **MongoDB `access_count` conflict** in `store_memory` MCP tool
- **MongoDB `created_at` conflict** in `add_semantic_fact`
- **SSE GET returning 405** — helpful error for OpenClaw transport misconfiguration
- **Pi5/OpenClaw install** — healthchecks, retry logic, clearer docs
- **Memory migration phasing** — wire Katra before disabling local memory
- **Adaptive heartbeat** — two critical bugs resolved, demo sleep cap removed, unbuffered logging
- **Dashboard data flow** — dedicated stats endpoint, unified overview, correct approve/reject endpoint path
- **Agent scope badges** — reflect actual memory scope configuration
- **Pre-download ONNX model** in Dockerfile + fix embedding health check
- **Route auth middleware** — corrected `validateKatraKey` invocation

### Security
- **Batches 1–7** — 25+ fixes across 16 files including:
  - SSRF vulnerability in LLM base URL configuration
  - Cross-tenant session leakage (scoped sessions to user ID)
  - ReDoS vulnerability in MongoDB regex queries
  - Timing attack vulnerability in API key comparison
  - MongoDB credentials exposure in CLI arguments
  - Missing user scoping in SemanticMemoryService queries
  - Tenant isolation bypass in cross-session knowledge search
  - IDOR vulnerability (bound user_id to server identity)
  - Missing authentication on tenant management routes
  - Insecure event ID generation (cryptographically secure UUIDs)
  - Authorization check in learning analytics endpoint
  - Sensitive data in error logs (background processor)
  - Rate limiting middleware to prevent API abuse
  - Redis password exposure in connection logs
  - Hardcoded API key in scripts
  - Protobufjs vulnerability fix
  - UUID buffer bounds check upgrade
  - Flatbuffers license compliance fix
  - API key authentication middleware on memory & admin routes
  - Removed hardcoded API key from dashboard configuration

### Changed
- **Documentation overhaul** — comprehensive refresh of README, architecture docs, SKILL.md for agent-agnostic design
- **License** — MIT → Apache 2.0 to match LICENSE file
- **Universal trigger mechanism** — agent-agnostic refactor
- **Task delivery** — heartbeat posts bulletins to auto-journal
- **All subprocess/curl calls removed** — native urllib used throughout

### Added
- **Integration tests** — 15 tests across 3 files
- **Unit tests** — 72 tests across 6 files (Vitest)
- **Dockerfile** — pre-download ONNX model for embedding

## [0.0.1] — 2026-06-18

### Added
- Initial release of Katra-Agentic-Memory
- MCP-native cognitive memory server with SSE transport
- Multi-layered memory architecture (episodic, semantic, working, temporal, knowledge graph)
- Local embeddings via Transformers.js (Xenova/all-MiniLM-L6-v2)
- 35 MCP tools for memory operations
- Docker Compose deployment (MongoDB, Redis, MinIO, Katra server)
- Dashboard web UI
- Python SDK (`sdks/python/`)
- TypeScript SDK (`sdks/typescript/`)
- Watcher system for multi-platform session extraction (OpenClaw, Claude Code, Kolega Code, OpenCode, Codex CLI)
- Terraform module for AWS deployment
- Helm chart for Kubernetes deployment
- Documentation: Quick Start, Architecture, API Reference, MCP Tools, Configuration, Deployment, Migration
