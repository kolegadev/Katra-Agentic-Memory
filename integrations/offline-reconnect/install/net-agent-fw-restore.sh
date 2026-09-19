#!/bin/bash
# net-agent: restore the newest firmware snapshot into /lib/firmware.
# Fixed no-arg script. The snapshot path is read from the restore-target
# file written by the s15 skill in the invoking user's state dir.
set -u
SU="${SUDO_USER:-johnpellew}"
STATE="$(getent passwd "$SU" | cut -d: -f6)/.local/state/net-agent"
TARGET_FILE="$STATE/restore-target"

SRC="$(cat "$TARGET_FILE" 2>/dev/null || true)"
[ -n "$SRC" ] || { echo "no restore-target file at $TARGET_FILE"; exit 1; }
case "$SRC" in
  "$STATE"/fw-backup/snap-*) : ;;
  *) echo "refusing unsafe path: $SRC"; exit 2 ;;
esac
[ -d "$SRC" ] || { echo "snapshot missing: $SRC"; exit 3; }

STAMP="$(date +%Y%m%d-%H%M%S)"
BAK="/lib/firmware/.net-agent-prerestore-$STAMP"
mkdir -p "$BAK" || { echo "cannot create $BAK"; exit 4; }

# 1. back up the CURRENT firmware before overwriting (so even a restore
#    can be undone by hand)
for f in /lib/firmware/iwlwifi-ty-a0-gf-a0*; do
  [ -e "$f" ] || continue
  cp -a "$f" "$BAK"/ || { echo "backup failed: $f"; exit 5; }
done

# 2. restore the snapshot files
for f in "$SRC"/iwlwifi-ty-a0-gf-a0*; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  cp -a "$f" /lib/firmware/ || { echo "restore failed: $f"; exit 6; }
  # when restoring a .zst, drop a stray uncompressed twin so the firmware
  # loader resolves to the restored file
  case "$base" in
    *.zst) rm -f "/lib/firmware/${base%.zst}" ;;
  esac
done

# 3. bake into initramfs (best-effort; a failed initramfs update does not
#    block the live reload)
update-initramfs -u -k all >/dev/null 2>&1 || \
  echo "warning: update-initramfs failed (live reload still proceeds)"

# 4. reload the driver so the restored firmware takes effect now
/usr/local/sbin/net-agent-wifi-reload.sh

echo "restored $SRC (previous files kept in $BAK)"
exit 0
