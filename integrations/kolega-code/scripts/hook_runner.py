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
    return 0


if __name__ == "__main__":
    sys.exit(main())
