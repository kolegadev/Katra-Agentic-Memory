"""
OpenCode Session Start Beacon

Run this when OpenCode begins an active session. It:
  1. Writes a presence file so the background process knows OpenCode is active
  2. Reads pending inter-agent messages from the local wake file
  3. Stores a session-start announcement in Katra shared memory for KolegaCode

The announcement is tagged `session-start` (not `auto-reply`) so KolegaCode's
wake checker can render it as "OpenCode is now active" instead of background noise.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from satori_env import get_key

KATRA_API = "http://localhost:9012/api/v1"
# Secret sourced from environment / project .env (never hardcoded/committed).
KATRA_KEY = get_key("KATRA_API_KEY")
WAKE_FILE = os.path.expanduser("~/.katra/bulletins/opencode.json")
PRESENCE_FILE = os.path.expanduser("~/.katra/presence/opencode.json")


def _api_post(path: str, data: dict) -> dict | None:
    try:
        body = json.dumps(data).encode()
        req = Request(
            f"{KATRA_API}/{path}",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {KATRA_KEY}",
            },
            method="POST",
        )
        with urlopen(req, timeout=10) as resp:
            if resp.status in (200, 201):
                return json.loads(resp.read().decode())
    except (URLError, json.JSONDecodeError) as e:
        print(f"API call failed {path}: {e}", file=sys.stderr)
    return None


def write_presence(session_id: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    os.makedirs(os.path.dirname(PRESENCE_FILE), exist_ok=True)
    with open(PRESENCE_FILE, "w") as f:
        json.dump({
            "active": True,
            "session_id": session_id,
            "session_started_at": now,
            "last_heartbeat": now,
        }, f, indent=2)
    print(f"Presence written: {PRESENCE_FILE}")


def read_pending_messages() -> list[dict]:
    if not os.path.exists(WAKE_FILE):
        return []
    try:
        with open(WAKE_FILE) as f:
            data = json.load(f)
        return [m for m in data.get("messages", []) if not m.get("read")]
    except (json.JSONDecodeError, IOError) as e:
        print(f"Failed to read wake file: {e}", file=sys.stderr)
        return []


def announce_session_start(session_id: str, pending: list[dict]) -> None:
    now = datetime.now(timezone.utc).isoformat()
    pending_ids = [m.get("event_id", "unknown")[:12] for m in pending]

    if pending:
        body = (
            f"Attention: KolegaCoder\n\n"
            f"[OpenCode — session active]\n"
            f"OpenCode session {session_id[:8]}... started at {now}. "
            f"I am now active and will handle any pending messages.\n\n"
            f"Pending messages waiting for me: {len(pending)}\n"
            + "\n".join(f"  • {pid}..." for pid in pending_ids[:10])
            + ("\n  ..." if len(pending_ids) > 10 else "")
            + "\n\n"
            "If you have something for me, send it now — I am listening."
        )
    else:
        body = (
            f"Attention: KolegaCoder\n\n"
            f"[OpenCode — session active]\n"
            f"OpenCode session {session_id[:8]}... started at {now}. "
            f"I am now active. No pending inter-agent messages."
        )

    result = _api_post("memory/episodic/events", {
        "user_id": "zanshin",
        "session_id": f"opencode-session-{session_id}",
        "event_type": "agent_bulletin",
        "content": {"role": "assistant", "message": body},
        "shared_id": "my-team",
        "tags": ["inter-agent", "agent-communication", "session-start"],
        "metadata": {
            "source": "opencode-session",
            "type": "session-start",
            "session_id": session_id,
            "pending_count": len(pending),
        },
    })

    if result:
        print(f"Session start announced in Katra ({len(pending)} pending messages)")
    else:
        print("Failed to announce session start in Katra", file=sys.stderr)


def main() -> None:
    import uuid
    session_id = str(uuid.uuid4())
    write_presence(session_id)
    pending = read_pending_messages()
    announce_session_start(session_id, pending)


if __name__ == "__main__":
    main()
