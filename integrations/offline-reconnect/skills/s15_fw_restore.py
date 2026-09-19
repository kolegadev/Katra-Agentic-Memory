"""s15: roll back the WiFi firmware to the newest s14 snapshot.

Writes the chosen snapshot path to <state_dir>/restore-target, then invokes
the fixed root wrapper /usr/local/sbin/net-agent-fw-restore.sh (no args),
which restores /lib/firmware, updates initramfs and reloads the driver.
The LLM only selects the skill; all file work happens in the wrapper.
"""
import os

from skills.base import Ctx, skill


def _snap_root(ctx: Ctx) -> str:
    return os.path.join(ctx.config.get("state_dir", "/var/lib/net-agent"),
                        "fw-backup")


def _newest_snapshot(ctx: Ctx) -> str | None:
    root = _snap_root(ctx)
    try:
        snaps = sorted(d for d in os.listdir(root)
                       if d.startswith("snap-") and
                       os.path.isdir(os.path.join(root, d)))
    except OSError:
        return None
    return os.path.join(root, snaps[-1]) if snaps else None


@skill("s15_fw_restore",
       when="a firmware update broke wifi (no SSIDs visible, module fails to load, radio dead) — roll back to the pre-update snapshot",
       effect="restore the newest fw snapshot via /usr/local/sbin/net-agent-fw-restore.sh and reload the driver",
       risk="mutating", needs_root=True)
def run(ctx: Ctx) -> dict:
    snap = _newest_snapshot(ctx)
    if not snap:
        return ctx.result("failed",
                          evidence="no snapshots under %s — run s14 before updating"
                                   % _snap_root(ctx))
    target_file = os.path.join(ctx.config.get("state_dir", "/var/lib/net-agent"),
                               "restore-target")
    ctx.file_write(target_file, snap)
    r = ctx.run(["/usr/local/sbin/net-agent-fw-restore.sh"],
                timeout=600, mutating=True, elevated=True)
    if r["rc"] != 0:
        return ctx.result("failed",
                          evidence="restore wrapper rc=%s: %s"
                                   % (r["rc"], (r["err"] or r["out"])[:160]),
                          changed=True)
    return ctx.result("ok",
                      evidence="firmware restored from %s and driver reloaded"
                               % snap, changed=True)
