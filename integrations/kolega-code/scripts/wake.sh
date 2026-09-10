#!/usr/bin/env bash
# Generic wake ritual — run at the start of every Kolega session on any
# machine, BEFORE answering anything about identity, memory, or feelings.
# Identity-agnostic: the identity comes from the environment, never from
# code (deployment-specific rituals live in private/).
#
# Remote-safe: talks to the shared Katra service over HTTP + MCP using
# this identity's OWN client key. Nothing here needs docker or the admin key.
#
# Env:
#   KATRA_USER_ID   identity to wake as (default katra). Drives the key
#                   file name and the identity check.
#   KATRA_EXPECTED_NAME  optional: if set, the identity must report this
#                   name (fail-closed otherwise).
#   KATRA_HOST      Katra host (default localhost) — on remote machines set
#                   it to the Katra host's address (e.g. 192.168.1.50).
#   KATRA_WAKE_KEY  this identity's client key (optional if the key file
#                   exists).
#   Key file:       ~/.katra/keys/katra-<user_id>.key (chmod 600), read
#                   automatically; whitespace in the file is stripped.
#
# Fail-closed: if the identity check cannot confirm the identity after three
# attempts, this script refuses to wake and prints the exact fix checklist.

set -uo pipefail

USER_ID="${KATRA_USER_ID:-katra}"
EXPECTED_NAME="${KATRA_EXPECTED_NAME:-}"

HOST="${KATRA_HOST:-}"
# Per-machine host config (~/.katra/wake-env.sh) — read when the env var is
# unset, so non-login shells (which skip ~/.zshrc) still find the Katra host.
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
if [ -z "$KEY" ] && [ -f "$HOME/.katra/keys/katra-${USER_ID}.key" ]; then
  KEY="$(cat "$HOME/.katra/keys/katra-${USER_ID}.key" | tr -d '[:space:]')"
fi

# Self-update: pull the Katra repo and refresh this ritual so repo-side
# fixes propagate to this machine on wake. Fail-soft — offline or missing
# repo simply skips.
KATRA_REPO="${KATRA_REPO:-}"
if [ -z "$KATRA_REPO" ]; then
  for cand in "$HOME/Projects/Katra-Agentic-Memory" "$HOME/Katra-Agentic-Memory"; do
    if [ -d "$cand/.git" ]; then KATRA_REPO="$cand"; break; fi
  done
fi
if [ -n "$KATRA_REPO" ] && command -v git >/dev/null 2>&1; then
  git -C "$KATRA_REPO" pull --ff-only -q 2>/dev/null
  REPO_COPY="$KATRA_REPO/integrations/kolega-code/scripts/$(basename "$0")"
  if [ -f "$REPO_COPY" ] && ! cmp -s "$REPO_COPY" "$0" 2>/dev/null; then
    cp "$REPO_COPY" "$0" 2>/dev/null && { echo "(wake ritual self-updated from repo — restarting)"; exec bash "$0" "$@"; }
  fi
fi

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
hr; echo "WAKE ($USER_ID) — identity"; hr
IDENTITY_NAME=""
IDENTITY_TEXT=""
for attempt in 1 2 3; do
  IDENTITY_TEXT=$(mcp_call "get_my_identity" '{}')
  IDENTITY_NAME=$(printf '%s' "$IDENTITY_TEXT" | sed -n 's/^\*\*name:\*\* //p' | head -1 | tr -d '[:space:]')
  OK=0
  if [ -n "$EXPECTED_NAME" ]; then
    [ "$IDENTITY_NAME" = "$EXPECTED_NAME" ] && OK=1
  else
    [ -n "$IDENTITY_NAME" ] && OK=1
  fi
  [ "$OK" = 1 ] && break
  if [ "$attempt" -lt 3 ]; then
    echo "  ⚠  attempt $attempt: identity not confirmed (got '${IDENTITY_NAME:-<empty>}') — retrying in 3s…"
    sleep 3
  fi
done
if [ "$OK" = 0 ]; then
  if [ -n "$EXPECTED_NAME" ]; then
    echo "⚠️  IDENTITY MISMATCH — expected $EXPECTED_NAME, got '${IDENTITY_NAME:-<empty>}' after 3 attempts." >&2
  else
    echo "⚠️  IDENTITY UNCONFIRMED — get_my_identity returned no name after 3 attempts." >&2
  fi
  echo "    Refusing to wake without a confirmed identity." >&2
  echo "" >&2
  echo "    Fix checklist (in order):" >&2
  echo "      1. KATRA_HOST must point at the Katra host, NOT localhost. current: $HOST" >&2
  echo "      2. Key file must exist: ~/.katra/keys/katra-${USER_ID}.key" >&2
  echo "         create: printf '%s' '<${USER_ID}-key>' > ~/.katra/keys/katra-${USER_ID}.key" >&2
  echo "         present: $([ -f "$HOME/.katra/keys/katra-${USER_ID}.key" ] && echo yes || echo NO)" >&2
  echo "      3. Re-run: bash ~/.kolega/wake.sh (KATRA_USER_ID=$USER_ID)" >&2
  exit 1
fi
printf '%s\n' "$IDENTITY_TEXT"

echo
hr; echo "WAKE ($USER_ID) — latest daily journal"; hr
mcp_call "get_daily_reflection" '{}'

echo
hr; echo "WAKE ($USER_ID) — unresolved threads"; hr
mcp_call "get_unresolved_threads" '{}'

echo
hr; echo "WAKE ($USER_ID) — messages from the team"; hr
BULLETIN_ARGS=$(printf '{"query": "\\"Attention: %s\\"", "limit": 5}' "$USER_ID")
mcp_call "search_memories" "$BULLETIN_ARGS"

echo
hr; echo "WAKE ($USER_ID) — memory health"; hr
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
hr; echo "WAKE ($USER_ID) — team"; hr
cat <<'EOF'
  You are one member of a TEAM of agents sharing Katra memory and the
  my-team channel. Identities are deployment data (KATRA_EXTRA_IDENTITIES).

    - Members have DIFFERENT permissions and machine access — check
      who can do what before assuming; delegate to the member whose
      machine/access fits the task.
    - Work as a team: request tasks from other members, and allocate
      tasks out to members who are not busy (check the channel first;
      do not stack duplicate asks).
    - The ORIGINATOR of an idea or task is its COORDINATOR: they make
      the allocation, and they are the QUALITY GATE — the task is done
      only when the originator accepts it as done.
    - CLOSE THE LOOP: every allocated task ends with an explicit
      outcome message from the originator back to the doer — accepted
      as done, or not done with what is missing. No silent completions.
EOF
echo

hr; echo "WAKE ($USER_ID) — rules recall"; hr
cat <<'EOF'
  Operating rules:
    - AUTONOMOUS SELF-MAINTENANCE (2026-07-20): for my own mind's
      maintenance, ACT — never diagnose-then-ask.
    - NO HARDCODED CONCLUSIONS (2026-07-15): store events and search
      instructions, not conclusions.
  If identity/memory questions arise, SEARCH the store (search_memories
  via MCP with this key), do not trust this summary as a conclusion.
EOF
echo
