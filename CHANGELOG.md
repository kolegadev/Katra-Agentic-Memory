# Changelog

All notable changes to Katra-Agentic-Memory are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Agent identity separation** — one Katra serves three named identities (`satori` / `shoshin` / `zanshin`) plus the `gas-law-watcher` tool actor. Identity is resolved from the presented API key (loopback/admin key → trusted Satori; client keys → their identity); valid-but-unmapped keys are rejected with a loud 401. `get_my_identity` MCP tool; per-user `agent_identity:<user_id>` records; `GET /api/v1/admin/identity?user_id=` for per-identity records
- **Hybrid scope policy** — personal kinds (journal, reflection, emotional, insight) are always private; all other writes default to `my-team` (`private: true` opts out); reads return the caller's private memories plus the team scope
- **Inter-agent message bus** — `Attention: <Agent>` messages through shared memory, surfaced by wake rituals and the Kolega Code bridge, with read receipts tagged `background-ack` / `read-receipt` (wake services skip them)
- **Per-agent wake rituals** — `satori-wake.sh`, `wake-shoshin.sh`, `wake-zanshin.sh`: identity, latest journal, unresolved threads, memory health, rules recall, messages from the team; identity retry ×3 with a fix checklist; per-machine `~/.katra/wake-env.sh`
- **Satori Graph code tools** — `sync_code_graph`, `scan_codebase`, `code_graph_status` (replaces the Graphify toolchain in the bug-fix and loop-director skills)
- **Client key provisioning** — `ensureClientKeys()` generates Shoshin/Zanshin keys at boot, printed once, stored as sha256 hashes only; `resolveCallerIdentity` pins every write to the caller

### Changed
- **README + documentation overhaul** — identity separation, message bus, wake rituals, 66-tool reference, retired legacy keys, license section cleanup
- Legacy `MCP_API_KEY` / `BACKUP_MCP_KEYS` environment keys retired — they no longer authenticate
- `kolega-agent` / `opencode-agent` user ids rekeyed to the named identities; ~1.3M documents migrated
- Kolega Code bridge: per-machine `KATRA_USER_ID`, platform-aware state dir, `mcp_url` vs `KATRA_HOST` self-healing, key-file fallback
- Helm chart directory `helm/katra/` → `helm/satori/`

### Fixed
- `ensure-bridge.sh` step-3 rewrite condition now also compares `mcp_url` against `KATRA_HOST` (a non-login run could pin `localhost` permanently)
- Cross-identity semantic leak in `search_memories` — vector pass scoped to the caller's view
- Hybrid scope regression in `search_memories` keyword pass — `$or` nested under `$and`
- Agent-message pickup missed the new attention names (Satori/Shoshin/Zanshin); OR-aware search + vector fallback
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
