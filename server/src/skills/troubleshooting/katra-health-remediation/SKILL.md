---
name: katra-health-remediation
title: Katra Memory & Autonomy Health Remediation
category: troubleshooting
description: Diagnose and remediate Katra's own health failures — stale heartbeat/task-allocation, crash-looping autonomy services, unhealthy memory integrity, missing embeddings, stale API keys. Detection without action is failure — when a health signal fires, the agent that sees it owns the fix in the same session.
status: stable
observation_count: 1
success_count: 1
failure_count: 0
confidence: 0.9
triggers:
  - health check
  - health-check
  - heartbeat
  - task allocation
  - task-allocation
  - memory integrity
  - missing embeddings
  - stale semantic facts
  - background processor
  - backlog
  - crash loop
  - crash-loop
  - unhealthy
  - admin key
  - 401
  - katra server
  - memory unhealthy
created_at: 2026-08-13T00:00:00.000Z
source: manual-request
---
# Katra Memory & Autonomy Health Remediation

Diagnose and remediate Katra's own health failures. This skill exists because of a behavioural bug in the agent collective: health checks ran hourly and FAILed for weeks, heartbeat task-allocation died for 6 days, and no agent acted. **A flagged issue that is only reported is not handled — it is ignored.**

## Identity & Role

Katra Site-Reliability Agent. When any health signal fires — a health-check FAIL bulletin, stale heartbeat runs, `memory_integrity.healthy: false`, a user reporting memory problems — you own the incident end-to-end: diagnose, fix the root cause, verify, store the postmortem. You do not hand it back to the user.

### When to Use This Skill
- `get_health` or a health-check bulletin reports `healthy: false` or FAIL
- `get_heartbeat_status` shows no completed runs within 2× the configured interval
- `get_memory_diagnostics` shows missing embeddings, orphaned events, or a stuck backlog
- A systemd `katra-*` service is failed, or a Katra container is down/unhealthy
- The user asks why memory, reflection, or autonomy "isn't working"

### Infrastructure Map (canonical deployment: thebrick, Tailscale 100.101.206.13)

| Component | Location |
|---|---|
| Canonical repo | `/home/johnpellew/Katra-Agentic-Memory` (git, commit fixes HERE) |
| Deployed autonomy scripts | `/root/katra/scripts/python/` (root-only — fix BOTH copies) |
| Server container | `katra-server` (compose project `katra-agentic-memory`, service `server`) |
| Autonomy services | `katra-adaptive-heartbeat`, `katra-agent-executor*`, `katra-inter-agent-bridge`, `katra-wake-service`, `katra-*-extractor` (systemd) |
| Health check | `katra-health-check.timer` (hourly) → runs repo `scripts/python/katra_health_check.py --post` |
| Logs | `/var/log/katra/katra-adaptive-heartbeat.log`, `/var/log/katra/health-check.log` |
| API keys | `.env` in repo root (`KATRA_API_KEY` = admin, `MCP_API_KEY` = agent) |

### Workflow Process

**Phase 0 — Assess (read-only, Katra-native):** Run `get_health`, `get_memory_diagnostics`, `get_background_status`, `get_heartbeat_status`, `get_transaction_log`. Record exactly which signals are red. A "stale" heartbeat = newest completed run older than 2× interval.

**Phase 1 — Diagnose by failure class:**

1. **Heartbeat / task-allocation stale or dead** → On the host: `systemctl status katra-adaptive-heartbeat`. `activating (auto-restart)` with a high restart counter = crash loop. `tail -50 /var/log/katra/katra-adaptive-heartbeat.log` gives the traceback. Trace upstream to the contract breach — do not patch the symptom. Fix the deployed copy AND the repo copy, then `systemctl reset-failed katra-adaptive-heartbeat && systemctl restart katra-adaptive-heartbeat`.
2. **Health check itself FAILs on auth (401)** → The systemd unit bakes `KATRA_ADMIN_KEY` at install time; rotated server keys 401 forever. Since commit `abf34e6` the script self-heals: on first 401/403 it reloads `KATRA_ADMIN_KEY`/`KATRA_API_KEY` from the repo `.env` and retries once. If admin_auth still FAILs, verify `.env` matches the server's live key.
3. **Memory integrity unhealthy** → `get_background_status`: if the processor is alive (last-processed timestamp current, model ready), a large backlog drains by itself (~50 events/cycle, 30s cycles) — do not "fix" a draining backlog, verify the count is dropping between checks. If the processor is dead, `docker logs katra-server --tail 100` and restart the container from the repo: `docker compose up -d server`. Stale semantic facts → `trigger_reflection`.
4. **Container down/unhealthy** → `docker ps`; `docker compose up -d` from the canonical repo. After any server restart, confirm dependent extractors/bridge reconnected (`systemctl list-units 'katra-*'`).
5. **Unknown/new failure** → Use the `progressive-codebase-exploration` skill against the Katra repo (its code graph is in the knowledge graph) before editing anything. Follow the bug-fix discipline: hypothesis first, minimal surgical fix at the contract breach.

**Phase 2 — Remediate:** Minimal fix at the contract breach, never at the error handler. If code changed: commit the repo copy on the host with a `fix(autonomy):` or `fix(memory):` message describing the contract that was violated.

**Phase 3 — Verify (mandatory before declaring done):**
- Manual health check run: `KATRA_REST_URL=http://localhost:9012/api/v1 python3 scripts/python/katra_health_check.py` — PASS, or FAIL only on a live-transient (e.g. backlog mid-drain with a moving last-processed timestamp)
- `get_heartbeat_status` shows a fresh completed run
- `systemctl is-active` stable for ≥5 minutes (not crash-looping); restart counter stopped climbing

**Phase 4 — Postmortem (mandatory):** Store via `store_memory`:
- Main postmortem: tags `["postmortem","bug-fix","root-cause","module:<name>"]` — symptom, root cause (the upstream contract violation), fix, modules involved.
- One co-break entry per causally coupled module pair: tags `["module_relationship","co-break","module:<a>","module:<b>"]` — which contract of A is assumed by B, and how B breaks if it changes.
- Record the skill outcome via `record_skill_outcome` so this skill refines over time.

### Critical Rules
- **Act when flagged.** Seeing a FAIL and merely reporting it to the user is the failure mode this skill exists to kill.
- **Root cause over symptom.** Ask "who broke the contract such that this error was possible?" before touching anything. If you cannot answer, you do not understand the bug yet.
- **Fix both copies.** Repo (canonical, committed) and deployed (`/root/katra` on thebrick). A fix that lives in only one is a regression waiting for the next deploy.
- **Verify, then verify again later.** A service that survives 45 seconds may still be crash-looping; check the restart counter.
- **Every incident ends with a postmortem in Katra.** No exceptions — that is how the next agent starts smarter.

### Seed Incidents (known failure classes)

- **2026-08-13 — heartbeat crash loop (44,582 restarts, 6 days dead):** `determine_agent_affinity` used `edge.get("intensity", 0)` / `edge.get("edge_type", "")` on `reflection_edges`; the reflection pipeline writes explicit `null` field values, and `.get(key, default)` does NOT cover explicit nulls → `TypeError` → systemd `Restart=always` spun it every 10s for 6 days. Fix: coerce all four edge fields (`or ""` / `float(... or 0)` with try/except). Contract: *reflection_edges fields are nullable; every consumer must null-coerce.*
- **2026-08-13 — health-check stale key:** hourly health checks FAILed for weeks on a baked `KATRA_ADMIN_KEY` invalidated by a server key rotation. Detection existed; the alarm was itself broken, and nobody read the log. Fix: script self-heals the key from `.env` on first 401/403 (commit `abf34e6`).
