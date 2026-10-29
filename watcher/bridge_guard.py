#!/usr/bin/env python3
"""
Bridge Guard — self-healing for the Kolega Code ⇄ Katra (Katra) bridge.

Why this exists
---------------
`kolega-code update` rebuilds the CLI uv-tool venv, silently dropping the
editable bridge install and (with the old python-type hooks) leaving the
agent with amnesia from turn zero (incident 2026-08-20). This guard checks
every piece of the bridge every few minutes and repairs it automatically:

  1. Repo venv   integrations/kolega-code/.venv (command-hook runner)
  2. CLI venv    editable bridge install (best-effort, dropped by updates)
  3. Hook config katra-hook.json (bridge config filename)
  4. hooks.json  bridge entries must be command-type (runner), not python-type
  5. Live test   spawn the runner with a SessionStart event → expect context

On any repair or failure it writes an episodic event to Katra so the memory
system records its own health transitions (search: bridge_guard).

Runs with stdlib only (system python3). Usage:
    python3 bridge_guard.py --once        # one check/repair pass (cron)
    python3 bridge_guard.py               # loop, default 300s

Env overrides (for testing): KOLEGA_CLI_PY, KOLEGA_STATE_DIR, KATRA_DIR.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

KATRA_DIR = Path(os.environ.get("KATRA_DIR", Path.home() / "Katra-Agentic-Memory"))
INTEGRATION = KATRA_DIR / "integrations" / "kolega-code"
REPO_VENV_PY = INTEGRATION / ".venv" / "bin" / "python"
RUNNER = INTEGRATION / "scripts" / "hook_runner.py"
ENSURE = INTEGRATION / "scripts" / "ensure-bridge.sh"
CLI_PY = Path(os.environ.get("KOLEGA_CLI_PY", Path.home() / ".local" / "share" / "uv" / "tools" / "kolega-code" / "bin" / "python"))


def resolve_state_dir() -> Path:
    """The CLI's real state directory on THIS platform.

    Order: KOLEGA_CODE_STATE_DIR (the CLI's own variable, also honoured by
    hook_runner.py and bridge-guard.sh) → KOLEGA_STATE_DIR (this guard's
    long-standing test override) → platform default.

    2026-10-29: the default used to be ~/.local/state/kolega-code on every
    platform, but kolega-code keeps its state under
    ~/Library/Application Support/kolega-code on macOS. On this Mac that made
    the guard inspect a directory that does not exist — it would have reported
    hook_config/hooks_json broken for the wrong reason while the shell guard
    (which resolves the macOS path) reported them fine.
    """
    for var in ("KOLEGA_CODE_STATE_DIR", "KOLEGA_STATE_DIR"):
        value = os.environ.get(var)
        if value:
            return Path(value)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "kolega-code"
    return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "kolega-code"


STATE_DIR = resolve_state_dir()
HOOK_CFG = STATE_DIR / "katra-hook.json"
LEGACY_HOOK_CFG = STATE_DIR / "katra-hook.json"
HOOKS_JSON = STATE_DIR / "hooks.json"
GUARD_STATE = Path.home() / ".katra" / "bridge-guard-state.json"
LOG_PATH = STATE_DIR / "diagnostics" / "bridge-guard.log"
MCP_ADMIN = os.environ.get("KATRA_ADMIN_URL", "http://localhost:9012")
INTERVAL = 300
# While unhealthy, re-notify Katra once every N cycles (~30 min at 300s):
# a persistent condition that cannot be repaired must not write an event every
# cycle (the thebrick cli_venv condition did: 12/hour), but it must not go
# quiet either — silence is how a gap survives.
RE_NOTIFY_CYCLES = int(os.environ.get("KOLEGA_GUARD_RE_NOTIFY_CYCLES", "6"))

# Why each check failed THIS cycle (check name -> reason), filled by the fix_*
# functions. 2026-10-29: the guard used to say "Repairs were applied
# automatically" whether or not a repair had happened, which is how a
# non-converging condition kept reading as handled.
FAILURES: dict[str, str] = {}


def _fail(check: str, reason: str) -> None:
    FAILURES[check] = " ".join(reason.split())[:220]


def log(msg: str, level: str = "INFO") -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"{ts} [{level}] bridge-guard: {msg}\n")
    except OSError:
        pass
    print(f"[{level}] {msg}")


def venv_imports(venv_py: Path) -> bool:
    if not venv_py.exists():
        return False
    try:
        r = subprocess.run(
            [str(venv_py), "-c", "import kolega_katra_bridge"],
            capture_output=True, timeout=60,
        )
        return r.returncode == 0
    except Exception:
        return False


def fix_repo_venv() -> bool:
    """Create/refresh the runner venv inside the Katra repo."""
    if venv_imports(REPO_VENV_PY):
        return True
    log(f"repair: repo venv broken — reinstalling bridge into {REPO_VENV_PY}")
    uv = shutil.which("uv")
    if not uv:
        _fail("repo_venv", "uv not on PATH — cannot rebuild the runner venv")
        log("repair failed: uv not on PATH", "ERROR")
        return False
    try:
        subprocess.run([uv, "venv", str(INTEGRATION / ".venv")],
                       capture_output=True, timeout=120)
        proc = subprocess.run([uv, "pip", "install", "--python", str(REPO_VENV_PY), "-e", str(INTEGRATION)],
                              capture_output=True, timeout=300, text=True)
    except subprocess.TimeoutExpired:
        _fail("repo_venv", "uv timed out rebuilding the runner venv")
        log("repair failed: uv timed out", "ERROR")
        return False
    if proc.returncode != 0:
        _fail("repo_venv", f"uv pip install exited {proc.returncode}: {_tail(proc)}")
        log(f"repair failed: uv pip install exited {proc.returncode}", "ERROR")
        return False
    if not venv_imports(REPO_VENV_PY):
        _fail("repo_venv", "editable install reported success but the import still fails")
        log("repair failed: import still failing after install", "ERROR")
        return False
    return True


def _tail(proc: object, limit: int = 160) -> str:
    """Last non-empty line of a finished process, for a one-line reason."""
    out = (
        getattr(proc, "stderr", "") or getattr(proc, "stdout", "") or ""
    ).strip().splitlines()
    return out[-1][:limit] if out else "no output"


def fix_cli_venv() -> bool:
    """Best-effort editable install into the CLI venv (dropped by updates;
    the command-hook path does not depend on it)."""
    if not CLI_PY.exists():
        return True  # nothing to fix; runner path is authoritative
    if venv_imports(CLI_PY):
        return True
    log(f"repair: CLI venv lost the bridge (kolega-code update?) — reinstalling")
    uv = shutil.which("uv")
    if not uv:
        _fail("cli_venv", "uv not on PATH — cannot reinstall the editable bridge")
        log("repair failed: uv not on PATH", "ERROR")
        return False
    try:
        proc = subprocess.run([uv, "pip", "install", "--python", str(CLI_PY), "-e", str(INTEGRATION)],
                             capture_output=True, timeout=300, text=True)
    except subprocess.TimeoutExpired:
        _fail("cli_venv", "uv timed out reinstalling the editable bridge")
        log("repair failed: uv timed out", "ERROR")
        return False
    if proc.returncode != 0:
        _fail("cli_venv", f"uv pip install exited {proc.returncode}: {_tail(proc)}")
        log(f"repair failed: uv pip install exited {proc.returncode}: {_tail(proc)}", "ERROR")
        return False
    if not venv_imports(CLI_PY):
        _fail("cli_venv", "uv pip install succeeded but the import still fails "
                          "(CLI venv rebuilt by kolega-code update?)")
        log("repair failed: import still failing after a successful install", "ERROR")
        return False
    return True


def fix_hook_config() -> bool:
    if HOOK_CFG.exists():
        return True
    if LEGACY_HOOK_CFG.exists():
        try:
            shutil.copyfile(LEGACY_HOOK_CFG, HOOK_CFG)
            log("repair: katra-hook.json restored from katra-hook.json")
            return True
        except OSError as exc:
            _fail("hook_config", f"cannot write {HOOK_CFG.name}: {exc}")
            log(f"repair failed: cannot write {HOOK_CFG}: {exc}", "ERROR")
            return False
    _fail("hook_config", f"neither {LEGACY_HOOK_CFG.name} nor {HOOK_CFG.name} exists in {STATE_DIR}")
    log(f"repair failed: neither {LEGACY_HOOK_CFG.name} nor {HOOK_CFG.name} exists", "ERROR")
    return False


def fix_hooks_json() -> bool:
    """Ensure bridge entries are command-type (runner), self-healing any
    regression to python-type specs that depend on the CLI venv."""
    if not HOOKS_JSON.exists():
        _fail("hooks_json", f"{HOOKS_JSON} missing")
        log(f"repair failed: {HOOKS_JSON} missing", "ERROR")
        return False
    try:
        data = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail("hooks_json", f"cannot read {HOOKS_JSON.name}: {exc}")
        log(f"repair failed: cannot read {HOOKS_JSON}: {exc}", "ERROR")
        return False

    runner_cmd = f"{REPO_VENV_PY} {RUNNER}"
    changed = False
    for ev in ("SessionStart", "UserPromptSubmit"):
        for group in data.get("hooks", {}).get(ev, []):
            for h in group.get("hooks", []):
                call = str(h.get("callable") or "")
                if call.startswith("kolega_katra_bridge"):
                    h.clear()
                    h.update({"type": "command", "command": runner_cmd,
                              "timeout": 20 if ev == "SessionStart" else 15})
                    changed = True
    if changed:
        try:
            HOOKS_JSON.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            log("repair: hooks.json bridge entries restored to command-type (runner)")
        except OSError as exc:
            _fail("hooks_json", f"cannot write {HOOKS_JSON.name}: {exc}")
            log(f"repair failed: cannot write {HOOKS_JSON}: {exc}", "ERROR")
            return False
    return True


def live_runner_test() -> bool:
    """Spawn the runner with a SessionStart event; expect additionalContext."""
    if not (REPO_VENV_PY.exists() and RUNNER.exists()):
        missing = "runner" if not RUNNER.exists() else "runner venv"
        _fail("live_runner", f"{missing} missing under {INTEGRATION}")
        return False
    payload = json.dumps({"hook_event_name": "SessionStart",
                          "session_id": "bridge-guard-self-test"})
    try:
        r = subprocess.run([str(REPO_VENV_PY), str(RUNNER)],
                           input=payload, capture_output=True, text=True, timeout=60)
        out = json.loads(r.stdout or "{}")
        ctx = (out.get("hookSpecificOutput") or {}).get("additionalContext") or ""
        if ctx:
            return True
        # The runner now classifies the empty envelope (2026-10-29); keep the
        # reason, otherwise the guard repeats "no context" for the same cause
        # and nobody can tell whether it changed.
        alarm_line = next(
            (line.strip() for line in reversed((r.stderr or "").splitlines())
             if "BRIDGE ALARM" in line),
            "",
        )
        _fail("live_runner", alarm_line or "SessionStart self-test returned an empty envelope")
        return False
    except Exception as exc:
        _fail("live_runner", f"{type(exc).__name__}: {exc}")
        return False


def read_admin_key() -> str:
    """KATRA admin key from the running container (never persisted)."""
    try:
        r = subprocess.run(
            ["docker", "exec", "katra-server", "sh", "-c", "echo $KATRA_API_KEY"],
            capture_output=True, text=True, timeout=10,
        )
        return r.stdout.strip()
    except Exception:
        return ""


def record_event(message: str) -> None:
    """Episodic event into Katra so health transitions live in memory."""
    if os.environ.get("KOLEGA_DRY_RUN"):
        log(f"dry-run: would record in Katra: {message[:200]}")
        return
    key = read_admin_key()
    if not key:
        log("cannot record event: no admin key", "WARN")
        return
    body = json.dumps({
        "event_type": "bridge_health",
        "session_id": "bridge-guard",
        "content": message,
        "metadata": {"tags": ["self-maintenance", "bridge", "bridge_guard"]},
    }).encode()
    req = urllib.request.Request(
        f"{MCP_ADMIN}/api/v1/memory/episodic/events",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=10)
        log("health transition recorded in Katra")
    except Exception as exc:
        log(f"could not record event in Katra: {exc}", "WARN")


def state_hash(results: dict) -> str:
    return hashlib.sha256(json.dumps(results, sort_keys=True).encode()).hexdigest()[:16]


def run_once(record: bool = True) -> dict:
    FAILURES.clear()
    results = {
        "repo_venv": fix_repo_venv(),
        "cli_venv": fix_cli_venv(),
        "hook_config": fix_hook_config(),
        "hooks_json": fix_hooks_json(),
        "live_runner": live_runner_test(),
    }
    healthy = all(results.values())
    log("check: " + " ".join(f"{k}={'ok' if v else 'BROKEN'}" for k, v in results.items())
        + (" → HEALTHY" if healthy else " → STILL BROKEN: "
           + "; ".join(f"{k}: {FAILURES.get(k, 'no reason recorded')}"
                       for k, v in results.items() if not v)))

    prev = {}
    if GUARD_STATE.exists():
        try:
            prev = json.loads(GUARD_STATE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            prev = {}
    h = state_hash(results)
    transition = prev.get("hash") != h
    cycles = int(prev.get("cycles_unhealthy") or 0)
    cycles = cycles + 1 if not healthy else 0
    # Record on transition only, plus one re-notify per RE_NOTIFY_CYCLES while
    # a condition persists. 2026-10-29: the guard used to write an event every
    # cycle for a condition it could not repair (12/hour on thebrick), which
    # made the memory log carry the same sentence over and over instead of a
    # signal.
    due_renotify = (not healthy) and cycles > 0 and cycles % max(RE_NOTIFY_CYCLES, 1) == 0
    try:
        GUARD_STATE.parent.mkdir(parents=True, exist_ok=True)
        GUARD_STATE.write_text(json.dumps(
            {"hash": h, "results": results, "cycles_unhealthy": cycles,
             "ts": datetime.now(timezone.utc).isoformat()}, indent=2))
    except OSError:
        pass

    if record and (transition or due_renotify):
        if healthy:
            message = (". State changed (e.g. after kolega-code update); "
                       "bridge verified healthy.")
        else:
            broken = "; ".join(
                f"{k}={FAILURES.get(k, 'unknown reason')}"
                for k, v in results.items() if not v
            )
            message = (f". Repair attempted, STILL BROKEN (cycle {cycles}): {broken}")
        record_event(
            "bridge_guard check: "
            + ", ".join(f"{k}={'ok' if v else 'broken'}" for k, v in results.items())
            + message
        )
    return results


def main() -> int:
    args = sys.argv[1:]
    if "--once" in args:
        results = run_once()
        return 0 if all(results.values()) else 1
    log(f"bridge-guard loop started (interval {INTERVAL}s)")
    while True:
        try:
            run_once()
        except Exception as exc:  # never die; a dead guard heals nothing
            log(f"guard loop error: {exc}", "ERROR")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
