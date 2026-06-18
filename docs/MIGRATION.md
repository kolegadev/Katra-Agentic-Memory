# Migration from cognitive-memory-chat

This guide covers migrating from [cognitive-memory-chat](https://github.com/kolegadev/cognitive-memory-chat) to Katra.

## What's the Same

- **Core engine** — Same 14 memory services (episodic, semantic, knowledge graph, working memory, embeddings, background processor, etc.)
- **MCP tools** — All 25 MCP tools work identically
- **REST API** — Same route structure under `/api/v1/`
- **Database** — Same MongoDB collections and index structure
- **Redis** — Same working memory and caching patterns
- **Docker** — Same service architecture (MongoDB + Redis + MinIO + server)

## What's Different

| Aspect | cognitive-memory-chat | Katra |
|---|---|---|
| **Purpose** | Solomon agent + memory system | Memory system only |
| **Services** | 45+ services (including agent, heartbeat, autonomous execution) | 26 core memory services |
| **LLM** | Hardcoded DeepSeek/Moonshot | Pluggable (any OpenAI-compatible) |
| **Identity** | Solomon-specific capability card | Generic Katra card |
| **Ingestion** | OpenClaw-specific | Generic (any JSONL-producing platform) |
| **API key env var** | `ADMIN_API_KEY` | `KATRA_API_KEY` (or `MCP_API_KEY`) |
| **Database name** | `cognitive-memory` | `katra` |
| **Build** | `tsc` (needs lots of RAM) | `esbuild` (Pi-compatible) |

## Environment Variable Changes

| cognitive-memory-chat | Katra | Notes |
|---|---|---|
| `ADMIN_API_KEY` | `KATRA_API_KEY` | Renamed |
| `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | Same (legacy support) |
| — | `LLM_PROVIDERS` | New multi-provider config |
| — | `LLM_PROVIDER_*_API_KEY` | New per-provider keys |
| — | `EMBEDDING_PROVIDER` | New (default: `local`) |
| — | `PORT` / `MCP_PORT` | Separately configurable |

## Database Migration

### Option 1: Same MongoDB, New Database

Both systems can share the same MongoDB instance using different databases:

```bash
# cognitive-memory-chat uses: cognitive-memory
# Katra uses: katra

# Run migration script
python3 katra/scripts/migrate_from_cognitive_memory.py \
  --source "mongodb://admin:password@localhost:27017/cognitive-memory?authSource=admin" \
  --target "mongodb://admin:password@localhost:27017/katra?authSource=admin"
```

### Option 2: Dry Run First

```bash
python3 katra/scripts/migrate_from_cognitive_memory.py \
  --source "mongodb://..." \
  --target "mongodb://..." \
  --dry-run
```

This counts documents per collection without copying.

### Option 3: Specific Collections

```bash
python3 katra/scripts/migrate_from_cognitive_memory.py \
  --source "mongodb://..." \
  --target "mongodb://..." \
  --collections episodic_events,semantic_facts,knowledge_nodes
```

## Running Both Side-By-Side

You can run both systems simultaneously:

1. **Different ports**: cognitive-memory-chat on 9002/3100, Katra on 9012/3112
2. **Different databases**: `cognitive-memory` and `katra` in the same MongoDB
3. **Different Docker Compose files**: each with its own network

```bash
# cognitive-memory-chat
cd cognitive-memory-chat
docker compose up -d  # ports 9002, 3100

# Katra (different ports)
cd katra
# Edit docker-compose.yml: change ports to 9012:9002, 3112:3100
docker compose up -d
```

## Migration Checklist

1. [ ] Clone Katra: `git clone https://github.com/kolegadev/katra`
2. [ ] Copy `.env.example` to `.env`, configure API key and LLM
3. [ ] Start Katra: `docker compose up -d`
4. [ ] Verify health: `curl http://localhost:3100/health`
5. [ ] Run migration script (dry run first): `python3 scripts/migrate_from_cognitive_memory.py --source ... --target ... --dry-run`
6. [ ] Run actual migration: `python3 scripts/migrate_from_cognitive_memory.py --source ... --target ...`
7. [ ] Verify migrated data: `curl -X POST http://localhost:9002/api/v1/memory/episodic/search -H "Authorization: Bearer KEY" -H "Content-Type: application/json" -d '{"query":"test","user_id":"openclaw-main"}'`
8. [ ] Update agent MCP config to point at Katra
9. [ ] Deploy Katra watcher (if using auto-collection)
10. [ ] Verify agent can search memories through Katra
11. [ ] (Optional) Shut down cognitive-memory-chat

## What's Left Behind

These Solomon-specific services are NOT in Katra:
- Heartbeat service / scheduler
- Autonomous execution service (Full Auto mode)
- Skill runner
- Gitea service
- LUKS secret manager
- Inbox triage service
- Conversation service (chat interface)
- Response generation service
- Chain reasoning service
- LLM memory curator

If you need any of these, they remain in cognitive-memory-chat.
