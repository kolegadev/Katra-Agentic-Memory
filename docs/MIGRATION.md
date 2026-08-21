# Migration from cognitive-memory-chat

This guide covers migrating from [cognitive-memory-chat](https://github.com/kolegadev/cognitive-memory-chat) to Satori.

## What's the Same

- **Core engine** — Same core memory services (episodic, semantic, knowledge graph, working memory, embeddings, background processor, sleep consolidation, etc.)
- **MCP tools** — The original memory tools behave the same; Katra registers 66 tools today (up from 48 at migration time — see [MCP-TOOLS.md](MCP-TOOLS.md))
- **REST API** — Same route structure under `/api/v1/`
- **Database** — Same MongoDB collections and index structure
- **Redis** — Same working memory and caching patterns
- **Docker** — Same service architecture (MongoDB + Redis + MinIO + server)

## What's Different

| Aspect | cognitive-memory-chat | Satori |
|---|---|---|
| **Purpose** | Solomon agent + memory system | Memory system only |
| **Services** | 45+ services (including agent, heartbeat, autonomous execution) | Core memory services plus newer additions: skill engine, executive/cognitive services, code-graph tools |
| **LLM** | Hardcoded DeepSeek/Moonshot | Pluggable (DeepSeek, OpenAI, Moonshot, Ollama, custom OpenAI-compatible) |
| **Identity** | Solomon-specific capability card | Per-identity client keys — `satori`, `shoshin`, `zanshin` + tool actor `gas-law-watcher` |
| **Ingestion** | OpenClaw-specific | Generic (any JSONL-producing platform) |
| **API keys** | `ADMIN_API_KEY` (plaintext) | `KATRA_API_KEY` (admin key, authenticates as trusted satori) + identity-resolved client keys (sha256 hashes only, in `system_settings.client_keys`) |
| **Database name** | `cognitive-memory` | `katra` |
| **Build** | `tsc` (needs lots of RAM) | `esbuild` (Pi-compatible) |
| **New in Satori** | — | Sleep consolidation, identity separation (2026-08-21 cutover), test suite (482 tests), security hardening |

## Environment Variable Changes

| cognitive-memory-chat | Satori | Notes |
|---|---|---|
| `ADMIN_API_KEY` | `KATRA_API_KEY` | Renamed — the admin key now authenticates as trusted `satori` |
| `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | Same (legacy support) |
| — | `LLM_PROVIDERS` | New multi-provider config |
| — | `LLM_PROVIDER_*_API_KEY` | New per-provider keys |
| — | `EMBEDDING_PROVIDER` | New (default: `local` — Xenova/all-MiniLM-L6-v2) |
| — | `HOST_MCP_PORT` / `HOST_API_PORT` | Compose host mapping — `3112 -> 3100` (MCP) and `9012 -> 9002` (REST) |
| — | `SOLOMEM_USER_ID` | The server's own default identity (compose sets `satori`) |
| — | client keys | Not an env var — provisioned at boot as sha256 hashes in `system_settings.client_keys`, printed once in the server log |

> **Legacy env keys retired (2026-08-21):** `MCP_API_KEY` and
> `BACKUP_MCP_KEYS` no longer authenticate. There is no fallback — a
> valid-but-unmapped key is rejected with 401. See
> [Identity Cutover](#identity-cutover-2026-08-21) below.

## Database Migration

### Option 1: Same MongoDB, New Database

Both systems can share the same MongoDB instance using different databases:

```bash
# cognitive-memory-chat uses: cognitive-memory
# Satori uses: katra

# Run migration script
python3 scripts/python/migrate_from_cognitive_memory.py \
  --source "mongodb://admin:password@localhost:27017/cognitive-memory?authSource=admin" \
  --target "mongodb://admin:password@localhost:27017/katra?authSource=admin"
```

### Option 2: Dry Run First

```bash
python3 scripts/python/migrate_from_cognitive_memory.py \
  --source "mongodb://..." \
  --target "mongodb://..." \
  --dry-run
```

This counts documents per collection without copying.

### Option 3: Specific Collections

```bash
python3 scripts/python/migrate_from_cognitive_memory.py \
  --source "mongodb://..." \
  --target "mongodb://..." \
  --collections episodic_events,semantic_facts,knowledge_nodes
```

## Running Both Side-By-Side

You can run both systems simultaneously:

1. **Different ports**: cognitive-memory-chat on host 9002/3100, Satori on host 9012/3112
2. **Different databases**: `cognitive-memory` and `katra` in the same MongoDB
3. **Different Docker Compose files**: each with its own network

```bash
# cognitive-memory-chat
cd cognitive-memory-chat
docker compose up -d  # ports 9002, 3100

# Satori (different ports)
cd Satori-Agentic-Memory
# Edit docker-compose.yml: change ports to 9012:9002, 3112:3100
docker compose up -d
```

## Identity Cutover (2026-08-21)

Katra no longer uses a single shared agent identity. If your install predates
the cutover, it needs the rekey steps documented in the authoritative runbook:
[`docs/runbook-identity-cutover.md`](runbook-identity-cutover.md). Summary:

- **user_id rekey:** legacy `kolega-agent` / `opencode-agent` writes were
  rekeyed to the named identities — `satori` (this machine), `shoshin` (iMac
  trading Kolega Code), `zanshin` (iMac OpenCode desktop). The old ids are
  retired and receive zero new writes.
- **client_keys:** identity is resolved from the API key presented
  (`X-MCP-Auth` / `Authorization: Bearer` / `?token=`), never from client
  self-report. Keys are stored only as sha256 hashes in
  `system_settings.client_keys`, provisioned idempotently at boot
  (`ensureClientKeys()`), and printed once in the server log under "Client
  keys (identity separation)".
- **Legacy env keys retired:** `MCP_API_KEY` and `BACKUP_MCP_KEYS` no longer
  authenticate. A valid-but-unmapped key is rejected with 401 + reason —
  loud failure, no silent fallback to satori.
- **Scope policy:** personal kinds (`journal`, `reflection`, `emotional`,
  `insight`) are always private per identity; everything else defaults to the
  shared `my-team` scope unless the write passes `private: true`. Implemented
  in `server/src/services/memory/write-scope-policy.ts`.
- **Identity endpoints:** `get_my_identity` (MCP) returns the caller's own
  identity record; `GET /api/v1/admin/identity` (no auth) returns the system
  identity, `GET /api/v1/admin/identity?user_id=X` (admin key) returns
  per-identity records (`agent_identity:<user_id>`), and
  `PUT /api/v1/admin/identity` sets it (admin key).

## Migration Checklist

1. [ ] Clone Satori: `git clone https://github.com/kolegadev/Satori-Agentic-Memory`
2. [ ] Copy `.env.example` to `.env`, configure API key and LLM
3. [ ] Start Satori: `docker compose up -d`
4. [ ] Verify health: `curl http://localhost:3112/health`
5. [ ] Run migration script (dry run first): `python3 scripts/python/migrate_from_cognitive_memory.py --source ... --target ... --dry-run`
6. [ ] Run actual migration: `python3 scripts/python/migrate_from_cognitive_memory.py --source ... --target ...`
7. [ ] Verify migrated data: `curl -X POST http://localhost:9012/api/v1/memory/episodic/search -H "Authorization: Bearer KEY" -H "Content-Type: application/json" -d '{"query":"test","user_id":"openclaw-main"}'`
8. [ ] Update agent MCP config to point at Satori
9. [ ] Deploy Satori watcher (if using auto-collection)
10. [ ] Verify agent can search memories through Satori
11. [ ] (Optional) Shut down cognitive-memory-chat

## What's Left Behind

Some Solomon-specific services were **not** carried over, and Katra grew its
own equivalents for others:

- **Heartbeat / autonomous execution** — replaced by Katra's own autonomous
  loop: the autonomous executive
  (`server/src/services/processing/autonomous-executive.ts`) plus the
  `scripts/python/` loop scripts (`adaptive_heartbeat.py`,
  `agent_executor.py`, `wake_service.py`, `satori_pubsub.py`,
  `inter_agent_bridge.py`). See [AUTONOMOUS-LOOP.md](AUTONOMOUS-LOOP.md).
- **Skill runner** — replaced by the Katra skill engine (`list_katra_skills`,
  `load_katra_skill`, `search_katra_skills`, `request_skill`, `refine_skill`,
  `record_skill_outcome`, …).

Still left behind (no Katra equivalent):
- Gitea service
- LUKS secret manager
- Inbox triage service
- Conversation service (chat interface)
- Response generation service
- Chain reasoning service
- LLM memory curator

If you need any of these, they remain in cognitive-memory-chat.
