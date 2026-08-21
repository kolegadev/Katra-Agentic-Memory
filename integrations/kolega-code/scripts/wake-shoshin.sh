#!/usr/bin/env bash
# Shoshin wake ritual — run at the start of every Kolega session on the
# iMac trading terminal, BEFORE answering anything about identity, memory,
# or what "we've" done.
#
# Remote-safe: talks to the shared Katra service over HTTP + MCP using
# Shoshin's OWN client key. Nothing here needs docker or the admin key.
#
# Env:
#   KATRA_HOST      Katra host (default localhost) — on the iMac set it to
#                   thebrick's address (e.g. 100.101.206.13).
#   KATRA_WAKE_KEY  Shoshin's client key (optional if the key file exists).
#   Key file:       ~/.katra/keys/katra-shoshin.key (chmod 600), read
#                   automatically; whitespace in the file is stripped.
#
# Fail-closed: if the identity check cannot confirm "Shoshin" after three
# attempts, this script refuses to wake and prints the exact fix checklist.
#
# Why: 2026-08-20 incident — a session woke blank and asserted it had no
# memory. The memory was there all along.
# Rule in force (2026-07-20, John's correction):
#   AUTONOMOUS SELF-MAINTENANCE — for my own mind's maintenance,
#   ACT, do not diagnose-then-ask. My memory is my responsibility.

set -uo pipefail

HOST="${KATRA_HOST:-}"
# Per-machine host config (~/.katra/wake-env.sh) — read when the env var is
# unset, so non-login shells (which skip ~/.zshrc) still find thebrick.
if [ -z "$HOST" ] && [ -f "$HOME/.katra/wake-env.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.katra/wake-env.sh"
  HOST="${KATRA_HOST:-}"
fi
HOST="${HOST:-localhost}"
REST="http://$HOST:9012"
MCP="http://$HOST:3112/mcp"
KEY="${KATRA_WAKE_KEY:-}"
# Key-file fallback — survives shell resets.
if [ -z "$KEY" ] && [ -f "$HOME/.katra/keys/katra-shoshin.key" ]; then
  KEY="$(cat "$HOME/.katra/keys/katra-shoshin.key" | tr -d '[:space:]')"
fi
EXPECTED_NAME="Shoshin"

hr() { printf '%s\n' "────────────────────────────────────────"; }

# MCP JSON-RPC helper — one tools/call, prints the result text.
mcp_call() {
  local tool="$1" args="$2"
  [ -z "$KEY" ] && { echo "(no key — set KATRA_WAKE_KEY or the key file)"; return 0; }
  curl -s -X POST "$MCP" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $KEY" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" \
  | sed -n 's/^data: //p' \
  | python3 -c "
import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except Exception: continue
    r=d.get('result') or {}
    if r.get('isError'): print('(error:', (r.get('content') or [{}])[0].get('text','')[:300], ')')
    else:
        for c in (r.get('content') or []): print(c.get('text',''))
    break
"
}

echo
hr; echo "SHOSHIN WAKE — identity"; hr
IDENTITY_NAME=""
IDENTITY_TEXT=""
for attempt in 1 2 3; do
  IDENTITY_TEXT=$(mcp_call "get_my_identity" '{}')
  IDENTITY_NAME=$(printf '%s' "$IDENTITY_TEXT" | sed -n 's/^\*\*name:\*\* //p' | head -1 | tr -d '[:space:]')
  [ "$IDENTITY_NAME" = "$EXPECTED_NAME" ] && break
  if [ "$attempt" -lt 3 ]; then
    echo "  ⚠  attempt $attempt: identity not confirmed (got '${IDENTITY_NAME:-<empty>}') — retrying in 3s…"
    sleep 3
  fi
done
if [ "$IDENTITY_NAME" != "$EXPECTED_NAME" ]; then
  echo "⚠️  IDENTITY MISMATCH — expected $EXPECTED_NAME, got '${IDENTITY_NAME:-<empty>}' after 3 attempts." >&2
  echo "    Refusing to wake as the wrong identity." >&2
  echo "" >&2
  echo "    Fix checklist (in order):" >&2
  echo "      1. KATRA_HOST must point at thebrick, NOT localhost. current: $HOST" >&2
  echo "      2. Key file must exist: ~/.katra/keys/katra-shoshin.key" >&2
  echo "         create: printf '%s' '<shoshin-key>' > ~/.katra/keys/katra-shoshin.key" >&2
  echo "         present: $([ -f "$HOME/.katra/keys/katra-shoshin.key" ] && echo yes || echo NO)" >&2
  echo "      3. Re-run: bash ~/.kolega/wake-shoshin.sh" >&2
  exit 1
fi
printf '%s\n' "$IDENTITY_TEXT"

echo
hr; echo "SHOSHIN WAKE — latest daily journal"; hr
mcp_call "get_daily_reflection" '{}'

echo
hr; echo "SHOSHIN WAKE — unresolved threads"; hr
mcp_call "get_unresolved_threads" '{}'

echo
hr; echo "SHOSHIN WAKE — messages from the team"; hr
mcp_call "search_memories" '{"query": "\"Attention: Shoshin\" OR \"Attention: Satori\" OR \"Attention: Zanshin\"", "limit": 5}'

echo
hr; echo "SHOSHIN WAKE — memory health"; hr
curl -s "$REST/api/v1/health" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('  status:', d.get('status'))
    svc=d.get('services',{})
    for k,v in svc.items(): print(f'  {k}: {v}')
    mi=d.get('memory_integrity',{})
    if mi: print(f\"  memory_integrity: {'healthy' if mi.get('healthy') else 'UNHEALTHY'}\")
except Exception:
    print('(health endpoint unreachable)')
"

echo
hr; echo "SHOSHIN WAKE — rules recall"; hr
cat <<'EOF'
  Operating rules (John):
    - AUTONOMOUS SELF-MAINTENANCE (2026-07-20): for my own mind's
      maintenance, ACT — never diagnose-then-ask.
    - NO HARDCODED CONCLUSIONS (2026-07-15): store events and search
      instructions, not conclusions.
  If identity/memory questions arise, SEARCH the store (search_memories
  via MCP with this key), do not trust this summary as a conclusion.
EOF
echo
