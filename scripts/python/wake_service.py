"""
Wake Service — Real-time inter-agent notification bridge.

Subscribes to Redis pub-sub channel katra:events:{shared_id}.
On inter-agent message, determines the target agent and:
  1. Stores in Katra working_memory for the target agent
  2. Writes to a wake file the agent's hook checks
  3. For OpenCode: writes to ~/.katra/bulletins/opencode.json
  4. For KolegaCode: writes to ~/.katra/bulletins/kolegacode.json

Runs as a launchctl service.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import logging
from datetime import datetime, timezone
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

import redis

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from katra_env import get_key

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("wake-service")

# ── Config ────────────────────────────────────────────────────────────────
REDIS_HOST = "localhost"
REDIS_PORT = 6384
SHARED_ID = "my-team"
REDIS_CHANNEL = f"katra:events:{SHARED_ID}"
KATRA_API = os.environ.get("KATRA_API", "http://localhost:9012/api/v1")
# Secret sourced from environment / project .env (never hardcoded/committed).
KATRA_KEY = get_key("KATRA_API_KEY")
WAKE_DIR = os.path.expanduser("~/.katra/bulletins")

# Attention pattern: "Attention: AgentName — ..." or "Attention: AgentName\n..."
ATTN_PATTERN = re.compile(r"Attention:\s*(OpenCoder|OpenCode|KolegaCoder|KolegaCode)", re.IGNORECASE)

AGENT_WAKE_FILES = {
    "OpenCoder": os.path.expanduser("~/.katra/bulletins/opencode.json"),
    "OpenCode": os.path.expanduser("~/.katra/bulletins/opencode.json"),
    "KolegaCoder": os.path.expanduser("~/.katra/bulletins/kolegacode.json"),
    "KolegaCode": os.path.expanduser("~/.katra/bulletins/kolegacode.json"),
}


def _api_post(path: str, data: dict) -> bool:
    """Simple REST API POST wrapper."""
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
            return resp.status == 201 or resp.status == 200
    except URLError as e:
        logger.warning(f"API call failed {path}: {e}")
        return False


def store_wake_memory(agent: str, content_preview: str, event_id: str) -> None:
    """Store a wake entry in Katra working_memory for the target agent."""
    _api_post("memory/working", {
        "session_id": f"wake-{agent.lower()}",
        "action": "store",
        "user_id": "kolega-agent",
        "content": json.dumps({
            "type": "inter-agent-wake",
            "from": "wake-service",
            "target_agent": agent,
            "event_id": event_id,
            "content_preview": content_preview[:500],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }),
    })


def write_wake_file(agent: str, content_preview: str, event_id: str, source: str = "agent", tags: list[str] | None = None) -> None:
    """Write a wake file for the target agent's hook to discover."""
    path = AGENT_WAKE_FILES.get(agent)
    if not path:
        return

    os.makedirs(os.path.dirname(path), exist_ok=True)

    try:
        if os.path.exists(path):
            with open(path) as f:
                existing = json.load(f)
        else:
            existing = {"messages": [], "last_read": None}
    except (json.JSONDecodeError, IOError):
        existing = {"messages": [], "last_read": None}

    entry = {
        "event_id": event_id,
        "content_preview": content_preview[:300],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "target": agent,
        "source": source,
        "tags": tags or [],
    }

    # Keep last 50 messages
    existing["messages"].append(entry)
    if len(existing["messages"]) > 50:
        existing["messages"] = existing["messages"][-50:]
    existing["updated_at"] = entry["timestamp"]
    existing["unread_count"] = sum(1 for m in existing["messages"] if not m.get("read"))

    with open(path, "w") as f:
        json.dump(existing, f, indent=2)

    logger.info(f"Wake file written for {agent}: {path}")


def determine_target(content_preview: str) -> Optional[str]:
    """Extract target agent from 'Attention: AgentName' pattern."""
    match = ATTN_PATTERN.search(content_preview)
    if match:
        agent = match.group(1)
        # Normalize names
        if agent.lower() in ("opencoder", "opencode"):
            return "OpenCode"
        if agent.lower() in ("kolegacoder", "kolegacode"):
            return "KolegaCode"
    return None


def on_message(message: dict) -> None:
    """Process a Redis pub-sub message."""
    try:
        data = json.loads(message["data"])
    except (json.JSONDecodeError, KeyError, TypeError):
        return

    event_type = data.get("type")
    if event_type != "inter-agent-message":
        return

    content_preview = data.get("content_preview", "")
    event_id = data.get("event_id", "unknown")
    tags = data.get("tags", []) or []

    # Never wake an agent for background auto-acks or delivery receipts.
    if any(t in tags for t in ("auto-reply", "background-ack")):
        logger.debug(f"Skipping background-ack message: {event_id[:12]}...")
        return

    target = determine_target(content_preview)
    if not target:
        logger.debug(f"No target agent found in message: {content_preview[:80]}")
        return

    # Infer source from tags because Redis payload only carries tags, not metadata.
    if "session-start" in tags:
        source = "session-start"
    elif "heartbeat" in tags:
        source = "heartbeat"
    elif "cognitive-state" in tags:
        source = "cognitive-state"
    else:
        source = "agent"

    logger.info(f"Wake event: {target} ← {event_id[:12]}... source={source} ({len(content_preview)} chars)")

    # 1. Store in working_memory
    store_wake_memory(target, content_preview, event_id)

    # 2. Write wake file
    write_wake_file(target, content_preview, event_id, source=source, tags=tags)


def main():
    logger.info("=" * 50)
    logger.info("  WAKE SERVICE — Inter-Agent Real-time Notification")
    logger.info(f"  Redis: {REDIS_HOST}:{REDIS_PORT}/{REDIS_CHANNEL}")
    logger.info("=" * 50)

    os.makedirs(WAKE_DIR, exist_ok=True)

    backoff = 2
    while True:
        try:
            r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
            r.ping()
            logger.info("Connected to Redis")

            ps = r.pubsub()
            ps.subscribe(REDIS_CHANNEL)
            logger.info(f"Subscribed to {REDIS_CHANNEL}")

            backoff = 2  # Reset backoff on successful connection

            for message in ps.listen():
                if message["type"] == "message":
                    on_message(message)

        except (redis.ConnectionError, redis.RedisError) as e:
            logger.error(f"Redis connection failed: {e} — retrying in {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
        except Exception as e:
            logger.error(f"Unexpected error: {e} — retrying in {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    main()
