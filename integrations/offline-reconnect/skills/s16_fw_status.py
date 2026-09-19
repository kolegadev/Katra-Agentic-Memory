"""s16: read-only WiFi firmware status — loaded vs on-disk vs snapshots.

Tells the model which firmware is actually loaded (journalctl), what is on
disk, which snapshots exist for rollback, and the current NM connection.
Pure evidence; never mutates.
"""
import os
import re

from skills.base import Ctx, skill

FW_DIR = "/lib/firmware"
FAMILY = "iwlwifi-ty-a0-gf-a0"


def _disk_files() -> list[str]:
    try:
        return sorted(f for f in os.listdir(FW_DIR) if f.startswith(FAMILY))
    except OSError:
        return []


def _api_suffix(fname: str) -> int:
    m = re.search(r"-(\d+)\.ucode", fname)
    return int(m.group(1)) if m else -1


@skill("s16_fw_status",
       when="to see which wifi firmware is loaded vs on disk, or whether snapshots exist",
       effect="report kernel, loaded firmware, on-disk firmware versions, snapshots, connection (read-only)",
       risk="readonly")
def run(ctx: Ctx) -> dict:
    kern = ctx.run(["uname", "-r"], timeout=10)
    jr = ctx.run(["journalctl", "-k", "-b", "0", "--no-pager"], timeout=30)
    loaded = [l.strip() for l in jr["out"].splitlines()
              if "loaded firmware" in l and "iwlwifi" in l]
    pnvm = [l.strip() for l in jr["out"].splitlines()
            if "loaded PNVM" in l]
    files = _disk_files()
    newest = None
    for f in files:
        if f.endswith(".ucode.zst") and _api_suffix(f) > _api_suffix(newest or ""):
            newest = f
    state = ctx.config.get("state_dir", "/var/lib/net-agent")
    snaps = []
    try:
        root = os.path.join(state, "fw-backup")
        snaps = sorted(d for d in os.listdir(root) if d.startswith("snap-"))
    except OSError:
        pass
    target = ""
    try:
        with open(os.path.join(state, "restore-target")) as f:
            target = f.read().strip()
    except OSError:
        pass
    nm = ctx.run(["nmcli", "-t", "-f", "DEVICE,STATE,CONNECTION", "device"],
                 timeout=10)
    conn = [l for l in nm["out"].splitlines()
            if l.startswith(ctx.config.get("iface", "wlp3s0") + ":")]
    return ctx.result("ok",
                      evidence="kernel=%s loaded=%s newest_disk=%s snapshots=%d"
                               % (kern["out"].strip(), loaded[-1:] or ["?"],
                                  newest or "?", len(snaps)),
                      data={"kernel": kern["out"].strip(),
                            "loaded_firmware": loaded,
                            "loaded_pnvm": pnvm,
                            "disk_files": files,
                            "newest_disk": newest,
                            "snapshots": snaps,
                            "restore_target": target or None,
                            "nm_connection": conn})
