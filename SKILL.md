# Katra — Multi-Platform Memory Collection

A persistent, searchable memory system that gives AI agents continuity across sessions.
Katra captures every conversation, processes it, and makes it queryable via natural language —
turning stateless agents into agents with memory.

**One memory server. One watcher daemon. Any platform.**

---

## Universal Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Katra MCP Server                            │
│                   (MongoDB + Redis + LLM embeddings)               │
└──────────────────────────────────────────────────────────────────┘
        ▲           ▲           ▲           ▲           ▲
        │           │           │           │           │
   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
   │OpenClaw│ │ Claude │ │OpenCode│ │ Codex  │ │ Hermes │
   │JSONL   │ │  Code  │ │SQLite  │ │  CLI   │ │ Kilo/  │
   │files   │ │ JSONL  │ │ +JSONL │ │ Files  │ │ Kimi   │
   └────────┘ └────────┘ └────────┘ └────────┘ └────────┘
        │           │           │           │           │
        └───────────┴───────────┴─────┬─────┴───────────┘
                                      │
                           katra_watcher.py
                           (multi-platform daemon)
```

---

## Platform Quick Reference

| Platform | Session Directory | File Format | Auto-Collection | MCP Native |
|---|---|---|---|---|
| **OpenClaw** | `~/.openclaw/agents/*/sessions/` | `.jsonl` | File watcher | Yes |
| **Claude Code** | `~/.claude/projects/*/` | `.jsonl` | File watcher | Yes |
| **OpenCode** | `~/.local/share/opencode/` | SQLite + `.jsonl` | Extractor + watcher | Via config |
| **Codex CLI** | `~/.codex/sessions/` | `.jsonl` | File watcher | Via config |
| **KiloClaw** | `~/.kiloclaw/agents/*/sessions/` | `.jsonl` | File watcher | Yes |
| **KimiClaw** | `~/.kimiclaw/agents/*/sessions/` | `.jsonl` | File watcher | Yes |
| **Hermes** | `~/.hermes/sessions/` | `.jsonl` | File watcher | Via config |
| **Any JSONL** | configurable | `.jsonl` | File watcher | Via MCP/REST |

---

## Installation

### 1. Start the Katra Server

```bash
git clone https://github.com/kolegadev/katra
cd katra
cp .env.example .env  # Edit with your settings
docker compose up -d
```

Verify: `curl http://localhost:3100/health`

### 2. Deploy the Multi-Platform Watcher

```bash
mkdir -p ~/.katra
cp watcher/katra_watcher.py ~/.katra/
cp watcher/katra_opencode_extractor.py ~/.katra/
cp watcher/watcher-config.example.json ~/.katra/watcher-config.json
chmod +x ~/.katra/katra_watcher.py ~/.katra/katra_opencode_extractor.py
```

Edit `~/.katra/watcher-config.json` — set your `mcp_url`, `api_key`, and enable the platforms you use.

### 3. Install Systemd Service

```bash
cp watcher/katra-watcher.service ~/.config/systemd/user/
# Edit the service file to set your KATRA_API_KEY
systemctl --user daemon-reload
systemctl --user enable katra-watcher
systemctl --user start katra-watcher
```

### 4. Backfill Existing History

```bash
python3 ~/.katra/katra_watcher.py --once --config ~/.katra/watcher-config.json
```

---

## Platform-Specific Setup

### OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3100/mcp",
        "transport": "sse",
        "headers": {
          "Authorization": "Bearer your-katra-api-key",
          "Accept": "application/json, text/event-stream"
        }
      }
    }
  }
}
```

Restart: `openclaw gateway restart`

**Tip**: If running Katra in Docker, use the container's direct IP instead of `localhost` (Docker's port proxy can break SSE). Find it with:
```bash
docker inspect katra-server --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

### Claude Code

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "katra": {
      "type": "http",
      "url": "http://localhost:3100/mcp",
      "headers": {
        "Authorization": "Bearer your-katra-api-key"
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
      "url": "http://localhost:3100/mcp",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer your-katra-api-key",
        "Accept": "application/json, text/event-stream"
      }
    }
  }
}
```

For OpenCode's SQLite-based sessions, also run the extractor:
```bash
python3 ~/.katra/katra_opencode_extractor.py --once
```

Or install it as a separate systemd service.

### Codex CLI (OpenAI)

Add to `~/.codex/config.yaml`:

```yaml
hooks:
  post_turn:
    - command: |
        curl -X POST http://localhost:3100/mcp \
          -H "Authorization: Bearer your-katra-api-key" \
          -H "Content-Type: application/json" \
          -H "Accept: application/json, text/event-stream" \
          -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"store_memory","arguments":{"content":"<TURN_CONTENT>","category":"event"}}}'
```

### KiloClaw / KimiClaw

OpenClaw variants — same MCP config at `~/.kiloclaw/openclaw.json` or `~/.kimiclaw/openclaw.json`.

### Hermes

Add to `~/.hermes/hermes.json`:

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3100/mcp",
        "transport": "sse",
        "headers": {
          "Authorization": "Bearer your-katra-api-key"
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

If the platform supports MCP, point it at `http://localhost:3100/mcp` with Bearer auth.

---

## How Auto-Collection Works

### Passive Layer (File Watcher)

The `katra_watcher.py` daemon runs as a systemd service, scanning all configured platform directories every 30 seconds:

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

This provides real-time storage alongside the passive watcher.

### Background Processing

The Katra server's background processor automatically:
- Deduplicates events via content hashing
- Extracts semantic facts and entities
- Builds a knowledge graph from conversations
- Generates time-block summaries
- Detects temporal patterns

---

## MCP Tools Reference

### Storage
| Tool | Arguments | Description |
|---|---|---|
| `store_memory` | content, user_id?, category?, confidence? | Store a memory |
| `store_journal` | user_id, entry, source?, tags? | Save a journal entry |
| `working_memory` | session_id, action, content? | Read/store/delete short-term memory |

### Recall
| Tool | Arguments | Description |
|---|---|---|
| `search_memories` | query, user_id?, limit? | Full-text search |
| `vector_search` | query, user_id?, limit? | Semantic similarity search |
| `temporal_recall` | user_id, from?, to?, limit? | Recall by time window |
| `temporal_search` | user_id, query, limit? | Search by keywords with time context |
| `get_conversation_history` | session_id, limit? | Retrieve a specific session |
| `get_temporal_context` | user_id, session_id | Current active context summary |

### Analysis
| Tool | Arguments | Description |
|---|---|---|
| `detect_patterns` | user_id, lookback_weeks? | Recurring patterns across sessions |
| `get_time_block_summaries` | user_id, block_type?, from?, to? | Time-organized summaries |
| `summarize_time_blocks` | user_id, block_type?, lookback_days? | Generate time block summaries |
| `get_auto_journal` | user_id, since?, limit? | AI-generated daily digest |
| `get_journal` | user_id, source?, limit? | Manual + auto journal entries |

### Knowledge Graph
| Tool | Arguments | Description |
|---|---|---|
| `explore_graph` | query?, limit?, include_edges? | Explore entities and relationships |

### Missions
| Tool | Arguments | Description |
|---|---|---|
| `create_mission` | user_id, goal, title?, tasks? | Create task tracker |
| `list_missions` | user_id, limit? | List active missions |
| `get_mission` | user_id, mission_id | Get mission details |
| `update_mission_task` | user_id, mission_id, task_id, status | Update a task |

### System
| Tool | Description |
|---|---|
| `get_memory_diagnostics` | Storage stats, index health |
| `get_background_status` | Background processor state |
| `get_health` | Server health check |
| `get_heartbeat_status` | Heartbeat scheduler state |
| `list_assets` | Stored files and assets |
| `get_transaction_log` | Audit trail of agent actions |

---

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `KATRA_MCP_URL` | `http://localhost:3100/mcp` | Katra MCP server URL |
| `KATRA_API_KEY` | (required) | API key for MCP authentication |

### Watcher Config (`~/.katra/watcher-config.json`)

| Field | Description |
|---|---|
| `mcp_url` | Katra MCP server URL |
| `api_key` | API key for authentication |
| `default_user_id` | Default user ID for stored memories |
| `state_file` | Path to dedup state file |
| `platforms` | Array of platform configs |

Each platform entry:
- `name` — Platform identifier
- `session_dir` — Base directory containing session files
- `glob` — Glob pattern to find session files
- `exclude` — List of substrings that mark files to skip
- `user_id` — (optional) Per-platform user ID override

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| SSE error: other side closed | Docker proxy breaking SSE | Use direct container IP, not localhost |
| No data in recall | Background processor hasn't indexed | Wait one processing cycle (~30s) |
| Platform not collecting | Session dir path wrong | Verify paths in watcher-config.json |
| Agent not using MCP tools | MCP not configured | Check platform-specific MCP config |
| `store_memory` returns 0 | MCP auth failed | Verify KATRA_API_KEY is set correctly |
| OpenCode extractor fails | DB path wrong | Check `--db` flag or default path |

---

## File Reference

```
katra/watcher/
├── katra_watcher.py              — Multi-platform JSONL session ingestion daemon
├── katra_opencode_extractor.py   — OpenCode SQLite session extractor
├── katra-watcher.service         — Systemd unit for auto-start
└── watcher-config.example.json   — Multi-platform config template
```
