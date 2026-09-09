#!/usr/bin/env bash
# Installs (idempotently) the inbox auto-reply cron entries for Satori and
# Zefir on thebrick. Version-controlled dispatch config — see README.md.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO/integrations/kolega-code/scripts/satori_inbox.py"
SATORI_DIR="$REPO/integrations/kolega-code/inbox-agent"
ZEFIR_DIR="$REPO/integrations/kolega-code/inbox-agent-zefir"
LOG_DIR="$HOME/.katra/inbox"
ZEFIR_KEY_FILE="$HOME/.katra/keys/katra-zefir.key"

crontab -l 2>/dev/null | grep -v "satori_inbox.py dispatch" > /tmp/cron.base || true
{
  cat /tmp/cron.base
  cat <<CRON
# satori inbox auto-reply loop — full capability (John 2026-09-09)
*/3 * * * * /usr/bin/python3 $SCRIPT dispatch >> $LOG_DIR/cron.log 2>&1
# zefir inbox auto-reply loop — full capability (John 2026-09-09)
*/3 * * * * KATRA_AGENT_ID=zefir KATRA_AGENT_NAMES=zefir KATRA_INBOX_DIR=$ZEFIR_DIR KATRA_HOST=localhost KATRA_API_KEY=\$(cat $ZEFIR_KEY_FILE | tr -d '[:space:]') /usr/bin/python3 $SCRIPT dispatch >> $LOG_DIR/zefir-cron.log 2>&1
CRON
} | crontab -
echo "cron installed:"; crontab -l | grep -c satori_inbox
