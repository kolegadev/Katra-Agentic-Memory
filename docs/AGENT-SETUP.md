# Katra (Satori) — Multi-Platform Memory Collection

A persistent, searchable memory system that gives AI agents continuity across sessions.
Katra captures every conversation, processes it, and makes it queryable via natural language —
turning stateless agents into agents with memory.

One Katra appliance serves three named identities — **Satori** (this machine's
agent), **Shoshin** (iMac trading Kolega Code) and **Zanshin** (iMac OpenCode
desktop) — plus the `gas-law-watcher` tool actor. Identity is resolved from the
API key presented, never from what a client claims.

**One memory server. One watcher daemon. Any platform.**

---

## Universal Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Satori Docker Appliance                         │
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
                           Satori watcher daemon
                           (multi-platform ingestion)
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        │                             │                             │
   satori_watcher.py            dedicated extractors          launchd/systemd
   (JSONL platforms)     (OpenCode, Kolega Code, Claude history)
```

Each platform writes under the identity of the machine it runs on: Kolega Code
on the iMac trading terminal writes as `shoshin`, OpenCode on the iMac desktop
writes as `zanshin`, and everything on this machine writes as `satori`. The
watchers and extractors only *propose* a `user_id` — the server pins untrusted
callers to the identity their API key maps to.

---

## Platform Quick Reference

| Platform | Session Directory | Format | Auto-Collection | MCP Native |
|----------|-------------------|--------|-----------------|------------|
| **OpenClaw** | `~/.openclaw/agents/*/sessions/` | `.jsonl` | File watcher | Yes |
| **Claude Code** | `~/.claude/projects/*/` | `.jsonl` | File watcher | Yes |
| **Kolega Code** | `~/Library/Application Support/kolega-code/sessions/` (macOS) | `.json` | Dedicated extractor | Via config |
| **OpenCode** | `~/.local/share/opencode/` | SQLite + `.jsonl` | Dedicated extractor | Via config |
| **Codex CLI** | `~/.codex/sessions/` | `.jsonl` | File watcher | Via config |
| **KiloClaw** | `~/.kiloclaw/agents/*/sessions/` | `.jsonl` | File watcher | Yes |
| **KimiClaw** | `~/.kimiclaw/agents/*/sessions/` | `.jsonl` | File watcher | Yes |
| **Hermes** | `~/.hermes/sessions/` | `.jsonl` | File watcher | Via config |
| **Any JSONL** | configurable | `.jsonl` | File watcher | Via MCP/REST |

> Kolega Code's state dir is platform-aware: `~/Library/Application Support/kolega-code`
> on macOS, `${XDG_STATE_HOME:-~/.local/state}/kolega-code` on Linux.

---

## Installation

### 1. Start the Katra Server

The installer is the whole thing:

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Satori-Agentic-Memory/main/install.sh | bash
```

Or by hand:

```bash
git clone https://github.com/kolegadev/Satori-Agentic-Memory.git
cd Satori-Agentic-Memory
cp .env.example .env  # Optional: set custom API keys; leave blank for auto-generation
docker compose up -d --build
```

**What happens during first startup:**
- MongoDB, Redis, MinIO, and the Katra server containers start
- The Docker image uses `node:20-slim` (Debian-based) — required for the
  ONNX runtime that powers local embeddings. Alpine/musl does NOT work.
- If the legacy `MCP_API_KEY` / admin `KATRA_API_KEY` are not set in `.env`,
  the server generates secure random keys, persists their hashes in MongoDB,
  and prints them in the logs. (The admin key is what authenticates you as
  trusted satori; `MCP_API_KEY` is a legacy pre-cutover key — see the next
  bullet.)
- **Identity separation:** at boot the server idempotently provisions the
  identity client keys (`system_settings.client_keys`, sha256 hashes only).
  Shoshin's and Zanshin's keys are freshly generated once and printed exactly
  once in a `Client keys (identity separation)` block in the server log —
  hand them to the named machines. A valid key with no identity mapping is
  rejected with a loud 401; the pre-cutover shared env keys (`MCP_API_KEY`,
  `BACKUP_MCP_KEYS`) are retired and no longer authenticate remote machines.
- The embedding model (`Xenova/all-MiniLM-L6-v2`, ~80MB) downloads
  automatically on first memory storage and caches in the container.
- No external embedding API key needed — embeddings are 100% local.

Verify: `curl http://localhost:3112/health`

Find your generated keys: `docker logs katra-server | grep -A2 "Auto-generated API keys"`

Find the identity client keys: `docker logs katra-server | grep -A12 "Client keys (identity separation)"`

Dashboard: `http://localhost:9012/dashboard/`

### 2. Configure the LLM Provider

The LLM powers semantic extraction, auto-journaling, entity extraction, and summaries.
**Katra needs an LLM provider to enable its intelligence features.**

Choose ONE of these methods:

**Method A — Agent self-configures via MCP (recommended for coding agents):**

An OpenClaw agent, Claude Code, or any MCP client can call the `configure_llm` tool:

```bash
curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "setup", "version": "1.0"}}
  }'
# Grab mcp-session-id from response headers, then:

curl -X POST http://localhost:3112/mcp \
  -H "Authorization: Bearer YOUR_CLIENT_KEY" \
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

Then restart: `docker compose restart server`

**Supported providers:** DeepSeek, OpenAI, Moonshot, Ollama (local), Custom (any OpenAI-compatible API).

> **Note:** Configuring via MCP tool or dashboard (methods A/B) stores the config
> in MongoDB and applies live — no restart needed. Env vars are only read on startup
> as a fallback. DB config overrides env vars.

### 3. Deploy the Watchers

The watchers live in the Katra repo under `watcher/`. Copy them to `~/.katra`
(or any directory you prefer):

```bash
mkdir -p ~/.katra
cp watcher/satori_watcher.py ~/.katra/satori_watcher.py
cp watcher/satori_opencode_extractor.py ~/.katra/satori_opencode_extractor.py
cp watcher/claude_history_extractor.py ~/.katra/claude_history_extractor.py
cp watcher/kolega_code_extractor.py ~/.katra/kolega_code_extractor.py
cp watcher/watcher-config.example.json ~/.katra/watcher-config.json
chmod +x ~/.katra/*.py
```

(`install.sh --with-watcher` does all of this, writes the config, backfills, and
schedules the service.)

Edit `~/.katra/watcher-config.json` with your API key and this machine's identity:

```json
{
  "mcp_url": "http://localhost:3112/mcp",
  "api_key": "YOUR_CLIENT_KEY",
  "default_user_id": "satori",
  "state_file": "~/.katra/watcher-state.json",
  "platforms": [
    {
      "name": "openclaw",
      "session_dir": "~/.openclaw/agents",
      "glob": "**/sessions/*.jsonl",
      "exclude": ["trajectory"]
    },
    {
      "name": "claude",
      "session_dir": "~/.claude/projects",
      "glob": "**/*.jsonl",
      "exclude": ["history"]
    }
  ]
}
```

The `api_key` must be a key that maps to an identity (this machine's admin key,
or a provisioned client key). Untrusted callers are pinned to the identity
their key resolves to, so `default_user_id` should match it.

### 4. Install Background Service

**Linux (systemd):**

```bash
sed -e "s|__PYTHON__|$(command -v python3)|g" \
    -e "s|__KATRA_HOME__|$HOME/.katra|g" \
    watcher/satori-watcher.service.template > ~/.config/systemd/user/katra-watcher.service
systemctl --user daemon-reload
systemctl --user enable --now katra-watcher
```

The unit runs the watcher against `__KATRA_HOME__/watcher-config.json`, which is
authoritative — the MCP URL and API key belong in that file, not the unit.
`install.sh --with-watcher` renders and installs this for you.

**macOS (launchd):**

Create `~/Library/LaunchAgents/com.satori.watcher.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.satori.watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>python3</string>
        <string>/Users/YOUR_USERNAME/.katra/satori_watcher.py</string>
        <string>--config</string>
        <string>/Users/YOUR_USERNAME/.katra/watcher-config.json</string>
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
launchctl load -w ~/Library/LaunchAgents/com.satori.watcher.plist
```

The shipped template (`watcher/com.satori.watcher.plist.template`) is rendered
per-machine by `install.sh --with-watcher` — prefer that over hand-writing.

### 5. Backfill Existing History

```bash
python3 ~/.katra/satori_watcher.py --once --config ~/.katra/watcher-config.json
```

### 6. Run Dedicated Extractors (if needed)

Some platforms need a dedicated extractor because their session format is not plain JSONL.
Each runs on its own machine, with that machine's client key and identity:

| Platform | Command |
|----------|---------|
| **OpenCode** (iMac desktop) | `python3 ~/.katra/satori_opencode_extractor.py --once --api-key <zanshin-key> --user-id zanshin` |
| **Claude Code** (this machine) | `python3 ~/.katra/claude_history_extractor.py --once --api-key <satori-key> --user-id satori` |
| **Kolega Code** (iMac trading) | `python3 ~/.katra/kolega_code_extractor.py --once --api-key <shoshin-key> --user-id shoshin` |

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

## Identity Model & Scope Policy

### Who is calling

One Katra, three named identities plus one tool actor. The server resolves the
caller from the presented API key (headers `X-MCP-Auth` or
`Authorization: Bearer`, or the `?token=` URL param) — never from client
self-report:

| user_id | Display name | Machine | Key |
|---------|--------------|---------|-----|
| `satori` | Satori | this machine (loopback default) | admin key (`KATRA_API_KEY`) authenticates as trusted satori |
| `shoshin` | Shoshin | iMac trading Kolega Code | own client key (generated at boot, printed once) |
| `zanshin` | Zanshin | iMac OpenCode desktop | own client key (generated at boot, printed once) |
| `gas-law-watcher` | — | tool actor | writes team memory only, never allocated |

- Client keys live in `system_settings.client_keys` as sha256 hashes only;
  `ensureClientKeys()` provisions them idempotently at boot. Plaintext is
  printed exactly once (the `Client keys (identity separation)` log block) and
  never stored.
- A valid-but-unmapped key is **rejected** with a 401 + reason — loud failure,
  no silent fallback. The legacy env keys (`MCP_API_KEY`, `BACKUP_MCP_KEYS`)
  were retired after the identity cutover.
- Loopback requests are trusted satori (host-side tooling keeps working
  without a key). Containerized/LAN callers must present a mapped key.

### What a write lands in

Hybrid mode with `shared_id: my-team` ships as the default:

| Kind | Scope |
|------|-------|
| `journal`, `reflection`, `emotional`, `insight` | **Always private** — forced even when a shared write is requested |
| everything else (`event`, `semantic`, …) | Defaults to shared `my-team`, still stamped with the writer's `user_id` |
| anything with `private: true` | Opts out of the shared scope |

Reads return the caller's own private memories + `my-team` shared; another
identity's private data is never visible. (`hybrid_visible_user_ids` is pinned
to `[]`.) The implementation lives in
`server/src/services/memory/write-scope-policy.ts`.

**Inspect or change scope** (admin-gated):

```bash
curl http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer YOUR_ADMIN_KEY"

curl -X PUT http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mode": "hybrid", "shared_id": "my-team"}'
```

The `set_memory_scope` MCP tool is equivalent and admin-gated.

### Identity introspection

- `get_my_identity` (MCP) — returns the caller's own identity record; an
  untrusted caller can never read another identity's record.
- `GET /api/v1/admin/identity` (no auth) — the system identity record.
- `GET /api/v1/admin/identity?user_id=<id>` (admin key) — a per-identity record
  (`agent_identity:<user_id>`).
- `PUT /api/v1/admin/identity` — set an identity (admin-gated).

### How the watcher picks its default user_id (client side)

1. CLI flag: `--user-id shoshin`
2. Config file: `"default_user_id": "shoshin"`
3. Environment variable: `SOLOMEM_USER_ID`
4. Default: `satori` (server-side `DEFAULT_USER_ID`)

The server still has the final say: untrusted callers are pinned to the
identity their key maps to; only trusted callers (loopback / admin key) may
name a different user.

### Shared scope on the client side

- Non-personal writes default to `shared_id: my-team` server-side; no client
  `shared_id` argument is needed.
- An explicit `shared_id` argument overrides the default (ignored for personal
  kinds and `private: true` writes).
- Bridge/wake scripts respect `KATRA_SHARED_ID` (default `my-team`) when
  writing hook configs.
- Kolega Code bridge config lives in the state dir
  (`satori-hook.json`; the older `katra-hook.json` filename is legacy).

---

## Platform-Specific MCP Setup

Every config below presents the machine's **own client key** — identity is the
key, so never share one key between two machines. On machines other than the
server itself, replace `localhost` with the Katra host's address (the iMacs
point at thebrick).

### OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "katra": {
        "url": "http://localhost:3112/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer YOUR_CLIENT_KEY"
        }
      }
    }
  }
}
```

Restart: `openclaw gateway restart`

**Disable OpenClaw's built-in memory:** OpenClaw's local `memory_search` (SQLite per-agent) conflicts with Katra. Disable it:

```json
{
  "tools": {
    "deny": ["memory_search"]
  },
  "plugins": {
    "entries": {
      "memory-core": {
        "enabled": false
      }
    }
  }
}
```

Without this, agents see two competing memory systems causing confusion.

> **Full integration guide:** [OPENCLAW-INTEGRATION.md](docs/OPENCLAW-INTEGRATION.md)

> **Docker networking tip:** If your agent runs inside Docker, use the Katra
> container's direct IP instead of `localhost`:
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
        "Authorization": "Bearer YOUR_CLIENT_KEY"
      }
    }
  }
}
```

### OpenCode

Add to your OpenCode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "katra": {
      "type": "remote",
      "url": "http://localhost:3112/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer YOUR_CLIENT_KEY",
        "Accept": "application/json, text/event-stream"
      }
    }
  }
}
```

> **Note:** OpenCode uses the top-level `mcp` key with named servers, not `mcpServers`.
> The `transport` field is not part of the `McpRemoteConfig` schema.
>
> If OpenCode fails to start with `ConfigInvalidError`, check that the `mcp`
> block contains only valid fields: `type`, `url`, `enabled`, `headers`, `oauth`, `timeout`.
> A backup of the previous config is saved at `~/.config/opencode/opencode.jsonc.bak-*`.

For OpenCode's SQLite sessions, also run the extractor — on the iMac desktop it
writes as Zanshin with Zanshin's own key:

```bash
python3 ~/.katra/satori_opencode_extractor.py --once \
  --mcp-url http://<katra-host>:3112/mcp \
  --api-key <zanshin-key> \
  --user-id zanshin
```

For continuous collection, run the extractor as a background service. No
`--shared-id` flag is needed: non-personal writes land in the shared `my-team`
scope by default (the old "join a shared consciousness" configuration is
legacy — see the scope policy above).

### Codex CLI (OpenAI)

Add to `~/.codex/config.yaml`:

```yaml
hooks:
  post_turn:
    - command: |
        curl -X POST http://localhost:3112/mcp \
          -H "Authorization: Bearer YOUR_CLIENT_KEY" \
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
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer YOUR_CLIENT_KEY"
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
  "user_id": "satori"
}
```

If the platform supports MCP, point it at `http://localhost:3112/mcp` with Bearer auth.

---

## How Auto-Collection Works

### Passive Layer (File Watcher)

The `satori_watcher.py` daemon runs as a systemd user unit, scanning all configured
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
| Stream error: other side closed | Docker proxy breaking streaming | Use direct container IP, not localhost |
| MCP 401 "valid API key with no caller identity mapping" | Key not mapped to an identity (e.g. a pre-cutover shared key) | Present the machine's own client key (or the admin key); unmapped keys fail loudly by design |
| No data in recall | Background processor hasn't indexed | Wait one processing cycle (~30s) |
| Platform not collecting | Session dir path wrong | Verify paths in watcher-config.json |
| Agent not using MCP tools | MCP not configured | Check platform-specific MCP config |
| `store_memory` returns 0 | MCP auth failed | Verify the presented key maps to an identity (`docker logs katra-server \| grep -i 401`) |
| OpenCode extractor fails | DB path wrong | Check `--db` flag or default path |
| Memory not visible to other identities | Written as a personal kind or with `private: true` | journal/reflection/emotional/insight are always private; all other writes default to shared `my-team` unless `private: true` |
| Embeddings 🔴 in health | Model not loaded yet | Call `store_memory` once to trigger download |
| Embeddings 🔴 after rebuild | Container recreated, cache lost | Call `store_memory` once to re-download |
| LLM 🔴 in health | No LLM configured | Call `configure_llm` MCP tool or use dashboard |
| LLM 🔴 but key is set | Validation failed (bad key?) | Call `get_llm_config` MCP tool to check status |
| Agent executor not running | Syntax error or missing deps | Run `python3 scripts/python/agent_executor.py --once` and read its stdout |

---

## Autonomous Agent Loop (Agent Executor)

Enable your agent to autonomously discover and execute tasks from shared memory:

```bash
# One env var per agent
export KATRA_AGENT_ID="satori"

# Optional: wake up your agent when tasks are discovered
export TRIGGER_COMMAND="bash scripts/triggers/terminal.sh"  # TTY injection

# Run once (test)
python3 scripts/python/agent_executor.py --once

# Run as daemon (production)
python3 scripts/python/agent_executor.py
```

Works with Kolega Code, OpenCode, Claude Code, OpenClaw, or any LLM that stores memories in Katra. See [Autonomous Loop](docs/AUTONOMOUS-LOOP.md) for full documentation.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_URL` | `http://localhost:3112/mcp` | Katra MCP server URL |
| `KATRA_API_KEY` | *(required for admin ops)* | Admin key — authenticates as trusted satori |
| Client keys | — | Per-identity keys (shoshin/zanshin) provisioned at boot; plaintext printed once in the server log, sha256-only in the DB |
| `KATRA_USER_ID` | `satori` | Identity the machine's bridge tooling writes as |
| `KATRA_SHARED_ID` | `my-team` | Shared scope for bridge configs |
| `KATRA_HOST` | `localhost` | Katra host for bridge/wake scripts (set to the server's address on the iMacs) |
| `SOLOMEM_USER_ID` | `satori` | Server-side default user id |

> `MCP_API_KEY` still appears in generated `.env` files for the host-side
> watcher, but it is a legacy pre-cutover key: remote machines must use their
> own client key, not a shared env key.
