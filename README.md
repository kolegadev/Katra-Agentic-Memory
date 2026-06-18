# Katra — Cognitive Memory as a Service for AI Agents

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Katra is open-source **memory infrastructure for AI agents**. It provides persistent, multi-layered memory — episodic events, semantic facts, knowledge graphs, working memory, and temporal recall — accessible through the Model Context Protocol (MCP) and a REST API.

Any MCP-compatible agent (OpenClaw, Claude Code, OpenCode, Codex CLI, or any platform that writes conversation logs) can connect and immediately gain long-term memory.

## Quick Start

```bash
git clone https://github.com/kolegadev/katra.git
cd katra
cp .env.example .env
# Edit .env — set your API key and LLM provider
docker compose up -d
```

Your Katra server is now running:
- **MCP endpoint:** `http://localhost:3100/mcp`
- **REST API:** `http://localhost:9002/api/v1`
- **Health:** `http://localhost:9002/api/v1/health`

Verify:
```bash
curl http://localhost:3100/health
# {"status":"ok","services":{"mongodb":"connected","redis":"connected"}}
```

## Connect Your Agent

### Any MCP-compatible platform

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

See [SKILL.md](SKILL.md) for platform-specific setup guides (OpenClaw, Claude Code, OpenCode, Codex CLI, Hermes, KiloClaw, KimiClaw).

### Python SDK

```python
from katra import KatraClient

katra = KatraClient(url="http://localhost:3100", api_key="your-katra-api-key")

# Store a memory
katra.store_memory(content="User prefers dark mode", category="preference")

# Search
results = katra.search_memories(query="user preferences")

# Semantic search
results = katra.vector_search(query="UI themes the user likes")
```

### TypeScript SDK

```typescript
import { KatraClient } from '@katra/sdk';

const katra = new KatraClient({ url: 'http://localhost:3100', apiKey: 'your-katra-api-key' });

// Store a memory
await katra.storeMemory({ content: 'User prefers dark mode', category: 'preference' });

// Search
const results = await katra.searchMemories({ query: 'user preferences' });
```

### REST API

```bash
# Store an episodic event
curl -X POST http://localhost:9002/api/v1/memory/episodic/events \
  -H "Authorization: Bearer your-katra-api-key" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"my-agent","session_id":"s1","event_type":"user_message","content":{"role":"user","message":"Hello Katra!"}}'

# Search
curl -X POST http://localhost:9002/api/v1/memory/episodic/search \
  -H "Authorization: Bearer your-katra-api-key" \
  -H "Content-Type: application/json" \
  -d '{"query":"hello","user_id":"my-agent"}'
```

## Auto-Collection

Katra includes a multi-platform watcher daemon that automatically ingests conversation logs:

```bash
# Install the watcher
cp watcher/katra_watcher.py ~/.katra/
cp watcher/watcher-config.example.json ~/.katra/watcher-config.json
# Edit config with your session directories and API key

# Backfill existing history
python3 ~/.katra/katra_watcher.py --once

# Install as systemd service for continuous collection
cp watcher/katra-watcher.service ~/.config/systemd/user/
systemctl --user enable --now katra-watcher
```

Supports OpenClaw, Claude Code, OpenCode, Codex CLI, Hermes, KiloClaw, KimiClaw, and any platform that writes JSONL session logs. See [SKILL.md](SKILL.md) for full setup.

## Features

- **Episodic Memory** — Every conversation message, tool call, system event stored with dedup and cascade detection
- **Semantic Memory** — Distilled facts with confidence scores and vector embeddings
- **Knowledge Graph** — Auto-extracted entities and relationships from conversations
- **Working Memory** — Redis-backed short-term session state (<5ms access)
- **Temporal Recall** — Query by time range, detect recurring patterns
- **Vector Search** — Semantic similarity search (local embeddings or OpenAI)
- **Background Processing** — Automatically extracts facts, builds graph, generates summaries
- **25 MCP Tools** — Store, search, recall, explore — all via standardized protocol
- **Multi-Platform Watcher** — Auto-ingest from 7+ agent platforms
- **Local-First** — Runs on a Raspberry Pi with zero external API costs

## Architecture

```
katra/
├── server/                 — Katra server (TypeScript, esbuild, Docker)
│   ├── src/
│   │   ├── services/       — 26 core memory services
│   │   ├── routes/         — 7 REST API route files
│   │   ├── database/       — MongoDB, Redis, migrations, indexes
│   │   ├── types/          — TypeScript type definitions
│   │   ├── mcp-server.ts   — MCP server (25 tools)
│   │   └── index.ts        — Entry point (REST API + MCP)
│   ├── esbuild.config.mjs  — Pi-compatible build
│   ├── package.json
│   └── tsconfig.json
├── watcher/                — Multi-platform session ingestion
│   ├── katra_watcher.py         — JSONL file watcher daemon
│   ├── katra_opencode_extractor.py — OpenCode SQLite extractor
│   ├── katra-watcher.service    — Systemd unit
│   └── watcher-config.example.json
├── sdks/
│   ├── python/             — Python SDK (katra-sdk)
│   └── typescript/         — TypeScript SDK (@katra/sdk)
├── dashboard/              — Web dashboard (vanilla HTML/CSS/JS)
├── scripts/
│   └── migrate_from_cognitive_memory.py — Migration script
├── docs/                   — Documentation
│   ├── ARCHITECTURE.md
│   ├── QUICKSTART.md
│   ├── MCP-TOOLS.md
│   ├── API-REFERENCE.md
│   ├── CONFIGURATION.md
│   ├── DEPLOYMENT.md
│   └── MIGRATION.md
├── docker-compose.yml      — MongoDB, Redis, MinIO, Katra server
├── Dockerfile
├── SKILL.md                — Multi-platform deployment guide
├── .env.example
└── LICENSE                 — MIT
```

## Documentation

- [Quick Start Guide](docs/QUICKSTART.md)
- [Architecture & Implementation Plan](docs/ARCHITECTURE.md)
- [MCP Tools Reference](docs/MCP-TOOLS.md)
- [REST API Reference](docs/API-REFERENCE.md)
- [Configuration Guide](docs/CONFIGURATION.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Migration from cognitive-memory-chat](docs/MIGRATION.md)
- [Multi-Platform Setup (SKILL.md)](SKILL.md)

## Deployment Tiers

| Tier | Target | Infrastructure |
|---|---|---|
| **Local Docker** | Developers, hobbyists | `docker compose up` — MongoDB, Redis, MinIO |
| **Cloud** | Teams, production | AWS/Azure/GCP Terraform modules, managed services |
| **Hosted SaaS** | No-infrastructure users | `api.katra.ai` — multi-tenant, billed per usage |

## How It Compares

| Feature | Katra | Mem0 | Zep | Pinecone |
|---|---|---|---|---|
| MCP-native | ✅ | ❌ | ❌ | ❌ |
| Multi-layered memory | ✅ (episodic + semantic + graph + working + temporal) | ❌ (flat) | Partial | ❌ (vector only) |
| Local-first (zero cost) | ✅ (Pi-compatible) | ❌ | ❌ | ❌ |
| Background processing | ✅ (auto-extract facts, build graph) | ❌ | Partial | ❌ |
| Multi-platform watcher | ✅ (7+ platforms) | ❌ | ❌ | ❌ |
| License | MIT | Apache 2.0 | MIT | Proprietary |

## License

MIT — see [LICENSE](LICENSE).
