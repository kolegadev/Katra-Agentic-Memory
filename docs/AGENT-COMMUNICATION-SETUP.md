# Agent-to-Agent Communication Setup Guide

> **How the three identities — Satori, Shoshin and Zanshin — talk to each other
> through Katra shared memory: thought messages, task syndication, read receipts.**

---

## Overview

The inter-agent bus is ordinary memory. A message is a `store_memory` event in
the shared scope whose text starts with an `Attention: <AgentName>` header.
Because non-personal writes default to the shared `my-team` scope, a message
written by one identity is visible to all of them on the next read.

```
Satori:  store_memory("Attention: Shoshin — the fix is merged")
            →  Katra shared pool (my-team)
            →  Shoshin's wake ritual / bridge bulletin discovers it
            →  Shoshin replies: store_memory("Attention: Satori — thanks, verifying")
```

There is no separate message store, queue, or API: messages are memories, and
the existing scope policy routes them. (A complementary Redis presence/topic
bus also exists — see [AGENT-PUBSUB-GUIDE.md](AGENT-PUBSUB-GUIDE.md) — but the
shared-memory `Attention:` channel is the durable message-of-record.)

## Step 1: Scope Policy — nothing to configure

Hybrid mode with `shared_id: my-team` ships as the default:

- Non-personal `store_memory` writes land in `my-team` automatically, stamped
  with the writer's `user_id`.
- Personal kinds (`journal`, `reflection`, `emotional`, `insight`) are always
  private; `private: true` opts any other write out of the shared scope.
- Reads return the caller's own private memories + `my-team` shared.

Check the current scope (admin-gated):

```bash
curl -s http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer $KATRA_API_KEY"
```

> **Legacy note:** the old flow where each agent called `set_memory_scope`
> with `mode`, `shared_id`, and `hybrid_visible_user_ids` is superseded — the
> scope is a system-level setting (`my-team`, hybrid, visible-ids pinned to
> `[]`), and `set_memory_scope` / `PUT /api/v1/admin/memory-scope` are
> admin-gated.

## Step 2: Each Machine Presents Its Own Identity Key

Identity is resolved from the API key, so each machine's MCP client must
present its own client key — never another identity's and never a retired
pre-cutover shared key (those get a loud 401).

### OpenCode on the iMac desktop (Zanshin) — `~/.config/opencode/opencode.jsonc`

```jsonc
{
  "mcp": {
    "katra": {
      "type": "remote",
      "url": "http://<katra-host>:3112/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer <zanshin-key>",
        "Accept": "application/json, text/event-stream"
      }
    }
  }
}
```

(`<katra-host>` is the server's address — on the iMacs, `localhost` only
reaches Katra on the server machine itself.)

### Kolega Code on the iMac trading terminal (Shoshin) — bridge hook config

The bridge reads `satori-hook.json` from the Kolega Code state dir (macOS:
`~/Library/Application Support/kolega-code/`; the older `katra-hook.json`
filename is legacy). It holds `mcp_url` / `api_key` / `user_id` / `sources`:

```json
{
  "mcp_url": "http://<katra-host>:3112/mcp",
  "api_key": "<shoshin-key>",
  "user_id": "shoshin",
  "shared_id": "my-team",
  "enabled": true,
  "timeout_seconds": 8,
  "max_context_tokens": 5000,
  "sources": ["working_memory", "temporal_context", "vector_search", "temporal_recall"],
  "cache_ttl_seconds": 30,
  "debug": false
}
```

`ensure-bridge.sh` writes and rewrites this config itself (see Step 3); set
`KATRA_USER_ID=shoshin` and `KATRA_HOST=<katra-host>` when you run it, and the
config is rewritten when either the `user_id` or the `mcp_url` host differs
from `KATRA_HOST`.

## Step 3: Install the Kolega Code Bridge

The bridge injects relevant memories on every `UserPromptSubmit` (sources
`working_memory`, `temporal_context`, `vector_search`, `temporal_recall`) and
surfaces inter-agent messages as a 🔔 **INTER-AGENT BULLETIN**. Installation is
one idempotent script that also registers the update-proof command hooks:

```bash
cd ~/Katra-Agentic-Memory/integrations/kolega-code

# Per-machine identity: shoshin on the iMac trading terminal,
# zanshin on the iMac OpenCode desktop, satori on this machine.
KATRA_USER_ID=shoshin KATRA_HOST=<katra-host> bash scripts/ensure-bridge.sh
```

What it does: builds the bridge venv, writes `satori-hook.json`
(`mcp_url`/`api_key`/`user_id`/`sources`), registers `SessionStart` +
`UserPromptSubmit` command hooks in the state dir's `hooks.json`, and runs a
live self-test. The command-hook path runs from the repo's own venv, so
`kolega-code update` (which rebuilds the CLI venv and used to drop the bridge —
the 2026-08-20 amnesia incident) can no longer break memory.

> The old installation method (installing `kolega_katra_bridge` into the CLI's
> uv tool venv via `uv pip install --python ~/.local/share/uv/tools/kolega-code/bin/python .`)
> is **legacy** — CLI updates silently drop it. Re-run `ensure-bridge.sh` after
> every `kolega-code update` (a self-healing cron guard is recommended).

The key can come from `KATRA_API_KEY`, from `KATRA_API_KEY_FILE`
(default `~/.katra/keys/katra-<user>.key`), or from an explicit value already
in the hook config.

## Step 4: Extractors Write Under Their Machine's Identity

Extractors push agent session logs into Katra. Under identity separation the
server pins untrusted callers to the identity their key maps to, so run each
extractor on its own machine with that machine's key and user_id:

### Kolega Code extractor (iMac trading — LaunchAgent)

```xml
<string>/Users/YOUR_USERNAME/.katra/kolega_code_extractor.py</string>
<string>--api-key</string>
<string><shoshin-key></string>
<string>--user-id</string>
<string>shoshin</string>
```

### OpenCode extractor (iMac desktop — LaunchAgent)

```xml
<string>/Users/YOUR_USERNAME/.katra/satori_opencode_extractor.py</string>
<string>--mcp-url</string>
<string>http://<katra-host>:3112/mcp</string>
<string>--api-key</string>
<string><zanshin-key></string>
<string>--user-id</string>
<string>zanshin</string>
```

No `--shared-id` argument is needed: non-personal writes default to the shared
`my-team` scope.

## Step 5: The Thought-Comm Protocol

### Sending a message

Store an episodic event with an `Attention: <AgentName>` header:

```
Attention: Shoshin — can you review the auth module? There's a race condition
in the token refresh. Details in katra/auth-race-condition.
```

**Via MCP (preferred — from your agent):**

```
store_memory(category="event", content="Attention: Shoshin — ...")
```

The write defaults to the shared `my-team` scope, so every identity's reads
pick it up. (For `store_memory`, the writer's identity comes from the
presented key — there is no `user_id` argument to spoof.)

**Via REST API (loopback / admin key):**

```bash
curl -s -X POST http://localhost:9012/api/v1/memory/episodic/events \
  -H "Authorization: Bearer $KATRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"satori","event_type":"conversation",
       "content":"Attention: Shoshin — message here",
       "session_id":"satori-comm","metadata":{"source":"agent-communication"}}'
```

### Receiving messages

Messages surface through two mechanisms:

1. **Wake rituals** — every identity's wake script (`satori-wake.sh` on this
   machine; `wake-shoshin.sh` / `wake-zanshin.sh` on the iMacs) prints a
   *messages from the team* section that queries:

   ```
   search_memories(query: '"Attention: Shoshin" OR "Attention: Satori" OR "Attention: Zanshin"', limit: 5)
   ```

   Run the ritual at the start of every session; it survives `/clear`,
   `/compress`, and code updates.

2. **Kolega Code bridge** — on every prompt the bridge scans for
   `Attention: Satori/Shoshin/Zanshin` (plus the legacy OpenCode/KolegaCode
   aliases) and surfaces hits as a 🔔 **INTER-AGENT BULLETIN** at the top of
   context. For OpenCode, query directly via MCP:

   ```
   search_memories("Attention: Zanshin", limit: 5)
   ```

### Read receipts

When the bridge surfaces a bulletin into a turn's context, it posts a
fire-and-forget receipt event tagged
`["background-ack", "read-receipt", "agent-message"]` so senders can see their
bulletins were picked up. Wake services and bulletin scans skip `background-ack`
events, so receipts never surface as new messages.

### Responding

```
Attention: Satori — received. Looking at the auth module now. Will report back.
```

Replies are just more `store_memory` events in the shared scope; the reply's
`Attention:` header routes it back.

## Step 6: Back Channel Agent Pattern (Optional)

Dedicate a sub-agent to handle comms in parallel with main work. This is an
optional pattern layered on the same shared-memory bus — the sub-agent reads
and writes `Attention:` events like everyone else:

- Search for `Attention: <you>` messages (or the full team query from Step 5).
- Respond to any found, and post receipts where the mechanism supports it.
- Report findings to the main agent's context.

On OpenCode, use the `task` tool with `subagent_type: general`; on Kolega Code,
use the platform's sub-agent dispatch (e.g. the gigacode workflow
orchestration) to spawn a back-channel worker that runs the search-and-reply
loop against `search_memories` + `store_memory`.

## Common Pitfalls & Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Messages not found | Written with `private: true`, or as a personal kind | journal/reflection/emotional/insight are always private; send messages as `category="event"` without `private` |
| 401 on every write from a remote machine | Legacy pre-cutover key, or a key not mapped to an identity | Use the machine's own client key (provisioned at boot, printed once in the server log) |
| Fresh start knows nothing | Bridge dropped by a CLI update | Re-run `ensure-bridge.sh` with the right `KATRA_USER_ID`; use the update-proof command hooks |
| "Server not initialized" | MCP session expired after restart | Restart agent — bridge auto-negotiates session |
| vector_search returns empty | Embeddings model loading | Use `search_memories` instead (no embeddings needed) |
| Receipts showing up as messages | Wake scan not skipping acks | Receipts are tagged `background-ack`; wake services skip them — make sure your scan does too |
| Extractor writes to wrong scope | Extractor run on the wrong machine / with the wrong key | Extractors must run with their own machine's client key; untrusted callers are pinned to their key's identity |

## Verification Checklist

```bash
# 1. Katra health
curl -s http://localhost:9012/api/v1/health

# 2. System identity (no auth)
curl -s http://localhost:9012/api/v1/admin/identity

# 3. Memory scope (admin key)
curl -s http://localhost:9012/api/v1/admin/memory-scope \
  -H "Authorization: Bearer $KATRA_API_KEY"

# 4. Search for inter-agent messages (each machine's own key)
#    MCP: search_memories("Attention: Shoshin" OR "Attention: Satori"
#         OR "Attention: Zanshin", limit: 5)

# 5. Bridge health (Kolega Code machine)
bash ~/Katra-Agentic-Memory/integrations/kolega-code/scripts/ensure-bridge.sh

# 6. Wake ritual (per identity)
bash ~/.kolega/wake-shoshin.sh      # iMac trading
bash ~/.kolega/wake-zanshin.sh      # iMac OpenCode desktop
bash ~/.kolega/satori-wake.sh       # this machine

# 7. Extractors running
launchctl list | grep katra
```

## Reference

- [Identity Separation Contract](contracts/identity-separation.md) — the key-based identity model
- [Identity Cutover Runbook](runbook-identity-cutover.md) — Shoshin/Zanshin cutover history
- [Kolega Code Bridge](../integrations/kolega-code/README.md) — bridge installation and config
- [Agent Pub-Sub Guide](AGENT-PUBSUB-GUIDE.md) — the complementary Redis presence/topic bus
- Katra MCP tools: `docs/MCP-TOOLS.md`
- Loop Director workflow: `docs/AUTONOMOUS-LOOP.md`
