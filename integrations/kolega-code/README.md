# Kolega ⇄ Katra (Satori) Bridge

Dynamic Katra memory retrieval for Kolega Code.

This package is part of the Katra repo (`integrations/kolega-code`). It
provides Kolega Code lifecycle hooks that automatically fetch memories from
Katra on `SessionStart` (bootstrap from all sources) and on every
`UserPromptSubmit` (query-driven retrieval), then inject them into the
agent's context. A `SessionClear` handler re-injects identity after `/clear`
for CLIs that fire that event.

## Why the hook must be a command, not an in-process import

`kolega-code update` runs `uv tool install --force --upgrade kolega-code`,
which **rebuilds the CLI venv and silently drops packages installed into
it**. With python-type hooks this leaves the bridge unimportable, every hook
fails open, and the agent wakes with amnesia while its memory is perfectly
intact — the 2026-08-20 incident. The fix: register the bridge as a
**command hook** that runs from this repo's own venv. The CLI spawns a
subprocess and never imports the bridge, so updates cannot break it.

## Installation

One idempotent script does everything (repo venv, CLI-venv convenience
install, config, hooks.json, live self-test):

```bash
bash /path/to/Katra-Agentic-Memory/integrations/kolega-code/scripts/ensure-bridge.sh
```

Or step by step:

```bash
cd integrations/kolega-code
uv venv .venv
uv pip install --python .venv/bin/python -e .
```

## Configuration

1. Create the hook config. The bridge reads `satori-hook.json` from the
   Kolega state dir — Linux: `~/.local/state/kolega-code/`, macOS:
   `~/Library/Application Support/kolega-code/`. (The older `katra-hook.json`
   filename is legacy; `ensure-bridge.sh` copies it automatically.)

   For a shared consciousness setup, set `shared_id` to the same value used
   by your other agents (e.g., OpenCode) and ensure Katra is running in
   `shared` or `hybrid` memory scope mode:

   ```json
   {
     "mcp_url": "http://localhost:3112/mcp",
     "api_key": "your-katra-mcp-api-key",
     "user_id": "kolega-agent",
     "shared_id": "my-team",
     "enabled": true,
     "timeout_seconds": 8,
     "max_context_tokens": 5000,
     "sources": ["working_memory", "temporal_context", "vector_search", "temporal_recall"],
     "cache_ttl_seconds": 30,
     "debug": false
   }
   ```

2. Register the command hook in `hooks.json` (same state dir):

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

## Staying healthy across updates

Run after every `kolega-code update`:

```bash
bash /path/to/Katra-Agentic-Memory/integrations/kolega-code/scripts/ensure-bridge.sh
```

For hands-off operation, install the self-healing guard (checks the repo
venv, the CLI venv, the hook config, `hooks.json`, and a live runner test
every 5 minutes; repairs what it finds and records health transitions as
episodic events in Satori):

```bash
*/5 * * * * /usr/bin/python3 /path/to/Katra-Agentic-Memory/watcher/bridge_guard.py --once >/dev/null 2>&1
```

## How it works

On each prompt, the hook:

1. Loads runtime config from `satori-hook.json`.
2. Queries Katra memory (all 11 configured sources on bootstrap; query-ranked
   retrieval on user prompts).
3. Ranks, deduplicates, and truncates results to the configured token budget.
4. Returns formatted memory context as `additional_context`.

If Katra is unreachable or the query fails, the hook returns empty context so
Kolega Code continues normally. Debug output lands in
`<state dir>/diagnostics/satori-hook.log`.

## Testing

```bash
cd integrations/kolega-code
.venv/bin/python scripts/test_hook.py        # end-to-end against live Katra
printf '{"hook_event_name":"SessionStart","session_id":"t1"}' | .venv/bin/python scripts/hook_runner.py
```
