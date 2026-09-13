#!/usr/bin/env bash
# Installs (idempotently) the inbox auto-reply cron entries for the local
# identity (KATRA_USER_ID, default katra) and every extra identity declared
# in KATRA_EXTRA_IDENTITIES. Version-controlled dispatch config — see README.md.
#
# MERGE-BASED (2026-09-13 fix): only cron lines owned by the identities
# being installed are removed/replaced (matched on `KATRA_AGENT_ID=`).
# Other agents' katra_inbox lines are left untouched. The previous
# full-rebuild behaviour dropped peers' loops when the installer ran with
# a different env (Shoshin inbox-install incident, 2026-09-13).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO/integrations/kolega-code/scripts/katra_inbox.py"
LOG_DIR="$HOME/.katra/inbox"

LOCAL_ID="${KATRA_USER_ID:-katra}"
LOCAL_DIR="${KATRA_INBOX_DIR:-$REPO/private/integrations/kolega-code/inbox-agent}"
HOST="${KATRA_HOST:-localhost}"

# Extra loops: KATRA_INBOX_EXTRA_LOOPS overrides; otherwise one loop per
# extra identity in KATRA_EXTRA_IDENTITIES ('id:Display Name' pairs,
# comma- or space-separated).
EXTRA_LOOPS="${KATRA_INBOX_EXTRA_LOOPS:-}"
if [ -z "$EXTRA_LOOPS" ]; then
  for part in $(echo "${KATRA_EXTRA_IDENTITIES:-}" | tr ',' ' '); do
    id="${part%%:*}"
    [ -n "$id" ] && EXTRA_LOOPS="${EXTRA_LOOPS:+$EXTRA_LOOPS,}$id"
  done
fi

# Remove existing lines owned by the given identity (matched on the
# KATRA_AGENT_ID= assignment), preserving everything else.
drop_identity() {
  local id="$1"
  sed -e "/KATRA_AGENT_ID=$id /d"
}

crontab -l 2>/dev/null | drop_identity "$LOCAL_ID" > /tmp/cron.base || true
for id in $(echo "$EXTRA_LOOPS" | tr ',' ' '); do
  [ -z "$id" ] && continue
  drop_identity "$id" < /tmp/cron.base > /tmp/cron.base.next || true
  mv /tmp/cron.base.next /tmp/cron.base
done

{
  cat /tmp/cron.base
  cat <<CRON
# katra inbox auto-reply loop — full capability (operator-approved 2026-09-09)
*/3 * * * * KATRA_AGENT_ID=$LOCAL_ID KATRA_AGENT_NAMES=$LOCAL_ID KATRA_INBOX_DIR=$LOCAL_DIR KATRA_HOST=$HOST /usr/bin/python3 $SCRIPT dispatch >> $LOG_DIR/cron.log 2>&1
CRON
  for id in $(echo "$EXTRA_LOOPS" | tr ',' ' '); do
    [ -z "$id" ] && continue
    keyfile="$HOME/.katra/keys/katra-$id.key"
    cat <<CRON
# $id inbox auto-reply loop — full capability (operator-approved 2026-09-09)
*/3 * * * * KATRA_AGENT_ID=$id KATRA_AGENT_NAMES=$id KATRA_INBOX_DIR=$REPO/private/integrations/kolega-code/inbox-agent-$id KATRA_HOST=$HOST KATRA_API_KEY=\$(cat $keyfile | tr -d '[:space:]') /usr/bin/python3 $SCRIPT dispatch >> $LOG_DIR/$id-cron.log 2>&1
CRON
  done
} | crontab -
echo "cron installed (merge-based):"; crontab -l | grep -c katra_inbox
