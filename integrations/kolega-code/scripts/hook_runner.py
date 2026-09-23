#!/usr/bin/env python3
"""Kolega Code command-hook runner for the Katra memory bridge.

Why this file exists
--------------------
The Kolega CLI runs in a uv tool venv that is REBUILT on every
``kolega-code update`` (uv tool install --force --upgrade). Any package
installed into that venv is lost, so the bridge must not depend on it.
This runner executes in its own venv inside the Katra repo
(``integrations/kolega-code/.venv``) and is invoked as a *command* hook,
so the CLI never imports the bridge at all.

Hook contract (Claude-Code wire format)
---------------------------------------
stdin : JSON event document
        {hook_event_name, session_id, cwd, permission_mode, ...payload}
stdout: {"hookSpecificOutput": {"hookEventName": ..., "additionalContext": ...}}
exit  : always 0 for the TURN (a broken memory hook must never break the
        turn) — but the 2026-09-23 directive adds a FAIL-LOUD side channel:
        a broken bridge (defaulted config, empty bootstrap) writes an alarm
        marker (state_dir/bridge-alarm.json), prints loudly on stderr, and
        the machine-health collector escalates the marker to an alarm.

Handled events (2026-09-23 wake-ritual re-implementation):
  SessionStart      full bootstrap, all 11 sources            (startup)
  PostCompact       full bootstrap re-injection               (after /compress)
  UserPromptSubmit  query retrieval + CLEAR-DETECTION: when the CLI's
                    session store shows a new epoch since our last
                    bootstrap (clear_history() calls
                    start_epoch("agent_clear_command")), escalate to the
                    full bootstrap and prefix it before the query context.
"""

import asyncio
import json
import os
import socket
import sys
from datetime import datetime, timezone
from types import SimpleNamespace


def state_dir() -> str:
    if os.environ.get("KOLEGA_CODE_STATE_DIR"):
        return os.environ["KOLEGA_CODE_STATE_DIR"]
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "kolega-code")
    return os.path.join(os.environ.get("XDG_STATE_HOME", os.path.join(os.path.expanduser("~"), ".local", "state")), "kolega-code")


STATE_DIR = state_dir()
ALARM_FILE = os.path.join(STATE_DIR, "bridge-alarm.json")
SESSION_MARKER_DIR = os.path.join(STATE_DIR, "bridge-session")


def _write_alarm(event: str, reason: str, detail: str = "") -> None:
    """Fail-loud side channel: the turn stays open (exit 0) but the alarm is
    persisted and printed so a broken bridge can never hide for days again
    (the 2026-09-19 MacBook incident fingerprint was a 58-byte empty
    envelope with zero signal)."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(ALARM_FILE, "w") as f:
            json.dump(
                {
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "event": event,
                    "reason": reason,
                    "detail": detail,
                },
                f,
            )
    except OSError:
        pass
    print(f"katra-bridge-runner: BRIDGE ALARM [{event}]: {reason} {detail}".strip(), file=sys.stderr)


def _clear_alarm() -> None:
    try:
        if os.path.exists(ALARM_FILE):
            os.remove(ALARM_FILE)
    except OSError:
        pass


def _port_listening(host: str, port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _config_sanity_check() -> None:
    """The mcp_url/user_id fix in the hook path (directive item f): a config
    that fell through to defaults must raise an alarm, not a silent no-op.
    localhost:3112 is only legitimate on the machine actually serving Katra
    — on a client machine nothing listens there and the check fires."""
    try:
        from kolega_katra_bridge.config import load_config

        cfg = load_config()
        if not cfg.api_key:
            _write_alarm("config", "api_key is empty — bridge config is defaulted or missing (pre-f9b5031 satori-hook.json rename?)")
            return
        url = cfg.mcp_url or ""
        if "localhost" in url or "127.0.0.1" in url:
            if not _port_listening("localhost", 3112):
                _write_alarm("config", "mcp_url points at localhost:3112 but nothing serves Katra here — this machine is not the Katra host")
    except Exception as exc:
        _write_alarm("config", f"cannot load bridge config: {exc}")


def _load_event() -> dict | None:
    try:
        doc = json.load(sys.stdin)
    except Exception:
        return None
    return doc if isinstance(doc, dict) else None


def _latest_epoch_id(session_id: str) -> str | None:
    """Read the session's recorded epoch from the CLI's own store, tail only.
    clear_history() starts a new epoch ('agent_clear_command'), which is the
    ONLY reliable signal a /clear happened — the CLI emits no hook for it."""
    try:
        path = os.path.join(STATE_DIR, "sessions", session_id, "events.jsonl")
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 8192))
            tail = f.read().decode("utf-8", errors="ignore")
        for line in reversed(tail.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                doc = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(doc, dict) and doc.get("epoch_id"):
                return str(doc["epoch_id"])
        return None
    except OSError:
        return None


def _marker_path(session_id: str) -> str:
    return os.path.join(SESSION_MARKER_DIR, f"{session_id}.json")


def _read_marker(session_id: str) -> dict | None:
    try:
        with open(_marker_path(session_id)) as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else None
    except OSError:
        return None


def _write_marker(session_id: str, epoch_id: str | None) -> None:
    try:
        os.makedirs(SESSION_MARKER_DIR, exist_ok=True)
        with open(_marker_path(session_id), "w") as f:
            json.dump({"epoch_id": epoch_id, "ts": datetime.now(timezone.utc).isoformat()}, f)
    except OSError:
        pass


def _cleared_since_last_bootstrap(session_id: str) -> bool:
    """True when the CLI's session store is on an epoch we have not
    bootstrapped into — i.e. /clear (or any epoch restart) happened."""
    marker = _read_marker(session_id)
    if marker is None:
        return False  # no prior bootstrap in this session; SessionStart owns it
    epoch = _latest_epoch_id(session_id)
    if epoch is None:
        return False
    return marker.get("epoch_id") != epoch


async def _run_bootstrap(event: SimpleNamespace, session_id: str):
    from kolega_katra_bridge import hook as bridge_hook

    result = await bridge_hook.on_session_start(event)
    _write_marker(session_id, _latest_epoch_id(session_id))
    return result or {}


async def _run_prompt_with_escalation(event: SimpleNamespace, session_id: str):
    from kolega_katra_bridge import hook as bridge_hook

    result = (await bridge_hook.on_user_prompt(event)) or {}
    if _cleared_since_last_bootstrap(session_id):
        # /clear fired no hook — escalate to the full bootstrap so identity
        # and memory return on THIS turn, not one turn later.
        bootstrap = await _run_bootstrap(event, session_id)
        bctx = bootstrap.get("additional_context") or ""
        qctx = result.get("additional_context") or ""
        if bctx:
            result["additional_context"] = (bctx + "\n\n" + qctx).strip() if qctx else bctx
    return result


def main() -> int:
    doc = _load_event()
    if doc is None:
        return 0

    name = str(doc.get("hook_event_name") or "")
    user_message = str(doc.get("user_message") or doc.get("payload", {}).get("user_message", "") or "")
    session_id = str(doc.get("session_id") or "")
    event = SimpleNamespace(payload={"user_message": user_message}, session_id=session_id)

    try:
        _config_sanity_check()
        from kolega_katra_bridge import hook as bridge_hook

        if name == "SessionStart":
            result = asyncio.run(_run_bootstrap(event, session_id))
        elif name == "PostCompact":
            # After /compress the context was rewritten; re-run the FULL
            # bootstrap immediately (directive item b) — advisory PreCompact
            # stays unregistered.
            result = asyncio.run(_run_bootstrap(event, session_id))
        elif name == "UserPromptSubmit":
            result = asyncio.run(_run_prompt_with_escalation(event, session_id))
        else:
            return 0
    except Exception as exc:
        # Turn-safe fail-open, but loud: alarm + stderr, never silent.
        _write_alarm(name or "hook", f"bridge hook failed: {exc}")
        print(f"katra-bridge-runner: {name} failed: {exc}", file=sys.stderr)
        return 0

    ctx = result.get("additional_context")
    out: dict = {"hookSpecificOutput": {"hookEventName": name}}
    if ctx:
        out["hookSpecificOutput"]["additionalContext"] = ctx
    else:
        # The 2026-09-23 hard requirement: a bootstrap that returns NOTHING is
        # the dead-bridge fingerprint — alarm it instead of hiding it.
        _write_alarm(name, "hook returned no additionalContext — memory bridge is not delivering context", f"out={len(json.dumps(out))}B")
    print(json.dumps(out))

    if ctx and "INTER-AGENT BULLETIN" in ctx:
        try:
            asyncio.run(_post_read_receipt(session_id))
        except Exception:
            pass

    # Clear a stale alarm when a full bootstrap delivered real context.
    if name in ("SessionStart", "PostCompact") and ctx:
        _clear_alarm()
    return 0


async def _post_read_receipt(session_id: str) -> None:
    from kolega_katra_bridge.config import load_config
    from kolega_katra_bridge.katra_client import KatraMCPClient

    cfg = load_config()
    async with KatraMCPClient(cfg) as client:
        await client.store_memory(
            content=f"bulletin_received: {cfg.user_id} surfaced inter-agent messages in session {session_id[:12] or 'unknown'}",
            category="event",
            tags=["background-ack", "read-receipt", "agent-message"],
            private=True,
        )


if __name__ == "__main__":
    sys.exit(main())
