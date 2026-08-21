# Quick Start Guide

Get Katra running in 5 minutes.

Katra is a self-hosted cognitive memory appliance. The memory system's founding
identity — the agent that lives on this machine — is **Satori**, so don't be
surprised when the server, scripts, and this guide use that name.

## Prerequisites

- **Docker** and **Docker Compose v2** (`docker compose`)
- Any MCP-compatible agent (optional — you can test via curl)

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Satori-Agentic-Memory/main/install.sh | bash
```

That is the whole thing. It clones the source to `~/.katra/src`, generates a
`.env` with real credentials, builds and starts all four containers (MongoDB,
Redis, MinIO and the Katra server), waits for them to report healthy, and prints
the config snippet for connecting your agent — including the machine's API key.

Add `--with-watcher` to ingest your existing agent session history, and
`--with-systemd` to start Katra on boot:

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Satori-Agentic-Memory/main/install.sh \
  | bash -s -- --with-watcher --with-systemd
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for every flag, and for the manual install if
you would rather do it by hand. Note that `MONGO_PASS`, `MINIO_USER` and
`MINIO_PASS` are **required** — compose refuses to start without them rather
than falling back to a known default — so a manual install means setting those
yourself. The installer generates them.

**Identity keys.** Katra resolves *who* is calling from the API key presented —
never from what a client claims. On first boot the server provisions the
per-identity client keys idempotently (`system_settings.client_keys`, sha256
hashes only) and prints the freshly generated Shoshin/Zanshin keys exactly once,
in a `Client keys (identity separation)` block in the server log. Hand those
keys to the named machines and store nothing else — a valid key with no
identity mapping is rejected with a loud 401, never silently accepted.

## 2. Verify

```bash
# Admin API health (no auth required)
curl http://localhost:9012/api/v1/health

# MCP health
curl http://localhost:3112/health

# The identity the memory holds for its own inhabitant (no auth)
curl http://localhost:9012/api/v1/admin/identity
```

You should see `{"status":"ok",...}` and an identity record (`name: Satori`).

Your admin key is `KATRA_API_KEY` in `.env` — presenting it authenticates you
as the trusted satori identity for admin operations. The installer also writes
a legacy `MCP_API_KEY` into `.env` (kept for the host-side watcher); the
per-machine client keys for the other identities (Shoshin, Zanshin) are printed
once in the server log:

```bash
grep '^KATRA_API_KEY=' ~/.katra/src/.env
docker logs katra-server | grep -A12 'Client keys (identity separation)'
```

Open the dashboard: **http://localhost:9012/dashboard/**

## 3. Store Your First Memory

The MCP endpoint is POST-only streamable HTTP at `/mcp`. Identity comes from
the key you present — a loopback call on this machine runs as trusted satori; a
remote machine presents its own client key:

```bash
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer your-api-key" \
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
  -H "Authorization: Bearer your-api-key" \
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
        "content": "Hello Satori! This is my first memory.",
        "category": "event"
      }
    }
  }'
```

No `user_id` argument needed: writes are stamped with the caller's own
identity. Under the shipped scope policy this event lands in the shared
`my-team` scope, so every identity can read it. Personal kinds — `journal`,
`reflection`, `emotional`, `insight` — are *always* private no matter what a
caller requests, and passing `"private": true` opts any other write out of the
shared scope.

## 4. Search Memories

```bash
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer your-api-key" \
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
        "query": "first memory"
      }
    }
  }'
```

Reads return the caller's own private memories plus the shared `my-team` scope.
Another identity's private memories are never visible.

## 5. Connect Your Agent

Add Katra to your agent's MCP config:

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "type": "http",
        "url": "http://localhost:3112/mcp",
        "headers": {
          "Authorization": "Bearer your-api-key",
          "Accept": "application/json, text/event-stream"
        }
      }
    }
  }
}
```

Use the machine's own client key, not another identity's. Restart your agent.
It now has **66** memory tools available — including the identity tools
(`get_my_identity`), the Satori Graph code-graph tools (`sync_code_graph`,
`scan_codebase`, `code_graph_status`), the Katra skill engine, and the
executive/cognitive tools.

## 6. Run the Test Suite

Katra includes a comprehensive vitest suite (unit + security + integration,
36 test files and 480+ test cases):

```bash
cd server
npm install
npm test                    # All tests
npm run test:unit           # Unit tests only
npm run test:security       # Security regression tests
npm run test:integration    # Integration tests (Docker stack required)
npm run test:coverage       # With coverage report
./tests/run-all.sh all      # Shell runner — same as npm test
```

Tests cover: API key hashing and client-key provisioning, caller identity
resolution (loopback / mapped / unmapped / legacy keys), the write-scope policy
and forced-private personal kinds, memory scope filtering, prototype pollution
prevention, user ID scoping, metadata sanitization, retry counter logic, route
authentication, admin gating, and input validation.

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

## 8. How Memory Scope Works

Hybrid mode with `shared_id: my-team` ships as the default — for the common
case there is nothing to configure:

- Personal kinds — `journal`, `reflection`, `emotional`, `insight` — are
  **always** private, even when a shared write is requested.
- Every other `store_memory` write defaults to the shared `my-team` scope,
  still stamped with the writer's `user_id`.
- Explicit `private: true` opts a write out of the shared scope.
- Reads return the caller's own private memories + `my-team` shared; another
  identity's private data is never visible.

To inspect or change the scope settings (admin-gated, use your admin key):

```bash
curl http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer your-admin-key"
```

```bash
curl -X PUT http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"mode": "hybrid", "shared_id": "my-team"}'
```

The `set_memory_scope` MCP tool is equivalent, and is likewise admin-gated.

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
plain JSONL. Each extractor runs on its own machine and must present that
machine's client key; writes are then stamped with that machine's identity:

| Platform | Command |
|----------|---------|
| **OpenCode** (iMac) | `python3 ~/.katra/satori_opencode_extractor.py --once --api-key <zanshin-key> --user-id zanshin` |
| **Claude Code** (this machine) | `python3 ~/.katra/claude_history_extractor.py --once --api-key <satori-key> --user-id satori` |
| **Kolega Code** (iMac trading) | `python3 ~/.katra/kolega_code_extractor.py --once --api-key <shoshin-key> --user-id shoshin` |

On macOS the installer uses launchd instead of systemd. A ready-made agent
template ships at `watcher/com.satori.watcher.plist.template` — there is no
longer anything to hand-write.

## Next Steps

- [MCP Tools Reference](MCP-TOOLS.md) — All 66 tools with examples
- [REST API Reference](API-REFERENCE.md) — HTTP endpoints
- [Security Policy](SECURITY.md) — Security architecture and vulnerability reporting
- [Configuration Guide](CONFIGURATION.md) — All environment variables
- [Deployment Guide](DEPLOYMENT.md) — Cloud, K8s, Raspberry Pi
- [OpenClaw Integration Guide](OPENCLAW-INTEGRATION.md) — Complete OpenClaw setup with lessons learned
- [Agent Communication Setup](AGENT-COMMUNICATION-SETUP.md) — Inter-agent messaging over shared memory
- [Agent Pub-Sub Guide](AGENT-PUBSUB-GUIDE.md) — The complementary Redis presence/topic bus
- [Identity Separation Contract](contracts/identity-separation.md) — The key-based identity model
- [Kolega Code Bridge](../integrations/kolega-code/README.md) — Automatic memory injection for Kolega Code
- [Sleep Consolidation](SLEEP-CONSOLIDATION.md) — Reflective memory distillation
- [Data Processing Pipelines](Data-Processing-Pipelines.md) — Full pipeline architecture
