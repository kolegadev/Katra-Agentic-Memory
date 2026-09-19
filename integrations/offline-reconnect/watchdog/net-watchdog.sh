#!/usr/bin/env bash
# net-watchdog: cheap reachability probe; triggers the net-agent loop on failure.
# Run by net-watchdog.timer every 30s. Two consecutive failures = engage.
# Backoff: repeated failed dispatch runs stretch the engage cadence.
set -u
DIR="${NET_AGENT_DIR:-/etc/net-agent}"
STATE="$DIR/watchdog-state"
DISPLAY_DIR="$(dirname "$(readlink -f "$0")")"
ROOT="$(dirname "$DISPLAY_DIR")"

# STOP file: leave quietly, do not spam the journal every 30s
[ -f "$DIR/STOP" ] && exit 0

online() {
  # quick: gateway ping is enough of a first gate; verify handles the full contract
  timeout 5 ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 && return 0
  timeout 5 getent hosts one.one.one.one >/dev/null 2>&1 && return 0
  return 1
}

fails="${NET_AGENT_FAILS:-2}"
mkdir -p "$STATE" 2>/dev/null || STATE="/tmp/net-agent-state"
CNT="$STATE/fail-count"
DCNT="$STATE/dispatch-fail-count"

if online; then
  echo 0 > "$CNT" 2>/dev/null || true
  echo 0 > "$DCNT" 2>/dev/null || true
  exit 0
fi

n=0
[ -f "$CNT" ] && n=$(cat "$CNT" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$CNT" 2>/dev/null || true
[ "$n" -lt "$fails" ] && exit 0

# backoff: after repeated failed dispatch runs, engage less often
# (ISP-down mode would otherwise burn model inference every ~90s forever)
d=0
[ -f "$DCNT" ] && d=$(cat "$DCNT" 2>/dev/null || echo 0)
if [ "$d" -ge 8 ]; then
  # engage only every 10th check (≈5 min at 30s cadence)
  [ $((n % 10)) -ne 0 ] && exit 0
fi

# engage: one dispatcher run; flock prevents overlap; timer re-arms the loop
exec 9>"$STATE/net-agent.lock"
if ! flock -n 9; then
  exit 0   # a run is already in progress
fi
cd "$ROOT" || exit 3
python3 dispatcher/dispatch.py --config "$DIR/config.json"
rc=$?
if [ "$rc" -eq 2 ]; then
  d=$((d + 1)); echo "$d" > "$DCNT" 2>/dev/null || true
else
  echo 0 > "$DCNT" 2>/dev/null || true
fi
exit $rc
