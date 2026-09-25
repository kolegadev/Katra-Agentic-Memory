#!/usr/bin/env bash
# Install (or remove) the macOS bridge-guard launchd agent.
#
#   integrations/kolega-code/scripts/install-bridge-guard-macos.sh
#   integrations/kolega-code/scripts/install-bridge-guard-macos.sh --uninstall
#
# WHY THIS EXISTS. The tracked plist is a TEMPLATE carrying placeholders rather
# than one machine's paths: the repo's privacy lint forbids absolute home paths
# and tailnet addresses in tracked files, and the values differ per machine.
# The first hand-install copied the template verbatim and pinned a repo path
# that does not exist on the Mac, so launchd would have failed to exec every 10
# minutes — silently, because the failure looks like "the guard found nothing
# to do". Substitution is the installer's job; hand-editing is the bug.
#
# Values default to this machine: the repo is located from this script's own
# path, and the host/identity come from the bridge config the guard repairs
# (katra-hook.json). Override with --repo-dir / --host / --user-id.
#
# Run it as the user whose session should run the guard (launchd gui domain).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TEMPLATE="${SCRIPT_DIR}/com.kolega.bridge-guard.plist"
LABEL="com.kolega.bridge-guard"
TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"
CONFIG="${HOME}/Library/Application Support/kolega-code/katra-hook.json"
HOST=""
USER_ID=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --user-id) USER_ID="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$UNINSTALL" = "1" ]; then
  launchctl bootout "gui/$(id -u)" "$TARGET" 2>/dev/null || true
  rm -f "$TARGET"
  echo "uninstalled ${LABEL} (agent stopped, ${TARGET} removed)"
  exit 0
fi

[ -f "$TEMPLATE" ] || { echo "template not found: $TEMPLATE" >&2; exit 1; }
[ -x "${REPO_DIR}/integrations/kolega-code/scripts/bridge-guard.sh" ] || {
  echo "bridge-guard.sh not executable under ${REPO_DIR} — pass --repo-dir" >&2; exit 1
}

# Default the connection values from the bridge config the guard repairs.
if [ -z "$HOST" ] || [ -z "$USER_ID" ]; then
  if [ -f "$CONFIG" ]; then
    CONFIG_VALUES="$(python3 - "$CONFIG" <<'PY'
import json, sys, urllib.parse
try:
    cfg = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit
url = str(cfg.get("mcp_url") or "")
host = urllib.parse.urlparse(url).hostname or ""
print(host)
print(cfg.get("user_id") or "")
PY
)"
    [ -z "$HOST" ] && HOST="$(printf '%s' "$CONFIG_VALUES" | sed -n 1p)"
    [ -z "$USER_ID" ] && USER_ID="$(printf '%s' "$CONFIG_VALUES" | sed -n 2p)"
  fi
fi
[ -n "$HOST" ] || { echo "no host — pass --host or set KATRA_HOST" >&2; exit 1; }
[ -n "$USER_ID" ] || { echo "no identity — pass --user-id or set KATRA_USER_ID" >&2; exit 1; }

mkdir -p "$(dirname "$TARGET")"
sed -e "s|__REPO_DIR__|${REPO_DIR}|g" \
    -e "s|__KATRA_HOST__|${HOST}|g" \
    -e "s|__KATRA_USER_ID__|${USER_ID}|g" \
    -e "s|__USER_BIN__|${HOME}/.local/bin|g" \
    "$TEMPLATE" > "$TARGET"

launchctl bootout "gui/$(id -u)" "$TARGET" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl print "gui/$(id -u)/${LABEL}" >/dev/null

echo "installed ${LABEL}"
echo "  repo    : ${REPO_DIR}"
echo "  host    : ${HOST}"
echo "  identity: ${USER_ID}"
echo "  plist   : ${TARGET} (substituted from the tracked template)"
echo "  status  : $(launchctl print "gui/$(id -u)/${LABEL}" | grep -E '^\s+state' | head -1 | tr -s ' ')"
