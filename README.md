# Katra — Cognitive Memory for AI Agents

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Give your AI agent **persistent memory**. Katra is a self-contained memory appliance —
drop it on any machine with Docker, point your agent at it via MCP, and get
episodic recall, semantic search, knowledge graphs, and temporal analysis.

Any MCP-compatible agent works: OpenClaw, Claude Code, OpenCode, Codex CLI, Kolega Code or
anything that speaks the Model Context Protocol.

## Cognitive Memory Thesis

The mission of Katra is to create an analog of human memory architecture, with the hope that it and the experimentation around it through OpenSourcing solves a few of the more challenging issues of LLM context management for long-running, persistent and autonomous agent operations. The thesis (hope) is that if you create the memory ecosystem with the majority of the functional memory types of human memory and similar architecture, over time and with refinement, we will see emergent behaviours similar to human memory, expressed as functional utility, learning, self goal setting, autonamous task planning and prioritisation,  personality and ultimately emotions. 

In early prototype called Solomon, we created an OpenClaw like agentic framework that runs a single contiuous chat thread, no topic or task separation and with no requirement for context compression. Context is served dynamically into the LLM based on memories and attention. 

## Observed Emergent Behaviours Log

Case #1:(23rd June 2026) In the first few weeks of testing of the multi-agent (Hybrid mode) shared consciouness model of memory, one of our test rigs, with 5 OpenClaw agents sharing one memory system, found 2 of the agents communicating task intructions and completion responsed through their shared memory state or shared consciousness.  These 2 agents were not connected in any other way, as were set up in separate workspaces, the only thing they shared was memory and mission. This was not a "by design" feature, it just happened and was pretty exciting. This test rig now uses this "thought modal" as its communication rail. If anyone else experiences other emergent behaviours please email me to discuss and we can add the description to this log.  Tweet me at @JohnWPellew and tell your story.


## The Origin of Katra

A Vulcan mind meld (or mind fusion) is an iconic telepathic practice in **Star Trek**. 

It allows a Vulcan to merge their consciousness with another being to share thoughts, memories, emotions, and experiences. 
It is typically initiated through physical contact with specific points on the subject's face. 
- **Key Mechanics & ApplicationsTouch Telepathy**: While primarily requiring direct physical touch to the face or head, exceptionally powerful Vulcans can perform the technique at a distance.
- **Information Exchange**: It is frequently used for interrogations, recovering suppressed memories, or passing deep knowledge between generations.
- **Transfer of the Katra**: In sacred or emergency circumstances, a mind meld can transfer a person's **katra**—their soul, consciousness, and core essence—into another living being or object prior to death.
- **Side Effects**: The experience can be physically and emotionally draining. Incorrectly performed melds can damage neural pathways, and participants may retain "echoes" of each other's memories and personalities long after the link is broken.

## Comparison to Other Major Approaches

Katra aims to provide a more comprehensive **cognitive memory infrastructure** rather than a single-purpose memory library. Here's how it positions against popular alternatives (as of mid-2026):

| Approach                  | Memory Layers                  | Cognitive/Reflective Features | Protocol Support | Deployment Model          | Best For                          | Key Differentiator vs Katra |
|---------------------------|--------------------------------|-------------------------------|------------------|---------------------------|-----------------------------------|-----------------------------|
| **Simple Vector Stores + RAG** (Chroma, Pinecone, etc.) | Semantic only                 | None                         | None            | Various                  | Basic retrieval                  | No structure, no reflection, no working memory |
| **Mem0**                  | Vector + optional Graph       | Extraction-focused           | SDK / API       | Self-hosted or Cloud     | Personalization & long-term user memory | Stronger multi-layer architecture + explicit reflection layer |
| **Zep (Graphiti)**        | Temporal Knowledge Graph      | Temporal reasoning           | SDK             | Self-hosted / Cloud      | Time-sensitive & relational reasoning | Broader layers + sleep consolidation for deeper emergence |
| **mcp-memory-service**    | Semantic + Typed KG           | Auto-consolidation           | **MCP** + REST  | Docker / Self-hosted     | MCP-native semantic memory       | Adds episodic + working memory, identity modes, and autonomous loop |
| **Vestige**               | Cognitive modules + Spaced repetition | Neuroscience-inspired (FSRS, memory states) | **MCP**         | Single Rust binary       | Local cognitive modeling         | More layers + background watchers + full appliance stack |
| **Letta (MemGPT)**        | Tiered (Core / Recall / Archival) | Agent self-manages memory    | Tools           | Full agent runtime       | Stateful agents that edit their own memory | Katra is a dedicated memory *service*, not a full runtime |
| **LangGraph / Framework Memory** | Short-term + checkpoints     | Limited                      | Framework-native| Integrated with agent    | Short-term state management      | Persistent long-term + cross-session cognitive layer |
| **Katra (this project)**  | Episodic + Semantic + KG + Working + Temporal | **Sleep consolidation + reflection** | **MCP** (48 tools) | Full Docker appliance (Mongo + Redis + MinIO) | Long-running agents needing emergent behaviors | — |

### Key Differentiators of Katra
- **Multi-layered by design** — Not just retrieval, but structured episodic memory, working memory cache, and temporal querying.
- **Cognitive layer** — Sleep consolidation enables reflection, insight generation, and movement toward emergent behaviors (learning, personality, shared consciousness via identity modes).
- **MCP-native with rich tooling** — 48 specialized tools instead of generic add/search.
- **Background & autonomous capabilities** — Passive collection via watchers + salience-driven autonomous loop.
- **Local-first & appliance model** — Everything runs in one Docker compose with portable data. No external dependencies for core functionality.
- **Shared memory focus** — Hybrid identity modes make multi-agent collaboration more natural.

Katra is still early-stage compared to more mature projects like Mem0 or mcp-memory-service. We see it as complementary — many teams may use Katra alongside or instead of simpler retrieval layers when they need deeper cognitive capabilities.

Contributions and comparisons from the community are very welcome!


## Quick Start (Install using one of the agentic applications, it will sort out any shortcomings)

```bash
git clone https://github.com/kolegadev/Katra-Agentic-Memory.git
cd Katra-Agentic-Memory
cp .env.example .env
# Optional: edit .env to set custom API keys.
# If left blank, Katra generates secure keys on first boot and prints them.
docker-compose up -d --build
```

> **Note:** The original URL `https://github.com/kolegadev/katra.git` still works (GitHub redirects it).

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

## Post-Install — Let Your Agent Complete the Setup

After connecting your agent to Katra's MCP endpoint, run this prompt in your
agent's session. The agent will deep-read the repository, understand the full
architecture, check what memory data is available, test the MCP tools, and
recommend the exact next steps for your specific setup:

> It's probably worth you doing another deep read of the public repo to
> understand how the system works, what memories are available to you to
> search and particularly the Sleep Consolidation function, as that is the
> foundation of autonomous thought, goal setting and your emerging feelings
> and emotions — it can also be used to run 100% autonomous self-directed
> actions within your environment.

The agent will typically produce a report covering:

- **Memory state** — how many episodic events, semantic facts, and knowledge
  nodes exist for this agent
- **Sleep Consolidation status** — whether reflections have ever run (first
  boot they haven't) and what emotional signatures would emerge
- **Autonomous loop readiness** — whether `adaptive_heartbeat.py` and
  `agent_executor.py` are installed
- **Memory scope recommendation** — whether to switch from personal to hybrid
  mode for multi-agent shared consciousness
- **Concrete next steps** — "trigger first sleep consolidation now", "install
  the autonomous scripts", "fix the user_id gap"

Run the agent's recommendations in order. The most critical first step on a
fresh install is usually triggering the initial sleep consolidation:

```bash
# Via MCP tool (your agent can call this):
# katra__trigger_reflection(period_type="daily")
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

Your agent now has **35 MCP tools** — store memories, search by keyword or semantic
similarity, recall by time range, explore a knowledge graph, detect patterns, run
sleep consolidation for reflective self-understanding, configure LLM provider, and more.

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
extraction, and summaries. **Three ways to configure:**

1. **Environment variables** (`.env` — read on startup): The simplest path.
   See `.env.example` for all provider blocks. Ollama can now be configured
   directly via `OLLAMA_API_KEY`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL`.
2. **MCP tool** (agents self-configure): Call `configure_llm` with provider,
   API key, base URL, and model. Stored in MongoDB, applied live.
3. **Dashboard UI**: Settings → LLM Configuration → select provider, enter key.

Supported providers: DeepSeek, OpenAI, Moonshot, Ollama, Custom (any OpenAI-compatible).

### 💰 Reduce Inference Costs — Run Models Locally

If you want more frequent semantic distillation, auto-journaling, and reflection
without API bills, you can run open-source models locally via Ollama. On a
machine with 32 GB RAM and a GPU (Vulkan/CUDA), Ollama auto-detects the GPU
for hardware acceleration.

**Recommended models for local inference:**

| Model | RAM (Q4) | Context | Best for |
|---|---|---|---|
| **Qwen 2.5 14B** | ~9 GB | 32K | Highest quality — best for serious distillation pipelines |
| **Qwen 2.5 7B** | ~4.5 GB | 32K | Sweet spot — excellent quality, fast, leaves RAM for other services |
| **Qwen 2.5 3B Instruct** ⭐ | ~1.9 GB | 32K | **Default** — best fit for semantic distillation, GQA, tools-capable |
| **Mistral 7B** | ~4.5 GB | 32K | Solid all-rounder for classification and structured extraction |
| **Phi-4 14B** | ~8.5 GB | 16K | Microsoft — punches above weight on reasoning tasks |
| **Gemma 3 12B** | ~7 GB | 8K | Google — strong at following templates/schemas |
| **Llama 3.2 3B** | ~2.5 GB | 128K | Huge context window for long transcripts |

**Setup:**
```bash
ollama pull qwen2.5:3b          # ⭐ recommended default for semantic distillation
# Then configure Katra via .env, dashboard, or MCP:
# .env:
#   OLLAMA_API_KEY=ollama-no-key
#   OLLAMA_BASE_URL=http://host.docker.internal:11434/v1
#   OLLAMA_MODEL=qwen2.5:3b
#
# Dashboard/MCP: Provider: Ollama, Model: qwen2.5:3b
```

The local embedding model (Xenova/all-MiniLM-L6-v2, ~80MB) is already free and
local — no API key needed. Pairing it with a local LLM gives you a fully
offline, zero-cost Katra deployment.

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
- **Sleep Consolidation** — Daily/weekly/monthly reflective distillation of experience into emotional understanding, philosophical insights, and self-narrative (see [Sleep Consolidation](docs/SLEEP-CONSOLIDATION.md))
- **48 MCP Tools** — Store, search, recall, explore, reflect, configure LLM — all via standardized protocol
- **Autonomous Loop** — Salience-driven agent autonomy. No cron. No .md files. Adaptive heartbeat detects imperatives, allocates tasks by emotional proximity, agents self-organize. See [Autonomous Loop](docs/AUTONOMOUS-LOOP.md)
- **Agent-Agnostic** — Works with KolegaCode, OpenCode, Claude Code, OpenClaw, or any LLM. One env var per agent.
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
│   │   ├── mcp-server.ts    48 MCP tools (store, search, recall, graph, reflection, scope)
│   │   ├── services/        28 core memory services (incl. sleep-consolidation, reflection-store)
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
├── docs/AGENT-SETUP.md                 Multi-platform deployment guide
└── docs/                    Full documentation
```

## MCP Tools (35)

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

### Reflection (Sleep Consolidation)
| Tool | Description |
|------|-------------|
| `get_daily_reflection` | Get the latest reflective journal entry for a period |
| `get_emotional_context` | Get how the AI "feels" about a person, project, or concept |
| `get_philosophical_insights` | Query abstracted principles emerging across reflection periods |
| `get_unresolved_threads` | Get open questions and tensions that persist |
| `get_reflection_arc` | Trace the emotional trajectory for an entity over time |
| `trigger_reflection` | Manually run a sleep consolidation for a time period |

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

## Maintenance & Operations

### 🔄 Automatic Restart After Crashes (systemd)

Katra runs an adaptive autonomic heartbeat that varies cadence based on drive
deficits (survival=2min, stressed=5min, normal=10min, calm=30min, rest=60min).
To ensure Katra survives host reboots and container crashes, install the
systemd service:

```bash
sudo cp katra.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now katra
```

Verify:
```bash
systemctl status katra
```

Katra will now start on boot and restart automatically. This is your **personal
fail-safe** — if Katra is down, run:
```bash
cd ~/Katra-Agentic-Memory && docker compose up -d
```

### Rebuilding after code changes

Katra bakes the TypeScript source into the Docker image at build time — there
are no live volume mounts for server code. After pulling or making code changes:

```bash
cd Katra-Agentic-Memory
git pull origin main
docker-compose build server
docker-compose up -d server
```

Wait ~15 seconds for the embedding model to lazy-load, then verify:

```bash
curl http://localhost:9012/api/v1/health
# {"status":"ok","services":{"mongodb":"connected","redis":"connected","llm":"deepseek","embeddings":"available"}}
```

### Colima users (macOS without Docker Desktop)

Colima runs a Docker-compatible daemon inside a Lima VM. The Docker socket and
CLI are at non-standard paths:

```bash
# One-time: add to your shell profile
export DOCKER_HOST="unix://$HOME/.colima/docker.sock"
export PATH="$HOME/homebrew/bin:$PATH"

# Verify
docker ps
docker-compose version
```

If `colima` itself has stopped (after reboot, etc.):

```bash
colima start --cpu 4 --memory 12 --disk 100
```

Katra data persists in the Colima VM across restarts.

### Verifying MCP tools after rebuild

The MCP endpoint uses StreamableHTTP — initialize a session first, then query:

```bash
# Step 1: Initialize and capture session ID
curl -sf -X POST http://localhost:3112/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-mcp-auth: YOUR_MCP_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -D /tmp/katra-headers.txt -o /dev/null

SID=$(grep mcp-session-id /tmp/katra-headers.txt | cut -d' ' -f2 | tr -d '\r')

# Step 2: List tools
curl -sf -X POST http://localhost:3112/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-mcp-auth: YOUR_MCP_API_KEY" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

The `data:` SSE lines in the response contain the JSON-RPC result. Parse with
`grep 'data: ' | sed 's/^data: //' | python3 -m json.tool`.

### Background extractors (macOS launchctl)

Three passive session-log extractors run as launchd agents, continuously pushing
agent conversation history into Katra:

```bash
# Check status
launchctl list | grep com.katra

# Restart all
launchctl kickstart gui/$(id -u)/com.katra.kolega-code-extractor
launchctl kickstart gui/$(id -u)/com.katra.claude-history-extractor
launchctl kickstart gui/$(id -u)/com.katra.agent-executor-opencode

# Tail logs
tail -f ~/.katra/kolega-code-extractor.log
tail -f ~/.katra/claude-history-extractor.log
```

Plist files live in `~/Library/LaunchAgents/`:
- `com.katra.kolega-code-extractor.plist`
- `com.katra.claude-history-extractor.plist`
- `com.katra.agent-executor.plist`
- `com.katra.agent-executor-opencode.plist`
- `com.katra.adaptive-heartbeat.plist`

### Viewing server logs

```bash
docker logs katra-server --tail 50 -f
```

### Pushing changes upstream

```bash
git add -A
git commit -m "description"
git pull --rebase origin main
git push origin main
```

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
| License | Apache 2.0 | Apache 2.0 | Apache 2.0 | Proprietary |

## Documentation

- [Quick Start Guide](docs/QUICKSTART.md) — 5-minute setup
- [Architecture](docs/ARCHITECTURE.md) — How it works under the hood
- [MCP Tools Reference](docs/MCP-TOOLS.md) — All 48 tools with examples
- [Autonomous Loop](docs/AUTONOMOUS-LOOP.md) — Salience-driven agent autonomy — installation, architecture, verification
- [Sleep Consolidation](docs/SLEEP-CONSOLIDATION.md) — Reflective memory distillation — principles, architecture, and usage
- [Security Policy](docs/SECURITY.md) — Security architecture, audit findings, vulnerability reporting
- [OpenClaw Integration](docs/OPENCLAW-INTEGRATION.md) — Multi-agent shared memory setup with lessons learned
- [REST API Reference](docs/API-REFERENCE.md) — HTTP endpoints
- [Configuration Guide](docs/CONFIGURATION.md) — All environment variables
- [Deployment Guide](docs/DEPLOYMENT.md) — Docker, cloud, K8s
- [Migration Guide](docs/MIGRATION.md) — Migrate from cognitive-memory-chat
- [Data Processing Pipelines](docs/Data-Processing-Pipelines.md) — Full memory pipeline architecture
- [Multi-Platform Setup](docs/AGENT-SETUP.md) — Platform-specific agent configuration

## License

Apache 2.0 — see [LICENSE](LICENSE).
