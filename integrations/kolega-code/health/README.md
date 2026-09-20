# Machine Health Custody Loop (Satori)

Per-machine health sampling + daily review. Every team machine pushes one
`machine_health` episodic event to Katra every 15 minutes; Satori's daily
review (plus the shared wake/health reports) reads them, resolves problems,
and closes incidents with cards per `docs/incident-improvement-loop.md`.

## Pieces

- `machine_health.py` — cross-platform collector (stdlib only, system
  python3). Samples: OS/boot/uptime/load, disk, memory, configured DNS
  resolvers, live lookups (pypi.org, controlplane.tailscale.com,
  openaipublic.blob.core.windows.net), tailscale backend state, kolega-code
  version, bridge config + Katra reachability. Computes ok/degraded/down and
  POSTs the event (tags `machine-health`, `health-log`).
- `health_review.py` — thebrick-side daily reviewer. Reads the last N hours
  of events, reports per-machine status/staleness/degraded streaks, appends
  history to `~/.katra/inbox/health-reports.md`, posts an
  "Attention: Satori" alert when something needs action, appends John-only
  items to `needs-owner.md`, and flags machines that recovered inside the
  window as CARD DUE (incident-improvement loop).

## Install on a machine

```bash
mkdir -p ~/Katra-Agentic-Memory/integrations/kolega-code/health
# copy machine_health.py there (scp from thebrick)
crontab -l | grep -v health/machine_health > /tmp/cron.base
{ cat /tmp/cron.base
  echo "# machine health collector -> Katra (Satori custody loop)"
  echo "*/15 * * * * KATRA_HOST=100.101.206.13 mkdir -p $HOME/.katra/inbox && /usr/bin/python3 $HOME/Katra-Agentic-Memory/integrations/kolega-code/health/machine_health.py >> $HOME/.katra/inbox/health-cron.log 2>&1"
} | crontab -
```

The `mkdir -p` inside the cron line is mandatory, not cosmetic: a missing
`~/.katra/inbox` makes `/bin/sh` fail the redirect, the job dies silently,
and the only trace is cron error mail (natasha went 23h stale this way,
2026-09-20). Every installed line must carry it.

Notes:
- `KATRA_HOST` must point at thebrick (Katra host) on non-thebrick machines.
- Identity comes from the machine's `katra-hook.json` user_id; the API key
  from `~/.katra/keys/katra-<user>.key` (thebrick falls back to the repo
  `.env` admin key — the REST API does not accept the MCP key).
- Installed: thebrick (satori), natasha-macbook-pro (zefir). Pending:
  johns-macbook-pro (lilly, Remote Login off) and johns-imac (shoshin,
  offline) — install when those machines are reachable.

## Review cadence

- Collector cron: `*/15` on each machine.
- Reviewer cron (thebrick): daily 07:30, `--hours 26 --write-report
  --post-alert`. Run manually any time: same command with shorter window.
- Escalation: machine problems → "Attention: Satori" bulletin +
  `needs-owner.md` for John-only items (hardware, tailnet-level changes,
  machines with no collector).
