#!/usr/bin/env python3
"""
Katra Kolega Code Session Extractor

Kolega Code (Claude-Code-architecture-based agentic CLI) stores sessions as
single JSON files in ~/Library/Application Support/kolega-code/sessions/.
Each file contains a "history" array of user/assistant messages with full
content blocks (text, thinking, tool_call, tool_result).

This extractor captures the complete turn-by-turn transcript — user prompts,
assistant replies, reasoning traces, and tool interactions — and stores each
session as an episodic memory in Katra via MCP.

Usage:
    python3 kolega_code_extractor.py --once
    python3 kolega_code_extractor.py          # continuous, 30s interval
"""

import json
import os
import sys
import time
import uuid
import hashlib
import logging
import argparse
import requests
from pathlib import Path
from typing import Optional

DEFAULT_SESSIONS_DIR = os.path.expanduser(
    "~/Library/Application Support/kolega-code/sessions"
)
DEFAULT_MCP_URL = os.environ.get("KATRA_MCP_URL", "http://localhost:3112/mcp")
DEFAULT_API_KEY = os.environ.get("KATRA_API_KEY", "")
DEFAULT_USER_ID = os.environ.get("KATRA_USER_ID", "kolega-agent")
DEFAULT_STATE_FILE = os.path.expanduser("~/.katra/kolega-code-extractor-state.json")
SCAN_INTERVAL = 30  # seconds
MAX_TOOL_RESULT_CHARS = 4000
MAX_MEMORY_CHARS = 100_000
_INCLUDE_THINKING = True

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] kolega-code-extractor: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("kolega-code-extractor")


def load_state(state_file: str) -> dict:
    if os.path.exists(state_file):
        with open(state_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"processed_sessions": {}}


def save_state(state: dict, state_file: str):
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def get_session_checksum(transcript: str) -> str:
    """Stable checksum for the extracted transcript content."""
    return hashlib.sha256(transcript.encode("utf-8")).hexdigest()[:32]


def get_file_checksum(path: Path) -> str:
    """Checksum based on file size and mtime for quick change detection."""
    stat = path.stat()
    raw = f"{path}:{stat.st_size}:{stat.st_mtime_ns}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def extract_text_from_block(block: dict) -> Optional[str]:
    """Extract human-readable text from a content block."""
    block_type = block.get("type")

    if block_type == "text":
        return block.get("text", "")

    if block_type == "thinking":
        if not _INCLUDE_THINKING:
            return None
        thinking = block.get("thinking", "")
        if thinking:
            return f"[THINKING]\n{thinking}"
        return None

    if block_type == "tool_call":
        name = block.get("name", "unknown")
        tool_input = block.get("input", {})
        try:
            input_json = json.dumps(tool_input, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            input_json = str(tool_input)
        return f"[TOOL_CALL] {name}\ninput: {input_json}"

    if block_type == "tool_result":
        name = block.get("name", "unknown")
        content = block.get("content", "")
        is_error = block.get("is_error", False)
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and "text" in item:
                    parts.append(str(item["text"]))
                elif isinstance(item, dict) and "content" in item:
                    parts.append(str(item["content"]))
                else:
                    parts.append(str(item))
            content = "\n".join(parts)
        content = str(content)
        if len(content) > MAX_TOOL_RESULT_CHARS:
            content = content[:MAX_TOOL_RESULT_CHARS] + "\n... [truncated]"
        prefix = "[TOOL_RESULT]"
        if is_error:
            prefix = "[TOOL_RESULT ERROR]"
        return f"{prefix} {name}\n{content}"

    return None


def extract_message_text(message: dict) -> str:
    """Extract readable text from a single message's content blocks."""
    content = message.get("content", [])
    if isinstance(content, str):
        return content.strip()

    parts = []
    seen_tool_results = False
    for block in content:
        if not isinstance(block, dict):
            continue

        # For user messages, tool_result blocks are feedback from the harness.
        # For assistant messages, tool_result blocks are normally not present.
        if block.get("type") == "tool_result":
            seen_tool_results = True

        text = extract_text_from_block(block)
        if text:
            parts.append(text)

    # If a user message only contains tool_results, label it explicitly so the
    # transcript still shows a turn happened.
    if seen_tool_results and not parts:
        return "[tool results]"

    return "\n\n".join(parts).strip()


def parse_session_file(path: Path) -> Optional[dict]:
    """Parse a Kolega Code session JSON file into a transcript dict."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        log.warning(f"JSON decode error in {path.name}: {e}")
        return None
    except Exception as e:
        log.warning(f"Error reading {path.name}: {e}")
        return None

    session_id = path.stem
    history = data.get("history", [])
    config = data.get("config", {})
    created_at = data.get("created_at", "")

    model = config.get("long_model") or config.get("fast_model") or "unknown"
    provider = config.get("long_provider") or config.get("fast_provider") or "unknown"

    turns = []
    for idx, message in enumerate(history):
        role = message.get("role")
        if role not in ("user", "assistant"):
            continue

        text = extract_message_text(message)
        if not text:
            continue

        stop_reason = message.get("stop_reason")
        usage = message.get("usage_metadata", {})

        turns.append({
            "index": idx + 1,
            "role": role,
            "text": text,
            "stop_reason": stop_reason,
            "usage": usage,
        })

    if not turns:
        return None

    lines = [
        f"Session: {session_id}",
        f"Source: kolega-code",
        f"Created: {created_at}",
        f"Model: {model} ({provider})",
        f"Turns: {len(turns)}",
        "",
    ]

    for turn in turns:
        header = f"--- Turn {turn['index']} [{turn['role'].upper()}] ---"
        if turn.get("stop_reason"):
            header += f" (stop: {turn['stop_reason']})"
        lines.append(header)
        lines.append(turn["text"])
        lines.append("")

    transcript = "\n".join(lines)
    if len(transcript) > MAX_MEMORY_CHARS:
        transcript = transcript[:MAX_MEMORY_CHARS] + "\n\n... [transcript truncated]"

    return {
        "session_id": session_id,
        "created_at": created_at,
        "model": model,
        "provider": provider,
        "turn_count": len(turns),
        "transcript": transcript,
        "checksum": get_session_checksum(transcript),
        "file_checksum": get_file_checksum(path),
    }


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
                "jsonrpc": "2.0",
                # Unique per-request id — avoids response cross-wiring when calls
                # are multiplexed over a shared mcp-session-id.
                "id": f"init-{uuid.uuid4().hex}",
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "kolega-code-extractor", "version": "1.0"},
                },
            },
            timeout=10,
        )
        mcp_sid = r.headers.get("mcp-session-id", "")
        if not mcp_sid:
            log.error("No MCP session ID returned")
            return None

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


def store_session(session: dict, mcp_url: str, api_key: str, user_id: str, shared_id: str = "") -> bool:
    """Store one session's full transcript as a Katra memory."""
    req_session = requests.Session()
    mcp_sid = initialize_mcp(req_session, mcp_url, api_key)
    if not mcp_sid:
        return False

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": mcp_sid,
    }

    try:
        r = req_session.post(
            mcp_url,
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": f"call-{uuid.uuid4().hex}",
                "method": "tools/call",
                "params": {
                    "name": "store_memory",
                    "arguments": {
                        "content": session["transcript"],
                        "category": "event",
                        "user_id": user_id,
                        "session_id": session["session_id"],
                        "source": "kolega-code",
                        "tags": [
                            "kolega-code",
                            "conversation",
                            "full-transcript",
                            "auto-collected",
                        ],
                        **({"shared_id": shared_id} if shared_id else {}),
                    },
                },
            },
            timeout=30,
        )

        raw_text = r.content.decode("utf-8", errors="replace")
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
                log.error(f"Failed to parse SSE payload: {e}. payload={payload[:300]!r}")
        else:
            log.warning(f"No SSE data from store_memory. Status={r.status_code}, text={raw_text[:300]!r}")
    except Exception as e:
        log.error(f"store_memory request failed: {e}")

    return False


def find_session_files(sessions_dir: str) -> list[Path]:
    path = Path(sessions_dir).expanduser()
    if not path.exists():
        log.warning(f"Sessions directory not found: {path}")
        return []
    return sorted(path.glob("*.json"))


def process_sessions(sessions_dir: str, state: dict, mcp_url: str, api_key: str,
                     user_id: str, shared_id: str = "") -> int:
    files = find_session_files(sessions_dir)
    stored = 0

    for path in files:
        try:
            session = parse_session_file(path)
            if not session:
                continue

            sid = session["session_id"]
            prev = state["processed_sessions"].get(sid)

            # Skip if transcript content hasn't changed since last cycle.
            if prev and prev.get("checksum") == session["checksum"]:
                continue

            log.info(
                f"Processing {sid[:12]}... ({session['turn_count']} turns, "
                f"{len(session['transcript'])} chars)"
            )

            if store_session(session, mcp_url, api_key, user_id, shared_id):
                state["processed_sessions"][sid] = {
                    "checksum": session["checksum"],
                    "file_checksum": session["file_checksum"],
                    "turn_count": session["turn_count"],
                    "stored_at": time.time(),
                }
                stored += 1
                log.info(f"  Stored {sid[:12]}... ({session['turn_count']} turns)")
            else:
                log.warning(f"  Failed to store {sid[:12]}...")

        except Exception as e:
            log.error(f"Error processing {path.name}: {e}")

    return stored


def main():
    parser = argparse.ArgumentParser(
        description="Katra Kolega Code full-turn transcript extractor"
    )
    parser.add_argument("--once", action="store_true", help="Process once and exit")
    parser.add_argument("--sessions-dir", default=DEFAULT_SESSIONS_DIR,
                        help="Path to kolega-code sessions directory")
    parser.add_argument("--mcp-url", default=DEFAULT_MCP_URL, help="Katra MCP URL")
    parser.add_argument("--api-key", default=DEFAULT_API_KEY, help="Katra MCP API key")
    parser.add_argument("--user-id", default=DEFAULT_USER_ID, help="User ID for stored memories")
    parser.add_argument("--state-file", default=DEFAULT_STATE_FILE, help="State file path")
    parser.add_argument("--interval", type=int, default=SCAN_INTERVAL,
                        help="Scan interval in seconds")
    parser.add_argument("--include-thinking", action="store_true", default=True,
                        help="Include assistant thinking blocks in transcript")
    parser.add_argument("--exclude-thinking", action="store_true",
                        help="Exclude assistant thinking blocks from transcript")
    parser.add_argument("--shared-id", default="", help="Shared ID for communal memory")
    args = parser.parse_args()

    if not args.api_key:
        log.error("No API key. Set KATRA_API_KEY env var or --api-key.")
        sys.exit(1)

    include_thinking = args.include_thinking and not args.exclude_thinking
    global _INCLUDE_THINKING
    _INCLUDE_THINKING = include_thinking

    log.info(
        f"Kolega Code Extractor — dir: {args.sessions_dir}, MCP: {args.mcp_url}, "
        f"thinking: {include_thinking}"
    )

    state = load_state(args.state_file)
    total_stored = 0

    while True:
        try:
            stored = process_sessions(
                args.sessions_dir, state, args.mcp_url, args.api_key, args.user_id, args.shared_id
            )
            total_stored += stored
            save_state(state, args.state_file)
            log.info(f"Cycle complete: {stored} new/updated sessions, {total_stored} total")
        except Exception as e:
            log.error(f"Processing cycle failed: {e}")

        if args.once:
            break

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
