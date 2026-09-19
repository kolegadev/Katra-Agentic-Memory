#!/usr/bin/env bash
# outage-drill.sh — controlled connectivity drill for the net-agent toolbox.
#
# 1. disables device autoconnect and drops the WiFi link (simulated outage)
# 2. waits for the watchdog → dispatcher → skill loop to restore connectivity
# 3. RESTORES autoconnect unconditionally (safety net if the agent fails)
#
# The agent itself is the only intended restorer during the wait window.
# Evidence: ~/.local/state/net-agent/net-agent-state.json history + this log.
set -u

LOG=/tmp/outage-drill.log
CFG="$HOME/.config/net-agent/config.json"
DISP="$HOME/.config/net-agent/dispatcher/dispatch.py"
STATE="$HOME/.local/state/net-agent/net-agent-state.json"

log() { echo "[$(date +%H:%M:%S)] $*" >> "$LOG"; }

restore() {
  log "SAFETY RESTORE: re-enabling autoconnect + forcing profile up"
  sudo -n nmcli device set wlp3s0 autoconnect yes >> "$LOG" 2>&1
  nmcli connection up netis >> "$LOG" 2>&1   # user-owned profile: no sudo needed
}

trap restore EXIT

: > "$LOG"
log "=== outage drill start ==="
log "pre-drill verify: $(python3 "$DISP" --config "$CFG" --verify-only 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['online'])")"
log "archiving prior agent state"
[ -f "$STATE" ] && mv "$STATE" "$STATE.pre-drill" >> "$LOG" 2>&1

log "disabling autoconnect on wlp3s0"
sudo -n nmcli device set wlp3s0 autoconnect no >> "$LOG" 2>&1
log "dropping wifi link (outage starts)"
sudo -n nmcli device disconnect wlp3s0 >> "$LOG" 2>&1

RESTORED=no
for i in $(seq 1 72); do   # up to 6 minutes
  sleep 5
  if python3 "$DISP" --config "$CFG" --verify-only 2>/dev/null \
      | grep -q '"online": true'; then
    log "RESTORED after ~$((i*5))s — checking who did it"
    RESTORED=yes
    break
  fi
  [ $((i % 6)) -eq 0 ] && log "t+$((i*5))s: still offline"
done

if [ "$RESTORED" = "yes" ]; then
  if [ -f "$STATE" ]; then
    python3 - "$STATE" >> "$LOG" 2>&1 <<'PYEOF'
import json, sys
try:
    st = json.load(open(sys.argv[1]))
    ok = [h for h in st.get("history", []) if h.get("online_after")]
    print("agent_restored: true" if ok else "agent_restored: false")
    for h in st.get("history", [])[-6:]:
        print("  cycle %s: %s -> %s (online_after=%s)"
              % (h.get("cycle"), h.get("skill"), h.get("result"),
                 h.get("online_after")))
except Exception as e:
    print("state unreadable:", e)
PYEOF
  fi
else
  log "TIMEOUT: agent did not restore within 6 minutes (safety net takes over)"
fi

log "journal tail (user watchdog):"
systemctl --user status net-watchdog.service --no-pager -n 5 >> "$LOG" 2>&1
log "=== drill end (restore trap runs on exit) ==="
