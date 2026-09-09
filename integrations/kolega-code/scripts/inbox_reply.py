#!/usr/bin/env python3
"""
Satori Inbox Reply Writer — post a canonical inter-agent reply to Katra.

Writes an episodic event in the shared team scope with:
  - "Attention: <Agent> — FROM: Satori — ..." header
  - metadata.in_reply_to → the original message id (threading + handled-marking)
  - tags incl. inter-agent (so the server publishes to the Redis wake channel)
    and inbox-auto-reply (so peers can filter automated replies if they want)

The key is resolved like the wake scripts: KATRA_API_KEY env → ~/.katra/wake-env.sh
→ the katra-server container's own KATRA_API_KEY.

Usage:
  python3 inbox_reply.py --to Lilly --in-reply-to event_abc123 --file /tmp/reply.txt
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

AGENT_ID = os.environ.get("KATRA_AGENT_ID", "satori")
SHARED_ID = os.environ.get("KATRA_SHARED_ID", "my-team")
API_BASE = os.environ.get("KATRA_API", "http://localhost:9012/api/v1")

KNOWN_AGENTS = {"shoshin", "zanshin", "lilly", "zefir", "opencode", "opencoder",
                "kolegacode", "kolegacoder", "john"}


def resolve_key() -> str:
    if os.environ.get("KATRA_API_KEY"):
        return os.environ["KATRA_API_KEY"]
    wake_env = os.path.expanduser("~/.katra/wake-env.sh")
    if os.path.exists(wake_env):
        try:
            with open(wake_env) as f:
                for line in f:
                    if line.strip().startswith("KATRA_API_KEY="):
                        return line.strip().split("=", 1)[1].strip("\"'")
        except IOError:
            pass
    try:
        out = subprocess.run(
            ["docker", "exec", "katra-server", "sh", "-c", "echo $KATRA_API_KEY"],
            capture_output=True, text=True, timeout=30)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (subprocess.SubprocessError, OSError):
        pass
    raise SystemExit("inbox_reply: no KATRA_API_KEY resolvable")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True)
    ap.add_argument("--in-reply-to", required=True)
    ap.add_argument("--file", required=True)
    args = ap.parse_args()

    target = args.to.strip()
    if target.lower() not in KNOWN_AGENTS:
        print(f"inbox_reply: warning — unknown recipient {target!r}", file=sys.stderr)

    with open(args.file) as f:
        body_text = f.read().strip()
    if not body_text:
        print("inbox_reply: empty reply file", file=sys.stderr)
        return 1

    full = f"Attention: {target} — FROM: {AGENT_ID.title()} — {body_text}"
    payload = {
        "user_id": AGENT_ID,
        "session_id": "inbox-auto",
        "event_type": "agent_message",
        "content": {"message": full},
        "shared_id": SHARED_ID,
        "metadata": {
            "tags": ["inter-agent", "agent-communication", "bulletin",
                     f"FROM:{AGENT_ID.title()}", f"FOR:{target}",
                     "inbox-auto-reply"],
            "in_reply_to": args.in_reply_to,
            "source": "kolega-code-inbox",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    }

    key = resolve_key()
    req = Request(
        f"{API_BASE}/memory/episodic/events",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
        print(f"inbox_reply: posted {result.get('event_id') or result} "
              f"-> {target} (in-reply-to {args.in_reply_to})")
        return 0
    except URLError as e:
        print(f"inbox_reply: FAILED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
