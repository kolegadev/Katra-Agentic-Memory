#!/usr/bin/env python3
"""Per-identity daily reflection guard.

Root cause this guards (2026-10-21): SleepConsolidationService.schedule() calls
runConsolidation(period) with no user_id -> DEFAULT_USER_ID ("katra") only, while
consolidation_runs stores ONE global last_run per period. The scheduler looks
healthy while every other identity's reflection goes stale (agent-a 10-11,
agent 10-06, agent-c 10-05, agent-b 08-24 at the time of writing).

This guard reads the latest reflective_journals row per identity, and for any
identity older than MAX_AGE_H, calls the admin trigger endpoint
(POST /api/v1/admin/trigger-reflection with an explicit user_id), waiting for
that identity's journal to advance before moving to the next (the service
consolidates one identity at a time).

Note (learned 2026-10-21): the MCP `trigger_reflection` tool honours a named
user_id only for a TRUSTED caller; the loop.env key resolves to its own
identity, so a call naming agent-b consolidated `katra` instead. The admin route
takes user_id directly and is gated by the container's KATRA_API_KEY.

Usage:
  python3 scripts/python/katra_reflection_guard.py --dry-run
  python3 scripts/python/katra_reflection_guard.py
  python3 scripts/python/katra_reflection_guard.py --max-age-hours 25 --timeout 240

No secret is stored here: the key is read at runtime from the container env
(KATRA_API_KEY via docker exec) or KATRA_ADMIN_KEY in the environment.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

ADMIN_URL = os.environ.get("KATRA_ADMIN_URL", "http://localhost:9012/api/v1/admin/trigger-reflection")
LOG = os.path.expanduser("~/.katra/reflection-guard.log")


def log(line: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as fh:
        fh.write(f"[{stamp}] {line}\n")


def api_key() -> str:
    key = os.environ.get("KATRA_ADMIN_KEY", "").strip()
    if key:
        return key
    try:
        out = subprocess.run(["docker", "exec", "katra-server", "printenv", "KATRA_API_KEY"],
                             capture_output=True, text=True, timeout=20)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    for path in ("~/.katra/loop.env", "~/Katra-Agentic-Memory/.env"):
        path = os.path.expanduser(path)
        if not os.path.exists(path):
            continue
        for line in open(path):
            if line.startswith("KATRA_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("no admin key found (KATRA_ADMIN_KEY, container KATRA_API_KEY, loop.env)")


def latest_journals() -> dict[str, datetime]:
    """Latest daily reflective journal per identity, via mongosh inside katra-mongo."""
    script = (
        'db.reflective_journals.aggregate([{$sort:{created_at:-1}},'
        '{$match:{period_type:"daily"}},'
        '{$group:{_id:"$user_id",last:{$first:"$created_at"}}}]).forEach('
        'x=>print(x._id+"\\t"+x.last.toISOString()))'
    )
    out = subprocess.run(
        ["docker", "exec", "-i", "katra-mongo", "sh", "-c",
         'mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" '
         '--authenticationDatabase admin katra --quiet --eval "$(cat)"'],
        input=script, capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise SystemExit(f"mongosh failed: {out.stderr[:300]}")
    latest: dict[str, datetime] = {}
    for line in out.stdout.splitlines():
        parts = line.strip().split("\t")
        if len(parts) == 2:
            uid, ts = parts
            try:
                latest[uid] = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                pass
    return latest


def trigger(user_id: str, key: str) -> str:
    payload = {"period_type": "daily", "user_id": user_id}
    req = urllib.request.Request(ADMIN_URL, data=json.dumps(payload).encode(), headers={
        "content-type": "application/json",
        "authorization": f"Bearer {key}",
    })
    try:
        raw = urllib.request.urlopen(req, timeout=300).read().decode()
    except Exception as exc:  # noqa: BLE001 - report the named failure
        return f"call failed: {type(exc).__name__}: {exc}"
    try:
        j = json.loads(raw)
    except Exception:  # noqa: BLE001
        return f"unparseable response: {raw[:200]}"
    if not j.get("success"):
        err = (j.get("result") or {}).get("error") or j.get("error") or "unknown"
        return f"not run: {err}"
    res = j.get("result") or {}
    return (f"completed (nodes {res.get('nodes_upserted', 0)}, "
            f"insights {res.get('insights_upserted', 0)})")


def wait_for_advance(user_id: str, before: datetime | None, timeout_s: int) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(10)
        try:
            now = latest_journals().get(user_id)
        except SystemExit:
            continue
        if now is not None and (before is None or now > before):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-age-hours", type=float, default=25.0)
    ap.add_argument("--timeout", type=int, default=240)
    ap.add_argument("--only", default="", help="comma-separated identities")
    args = ap.parse_args()

    key = "" if args.dry_run else api_key()
    latest = latest_journals()
    # Every identity that has ever had a reflection, plus the built-in default.
    latest.setdefault("katra", None)  # type: ignore[arg-type]
    if args.only:
        wanted = {x.strip() for x in args.only.split(",") if x.strip()}
        latest = {u: t for u, t in latest.items() if u in wanted}

    now = datetime.now(timezone.utc)
    stale = []
    for uid, ts in sorted(latest.items(), key=lambda kv: (kv[1] is not None, kv[1])):
        if ts is None or (now - ts).total_seconds() > args.max_age_hours * 3600:
            stale.append((uid, ts))

    if not stale:
        log("all identities fresh")
        print("all identities fresh")
        return 0

    print(f"stale identities: {[(u, t.isoformat() if t else None) for u, t in stale]}")
    for uid, before in stale:
        if args.dry_run:
            log(f"DRY-RUN would trigger {uid} (last {before})")
            continue
        msg = trigger(uid, key)
        log(f"trigger {uid} (last {before}): {msg}")
        print(f"trigger {uid}: {msg}")
        if msg.startswith(("call failed", "not run", "unparseable")):
            continue
        ok = wait_for_advance(uid, before, args.timeout)
        log(f"{uid}: journal {'advanced' if ok else 'did NOT advance within %ss' % args.timeout}")
        print(f"{uid}: {'advanced' if ok else 'did not advance'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
