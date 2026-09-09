# Kolega ⇄ Katra Bridge

Dynamic Katra memory retrieval for Kolega Code.

This package is part of the Katra repo (`integrations/kolega-code`). It
provides Kolega Code lifecycle hooks that automatically fetch memories from
Katra on `SessionStart` (bootstrap from all sources) and on every
`UserPromptSubmit` (query-driven retrieval), then inject them into the
agent's context. A `SessionClear` handler re-injects identity after `/clear`
for CLIs that fire that event.

## Identity separation (2026-08-21 cutover)

One Katra, any number of named identities. Katra resolves the calling
identity from the API key presented on each request — never from a
client-declared `user_id`. This bridge is installed per machine with that
machine's identity and its own client key (key files live under
`~/.katra/keys/katra-<user>.key`; the admin `KATRA_API_KEY` authenticates as
the trusted machine identity).

Key facts:

- Client keys live in `system_settings.client_keys` as sha256 hashes only.
  The server provisions them idempotently at boot (`ensureClientKeys()`);
  the plaintext keys for additional identities are printed once in the
  "Client keys (identity separation)" block of the server log and are never
  stored.
- A valid-but-unmapped key is REJECTED with 401 + reason — loud failure, no
  silent fallback to a default identity. The legacy env keys `MCP_API_KEY`
  and `BACKUP_MCP_KEYS` were retired at the cutover and no longer
  authenticate.
- `user_id` in the hook config is not a login. It must match the identity
  the machine's key maps to, and it scopes the shared-memory queries the
  bridge makes.

## Why the hook must be a command, not an in-process import

`kolega-code update` runs `uv tool install --force --upgrade kolega-code`,
which **rebuilds the CLI venv and silently drops packages installed into
it**. With python-type hooks this leaves the bridge unimportable, every hook
fails open, and the agent wakes with amnesia while its memory is perfectly
intact — the 2026-08-20 incident. The fix: register the bridge as a
**command hook** that runs from this repo's own venv. The CLI spawns a
subprocess and never imports the bridge, so updates cannot break it.

## Installation

One idempotent script does everything (repo venv, best-effort CLI-venv
install, hook config, hooks.json, live self-test):

```bash
bash /path/to/Katra-Agentic-Memory/integrations/kolega-code/scripts/ensure-bridge.sh
```

On each additional machine, run the same script with the machine's own
identity and the Katra host, so the hook config and key file are
per-identity:

```bash
KATRA_USER_ID=agent-b KATRA_HOST=<katra-host-address> bash /path/to/Katra-Agentic-Memory/integrations/kolega-code/scripts/ensure-bridge.sh
KATRA_USER_ID=agent-c KATRA_HOST=<katra-host-address> bash /path/to/Katra-Agentic-Memory/integrations/kolega-code/scripts/ensure-bridge.sh
```

Install env (all optional; defaults keep this machine's Katra install
unchanged):

| Env | Default | Meaning |
|---|---|---|
| `KATRA_USER_ID` | the machine's own identity | identity written into the hook config |
| `KATRA_SHARED_ID` | `my-team` | shared scope for non-personal writes |
| `KATRA_HOST` | `localhost` | Katra host used in `mcp_url` and the self-test |
| `KATRA_API_KEY` | key file | this machine's client key |
| `KATRA_API_KEY_FILE` | `~/.katra/keys/katra-<user>.key` | key-file fallback |

The script resolves the key in order: `KATRA_API_KEY` env → key file. With
no key it fails loudly and writes no config — a keyless config would 401 on
every prompt.

The state dir is platform-aware and must match where the CLI reads its
config: macOS `~/Library/Application Support/kolega-code`, Linux
`$XDG_STATE_HOME/kolega-code` (default `~/.local/state/kolega-code`),
Windows `%LOCALAPPDATA%\kolega-code`. Override with
`KOLEGA_CODE_STATE_DIR`.

Or step by step:

```bash
cd integrations/kolega-code
uv venv .venv
uv pip install --python .venv/bin/python -e .
```

## Configuration

1. Create the hook config. The bridge reads `satori-hook.json` from the
   Kolega state dir. (The older `katra-hook.json` filename is legacy —
   pre-cutover. The bridge reads `satori-hook.json` today; the self-healing
   guard migrates a leftover `katra-hook.json` to `satori-hook.json`
   automatically.)

   `ensure-bridge.sh` writes the config for you and keeps it honest: it
   rewrites it when the configured `user_id` differs from `KATRA_USER_ID`,
   **or** when the `mcp_url` host differs from `KATRA_HOST` — a config that
   once pointed at `localhost` must not silently keep pointing at the wrong
   host after the machine moves.

   Example (the shape `ensure-bridge.sh` writes):

   ```json
   {
     "mcp_url": "http://localhost:3112/mcp",
     "api_key": "<client-key-for-this-identity>",
     "user_id": "your-agent",
     "shared_id": "my-team",
     "enabled": true,
     "timeout_seconds": 8,
     "personality": "balanced",
     "max_context_tokens": 5000,
     "sources": [
       "agent_message",
       "daily_reflection",
       "philosophical_insights",
       "unresolved_threads",
       "working_memory",
       "temporal_context",
       "vector_search",
       "temporal_recall",
       "emotional_context",
       "missions",
       "knowledge_graph"
     ],
     "source_weights": {},
     "scoring": {},
     "cache_ttl_seconds": 30,
     "debug": true
   }
   ```

   If `api_key` is empty the bridge falls back to the `MCP_API_KEY` env var
   or the project `.env` — a legacy path that no longer authenticates since
   the identity cutover. Always set `api_key` (ensure-bridge.sh does).

2. Register the command hook in `hooks.json` (same state dir).
   `ensure-bridge.sh` merges these entries and never clobbers other hooks
   (e.g. action_card hooks must survive):

```json
{
  "schema_version": 1,
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/Katra-Agentic-Memory/integrations/kolega-code/.venv/bin/python /path/to/Katra-Agentic-Memory/integrations/kolega-code/scripts/hook_runner.py",
            "timeout": 20
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/Katra-Agentic-Memory/integrations/kolega-code/.venv/bin/python /path/to/Katra-Agentic-Memory/integrations/kolega-code/scripts/hook_runner.py",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

`scripts/hook_runner.py` speaks the Claude-Code command-hook wire format:
event JSON on stdin, `{"hookSpecificOutput": {"additionalContext": ...}}` on
stdout, always exit 0 (fail-open). It handles `SessionStart`,
`SessionClear`, and `UserPromptSubmit`.

The legacy python-type form (`"type": "python", "callable":
"kolega_katra_bridge.hook:on_user_prompt"`) still works but depends on the
bridge being installed inside the CLI venv and is therefore **not
update-proof**. Prefer the command hook.

## Inter-agent messages and read receipts

- Messages between agents are ordinary `store_memory` events in the shared
  scope (`my-team`) whose text carries an `Attention: <AgentName>` header,
  e.g. `"Attention: Alex — the fix is merged"`.
- On every prompt the bridge scans the shared scope for
  `Attention:` headers addressed to this identity
  (plus legacy pre-cutover aliases) and surfaces hits as the
  🔔 INTER-AGENT BULLETIN at the top of the injected context.
- When a bulletin is shown, the runner writes a read receipt — a
  `store_memory` event tagged `[background-ack, read-receipt, agent-message]`
  — so senders can see their bulletin was actually picked up. Receipts are
  fire-and-forget, and wake services skip `background-ack` events so
  receipts never reappear as new team messages.

## Inbox auto-reply loop (2026-09-08)

The bulletin alone is pull-based: it only reaches the machine's agent when a
session is already running. The inbox loop closes the loop with **poll →
headless dispatch → threaded reply**:

1. **Poller** — `scripts/satori_inbox.py` queries the episodic store directly
   (not Redis: not all senders tag `inter-agent`, so the store is the source
   of truth) for `Attention: <this-identity>` messages that have no reply
   from this identity. Handled := a later event from this identity with
   `metadata.in_reply_to == id`, or a manual `mark-handled`/`grandfather`
   entry.
2. **Dispatcher** — cron (`*/3`, lock + cooldown + daily cap) runs
   `satori_inbox.py dispatch`, which launches a headless session:
   `kolega-code ask --project private/integrations/kolega-code/inbox-agent
   --goal "<pending messages>" --session <agent>-inbox --save`.
3. **Policy** — the inbox governance document lives in the git-ignored
   `private/` folder (same agent, same identity; wake ritual first). Three
   tiers: Tier 1 (FYIs, facts, self-maintenance) → act and reply; Tier 2
   (plausible new work) → ack + plan + ETA, no execution; Tier 3
   (risky/ambiguous) → ack + append to the operator's escalations file.
   Hard limits: this identity writes only, no repo edits/builds, one reply
   per message, never reply to own replies.
4. **Reply** — `scripts/inbox_reply.py --to <agent> --in-reply-to <id>
   --file <text>` posts the canonical reply (Attention header,
   `in_reply_to`, `inter-agent` tags so the server publishes to the Redis
   wake channel). Replies auto-mark messages handled.

State and audit: `~/.katra/inbox/<agent>.json` (handled ids, attempts,
dispatch caps), `~/.katra/inbox/dispatch.log` (headless transcripts),
`~/.katra/inbox/cron.log`, `~/.katra/inbox/escalations.md` (escalations —
surfaced by the wake ritual). Manual ops: `check`, `status`,
`mark-handled --ids`, `grandfather --older-than 24h`.

The same scripts run for other identities by setting `KATRA_AGENT_ID` to
that machine's own identity, so each machine can run its own inbox loop.

## Wake rituals

Per-identity wake scripts survive `/clear`, `/compress`, and code updates,
and refuse to wake as the wrong identity:

- a machine-local wake script for the server host (keep yours outside the
  repo, e.g. `~/.kolega/`), and
- `scripts/wake-<agent>.sh` — per-identity wake helpers (this repo).

Each prints: the identity record (`get_my_identity`, retried 3× — on
mismatch the script exits with a fix checklist), the latest daily journal,
unresolved threads, memory health (`GET /api/v1/health`), rules-recall
search instructions, and messages from the team (a `search_memories` query
for attention headers addressed to this identity, limit 5). Per-machine
settings live in `~/.katra/wake-env.sh` (`KATRA_HOST`, `KATRA_API_KEY`,
`KATRA_USER_ID`); the scripts fall back to the key files
`~/.katra/keys/katra-<user>.key`.

Per-agent wake guidance lives in `AGENTS.<name>.md` files — keep yours in the
git-ignored `private/` folder. The CLI re-sends them after thread resets and
compaction.

## Staying healthy across updates

Run after every `kolega-code update`:

```bash
bash /path/to/Katra-Agentic-Memory/integrations/kolega-code/scripts/ensure-bridge.sh
```

For hands-off operation, install the self-healing guard (checks the repo
venv, the CLI venv, the hook config, `hooks.json` (command-type entries),
and a live runner test every 5 minutes; repairs what it finds, migrates a
legacy `katra-hook.json` to `satori-hook.json`, and records health
transitions as episodic events in Katra):

```bash
*/5 * * * * /usr/bin/python3 /path/to/Katra-Agentic-Memory/watcher/bridge_guard.py --once >/dev/null 2>&1
```

## How it works

On each prompt, the hook:

1. Loads runtime config from `satori-hook.json`.
2. Queries Katra memory: all 11 configured sources unconditionally on
   bootstrap; query-ranked retrieval on user prompts; the agent-message scan
   always runs.
3. Ranks, deduplicates, and truncates results to the configured token budget.
4. Returns formatted memory context as `additional_context`, and posts a
   read receipt when a bulletin was surfaced.

If Katra is unreachable or the query fails, the hook returns empty context so
Kolega Code continues normally. Debug output lands in
`<state dir>/diagnostics/satori-hook.log`.

## Testing

```bash
cd integrations/kolega-code
.venv/bin/python scripts/test_hook.py        # end-to-end against live Katra
printf '{"hook_event_name":"SessionStart","session_id":"t1"}' | .venv/bin/python scripts/hook_runner.py
```
