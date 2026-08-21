#!/usr/bin/env bash
# Idempotent reinstatement + self-test for the Kolega Code ⇄ Katra bridge.
#
# `kolega-code update` runs `uv tool install --force --upgrade kolega-code`,
# which REBUILDS the CLI venv and silently drops packages installed into it.
# That breaks the memory hook and the agent wakes with amnesia (2026-08-20).
# Run this script after every CLI update. It is safe to run anytime.
#
# The update-proof path is the command hook (scripts/hook_runner.py) running
# from this repo's own .venv — the CLI never imports the bridge, so updates
# cannot break it.
#
# Per-machine identity (identity-separation cutover 2026-08-21): the hook
# config written by this installer carries the CALLING agent's identity.
# Env (defaults keep this machine's Satori install unchanged):
#   KATRA_USER_ID      user_id to write into the hook config (default satori)
#   KATRA_SHARED_ID    shared scope (default my-team)
#   KATRA_API_KEY      the machine's client key; when unset, read from
#                      KATRA_API_KEY_FILE (default ~/.katra/keys/katra-<user>.key)
#   KATRA_HOST         Katra host (default localhost) for the self-test
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PY="${KOLEGA_CLI_PY:-$HOME/.local/share/uv/tools/kolega-code/bin/python}"
STATE_DIR="${KOLEGA_CODE_STATE_DIR:-$HOME/.local/state/kolega-code}"
export KOLEGA_CODE_STATE_DIR="$STATE_DIR"
USER_ID="${KATRA_USER_ID:-satori}"
SHARED_ID="${KATRA_SHARED_ID:-my-team}"
HOST="${KATRA_HOST:-localhost}"
FAIL=0

# Resolve the API key: env first, then key file (~/.katra/keys/katra-<user>.key).
API_KEY="${KATRA_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  KEY_FILE="${KATRA_API_KEY_FILE:-$HOME/.katra/keys/katra-$USER_ID.key}"
  if [ -f "$KEY_FILE" ]; then
    API_KEY="$(cat "$KEY_FILE" | tr -d '\n')"
  fi
fi

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
    || ok "CLI venv import skipped (command-hook path works; next update resets this anyway)"
else
  ok "no CLI venv found — command-hook path only"
fi

step "3/4 hook config + command-hook registration"
mkdir -p "$STATE_DIR" "$HOME/.katra/keys"
HOOK_CFG="$STATE_DIR/satori-hook.json"

# 3a. Write the hook config for THIS machine's identity when it is missing.
#     An existing config is left untouched (it may hold a rotated key);
#     when KATRA_USER_ID differs from the config's user_id, refresh it.
NEEDS_CFG=0
if [ ! -f "$HOOK_CFG" ]; then
  NEEDS_CFG=1
elif [ -n "$API_KEY" ] && ! grep -q "\"user_id\": \"$USER_ID\"" "$HOOK_CFG" 2>/dev/null; then
  NEEDS_CFG=1
fi
if [ "$NEEDS_CFG" = "1" ]; then
  if [ -z "$API_KEY" ]; then
    bad "no API key for user '$USER_ID' — set KATRA_API_KEY or write $HOME/.katra/keys/katra-$USER_ID.key"
  else
    cat > "$HOOK_CFG" <<EOF
{
  "mcp_url": "http://$HOST:3112/mcp",
  "api_key": "$API_KEY",
  "user_id": "$USER_ID",
  "shared_id": "$SHARED_ID",
  "enabled": true,
  "timeout_seconds": 8,
  "personality": "balanced",
  "max_context_tokens": 5000,
  "sources": [
    "agent_message",
    "daily_reflection",
    "philosophical_insights",
    "unresolved_threads",
    "working_memory",
    "temporal_context",
    "vector_search",
    "temporal_recall",
    "emotional_context",
    "missions",
    "knowledge_graph"
  ],
  "source_weights": {},
  "scoring": {},
  "cache_ttl_seconds": 30,
  "debug": true
}
EOF
    chmod 600 "$HOOK_CFG"
    ok "hook config written for user_id '$USER_ID' (chmod 600)"
  fi
else
  ok "hook config present for user_id '$USER_ID'"
fi

# 3b. Register the command hooks with the CLI (update-proof path). Merge,
#     never clobber: other hooks (e.g. action_card_hook) must survive.
HOOKS_JSON="$STATE_DIR/hooks.json"
CMD_RUNNER="$HERE/.venv/bin/python $HERE/scripts/hook_runner.py"
python3 - "$HOOKS_JSON" "$CMD_RUNNER" <<'PYEOF'
import json, os, sys
path, runner = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        cfg = json.load(f)
except Exception:
    cfg = {"schema_version": 1, "hooks": {}}
hooks = cfg.setdefault("hooks", {})
def ensure(event, timeout):
    lst = hooks.setdefault(event, [])
    entry = {"matcher": "*", "hooks": []}
    for grp in lst:
        if grp.get("matcher") == "*":
            entry = grp
            break
    else:
        lst.append(entry)
    existing = [h for h in entry["hooks"] if h.get("type") == "command" and h.get("command") == runner]
    if not existing:
        entry["hooks"].insert(0, {"type": "command", "command": runner, "timeout": timeout})
ensure("SessionStart", 20)
ensure("UserPromptSubmit", 15)
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF
if [ -f "$HOOKS_JSON" ]; then
  ok "command hooks registered in $HOOKS_JSON"
else
  bad "hooks.json registration failed"
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
  && ok "runner returned memory context for user_id '$USER_ID'" \
  || bad "runner returned no context (auth or server issue)"

if [ "$FAIL" -ne 0 ]; then
  printf '\nensure-bridge FAILED — see ✗ lines above.\n'
  exit 1
fi
printf '\nensure-bridge OK — bridge healthy and update-proof (identity: %s).\n' "$USER_ID"
