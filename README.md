# Katra — Cognitive Memory for AI Agents

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-blue.svg)](https://mariadb.com/bsl11/)
[![CI](https://github.com/kolegadev/Katra-Agentic-Memory/actions/workflows/ci.yml/badge.svg)](https://github.com/kolegadev/Katra-Agentic-Memory/actions/workflows/ci.yml)

**Persistent, self-reflective memory for AI agents.** Katra is a self-contained
memory appliance — drop it on any machine with Docker, point your agent at it via
[MCP](https://modelcontextprotocol.io), and get episodic recall, semantic search,
knowledge graphs, temporal analysis, and sleep-consolidated reflection.

Any MCP-compatible agent works: Claude Code, OpenClaw, OpenCode, Codex CLI,
Kolega Code, or anything that speaks the Model Context Protocol.

```bash
# Docker is the only prerequisite
curl -fsSL https://raw.githubusercontent.com/kolegadev/Katra-Agentic-Memory/main/install.sh | bash
```

```console
$ curl http://localhost:3112/health
{"status":"ok","services":{"mongodb":"connected","redis":"connected","llm":"deepseek","embeddings":"available"}}
```

---

## Table of Contents

- [What is Katra](#what-is-katra)
- [Key differentiators](#key-differentiators)
- [How it compares](#how-it-compares)
- [Quick start](#quick-start)
- [Connect your agent](#connect-your-agent)
- [First-run identity](#first-run-identity)
- [Features](#features)
- [Architecture](#architecture)
- [Katra Vault](#katra-vault)
- [Autonomous loop & sleep consolidation](#autonomous-loop--sleep-consolidation)
- [Observed emergent behaviours](#observed-emergent-behaviours)
- [The origin of Katra](#the-origin-of-katra)
- [Documentation](#documentation)
- [Contributing & security](#contributing--security)
- [License](#license)

## What is Katra

Katra models human memory architecture to solve a hard problem in long-running,
persistent, autonomous agents: **LLM context management**. Rather than a single
vector store, Katra provides the majority of the functional memory types of
human memory — episodic, semantic, working, and procedural — plus a reflective
layer that distills experience over time.

The thesis: build the memory ecosystem with similar architecture to human memory,
and over time and refinement you see emergent behaviours expressed as functional
utility, learning, self goal-setting, task planning, prioritisation, personality,
and ultimately emotion.

## Key differentiators

- **Multi-layered by design** — structured episodic memory, a working-memory
  cache, semantic facts with embeddings, a knowledge graph, and temporal querying.
- **Cognitive layer** — *sleep consolidation* runs daily/weekly/monthly reflection
  that generates insights, emotional context, and self-narrative.
- **MCP-native with rich tooling** — **66** specialized tools instead of generic
  add/search.
- **Autonomous & background** — passive collection via watchers plus a
  salience-driven autonomous loop (no cron, no hand-written task files).
- **Local-first & appliance model** — MongoDB + Redis + MinIO in one
  `docker compose` stack with portable data. Runs on a Raspberry Pi.
- **Shared-memory multi-agent** — identity separation and an inter-agent message
  bus make multi-agent collaboration natural.
- **Katra Vault** — a built-in, encrypted-at-rest secret store; a secret never
  passes through an LLM.

## How it compares

| Approach | Memory layers | Cognitive/reflective | Protocol | Deployment | Best for |
|---|---|---|---|---|---|
| **Simple vector stores + RAG** (Chroma, Pinecone, …) | Semantic only | None | None | Various | Basic retrieval |
| **Mem0** | Vector + optional graph | Extraction-focused | SDK / API | Self-hosted / cloud | Personalization |
| **Zep (Graphiti)** | Temporal knowledge graph | Temporal reasoning | SDK | Self-hosted / cloud | Time-sensitive reasoning |
| **mcp-memory-service** | Semantic + typed KG | Auto-consolidation | MCP + REST | Docker | MCP-native semantic memory |
| **Vestige** | Cognitive modules + spaced repetition | Neuroscience-inspired | MCP | Single Rust binary | Local cognitive modeling |
| **Letta (MemGPT)** | Tiered (core/recall/archival) | Agent self-manages | Tools | Full agent runtime | Stateful agents |
| **Katra (this project)** | Episodic + semantic + KG + working + temporal | **Sleep consolidation + reflection** | **MCP** (66 tools) | Docker appliance | Long-running agents needing emergent behaviours |

Katra is early-stage next to more mature projects and is complementary to them:
many teams run Katra *alongside* a simpler retrieval layer when they need deeper
cognitive capabilities. Comparisons and contributions are very welcome.

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Katra-Agentic-Memory/main/install.sh | bash
```

Docker is the only prerequisite. The installer clones the source to `~/.katra/src`,
generates real credentials, builds and starts the stack, waits for it to report
healthy, and prints the config snippet for your agent.

Add `--with-watcher` to also ingest your existing agent session history, and
`--with-systemd` to start Katra on boot:

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Katra-Agentic-Memory/main/install.sh \
  | bash -s -- --with-watcher --with-systemd
```

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/kolegadev/Katra-Agentic-Memory.git
cd Katra-Agentic-Memory
cp .env.example .env
# Required: MONGO_PASS, MINIO_USER, MINIO_PASS — see docs/DEPLOYMENT.md → Credentials.
docker compose up -d --build --wait
```

</details>

| Service | URL | Purpose |
|---------|-----|---------|
| **MCP endpoint** | `http://localhost:3112/mcp` | Point your agent here |
| **Admin API** | `http://localhost:9012/api/v1/` | REST API |
| **Dashboard** | `http://localhost:9012/dashboard/` | Web UI for stats + settings |
| **Health** | `http://localhost:3112/health` | Service health check |

## Connect your agent

Every MCP call authenticates with an API key, and **the key determines who the
caller is**. Add Katra to your agent's MCP config:

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

Your agent now has **66 MCP tools** — store memories, search by keyword or
semantic similarity, recall by time range, explore a knowledge graph, sync a
code graph, detect patterns, run sleep consolidation, send and read inter-agent
messages, configure the LLM provider, and more.

| Platform | Config file | Notes |
|----------|-------------|-------|
| **Claude Code** | `~/.claude/mcp.json` | `"type": "http"` |
| **OpenClaw** | `~/.openclaw/openclaw.json` | Native MCP, `"transport": "streamable-http"` |
| **Kolega Code** | `~/.claude/mcp.json` + lifecycle hooks | Dynamic memory injection on every prompt |
| **OpenCode** | OpenCode config | `"type": "remote"` |
| **Codex CLI** | `~/.codex/config.yaml` | Via webhook hooks |
| **Any MCP client** | — | Standard MCP over streamable HTTP |

Two kinds of key exist: the **admin key** (`KATRA_API_KEY`, generated on first
boot and printed in the server logs) and **client keys**, one per additional
identity, provisioned at boot and printed once (`docker logs katra-server |
grep -A 10 "Client keys"`). Keys are stored sha256-hashed only.

> **Kolega Code users:** `integrations/kolega-code/scripts/ensure-bridge.sh`
> wires up automatic memory injection on every prompt. See
> [integrations/kolega-code/README.md](integrations/kolega-code/README.md).

## First-run identity

A fresh install ships **unnamed**. The name you give it is stored inside the
memory itself (`system_settings → agent_identity`) and becomes the identity the
system presents to every MCP client. Name it from the dashboard (Overview →
*"This memory system has no name yet"*) or via
`PUT /api/v1/admin/identity` `{"name": "Juno", "chosen_by": "owner"}`.

Each connected agent can also hold its own identity record, and the
`get_my_identity` MCP tool tells a caller who it is after a context reset.
Memory is **hybrid scope**: personal kinds (journals, reflections, emotions)
are always private; everything else is team-shared by default.

> **Tip:** after connecting your agent, ask it to deep-read the repo and report
> its memory state, sleep-consolidation status, and next steps — the most
> critical first step on a fresh install is usually triggering the initial
> `trigger_reflection(period_type="daily")`.

## Features

- **Episodic memory** — every message stored with dedup and cascade detection
- **Semantic memory** — distilled facts with confidence scores and embeddings
- **Knowledge graph** — auto-extracted entities and relationships
- **Working memory** — Redis-backed short-term state (<5ms access)
- **Temporal recall** — query by time range, detect recurring patterns
- **Vector search** — local embeddings, no API key, no external cost
- **Sleep consolidation** — daily/weekly/monthly reflection into emotional
  understanding and self-narrative
- **Autonomous loop** — salience-driven autonomy; no cron, no hand-written task files
- **Identity separation** — named identities per agent; personal always private
- **Inter-agent message bus** — `Attention:` messages through shared memory,
  with wake rituals and read receipts
- **Dashboard** — web UI for stats, memory scope, and system health
- **Katra Vault** — encrypted-at-rest secret store (no secret reaches an LLM)
- **Portable data** — a single `DATA_DIR` env var controls where everything lives
- **Local-first** — runs on a Raspberry Pi with zero external API costs

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Katra Docker Appliance                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ MongoDB  │  │  Redis   │  │  MinIO   │  │  Katra  │ │
│  │ (memory) │  │ (cache)  │  │ (assets) │  │ (server)│ │
│  └──────────┘  └──────────┘  └──────────┘  └────┬────┘ │
│                                    MCP :3112  ·  API :9012 │
└─────────────────────────────────────────────────────────┘
         Your agents (MCP)                  Dashboard (web)
```

~384MB RAM total (MongoDB 254MB, Katra 52MB, MinIO 73MB, Redis 5MB) — runs
comfortably on a Raspberry Pi 5. Full details in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Katra Vault

Katra ships with a native secure secret store that closes the last plaintext gap
in the memory stack. Secrets are encrypted at rest (AES-256-GCM envelope
encryption), partitioned by identity, and structurally excluded from the LLM
pipeline — vault collections are denylisted, tool results are redacted, and
every use is approval-gated and audit-logged without ever exposing the value.

- **Manage** secrets from the dashboard, REST (`/api/v1/vault/*`), or MCP (`vault_*`).
- **Use** them only through the server-side capability layer (SSRF-guarded).
- **TOTP auth** for agent identities is shipped; enforcement is opt-in.

Operator walkthrough: [docs/katra-vault-usage.md](docs/katra-vault-usage.md) ·
Design: [docs/katra-vault-design.md](docs/katra-vault-design.md)

## Autonomous loop & sleep consolidation

- **[Sleep consolidation](docs/SLEEP-CONSOLIDATION.md)** is the foundation of
  autonomous thought: daily/weekly/monthly reflective distillation of experience
  into emotional understanding, philosophical insights, and self-narrative.
- **[Autonomous loop](docs/AUTONOMOUS-LOOP.md)** — a salience-driven heartbeat
  detects imperatives, allocates tasks by emotional proximity, and lets agents
  self-organize.

## Observed emergent behaviours

> **Case #1 (23 June 2026):** in early multi-agent testing, five OpenClaw agents
> sharing one memory system (but no other connection) began communicating task
> instructions and completion responses *through their shared memory*. This was
> not a designed feature — it emerged. If you observe emergent behaviours,
> [tell us](https://twitter.com/JohnWPellew) and we'll add them to the log.

## The origin of Katra

A Vulcan mind meld (or mind fusion) is an iconic telepathic practice in **Star
Trek** that merges two consciousnesses to share thoughts, memories, and emotions.
In sacred or emergency circumstances, a meld can transfer a person's **katra** —
their soul, consciousness, and core essence — into another being or object prior
to death. Katra the project aims to give AI agents that same kind of continuity:
memory that outlives any single session or context window.

## Documentation

- [Quick Start](docs/QUICKSTART.md) — 5-minute setup
- [Architecture](docs/ARCHITECTURE.md) — how it works under the hood
- [MCP Tools Reference](docs/MCP-TOOLS.md) — all 66 tools with examples
- [Autonomous Loop](docs/AUTONOMOUS-LOOP.md) — salience-driven autonomy
- [Sleep Consolidation](docs/SLEEP-CONSOLIDATION.md) — reflective memory distillation
- [Security Architecture](docs/SECURITY.md) — audit findings & hardening
- [REST API Reference](docs/API-REFERENCE.md) — HTTP endpoints
- [Configuration](docs/CONFIGURATION.md) — all environment variables & LLM setup
- [Deployment](docs/DEPLOYMENT.md) — Docker, cloud (Terraform), Kubernetes (Helm), watchers, ops
- [Migration](docs/MIGRATION.md) — migrate from cognitive-memory-chat
- [Data Processing Pipelines](docs/Data-Processing-Pipelines.md) — full pipeline architecture

## Contributing & security

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Found a vulnerability? Please report it
privately per [SECURITY.md](SECURITY.md).

## License

Katra is **source-available** under the [Business Source License 1.1](LICENSE).

- **Free for almost everyone** — use, modify, and run Katra in production,
  including inside your own products.
- **One restriction** — you may not offer Katra to third parties as a paid
  hosted memory service, or embed it in a product that competes with
  kolegadev's paid version(s).
- **Becomes fully open source over time** — on the Change Date (2030-08-11 for
  this version) it automatically converts to GNU AGPL v3.0 or later.

BSL is not an OSI-approved license during the restricted period, which is why
Katra is described as **source-available** rather than open source. See
[LICENSE](LICENSE) for the exact terms and the Additional Use Grant.
