---
name: wifi-firmware-recovery
title: thebrick WiFi Driver & Firmware Recovery (Intel AX210 / iwlwifi)
category: troubleshooting
confidence: 0.95
status: stable
source: hand-built
uses: 0
successes: 0
failures: 0
failure_patterns: []
---

# thebrick WiFi Driver & Firmware Recovery

## Description

Operational playbook for updating and recovering the WiFi stack on thebrick
(Ubuntu 24.04, Intel Wi-Fi 6E AX210 `8086:2725`, driver `iwlwifi`, interface
`wlp3s0`). Covers the 2026-09-11 driver/firmware update and every offline
recovery path. The net-agent watchdog (user timer, 30 s) automatically engages
the local fallback LLM (qwen2.5-coder:7b via Ollama) after two consecutive
failed reachability probes; the LLM only SELECTS pre-built skills — it never
writes commands.

## Current machine state (post-update)

- Kernels installed: GA `6.8.0-139` and HWE `7.0.0-31` (default after update).
- GA 6.8 iwlwifi caps at firmware API 86 (`ty-a0-gf-a0-86`, rev fb5c9aeb).
  The HWE kernel's iwlwifi loads the current `ty-a0-gf-a0-89` (core24.70-49,
  build d2579d43, 2026-08-20) + the current PNVM.
- WiFi profiles: `netis` is PRIMARY (autoconnect-priority 100); `91d2f8` /
  `91D2F8` / `91D2F8 1` are demoted fallbacks (priority -999).
- Firmware snapshots: `~/.local/state/net-agent/fw-backup/snap-*` (s14),
  newest wins; `restore-target` points at the chosen rollback source.
- Root helpers (fixed, no-arg, NOPASSWD via `/etc/sudoers.d/net-agent`):
  - `/usr/local/sbin/net-agent-wifi-reload.sh` — clean module reload
    (unmanage → `iw dev wlp3s0 del` → unload iwlmvm/iwlwifi/mac80211 →
    reload → reconnect). REQUIRED because a bare `modprobe -r iwlwifi`
    fails with "module in use" while the netdev exists.
  - `/usr/local/sbin/net-agent-fw-restore.sh` — restores the snapshot named
    by `~/.local/state/net-agent/restore-target` into `/lib/firmware`,
    keeps the current files in `/lib/firmware/.net-agent-prerestore-*`,
    runs update-initramfs and reloads the driver.
  - `/usr/local/sbin/net-agent-boot-previous.sh` — one-shot `grub-reboot`
    into the newest non-running kernel, then reboot (LAST RESORT).

## Symptoms

- After a firmware/driver update or reboot: no SSIDs visible, `wlp3s0`
  missing, `iwlwifi` load errors in `journalctl -k`, or connected-but-dead
  internet.
- `journalctl -k -b 0 | grep iwlwifi` shows "failed to load firmware",
  "Microcode SW error", or an FSEQ/TLV mismatch.

## Workflow

1. **Assess (read-only).** Run skill `s16_fw_status`: it reports the running
   kernel, the firmware actually loaded, the newest on-disk file, snapshots
   available, and the NM connection state. Also `s12_verify_online` is the
   ONLY authority that may declare recovery complete (gateway + DNS + two
   TCP:443 endpoints).

2. **If the machine is offline, the watchdog is already looping.** The
   dispatcher (`~/.config/net-agent/dispatcher/dispatch.py`) snapshots state
   and asks the local model to pick ONE skill per cycle, max 8 cycles,
   mutation budget 5. Let it work; check
   `~/.local/state/net-agent/` for evidence. A `STOP` file there pauses the
   loop.

3. **Ladder order for connection-level breakage (radio alive):**
   `s01_rfkill_recover` → `s02_nm_profile_up` → `s03_nm_rescan_connect` →
   `s05_dhcp_renew` → `s06_dns_recover` → `s04_wpa_restart`. Verify with
   `s12_verify_online` after each step.

4. **Driver/firmware-level breakage (module failed, radio dead):**
   - `s10_driver_reload` — the wrapper does the clean reload. This also
     picks up a newly installed firmware file without a reboot.
   - If the radio still fails AND a firmware change preceded the outage:
     `s15_fw_restore` — restores the newest `s14` snapshot (the pre-update
     firmware) and reloads. Run `s14_fw_snapshot` BEFORE any future
     firmware change so there is always a rollback point.
   - If a kernel change preceded the outage and the old kernel is still
     installed: `s17_boot_previous_kernel` — one-shot grub-reboot to the
     previous kernel (LAST RESORT; the machine reboots immediately).

5. **Manual equivalents (with root):**
   - `sudo nmcli device connect wlp3s0` (netis wins via priority 100).
   - `sudo /usr/local/sbin/net-agent-wifi-reload.sh`
   - `sudo grub-reboot 'Advanced options for Ubuntu>Ubuntu, with Linux 6.8.0-139-generic' && sudo reboot`
   - Restore by hand: `cp -a` the wanted files from
     `~/.local/state/net-agent/fw-backup/snap-*/` into `/lib/firmware/`,
     `update-initramfs -u -k all`, then reload.

## Escalation

- If the wrapper scripts are missing, `/etc/sudoers.d/net-agent` lacks the
  `net-agent-*.sh` lines, or a firmware file needs replacing by hand: these
  need John's sudo password (`sudo bash install.sh --grant-user johnpellew`
  in `~/Katra-Agentic-Memory/integrations/offline-reconnect/` reinstalls
  grants + wrappers).
- Hard-blocked radio or dead hardware: physical power-cycle + `rfkill list`
  for hard-block state.

## Notes

- Kernel 6.8 (GA) will NOT load API-89 firmware even if it is on disk; the
  HWE kernel is required for the newest ty-a0-gf-a0-89 builds.
- Upstream truth: linux-firmware git, `intel/iwlwifi/iwlwifi-ty-a0-gf-a0-*`
  (files moved from the old `iwlwifi/` path in 2025-08).
- Reboot safety: user linger is ON (14 polymarket bots + watchdog restart
  automatically); all docker containers use `restart=unless-stopped`.
