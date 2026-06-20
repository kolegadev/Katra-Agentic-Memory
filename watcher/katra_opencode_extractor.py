#!/usr/bin/env python3
"""
Katra OpenCode Session Extractor

OpenCode stores sessions in SQLite (~/.local/share/opencode/opencode.db) rather than
JSONL files. This extractor reads user/assistant message turns, batches them by session,
and stores them in the Katra MCP server.

Usage:
    python3 katra_opencode_extractor.py --once     # Extract all sessions once
    python3 katra_opencode_extractor.py            # Watch continuously (default)
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
SCAN_INTERVAL = 30  # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] katra-opencode: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("katra-opencode")


def load_state(state_file: str) -> dict:
    if os.path.exists(state_file):
        with open(state_file) as f:
            return json.load(f)
    return {"processed_sessions": {}}


def save_state(state: dict, state_file: str):
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file, "w") as f:
        json.dump(state, f, indent=2)


def extract_sessions(db_path: str) -> list[dict]:
    """Extract all sessions with user/assistant text turns from OpenCode DB."""
    sessions = {}

    if not os.path.exists(db_path):
        log.warning(f"OpenCode DB not found: {db_path}")
        return []

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    try:
        rows = conn.execute("""
            SELECT 
                m.session_id,
                m.time_created,
                json_extract(m.data, '$.role') as role,
                json_extract(p.data, '$.text') as text
            FROM message m
            JOIN part p ON p.message_id = m.id
            WHERE json_extract(p.data, '$.type') = 'text'
              AND json_extract(m.data, '$.role') IN ('user', 'assistant')
              AND json_extract(p.data, '$.text') IS NOT NULL
              AND json_extract(p.data, '$.text') != ''
            ORDER BY m.time_created ASC
        """).fetchall()

        for row in rows:
            sid = row["session_id"]
            role = row["role"]
            text = row["text"]
            ts = row["time_created"]

            if sid not in sessions:
                sessions[sid] = {"session_id": sid, "turns": [], "last_updated": 0}

            sessions[sid]["turns"].append({"role": role, "text": text, "timestamp": ts})
            sessions[sid]["last_updated"] = max(sessions[sid]["last_updated"], ts)

    except Exception as e:
        log.error(f"Error reading OpenCode DB: {e}")
    finally:
        conn.close()

    return list(sessions.values())


def get_session_checksum(session: dict) -> str:
    raw = f"{session['session_id']}:{len(session['turns'])}:{session['last_updated']}"
    return hashlib.sha256(raw.encode()).hexdigest()


def store_session(session: dict, state: dict, mcp_url: str, api_key: str, user_id: str) -> bool:
    checksum = get_session_checksum(session)
    if state["processed_sessions"].get(session["session_id"]) == checksum:
        return False

    lines = [f"Session: {session['session_id']}"]
    for turn in session["turns"]:
        role = turn["role"].upper()
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(turn["timestamp"] / 1000))
        lines.append(f"[{role}] {ts}\n{turn['text']}")
    content = "\n\n---\n".join(lines[:100])

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }

    try:
        r = requests.post(mcp_url, headers=headers, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "katra-opencode", "version": "1.0"}},
        }, timeout=10)
        sid = r.headers.get("mcp-session-id", "")
        if not sid:
            log.error("No MCP session ID")
            return False

        headers["mcp-session-id"] = sid
        r2 = requests.post(mcp_url, headers=headers, json={
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "store_memory", "arguments": {
                "content": content, "category": "event",
                "user_id": user_id, "confidence": 0.9,
            }},
        }, timeout=30)

        data_line = [l for l in r2.text.split("\n") if l.startswith("data:")]
        if data_line:
            resp = json.loads(data_line[0][6:])
            if resp.get("result"):
                state["processed_sessions"][session["session_id"]] = checksum
                return True
    except Exception as e:
        log.error(f"MCP error: {e}")

    return False


def main():
    parser = argparse.ArgumentParser(description="Katra OpenCode Session Extractor")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--db", default=OPENCODE_DB)
    parser.add_argument("--mcp-url", default=DEFAULT_MCP_URL)
    parser.add_argument("--api-key", default=DEFAULT_API_KEY)
    parser.add_argument("--user-id", default=DEFAULT_USER_ID)
    args = parser.parse_args()

    if not args.api_key:
        log.error("No API key. Set KATRA_API_KEY env var or --api-key.")
        return

    log.info(f"Katra OpenCode Extractor — DB: {args.db}, MCP: {args.mcp_url}")
    state = load_state(DEFAULT_STATE_FILE)

    while True:
        sessions = extract_sessions(args.db)
        stored = 0

        for session in sessions:
            if store_session(session, state, args.mcp_url, args.api_key, args.user_id):
                stored += 1
                log.info(f"  Session {session['session_id'][:12]}...: {len(session['turns'])} turns stored")

        save_state(state, DEFAULT_STATE_FILE)
        log.info(f"Extracted {len(sessions)} sessions, {stored} new, {len(state['processed_sessions'])} tracked")

        if args.once:
            break

        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
