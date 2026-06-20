# Quick Start Guide

Get Katra running in 5 minutes.

## Prerequisites

- **Docker** and **Docker Compose** (v1 `docker-compose` or v2 `docker compose`)
- Any MCP-compatible agent (optional — you can test via curl)

## 1. Clone and Configure

```bash
git clone https://github.com/kolegadev/katra.git
cd katra
cp .env.example .env
```

Edit `.env` — set custom keys, or leave them blank to let Katra generate
secure keys on first boot. Generated keys are persisted in MongoDB and printed
in the server logs (`docker logs katra-server`).

```bash
# Optional: set your own keys
MCP_API_KEY=your-mcp-secret-key       # Your agent sends this
KATRA_API_KEY=your-admin-secret-key   # For REST API + dashboard
```

## 2. Start the Server

```bash
docker-compose up -d --build
```

This starts 4 containers: MongoDB, Redis, MinIO, and the Katra server.

## 3. Verify

```bash
# MCP health (no auth required)
curl http://localhost:3112/health

# Admin API health
curl -H "Authorization: Bearer your-admin-secret-key" \
  http://localhost:9012/api/v1/health
```

You should see `{"status":"ok",...}`.

Open the dashboard: **http://localhost:9012/dashboard/**

## 4. Store Your First Memory

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

## 5. Search Memories

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

## 6. Connect Your Agent

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

Restart your agent. It now has 29 memory tools available.

## 6. Configure the LLM Provider

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
then `docker-compose restart server`

> Configuring via MCP tool or dashboard stores the config in MongoDB and applies
> live — no restart needed. Env vars are a fallback, read on startup only.

## 7. Configure Identity Mode (Optional)

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

## 8. Deploy the Watcher (Optional)

For passive background collection from conversation logs, use the watchers
included in this repo under `watcher/`:

```bash
mkdir -p ~/.solomem ~/.katra
cp watcher/katra_watcher.py ~/.solomem/memory_watcher.py
cp watcher/katra_opencode_extractor.py ~/.solomem/opencode_extractor.py
cp watcher/claude_history_extractor.py ~/.solomem/claude_history_extractor.py
cp watcher/kolega_code_extractor.py ~/.solomem/kolega_code_extractor.py
cp watcher/watcher-config.example.json ~/.solomem/watcher-config.json

# Edit ~/.solomem/watcher-config.json with your api_key and platforms
# Default config already includes OpenClaw, Claude Code, OpenCode, Codex CLI,
# KiloClaw, KimiClaw, and Hermes paths.

# Backfill existing history
python3 ~/.solomem/memory_watcher.py --once --config ~/.solomem/watcher-config.json

# Install as a systemd service for continuous collection
mkdir -p ~/.config/systemd/user
cp watcher/katra-watcher.service ~/.config/systemd/user/memory-watcher.service
systemctl --user daemon-reload
systemctl --user enable --now memory-watcher
```

Some platforms need a dedicated extractor because their session format is not
plain JSONL:

| Platform | Command |
|----------|---------|
| **OpenCode** | `python3 ~/.solomem/opencode_extractor.py --once --api-key your-mcp-secret-key --user-id opencode-agent` |
| **Claude Code** | `python3 ~/.solomem/claude_history_extractor.py --once --api-key your-mcp-secret-key --user-id claude-agent` |
| **Kolega Code** | `python3 ~/.solomem/kolega_code_extractor.py --once --api-key your-mcp-secret-key --user-id kolega-agent` |

On macOS, use `launchctl` / `~/Library/LaunchAgents` instead of systemd (see
`watcher/katra-watcher.service` for a template; adapt to a `.plist`).

## Next Steps

- [MCP Tools Reference](MCP-TOOLS.md) — All 29 tools with examples
- [REST API Reference](API-REFERENCE.md) — HTTP endpoints
- [Configuration Guide](CONFIGURATION.md) — All environment variables
- [Deployment Guide](DEPLOYMENT.md) — Cloud, K8s, USB storage
- [SKILL.md](../SKILL.md) — Platform-specific agent setup
