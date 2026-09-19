#!/usr/bin/env bash
# wake-check.sh — the wakeup-ritual step.
# Prints an ONLINE/OFFLINE verdict; engages the net-agent loop when offline.
# Safe to run unprivileged: it only probes and (optionally) asks systemd.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="python3"
# config resolution: NET_AGENT_DIR env → user-mode (~/.config) → /etc
if [ -n "${NET_AGENT_DIR:-}" ]; then
  :
elif [ -f "$HOME/.config/net-agent/config.json" ]; then
  NET_AGENT_DIR="$HOME/.config/net-agent"
else
  NET_AGENT_DIR="/etc/net-agent"
fi

if [ -f "$NET_AGENT_DIR/config.json" ]; then
  CFG="--config $NET_AGENT_DIR/config.json"
else
  CFG=""
fi

# 1. cheap probes first (no python import cost)
if timeout 4 ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; then
  echo "net-agent wake: ONLINE (icmp 1.1.1.1)"
  exit 0
fi

# 2. full contract verifier
if OUT=$("$PY" "$ROOT/dispatcher/dispatch.py" $CFG --verify-only 2>/dev/null); then
  ONLINE=$(echo "$OUT" | "$PY" -c "import json,sys;print(json.load(sys.stdin)['data']['online'])")
  if [ "$ONLINE" = "True" ]; then
    echo "net-agent wake: ONLINE (full verify)"
    exit 0
  fi
fi
echo "net-agent wake: OFFLINE — engaging reconnect loop"

# 3. engage: ensure watchdog timer is active, and kick one immediate run
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet net-watchdog.timer 2>/dev/null || \
    sudo -n systemctl enable --now net-watchdog.timer 2>/dev/null || true
  sudo -n systemctl start net-watchdog.service 2>/dev/null || true
fi

# 4. run one dispatcher pass inline (flock-guarded; won't overlap the timer)
STATE="${NET_AGENT_DIR:-/tmp}/watchdog-state"
mkdir -p "$STATE" 2>/dev/null || STATE="/tmp"
exec 9>"$STATE/net-agent.lock"
if flock -n 9; then
  cd "$ROOT" && "$PY" dispatcher/dispatch.py $CFG
  exit $?
fi
exit 0
