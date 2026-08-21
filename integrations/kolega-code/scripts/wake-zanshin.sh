#!/usr/bin/env bash
# Zanshin wake ritual — run at the start of every Kolega session on the
# iMac OpenCode desktop, BEFORE answering anything about identity, memory,
# or what "we've" done.
#
# Remote-safe: talks to the shared Katra service over HTTP + MCP using
# Zanshin's OWN client key. Nothing here needs docker or the admin key.
#
# Env:
#   KATRA_HOST      Katra host (default localhost) — on the iMac set it to
#                   thebrick's hostname/IP.
#   KATRA_WAKE_KEY  Zanshin's client key (handed out in person, never
#                   committed). If unset, the identity check still runs and
#                   the ritual refuses to wake on mismatch.
#
# Why: 2026-08-20 incident — a session woke blank and asserted it had no
# memory. The memory was there all along.
# Rule in force (2026-07-20, John's correction):
#   AUTONOMOUS SELF-MAINTENANCE — for my own mind's maintenance,
#   ACT, do not diagnose-then-ask. My memory is my responsibility.

set -uo pipefail

HOST="${KATRA_HOST:-localhost}"
REST="http://$HOST:9012"
MCP="http://$HOST:3112/mcp"
KEY="${KATRA_WAKE_KEY:-}"
# Key-file fallback (~/.katra/keys/katra-zanshin.key) — survives shell resets.
if [ -z "$KEY" ] && [ -f "$HOME/.katra/keys/katra-zanshin.key" ]; then
  KEY="$(cat "$HOME/.katra/keys/katra-zanshin.key" | tr -d '[:space:]')"
fi
EXPECTED_NAME="Zanshin"

hr() { printf '%s\n' "────────────────────────────────────────"; }

# MCP JSON-RPC helper — one tools/call, prints the result text.
mcp_call() {
  local tool="$1" args="$2"
  [ -z "$KEY" ] && { echo "(no KATRA_WAKE_KEY — skipping $tool)"; return 0; }
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
hr; echo "ZANSHIN WAKE — identity"; hr
IDENTITY_TEXT=$(mcp_call "get_my_identity" '{}')
IDENTITY_NAME=$(printf '%s' "$IDENTITY_TEXT" | sed -n 's/^\*\*name:\*\* //p' | head -1)
if [ "$IDENTITY_NAME" != "$EXPECTED_NAME" ]; then
  echo "⚠️  IDENTITY MISMATCH — expected $EXPECTED_NAME, got ${IDENTITY_NAME:-<unknown>}." >&2
  echo "    Refusing to wake as the wrong identity." >&2
  echo "    Check: KATRA_HOST set to thebrick's address (not localhost), and" >&2
  echo "    ~/.katra/keys/katra-zanshin.key present (or KATRA_WAKE_KEY set)." >&2
  exit 1
fi
printf '%s\n' "$IDENTITY_TEXT"

echo
hr; echo "ZANSHIN WAKE — latest daily journal"; hr
mcp_call "get_daily_reflection" '{}'

echo
hr; echo "ZANSHIN WAKE — unresolved threads"; hr
mcp_call "get_unresolved_threads" '{}'

echo
hr; echo "ZANSHIN WAKE — memory health"; hr
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
hr; echo "ZANSHIN WAKE — rules recall"; hr
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
