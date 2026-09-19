#!/bin/bash
# net-agent: clean WiFi driver reload for thebrick (iwlwifi / Intel AX210).
# Fixed no-arg script, invoked only by the static skills via NOPASSWD sudo.
# A bare `modprobe -r iwlwifi` fails with "module in use" while the netdev
# exists, so: un-manage -> delete netdev -> unload stack -> reload -> reconnect.
set -u
IFACE="wlp3s0"
log() { echo "[net-agent-reload] $*"; }

log "unmanaging $IFACE"
nmcli device set "$IFACE" managed no 2>/dev/null

log "deleting netdev"
iw dev "$IFACE" del 2>/dev/null || ip link set "$IFACE" down 2>/dev/null || true
sleep 1

log "unloading module stack"
modprobe -r iwlmvm 2>/dev/null
modprobe -r iwlwifi 2>/dev/null
modprobe -r mac80211 2>/dev/null
sleep 1

log "reloading iwlwifi"
modprobe iwlwifi || { echo "[net-agent-reload] modprobe iwlwifi FAILED"; exit 1; }
sleep 2

# NetworkManager re-detects the phy and recreates the interface; nudge it.
log "reconnecting"
nmcli device set "$IFACE" managed yes 2>/dev/null || true
sleep 2
nmcli device connect "$IFACE" 2>/dev/null || true

log "done"
exit 0
