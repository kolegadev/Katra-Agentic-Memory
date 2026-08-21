# Runbook — Identity Cutover for the iMac agents (Shoshin · Zanshin)

**Date:** 2026-08-21 · **Director:** Satori · **Status:** Zanshin handed out & verified 2026-08-21; Shoshin key verified

Katra now resolves caller identity from API keys. Each machine must use its OWN
key and user_id. Until a machine switches, its old shared key is REJECTED
(loud 401) — this is deliberate: the old key would write memories under
Satori's identity.

## Keys (handed out in person — never stored in the repo)

- **Shoshin** (iMac trading Kolega-code): key + user_id `shoshin`
- **Zanshin** (iMac OpenCode desktop): key + user_id `zanshin`
- Keys were printed once at katra-server boot (`docker logs katra-server |
  grep 'Client keys'`). To rotate: delete the `client_keys` entry in
  `system_settings` and restart katra-server.

## Shoshin (iMac trading terminal)

1. Update its hook config (the `satori-hook.json` equivalent on the iMac):
   `user_id: "shoshin"`, `shared_id: "my-team"`, `api_key: <shoshin key>`,
   `mcp_url` unchanged.
2. `git pull` in its Katra-Agentic-Memory checkout — the repo now carries the
   shoshin-aware bridge scripts (`scripts/python/inter_agent_bridge.py`:
   MY_AGENT_ID=shoshin, PEER_AGENT_ID=zanshin).
3. Install the wake ritual: copy `integrations/kolega-code/scripts/wake-shoshin.sh`
   to `~/.kolega/` and run it at every session start (mirror the Satori
   AGENTS.md guidance block, substituting Shoshin). The script is
   remote-safe: set `KATRA_HOST=<thebrick hostname/IP>` and
   `KATRA_WAKE_KEY=<shoshin key>` in the environment (or export in
   `~/.zshrc`). It calls the shared service over MCP with Shoshin's own
   key — no docker, no ssh, no admin key.
4. Relaunch the Kolega-code CLI. First memory writes must land as
   `user_id: shoshin` with `shared_id: my-team`.

## Zanshin (iMac OpenCode desktop)

1. Update its session-start script config: `user_id: "zanshin"`, its own key
   (`scripts/python/opencode_session_start.py` is already zanshin-aware after
   `git pull`).
2. Install `integrations/kolega-code/scripts/wake-zanshin.sh` (env:
   `KATRA_HOST` + `KATRA_WAKE_KEY=<zanshin key>`) and its wake ritual skill
   (`server/src/skills/operational/zanshin-wake-ritual/`).
3. First writes must land as `user_id: zanshin`.

## Cutover policy (updated after Shoshin's first-run report)

- **Legacy keys are rejected (401), not mapped.** The pre-cutover shared key
  (and every BACKUP_MCP_KEYS entry) no longer authenticates. A machine that
  still holds one gets a loud 401 until it switches to its own key.
- **`private: true`** (top-level, both REST event bodies and MCP
  `store_memory` arguments) opts a write out of the shared channel. Omitting
  `shared_id` is NOT enough — the default is `my-team`.

## What each agent can see (hybrid mode)

- Its own private memories (`user_id`) — journals, reflections, emotional
  state, private events.
- Everything shared on `my-team` — the shared consciousness channel.
- NOT other agents' private memories (`hybrid_visible_user_ids` is `[]`).

## Rules of the shared channel

- Personal stuff is private: sleep consolidations, reflections, emotional
  states always write to the agent's own user_id (enforced server-side).
- Everything else defaults to `my-team`; pass `"private": true` (top level of
  the event body / MCP `store_memory` arguments) to opt out per write.
- The wake ritual must run at every session start — it is the identity chain.
  If the identity check mismatches, the script exits 1 and refuses to wake.

## Onboarding: update-proof memory on every machine (2026-08-21 restart test)

The wake ritual alone is not enough — after `kolega-code update` the CLI
venv is rebuilt and only the command-hook bridge survives. Every machine
needs all four pieces, installed with ITS OWN identity:

1. **Bridge installer (with identity):**
   ```bash
   cd <repo>/integrations/kolega-code/scripts
   KATRA_USER_ID=shoshin bash ensure-bridge.sh     # zanshin on the OpenCode box
   ```
   The installer writes the hook config (user_id + key, chmod 600) and
   registers the update-proof command hooks in the CLI's `hooks.json`.
   Re-run after every `kolega-code update` (safe anytime, idempotent).
2. **Key file:** store the machine's client key at
   `~/.katra/keys/katra-<user>.key` (chmod 600) — the installer and the
   wake script both read it; no shell-env persistence needed.
3. **Wake script:** copy `wake-<name>.sh` to `~/.kolega/` and make it
   executable. Set `KATRA_HOST=<thebrick hostname/IP>` in `~/.zshrc`.
4. **AGENTS.md guidance block:** install
   `integrations/kolega-code/AGENTS.<name>.md` as the `AGENTS.md` guidance
   block in the CLI's working directory (or `~/AGENTS.md`). The CLI re-sends
   it after `/clear` and `/compress` — this is what makes the ritual actually
   fire at every session start.
5. **Restart/update test:** run `kolega-code update`, restart the CLI, start
   a new session, and confirm the wake ritual output starts with the agent's
   own name and identity. If it doesn't, run `ensure-bridge.sh` and re-test.

## Verification checklist (after both machines switch)

- [x] Each machine's writes appear under its own user_id. *(verified: zanshin key → `user_id: zanshin`, shoshin key → `user_id: shoshin`)*
- [x] A `my-team` memory written by one agent is visible to the other two. *(verified via shared search)*
- [x] A private memory is NOT visible to the other agents. *(verified: `private:true` stays out of shared channel)*
- [x] `kolega-agent` receives zero new writes (old id retired). *(verified: only shared/zanshin events surface; no new kolega-agent writes)*
- [x] Each wake script prints its own agent's name. *(Zanshin iMac wake prints "ZANSHIN WAKE"; Shoshin wake prints its name)*

## Zanshin hand-out log (2026-08-21)

- [x] `~/.config/opencode/opencode.jsonc` katra MCP auth → `{file:.../katra-zanshin.key}`
- [x] Background extractor (launchd `com.solomem.opencode-extractor`) → `--api-key katra-zanshin-... --user-id zanshin`
- [x] `~/.config/opencode/AGENTS.md` identity/session-opening updated to Zanshin + iMac wake ritual path
- [x] `~/.katra/wake-zanshin.sh` created (iMac MCP-based wake; the repo script needs docker, which is thebrick-only)
- [x] iMac wake ritual runs successfully and verifies the Zanshin identity kernel
