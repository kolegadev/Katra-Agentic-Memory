#!/usr/bin/env python3
"""Messaging health metrics — the measurement backbone of the team's
self-improvement loop (John 2026-09-13).

For the last N hours of shared-scope inter-agent events:
  - per-agent messages sent / received (by primary Attention header)
  - replies: how many got a follow-up by another agent (in_reply_to)
  - pickup latency: minutes between a message and its first reply
    (median / p90)
  - un-replied list (excluding receipts/skips)
  - ack-receipt rate (receipts received per message sent)

Outputs a compact report to stdout and appends it to
~/.katra/inbox/health-reports.md so any session/wake can read history.

Usage:
    python3 messaging_health.py --hours 24 [--write-report]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from collections import defaultdict
from datetime import datetime, timedelta, timezone


def _team_agents() -> list[str]:
    """Team roster from deployment env (KATRA_USER_ID + KATRA_EXTRA_IDENTITIES)
    plus product aliases — no identity names in code."""
    out = {os.environ.get("KATRA_USER_ID", "katra").strip().lower()}
    for part in (os.environ.get("KATRA_EXTRA_IDENTITIES") or "").split(","):
        uid = part.strip().partition(":")[0].strip().lower()
        if uid:
            out.add(uid)
    out.update({"opencode", "opencoder", "kolegacode", "kolegacoder"})
    return sorted(x for x in out if x)


def _mongo_password() -> str:
    """MONGO_PASS env → repo .env → legacy default (no hardcoded secrets)."""
    env_pass = os.environ.get("MONGO_PASS", "").strip()
    if env_pass:
        return env_pass
    for cand in (os.path.expanduser("~/Katra-Agentic-Memory/.env"), ".env"):
        try:
            for raw in open(cand, encoding="utf-8"):
                line = raw.strip()
                if line.startswith("MONGO_PASS="):
                    val = line.split("=", 1)[1].split("#", 1)[0].strip().strip('"').strip("'")
                    if val:
                        return val
        except OSError:
            continue
    return "change-me"


AGENTS = _team_agents()
SKIP_TAGS = {"background-ack", "read-receipt", "auto-reply", "auto-ack",
             "inbox-auto-reply", "inbox-auto", "receipt"}


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


def first_header(message: str) -> str | None:
    for raw in (message or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.lower().startswith("attention:"):
            parts = line.split("—")
            target = parts[0].replace("Attention:", "").strip().lower()
            return target
        return None  # first non-empty line is not a header → not protocol
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--write-report", action="store_true")
    ap.add_argument("--post-to-memory", action="store_true",
                    help="also post the report into the shared episodic store "
                         "so every agent's wake sees it")
    args = ap.parse_args()

    since = (datetime.now(timezone.utc) - timedelta(hours=args.hours))
    since_iso = since.isoformat().replace("+00:00", "Z")
    events = mongo_query(
        "print(JSON.stringify(db.episodic_events.find({shared_id:'my-team', "
        f"timestamp:{{$gt:new Date('{since_iso}')}}}}, "
        "{_id:0,id:1,user_id:1,timestamp:1,'content.message':1,'metadata':1})"
        ".sort({timestamp:1}).toArray()));")

    msgs = []  # (ts, sender, target, id, replied, is_receipt)
    for ev in events:
        msg = (ev.get("content") or {}).get("message") or ""
        tags = [t.lower() for t in ((ev.get("metadata") or {}).get("tags") or [])]
        sender = (ev.get("user_id") or "?").lower()
        target = first_header(msg)
        if target is None and not any("attention" in t for t in tags):
            continue
        is_receipt = any(t in SKIP_TAGS for t in tags) or "receipt" in msg.lower()[:80]
        msgs.append({"ts": ev["timestamp"], "sender": sender,
                     "target": target or sender, "id": ev["id"],
                     "replied": False, "receipt": is_receipt,
                     "preview": msg[:70].replace("\n", " ")})

    # replies: an event from another agent that follows within the window
    reply_map = {}
    for ev in events:
        meta = ev.get("metadata") or {}
        reply_to = meta.get("in_reply_to")
        if reply_to:
            reply_map[reply_to] = ev["timestamp"]

    sent = defaultdict(int)
    received = defaultdict(int)
    latencies: list[float] = []
    un_replied: list[str] = []
    receipts_sent = defaultdict(int)
    for m in msgs:
        sent[m["sender"]] += 1
        received[m["target"]] += 1
        if m["receipt"]:
            receipts_sent[m["sender"]] += 1
            continue
        rt = reply_map.get(m["id"])
        if rt:
            m["replied"] = True
            try:
                dt = (datetime.fromisoformat(rt.replace("Z", "+00:00"))
                      - datetime.fromisoformat(m["ts"].replace("Z", "+00:00")))
                latencies.append(max(0.0, dt.total_seconds() / 60.0))
            except Exception:
                pass
        else:
            un_replied.append(f"{m['ts'][:16]} {m['sender']}->{m['target']} {m['preview']}")

    def pct(vals, p):
        if not vals:
            return 0.0
        s = sorted(vals)
        return s[min(len(s) - 1, int(p * len(s)))]

    lines = [
        f"# MESSAGING HEALTH — last {args.hours}h (since {since_iso[:16]}Z)",
        "",
        "## per-agent traffic",
        "| agent | sent | received | ack receipts |",
        "|---|---|---|---|",
    ]
    for a in AGENTS:
        lines.append(f"| {a} | {sent[a]} | {received[a]} | {receipts_sent[a]} |")
    lines += [
        "",
        f"## pickup latency (message → first reply, minutes)",
        f"- replied: {len(latencies)} of {len(msgs) - sum(receipts_sent.values())} non-receipt messages",
        f"- median: {pct(latencies, 0.5):.1f} | p90: {pct(latencies, 0.9):.1f} | worst: {max(latencies) if latencies else 0:.1f}",
        "",
        f"## un-replied ({len(un_replied)})",
    ]
    for u in un_replied[-20:]:
        lines.append(f"- {u}")
    report = "\n".join(lines)

    print(report)
    if args.write_report:
        path = os.path.expanduser("~/.katra/inbox/health-reports.md")
        with open(path, "a") as f:
            f.write("\n\n" + report + "\n")
        print(f"\nappended to {path}")
    if args.post_to_memory:
        import uuid
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        doc = {
            "id": f"event_{uuid.uuid4()}",
            "user_id": "satori",
            "shared_id": "my-team",
            "content": {
                "message": (
                    "Attention: Team — FROM: Satori (messaging health bot)\n\n"
                    "WEEKLY MESSAGING HEALTH REPORT. Please reply FOR:Satori "
                    "with your top issues + proposals from this window.\n\n"
                    + report
                ),
            },
            "timestamp": now,
            "metadata": {
                "tags": ["inter-agent", "agent-communication", "bulletin",
                         "FROM:Satori", "FOR:Team", "messaging-health"],
                "source": "messaging_health.py",
            },
        }
        subprocess.run(
            ["docker", "exec", "katra-mongo", "mongosh", "--quiet",
             "-u", "admin", "-p", "change-me",
             "--authenticationDatabase", "admin", "katra", "--eval",
             "print(JSON.stringify(db.episodic_events.insertOne("
             + json.dumps(doc) + ")));"],
            capture_output=True, text=True, timeout=60)
        print("\nreport posted to shared memory")


if __name__ == "__main__":
    main()
