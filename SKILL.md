# Katra — Multi-Platform Memory Collection

A persistent, searchable memory system that gives AI agents continuity across sessions.
Katra captures every conversation, processes it, and makes it queryable via natural language —
turning stateless agents into agents with memory.

**One memory server. One watcher daemon. Any platform.**

---

## Universal Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Katra Docker Appliance                         │
│            (MongoDB + Redis + MinIO + MCP Server)                  │
│                    Internal network only                           │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ MCP :3112
                               │ Admin API :9012
        ┌──────────┬───────────┼───────────┬──────────┬───────────┐
        │          │           │           │          │           │
   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
   │OpenClaw│ │ Claude │ │ Kolega │ │OpenCode│ │ Codex  │ │ Hermes │
   │JSONL   │ │  Code  │ │ Code  │ │SQLite  │ │  CLI   │ │ Kilo/  │
   │files   │ │  JSONL │ │ JSON  │ │+JSONL  │ │ Files  │ │ Kimi   │
   └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘
        │           │           │           │           │          │
        └───────────┴───────────┴─────┬─────┴───────────┴──────────┘
                                      │
                           solomem watcher daemon
                           (multi-platform ingestion)
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        │                             │                             │
   katra_watcher.py            dedicated extractors          launchd/systemd
   (JSONL platforms)     (OpenCode, Kolega Code, Claude history)
```

---

## Platform Quick Reference

| Platform | Session Directory | Format | Auto-Collection | MCP Native |
|----------|-------------------|--------|-----------------|------------|
| **OpenClaw** | `~/.openclaw/agents/*/sessions/` | `.jsonl` | File watcher | Yes |
| **Claude Code** | `~/.claude/projects/*/` | `.jsonl` | File watcher | Yes |
| **Kolega Code** | `~/Library/Application Support/kolega-code/sessions/` | `.json` | Dedicated extractor | Via config |
| **OpenCode** | `~/.local/share/opencode/` | SQLite + `.jsonl` | Dedicated extractor | Via config |
| **Codex CLI** | `~/.codex/sessions/` | `.jsonl` | File watcher | Via config |
| **KiloClaw** | `~/.kiloclaw/agents/*/sessions/` | `.jsonl` | File watcher | Yes |
| **KimiClaw** | `~/.kimiclaw/agents/*/sessions/` | `.jsonl` | File watcher | Yes |
| **Hermes** | `~/.hermes/sessions/` | `.jsonl` | File watcher | Via config |
| **Any JSONL** | configurable | `.jsonl` | File watcher | Via MCP/REST |

---

## Installation

### 1. Start the Katra Server

```bash
git clone https://github.com/kolegadev/katra.git
cd katra
cp .env.example .env  # Optional: set custom API keys; leave blank for auto-generation
docker-compose up -d --build
```

**What happens during first startup:**
- MongoDB, Redis, MinIO, and Katra server containers start
- The Docker image uses `node:20-slim` (Debian-based) — required for the
  ONNX runtime that powers local embeddings. Alpine/musl does NOT work.
- If `MCP_API_KEY` / `KATRA_API_KEY` are not set in `.env`, Katra generates
  secure random keys, persists them in MongoDB, and prints them in the logs.
- The embedding model (`Xenova/all-MiniLM-L6-v2`, ~80MB) downloads
  automatically on first memory storage and caches in the container.
- No external embedding API key needed — embeddings are 100% local.

Verify: `curl http://localhost:3112/health`

Find your generated keys: `docker logs katra-server | grep -A2 "Auto-generated API keys"`

Dashboard: `http://localhost:9012/dashboard/`

### 2. Configure the LLM Provider

The LLM powers semantic extraction, auto-journaling, entity extraction, and summaries.
**Katra needs an LLM provider to enable its intelligence features.**

Choose ONE of these methods:

**Method A — Agent self-configures via MCP (recommended for coding agents):**

An OpenClaw agent, Claude Code, or any MCP client can call the `configure_llm` tool:

```bash
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer YOUR_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "setup", "version": "1.0"}}
  }'
# Grab mcp-session-id from response headers, then:

curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer YOUR_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: SESSION_ID" \
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": {"name": "configure_llm", "arguments": {
      "provider": "deepseek",
      "api_key": "sk-your-key-here",
      "base_url": "https://api.deepseek.com/v1",
      "model": "deepseek-v4-flash"
    }}
  }'
```

Or from within an agent that has MCP tools: call `configure_llm` directly.

**Method B — Dashboard UI:**

Open `http://localhost:9012/dashboard/` → Settings → LLM Configuration.
Select provider, enter API key, click Save & Apply.

**Method C — Environment variables in `.env`:**

```bash
# Uncomment and fill in your provider:
DEEPSEEK_API_KEY=sk-your-key-here
# OPENAI_API_KEY=sk-your-key-here
# MOONSHOT_API_KEY=sk-your-key-here
```

Then restart: `docker-compose restart server`

**Supported providers:** DeepSeek, OpenAI, Moonshot, Ollama (local), Custom (any OpenAI-compatible API).

> **Note:** Configuring via MCP tool or dashboard (methods A/B) stores the config
> in MongoDB and applies live — no restart needed. Env vars are only read on startup
> as a fallback. DB config overrides env vars.

### 3. Deploy the Solomem Watchers

The watchers live in the Katra repo under `watcher/`. Copy them to `~/.solomem`
(or any directory you prefer):

```bash
mkdir -p ~/.solomem ~/.katra
cp watcher/katra_watcher.py ~/.solomem/memory_watcher.py
cp watcher/katra_opencode_extractor.py ~/.solomem/opencode_extractor.py
cp watcher/claude_history_extractor.py ~/.solomem/claude_history_extractor.py
cp watcher/kolega_code_extractor.py ~/.solomem/kolega_code_extractor.py
cp watcher/watcher-config.example.json ~/.solomem/watcher-config.json
chmod +x ~/.solomem/*.py
```

Edit `~/.solomem/watcher-config.json` with your `api_key` and platforms:

```json
{
  "mcp_url": "http://localhost:3112/mcp",
  "api_key": "YOUR_MCP_API_KEY",
  "user_id": "my-agent",
  "shared_id": "",
  "platforms": [
    {
      "name": "openclaw",
      "session_dir": "~/.openclaw/agents",
      "glob": "**/sessions/*.jsonl",
      "exclude": ["trajectory"],
      "user_id": "openclaw-agent"
    },
    {
      "name": "claude",
      "session_dir": "~/.claude/projects",
      "glob": "**/*.jsonl",
      "exclude": ["history"],
      "user_id": "claude-agent"
    }
  ]
}
```

### 4. Install Background Service

**Linux (systemd):**

```bash
cp watcher/katra-watcher.service ~/.config/systemd/user/memory-watcher.service
systemctl --user daemon-reload
systemctl --user enable memory-watcher
systemctl --user start memory-watcher
```

**macOS (launchd):**

Create `~/Library/LaunchAgents/com.katra.memory-watcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.katra.memory-watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>python3</string>
        <string>/Users/YOUR_USERNAME/.solomem/memory_watcher.py</string>
        <string>--config</string>
        <string>/Users/YOUR_USERNAME/.solomem/watcher-config.json</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.katra/memory-watcher.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.katra/memory-watcher.log</string>
</dict>
</plist>
```

Then load it:

```bash
launchctl load -w ~/Library/LaunchAgents/com.katra.memory-watcher.plist
```

### 5. Backfill Existing History

```bash
python3 ~/.solomem/memory_watcher.py --once --config ~/.solomem/watcher-config.json
```

### 6. Run Dedicated Extractors (if needed)

Some platforms need a dedicated extractor because their session format is not plain JSONL:

| Platform | Command |
|----------|---------|
| **OpenCode** | `python3 ~/.solomem/opencode_extractor.py --once --api-key YOUR_MCP_API_KEY --user-id opencode-agent` |
| **Claude Code** | `python3 ~/.solomem/claude_history_extractor.py --once --api-key YOUR_MCP_API_KEY --user-id claude-agent` |
| **Kolega Code** | `python3 ~/.solomem/kolega_code_extractor.py --once --api-key YOUR_MCP_API_KEY --user-id kolega-agent` |

For continuous collection, wrap the dedicated extractor in its own launchd/systemd service.

---

## How Embeddings Work

Katra uses **local embeddings** — no API key, no external service, no cost.

- **Model:** `Xenova/all-MiniLM-L6-v2` (22M params, 384 dimensions, ~80MB)
- **Runtime:** Transformers.js (ONNX via WASM) — runs on CPU, including Raspberry Pi
- **Lazy load:** Downloads on first `store_memory` call, then caches in container memory
- **Docker requirement:** `node:20-slim` (Debian/glibc). Alpine/musl does NOT work
  because the ONNX runtime binary requires glibc.

Vector/semantic search works out of the box. Keyword search (`$text` + regex) works
even if embeddings fail to load (graceful degradation).

---

## Identity Modes

Katra supports three memory sharing modes. The watcher always sends `user_id` and
optionally `shared_id` — the server decides what to use based on its scope mode.

| Mode | Behavior | shared_id | Use Case |
|------|----------|-----------|----------|
| **personal** (default) | Isolated by `user_id` | Ignored | Single agent, private memory |
| **shared** | Communal via `shared_id` | Stored | Multiple agents, shared consciousness |
| **hybrid** | Personal + shared + visible others | Stored | Team of agents with private + shared |

**Configure via dashboard:** Settings → Memory Scope

**Configure via MCP:**
```bash
# Set to shared mode
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer YOUR_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"set_memory_scope","arguments":{"mode":"shared","shared_id":"my-team"}}}'
```

### How user_id is Resolved (priority order)

1. CLI flag: `--user-id my-agent`
2. Config file (per-platform): `"user_id": "openclaw-agent"`
3. Config file (global): `"user_id": "my-agent"`
4. Environment variable: `SOLOMEM_USER_ID`
5. Default: `<hostname>-agent`

### How shared_id is Resolved

1. CLI flag: `--shared-id my-team`
2. Config file (per-platform or global)
3. Environment variable: `SOLOMEM_SHARED_ID`
4. Default: empty (personal mode)

---

## Platform-Specific MCP Setup

### OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3112/mcp",
        "transport": "sse",
        "headers": {
          "Authorization": "Bearer YOUR_MCP_API_KEY",
          "Accept": "application/json, text/event-stream"
        }
      }
    }
  }
}
```

Restart: `openclaw gateway restart`

> **Docker SSE tip:** If your agent runs inside Docker, use the Katra container's
> direct IP instead of `localhost`:
> ```bash
> docker inspect katra-server --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
> ```

### Claude Code

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "katra": {
      "type": "http",
      "url": "http://localhost:3112/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

### OpenCode

Add to your OpenCode config:

```json
{
  "mcpServers": {
    "katra": {
      "type": "remote",
      "url": "http://localhost:3112/mcp",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY",
        "Accept": "application/json, text/event-stream"
      }
    }
  }
}
```

For OpenCode's SQLite sessions, also run the extractor:
```bash
python3 ~/.solomem/opencode_extractor.py --once \
  --mcp-url http://localhost:3112/mcp \
  --api-key YOUR_MCP_API_KEY \
  --user-id opencode-agent
```

### Codex CLI (OpenAI)

Add to `~/.codex/config.yaml`:

```yaml
hooks:
  post_turn:
    - command: |
        curl -X POST http://localhost:3112/mcp \
          -H "Authorization: Bearer YOUR_MCP_API_KEY" \
          -H "Content-Type: application/json" \
          -H "Accept: application/json, text/event-stream" \
          -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"store_memory","arguments":{"content":"<TURN_CONTENT>","category":"event"}}}'
```

### KiloClaw / KimiClaw

OpenClaw variants — same MCP config at `~/.kiloclaw/openclaw.json` or `~/.kimclaw/openclaw.json`.

### Hermes

Add to `~/.hermes/hermes.json`:

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3112/mcp",
        "transport": "sse",
        "headers": {
          "Authorization": "Bearer YOUR_MCP_API_KEY"
        }
      }
    }
  }
}
```

### Any Other Platform

If the platform writes JSONL session logs, add an entry to `watcher-config.json`:

```json
{
  "name": "custom-platform",
  "session_dir": "~/.myplatform/sessions",
  "glob": "**/*.jsonl",
  "exclude": [],
  "user_id": "my-platform-user"
}
```

If the platform supports MCP, point it at `http://localhost:3112/mcp` with Bearer auth.

---

## How Auto-Collection Works

### Passive Layer (File Watcher)

The `memory_watcher.py` daemon runs as a systemd service, scanning all configured
platform directories every 30 seconds:

1. Finds new or modified `.jsonl` session files
2. Parses user/assistant messages from JSONL format
3. Initializes an MCP session with the Katra server
4. Calls `store_memory` for each session, batching all turns into one document
5. Tracks processed files via a state file to avoid duplicates

### Active Layer (Agent Instructions)

Add to your project's `AGENTS.md` or system prompt:

```markdown
## Active Memory System

After EVERY response, call the `store_memory` MCP tool with:
- The user's message and your full response as content
- A 1-sentence summary
- Relevant tags/topics

Available recall tools: search_memories, temporal_recall, get_conversation_history,
vector_search, working_memory, get_auto_journal, detect_patterns
```

### Background Processing

The Katra server's background processor automatically:
- Deduplicates events via content hashing
- Extracts semantic facts and entities (requires LLM)
- Builds a knowledge graph from conversations (requires LLM)
- Generates time-block summaries (requires LLM)
- Detects temporal patterns (requires LLM)

> Without an LLM configured, storage and search still work. The intelligence
> features (extraction, journaling, summaries) are disabled until you configure
> a provider.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| SSE error: other side closed | Docker proxy breaking SSE | Use direct container IP, not localhost |
| No data in recall | Background processor hasn't indexed | Wait one processing cycle (~30s) |
| Platform not collecting | Session dir path wrong | Verify paths in watcher-config.json |
| Agent not using MCP tools | MCP not configured | Check platform-specific MCP config |
| `store_memory` returns 0 | MCP auth failed | Verify MCP_API_KEY is set correctly |
| OpenCode extractor fails | DB path wrong | Check `--db` flag or default path |
| shared_id not stored | Server in personal mode | Switch to shared/hybrid mode first |
| Embeddings 🔴 in health | Model not loaded yet | Call `store_memory` once to trigger download |
| Embeddings 🔴 after rebuild | Container recreated, cache lost | Call `store_memory` once to re-download |
| LLM 🔴 in health | No LLM configured | Call `configure_llm` MCP tool or use dashboard |
| LLM 🔴 but key is set | Validation failed (bad key?) | Call `get_llm_config` MCP tool to check status |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_URL` | `http://localhost:3112/mcp` | Katra MCP server URL |
| `MCP_API_KEY` | *(required)* | MCP authentication key |
| `SOLOMEM_USER_ID` | `<hostname>-agent` | Default user_id for memories |
| `SOLOMEM_SHARED_ID` | *(empty)* | Shared ID for communal memory |
