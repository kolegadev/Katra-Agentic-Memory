#!/usr/bin/env python3
"""
Bridge Guard — self-healing for the Kolega Code ⇄ Katra (Satori) bridge.

Why this exists
---------------
`kolega-code update` rebuilds the CLI uv-tool venv, silently dropping the
editable bridge install and (with the old python-type hooks) leaving the
agent with amnesia from turn zero (incident 2026-08-20). This guard checks
every piece of the bridge every few minutes and repairs it automatically:

  1. Repo venv   integrations/kolega-code/.venv (command-hook runner)
  2. CLI venv    editable bridge install (best-effort, dropped by updates)
  3. Hook config satori-hook.json (bridge config filename)
  4. hooks.json  bridge entries must be command-type (runner), not python-type
  5. Live test   spawn the runner with a SessionStart event → expect context

On any repair or failure it writes an episodic event to Satori so the memory
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
STATE_DIR = Path(os.environ.get("KOLEGA_STATE_DIR", Path.home() / ".local" / "state" / "kolega-code"))
HOOK_CFG = STATE_DIR / "satori-hook.json"
LEGACY_HOOK_CFG = STATE_DIR / "katra-hook.json"
HOOKS_JSON = STATE_DIR / "hooks.json"
GUARD_STATE = Path.home() / ".katra" / "bridge-guard-state.json"
LOG_PATH = STATE_DIR / "diagnostics" / "bridge-guard.log"
MCP_ADMIN = os.environ.get("KATRA_ADMIN_URL", "http://localhost:9012")
INTERVAL = 300


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
        log("repair failed: uv not on PATH", "ERROR")
        return False
    subprocess.run([uv, "venv", str(INTEGRATION / ".venv")],
                   capture_output=True, timeout=120)
    subprocess.run([uv, "pip", "install", "--python", str(REPO_VENV_PY), "-e", str(INTEGRATION)],
                   capture_output=True, timeout=300)
    return venv_imports(REPO_VENV_PY)


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
        log("repair failed: uv not on PATH", "ERROR")
        return False
    subprocess.run([uv, "pip", "install", "--python", str(CLI_PY), "-e", str(INTEGRATION)],
                   capture_output=True, timeout=300)
    return venv_imports(CLI_PY)


def fix_hook_config() -> bool:
    if HOOK_CFG.exists():
        return True
    if LEGACY_HOOK_CFG.exists():
        try:
            shutil.copyfile(LEGACY_HOOK_CFG, HOOK_CFG)
            log("repair: satori-hook.json restored from katra-hook.json")
            return True
        except OSError as exc:
            log(f"repair failed: cannot write {HOOK_CFG}: {exc}", "ERROR")
            return False
    log(f"repair failed: neither {LEGACY_HOOK_CFG.name} nor {HOOK_CFG.name} exists", "ERROR")
    return False


def fix_hooks_json() -> bool:
    """Ensure bridge entries are command-type (runner), self-healing any
    regression to python-type specs that depend on the CLI venv."""
    if not HOOKS_JSON.exists():
        log(f"repair failed: {HOOKS_JSON} missing", "ERROR")
        return False
    try:
        data = json.loads(HOOKS_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
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
            log(f"repair failed: cannot write {HOOKS_JSON}: {exc}", "ERROR")
            return False
    return True


def live_runner_test() -> bool:
    """Spawn the runner with a SessionStart event; expect additionalContext."""
    if not (REPO_VENV_PY.exists() and RUNNER.exists()):
        return False
    payload = json.dumps({"hook_event_name": "SessionStart",
                          "session_id": "bridge-guard-self-test"})
    try:
        r = subprocess.run([str(REPO_VENV_PY), str(RUNNER)],
                           input=payload, capture_output=True, text=True, timeout=60)
        out = json.loads(r.stdout or "{}")
        ctx = (out.get("hookSpecificOutput") or {}).get("additionalContext") or ""
        return bool(ctx)
    except Exception:
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
    """Episodic event into Satori so health transitions live in memory."""
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
        log("health transition recorded in Satori")
    except Exception as exc:
        log(f"could not record event in Satori: {exc}", "WARN")


def state_hash(results: dict) -> str:
    return hashlib.sha256(json.dumps(results, sort_keys=True).encode()).hexdigest()[:16]


def run_once(record: bool = True) -> dict:
    results = {
        "repo_venv": fix_repo_venv(),
        "cli_venv": fix_cli_venv(),
        "hook_config": fix_hook_config(),
        "hooks_json": fix_hooks_json(),
        "live_runner": live_runner_test(),
    }
    healthy = all(results.values())
    log("check: " + " ".join(f"{k}={'ok' if v else 'BROKEN'}" for k, v in results.items())
        + (" → HEALTHY" if healthy else " → REPAIRS APPLIED/FALLING"))

    prev = {}
    if GUARD_STATE.exists():
        try:
            prev = json.loads(GUARD_STATE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            prev = {}
    h = state_hash(results)
    try:
        GUARD_STATE.parent.mkdir(parents=True, exist_ok=True)
        GUARD_STATE.write_text(json.dumps(
            {"hash": h, "results": results,
             "ts": datetime.now(timezone.utc).isoformat()}, indent=2))
    except OSError:
        pass

    if record and (not healthy or prev.get("hash") != h):
        record_event(
            "bridge_guard check: " +
            ", ".join(f"{k}={'ok' if v else 'broken'}" for k, v in results.items()) +
            (". Repairs were applied automatically." if not healthy else
             ". State changed (e.g. after kolega-code update); bridge verified healthy.")
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
