# Machine Health Custody Loop

Per-machine health sampling + daily review. Every team machine pushes one
`machine_health` episodic event to Katra every 15 minutes; the host agent's
daily review (plus the shared wake/health reports) reads them, resolves
problems, and closes incidents with cards per
`docs/incident-improvement-loop.md`.

## Pieces

- `machine_health.py` — cross-platform collector (stdlib only, system
  python3). Samples: OS/boot/uptime/load, disk, memory, configured DNS
  resolvers, live lookups (pypi.org, controlplane.tailscale.com,
  openaipublic.blob.core.windows.net), tailscale backend state, kolega-code
  version, bridge config + Katra reachability. Computes ok/degraded/down and
  POSTs the event (tags `machine-health`, `health-log`).
- `health_review.py` — host-side daily reviewer. Reads the last N hours of
  events, reports per-machine status/staleness/degraded streaks, appends
  history to `~/.katra/inbox/health-reports.md`, posts an
  `Attention: <local identity>` alert when something needs action, appends
  owner-only items to `needs-owner.md`, and flags machines that recovered
  inside the window as CARD DUE (incident-improvement loop). Identity is
  deployment data: the alert RECIPIENT is `KATRA_USER_ID`; the AUTHOR is the
  system identity (`KATRA_ALERT_AUTHOR`, default `katra`). Author and
  recipient MUST differ — the consuming loop's candidate query excludes
  events authored by its own identity, so a self-authored alert is never
  dispatched (see `docs/incident-improvement-loop.md`, card
  health-alert-undeliverable).

## Install on a machine

```bash
mkdir -p ~/Katra-Agentic-Memory/integrations/kolega-code/health
# copy machine_health.py there (scp from the Katra host)
crontab -l | grep -v health/machine_health > /tmp/cron.base
{ cat /tmp/cron.base
  echo "# machine health collector -> Katra (Satori custody loop)"
  echo "*/15 * * * * KATRA_HOST=<katra-host-ip> mkdir -p $HOME/.katra/inbox && /usr/bin/python3 $HOME/Katra-Agentic-Memory/integrations/kolega-code/health/machine_health.py >> $HOME/.katra/inbox/health-cron.log 2>&1"
} | crontab -
```

The `mkdir -p` inside the cron line is mandatory, not cosmetic: a missing
`~/.katra/inbox` makes `/bin/sh` fail the redirect, the job dies silently,
and the only trace is cron error mail (natasha went 23h stale this way,
2026-09-20). Every installed line must carry it.

Notes:
- `KATRA_HOST` must point at the Katra host on non-host machines.
- Identity comes from the machine's `katra-hook.json` user_id; the API key
  from `~/.katra/keys/katra-<user>.key` (the Katra host falls back to the
  repo `.env` admin key — the REST API does not accept the MCP key).
- Per-machine install state is deployment data — track it in the
  git-ignored `private/` deployment notes, not here.

## Review cadence

- Collector cron: `*/15` on each machine.
- Reviewer cron (Katra host): daily 07:30, `--hours 26 --write-report
  --post-alert`, with `KATRA_USER_ID=<local agent id>` set in the cron line
  (e.g. `satori` on thebrick — the alert is addressed to it; without it the
  alert falls back to a self-addressed "katra" form that no loop fetches).
  Run manually any time: same command with shorter window.
- Escalation: machine problems → `Attention: <local identity>` bulletin +
  `needs-owner.md` for owner-only items (hardware, tailnet-level changes,
  machines with no collector).
