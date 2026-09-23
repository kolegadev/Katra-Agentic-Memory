#!/usr/bin/env bash
# Bridge guard — cheap, idempotent, self-healing check for the Kolega ⇄ Katra
# bridge (2026-09-23 wake-ritual re-implementation, directive items d + f).
#
# Verifies the three update-proof invariants and REPAIRS them by re-running
# ensure-bridge.sh when broken:
#   1. hook config exists and is NOT defaulted (api_key present; mcp_url
#      localhost only if something actually serves Katra here)
#   2. hooks.json registers SessionStart + UserPromptSubmit + PostCompact
#      with this repo's runner (an update rebuilds the CLI venv and can drop
#      registrations — the 2026-08-20 incident)
#   3. a live SessionStart self-test through the runner returns non-empty
#      additionalContext (the dead-bridge fingerprint is an empty envelope)
#
# On any failure: writes the alarm marker (bridge-alarm.json) that the
# machine-health collector escalates, prints loudly, exits non-zero.
# On full health: clears the alarm marker.
#
# Cron: */10 * * * * KATRA_USER_ID=<id> KATRA_HOST=<katra-host> <path>/bridge-guard.sh --quiet
# Env: same contract as ensure-bridge.sh (KATRA_USER_ID, KATRA_HOST, KATRA_API_KEY/…).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

if [ -z "${KOLEGA_CODE_STATE_DIR:-}" ]; then
  case "$(uname -s)" in
    Darwin) STATE_DIR="$HOME/Library/Application Support/kolega-code" ;;
    *)      STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/kolega-code" ;;
  esac
else
  STATE_DIR="$KOLEGA_CODE_STATE_DIR"
fi
export KOLEGA_CODE_STATE_DIR="$STATE_DIR"

HOOK_CFG="$STATE_DIR/katra-hook.json"
HOOKS_JSON="$STATE_DIR/hooks.json"
ALARM_FILE="$STATE_DIR/bridge-alarm.json"
RUNNER="$HERE/.venv/bin/python $HERE/scripts/hook_runner.py"

FAIL=0
alarm() {
  FAIL=1
  printf '{"ts":"%s","event":"guard","reason":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" > "$ALARM_FILE" 2>/dev/null || true
  [ "$QUIET" = "0" ] && printf '✗ bridge-guard: %s\n' "$1" >&2
}
ok() { [ "$QUIET" = "0" ] && printf '✓ %s\n' "$1"; }

# 1. Config sane?
if [ ! -f "$HOOK_CFG" ]; then
  alarm "katra-hook.json missing — running ensure-bridge to repair"
  "$HERE/scripts/ensure-bridge.sh" >/dev/null 2>&1 || true
fi
if [ -f "$HOOK_CFG" ]; then
  grep -q '"api_key": "[^"]' "$HOOK_CFG" 2>/dev/null || alarm "katra-hook.json has an empty api_key (defaulted config)"
  if grep -q '"mcp_url": "http://localhost:3112/mcp"' "$HOOK_CFG" 2>/dev/null; then
    if ! (exec 3<>/dev/tcp/localhost/3112) 2>/dev/null; then
      alarm "mcp_url=localhost:3112 but nothing serves Katra on this machine"
    fi
  fi
else
  alarm "ensure-bridge repair failed to create katra-hook.json"
fi

# 2. hooks.json registrations present (all three events, our runner)?
REGISTERED=0
if [ -f "$HOOKS_JSON" ]; then
  REGISTERED=1
  for ev in SessionStart UserPromptSubmit PostCompact; do
    grep -q "\"$ev\"" "$HOOKS_JSON" || REGISTERED=0
  done
  grep -q "hook_runner.py" "$HOOKS_JSON" || REGISTERED=0
fi
if [ "$REGISTERED" = "0" ]; then
  alarm "hooks.json missing bridge registrations — running ensure-bridge to repair"
  "$HERE/scripts/ensure-bridge.sh" >/dev/null 2>&1 || true
  REGISTERED=1
  if [ -f "$HOOKS_JSON" ]; then
    for ev in SessionStart UserPromptSubmit PostCompact; do
      grep -q "\"$ev\"" "$HOOKS_JSON" || REGISTERED=0
    done
    grep -q "hook_runner.py" "$HOOKS_JSON" || REGISTERED=0
  else
    REGISTERED=0
  fi
  [ "$REGISTERED" = "1" ] || alarm "repair failed: hooks.json still lacks bridge registrations"
fi

# 3. Live self-test: SessionStart must return real context.
if [ -x "$HERE/.venv/bin/python" ]; then
  RESULT=$("$HERE/.venv/bin/python" "$HERE/scripts/hook_runner.py" <<'EOF'
{"hook_event_name":"SessionStart","session_id":"bridge-guard-self-test"}
EOF
)
  HAS_CTX=$(printf '%s' "$RESULT" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('1' if d.get('hookSpecificOutput',{}).get('additionalContext') else '0')
except Exception:
    print('0')
" 2>/dev/null)
  if [ "$HAS_CTX" = "1" ]; then
    ok "SessionStart self-test returns memory context"
  else
    alarm "SessionStart self-test returned no context (dead-bridge fingerprint)"
  fi
else
  alarm "repo bridge venv missing — run ensure-bridge.sh"
fi

# 4. Legacy config name must not linger (migration completeness).
if [ -f "$STATE_DIR/satori-hook.json" ]; then
  alarm "stale satori-hook.json still present — running ensure-bridge to migrate"
  "$HERE/scripts/ensure-bridge.sh" >/dev/null 2>&1 || true
  [ -f "$STATE_DIR/satori-hook.json" ] && alarm "migration failed: satori-hook.json still present"
fi

if [ "$FAIL" -ne 0 ]; then
  [ "$QUIET" = "0" ] && printf 'bridge-guard FAILED (alarm marker written: %s)\n' "$ALARM_FILE"
  exit 1
fi
rm -f "$ALARM_FILE" 2>/dev/null || true
[ "$QUIET" = "0" ] && printf 'bridge-guard OK — bridge healthy and update-proof.\n'
exit 0
