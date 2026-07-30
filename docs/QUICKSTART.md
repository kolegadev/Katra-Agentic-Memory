# Quick Start Guide

Get Katra running in 5 minutes.

## Prerequisites

- **Docker** and **Docker Compose v2** (`docker compose`)
- Any MCP-compatible agent (optional — you can test via curl)

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Katra-Agentic-Memory/main/install.sh | bash
```

That is the whole thing. It clones the source to `~/.katra/src`, generates a
`.env` with real credentials, builds and starts all four containers (MongoDB,
Redis, MinIO and the Katra server), waits for them to report healthy, and prints
the config snippet for connecting your agent — including the generated
`MCP_API_KEY`.

Add `--with-watcher` to ingest your existing agent session history, and
`--with-systemd` to start Katra on boot:

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Katra-Agentic-Memory/main/install.sh \
  | bash -s -- --with-watcher --with-systemd
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for every flag, and for the manual install if
you would rather do it by hand. Note that `MONGO_PASS`, `MINIO_USER` and
`MINIO_PASS` are **required** — compose refuses to start without them rather
than falling back to a known default — so a manual install means setting those
yourself. The installer generates them.

## 2. Verify

```bash
# Admin API health (no auth required)
curl http://localhost:9012/api/v1/health

# MCP health
curl http://localhost:3112/health
```

You should see `{"status":"ok",...}`.

Your generated keys are in `.env` (`MCP_API_KEY` for your agent, `KATRA_API_KEY`
for the admin API). To read one back:

```bash
grep '^MCP_API_KEY=' ~/.katra/src/.env
```

Open the dashboard: **http://localhost:9012/dashboard/**

## 3. Store Your First Memory

```bash
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer your-mcp-secret-key" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "test", "version": "1.0"}
    }
  }'
```

Grab the `mcp-session-id` from the response headers, then:

```bash
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer your-mcp-secret-key" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: SESSION_ID_FROM_STEP_1" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "store_memory",
      "arguments": {
        "content": "Hello Katra! This is my first memory.",
        "user_id": "my-agent",
        "category": "event"
      }
    }
  }'
```

## 4. Search Memories

```bash
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer your-mcp-secret-key" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "search_memories",
      "arguments": {
        "query": "first memory",
        "user_id": "my-agent"
      }
    }
  }'
```

## 5. Connect Your Agent

Add Katra to your agent's MCP config:

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3112/mcp",
        "transport": "sse",
        "headers": {
          "Authorization": "Bearer your-mcp-secret-key",
          "Accept": "application/json, text/event-stream"
        }
      }
    }
  }
}
```

Restart your agent. It now has 48 memory tools available.

## 6. Run the Test Suite

Katra includes a comprehensive test suite (87 tests, 9 files, 0 failures):

```bash
cd server
npm install
npm test                    # All unit + security tests (< 1s)
npm run test:unit           # Unit tests only (54 tests)
npm run test:security       # Security regression tests (18 tests)
npm run test:integration    # Integration tests (Docker stack required, 15 tests)
npm run test:coverage       # With coverage report
./tests/run-all.sh all      # Shell runner — same as npm test
```

Tests cover: API key hashing, memory scope filtering, prototype pollution prevention, user ID scoping, metadata sanitization, retry counter logic, route authentication, admin gating, and input validation.

## 7. Configure the LLM Provider

Katra needs an LLM provider for semantic extraction, auto-journaling, and summaries.
Configure it via MCP tool, dashboard, or env vars.

**Via MCP tool (from your agent):**

Call the `configure_llm` MCP tool:
```
configure_llm(
  provider: "deepseek",
  api_key: "sk-your-key-here",
  base_url: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash"
)
```

**Via dashboard:** Open `http://localhost:9012/dashboard/` → Settings → LLM Configuration

**Via .env:** Uncomment and fill in your provider's API key (e.g. `DEEPSEEK_API_KEY`),
then `docker compose restart server`

> Configuring via MCP tool or dashboard stores the config in MongoDB and applies
> live — no restart needed. Env vars are a fallback, read on startup only.

## 8. Configure Memory Scope (Optional)

By default, each agent's memories are isolated (personal mode). To enable shared
or hybrid memory across multiple agents:

**Via dashboard:** http://localhost:9012/dashboard/ → Settings → Memory Scope

**Via admin API:**
```bash
curl -X PUT http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer your-admin-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "shared",
    "shared_id": "my-team"
  }'
```

## 9. Deploy the Watcher (Optional)

For passive background collection from conversation logs, use the watchers
included in this repo under `watcher/`. The installer does the whole thing —
copying the extractors, writing the config with your MCP URL and API key filled
in, backfilling existing history, and installing the scheduler (a systemd user
unit on Linux, a launchd agent on macOS):

```bash
~/.katra/src/install.sh --with-watcher
```

The default config already covers OpenClaw, Claude Code, OpenCode, Codex CLI,
KiloClaw, KimiClaw and Hermes paths.

For the manual equivalent — including how to render the unit templates, which
must have their placeholders substituted rather than being copied as-is — see
[DEPLOYMENT.md → Watcher Deployment](DEPLOYMENT.md#watcher-deployment).

Some platforms need a dedicated extractor because their session format is not
plain JSONL:

| Platform | Command |
|----------|---------|
| **OpenCode** | `python3 ~/.katra/katra_opencode_extractor.py --once --api-key your-mcp-secret-key --user-id opencode-agent` |
| **Claude Code** | `python3 ~/.katra/claude_history_extractor.py --once --api-key your-mcp-secret-key --user-id claude-agent` |
| **Kolega Code** | `python3 ~/.katra/kolega_code_extractor.py --once --api-key your-mcp-secret-key --user-id kolega-agent` |

On macOS the installer uses launchd instead of systemd. A ready-made agent
template ships at `watcher/com.katra.watcher.plist.template` — there is no
longer anything to hand-write.

## Next Steps

- [MCP Tools Reference](MCP-TOOLS.md) — All 48 tools with examples
- [REST API Reference](API-REFERENCE.md) — HTTP endpoints
- [Security Policy](SECURITY.md) — Security architecture and vulnerability reporting
- [Configuration Guide](CONFIGURATION.md) — All environment variables
- [Deployment Guide](DEPLOYMENT.md) — Cloud, K8s, Raspberry Pi
- [OpenClaw Integration Guide](OPENCLAW-INTEGRATION.md) — Complete OpenClaw setup with lessons learned
- [Sleep Consolidation](SLEEP-CONSOLIDATION.md) — Reflective memory distillation
- [Data Processing Pipelines](Data-Processing-Pipelines.md) — Full pipeline architecture
- [SKILL.md](../SKILL.md) — Platform-specific agent setup
