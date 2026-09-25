#!/usr/bin/env python3
"""Regression test — /clear and /compress reset detection in hook_runner.py.

Run:  .venv/bin/python scripts/test_reset_detection.py

Runs hook_runner.py as a subprocess against a SYNTHETIC state dir with a stub
bridge (no Katra, no network), so the real id resolution, the real journal
scan and the real marker handling are exercised end to end:

  1. thread-id → session-dir resolution (the 2026-09-25 regression: the CLI
     stamps hook docs with the THREAD id, the store keys dirs by SESSION id)
  2. /clear — a new epoch escalates the next prompt to a full bootstrap
  3. negative control — no reset, no escalation
  4. /compress — `context.compacted` with no hook fires escalates
  5. a compaction older than the marker does NOT escalate
  6. a failed bootstrap records an UNBOOTSTRAPPED marker, so the next prompt
     retries it instead of the session staying memory-less
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE / "hook_runner.py"
PYEXE = sys.executable

SESSION_ID = "sess11112222333344445555"
THREAD_ID = "thread99998888777766665555"

STUB_BRIDGE = '''\
"""Stub bridge for the reset-detection test — no Katra, no network."""

import os


async def on_session_start(event):
    if os.environ.get("STUB_BOOTSTRAP_EMPTY"):
        return {}
    return {"additional_context": "<<BOOTSTRAP-FULL>>"}


async def on_user_prompt(event):
    return {"additional_context": "<<QUERY-CONTEXT>>"}
'''

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS  {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


def make_env(root: Path) -> dict:
    """State dir + stub bridge that shadows the real package (PYTHONPATH wins)."""
    stub = root / "stub"
    (stub / "kolega_katra_bridge").mkdir(parents=True)
    (stub / "kolega_katra_bridge" / "__init__.py").write_text("")
    (stub / "kolega_katra_bridge" / "hook.py").write_text(STUB_BRIDGE)
    state = root / "state"
    (state / "sessions" / SESSION_ID).mkdir(parents=True)
    (state / "bridge-session").mkdir(parents=True)
    env = dict(os.environ)
    env["KOLEGA_CODE_STATE_DIR"] = str(state)
    env["PYTHONPATH"] = str(stub)
    env.pop("STUB_BOOTSTRAP_EMPTY", None)
    return env


def write_session(state_root: Path, *, epochs: list[str], compactions: list[str], thread_id: str = THREAD_ID) -> None:
    """Session dir is keyed by SESSION id; the hook doc carries the THREAD id."""
    sdir = state_root / "sessions" / SESSION_ID
    (sdir / "metadata.json").write_text(json.dumps({"session_id": SESSION_ID, "thread_id": thread_id}))
    lines = []
    for i, epoch in enumerate(epochs):
        lines.append(json.dumps({"type": "context.epoch_started", "epoch_id": epoch, "timestamp": f"2026-09-25T10:00:{i:02d}+00:00"}))
    for i, ts in enumerate(compactions):
        lines.append(json.dumps({"type": "context.compacted", "epoch_id": epochs[-1], "timestamp": ts}))
    (sdir / "events.jsonl").write_text("\n".join(lines) + "\n")


def write_marker(state_root: Path, *, epoch_id: str | None, compacted_at: str | None = None, ts: str = "2026-09-25T10:05:00+00:00") -> None:
    (state_root / "bridge-session" / f"{THREAD_ID}.json").write_text(
        json.dumps({"epoch_id": epoch_id, "compacted_at": compacted_at, "ts": ts})
    )


def run_hook(env: dict, event: dict) -> dict:
    proc = subprocess.run(
        [PYEXE, str(RUNNER)],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"_stdout": proc.stdout, "_stderr": proc.stderr, "_rc": proc.returncode}


def context_of(result: dict) -> str:
    return (result.get("hookSpecificOutput") or {}).get("additionalContext") or ""


def prompt_event() -> dict:
    return {
        "hook_event_name": "UserPromptSubmit",
        "session_id": THREAD_ID,  # the CLI sends the thread id, not the session id
        "cwd": "/tmp",
        "user_message": "Hi Lilly",
    }


def start_event() -> dict:
    return {"hook_event_name": "SessionStart", "session_id": THREAD_ID, "cwd": "/tmp", "source": "startup"}


def case(name: str, fn) -> None:
    print(f"\n{name}")
    root = Path(tempfile.mkdtemp(prefix="resetdetect-"))
    try:
        fn(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    # ---- 1/2/3: resolution, /clear escalation, negative control -----------
    def case_clear(root: Path) -> None:
        env = make_env(root)
        state = Path(env["KOLEGA_CODE_STATE_DIR"])
        # Bootstrapped on epoch A, then /clear started epoch B.
        write_session(state, epochs=["epoch-A"], compactions=[])
        write_marker(state, epoch_id="epoch-A")
        # before the /clear
        ctx_before = context_of(run_hook(env, prompt_event()))
        check("no reset → no bootstrap escalation", "<<BOOTSTRAP-FULL>>" not in ctx_before, ctx_before[:80])
        check("no reset → query context still delivered", "<<QUERY-CONTEXT>>" in ctx_before, ctx_before[:80])
        # /clear: the CLI appends a new epoch (TUI: start_epoch("thread_reset"))
        write_session(state, epochs=["epoch-A", "epoch-B"], compactions=[])
        ctx_after = context_of(run_hook(env, prompt_event()))
        check("/clear (new epoch) → full bootstrap injected", "<<BOOTSTRAP-FULL>>" in ctx_after, ctx_after[:80])
        check("/clear → bootstrap precedes query context", ctx_after.find("<<BOOTSTRAP-FULL>>") < ctx_after.find("<<QUERY-CONTEXT>>"), ctx_after[:120])
        marker = json.loads((state / "bridge-session" / f"{THREAD_ID}.json").read_text())
        check("marker advanced to the new epoch", marker.get("epoch_id") == "epoch-B", str(marker))
        ctx_settled = context_of(run_hook(env, prompt_event()))
        check("next prompt after escalation does NOT re-escalate", "<<BOOTSTRAP-FULL>>" not in ctx_settled, ctx_settled[:80])

    case("1-3. thread-id resolution, /clear escalation, negative control", case_clear)

    # ---- 4/5: manual /compress (no hook) ----------------------------------
    def case_compress(root: Path) -> None:
        env = make_env(root)
        state = Path(env["KOLEGA_CODE_STATE_DIR"])
        write_session(state, epochs=["epoch-A"], compactions=[])
        # marker from BEFORE the /compress (old-style: no compacted_at)
        write_marker(state, epoch_id="epoch-A", ts="2026-09-25T10:05:00+00:00")
        write_session(state, epochs=["epoch-A"], compactions=["2026-09-25T10:09:00+00:00"])
        ctx = context_of(run_hook(env, prompt_event()))
        check("/compress (context.compacted, no hook) → bootstrap injected", "<<BOOTSTRAP-FULL>>" in ctx, ctx[:80])
        # a newer compaction must not re-trigger now that the marker has it
        ctx_again = context_of(run_hook(env, prompt_event()))
        check("compaction recorded in marker → no repeat escalation", "<<BOOTSTRAP-FULL>>" not in ctx_again, ctx_again[:80])
        # an OLD compaction (before the marker) must not escalate
        write_session(state, epochs=["epoch-A"], compactions=["2026-09-25T09:00:00+00:00"])
        write_marker(state, epoch_id="epoch-A", compacted_at="2026-09-25T10:05:00+00:00")
        ctx_old = context_of(run_hook(env, prompt_event()))
        check("compaction older than marker → no escalation", "<<BOOTSTRAP-FULL>>" not in ctx_old, ctx_old[:80])

    case("4-5. /compress detection and stale-compaction control", case_compress)

    # ---- 6: a FAILED bootstrap must not advance the marker ----------------
    def case_failed_bootstrap(root: Path) -> None:
        env = make_env(root)
        state = Path(env["KOLEGA_CODE_STATE_DIR"])
        write_session(state, epochs=["epoch-A", "epoch-B"], compactions=[])
        write_marker(state, epoch_id="epoch-A")
        env["STUB_BOOTSTRAP_EMPTY"] = "1"
        run_hook(env, start_event())  # bootstrap returns {} (Katra unreachable)
        marker = json.loads((state / "bridge-session" / f"{THREAD_ID}.json").read_text())
        check("failed bootstrap records an UNBOOTSTRAPPED marker", marker.get("epoch_id") is None, str(marker))
        del env["STUB_BOOTSTRAP_EMPTY"]
        ctx = context_of(run_hook(env, prompt_event()))
        check("next prompt retries the bootstrap", "<<BOOTSTRAP-FULL>>" in ctx, ctx[:80])
        marker = json.loads((state / "bridge-session" / f"{THREAD_ID}.json").read_text())
        check("delivered retry advances the marker to the live epoch", marker.get("epoch_id") == "epoch-B", str(marker))

    case("6. failed bootstrap never looks like a done one (retry path)", case_failed_bootstrap)

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {', '.join(failures)}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
