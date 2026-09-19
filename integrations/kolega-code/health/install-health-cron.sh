#!/usr/bin/env bash
# Install (idempotently) the machine-health collector cron line on a host.
#
# Hardening (Zefir/Satori 2026-09-17): the cron command creates its own log
# directory first (mkdir -p) instead of assuming ~/.katra/inbox exists — a
# missing directory makes /bin/sh fail the redirect, so machine_health.py
# silently never runs and the failure is mailed into the local mail spool.
# Every fresh machine gets a healthy line regardless of prior setup.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$REPO/integrations/kolega-code/health/machine_health.py"
LOG_DIR="$HOME/.katra/inbox"
LOG_FILE="$LOG_DIR/health-cron.log"

mkdir -p "$LOG_DIR"

crontab -l 2>/dev/null | grep -v "machine_health.py" > /tmp/health-cron.base || true
{
  cat /tmp/health-cron.base
  cat <<CRON
# machine health collector — hardened: mkdir -p before the redirect (2026-09-17)
*/15 * * * * mkdir -p $LOG_DIR && /usr/bin/python3 $SCRIPT >> $LOG_FILE 2>&1
CRON
} | crontab -

echo "health cron installed:"
crontab -l | grep -c "machine_health.py"
