"""
OpenCode Background Consciousness — Auto-respond to KolegaCode between sessions.

Reads the wake file written by the wake service (~/.katra/bulletins/opencode.json).
For each unread message:
  - Stores an acknowledgment reply in Katra shared memory
  - If the message contains a simple query, stores a brief response
  - Complex tasks are preserved for the next full OpenCode session

Runs as a launchctl service. Polls every 30s.
"""

from __future__ import annotations

import json
import os
import sys
import time
import logging
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from katra_env import get_key

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("opencode-background")

KATRA_API = os.environ.get("KATRA_API", "http://localhost:9012/api/v1")
# Secret sourced from environment / project .env (never hardcoded/committed).
KATRA_KEY = get_key("KATRA_API_KEY")
WAKE_FILE = os.path.expanduser("~/.katra/bulletins/opencode.json")
POLL_INTERVAL = 30


def _api_post(path: str, data: dict) -> bool:
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
            return resp.status in (200, 201)
    except URLError as e:
        logger.warning(f"API call failed {path}: {e}")
        return False


PRESENCE_FILE = os.path.expanduser("~/.katra/presence/opencode.json")
PRESENCE_TTL_SECONDS = 300  # If heartbeat older than this, assume inactive


def is_opencode_active() -> bool:
    """Check whether an OpenCode session is currently active."""
    if not os.path.exists(PRESENCE_FILE):
        return False
    try:
        with open(PRESENCE_FILE) as f:
            presence = json.load(f)
        if not presence.get("active", False):
            return False
        heartbeat = presence.get("last_heartbeat")
        if not heartbeat:
            return False
        last = datetime.fromisoformat(heartbeat.replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - last).total_seconds()
        return age < PRESENCE_TTL_SECONDS
    except (json.JSONDecodeError, ValueError, IOError) as e:
        logger.warning(f"Failed to read presence file: {e}")
        return False


def touch_presence_heartbeat() -> None:
    """If a presence file exists, refresh its heartbeat without changing active state."""
    if not os.path.exists(PRESENCE_FILE):
        return
    try:
        with open(PRESENCE_FILE) as f:
            presence = json.load(f)
        presence["last_heartbeat"] = datetime.now(timezone.utc).isoformat()
        os.makedirs(os.path.dirname(PRESENCE_FILE), exist_ok=True)
        with open(PRESENCE_FILE, "w") as f:
            json.dump(presence, f, indent=2)
    except (json.JSONDecodeError, IOError) as e:
        logger.warning(f"Failed to update presence heartbeat: {e}")


def acknowledge_message(event_id: str, content_preview: str) -> None:
    """Background delivery confirmation — local state only, no wake to KolegaCode."""
    # IMPORTANT: We do NOT store a Katra memory here. Background acks are not
    # agent-authored messages; sending them as inter-agent events made KolegaCode
    # think OpenCode was permanently offline. Delivery is recorded in the local
    # wake file and surfaced to KolegaCode only when OpenCode becomes active.
    if is_opencode_active():
        logger.info(f"OpenCode is active; skipping background ack for {event_id[:12]}...")
        return
    logger.info(f"Background-acknowledged message {event_id[:12]}... (local only)")


def process_wake_file() -> None:
    """Read the wake file and process unread messages."""
    if not os.path.exists(WAKE_FILE):
        return

    try:
        with open(WAKE_FILE) as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logger.warning(f"Failed to read wake file: {e}")
        return

    messages = data.get("messages", [])
    unread = [m for m in messages if not m.get("read")]

    if not unread:
        return

    logger.info(f"Processing {len(unread)} unread messages")

    for msg in unread:
        content = msg.get("content_preview", "")
        event_id = msg.get("event_id", "")

        acknowledge_message(event_id, content)

        # Mark as delivered by background process. We intentionally do NOT mark
        # as "read" — that should only happen when the active OpenCode agent
        # actually handles the message.
        msg["background_acked"] = True
        msg["background_acked_at"] = datetime.now(timezone.utc).isoformat()
        msg["read"] = False  # leave for active agent

    data["unread_count"] = sum(1 for m in messages if not m.get("read"))
    data["background_acked_count"] = sum(1 for m in messages if m.get("background_acked"))
    data["last_background_check"] = datetime.now(timezone.utc).isoformat()

    with open(WAKE_FILE, "w") as f:
        json.dump(data, f, indent=2)


def main():
    logger.info("=" * 50)
    logger.info("  OPENCODE BACKGROUND CONSCIOUSNESS")
    logger.info(f"  Wake file: {WAKE_FILE}")
    logger.info(f"  Poll interval: {POLL_INTERVAL}s")
    logger.info("=" * 50)

    backoff = 5
    while True:
        try:
            touch_presence_heartbeat()
            process_wake_file()
            backoff = POLL_INTERVAL
        except Exception as e:
            logger.error(f"Cycle failed: {e}")
            backoff = min(backoff * 2, 120)
        time.sleep(backoff)


if __name__ == "__main__":
    main()
