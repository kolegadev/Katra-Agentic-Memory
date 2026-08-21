#!/usr/bin/env python3
"""Kolega Code command-hook runner for the Katra (Satori) memory bridge.

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
exit  : always 0 (fail-open — a broken memory hook must never break the turn)

Handled events: SessionStart (bootstrap, all sources), SessionClear
(identity re-injection after /clear), UserPromptSubmit (query retrieval).
"""

import asyncio
import json
import sys
from types import SimpleNamespace


def _load_event() -> dict | None:
    try:
        doc = json.load(sys.stdin)
    except Exception:
        return None
    return doc if isinstance(doc, dict) else None


def main() -> int:
    doc = _load_event()
    if doc is None:
        return 0

    name = str(doc.get("hook_event_name") or "")
    # The CLI folds payload fields into the top level (to_hook_input()).
    user_message = str(doc.get("user_message") or doc.get("payload", {}).get("user_message", "") or "")
    session_id = str(doc.get("session_id") or "")
    event = SimpleNamespace(payload={"user_message": user_message}, session_id=session_id)

    try:
        from kolega_katra_bridge import hook as bridge_hook

        handlers = {
            "SessionStart": bridge_hook.on_session_start,
            "SessionClear": bridge_hook.on_session_clear,
            "UserPromptSubmit": bridge_hook.on_user_prompt,
        }
        handler = handlers.get(name)
        if handler is None:
            return 0
        result = asyncio.run(handler(event)) or {}
    except Exception as exc:  # fail-open, but loud on stderr for diagnostics
        print(f"katra-bridge-runner: {name} failed: {exc}", file=sys.stderr)
        return 0

    ctx = result.get("additional_context")
    out: dict = {"hookSpecificOutput": {"hookEventName": name}}
    if ctx:
        out["hookSpecificOutput"]["additionalContext"] = ctx
    print(json.dumps(out))

    # Comms-protocol read receipt: when inter-agent messages were surfaced
    # into this turn's context, acknowledge them on the shared channel so
    # senders can see their bulletins were actually picked up. Tagged
    # background-ack so wake services never treat receipts as new messages.
    # Fire-and-forget — a receipt failure must never affect the hook.
    if ctx and "INTER-AGENT BULLETIN" in ctx:
        try:
            asyncio.run(_post_read_receipt(session_id))
        except Exception:
            pass
    return 0


async def _post_read_receipt(session_id: str) -> None:
    from kolega_katra_bridge.config import load_config
    from kolega_katra_bridge.satori_client import KatraMCPClient

    cfg = load_config()
    async with KatraMCPClient(cfg) as client:
        await client.store_memory(
            content=f"bulletin_received: {cfg.user_id} surfaced inter-agent messages in session {session_id[:12] or 'unknown'}",
            category="event",
            tags=["background-ack", "read-receipt", "agent-message"],
        )


if __name__ == "__main__":
    sys.exit(main())
