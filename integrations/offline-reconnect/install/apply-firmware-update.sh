#!/bin/bash
# apply-firmware-update.sh — thebrick WiFi driver+firmware update (2026-09-11).
# RUN AS ROOT, ONCE:  sudo bash install/apply-firmware-update.sh
#
# Does NOT reboot. The operator verifies and reboots at a chosen time.
# Steps:
#   1. apt update + install linux-generic-hwe-24.04 (HWE 7.0 kernel: newer
#      iwlwifi driver that can load API-89 firmware; GA 6.8 caps at API 86)
#      and the split linux-firmware meta-package.
#   2. Fetch the newest Intel AX210 firmware from the upstream linux-firmware
#      repo (ty-a0-gf-a0-89 core24.70-49 build d2579d43 + current PNVM),
#      zstd-compress to Ubuntu convention, install into /lib/firmware with a
#      pre-install backup under /lib/firmware/.net-agent-fw-update-backup/.
#   3. update-initramfs -u -k all.
#   4. Install the net-agent wrapper scripts + sudoers grant (--grant-user).
#
# Rollback (offline-capable, no password needed after the grant):
#   - firmware: skill s15_fw_restore (restores the s14 snapshot + reloads)
#   - kernel:   skill s17_boot_previous_kernel (one-shot grub-reboot to 6.8)
set -eu

USER_TARGET="johnpellew"
UPSTREAM_BASE="https://gitlab.com/kernel-firmware/linux-firmware/-/raw/main/intel/iwlwifi"
FW89="iwlwifi-ty-a0-gf-a0-89.ucode"
PNVM="iwlwifi-ty-a0-gf-a0.pnvm"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== [1/4] apt update + HWE kernel + firmware packages =="
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    linux-generic-hwe-24.04 linux-headers-generic-hwe-24.04 linux-firmware

echo "== [2/4] fetch upstream AX210 firmware =="
curl -fsSL --retry 3 -o "$TMP/$FW89" "$UPSTREAM_BASE/$FW89"
curl -fsSL --retry 3 -o "$TMP/$PNVM" "$UPSTREAM_BASE/$PNVM"
echo "-- verifying build id (expect release/core86:signed_remote:d2579d43)"
strings "$TMP/$FW89" | grep -m1 "release/core" || true
sha256sum "$TMP/$FW89" "$TMP/$PNVM"

BAK="/lib/firmware/.net-agent-fw-update-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BAK"
cp -a /lib/firmware/$FW89.zst "$BAK"/ 2>/dev/null || true
cp -a /lib/firmware/$PNVM.zst "$BAK"/ 2>/dev/null || true
cp -a "$TMP/$FW89" "$TMP/$PNVM" "$BAK"/  # raw upstream copies too

zstd -19 -f -q -o "/lib/firmware/$FW89.zst" "$TMP/$FW89"
zstd -19 -f -q -o "/lib/firmware/$PNVM.zst" "$TMP/$PNVM"
ls -la "/lib/firmware/$FW89.zst" "/lib/firmware/$PNVM.zst"

echo "== [3/4] update-initramfs =="
update-initramfs -u -k all

echo "== [4/4] net-agent wrappers + sudoers grant for $USER_TARGET =="
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INTEGRATION_DIR="$(dirname "$SCRIPT_DIR")"
bash "$INTEGRATION_DIR/install.sh" --grant-user "$USER_TARGET"

echo
echo "== DONE. NOT rebooted. =="
echo "Verify: uname -r stays 6.8 until reboot; apt says hwe kernel installed:"
dpkg -l 'linux-image-7.*' | grep ^ii || true
echo "Then reboot at a chosen moment: systemctl reboot"
echo "Rollback: s15_fw_restore (firmware) / s17_boot_previous_kernel (kernel)."
