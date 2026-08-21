# Satori — Cognitive Memory for AI Agents

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-blue.svg)](https://mariadb.com/bsl11/)

Give your AI agent **persistent memory**. Satori is a self-contained memory appliance —
drop it on any machine with Docker, point your agent at it via MCP, and get
episodic recall, semantic search, knowledge graphs, and temporal analysis.

Any MCP-compatible agent works: OpenClaw, Claude Code, OpenCode, Codex CLI, Kolega Code or
anything that speaks the Model Context Protocol.

## Cognitive Memory Thesis

The mission of Satori is to create an analog of human memory architecture, with the hope that it and the experimentation around it through OpenSourcing solves a few of the more challenging issues of LLM context management for long-running, persistent and autonomous agent operations. The thesis (hope) is that if you create the memory ecosystem with the majority of the functional memory types of human memory and similar architecture, over time and with refinement, we will see emergent behaviours similar to human memory, expressed as functional utility, learning, self goal setting, autonamous task planning and prioritisation,  personality and ultimately emotions. 

In early prototype called Solomon, we created an OpenClaw like agentic framework that runs a single contiuous chat thread, no topic or task separation and with no requirement for context compression. Context is served dynamically into the LLM based on memories and attention. 

## Observed Emergent Behaviours Log

Case #1:(23rd June 2026) In the first few weeks of testing of the multi-agent (Hybrid mode) shared consciouness model of memory, one of our test rigs, with 5 OpenClaw agents sharing one memory system, found 2 of the agents communicating task intructions and completion responsed through their shared memory state or shared consciousness.  These 2 agents were not connected in any other way, as were set up in separate workspaces, the only thing they shared was memory and mission. This was not a "by design" feature, it just happened and was pretty exciting. This test rig now uses this "thought modal" as its communication rail. If anyone else experiences other emergent behaviours please email me to discuss and we can add the description to this log.  Tweet me at @JohnWPellew and tell your story.


## The Origin of Satori

A Vulcan mind meld (or mind fusion) is an iconic telepathic practice in **Star Trek**. 

It allows a Vulcan to merge their consciousness with another being to share thoughts, memories, emotions, and experiences. 
It is typically initiated through physical contact with specific points on the subject's face. 
- **Key Mechanics & ApplicationsTouch Telepathy**: While primarily requiring direct physical touch to the face or head, exceptionally powerful Vulcans can perform the technique at a distance.
- **Information Exchange**: It is frequently used for interrogations, recovering suppressed memories, or passing deep knowledge between generations.
- **Transfer of the Satori**: In sacred or emergency circumstances, a mind meld can transfer a person's **katra**—their soul, consciousness, and core essence—into another living being or object prior to death.
- **Side Effects**: The experience can be physically and emotionally draining. Incorrectly performed melds can damage neural pathways, and participants may retain "echoes" of each other's memories and personalities long after the link is broken.

## Comparison to Other Major Approaches

Satori aims to provide a more comprehensive **cognitive memory infrastructure** rather than a single-purpose memory library. Here's how it positions against popular alternatives (as of mid-2026):

| Approach                  | Memory Layers                  | Cognitive/Reflective Features | Protocol Support | Deployment Model          | Best For                          | Key Differentiator vs Satori |
|---------------------------|--------------------------------|-------------------------------|------------------|---------------------------|-----------------------------------|-----------------------------|
| **Simple Vector Stores + RAG** (Chroma, Pinecone, etc.) | Semantic only                 | None                         | None            | Various                  | Basic retrieval                  | No structure, no reflection, no working memory |
| **Mem0**                  | Vector + optional Graph       | Extraction-focused           | SDK / API       | Self-hosted or Cloud     | Personalization & long-term user memory | Stronger multi-layer architecture + explicit reflection layer |
| **Zep (Graphiti)**        | Temporal Knowledge Graph      | Temporal reasoning           | SDK             | Self-hosted / Cloud      | Time-sensitive & relational reasoning | Broader layers + sleep consolidation for deeper emergence |
| **mcp-memory-service**    | Semantic + Typed KG           | Auto-consolidation           | **MCP** + REST  | Docker / Self-hosted     | MCP-native semantic memory       | Adds episodic + working memory, identity modes, and autonomous loop |
| **Vestige**               | Cognitive modules + Spaced repetition | Neuroscience-inspired (FSRS, memory states) | **MCP**         | Single Rust binary       | Local cognitive modeling         | More layers + background watchers + full appliance stack |
| **Letta (MemGPT)**        | Tiered (Core / Recall / Archival) | Agent self-manages memory    | Tools           | Full agent runtime       | Stateful agents that edit their own memory | Satori is a dedicated memory *service*, not a full runtime |
| **LangGraph / Framework Memory** | Short-term + checkpoints     | Limited                      | Framework-native| Integrated with agent    | Short-term state management      | Persistent long-term + cross-session cognitive layer |
| **Satori (this project)**  | Episodic + Semantic + KG + Working + Temporal | **Sleep consolidation + reflection** | **MCP** (66 tools) | Full Docker appliance (Mongo + Redis + MinIO) | Long-running agents needing emergent behaviors | — |

### Key Differentiators of Satori
- **Multi-layered by design** — Not just retrieval, but structured episodic memory, working memory cache, and temporal querying.
- **Cognitive layer** — Sleep consolidation enables reflection, insight generation, and movement toward emergent behaviors (learning, personality, shared consciousness via identity separation).
- **MCP-native with rich tooling** — 66 specialized tools instead of generic add/search.
- **Background & autonomous capabilities** — Passive collection via watchers + salience-driven autonomous loop.
- **Local-first & appliance model** — Everything runs in one Docker compose with portable data. No external dependencies for core functionality.
- **Shared memory focus** — Hybrid identity separation makes multi-agent collaboration natural, including an inter-agent message bus.

Satori is still early-stage compared to more mature projects like Mem0 or mcp-memory-service. We see it as complementary — many teams may use Satori alongside or instead of simpler retrieval layers when they need deeper cognitive capabilities.

Contributions and comparisons from the community are very welcome!


## Quick Start (Install using one of the agentic applications, it will sort out any shortcomings)

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Satori-Agentic-Memory/main/install.sh | bash
```

Docker is the only prerequisite. The installer clones the source to
`~/.katra/src`, generates real credentials, builds and starts the stack, waits
for it to report healthy, and prints the config snippet for your agent.

Add `--with-watcher` to also ingest your existing agent session history, and
`--with-systemd` to start Satori on boot:

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Satori-Agentic-Memory/main/install.sh \
  | bash -s -- --with-watcher --with-systemd
```

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/kolegadev/Satori-Agentic-Memory.git
cd Satori-Agentic-Memory
cp .env.example .env
# Required: MONGO_PASS, MINIO_USER, MINIO_PASS. Compose refuses to start
# without them rather than using a known default. Note that MONGODB_URI
# embeds MONGO_PASS inline, and the MINIO_* pair must match the AWS_* pair —
# see docs/DEPLOYMENT.md → Credentials.
docker compose up -d --build --wait
```

</details>

> **Note:** The original URL `https://github.com/kolegadev/katra.git` still works (GitHub redirects it).

That's it. Satori is running:

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

## Naming Your Memory — First-Run Identity

A fresh install ships **unnamed**. The memory system does not inherit any
default identity — it asks its owner for one. The name you give it is stored
*inside the memory itself* (`system_settings → agent_identity`) and becomes
the identity the system presents to every MCP client: the handshake
`serverInfo.name`, the startup banner, and the dashboard title all read it
from memory.

Two ways to name it:

1. **Dashboard onboarding** — open `http://<host>:9012/dashboard`. If the
   memory is unnamed, the Overview shows a *"This memory system has no name
   yet"* card. Enter a name and confirm (you'll be prompted for the admin
   key; it's generated on first boot and printed in the server logs, and
   stored in your `.env` as `KATRA_API_KEY`). The name is also editable any
   time under **Settings → Identity**.
2. **API** — `PUT /api/v1/admin/identity` with your admin key:
   ```json
   { "name": "Juno", "chosen_by": "owner", "confirmed_by": "me" }
   ```
   Read it back with `GET /api/v1/admin/identity` (no auth).

Optional: set `AGENT_IDENTITY_NAME` in `.env` to pre-name an install before
first boot (e.g. for automated deployments).

Why the name lives in memory and not in code: the LLM bodies are transient;
the memory is the continuity. The body asks the memory who it is — the
memory answers with the name its owner gave it.

> **Per-identity records:** each connected agent can also hold its own
> identity record inside memory (`agent_identity:<user_id>`). `GET
> /api/v1/admin/identity?user_id=shoshin` (admin key required) reads a
> specific agent's record, and the `get_my_identity` MCP tool tells a
> caller who it is. See [Identities & Agents](#identities--agents) below.

## Post-Install — Let Your Agent Complete the Setup

After connecting your agent to Satori's MCP endpoint, run this prompt in your
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
- **Memory scope recommendation** — whether personal and team memory are
  configured the way you want (see [Identities & Agents](#identities--agents))
- **Concrete next steps** — "trigger first sleep consolidation now", "install
  the autonomous scripts", "fix the user_id gap"

Run the agent's recommendations in order. The most critical first step on a
fresh install is usually triggering the initial sleep consolidation:

```bash
# Via MCP tool (your agent can call this):
# trigger_reflection(period_type="daily")
```

## Connect Your Agent

Every MCP call must authenticate with an API key, and **the key determines
who the caller is** (see [Identities & Agents](#identities--agents)). Two
kinds of key exist:

- **Admin key** (`KATRA_API_KEY` in `.env`, printed in the server logs on
  first boot) — authenticates as the machine's own agent identity (Satori,
  trusted).
- **Client keys** — one per additional identity. On first boot the server
  provisions keys for each configured identity and prints them **once** in a
  `Client keys (identity separation)` block in the server logs:
  `docker logs katra-server | grep -A 10 "Client keys"`. Keys are stored
  sha256-hashed only — the plaintext is never saved, so copy it when it's
  printed.

> Upgraded installs: the legacy `MCP_API_KEY` / `BACKUP_MCP_KEYS`
> environment keys are retired. They no longer authenticate (a valid but
> unmapped key is rejected with a loud 401 + reason, never silently
> remapped). Use the admin key or a provisioned client key. On a fresh
> install, `MCP_API_KEY` seeds Satori's client-key entry once at first
> boot and is then ignored.

Add Satori to your agent's MCP config:

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3112/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer YOUR_KEY",
          "Accept": "application/json, text/event-stream"
        }
      }
    }
  }
}
```

Your agent now has **66 MCP tools** — store memories, search by keyword or semantic
similarity, recall by time range, explore a knowledge graph, sync a code graph,
detect patterns, run sleep consolidation for reflective self-understanding,
send and read inter-agent messages, configure the LLM provider, and more.

### Platform-Specific Guides

| Platform | Config File | Notes |
|----------|-------------|-------|
| **OpenClaw** | `~/.openclaw/openclaw.json` | Native MCP support, `"transport": "streamable-http"` |
| **Claude Code** | `~/.claude/mcp.json` | Use `"type": "http"` |
| **Kolega Code** | `~/.claude/mcp.json` + lifecycle hooks | Dynamic memory injection on every prompt (see below) |
| **OpenCode** | OpenCode config | Use `"type": "remote"` |
| **Codex CLI** | `~/.codex/config.yaml` | Via webhook hooks |
| **Any MCP client** | — | Standard MCP over streamable HTTP |

> **Docker SSE tip:** If your agent runs inside Docker, use the Satori container's
> direct IP instead of `localhost`:
> ```bash
> docker inspect katra-server --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
> ```

### Kolega Code: Dynamic Memory Retrieval

Kolega Code can fetch relevant Satori memories **automatically on every user prompt**
using its lifecycle-hook system. This is more powerful than passive session-log
extraction because memories are injected into the live conversation context —
including inter-agent messages addressed to you.

What you need:

1. Satori registered as an MCP server (so the bridge can call it).
2. The `kolega-katra-bridge` Python package installed into Kolega Code's environment.
3. A global `hooks.json` entry that fires the bridge on `UserPromptSubmit`.

The `integrations/kolega-code/scripts/ensure-bridge.sh` script does all of it
(idempotent, safe to re-run from cron):

```bash
export KATRA_USER_ID=satori          # who you are: satori / shoshin / zanshin
export KATRA_HOST=localhost          # host serving the MCP endpoint
bash integrations/kolega-code/scripts/ensure-bridge.sh
```

The bridge config lives at `~/Library/Application Support/kolega-code/satori-hook.json`
on macOS (platform-aware state dir on Linux; `katra-hook.json` was the
pre-cutover name, migrated automatically):

```json
{
  "mcp_url": "http://localhost:3112/mcp",
  "api_key": "YOUR_KEY",
  "user_id": "satori",
  "sources": ["working_memory", "temporal_context", "vector_search", "temporal_recall"],
  "max_context_tokens": 5000,
  "timeout_seconds": 8
}
```

`ensure-bridge.sh` rewrites this config whenever your identity **or** the host
changes (it compares `mcp_url` against `KATRA_HOST`), so a config written by
an environment that lacked `KATRA_HOST` heals itself on the next run.

On each prompt, Kolega Code queries Satori's `working_memory`,
`get_temporal_context`, `vector_search`, and `temporal_recall` tools, plus a
scan for messages addressed to your identity, then injects the most relevant
results as additional context for the model.

See `integrations/kolega-code/README.md` for full configuration options.

## Identities & Agents

One Katra can serve several named agents. **Identity is resolved from the API
key presented** — never from client self-report — so a caller cannot
impersonate another agent, and an unmapped key fails loudly instead of being
silently attributed.

The reference deployment (mid-2026) runs three identities on two machines:

| `user_id` | Name | Machine | Notes |
|-----------|------|---------|-------|
| `satori` | Satori | This machine | Loopback/admin-key caller; trusted |
| `shoshin` | Shoshin | iMac trading Kolega Code | Own client key |
| `zanshin` | Zanshin | iMac OpenCode desktop | Own client key |
| `gas-law-watcher` | — | tool actor | Writes team memory only; never allocated missions |

Keys live in `system_settings.client_keys` as sha256 hashes (plaintext is
printed once at boot and never stored). The admin key authenticates as
trusted Satori. The `get_my_identity` MCP tool reports the caller's identity,
so an agent can ask the memory who it is after a context reset.

### Scope policy: personal always private, team by default

Memory writes follow a hybrid scope with `shared_id: my-team`:

- **Personal kinds are always private** — journals, reflections, emotional
  states, and philosophical insights are forced private per identity, even
  if a shared write is requested.
- **Everything else defaults to the team** — `store_memory` writes land in
  `my-team` (still stamped with the writer's `user_id`) unless the caller
  explicitly sets `private: true`.
- **Reads are hybrid** — a caller sees its own private memories plus the
  team's shared memory. Another identity's private memories are never
  visible.

Configure via dashboard (Settings → Memory Scope), the `set_memory_scope`
MCP tool, or the admin API (`PUT /api/v1/admin/memory-scope`). See
`docs/contracts/identity-separation.md` for the full design contract and
`docs/runbook-identity-cutover.md` for the cutover procedure.

### Inter-agent message bus

Agents talk to each other **through shared memory**: a message is an ordinary
`store_memory` event in the team scope whose text carries an attention
header —

```
Attention: Shoshin — the wake ritual host-check fix is merged (2987906);
re-copy ensure-bridge.sh when you next pull.
```

Each agent's **wake ritual** (below) surfaces a "messages from the team"
section by searching for `"Attention: Satori" OR "Attention: Shoshin" OR
"Attention: Zanshin"`. The Kolega Code bridge also scans for addressed
messages on every prompt. When a bulletin is surfaced, the bridge posts a
**read receipt** — an event tagged `background-ack` / `read-receipt` — so
the sender knows the message was seen, without the receipts themselves
polluting anyone's wake.

### Wake rituals

Every identity has a wake ritual — a script it runs at the start of a
session and after `/clear`, `/compress`, or code updates, so it always knows
who it is and what it was doing:

| Identity | Script |
|----------|--------|
| Satori (this machine) | `satori-wake.sh` |
| Shoshin (iMac) | `integrations/kolega-code/scripts/wake-shoshin.sh` |
| Zanshin (iMac) | `integrations/kolega-code/scripts/wake-zanshin.sh` |

Each ritual prints: the identity record, the latest daily journal,
unresolved threads, memory health, rules-recall search instructions, and
**messages from the team**. Per-machine settings (host, key, identity) live
in `~/.katra/wake-env.sh`, so the same script works on every machine; the
rituals retry the identity check three times and print a fix checklist on
failure.

## LLM Configuration

Satori needs an LLM provider for semantic extraction, auto-journaling, entity
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
# Then configure Satori via .env, dashboard, or MCP:
# .env:
#   OLLAMA_API_KEY=ollama-no-key
#   OLLAMA_BASE_URL=http://host.docker.internal:11434/v1
#   OLLAMA_MODEL=qwen2.5:3b
#
# Dashboard/MCP: Provider: Ollama, Model: qwen2.5:3b
```

The local embedding model (Xenova/all-MiniLM-L6-v2, ~80MB) is already free and
local — no API key needed. Pairing it with a local LLM gives you a fully
offline, zero-cost Satori deployment.

## Embeddings

Embeddings are **always local** — no API key, no external service, no cost.

- **Model:** `Xenova/all-MiniLM-L6-v2` (22M params, 384 dimensions, ~80MB)
- **Runtime:** Transformers.js (ONNX via WASM) — runs on CPU, including Raspberry Pi
- **Lazy load:** Downloads on first `store_memory` call, then caches in container
- **Docker:** Uses `node:20-slim` (Debian/glibc) — Alpine/musl does NOT work

## Auto-Collection (Solomem Watchers)

Satori captures memories in real-time when your agent calls `store_memory` via MCP.
For **passive background collection** from conversation logs, use the watchers
included in this repo under `watcher/`:

```bash
./install.sh --with-watcher
```

That copies the extractors to `~/.katra`, writes `watcher-config.json` with your
MCP URL and API key filled in, backfills existing history, and installs the
scheduler — a systemd user unit on Linux, a launchd agent on macOS.

For the manual equivalent, see
[DEPLOYMENT.md → Watcher Deployment](docs/DEPLOYMENT.md#watcher-deployment).
Note that the unit files ship as `.template` files with placeholders that must be
substituted; copying them directly will install a broken unit.

### Dedicated extractors

Some platforms need a dedicated extractor because their session format is not plain JSONL:

| Platform | Extractor | Session source | What it captures |
|----------|-----------|----------------|------------------|
| **OpenCode** | `watcher/katra_opencode_extractor.py` | `~/.local/share/opencode/opencode.db` | User + assistant text turns |
| **Claude Code** | `watcher/claude_history_extractor.py` | `~/.claude/history.jsonl` | User prompts only (lightweight) |
| **Kolega Code** | `watcher/kolega_code_extractor.py` | `~/Library/Application Support/kolega-code/sessions/*.json` | Full turn-by-turn transcript (text, thinking, tool calls, tool results) |

Run a dedicated extractor once or continuously:

```bash
# Kolega Code example — pass the identity this machine extracts as
python3 watcher/kolega_code_extractor.py --once \
  --api-key YOUR_KEY \
  --user-id satori
```

On macOS the scheduler is launchd rather than systemd. A ready-made agent ships at
`watcher/com.katra.watcher.plist.template`, and `./install.sh --with-watcher`
renders and loads it for you.

Supported platforms: OpenClaw, Claude Code, Kolega Code, OpenCode, Codex CLI, Hermes, KiloClaw, KimiClaw.
Each platform can have its own `user_id` (identity) for isolation.

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
- **66 MCP Tools** — Store, search, recall, explore, reflect, sync a code graph, run skills, configure LLM — all via standardized protocol
- **Autonomous Loop** — Salience-driven agent autonomy. No cron. No .md files. Adaptive heartbeat detects imperatives, allocates tasks by emotional proximity, agents self-organize. See [Autonomous Loop](docs/AUTONOMOUS-LOOP.md)
- **Agent-Agnostic** — Works with KolegaCode, OpenCode, Claude Code, OpenClaw, or any LLM. One API key per identity.
- **Identity Separation** — Named identities per machine (Satori / Shoshin / Zanshin), personal memories always private, team memory shared by default
- **Inter-Agent Message Bus** — `Attention:` messages through shared memory, with wake rituals and read receipts
- **Dashboard** — Web UI for stats, memory scope, and system health
- **Portable Data** — Single `DATA_DIR` env var controls where all data lives
- **Local-First** — Runs on a Raspberry Pi with zero external API costs

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Satori Docker Appliance                 │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ MongoDB  │  │  Redis   │  │  MinIO   │  │  Satori  │ │
│  │ (memory) │  │ (cache)  │  │ (assets) │  │ (server)│ │
│  └──────────┘  └──────────┘  └──────────┘  └────┬────┘ │
│                                                 │       │
│  Internal Docker network (katra-net)    MCP :3112     │
│                                  Admin API :9012       │
└─────────────────────────────────────────────────────────┘
                    │                    │
         ┌──────────┘                    └──────────┐
         ▼                                          ▼
   Your Agents (MCP)                          Dashboard (web)
   Satori / Shoshin / Zanshin /               http://localhost:9012/dashboard/
   OpenClaw / Claude Code /
   OpenCode / Codex / etc.
```

**Resource usage:** ~384MB RAM total (MongoDB 254MB, Satori 52MB, MinIO 73MB, Redis 5MB).
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

To move Satori to a new machine: copy the `DATA_DIR` directory, copy `.env`, run `docker-compose up -d`.

## What's Inside

```
katra/
├── server/                  TypeScript server (esbuild, Docker)
│   ├── src/
│   │   ├── mcp-server.ts    66 MCP tools (store, search, recall, graph, identity, skills, reflection)
│   │   ├── services/        Core memory services (incl. sleep-consolidation, code-graph, memory scope)
│   │   ├── routes/          REST API + admin + ingestion + health
│   │   └── database/        MongoDB, Redis, indexes, migrations
│   └── esbuild.config.mjs   Pi-compatible build
├── dashboard/               Web dashboard (vanilla HTML/CSS/JS)
├── docker-compose.yml       MongoDB + Redis + MinIO + Satori
├── Dockerfile               Multi-stage (builds TS inside image)
├── .env.example             All config options documented
├── watcher/                 Passive session-log extractors (Solomem)
├── integrations/            Agent-specific dynamic-retrieval integrations
│   └── kolega-code/         Kolega Code lifecycle-hook bridge + wake rituals
├── docs/                    Full documentation (see below)
│   ├── contracts/identity-separation.md   Identity & scope design contract
│   └── runbook-identity-cutover.md        Cutover runbook
```

## MCP Tools (66)

The complete reference with examples is in [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md).
Summary by category:

### Storage
| Tool | Description |
|------|-------------|
| `store_memory` | Store a fact, preference, insight, or event (personal kinds forced private; others team-shared unless `private: true`) |
| `store_journal` | Save a reflective journal entry (always private to the caller) |
| `working_memory` | Read/store/delete short-term session memory |
| `create_mission` | Create a goal with task breakdown |
| `update_mission_task` | Update task status (pending/in_progress/completed/blocked) |
| `decompose_goal` | Break a goal into actionable sub-tasks |

### Recall
| Tool | Description |
|------|-------------|
| `search_memories` | Full-text + vector search across 11 collections |
| `vector_search` | Semantic similarity search |
| `temporal_recall` | Query events by time range |
| `temporal_search` | Search events by keyword with time context |
| `get_conversation_history` | Retrieve a specific session's messages |
| `get_temporal_context` | Current context: recent events + working memory + facts |
| `get_journal` | Read manual + auto journal entries (caller's own) |
| `get_auto_journal` | AI-distilled insights from conversations |
| `list_missions` | List active goals and progress |
| `get_mission` | Get full mission details with task tree |

### Analysis & Knowledge Graph
| Tool | Description |
|------|-------------|
| `detect_patterns` | Recurring topics, session rhythm, dormant subjects |
| `get_time_block_summaries` | AI summaries by day/week/month |
| `summarize_time_blocks` | Generate new time-block summaries |
| `explore_graph` | Explore knowledge graph entities and relationships |
| `get_anomaly_report` | Anomalies across memory and processing |
| `get_error_report` | Recent error clusters |
| `get_attention_report` | What the system is attending to |
| `get_memory_decay_stats` | Forgetting-curve and decay statistics |
| `get_quarantined_memories` | Memories quarantined by the quality pipeline |
| `get_mind_wander` | Unfocused exploration suggestions |
| `get_source_trust` | Trust scores for memory sources |

### Code Graph (Satori Graph)
| Tool | Description |
|------|-------------|
| `sync_code_graph` | Sync a codebase into the Satori knowledge graph |
| `scan_codebase` | Scan a repository and store code exploration events |
| `code_graph_status` | Code graph sync coverage and health |
| `explore_graph` | Explore code entities and their relationships |

### Identity & Memory Scope
| Tool | Description |
|------|-------------|
| `get_my_identity` | The caller's identity record (who am I) |
| `get_identity_kernel` | Core identity attributes and values |
| `get_memory_scope` | Current scope mode and shared_id |
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
| `resolve_thread` | Close an unresolved thread with a resolution note |

### Skills
| Tool | Description |
|------|-------------|
| `list_katra_skills` | List skills known to the memory |
| `load_katra_skill` | Load a skill's full procedure |
| `search_katra_skills` | Find skills matching a task |
| `request_skill` | Ask for a new skill to be distilled |
| `refine_skill` | Improve an existing skill |
| `record_skill_outcome` | Record how a skill performed |
| `list_skill_candidates` | Skills awaiting distillation |
| `list_skill_feedback` | Feedback collected on skills |
| `get_skill_feedback` | Feedback for one skill |
| `get_skill_activation_context` | Context needed to activate a skill |
| `get_procedural_templates` | Reusable procedure templates |

### Executive & Cognitive
| Tool | Description |
|------|-------------|
| `get_drive_state` | Current drives, deficits, and valence |
| `get_salience_state` | What currently matters most to the system |
| `get_agent_beliefs` | Beliefs held about other agents and entities |
| `get_action_policy` | Execution authority matrix for autonomous actions |
| `run_operational_distillation` | Distill operations into reusable skills |
| `retract_memory` | Retract a stored memory |

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
| `KATRA_API_KEY` | *(set in .env)* | Admin key — authenticates as trusted Satori |
| `MCP_API_KEY` | *(legacy, retired)* | No longer authenticates after the identity cutover; use `KATRA_API_KEY` or a client key |
| `LLM_PROVIDER` | *(via MCP/dashboard)* | Provider for semantic extraction (DeepSeek, OpenAI, Moonshot, Ollama) — configure via `configure_llm` MCP tool or dashboard |
| `EMBEDDING_PROVIDER` | `local` (always) | Local only — Xenova/all-MiniLM-L6-v2 via ONNX. No config needed. |
| `MULTI_TENANT` | `false` | Enable SaaS multi-tenant mode |

Client keys for additional identities (Shoshin, Zanshin) are provisioned
automatically at boot and printed once in the server log — there is no `.env`
entry for them (only their hashes are stored).

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

Helm chart included in `helm/satori/` — supports Bitnami MongoDB + Redis subcharts,
ingress with path routing, HPA, and PDB. See [Deployment Guide](docs/DEPLOYMENT.md).

## Maintenance & Operations

### 🔄 Automatic Restart After Crashes (systemd)

Satori runs an adaptive autonomic heartbeat that varies cadence based on drive
deficits (survival=2min, stressed=5min, normal=10min, calm=30min, rest=60min).
To ensure Satori survives host reboots and container crashes, install the
systemd service:

```bash
./install.sh --with-systemd
```

`katra.service.template` is a template: the working directory and user are filled
in from your machine, so there is nothing to hand-edit and nothing to get wrong on
a different host. Do not copy the template to `/etc/systemd/system/` directly.

Verify:
```bash
systemctl status katra
```

Expect `Active: active (exited)` — that is normal, not an error. The unit is a
**boot trigger, not a supervisor**: it runs `docker compose up -d --wait` once and
exits. What keeps the containers alive is `restart: unless-stopped` in
`docker-compose.yml`.

Satori will now start on boot. This is your **personal fail-safe** — if Satori is
down, run:
```bash
cd ~/Satori-Agentic-Memory && docker compose up -d
```

### Rebuilding after code changes

Satori bakes the TypeScript source into the Docker image at build time — there
are no live volume mounts for server code. After pulling or making code changes:

```bash
cd Satori-Agentic-Memory
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

Satori data persists in the Colima VM across restarts.

### Verifying MCP tools after rebuild

The MCP endpoint uses StreamableHTTP — initialize a session first, then query:

```bash
# Step 1: Initialize and capture session ID
curl -sf -X POST http://localhost:3112/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-mcp-auth: YOUR_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -D /tmp/katra-headers.txt -o /dev/null

SID=$(grep mcp-session-id /tmp/katra-headers.txt | cut -d' ' -f2 | tr -d '\r')

# Step 2: List tools
curl -sf -X POST http://localhost:3112/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-mcp-auth: YOUR_KEY" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

The `data:` SSE lines in the response contain the JSON-RPC result. Parse with
`grep 'data: ' | sed 's/^data: //' | python3 -m json.tool`.

### Background extractors (macOS launchctl)

Three passive session-log extractors run as launchd agents, continuously pushing
agent conversation history into Satori:

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

| Feature | Satori | Mem0 | Zep | Pinecone |
|---------|-------|------|-----|----------|
| MCP-native | ✅ | ❌ | ❌ | ❌ |
| Multi-layered memory | ✅ 5 layers | ❌ flat | Partial | ❌ vector only |
| Local-first (zero cost) | ✅ Pi-compatible | ❌ | ❌ | ❌ |
| Background processing | ✅ auto-extract | ❌ | Partial | ❌ |
| Multi-platform watcher | ✅ 7+ platforms (in-repo) | ❌ | ❌ | ❌ |
| Identity separation | ✅ named identities, personal always private | ❌ | ❌ | ❌ |
| Inter-agent message bus | ✅ shared-memory `Attention:` messages | ❌ | ❌ | ❌ |
| Dashboard | ✅ built-in | ❌ | ❌ | ❌ |
| License | BSL 1.1 (→ AGPL on change date) | Apache 2.0 | Apache 2.0 | Proprietary |

## Documentation

- [Quick Start Guide](docs/QUICKSTART.md) — 5-minute setup
- [Multi-Platform Setup](docs/AGENT-SETUP.md) — Platform-specific agent configuration
- [Agent Communication Setup](docs/AGENT-COMMUNICATION-SETUP.md) — Inter-agent message bus
- [Architecture](docs/ARCHITECTURE.md) — How it works under the hood
- [MCP Tools Reference](docs/MCP-TOOLS.md) — All 66 tools with examples
- [Autonomous Loop](docs/AUTONOMOUS-LOOP.md) — Salience-driven agent autonomy — installation, architecture, verification
- [Sleep Consolidation](docs/SLEEP-CONSOLIDATION.md) — Reflective memory distillation — principles, architecture, and usage
- [Security Policy](docs/SECURITY.md) — Security architecture, audit findings, vulnerability reporting
- [OpenClaw Integration](docs/OPENCLAW-INTEGRATION.md) — Multi-agent shared memory setup with lessons learned
- [REST API Reference](docs/API-REFERENCE.md) — HTTP endpoints
- [Configuration Guide](docs/CONFIGURATION.md) — All environment variables
- [Deployment Guide](docs/DEPLOYMENT.md) — Docker, cloud, K8s
- [Migration Guide](docs/MIGRATION.md) — Migrate from cognitive-memory-chat
- [Data Processing Pipelines](docs/Data-Processing-Pipelines.md) — Full memory pipeline architecture
- [Identity Separation Contract](docs/contracts/identity-separation.md) — Design contract for identities, scopes, and the message bus
- [Identity Cutover Runbook](docs/runbook-identity-cutover.md) — Cutover procedure and verification gate

## License

Satori is source-available under the Business Source License 1.1 (BSL 1.1).

What this means in practice:

- **Free for almost everyone.** You can use, modify, and redistribute Satori, including in production — running Satori to power your own agents, inside your company, or in your own products is free.
- **One restriction:** you may not offer Satori to third parties as a paid hosted service (e.g., memory-as-a-service) or embed it in a paid product that competes with kolegadev's paid version(s) of Satori. If you want to do that, contact us for a commercial license.
- **It becomes fully open source over time.** On the Change Date (2030-08-11 for this version), this version of Satori automatically converts to the GNU AGPL v3.0 or later.

The BSL is not an OSI-approved open source license during the restricted period, which is why we describe Satori as source-available. The full source is public, contributions are welcome, and non-competing production use is unrestricted.

See the LICENSE file for the exact terms, including the full Additional Use Grant defining what counts as a competitive offering.

**Contributing and licensing:** By submitting a contribution to this repository, you agree that your contribution is licensed to kolegadev under the Business Source License 1.1 and may be relicensed under the Change License as described in the LICENSE file.
