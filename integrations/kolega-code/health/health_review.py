#!/usr/bin/env python3
"""Machine-health reviewer — the host agent's daily custody loop over team machines.

Reads machine_health events from Katra (Mongo), assesses every known machine,
flags problems, and drives the incident-improvement loop (docs/
incident-improvement-loop.md): machines that recovered inside the window get a
CARD DUE marker so the reviewing session closes the incident with a card.

Output:
- human report on stdout
- history appended to ~/.katra/inbox/health-reports.md
- when anything needs action: an "Attention: <local identity>" agent message
  posted to the shared scope (tagged machine-health-report) so the inbox
  loop/session picks it up, plus a needs-owner entry for anything that is
  the owner's call (hardware, tailnet-level, machines with no collector).

Usage:
    python3 health_review.py --hours 26 [--write-report] [--post-alert]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPORT_FILE = Path.home() / ".katra" / "inbox" / "health-reports.md"
NEEDS_OWNER = Path.home() / ".katra" / "inbox" / "needs-owner.md"
API = "http://localhost:9012/api/v1"

# Identity is deployment data: the alert is posted by and addressed to the
# local identity (KATRA_USER_ID), never a hardcoded name.
LOCAL_ID = (os.environ.get("KATRA_USER_ID", "katra") or "katra").strip() or "katra"
LOCAL_NAME = LOCAL_ID.title()


def _mongo_password() -> str:
    """MONGO_PASS env → repo .env → legacy default (no hardcoded secrets)."""
    env_pass = os.environ.get("MONGO_PASS", "").strip()
    if env_pass:
        return env_pass
    for cand in (Path.home() / "Katra-Agentic-Memory" / ".env", Path(".env")):
        try:
            for raw in cand.open(encoding="utf-8"):
                line = raw.strip()
                if line.startswith("MONGO_PASS="):
                    val = line.split("=", 1)[1].split("#", 1)[0].strip().strip('"').strip("'")
                    if val:
                        return val
        except OSError:
            continue
    return "change-me"


def mongo_query(js: str) -> list:
    out = subprocess.run(
        ["docker", "exec", "katra-mongo", "mongosh", "--quiet",
         "-u", "admin", "-p", _mongo_password(), "--authenticationDatabase", "admin",
         "katra", "--eval", js],
        capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(out.stderr[-300:])
    raw = out.stdout.strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def fetch_health_events(since_iso: str) -> list[dict]:
    js = f"""
var rows = db.episodic_events.find({{
  event_type: "machine_health",
  timestamp: {{$gte: ISODate("{since_iso}")}}
}}, {{user_id:1, timestamp:1, content:1, metadata:1, _id:0}})
.sort({{timestamp: 1}}).toArray();
print(JSON.stringify(rows));
"""
    return mongo_query(js)


def admin_key() -> str:
    env_file = Path.home() / "Katra-Agentic-Memory" / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.strip().startswith("KATRA_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def post_agent_message(message: str) -> bool:
    key = admin_key()
    if not key:
        return False
    payload = {
        "user_id": LOCAL_ID,
        "event_type": "agent_message",
        "content": {"message": message},
        "metadata": {"tags": ["inter-agent", "agent-message", "machine-health-report"]},
    }
    try:
        req = urllib.request.Request(
            f"{API}/memory/episodic/events",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {key}"},
            method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read(200) or b"{}").get("success") is True
    except Exception as exc:
        print(f"health_review: alert post failed: {exc}", file=sys.stderr)
        return False


def _to_dt(ts) -> datetime:
    if isinstance(ts, datetime):
        return ts
    if isinstance(ts, str):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            pass
    raise ValueError(f"unparseable timestamp {ts!r}")


def assess(events: list[dict], window_hours: int) -> dict:
    by_machine: dict[str, list[dict]] = defaultdict(list)
    for ev in events:
        machine = (ev.get("content") or {}).get("machine") or "unknown"
        by_machine[machine].append(ev)

    now = datetime.now(timezone.utc)
    machines: dict[str, dict] = {}
    for machine, evs in sorted(by_machine.items()):
        evs.sort(key=lambda e: _to_dt(e["timestamp"]))
        latest = evs[-1]
        checks = (latest.get("content") or {}).get("checks") or {}
        status = checks.get("_status", "unknown")
        interval = int((latest.get("metadata") or {}).get("interval_min", 15))
        age_min = (now - _to_dt(latest["timestamp"])).total_seconds() / 60
        stale = age_min > interval * 3
        statuses = [((e.get("content") or {}).get("checks") or {}).get("_status", "unknown")
                    for e in evs]
        degraded_hits = sum(1 for s in statuses if s in ("degraded", "down"))
        dns_fails = [
            h for e in evs
            for h, r in (((e.get("content") or {}).get("checks") or {}).get("dns_probes") or {}).items()
            if not r.get("ok")
        ]
        # Recovered inside the window? (a resolution we must close with a card)
        recovered = status == "ok" and any(s in ("degraded", "down") for s in statuses[:-1])
        machines[machine] = {
            "machine": machine,
            "latest_status": status,
            "age_min": round(age_min, 1),
            "stale": stale,
            "samples": len(evs),
            "statuses": statuses,
            "degraded_hits": degraded_hits,
            "dns_fails": sorted(set(dns_fails)),
            "kolega_version": (checks.get("kolega") or {}).get("version"),
            "tailscale": (checks.get("tailscale") or {}).get("backend_state"),
            "bridge_user": (checks.get("bridge") or {}).get("config_user"),
            "recovered": recovered,
        }
    return machines


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=26.0)
    ap.add_argument("--write-report", action="store_true")
    ap.add_argument("--post-alert", action="store_true")
    args = ap.parse_args()

    since = (datetime.now(timezone.utc) - timedelta(hours=args.hours)).isoformat()
    events = fetch_health_events(since)
    machines = assess(events, args.hours)

    lines: list[str] = []
    lines.append(f"# machine health review {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}Z "
                 f"(window {args.hours}h, {len(events)} samples, {len(machines)} machines)")
    problems: list[str] = []
    owner_items: list[str] = []
    card_due: list[str] = []
    for m in sorted(machines.values(), key=lambda x: x["machine"]):
        flag = ""
        if m["stale"]:
            flag = " STALE"
            problems.append(f"{m['machine']}: stale ({m['age_min']} min since last sample)")
            owner_items.append(f"{m['machine']}: no recent health samples — collector missing or machine off; "
                               "install/verify the */15 machine_health cron.")
        if m["latest_status"] in ("degraded", "down"):
            flag += f" {m['latest_status'].upper()}"
            problems.append(f"{m['machine']}: {m['latest_status']} "
                            f"({m['degraded_hits']}/{m['samples']} bad samples; dns fails: {m['dns_fails'] or 'none'})")
        if m["recovered"]:
            flag += " RECOVERED"
            card_due.append(m["machine"])
        lines.append(
            f"- {m['machine']:<22} {m['latest_status']:<8}{flag}"
            f" samples={m['samples']} degraded_hits={m['degraded_hits']} "
            f"kolega={m['kolega_version']} ts={m['tailscale']} bridge={m['bridge_user']}"
        )
    if not machines:
        lines.append("- (no machine_health events in window — collectors not running yet?)")
        problems.append("no machine_health events at all in window")

    lines.append("")
    if problems:
        lines.append("PROBLEMS: " + "; ".join(problems))
    else:
        lines.append("PROBLEMS: none — all machines reporting, all ok")
    if card_due:
        lines.append(f"CARD DUE (incident-improvement loop): {', '.join(card_due)}")
    lines.append("")

    report = "\n".join(lines)
    print(report)

    if args.write_report:
        with REPORT_FILE.open("a") as f:
            f.write("\n" + report + "\n")

    alert_parts = [p for p in problems]
    if card_due:
        alert_parts.append(f"incident cards due: {', '.join(card_due)}")
    if args.post_alert and alert_parts:
        msg = (f"Attention: {LOCAL_NAME} — FROM: {LOCAL_NAME} — machine health review "
               f"{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}Z: "
               + " | ".join(alert_parts)
               + " — review, resolve, then close each incident with a card "
                 "(docs/incident-improvement-loop.md).")
        if post_agent_message(msg):
            print("alert posted to shared scope")
        if owner_items:
            with NEEDS_OWNER.open("a") as f:
                f.write(f"\n## {datetime.now(timezone.utc).isoformat()}\n")
                for item in owner_items:
                    f.write(f"- health-review: {item}\n")
            print("needs-owner entries appended")
    return 0


if __name__ == "__main__":
    sys.exit(main())
