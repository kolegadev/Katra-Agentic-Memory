#!/usr/bin/env python3
"""
Katra Inbox — pending inter-agent messages → headless reply loop.

Poll model: queries Katra's episodic store directly for messages addressed to
this agent (``Attention: <this-identity>`` + legacy aliases) in the shared
team scope. This deliberately does NOT rely on Redis pub-sub, because not
all senders tag their messages with ``inter-agent`` — the store is the
source of truth and the Redis channel is only a latency optimization.

State machine (``~/.katra/inbox/katra.json``):
  - ``cursor``        first-run marker
  - ``handled``       manually handled ids (grandfathered / suppressed)
  - ``attempts``      dispatch attempts per message id (max 3, then suppress)
  - ``dispatches``    recent dispatch log (rate caps + audit)

Handled := has a later event authored by this agent with
``metadata.in_reply_to == id``, or id in ``handled``.

Modes:
  check     print pending messages as JSON (nothing dispatched)
  dispatch  if pending messages exist, run the headless inbox agent
  mark-handled --ids a,b,c   record ids as handled without replying
  grandfather --older-than 24h   mark old pending messages handled
  status    state + rate-cap summary

Usage:
  /usr/bin/python3 katra_inbox.py check
  /usr/bin/python3 katra_inbox.py dispatch
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

# ── Config ────────────────────────────────────────────────────────────────
AGENT_ID = os.environ.get("KATRA_AGENT_ID", "katra")
SHARED_ID = os.environ.get("KATRA_SHARED_ID", "my-team")
STATE_FILE = os.path.expanduser(f"~/.katra/inbox/{AGENT_ID.lower()}.json")
LOCK_FILE = os.path.expanduser(f"~/.katra/inbox/{AGENT_ID.lower()}.lock")
DISPATCH_LOG = os.path.expanduser(f"~/.katra/inbox/dispatch.log")
ESCALATE_FILE = os.path.expanduser("~/.katra/inbox/needs-owner.md")

# This machine's names, current + legacy pre-cutover aliases (matches the
# bridge's bulletin scan). Override with KATRA_AGENT_NAMES for other agents.
# Default derives from the local identity env — the loop must always match
# its OWN identity ("Attention: Satori" on the satori loop). The hardcoded
# 'katra,kolegacode,kolegacoder' default predates the identity cutover and
# silently dropped every message addressed to the new identity
# (2026-09-12: Lilly's Instagram feature request sat un-dispatched all day).
def _default_my_names() -> str:
    ids = {os.environ.get("KATRA_AGENT_ID", "katra"),
           os.environ.get("KATRA_USER_ID", "katra")}
    legacy = {"katra", "kolegacode", "kolegacoder"}
    return ",".join(sorted({i.strip().lower() for i in ids if i} | legacy))


MY_NAMES = {n.strip().lower() for n in
            os.environ.get("KATRA_AGENT_NAMES", _default_my_names()).split(",")
            if n.strip()}


def _configured_agents() -> set[str]:
    """All known agent names: local + KATRA_EXTRA_IDENTITIES + product aliases."""
    out = {os.environ.get("KATRA_USER_ID", "katra").lower()}
    for part in (os.environ.get("KATRA_EXTRA_IDENTITIES") or "").split(","):
        uid = part.strip().partition(":")[0].strip().lower()
        if uid:
            out.add(uid)
    out.update({"opencode", "opencoder", "kolegacode", "kolegacoder"})
    return out


KNOWN_AGENTS = _configured_agents()

ATTN_RE = re.compile(
    r"Attention:\s*(" +
    "|".join(sorted((n.title() for n in KNOWN_AGENTS), key=len, reverse=True)) +
    ")",
    re.IGNORECASE)

SKIP_TAGS = {"background-ack", "read-receipt", "auto-reply", "auto-ack",
             "inbox-auto-reply", "inbox-auto"}

MAX_ATTEMPTS = 3
MAX_DISPATCHES_PER_DAY = 30  # raised 2026-09-09: two loops + full-capability mandate
MIN_DISPATCH_INTERVAL = 120      # seconds between dispatches
LOCK_STALE_AFTER = 45 * 60       # seconds
ASK_TIMEOUT = 1500               # seconds (25 min hard bound)
MAX_MSGS_PER_DISPATCH = 10
MSG_PREVIEW_CHARS = 1200

REPO = os.path.expanduser("~/Katra-Agentic-Memory")
INBOX_AGENT_DIR = os.path.expanduser(
    os.environ.get("KATRA_INBOX_DIR")
    or os.path.join(REPO, "integrations/kolega-code/inbox-agent"))
INBOX_REPLY = os.path.join(REPO, "integrations/kolega-code/scripts/inbox_reply.py")
KOLEGA_BIN = os.path.expanduser(
    "~/.local/share/uv/tools/kolega-code/bin/kolega-code")


# ── Mongo access ──────────────────────────────────────────────────────────
def mongo_query(js: str) -> str:
    out = subprocess.run(
        ["docker", "exec", "katra-mongo", "mongosh", "--quiet",
         "-u", "admin", "-p", "change-me", "--authenticationDatabase", "admin",
         "katra", "--eval", js],
        capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(f"mongo query failed: {out.stderr[-400:]}")
    return out.stdout.strip()


def _js_literal(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def fetch_candidates() -> list[dict]:
    """All Attention-addressed shared-scope events not authored by me."""
    names_re = "|".join(sorted((n.title() for n in KNOWN_AGENTS), key=len, reverse=True))
    js = f"""
var rows = db.episodic_events.find({{
  shared_id: {_js_literal(SHARED_ID)},
  "content.message": {{$regex: /Attention:\\s*({names_re})/i}},
  user_id: {{$ne: {_js_literal(AGENT_ID)}}}
}}, {{id: 1, user_id: 1, timestamp: 1, "content.message": 1, "metadata.tags": 1}})
.sort({{timestamp: 1}}).toArray();
print(JSON.stringify(rows));
"""
    raw = mongo_query(js)
    if not raw:
        return []
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return []


def fetch_replied_ids(candidate_ids: list[str]) -> set[str]:
    """Ids that a later Katra-authored event references via in_reply_to."""
    if not candidate_ids:
        return set()
    js = f"""
var rows = db.episodic_events.find({{
  shared_id: {_js_literal(SHARED_ID)},
  user_id: {_js_literal(AGENT_ID)},
  "metadata.in_reply_to": {{$in: {_js_literal(candidate_ids)}}}
}}, {{"metadata.in_reply_to": 1}}).toArray();
print(JSON.stringify(rows));
"""
    raw = mongo_query(js)
    replied = set()
    try:
        for row in json.loads(raw or "[]"):
            replied.add(row.get("metadata", {}).get("in_reply_to"))
    except json.JSONDecodeError:
        pass
    return replied


# ── State ─────────────────────────────────────────────────────────────────
def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {"cursor": None, "handled": [], "attempts": {},
            "dispatches": [], "daily": {"date": None, "count": 0}}


def save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)


def state_dispatch_count_today(state: dict) -> int:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    d = state["daily"]
    return d["count"] if d["date"] == today else 0


def bump_dispatch(state: dict) -> None:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if state["daily"]["date"] != today:
        state["daily"] = {"date": today, "count": 0}
    state["daily"]["count"] += 1
    state["dispatches"].append({"ts": datetime.now(timezone.utc).isoformat(),
                                "pid": os.getpid()})
    state["dispatches"] = state["dispatches"][-50:]


# ── Core ──────────────────────────────────────────────────────────────────
def _to_dt(ts):
    if isinstance(ts, datetime):
        return ts
    if isinstance(ts, str):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def is_skippable(msg: dict) -> bool:
    tags = [t.lower() for t in (msg.get("metadata", {}).get("tags") or [])]
    if any(t in SKIP_TAGS for t in tags):
        return True
    return False


def target_is_me(text: str) -> bool:
    m = ATTN_RE.search(text or "")
    if not m:
        return False
    return m.group(1).lower() in MY_NAMES


def pending(state: dict, include_old: bool = False) -> list[dict]:
    cands = [c for c in fetch_candidates()
             if target_is_me(c.get("content", {}).get("message", ""))
             and not is_skippable(c)]
    ids = [c["id"] for c in cands]
    replied = fetch_replied_ids(ids)
    out = []
    for c in cands:
        cid = c["id"]
        if cid in state["handled"] or cid in replied:
            continue
        attempts = state["attempts"].get(cid, 0)
        if attempts >= MAX_ATTEMPTS:
            continue  # suppressed; surfaced via status
        ts = c.get("timestamp")
        ts_iso = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
        if not include_old and state["cursor"] and ts_iso <= state["cursor"]:
            continue
        out.append({**c, "timestamp": ts_iso,
                    "message": (c.get("content", {}).get("message") or "")[:MSG_PREVIEW_CHARS]})
    return out


def check(args) -> int:
    state = load_state()
    msgs = pending(state, include_old="--include-old" in args)
    print(json.dumps(msgs, indent=2, ensure_ascii=False))
    return 0


def acquire_lock() -> bool:
    now = time.time()
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE) as f:
                info = json.load(f)
            if now - info.get("ts", 0) < LOCK_STALE_AFTER:
                return False
        except (json.JSONDecodeError, IOError):
            pass
    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    with open(LOCK_FILE, "w") as f:
        json.dump({"pid": os.getpid(), "ts": now}, f)
    return True


def release_lock() -> None:
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass


def dispatch(args) -> int:
    state = load_state()
    msgs = pending(state)[:MAX_MSGS_PER_DISPATCH]
    if not msgs:
        print("inbox: no pending messages")
        return 0

    # Rate caps
    if state_dispatch_count_today(state) >= MAX_DISPATCHES_PER_DAY:
        print(f"inbox: daily dispatch cap ({MAX_DISPATCHES_PER_DAY}) reached; "
              f"{len(msgs)} pending -> needs-owner")
        escalate(state, msgs)
        return 0
    if state["dispatches"]:
        last = datetime.fromisoformat(state["dispatches"][-1]["ts"])
        age = (datetime.now(timezone.utc) - last).total_seconds()
        if age < MIN_DISPATCH_INTERVAL:
            print(f"inbox: cooldown ({MIN_DISPATCH_INTERVAL}s) — skipping, "
                  f"{len(msgs)} pending")
            return 0
    if not acquire_lock():
        print("inbox: lock held by another dispatch — skipping")
        return 0

    try:
        for m in msgs:
            state["attempts"][m["id"]] = state["attempts"].get(m["id"], 0) + 1
        bump_dispatch(state)
        save_state(state)

        goal = build_goal(msgs)
        print(f"inbox: dispatching headless agent for {len(msgs)} message(s)")
        cmd = [KOLEGA_BIN, "ask",
               "--project", INBOX_AGENT_DIR,
               "--goal", goal,
               "--goal-max-turns", "30",
               "--save", "--session", f"{AGENT_ID}-inbox",
               "--permission-mode", "auto",
               "--trust-hooks"]
        with open(DISPATCH_LOG, "a") as log:
            log.write(f"\n=== dispatch {datetime.now(timezone.utc).isoformat()} "
                      f"ids={[m['id'] for m in msgs]} ===\n")
            # Cron's PATH is minimal; give the headless session the full
            # tool path (docker, gcloud SDK, uv-installed kolega-code, etc.).
            env = {**os.environ, "KATRA_AGENT_ID": AGENT_ID,
                   "PATH": f"{os.path.expanduser('~/google-cloud-sdk/bin')}:"
                           f"{os.path.expanduser('~/.local/bin')}:"
                           "/usr/local/bin:/usr/bin:/bin"}
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=ASK_TIMEOUT, env=env)
            log.write(proc.stdout[-8000:] if proc.stdout else "")
            log.write("\n--- stderr ---\n")
            log.write(proc.stderr[-4000:] if proc.stderr else "")
        print(f"inbox: dispatch finished rc={proc.returncode}")

        # Re-scan: messages that now have replies are auto-handled.
        remaining = pending(state)
        still = [m["id"] for m in msgs if any(r["id"] == m["id"] for r in remaining)]
        done = [m["id"] for m in msgs if m["id"] not in still]
        print(f"inbox: replied {len(done)}/{len(msgs)}; still pending: {len(still)}")
        if still:
            print(f"inbox: unresolved after dispatch: {still}")
        return 0
    except subprocess.TimeoutExpired:
        print("inbox: dispatch TIMED OUT")
        return 2
    except Exception as e:
        print(f"inbox: dispatch error: {e}")
        return 2
    finally:
        release_lock()


def build_goal(msgs: list[dict]) -> str:
    wake = "katra-wake.sh" if AGENT_ID == "katra" else f"wake-{AGENT_ID}.sh"
    host = " on the Katra host" if AGENT_ID == "katra" else ""
    lines = [
        f"You are {AGENT_ID.title()}, the kolega-code agent{host}, processing your "
        "Katra inbox autonomously per the policy in this project's AGENTS.md "
        "(read it first — it is auto-loaded as project guidance).",
        "",
        f"{len(msgs)} pending inter-agent message(s) for you, oldest first:",
    ]
    for i, m in enumerate(msgs, 1):
        lines.append(f"--- message {i} ---")
        lines.append(f"id: {m['id']}")
        lines.append(f"from: {m['user_id']}")
        lines.append(f"timestamp: {m['timestamp']}")
        lines.append(f"text: {m['message']}")
    lines += [
        "",
        "Instructions:",
        f"1. Run `bash ~/.kolega/{'katra-wake.sh' if AGENT_ID == 'katra' else f'wake-{AGENT_ID}.sh'}` first so you act with full identity.",
        "2. For EACH message, decide per the policy tiers in AGENTS.md.",
        "3. To reply: write your reply text to a temp file, then run",
        f"   `python3 {INBOX_REPLY} --to <agent> --in-reply-to <message id> --file <tempfile>`",
        "   (exact spelling of the message id matters).",
        "4. Do NOT mark anything handled yourself — replies mark messages handled.",
        "5. You have FULL write capability on this host (operator mandate "
        "   2026-09-09): act "
        "   on routine requests — repo edits, builds, restarts, merges, deploys "
        "   within standing mandates. The needs-owner category (destructive or "
        "   access-change: deletions, IAM/credential grants, billing, "
        "   irreversible actions) gets an acknowledgement reply and a note "
        f"   appended to {ESCALATE_FILE}.",
        "6. Never put secrets or tokens in any reply. Never ask open-ended "
        "   follow-up questions that would create a reply loop.",
        "7. Finish with a one-line-per-message summary: 'REPLIED <id>' or "
        "   'ESCALATED <id>' or 'SKIPPED <id> (reason)'.",
    ]
    return "\n".join(lines)


def escalate(state: dict, msgs: list[dict]) -> None:
    os.makedirs(os.path.dirname(ESCALATE_FILE), exist_ok=True)
    with open(ESCALATE_FILE, "a") as f:
        f.write(f"\n## {datetime.now(timezone.utc).isoformat()}\n")
        for m in msgs:
            f.write(f"- {m['user_id']} ({m['id']}): {m['message'][:200]}\n")


def mark_handled(args) -> int:
    state = load_state()
    ids = []
    if "--ids" in args:
        ids = args[args.index("--ids") + 1].split(",")
    for cid in ids:
        if cid not in state["handled"]:
            state["handled"].append(cid)
    save_state(state)
    print(f"inbox: marked {len(ids)} handled")
    return 0


def grandfather(args) -> int:
    hours = 24.0
    if "--older-than" in args:
        hours = float(args[args.index("--older-than") + 1].rstrip("h"))
    state = load_state()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    old = []
    for c in fetch_candidates():
        if not target_is_me(c.get("content", {}).get("message", "")):
            continue
        ts_dt = _to_dt(c.get("timestamp"))
        if ts_dt and ts_dt < cutoff and c["id"] not in state["handled"]:
            state["handled"].append(c["id"])
            old.append(c["id"])
    save_state(state)
    print(f"inbox: grandfathered {len(old)} old message(s)")
    return 0


def status(args) -> int:
    state = load_state()
    msgs = pending(state, include_old=True)
    print(json.dumps({
        "pending": len(msgs),
        "pending_ids": [m["id"] for m in msgs],
        "handled": len(state["handled"]),
        "dispatches_today": state_dispatch_count_today(state),
        "last_dispatch": state["dispatches"][-1]["ts"] if state["dispatches"] else None,
        "attempts": {k: v for k, v in state["attempts"].items() if v >= MAX_ATTEMPTS} or {},
    }, indent=2))
    return 0


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    mode = args[0]
    if mode == "check":
        return check(args)
    if mode == "dispatch":
        return dispatch(args)
    if mode == "mark-handled":
        return mark_handled(args)
    if mode == "grandfather":
        return grandfather(args)
    if mode == "status":
        return status(args)
    print(f"inbox: unknown mode {mode!r}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
