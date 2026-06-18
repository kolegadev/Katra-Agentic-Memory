# Quick Start Guide

Get Katra running in 5 minutes.

## Prerequisites

- **Docker** and **Docker Compose** (for containerized deployment)
- **Python 3.11+** (for the watcher daemon, optional)
- Any MCP-compatible agent (OpenClaw, Claude Code, etc.) — optional for testing

## 1. Clone and Configure

```bash
git clone https://github.com/kolegadev/katra.git
cd katra
cp .env.example .env
```

Edit `.env` — set at minimum:

```bash
KATRA_API_KEY=your-secret-api-key
MONGODB_URI=mongodb://admin:yourpassword@mongo:27017/katra?authSource=admin
DEEPSEEK_API_KEY=sk-your-deepseek-key     # Or remove to use local-only mode
```

## 2. Start the Server

```bash
docker compose up -d
```

This starts MongoDB, Redis, MinIO, and the Katra server.

## 3. Verify

```bash
# Health check
curl http://localhost:9002/api/v1/health

# MCP health
curl http://localhost:3100/health
```

You should see `{"status":"ok",...}`.

## 4. Store Your First Memory

```bash
curl -X POST http://localhost:9002/api/v1/memory/episodic/events \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "my-agent",
    "session_id": "getting-started",
    "event_type": "user_message",
    "content": {
      "role": "user",
      "message": "Hello Katra! This is my first memory."
    }
  }'
```

## 5. Search Memories

```bash
curl -X POST http://localhost:9002/api/v1/memory/episodic/search \
  -H "Authorization: Bearer your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "first memory",
    "user_id": "my-agent"
  }'
```

## 6. Connect an Agent (MCP)

Add to your agent's MCP config:

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3100/mcp",
        "transport": "sse",
        "headers": {
          "Authorization": "Bearer your-secret-api-key",
          "Accept": "application/json, text/event-stream"
        }
      }
    }
  }
}
```

Restart your agent. It now has 25 memory tools available natively.

## 7. Deploy the Watcher (Optional)

Auto-ingest conversation logs from any supported platform:

```bash
mkdir -p ~/.katra
cp watcher/katra_watcher.py ~/.katra/
cp watcher/watcher-config.example.json ~/.katra/watcher-config.json
# Edit watcher-config.json with your API key and platform paths

# Backfill existing history
python3 ~/.katra/katra_watcher.py --once --config ~/.katra/watcher-config.json

# Install as systemd service for continuous collection
cp watcher/katra-watcher.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now katra-watcher
```

## Next Steps

- [MCP Tools Reference](MCP-TOOLS.md) — All 25 tools with examples
- [REST API Reference](API-REFERENCE.md) — HTTP endpoints
- [Configuration Guide](CONFIGURATION.md) — All environment variables
- [Deployment Guide](DEPLOYMENT.md) — Production deployment
- [SKILL.md](../SKILL.md) — Multi-platform setup guide
