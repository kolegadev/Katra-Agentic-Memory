#!/usr/bin/env bash
# install.sh — net-agent offline-reconnect toolbox installer.
#
#   USER MODE (no root needed for the toolbox itself):
#     ./install.sh --user                     # config + user watchdog units
#     sudo ./install.sh --grant-user $USER    # ONE-TIME: NOPASSWD allowlist
#
#   ROOT MODE (system-wide, everything as root):
#     sudo ./install.sh --root
#
# Katra/docker itself needs no sudo (docker group) — the grants above are for
# host network commands (rfkill/systemctl/resolvectl/...) that live OUTSIDE
# docker and cannot be done from a container.
set -u

SRC="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:---user}"
case "$MODE" in
  --root) MODE=root ;;
  --user) MODE=user ;;
  --grant-user) MODE=grant ;;
  -h|--help)
    echo "usage: $0 [--user|--root|--grant-user USER]"; exit 0 ;;
  *) echo "unknown mode: $MODE"; exit 1 ;;
esac

install_user() {
  local DEST="$HOME/.config/net-agent"
  echo "== user-mode install → $DEST"
  mkdir -p "$DEST" "$HOME/.local/state/net-agent"
  cp -r "$SRC/skills" "$SRC/dispatcher" "$SRC/watchdog" "$DEST/"
  chmod 700 "$DEST"
  chmod +x "$DEST/watchdog/"*.sh
  if [ ! -f "$DEST/config.json" ]; then
    cp "$SRC/config.example.json" "$DEST/config.json"
    sed -i 's|"state_dir": "/var/lib/net-agent"|"state_dir": "'"$HOME"'/.local/state/net-agent"|' \
      "$DEST/config.json"
    echo "  → edit $DEST/config.json to add router credentials (vault-seeded)"
  fi
  chmod 600 "$DEST/config.json"

  # user watchdog units (like the polymarket bot units)
  mkdir -p "$HOME/.config/systemd/user"
  sed "s|%h|$HOME|g" "$SRC/watchdog/net-watchdog-user.service" > \
    "$HOME/.config/systemd/user/net-watchdog.service"
  cp "$SRC/watchdog/net-watchdog-user.timer" \
    "$HOME/.config/systemd/user/net-watchdog.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now net-watchdog.timer
  systemctl --user start net-watchdog.service

  echo
  echo "== user-mode installed. One-time privilege grant still needed:"
  echo "   sudo $SRC/install.sh --grant-user $USER"
  echo
  echo "== verify:"
  echo "   systemctl --user status net-watchdog.timer"
  echo "   python3 $DEST/dispatcher/dispatch.py --config $DEST/config.json --verify-only"
}

install_root() {
  [ "$(id -u)" -eq 0 ] || { echo "root mode needs sudo: sudo $0 --root"; exit 1; }
  local DEST="/etc/net-agent"
  echo "== root install → $DEST"
  mkdir -p "$DEST" /var/lib/net-agent
  cp -r "$SRC/skills" "$SRC/dispatcher" "$SRC/watchdog" "$DEST/"
  chmod 700 "$DEST"
  chmod +x "$DEST/watchdog/"*.sh
  if [ ! -f "$DEST/config.json" ]; then
    cp "$SRC/config.example.json" "$DEST/config.json"
    echo "  → edit $DEST/config.json to add router credentials (vault-seeded)"
  fi
  chmod 600 "$DEST/config.json"
  K=$(docker exec katra-server sh -c 'echo $KATRA_API_KEY' 2>/dev/null || true)
  [ -n "$K" ] && { echo "$K" > "$DEST/katra.key"; chmod 600 "$DEST/katra.key"; }
  cp "$SRC/watchdog/net-watchdog.service" "$SRC/watchdog/net-watchdog.timer" \
     /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now net-watchdog.timer
  systemctl start net-watchdog.service
  echo "== root install done. Kill switch: sudo touch $DEST/STOP"
}

grant_user() {
  local U="$1"
  [ "$(id -u)" -eq 0 ] || { echo "grant needs sudo: sudo $0 --grant-user $U"; exit 1; }
  id "$U" >/dev/null 2>&1 || { echo "no such user: $U"; exit 1; }
  echo "== installing wrapper scripts to /usr/local/sbin (referenced by the grant)"
  for s in net-agent-wifi-reload.sh net-agent-fw-restore.sh net-agent-boot-previous.sh; do
    install -m 755 "$SRC/install/$s" "/usr/local/sbin/$s" || { echo "install failed: $s"; exit 1; }
  done
  echo "== writing /etc/sudoers.d/net-agent for $U"
  sed "s/__USER__/$U/" "$SRC/install/net-agent-sudoers.in" > /tmp/net-agent-sudoers
  if ! visudo -cf /tmp/net-agent-sudoers; then
    echo "sudoers syntax check FAILED — not installing"; rm -f /tmp/net-agent-sudoers; exit 1
  fi
  install -m 440 -o root -g root /tmp/net-agent-sudoers /etc/sudoers.d/net-agent
  rm -f /tmp/net-agent-sudoers
  echo "== grant installed. Verify: sudo -n -u $U true && echo passwordless-ok"
}

case "$MODE" in
  user) install_user ;;
  root) install_root ;;
  grant) grant_user "${2:-$SUDO_USER}" ;;
esac
