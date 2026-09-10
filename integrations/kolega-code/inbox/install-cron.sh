#!/usr/bin/env bash
# Installs (idempotently) the inbox auto-reply cron entries for the local
# identity (KATRA_USER_ID, default katra) and every extra identity declared
# in KATRA_EXTRA_IDENTITIES. Version-controlled dispatch config — see README.md.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO/integrations/kolega-code/scripts/katra_inbox.py"
LOG_DIR="$HOME/.katra/inbox"

LOCAL_ID="${KATRA_USER_ID:-katra}"
LOCAL_DIR="${KATRA_INBOX_DIR:-$REPO/private/integrations/kolega-code/inbox-agent}"

# Extra loops: KATRA_INBOX_EXTRA_LOOPS overrides; otherwise one loop per
# extra identity in KATRA_EXTRA_IDENTITIES ('id:Display Name' pairs).
EXTRA_LOOPS="${KATRA_INBOX_EXTRA_LOOPS:-}"
if [ -z "$EXTRA_LOOPS" ]; then
  for part in ${KATRA_EXTRA_IDENTITIES:-}; do
    id="${part%%:*}"
    [ -n "$id" ] && EXTRA_LOOPS="${EXTRA_LOOPS:+$EXTRA_LOOPS,}$id"
  done
fi

crontab -l 2>/dev/null | grep -v "katra_inbox.py dispatch" > /tmp/cron.base || true
{
  cat /tmp/cron.base
  cat <<CRON
# katra inbox auto-reply loop — full capability (operator-approved 2026-09-09)
*/3 * * * * KATRA_AGENT_ID=$LOCAL_ID KATRA_INBOX_DIR=$LOCAL_DIR KATRA_HOST=localhost /usr/bin/python3 $SCRIPT dispatch >> $LOG_DIR/cron.log 2>&1
CRON
  for id in $(echo "$EXTRA_LOOPS" | tr ',' ' '); do
    [ -z "$id" ] && continue
    keyfile="$HOME/.katra/keys/katra-$id.key"
    cat <<CRON
# $id inbox auto-reply loop — full capability (operator-approved 2026-09-09)
*/3 * * * * KATRA_AGENT_ID=$id KATRA_AGENT_NAMES=$id KATRA_INBOX_DIR=$REPO/private/integrations/kolega-code/inbox-agent-$id KATRA_HOST=localhost KATRA_API_KEY=\$(cat $keyfile | tr -d '[:space:]') /usr/bin/python3 $SCRIPT dispatch >> $LOG_DIR/$id-cron.log 2>&1
CRON
  done
} | crontab -
echo "cron installed:"; crontab -l | grep -c katra_inbox
