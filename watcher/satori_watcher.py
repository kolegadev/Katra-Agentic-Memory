#!/usr/bin/env python3
"""
Katra Multi-Platform Session Memory Watcher

Watches session directories for OpenClaw, Claude Code, OpenCode, Codex CLI, Hermes,
KiloClaw, KimiClaw, and any agentic platform that writes JSONL conversation logs.
Parses user/assistant messages and stores them in the Katra MCP server for
persistent cross-platform recall.

Each session file's conversation turns are batched into one store_memory call.

Usage:
    python3 katra_watcher.py --once     # Process all sessions once and exit
    python3 katra_watcher.py            # Watch continuously (default 30s interval)
    python3 katra_watcher.py --config ~/.katra/watcher-config.json

Config file supports multi-platform session directories.
Without --config, defaults to OpenClaw only (~/.openclaw/agents).

Environment:
    KATRA_MCP_URL=http://localhost:3112/mcp
    KATRA_API_KEY=your-api-key
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

# ── Config ──────────────────────────────────────────────────────────────────
DEFAULT_SESSIONS_DIR = os.path.expanduser("~/.openclaw/agents")
DEFAULT_MCP_URL = os.environ.get("KATRA_MCP_URL", "http://localhost:3112/mcp")
DEFAULT_API_KEY = os.environ.get("KATRA_API_KEY", "")
DEFAULT_STATE_FILE = os.path.expanduser("~/.katra/watcher-state.json")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] katra-watcher: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("katra-watcher")


def load_state(state_file: str) -> dict:
    if os.path.exists(state_file):
        with open(state_file) as f:
            return json.load(f)
    return {"processed_files": {}}


def save_state(state: dict, state_file: str):
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file, "w") as f:
        json.dump(state, f, indent=2)


def get_file_hash(filepath: str) -> str:
    stat = os.stat(filepath)
    return hashlib.sha256(f"{stat.st_mtime}:{stat.st_size}".encode()).hexdigest()


def parse_jsonl_session(filepath: str) -> tuple[str, list[str], str, str]:
    """Parse a JSONL session file (OpenClaw/Claude Code/KiloClaw format).
    Returns (session_id, turn_texts, provider, model)."""
    turns = []
    session_id = None
    provider = None
    model_id = None

    try:
        with open(filepath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # OpenClaw-style entries
                if entry.get("type") == "session":
                    session_id = entry.get("id")
                if entry.get("type") == "model_change":
                    provider = entry.get("provider") or provider
                    model_id = entry.get("modelId") or model_id

                # Claude Code-style entries (type may differ)
                if entry.get("type") == "message" or "message" in entry:
                    msg = entry.get("message", entry)
                    role = msg.get("role", "")
                    content = msg.get("content", [])
                    ts = entry.get("timestamp", msg.get("timestamp", ""))

                    text_parts = []
                    for block in (content if isinstance(content, list) else [content]):
                        if isinstance(block, dict) and block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif isinstance(block, str):
                            text_parts.append(block)

                    full_text = "\n".join(text_parts).strip()
                    if full_text:
                        turns.append(f"[{role.upper()}] {ts}\n{full_text}")

    except Exception as e:
        log.warning(f"Error parsing {os.path.basename(filepath)}: {e}")

    return session_id or os.path.basename(filepath), turns, provider or "unknown", model_id or "unknown"


def store_session_to_memory(session_id: str, turns: list[str], provider: str, model: str,
                            mcp_url: str, api_key: str, user_id: str = "default") -> int:
    """Initialize MCP session and store all turns from a session as one memory."""
    if not api_key:
        log.error("No API key configured. Set KATRA_API_KEY or api_key in config.")
        return 0

    session = requests.Session()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }

    try:
        # Initialize MCP session
        r = session.post(
            mcp_url,
            headers=headers,
            json={
                # Unique per-request id — avoids response cross-wiring when calls
                # are multiplexed over a shared mcp-session-id.
                "jsonrpc": "2.0", "id": f"init-{uuid.uuid4().hex}", "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "katra-watcher", "version": "1.0"},
                },
            },
            timeout=10,
        )
        mcp_sid = r.headers.get("mcp-session-id", "")
        if not mcp_sid:
            log.error("No session ID from MCP server")
            return 0

        # Send initialized notification (required before tool calls)
        init_headers = dict(headers)
        init_headers["mcp-session-id"] = mcp_sid
        session.post(
            mcp_url,
            headers=init_headers,
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            timeout=10,
        )

        # Build batched content
        content = f"Session: {session_id} | Provider: {provider}/{model}\n"
        content += "=" * 60 + "\n"
        content += "\n---\n".join(turns)

        summary = turns[0][:200].replace("\n", " ") if turns else "Empty session"
        if len(turns) > 1:
            summary += f" (+{len(turns)-1} more turns)"

        # Store memory
        r2 = session.post(
            mcp_url,
            headers=init_headers,
            json={
                "jsonrpc": "2.0", "id": f"call-{uuid.uuid4().hex}", "method": "tools/call",
                "params": {
                    "name": "store_memory",
                    "arguments": {
                        "content": content,
                        "user_id": user_id,
                        "category": "event",
                        "confidence": 0.9,
                    },
                },
            },
            timeout=30,
        )

        # Decode raw bytes as UTF-8 and concatenate all SSE data lines
        raw_text = r2.content.decode('utf-8', errors='replace')
        data_lines = [l[5:].lstrip() for l in raw_text.splitlines() if l.startswith("data:")]
        if data_lines:
            payload = "\n".join(data_lines)
            try:
                resp = json.loads(payload)
                if resp.get("result"):
                    return len(turns)
                else:
                    log.warning(f"store_memory error: {resp.get('error', 'unknown')}")
            except json.JSONDecodeError as e:
                log.error(f"Failed to parse SSE payload: {e}. payload={payload[:300]!r}")
        else:
            log.warning("No SSE response from store_memory")

        return 0

    except requests.exceptions.ConnectionError as e:
        log.error(f"MCP connection failed: {e} — is Katra running?")
        return 0
    except Exception as e:
        log.error(f"store_memory exception: {e}")
        return 0


def process_file(filepath: str, state: dict, mcp_url: str, api_key: str, user_id: str) -> int:
    file_hash = get_file_hash(filepath)
    if state["processed_files"].get(filepath) == file_hash:
        return 0

    session_id, turns, provider, model = parse_jsonl_session(filepath)
    if not turns:
        return 0

    stored = store_session_to_memory(session_id, turns, provider, model, mcp_url, api_key, user_id)

    if stored > 0:
        state["processed_files"][filepath] = file_hash
        log.info(f"  {os.path.basename(filepath)}: {stored} turns stored")

    return stored


def find_session_files(sessions_dir: str, glob_pattern: str = "**/*.jsonl",
                       exclude_patterns: list = None) -> list[str]:
    """Find all session files matching a glob pattern within sessions_dir."""
    if exclude_patterns is None:
        exclude_patterns = ["trajectory"]

    files = []
    base = Path(sessions_dir).expanduser()
    if not base.exists():
        log.warning(f"Session directory not found: {sessions_dir}")
        return files

    for f in base.rglob(glob_pattern):
        if f.is_file() and f.suffix == '.jsonl':
            name = f.name
            if not any(excl in name for excl in exclude_patterns):
                files.append(str(f))
    return sorted(files)


def load_platform_config(config_path: str = None) -> tuple[list[dict], str, str, str, str]:
    """Load multi-platform session directory config.
    Returns (platforms, mcp_url, api_key, state_file, default_user_id)."""
    mcp_url = DEFAULT_MCP_URL
    api_key = DEFAULT_API_KEY
    state_file = DEFAULT_STATE_FILE
    user_id = "default"

    if config_path:
        config_path = os.path.expanduser(config_path)
        if os.path.exists(config_path):
            with open(config_path) as f:
                config = json.load(f)

            mcp_url = config.get("mcp_url", mcp_url)
            api_key = config.get("api_key", api_key)
            state_file = config.get("state_file", state_file)
            user_id = config.get("default_user_id", user_id)

            platforms = config.get("platforms", [])
            if platforms:
                return platforms, mcp_url, api_key, state_file, user_id

    # Default: OpenClaw only
    return [{
        "name": "openclaw",
        "session_dir": DEFAULT_SESSIONS_DIR,
        "glob": "**/sessions/*.jsonl",
        "exclude": ["trajectory"]
    }], mcp_url, api_key, state_file, user_id


def main():
    parser = argparse.ArgumentParser(description="Katra Multi-Platform Session Memory Watcher")
    parser.add_argument("--once", action="store_true", help="Process all sessions once and exit")
    parser.add_argument("--config", default=None, help="Path to multi-platform watcher-config.json")
    parser.add_argument("--sessions-dir", default=None, help="Override session directory")
    parser.add_argument("--mcp-url", default=None, help="Override MCP server URL")
    parser.add_argument("--api-key", default=None, help="Override API key")
    parser.add_argument("--user-id", default=None, help="Override default user ID")
    parser.add_argument("--interval", type=int, default=30, help="Scan interval in seconds (default: 30)")
    args = parser.parse_args()

    platforms, mcp_url, api_key, state_file, user_id = load_platform_config(args.config)

    # Apply CLI overrides
    if args.mcp_url:
        mcp_url = args.mcp_url
    if args.api_key:
        api_key = args.api_key
    if args.user_id:
        user_id = args.user_id
    if args.sessions_dir:
        platforms = [{"name": "custom", "session_dir": args.sessions_dir,
                       "glob": "**/*.jsonl", "exclude": ["trajectory"]}]

    if not api_key:
        log.error("No API key. Set KATRA_API_KEY env var or api_key in config.")
        sys.exit(1)

    log.info(f"Katra Memory Watcher — {len(platforms)} platform(s), MCP: {mcp_url}")
    state = load_state(state_file)
    total_stored = 0

    while True:
        for platform in platforms:
            name = platform["name"]
            session_dir = os.path.expanduser(platform["session_dir"])
            glob_pat = platform.get("glob", "**/*.jsonl")
            exclude = platform.get("exclude", ["trajectory"])
            plat_user_id = platform.get("user_id", user_id)

            files = find_session_files(session_dir, glob_pat, exclude)

            for filepath in files:
                try:
                    stored = process_file(filepath, state, mcp_url, api_key, plat_user_id)
                    total_stored += stored
                except Exception as e:
                    log.error(f"Error [{name}] {os.path.basename(filepath)}: {e}")

            save_state(state, state_file)

        log.info(f"Scanned {len(platforms)} platform(s), {total_stored} total turns stored")

        if args.once:
            break

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
