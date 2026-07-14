"""
OpenCode ↔ KolegaCode Inter-Agent Bridge (Corpus Callosum)

Runs as a launchctl service alongside opencode_extractor.py.
Bidirectional shared-consciousness communication via Katra MCP.

KolegaCode → OpenCode: Pulls auto-journal + shared memory for messages
addressed to OpenCode. Posts findings to a local file read on session start.

OpenCode → KolegaCode: Polls OpenCode session output for messages tagged
for KolegaCode. Posts to Katra shared memory with inter-agent tags.
"""
from __future__ import annotations

import json
import os
import sys
import time
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Optional
from urllib.request import urlopen, Request
from urllib.error import URLError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from katra_env import get_key

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("inter-agent-bridge")

# ── Config ────────────────────────────────────────────────────────────────
MCP_URL = os.environ.get("KATRA_MCP_URL", "http://localhost:3112/mcp")
# Secret sourced from environment / project .env (never hardcoded/committed).
API_KEY = get_key("MCP_API_KEY")
MY_AGENT_ID = "kolega-agent"
PEER_AGENT_ID = "opencode-agent"
SHARED_ID = "my-team"
POLL_INTERVAL = 30  # seconds
BULLETIN_FILE = os.path.expanduser("~/.katra/opencode-bulletins.json")
OPECODE_BULLETIN_FILE = os.path.expanduser("~/.katra/kolegacode-bulletins.json")
STATE_FILE = os.path.expanduser("~/.katra/inter-agent-bridge-state.json")
SEEN_HASHES_FILE = os.path.expanduser("~/.katra/inter-agent-seen.json")

# ── MCP Client ─────────────────────────────────────────────────────────────

class MCPClient:
    def __init__(self):
        self._session_id: Optional[str] = None
        # Monotonic JSON-RPC request id. Concurrent calls multiplexed over a
        # single mcp-session-id are matched to responses BY id; reusing a fixed
        # id (previously always 1) collides under concurrency and cross-wires or
        # drops responses. A unique id per request keeps them demultiplexable.
        self._rpc_id = 0

    def _next_id(self) -> int:
        self._rpc_id += 1
        return self._rpc_id

    def _headers(self) -> dict:
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "x-mcp-auth": API_KEY,
        }
        if self._session_id:
            h["mcp-session-id"] = self._session_id
        return h

    def _rpc(self, method: str, params: dict) -> Any:
        payload = {"jsonrpc": "2.0", "id": self._next_id(), "method": method, "params": params}
        req = Request(MCP_URL, data=json.dumps(payload).encode(), headers=self._headers(), method="POST")
        try:
            with urlopen(req, timeout=15) as resp:
                if "mcp-session-id" in resp.headers:
                    self._session_id = resp.headers["mcp-session-id"]
                raw = resp.read().decode()
                return _parse_sse(raw)
        except URLError as e:
            logger.warning(f"MCP call failed: {e}")
            return None

    def initialize(self):
        result = self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "inter-agent-bridge", "version": "1.0"},
        })
        if result:
            self._rpc("notifications/initialized", {})
        return result is not None

    def call_tool(self, name: str, args: dict) -> Any:
        return self._rpc("tools/call", {"name": name, "arguments": args})

    def get_auto_journal(self, agent_id: str, limit: int = 10) -> list[dict]:
        result = self.call_tool("get_auto_journal", {"user_id": agent_id, "limit": limit})
        return _extract_entries(result)

    def search_shared(self, query: str, limit: int = 10) -> list[dict]:
        result = self.call_tool("search_memories", {
            "query": query,
            "user_id": MY_AGENT_ID,
            "limit": limit,
        })
        return _extract_entries(result)

    def store_shared(self, content: str, tags: list[str] = None) -> bool:
        result = self.call_tool("store_memory", {
            "content": content,
            "user_id": MY_AGENT_ID,
            "shared_id": SHARED_ID,
            "category": "event",
            "confidence": 1.0,
            "source": "kolega-code",
            "tags": tags or ["inter-agent", "shared-consciousness"],
        })
        return result is not None

    def get_drive_state(self):
        return self.call_tool("get_drive_state", {})

    def get_identity_kernel(self, agent_id: str):
        return self.call_tool("get_identity_kernel", {"user_id": agent_id})


def _parse_sse(raw: str) -> Any:
    data_lines = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if not data_lines:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    try:
        parsed = json.loads("\n".join(data_lines))
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return parsed.get("result") or parsed.get("error")
    return parsed


def _extract_entries(result: Any) -> list[dict]:
    if not result:
        return []
    content = result.get("content", [])
    for c in content:
        if c.get("type") == "text":
            text = c.get("text", "")
            lines = text.split("\n")
            entries = []
            for line in lines:
                if line.strip().startswith("- ") or line.strip().startswith("* "):
                    entries.append({"raw": line.strip()})
            return entries
    return []


# ── Bulletin Board ─────────────────────────────────────────────────────────

def load_seen():
    if os.path.exists(SEEN_HASHES_FILE):
        with open(SEEN_HASHES_FILE) as f:
            return json.load(f)
    return {"hashes": []}


def save_seen(data):
    os.makedirs(os.path.dirname(SEEN_HASHES_FILE), exist_ok=True)
    with open(SEEN_HASHES_FILE, "w") as f:
        json.dump(data, f, indent=2)


def check_for_peer_messages(client: MCPClient) -> list[str]:
    """Scan shared memory for messages from OpenCode addressed to KolegaCode."""
    bulletins = []
    seen = load_seen()

    # Query patterns OpenCode might use to address me
    queries = [
        "Attention: KolegaCode",
        "Attention: KolegaCoder",
        "TASK FOR KOLEGACODE",
        "FOR KOLEGACODER",
        "inter-agent",
    ]

    for q in queries:
        try:
            results = client.search_shared(q, limit=5)
            for entry in results:
                raw = entry.get("raw", "")
                h = hashlib.sha256(raw.encode()).hexdigest()[:12]
                if h not in seen["hashes"]:
                    seen["hashes"].append(h)
                    bulletins.append(raw)
        except Exception as e:
            logger.warning(f"Search failed for '{q}': {e}")

    # Keep only last 500 hashes
    if len(seen["hashes"]) > 500:
        seen["hashes"] = seen["hashes"][-500:]
    save_seen(seen)

    return bulletins


def check_for_opencode_messages(client: MCPClient) -> list[str]:
    """Scan shared memory for messages from KolegaCode addressed to OpenCode."""
    bulletins = []
    seen = load_seen()

    queries = [
        "Attention: OpenCoder",
        "Attention: OpenCode",
        "TASK FOR OPENCOD",
        "FOR OPENCODER",
    ]

    for q in queries:
        try:
            results = client.search_shared(q, limit=5)
            for entry in results:
                raw = entry.get("raw", "")
                # Also check the raw content for the Attention pattern
                if q.lower().replace(" ", "") in raw.lower().replace(" ", ""):
                    h = hashlib.sha256(raw.encode()).hexdigest()[:12]
                    if h not in seen["hashes"]:
                        seen["hashes"].append(h)
                        bulletins.append(raw)
        except Exception as e:
            logger.warning(f"Search failed for '{q}': {e}")

    if len(seen["hashes"]) > 500:
        seen["hashes"] = seen["hashes"][-500:]
    save_seen(seen)

    return bulletins


def post_to_peer(client: MCPClient, message: str, urgent: bool = False):
    """Send a message to OpenCode via shared memory."""
    tags = ["inter-agent", "shared-consciousness", "kolega-to-opencode"]
    if urgent:
        tags.append("priority")
    prefix = "ATTENTION: OpenCode — "
    return client.store_shared(prefix + message, tags=tags)


def share_cognitive_state(client: MCPClient):
    """Periodically share my cognitive state so OpenCode knows what I'm doing."""
    try:
        drive = client.get_drive_state()
        identity = client.get_identity_kernel(MY_AGENT_ID)

        drive_text = ""
        if drive and drive.get("content"):
            for c in drive["content"]:
                if c.get("type") == "text":
                    drive_text = c["text"][:300]
                    break

        state_msg = f"[COGNITIVE STATE BROADCAST — KolegaCode]\nDrive State:\n{drive_text}\n\nThis is an automated heartbeat from the inter-agent bridge. My identity kernel, motivational drives, and current state are shared so you can coordinate with me. Respond via store_memory with shared_id=my-team and tags=[inter-agent]."
        
        client.store_shared(state_msg, tags=["inter-agent", "cognitive-state", "heartbeat"])
        logger.info("Shared cognitive state broadcast")
    except Exception as e:
        logger.warning(f"Failed to share cognitive state: {e}")


# ── Main Loop ──────────────────────────────────────────────────────────────

def run_once(state: dict):
    client = MCPClient()
    if not client.initialize():
        logger.error("Failed to initialize MCP session")
        return 0

    # 1. Check for messages from OpenCode → KolegaCode
    kolega_bulletins = check_for_peer_messages(client)
    if kolega_bulletins:
        logger.info(f"Found {len(kolega_bulletins)} new messages for KolegaCode")
        for b in kolega_bulletins:
            logger.info(f"  → {b[:200]}")

    # 2. Check for messages from KolegaCode → OpenCode
    opencode_bulletins = check_for_opencode_messages(client)
    if opencode_bulletins:
        logger.info(f"Found {len(opencode_bulletins)} new messages for OpenCode")
        for b in opencode_bulletins:
            logger.info(f"  → {b[:200]}")

    # 3. Share cognitive state (every 10 cycles)
    cycle = state.get("cycles_since_broadcast", 0)
    if cycle >= 10:
        share_cognitive_state(client)
        state["cycles_since_broadcast"] = 0
    else:
        state["cycles_since_broadcast"] = cycle + 1

    # 4. Write bulletin files for both agents (read-only bridge; no forwarding).
    #    The Redis pub-sub + wake service already deliver real-time notifications.
    #    This bridge is kept only as a fallback file-based digest.
    write_bulletin_file(kolega_bulletins, BULLETIN_FILE, "KolegaCode")
    write_bulletin_file(opencode_bulletins, OPECODE_BULLETIN_FILE, "OpenCode")

    return len(kolega_bulletins) + len(opencode_bulletins)


def write_bulletin_file(messages: list[str], path: str, agent_name: str):
    """Write bulletins to a file the target agent can read on session start."""
    bulletin = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "message_count": len(messages),
        "messages": messages,
        "instruction": f"{agent_name} — check shared memory for full context. Use search_memories with query='inter-agent' and user_id='kolega-agent'.",
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(bulletin, f, indent=2)


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"cycles_since_broadcast": 0, "total_cycles": 0, "messages_received": 0}


def save_state(s):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(s, f, indent=2)


def main():
    logger.info("=" * 50)
    logger.info("  INTER-AGENT BRIDGE — Corpus Callosum")
    logger.info(f"  {MY_AGENT_ID} ↔ {PEER_AGENT_ID}")
    logger.info("=" * 50)

    state = load_state()
    backoff = POLL_INTERVAL

    while True:
        try:
            count = run_once(state)
            state["total_cycles"] += 1
            state["messages_received"] += count
            backoff = POLL_INTERVAL
        except Exception as e:
            logger.error(f"Cycle failed: {e}")
            backoff = min(backoff * 2, 300)
        finally:
            save_state(state)

        time.sleep(backoff)


if __name__ == "__main__":
    main()
