# Katra — Cognitive Memory for AI Agents

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Give your AI agent **persistent memory**. Katra is a self-contained memory appliance —
drop it on any machine with Docker, point your agent at it via MCP, and get
episodic recall, semantic search, knowledge graphs, and temporal analysis.

Any MCP-compatible agent works: OpenClaw, Claude Code, OpenCode, Codex CLI, Kolega Code or
anything that speaks the Model Context Protocol.

## Quick Start

```bash
git clone https://github.com/kolegadev/katra.git
cd katra
cp .env.example .env
# Optional: edit .env to set custom API keys.
# If left blank, Katra generates secure keys on first boot and prints them.
docker-compose up -d --build
```

That's it. Katra is running:

| Service | URL | Purpose |
|---------|-----|---------|
| **MCP endpoint** | `http://localhost:3112/mcp` | Point your agent here |
| **Admin API** | `http://localhost:9012/api/v1/` | REST API, dashboard |
| **Dashboard** | `http://localhost:9012/dashboard/` | Web UI for stats + settings |
| **Health** | `http://localhost:3112/health` | Service health check |

Verify:
```bash
curl http://localhost:3112/health
# {"status":"ok","services":{"mongodb":"connected","redis":"connected"}}
```

## Connect Your Agent

Get your MCP API key:

- If you set `MCP_API_KEY` in `.env`, use that value.
- If you left it blank, Katra generated one on first boot. Run
  `docker logs katra-server` and look for the **Auto-generated API keys** block.

Add Katra to your agent's MCP config:

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

Your agent now has **29 MCP tools** — store memories, search by keyword or semantic
similarity, recall by time range, explore a knowledge graph, detect patterns, configure
LLM provider, and more.

### Platform-Specific Guides

| Platform | Config File | Notes |
|----------|-------------|-------|
| **OpenClaw** | `~/.openclaw/openclaw.json` | Native MCP support |
| **Claude Code** | `~/.claude/mcp.json` | Use `"type": "http"` |
| **Kolega Code** | `~/.claude/mcp.json` + lifecycle hooks | Dynamic memory injection on every prompt (see below) |
| **OpenCode** | OpenCode config | Use `"type": "remote"` |
| **Codex CLI** | `~/.codex/config.yaml` | Via webhook hooks |
| **Any MCP client** | — | Standard MCP over SSE |

> **Docker SSE tip:** If your agent runs inside Docker, use the Katra container's
> direct IP instead of `localhost`:
> ```bash
> docker inspect katra-server --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
> ```

### Kolega Code: Dynamic Memory Retrieval

Kolega Code can fetch relevant Katra memories **automatically on every user prompt**
using its lifecycle-hook system. This is more powerful than passive session-log
extraction because memories are injected into the live conversation context.

What you need:

1. Katra registered as an MCP server (so the bridge can call it).
2. The `kolega-katra-bridge` Python package installed into Kolega Code's environment.
3. A global `hooks.json` entry that fires the bridge on `UserPromptSubmit`.

Install the bridge:

```bash
cd integrations/kolega-code
uv pip install --python ~/.local/share/uv/tools/kolega-code/bin/python -e .
```

Configure the bridge (`~/Library/Application Support/kolega-code/katra-hook.json` on macOS):

```json
{
  "mcp_url": "http://localhost:3112/mcp",
  "api_key": "YOUR_MCP_API_KEY",
  "user_id": "kolega-agent",
  "sources": ["working_memory", "temporal_context", "vector_search", "temporal_recall"],
  "max_context_tokens": 2500,
  "timeout_seconds": 8
}
```

Enable the hook (`~/Library/Application Support/kolega-code/hooks.json`):

```json
{
  "schema_version": 1,
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "python",
            "callable": "kolega_katra_bridge.hook:on_user_prompt",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

On each prompt, Kolega Code now queries Katra's `working_memory`,
`get_temporal_context`, `vector_search`, and `temporal_recall` tools, then injects
the most relevant results as additional context for the model.

See `integrations/kolega-code/README.md` for full configuration options.

## LLM Configuration

Katra needs an LLM provider for semantic extraction, auto-journaling, entity
extraction, and summaries. **Three ways to configure — no `.env` editing required:**

1. **MCP tool** (agents self-configure): Call `configure_llm` with provider,
   API key, base URL, and model. Stored in MongoDB, applied live.
2. **Dashboard UI**: Settings → LLM Configuration → select provider, enter key.
3. **Environment variables**: Set in `.env` (fallback, read on startup only).

Supported providers: DeepSeek, OpenAI, Moonshot, Ollama, Custom (any OpenAI-compatible).

## Embeddings

Embeddings are **always local** — no API key, no external service, no cost.

- **Model:** `Xenova/all-MiniLM-L6-v2` (22M params, 384 dimensions, ~80MB)
- **Runtime:** Transformers.js (ONNX via WASM) — runs on CPU, including Raspberry Pi
- **Lazy load:** Downloads on first `store_memory` call, then caches in container
- **Docker:** Uses `node:20-slim` (Debian/glibc) — Alpine/musl does NOT work

## Identity Modes

Katra supports three memory sharing modes between agents:

| Mode | Behavior | Use Case |
|------|----------|----------|
| **Personal** (default) | Each agent's memories are isolated by `user_id` | Single agent, private memory |
| **Shared** | All agents with the same `shared_id` see everything | Multiple agents, communal consciousness |
| **Hybrid** | Personal + shared + visible other agents | Team of agents with private + shared memory |

**Configure via dashboard:** Open `http://localhost:9012/dashboard/` → Settings → Memory Scope

**Configure via MCP:**
```bash
# Switch to shared mode
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer YOUR_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"set_memory_scope","arguments":{"mode":"shared","shared_id":"my-team"}}}'
```

**Configure via admin API:**
```bash
curl -X PUT http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer YOUR_KATRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode":"hybrid","shared_id":"my-team","hybrid_visible_user_ids":["agent-a","agent-b"]}'
```

## Auto-Collection (Solomem Watchers)

Katra captures memories in real-time when your agent calls `store_memory` via MCP.
For **passive background collection** from conversation logs, use the watchers
included in this repo under `watcher/`:

```bash
# The watchers live in the Katra repo
mkdir -p ~/.solomem ~/.katra
cp watcher/katra_watcher.py ~/.solomem/memory_watcher.py
cp watcher/katra_opencode_extractor.py ~/.solomem/opencode_extractor.py
cp watcher/claude_history_extractor.py ~/.solomem/claude_history_extractor.py
cp watcher/kolega_code_extractor.py ~/.solomem/kolega_code_extractor.py
cp watcher/watcher-config.example.json ~/.solomem/watcher-config.json

# Edit ~/.solomem/watcher-config.json with your MCP_API_KEY and platforms

# Backfill existing history
python3 ~/.solomem/memory_watcher.py --once --config ~/.solomem/watcher-config.json

# Install as a systemd service for continuous collection
cp watcher/katra-watcher.service ~/.config/systemd/user/memory-watcher.service
systemctl --user daemon-reload
systemctl --user enable --now memory-watcher
```

### Dedicated extractors

Some platforms need a dedicated extractor because their session format is not plain JSONL:

| Platform | Extractor | Session source | What it captures |
|----------|-----------|----------------|------------------|
| **OpenCode** | `watcher/katra_opencode_extractor.py` | `~/.local/share/opencode/opencode.db` | User + assistant text turns |
| **Claude Code** | `watcher/claude_history_extractor.py` | `~/.claude/history.jsonl` | User prompts only (lightweight) |
| **Kolega Code** | `watcher/kolega_code_extractor.py` | `~/Library/Application Support/kolega-code/sessions/*.json` | Full turn-by-turn transcript (text, thinking, tool calls, tool results) |

Run a dedicated extractor once or continuously:

```bash
# Kolega Code example
python3 watcher/kolega_code_extractor.py --once \
  --api-key YOUR_MCP_API_KEY \
  --user-id kolega-agent
```

On macOS, use `launchctl` to keep extractors running (see `watcher/katra-watcher.service`
for a systemd template; adapt to a `~/Library/LaunchAgents/com.katra...plist`).

Supported platforms: OpenClaw, Claude Code, Kolega Code, OpenCode, Codex CLI, Hermes, KiloClaw, KimiClaw.
Each platform can have its own `user_id` for identity mode isolation.

## Features

- **Episodic Memory** — Every conversation message stored with dedup and cascade detection
- **Semantic Memory** — Distilled facts with confidence scores and vector embeddings
- **Knowledge Graph** — Auto-extracted entities and relationships
- **Working Memory** — Redis-backed short-term session state (<5ms access)
- **Temporal Recall** — Query by time range, detect recurring patterns
- **Vector Search** — Semantic similarity search (local embeddings, no API key needed)
- **11-Collection Search** — Comprehensive search across all memory stores, not just 1-2
- **Background Processing** — Auto-extracts facts, builds graph, generates summaries
- **29 MCP Tools** — Store, search, recall, explore, configure LLM — all via standardized protocol
- **Identity Modes** — Personal, shared, or hybrid memory across multiple agents
- **Dashboard** — Web UI for stats, memory scope, and system health
- **Portable Data** — Single `DATA_DIR` env var controls where all data lives
- **Local-First** — Runs on a Raspberry Pi with zero external API costs

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Katra Docker Appliance                 │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ MongoDB  │  │  Redis   │  │  MinIO   │  │  Katra  │ │
│  │ (memory) │  │ (cache)  │  │ (assets) │  │ (server)│ │
│  └──────────┘  └──────────┘  └──────────┘  └────┬────┘ │
│                                                 │       │
│  Internal Docker network (katra-net)    MCP :3112     │
│                                  Admin API :9012       │
└─────────────────────────────────────────────────────────┘
                    │                    │
         ┌──────────┘                    └──────────┐
         ▼                                          ▼
   Your Agent (MCP)                          Dashboard (web)
   OpenClaw / Claude /                       http://localhost:9012/dashboard/
   OpenCode / Codex / etc.
```

**Resource usage:** ~384MB RAM total (MongoDB 254MB, Katra 52MB, MinIO 73MB, Redis 5MB).
Runs comfortably on a Raspberry Pi 5 with 16GB RAM.

## Data Portability

All persistent data lives under one directory, controlled by `DATA_DIR` in `.env`:

```bash
# Default: ./data/ (relative to docker-compose.yml)
DATA_DIR=./data

# USB stick (LUKS-encrypted, mounted at /mnt/usb-secrets)
DATA_DIR=/mnt/usb-secrets/katra

# External drive
DATA_DIR=/media/external/katra
```

To move Katra to a new machine: copy the `DATA_DIR` directory, copy `.env`, run `docker-compose up -d`.

## What's Inside

```
katra/
├── server/                  TypeScript server (esbuild, Docker)
│   ├── src/
│   │   ├── mcp-server.ts    29 MCP tools (store, search, recall, graph, scope)
│   │   ├── services/        26 core memory services
│   │   ├── routes/          REST API + admin + ingestion + health
│   │   └── database/        MongoDB, Redis, indexes, migrations
│   └── esbuild.config.mjs   Pi-compatible build
├── dashboard/               Web dashboard (vanilla HTML/CSS/JS)
├── docker-compose.yml       MongoDB + Redis + MinIO + Katra
├── Dockerfile               Multi-stage (builds TS inside image)
├── .env.example             All config options documented
├── watcher/                 Passive session-log extractors (Solomem)
├── integrations/            Agent-specific dynamic-retrieval integrations
│   └── kolega-code/         Kolega Code lifecycle-hook bridge
├── SKILL.md                 Multi-platform deployment guide
└── docs/                    Full documentation
```

## MCP Tools (29)

### Storage
| Tool | Description |
|------|-------------|
| `store_memory` | Store a fact, preference, insight, or event |
| `store_journal` | Save a reflective journal entry |
| `working_memory` | Read/store/delete short-term session memory |
| `create_mission` | Create a goal with task breakdown |
| `update_mission_task` | Update task status (pending/in_progress/completed/blocked) |

### Recall
| Tool | Description |
|------|-------------|
| `search_memories` | Full-text + vector search across 11 collections |
| `vector_search` | Semantic similarity search |
| `temporal_recall` | Query events by time range |
| `temporal_search` | Search events by keyword with time context |
| `get_conversation_history` | Retrieve a specific session's messages |
| `get_temporal_context` | Current context: recent events + working memory + facts |
| `get_journal` | Read manual + auto journal entries |
| `get_auto_journal` | AI-distilled insights from conversations |
| `list_missions` | List active goals and progress |
| `get_mission` | Get full mission details with task tree |

### Analysis
| Tool | Description |
|------|-------------|
| `detect_patterns` | Recurring topics, session rhythm, dormant subjects |
| `get_time_block_summaries` | AI summaries by day/week/month |
| `summarize_time_blocks` | Generate new time-block summaries |
| `explore_graph` | Explore knowledge graph entities and relationships |

### Memory Scope
| Tool | Description |
|------|-------------|
| `get_memory_scope` | Get current mode (personal/shared/hybrid) |
| `set_memory_scope` | Set mode, shared_id, visible users |

### LLM Configuration
| Tool | Description |
|------|-------------|
| `get_llm_config` | Get current LLM provider config (key masked) |
| `configure_llm` | Set LLM provider, API key, base URL, model — applies live |

### System
| Tool | Description |
|------|-------------|
| `get_memory_diagnostics` | Document counts, embedding coverage, index health |
| `get_background_status` | Background processor queue and timing |
| `get_health` | MongoDB, Redis, LLM, embedding status |
| `get_heartbeat_status` | Heartbeat scheduler state |
| `get_transaction_log` | Audit trail of agent actions |
| `list_assets` | Files stored in MinIO |

## Configuration

All configuration is via `.env` (see `.env.example` for full docs):

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | Where all persistent data lives |
| `HOST_MCP_PORT` | `3112` | Host port for MCP endpoint |
| `HOST_API_PORT` | `9012` | Host port for admin API + dashboard |
| `MCP_API_KEY` | *(set in .env)* | Key your agent sends for MCP auth |
| `KATRA_API_KEY` | *(set in .env)* | Key for admin REST API |
| `LLM_PROVIDER` | *(via MCP/dashboard)* | Provider for semantic extraction (DeepSeek, OpenAI, Moonshot, Ollama) — configure via `configure_llm` MCP tool or dashboard |
| `EMBEDDING_PROVIDER` | `local` (always) | Local only — Xenova/all-MiniLM-L6-v2 via ONNX. No config needed. |
| `MULTI_TENANT` | `false` | Enable SaaS multi-tenant mode |

## Deployment

### Local Docker (default)

```bash
docker-compose up -d --build
```

### USB Storage

```bash
# In .env:
DATA_DIR=/mnt/usb-secrets/katra

docker-compose up -d
```

### Cloud (Terraform)

AWS Terraform module included in `terraform/aws/` — provisions VPC, ECS Fargate,
DocumentDB, ElastiCache Redis, S3, and ALB. See [Deployment Guide](docs/DEPLOYMENT.md).

### Kubernetes (Helm)

Helm chart included in `helm/katra/` — supports Bitnami MongoDB + Redis subcharts,
ingress with path routing, HPA, and PDB. See [Deployment Guide](docs/DEPLOYMENT.md).

## How It Compares

| Feature | Katra | Mem0 | Zep | Pinecone |
|---------|-------|------|-----|----------|
| MCP-native | ✅ | ❌ | ❌ | ❌ |
| Multi-layered memory | ✅ 5 layers | ❌ flat | Partial | ❌ vector only |
| Local-first (zero cost) | ✅ Pi-compatible | ❌ | ❌ | ❌ |
| Background processing | ✅ auto-extract | ❌ | Partial | ❌ |
| Multi-platform watcher | ✅ 7+ platforms (in-repo) | ❌ | ❌ | ❌ |
| Identity modes | ✅ personal/shared/hybrid | ❌ | ❌ | ❌ |
| Dashboard | ✅ built-in | ❌ | ❌ | ❌ |
| License | MIT | Apache 2.0 | MIT | Proprietary |

## Documentation

- [Quick Start Guide](docs/QUICKSTART.md) — 5-minute setup
- [Architecture](docs/ARCHITECTURE.md) — How it works under the hood
- [MCP Tools Reference](docs/MCP-TOOLS.md) — All 29 tools with examples
- [REST API Reference](docs/API-REFERENCE.md) — HTTP endpoints
- [Configuration Guide](docs/CONFIGURATION.md) — All environment variables
- [Deployment Guide](docs/DEPLOYMENT.md) — Docker, cloud, K8s
- [Migration Guide](docs/MIGRATION.md) — Migrate from cognitive-memory-chat
- [Multi-Platform Setup](SKILL.md) — Platform-specific agent configuration

## License

MIT — see [LICENSE](LICENSE).
