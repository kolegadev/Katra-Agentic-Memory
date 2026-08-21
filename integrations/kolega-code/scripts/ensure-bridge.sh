#!/usr/bin/env bash
# Idempotent reinstatement + self-test for the Kolega Code ⇄ Katra (Satori) bridge.
#
# `kolega-code update` runs `uv tool install --force --upgrade kolega-code`,
# which REBUILDS the CLI venv and silently drops packages installed into it.
# That breaks the memory hook and the agent wakes with amnesia (2026-08-20).
# Run this script after every CLI update. It is safe to run anytime.
#
# The update-proof path is the command hook (scripts/hook_runner.py) running
# from this repo's own .venv — the CLI never imports the bridge, so updates
# cannot break it. The CLI-venv editable install below is a convenience for
# the older python-type hook spec only.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PY="${KOLEGA_CLI_PY:-$HOME/.local/share/uv/tools/kolega-code/bin/python}"
STATE_DIR="${KOLEGA_STATE_DIR:-$HOME/.local/state/kolega-code}"
FAIL=0

step() { printf '\n== %s ==\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; FAIL=1; }

step "1/4 bridge venv (update-proof runner)"
if [ ! -x "$HERE/.venv/bin/python" ]; then
  uv venv "$HERE/.venv" >/dev/null 2>&1 || { bad "uv venv failed"; }
fi
uv pip install --python "$HERE/.venv/bin/python" -e "$HERE" >/dev/null 2>&1
"$HERE/.venv/bin/python" -c "import kolega_katra_bridge" >/dev/null 2>&1 \
  && ok "bridge importable in repo venv" || bad "bridge venv broken"

step "2/4 CLI venv (best-effort; dropped by updates)"
if [ -x "$CLI_PY" ]; then
  uv pip install --python "$CLI_PY" -e "$HERE" >/dev/null 2>&1 || true
  "$CLI_PY" -c "import kolega_katra_bridge" >/dev/null 2>&1 \
    && ok "bridge importable in CLI venv" \
    || bad "CLI venv import (command-hook path still works; next update resets this anyway)"
else
  ok "no CLI venv found — command-hook path only"
fi

step "3/4 hook config"
if [ ! -f "$STATE_DIR/satori-hook.json" ] && [ -f "$STATE_DIR/katra-hook.json" ]; then
  cp "$STATE_DIR/katra-hook.json" "$STATE_DIR/satori-hook.json"
  ok "satori-hook.json written from katra-hook.json"
elif [ -f "$STATE_DIR/satori-hook.json" ]; then
  ok "satori-hook.json present"
else
  bad "no hook config (katra-hook.json / satori-hook.json missing)"
fi

step "4/4 live self-test through the runner"
RESULT=$("$HERE/.venv/bin/python" "$HERE/scripts/hook_runner.py" <<'EOF'
{"hook_event_name":"SessionStart","session_id":"ensure-bridge-self-test"}
EOF
)
HAS_CTX=$(printf '%s' "$RESULT" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('1' if d.get('hookSpecificOutput',{}).get('additionalContext') else '0')
except Exception:
    print('0')
")
[ "$HAS_CTX" = "1" ] \
  && ok "runner returned memory context from live Satori" \
  || bad "runner returned no context (auth or server issue)"

if [ "$FAIL" -ne 0 ]; then
  printf '\nensure-bridge FAILED — see ✗ lines above.\n'
  exit 1
fi
printf '\nensure-bridge OK — bridge healthy and update-proof.\n'
