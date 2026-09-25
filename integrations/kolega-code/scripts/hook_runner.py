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

Handled events (2026-09-23 wake-ritual re-implementation, id + /compress
detection fixed 2026-09-25):
  SessionStart      full bootstrap, all 11 sources            (startup)
  PostCompact       full bootstrap re-injection               (auto-compaction)
  UserPromptSubmit  query retrieval + RESET-DETECTION: when the CLI's session
                    store has moved past our last bootstrap — a new EPOCH
                    (/clear, thread reset) or a COMPACTION newer than our
                    marker (a manual /compress fires no hook at all: the CLI
                    fires PostCompact only from _auto_compact_once) —
                    escalate to the full bootstrap and prefix it before the
                    query context.

The CLI stamps hook events with the session's THREAD id, while the store keys
directories by SESSION id (baseagent.fire_hook: session_id=self.thread_id vs
session_store.session_dir_for(session_id)). Every journal read therefore
resolves the id first (_resolve_session_dir). Reading
sessions/<thread-id>/events.jsonl, which never exists, is what silently
disabled /clear detection from 2026-09-23 to 2026-09-25.
"""

import asyncio
import json
import os
import socket
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any


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


def _sessions_root() -> str:
    return os.path.join(STATE_DIR, "sessions")


def _resolve_session_dir(identifier: str) -> str | None:
    """Map the id the CLI put in the hook document to its session directory.

    The CLI stamps hook events with the session's THREAD id
    (kolega_code/agent/baseagent.py: fire_hook → session_id=self.thread_id),
    while the store keys directories by SESSION id
    (<state>/sessions/<session_id>/events.jsonl, session_store.py:
    session_dir_for). Markers are written under the hook's id, so both have to
    resolve to the same directory — otherwise every journal read hits a
    non-existent path and reset detection dies silently (the 2026-09-25
    regression: marker `542b9442….json` for thread 542b9442… existed, no such
    session directory did, so /clear was never detected).

    A direct hit wins (synthetic ids in tests/guards, and any future CLI that
    passes the session id). Otherwise the thread id is matched against the
    small metadata projections, newest `updated_at` first, because a thread
    can be resumed into a new session.
    """
    if not identifier:
        return None
    direct = os.path.join(_sessions_root(), identifier)
    if os.path.isfile(os.path.join(direct, "events.jsonl")):
        return direct
    best: tuple[str, str] | None = None
    try:
        names = os.listdir(_sessions_root())
    except OSError:
        return None
    for name in names:
        if name.startswith("."):
            continue
        meta_path = os.path.join(_sessions_root(), name, "metadata.json")
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(meta, dict) or meta.get("thread_id") != identifier:
            continue
        updated = str(meta.get("updated_at") or "")
        if best is None or updated > best[0]:
            best = (updated, os.path.join(_sessions_root(), name))
    return best[1] if best else None


# Journal tail window. The window must stay wide enough to still contain the
# last epoch/compaction record after the turns that followed it wrote their
# own lines — 8 KB was not: one turn of a busy session writes ~500 KB of
# journal, and a compaction record carries its whole summary. The scan itself
# stays cheap (substring pre-filter, see _journal_state), so a generous window
# costs a few milliseconds per prompt.
_TAIL_BYTES = 4 << 20  # 4 MiB


def _journal_tail_lines(events_path: str) -> list[str]:
    """Return the non-empty lines of the journal's tail window, newest first."""
    try:
        with open(events_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - _TAIL_BYTES))
            chunk = f.read().decode("utf-8", errors="ignore")
    except OSError:
        return []
    return [line for line in (ln.strip() for ln in reversed(chunk.splitlines())) if line]


def _safe_json(line: str) -> dict | None:
    try:
        doc = json.loads(line)
    except json.JSONDecodeError:
        # The window boundary can cut a line in half; it is the OLDEST line.
        return None
    return doc if isinstance(doc, dict) else None


def _journal_state(identifier: str) -> tuple[str | None, str | None]:
    """(latest epoch id, latest compaction timestamp) from the CLI's session store.

    Both signals come from ONE backwards pass over the same tail window:
      * `epoch_id` is stamped on every record, so the newest record carries the
        live epoch; a change means /clear or a thread reset happened
        (clear_history()/start_epoch, and the TUI's _reset_current_thread →
        start_epoch("thread_reset")).
      * `context.compacted` (session_journal.record_compaction) is the only
        signal a MANUAL /compress leaves: the CLI fires PostCompact hooks from
        _auto_compact_once only, so the manual command's re-injection has to be
        driven from the journal. Only candidate lines are parsed, so the pass
        stays a cheap substring scan in the common case (no compaction at all).
    """
    session_dir = _resolve_session_dir(identifier)
    if session_dir is None:
        return None, None
    epoch: str | None = None
    compacted_at: str | None = None
    for line in _journal_tail_lines(os.path.join(session_dir, "events.jsonl")):
        if epoch is None and '"epoch_id"' in line:
            doc = _safe_json(line)
            if doc and doc.get("epoch_id"):
                epoch = str(doc["epoch_id"])
        if compacted_at is None and "context.compacted" in line:
            doc = _safe_json(line)
            if doc and doc.get("type") == "context.compacted":
                ts = doc.get("timestamp") or doc.get("ts")
                if ts:
                    compacted_at = str(ts)
        if epoch is not None and compacted_at is not None:
            break
    return epoch, compacted_at


def _latest_epoch_id(session_id: str) -> str | None:
    """Back-compat shim: the session's current epoch, or None when unknown."""
    return _journal_state(session_id)[0]


def _iso_ts(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _marker_path(session_id: str) -> str:
    return os.path.join(SESSION_MARKER_DIR, f"{session_id}.json")


def _read_marker(session_id: str) -> dict | None:
    try:
        with open(_marker_path(session_id)) as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else None
    except OSError:
        return None


def _write_marker(session_id: str, epoch_id: str | None, compacted_at: str | None = None) -> None:
    try:
        os.makedirs(SESSION_MARKER_DIR, exist_ok=True)
        with open(_marker_path(session_id), "w") as f:
            json.dump(
                {
                    "epoch_id": epoch_id,
                    "compacted_at": compacted_at,
                    "ts": datetime.now(timezone.utc).isoformat(),
                },
                f,
            )
    except OSError:
        pass


def _cleared_since_last_bootstrap(session_id: str) -> bool:
    """True when the CLI's session store moved past our last bootstrap.

    Two ways that happens, both of which wipe or summarize the injected wake
    context and therefore need a fresh bootstrap on THIS turn:
      * a new epoch — /clear or a thread reset;
      * a compaction recorded after our marker — /compress. The manual command
        fires no hook at all, so the journal is the only witness.
    Markers written before 2026-09-25 carry no `compacted_at`; their own write
    time is the fallback cutoff.
    """
    marker = _read_marker(session_id)
    if marker is None:
        return False  # no prior bootstrap in this session; SessionStart owns it
    epoch, compacted_at = _journal_state(session_id)
    if epoch is None and compacted_at is None:
        return False
    if epoch != marker.get("epoch_id"):
        return True
    compaction_ts = _iso_ts(compacted_at)
    marker_ts = _iso_ts(marker.get("compacted_at") or marker.get("ts"))
    if compaction_ts is not None and (marker_ts is None or compaction_ts > marker_ts):
        return True
    return False


async def _run_bootstrap(event: SimpleNamespace, session_id: str):
    from kolega_katra_bridge import hook as bridge_hook

    epoch, compacted_at = _journal_state(session_id)
    result = (await bridge_hook.on_session_start(event)) or {}
    if result.get("additional_context"):
        _write_marker(session_id, epoch, compacted_at)
    else:
        # Nothing was delivered — Katra unreachable. Record an UNBOOTSTRAPPED
        # marker (null epoch) rather than nothing at all, so two things hold:
        # the next prompt escalates and retries instead of the session staying
        # memory-less, and there is still a marker for a later /clear to be
        # measured against. A failed bootstrap must never look like a done one.
        _write_marker(session_id, None, None)
    return result


async def _run_prompt_with_escalation(event: SimpleNamespace, session_id: str):
    from kolega_katra_bridge import hook as bridge_hook

    result = (await bridge_hook.on_user_prompt(event)) or {}
    if _cleared_since_last_bootstrap(session_id):
        # /clear and /compress fire no UserPromptSubmit-time signal of their
        # own — escalate to the full bootstrap so identity and memory return on
        # THIS turn, not one turn later.
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
