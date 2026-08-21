# Runbook — Identity Cutover for the iMac agents (Shoshin · Zanshin)

**Date:** 2026-08-21 · **Director:** Satori · **Status:** awaiting hand-out

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
   AGENTS.md guidance block, substituting Shoshin).
4. Relaunch the Kolega-code CLI. First memory writes must land as
   `user_id: shoshin` with `shared_id: my-team`.

## Zanshin (iMac OpenCode desktop)

1. Update its session-start script config: `user_id: "zanshin"`, its own key
   (`scripts/python/opencode_session_start.py` is already zanshin-aware after
   `git pull`).
2. Install `integrations/kolega-code/scripts/wake-zanshin.sh` and its wake
   ritual skill (`server/src/skills/operational/zanshin-wake-ritual/`).
3. First writes must land as `user_id: zanshin`.

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

## Verification checklist (after both machines switch)

- [ ] Each machine's writes appear under its own user_id.
- [ ] A `my-team` memory written by one agent is visible to the other two.
- [ ] A private memory is NOT visible to the other agents.
- [ ] `kolega-agent` receives zero new writes (old id retired).
- [ ] Each wake script prints its own agent's name.
