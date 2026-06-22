#!/usr/bin/env python3
"""
Katra OpenCode Session Extractor — Delta-Aware, Turn-by-Turn

OpenCode stores sessions in SQLite (~/.local/share/opencode/opencode.db).
This extractor reads user/assistant message turns, dedupes at the individual
turn level (not full session), and streams each turn pair as a discrete event
into Katra so the LLM background processor can distill them into 1-2 sentence
insights rather than processing a single monolithic blob.

Usage:
    python3 katra_opencode_extractor.py --once
    python3 katra_opencode_extractor.py          # watch continuously (default)
"""

import json
import os
import sqlite3
import time
import hashlib
import logging
import argparse
import requests

# ── Config ──────────────────────────────────────────────────────────────────
OPENCODE_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
DEFAULT_MCP_URL = os.environ.get("KATRA_MCP_URL", "http://localhost:3112/mcp")
DEFAULT_API_KEY = os.environ.get("KATRA_API_KEY", "")
DEFAULT_STATE_FILE = os.path.expanduser("~/.katra/opencode-extractor-state.json")
DEFAULT_USER_ID = os.environ.get("KATRA_USER_ID", "opencode")
DEFAULT_SHARED_ID = os.environ.get("KATRA_SHARED_ID", "")
SCAN_INTERVAL = 30  # seconds
MAX_TURN_TEXT_CHARS = 4000  # cap per-turn text to avoid huge payloads

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] katra-opencode: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("katra-opencode")


# ── State Management ────────────────────────────────────────────────────────

def load_state(state_file: str) -> dict:
    if os.path.exists(state_file):
        with open(state_file) as f:
            state = json.load(f)
    else:
        state = {}
    state.setdefault("processed_turns", {})
    return state


def save_state(state: dict, state_file: str):
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file, "w") as f:
        json.dump(state, f, indent=2)


def turn_hash(session_id: str, turn_index: int, role: str, text: str) -> str:
    """Deterministic per-turn hash for dedupe."""
    raw = f"{session_id}:{turn_index}:{role}:{text}"
    return hashlib.sha256(raw.encode()).hexdigest()


# ── Database Extraction ─────────────────────────────────────────────────────

def extract_turns(db_path: str) -> list[dict]:
    """Extract individual turns (not sessions) with user/assistant ordering."""
    if not os.path.exists(db_path):
        log.warning(f"OpenCode DB not found: {db_path}")
        return []

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    turns = []

    try:
        rows = conn.execute("""
            SELECT
                m.session_id,
                m.id AS message_id,
                m.time_created,
                json_extract(m.data, '$.role') AS role,
                json_extract(p.data, '$.text')  AS text
            FROM message m
            JOIN part p ON p.message_id = m.id
            WHERE json_extract(p.data, '$.type') = 'text'
              AND json_extract(m.data, '$.role') IN ('user', 'assistant')
              AND json_extract(p.data, '$.text') IS NOT NULL
              AND json_extract(p.data, '$.text') != ''
            ORDER BY m.session_id, m.time_created ASC
        """).fetchall()

        for row in rows:
            turns.append({
                "session_id":   row["session_id"],
                "message_id":   row["message_id"],
                "role":         row["role"],
                "text":         row["text"][:MAX_TURN_TEXT_CHARS],
                "timestamp":    row["time_created"],
            })
    except Exception as e:
        log.error(f"Error reading OpenCode DB: {e}")
    finally:
        conn.close()

    return turns


# ── MCP Client ───────────────────────────────────────────────────────────────

class McpClient:
    """Persistent MCP client that reuses the SSE session across calls."""

    def __init__(self, mcp_url: str, api_key: str):
        self.mcp_url = mcp_url
        self.session_headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        self.session_id = None

    def _initialize(self) -> bool:
        try:
            r = requests.post(
                self.mcp_url,
                headers=self.session_headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 0,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "katra-opencode", "version": "2.0"},
                    },
                },
                timeout=10,
            )
            sid = r.headers.get("mcp-session-id", "")
            if sid:
                self.session_id = sid
                self.session_headers["mcp-session-id"] = sid
                return True
            log.error("No MCP session ID in initialize response")
        except Exception as e:
            log.error(f"MCP initialize error: {e}")
        return False

    def call_tool(self, tool_name: str, arguments: dict) -> bool:
        """Call an MCP tool, re-initializing the session if needed."""
        if not self.session_id:
            if not self._initialize():
                return False

        try:
            r = requests.post(
                self.mcp_url,
                headers=self.session_headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": tool_name, "arguments": arguments},
                },
                timeout=30,
            )
            data_line = [l for l in r.text.split("\n") if l.startswith("data:")]
            if data_line:
                resp = json.loads(data_line[0][6:])
                if resp.get("result"):
                    return True
                err = resp.get("error", {})
                if "session" in str(err).lower() or "not initialized" in str(err).lower():
                    # Session expired — re-init and retry once
                    self.session_id = None
                    if self._initialize():
                        return self.call_tool(tool_name, arguments)
                log.warning(f"MCP tool error: {err}")
        except Exception as e:
            log.error(f"MCP call error: {e}")
            self.session_id = None  # force re-init next time
        return False


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Katra OpenCode Session Extractor (delta)")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--db", default=OPENCODE_DB)
    parser.add_argument("--mcp-url", default=DEFAULT_MCP_URL)
    parser.add_argument("--api-key", default=DEFAULT_API_KEY)
    parser.add_argument("--user-id", default=DEFAULT_USER_ID)
    parser.add_argument("--shared-id", default=DEFAULT_SHARED_ID,
                        help="Shared consciousness ID (requires Katra shared/hybrid mode)")
    args = parser.parse_args()

    if not args.api_key:
        log.error("No API key. Set KATRA_API_KEY env var or --api-key.")
        return

    log.info(
        f"Katra OpenCode Extractor v2 (delta) — DB: {args.db}, "
        f"MCP: {args.mcp_url}, user_id: {args.user_id}, "
        f"shared_id: {args.shared_id or '(none)'}"
    )

    state = load_state(DEFAULT_STATE_FILE)
    client = McpClient(args.mcp_url, args.api_key)

    while True:
        all_turns = extract_turns(args.db)
        stored_count = 0
        skipped_count = 0

        # Assign per-session indices for consistent ordering (reset each cycle)
        turn_idx_counter = {}
        for t in all_turns:
            sid = t["session_id"]
            if sid not in turn_idx_counter:
                turn_idx_counter[sid] = 0
            t["turn_index"] = turn_idx_counter[sid]
            turn_idx_counter[sid] += 1

        for turn in all_turns:
            th = turn_hash(turn["session_id"], turn["turn_index"],
                           turn["role"], turn["text"])

            if state["processed_turns"].get(th):
                skipped_count += 1
                continue

            # Build event content: role + timestamp + text
            ts_str = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(turn["timestamp"] / 1000)
            )
            content = f"[{turn['role'].upper()}] {ts_str}\n{turn['text']}"

            memory_args = {
                "content":    content,
                "category":   "event",
                "user_id":    args.user_id,
                "confidence": 0.9,
                "session_id": turn["session_id"],
                "source":     "opencode",
                "tags":       ["conversation", "opencode"],
            }
            if args.shared_id:
                memory_args["shared_id"] = args.shared_id

            if client.call_tool("store_memory", memory_args):
                state["processed_turns"][th] = True
                stored_count += 1
            else:
                log.warning(f"  Failed to store turn {turn['turn_index']} "
                            f"in session {turn['session_id'][:12]}")

        save_state(state, DEFAULT_STATE_FILE)

        total_tracked = len(state["processed_turns"])
        log.info(
            f"Cycle: {len(all_turns)} turns scanned, "
            f"{stored_count} new stored, {skipped_count} skipped, "
            f"{total_tracked} total tracked"
        )

        if args.once:
            break

        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
