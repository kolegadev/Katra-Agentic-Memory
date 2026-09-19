#!/bin/bash
# net-agent: LAST RESORT — one-shot reboot into the previous kernel.
# Fixed no-arg script. Finds the newest non-running kernel in /boot, locates
# its exact GRUB menu entry (including submenu), sets it via grub-reboot and
# reboots. Returns (non-zero) only when the reboot was refused.
set -u

CUR="$(uname -r)"
PREV="$(ls -1 /boot/vmlinuz-* 2>/dev/null | grep -v -- "-$CUR\$" | sort -V | tail -1 | sed 's|/boot/vmlinuz-||')"
[ -n "$PREV" ] || { echo "no previous kernel found in /boot"; exit 1; }

ENTRY="$(python3 - "$PREV" <<'PYEOF'
import re, sys
prev = sys.argv[1]
sub = None
for line in open("/boot/grub/grub.cfg", errors="replace"):
    m = re.search(r"^\s*submenu\s+'([^']+)'", line)
    if m:
        sub = m.group(1); continue
    m = re.search(r"^\s*menuentry\s+'([^']+)'", line)
    if m and prev in m.group(1):
        print((sub + ">" if sub else "") + m.group(1)); break
PYEOF
)"
[ -n "$ENTRY" ] || { echo "no grub entry for kernel $PREV"; exit 2; }

echo "setting one-shot boot: $ENTRY"
grub-reboot "$ENTRY" || { echo "grub-reboot failed"; exit 3; }

echo "rebooting now"
systemctl reboot
exit 0
