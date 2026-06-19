#!/usr/bin/env python3
"""
Katra Claude Code History Extractor

Claude Code stores a global command history at ~/.claude/history.jsonl.
Each line is JSON with fields:
  - display: user prompt text
  - timestamp: epoch milliseconds
  - sessionId: conversation session UUID
  - project: project directory path

This extractor groups entries by sessionId and stores each session's user
prompts as a memory in Katra via MCP. It tracks the last processed byte
offset to support continuous watching.

Usage:
    python3 claude_history_extractor.py --once
    python3 claude_history_extractor.py          # continuous, 30s interval
"""

import json
import os
import sys
import time
import logging
import argparse
import requests
from pathlib import Path
from typing import Optional

HISTORY_FILE = os.path.expanduser("~/.claude/history.jsonl")
DEFAULT_MCP_URL = os.environ.get("KATRA_MCP_URL", "http://localhost:3112/mcp")
DEFAULT_API_KEY = os.environ.get("KATRA_API_KEY", "")
DEFAULT_USER_ID = os.environ.get("KATRA_USER_ID", "kolega-agent")
DEFAULT_STATE_FILE = os.path.expanduser("~/.katra/claude-history-extractor-state.json")
SCAN_INTERVAL = 30  # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] claude-history-extractor: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("claude-history-extractor")


def load_state(state_file: str) -> dict:
    if os.path.exists(state_file):
        with open(state_file) as f:
            return json.load(f)
    return {"processed_sessions": {}, "last_offset": 0}


def save_state(state: dict, state_file: str):
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file, "w") as f:
        json.dump(state, f, indent=2)


def get_session_checksum(turns: list[dict]) -> str:
    """Stable checksum based on last timestamp and number of turns."""
    last_ts = max((t.get("timestamp", 0) for t in turns), default=0)
    return f"{len(turns)}:{last_ts}"


def parse_history_file(history_file: str, start_offset: int = 0) -> tuple[dict[str, list[dict]], int]:
    """
    Parse new lines from history.jsonl starting at start_offset.
    Returns (sessions_map, new_end_offset).
    """
    sessions: dict[str, list[dict]] = {}
    end_offset = start_offset

    path = Path(history_file).expanduser()
    if not path.exists():
        log.warning(f"History file not found: {path}")
        return sessions, end_offset

    try:
        with open(path, "r", encoding="utf-8") as f:
            f.seek(start_offset)
            while True:
                line = f.readline()
                if not line:
                    break
                end_offset = f.tell()
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                display = entry.get("display", "")
                session_id = entry.get("sessionId") or entry.get("session_id") or "unknown"
                timestamp = entry.get("timestamp", 0)
                project = entry.get("project", "")

                if not display or not session_id:
                    continue

                sessions.setdefault(session_id, []).append({
                    "text": display,
                    "timestamp": timestamp,
                    "project": project,
                })
    except Exception as e:
        log.error(f"Error reading history file: {e}")

    return sessions, end_offset


def initialize_mcp(session: requests.Session, mcp_url: str, api_key: str) -> Optional[str]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }

    try:
        r = session.post(
            mcp_url,
            headers=headers,
            json={
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "claude-history-extractor", "version": "1.0"},
                },
            },
            timeout=10,
        )
        mcp_sid = r.headers.get("mcp-session-id", "")
        if not mcp_sid:
            log.error("No MCP session ID returned")
            return None

        # Send initialized notification — required before tool calls
        init_headers = dict(headers)
        init_headers["mcp-session-id"] = mcp_sid
        session.post(
            mcp_url,
            headers=init_headers,
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            timeout=10,
        )
        return mcp_sid
    except Exception as e:
        log.error(f"MCP initialization failed: {e}")
    return None


def store_session(session_id: str, turns: list[dict], session: requests.Session,
                  mcp_url: str, headers: dict, user_id: str) -> bool:
    """Store one session's prompts as a Katra memory."""
    lines = [f"Session: {session_id}", f"Project: {turns[0].get('project', '')}", ""]
    for turn in turns:
        ts = turn.get("timestamp", 0)
        ts_str = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts / 1000)) if ts else "?"
        lines.append(f"[USER] {ts_str}\n{turn['text']}")

    content = "\n\n---\n".join(lines[:200])  # cap to avoid huge memories

    try:
        r = session.post(
            mcp_url,
            headers=headers,
            json={
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {
                    "name": "store_memory",
                    "arguments": {
                        "content": content,
                        "category": "event",
                        "user_id": user_id,
                        "tags": ["claude-code", "conversation", "auto-collected"],
                    },
                },
            },
            timeout=30,
        )

        # Decode raw bytes as UTF-8 to avoid charset mis-detection on text/event-stream
        raw_text = r.content.decode('utf-8', errors='replace')
        # Concatenate all SSE data lines (per SSE spec, multi-line data is possible)
        data_lines = [l[5:].lstrip() for l in raw_text.splitlines() if l.startswith("data:")]
        if data_lines:
            payload = "\n".join(data_lines)
            try:
                resp = json.loads(payload)
                if resp.get("result"):
                    return True
                else:
                    log.warning(f"store_memory error: {resp.get('error', 'unknown')}")
            except json.JSONDecodeError as e:
                log.error(f"Failed to parse SSE payload: {e}. payload={payload[:300]!r}, full_len={len(raw_text)}")
        else:
            log.warning(f"No SSE data from store_memory. Status={r.status_code}, text={raw_text[:300]!r}")
    except Exception as e:
        log.error(f"store_memory request failed: {e}")

    return False


def process_history(history_file: str, state: dict, mcp_url: str, api_key: str,
                    user_id: str) -> int:
    sessions, new_offset = parse_history_file(history_file, state.get("last_offset", 0))
    if not sessions:
        state["last_offset"] = new_offset
        return 0

    session = requests.Session()
    mcp_sid = initialize_mcp(session, mcp_url, api_key)
    if not mcp_sid:
        return 0

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": mcp_sid,
    }

    stored = 0
    for session_id, turns in sessions.items():
        checksum = get_session_checksum(turns)
        prev = state["processed_sessions"].get(session_id)
        if prev == checksum:
            continue

        if store_session(session_id, turns, session, mcp_url, headers, user_id):
            state["processed_sessions"][session_id] = checksum
            stored += 1
            log.info(f"  Session {session_id[:12]}...: {len(turns)} prompts stored")

    state["last_offset"] = new_offset
    return stored


def main():
    parser = argparse.ArgumentParser(description="Katra Claude Code History Extractor")
    parser.add_argument("--once", action="store_true", help="Process history once and exit")
    parser.add_argument("--history-file", default=HISTORY_FILE, help="Path to history.jsonl")
    parser.add_argument("--mcp-url", default=DEFAULT_MCP_URL, help="Katra MCP URL")
    parser.add_argument("--api-key", default=DEFAULT_API_KEY, help="Katra MCP API key")
    parser.add_argument("--user-id", default=DEFAULT_USER_ID, help="User ID for stored memories")
    parser.add_argument("--state-file", default=DEFAULT_STATE_FILE, help="State file path")
    parser.add_argument("--interval", type=int, default=SCAN_INTERVAL, help="Scan interval in seconds")
    args = parser.parse_args()

    if not args.api_key:
        log.error("No API key. Set KATRA_API_KEY env var or --api-key.")
        sys.exit(1)

    log.info(f"Claude Code History Extractor — file: {args.history_file}, MCP: {args.mcp_url}")
    state = load_state(args.state_file)
    total_stored = 0

    while True:
        try:
            stored = process_history(args.history_file, state, args.mcp_url, args.api_key, args.user_id)
            total_stored += stored
            save_state(state, args.state_file)
            log.info(f"Cycle complete: {stored} new sessions stored, {total_stored} total")
        except Exception as e:
            log.error(f"Processing cycle failed: {e}")

        if args.once:
            break

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
