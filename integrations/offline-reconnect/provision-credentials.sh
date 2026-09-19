#!/usr/bin/env bash
# provision-credentials.sh — interactive entry of router admin/WiFi credentials.
# Usage:  bash ~/.config/net-agent/provision-credentials.sh
# Passwords are typed hidden (never echoed); blank = keep current value.
set -u
CFG="${NET_AGENT_CONFIG:-$HOME/.config/net-agent/config.json}"
[ -f "$CFG" ] || { echo "config not found: $CFG"; exit 1; }
PY=python3

ask_hidden() { local v=""; read -r -s -p "$1: " v; echo; printf '%s' "$v"; }
ask_plain()  { local v=""; read -r -p "$1 [$2]: " v; printf '%s' "${v:-$2}"; }

echo "net-agent credential provisioning"
echo "(type values, press Enter; passwords are hidden; blank = leave unchanged)"
A1=$(ask_plain  "netis router admin username" "admin")
P1=$(ask_hidden "netis router admin password")
A2=$(ask_plain  "91D2F8 router admin username" "admin")
P2=$(ask_hidden "91D2F8 router admin password")
K1=$(ask_hidden "netis WiFi password (optional - for profile rebuild only)")
K2=$(ask_hidden "91D2F8 WiFi password (optional - for profile rebuild only)")

"$PY" - "$CFG" "$A1" "$P1" "$A2" "$P2" "$K1" "$K2" <<'PYEOF'
import json, os, sys
path, a1, p1, a2, p2, k1, k2 = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7]
cfg = json.load(open(path))
routers = cfg.setdefault("routers", [])
if routers:
    routers[0]["admin_user"] = a1
    if p1: routers[0]["admin_pass"] = p1
    if k1: routers[0]["psk"] = k1
if len(routers) > 1:
    routers[1]["admin_user"] = a2
    if p2: routers[1]["admin_pass"] = p2
    if k2: routers[1]["psk"] = k2
open(path, "w").write(json.dumps(cfg, indent=2))
os.chmod(path, 0o600)
print("config updated (mode 600). No secret value was echoed.")
PYEOF

echo "== quick check =="
"$PY" "$(dirname "$CFG")/dispatcher/dispatch.py" --config "$CFG" --verify-only 2>/dev/null \
  | "$PY" -c "import json,sys
try:
    d=json.load(sys.stdin); print('verify online:', d['data']['online'])
except Exception: print('verify: (could not parse)')"
