# Changelog

All notable changes to Katra-Agentic-Memory are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> ⚠️ **Deployment precondition — do not deploy this server change ahead of the bridge.**
> `GET /api/v1/admin/personality` is now **caller-pinned and authenticated**: it resolves the
> caller's own identity record, and `?user_id=<other>` requires the admin key. Any consumer that
> fetches it unauthenticated must send a key. The Kolega Code bridge does exactly that —
> `kolega_katra_bridge/config.py` (`_fetch_server_personality`) issues a plain `client.get(url)`
> with no `Authorization` header — and it **fails open**, so a 401 leaves the bridge on its
> locally-configured personality with nothing surfaced at default verbosity. In a deployment
> where the bridge reads server personality, shipping the server first therefore *silently* stops
> the dashboard from governing bridge retrieval. ITER-3 pins the bridge to an identity key (and
> `?user_id=` when it acts for a named identity) — deploy the bridge update first, or together
> with this change.

### Added
- **Agent identity separation** — one Katra serves multiple named identities (one per machine/agent) plus optional tool actors. Identity is resolved from the presented API key (loopback/admin key → trusted machine identity; client keys → their identity); valid-but-unmapped keys are rejected with a loud 401. `get_my_identity` MCP tool; per-user `agent_identity:<user_id>` records; `GET /api/v1/admin/identity?user_id=` for per-identity records
- **Hybrid scope policy** — personal kinds (journal, reflection, emotional, insight) are always private; all other writes default to `my-team` (`private: true` opts out); reads return the caller's private memories plus the team scope
- **Inter-agent message bus** — `Attention: <Agent>` messages through shared memory, surfaced by wake rituals and the Kolega Code bridge, with read receipts tagged `background-ack` / `read-receipt` (wake services skip them)
- **Per-agent wake rituals** — identity, latest journal, unresolved threads, memory health, rules recall, messages from the team; identity retry ×3 with a fix checklist; per-machine `~/.katra/wake-env.sh`
- **Katra Graph code tools** — `sync_code_graph`, `scan_codebase`, `code_graph_status` (replaces the Graphify toolchain in the bug-fix and loop-director skills)
- **Client key provisioning** — `ensureClientKeys()` generates per-identity client keys at boot, printed once, stored as sha256 hashes only; `resolveCallerIdentity` pins every write to the caller
- **Personality registry parity tests** — `server/tests/unit/personality-registry-parity.test.ts` (artifact freshness, the agent-message invariant, and a zero-drift proof computed from `git show 48ba7e6:`) and `integrations/kolega-code/scripts/test_personality_registry.py` (bridge-vs-registry parity, stdlib only, run in CI)
- **Per-identity Memory Personality** (`PER_IDENTITY_PERSONALITY`, default **off**) — the saved personality is no longer process-wide: each identity resolves and writes its own `personality_config:<user_id>` record, with the legacy global record as the migration fallback and the built-in `balanced` defaults last. Off (default) keeps today's global behaviour byte-for-byte. New `personality-config-service` (`resolve` / `update` / `snapshot`, read-only resolution, extracted PUT sanitiser); the dashboard's Personality tab gains an identity selector and shows the resolved origin, version and `updated_at`, with a notice while the flag is off
- **`get_my_personality` MCP tool** — the caller's resolved profile, effective source weights, scoring, version and origin, caller-pinned (`user_id` supplied by an untrusted caller is ignored), registered only when `PER_IDENTITY_PERSONALITY` is on; `active_mode` is reported `null` until thinking modes land in Phase 6

### Changed
- **Personality endpoints are caller-pinned and authenticated** — `GET`/`PUT /api/v1/admin/personality` left the no-auth allowlists (`middleware/caller-auth.ts`, `admin-routes.ts`): the record now resolves for the resolved caller, `?user_id=<id>` (another identity) requires the admin key, and the dashboard sends `Authorization`. `GET /api/v1/admin/personality/profiles` stays public — it is a static catalogue. Resolution never writes or migrates, so no identity inherits another's configuration and the legacy record is untouched
- **Personality profiles now come from one registry** — `shared/personality/registry.json` is the single source of truth for the ten memory personality profiles; `server/src/services/integration/personality-profiles.ts` and `integrations/kolega-code/kolega_katra_bridge/personality.py` keep their public APIs and behaviour unchanged and now consume generated artifacts (`personality-profiles.generated.ts`, `personality_registry.generated.py`) rendered by `scripts/generate-personality-registry.mjs` (`--check` runs in CI, so a hand edit fails the build). Every profile's names, weights, floors and scoring are byte-for-byte what they were — verified against `48ba7e6`
- **README + documentation overhaul** — identity separation, message bus, wake rituals, MCP tool reference, retired legacy keys, license section cleanup
- **MCP tool counts corrected to the measured surface** — `README.md` and `docs/MCP-TOOLS.md` now state **81** registered tools (every feature flag off), not the stale 67: the 15-tool gap was the undocumented `vault_*` (11) and `auth_*` (4) families, now documented in a *Registered surface* section that also spells out the flag-gated additions (`PER_IDENTITY_PERSONALITY=1` → 82; the cognitive-control plane → 106, or 119 with a scheduler mode). `server/tests/unit/mcp-tool-surface-docs.test.ts` counts the surface from `server/src/mcp-server.ts` itself and fails on any drift between the docs and reality
- Legacy `MCP_API_KEY` / `BACKUP_MCP_KEYS` environment keys retired — they no longer authenticate
- `kolega-agent` / `opencode-agent` user ids rekeyed to the named identities; ~1.3M documents migrated
- Kolega Code bridge: per-machine `KATRA_USER_ID`, platform-aware state dir, `mcp_url` vs `KATRA_HOST` self-healing, key-file fallback
- Helm chart directory `helm/katra/` → `helm/katra/`

### Fixed
- **Concurrent personality writes lost a version increment** — the flag-on `PUT` read the record and then wrote `version + 1` unconditionally, so two simultaneous updates both reported the same version and the second silently overwrote the first. The write is now a bounded compare-and-set on the observed version (`updateOne({key, version: observed})`, re-read and retry on a miss), so interleaved updates land as sequential increments with the last writer's payload; exhausted retries return **409** rather than a version that was never stored
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
