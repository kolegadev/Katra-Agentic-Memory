"""s14: snapshot the current WiFi firmware set so s15 can roll back.

Copies every iwlwifi-ty-a0-gf-a0* file (the Intel AX210 firmware family)
from /lib/firmware into <state_dir>/fw-backup/snap-<ts>/ with sha256sums
and a metadata file. Mutations are confined to the user state dir.
"""
import json
import os
import time

from skills.base import Ctx, skill

FW_DIR = "/lib/firmware"
FAMILY = "iwlwifi-ty-a0-gf-a0"  # AX210


def _snap_root(ctx: Ctx) -> str:
    return os.path.join(ctx.config.get("state_dir", "/var/lib/net-agent"),
                        "fw-backup")


def _fw_files() -> list[str]:
    try:
        return sorted(f for f in os.listdir(FW_DIR) if f.startswith(FAMILY))
    except OSError:
        return []


@skill("s14_fw_snapshot",
       when="BEFORE installing a wifi firmware/driver update, so s15 can roll it back",
       effect="copy the iwlwifi-ty firmware files + metadata into fw-backup/snap-<ts> (state dir only)",
       risk="mutating")
def run(ctx: Ctx) -> dict:
    files = _fw_files()
    if not files:
        return ctx.result("failed",
                          evidence="no %s files found under %s" % (FAMILY, FW_DIR))
    snap_root = _snap_root(ctx)
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(snap_root, "snap-%s" % ts)

    r = ctx.run(["mkdir", "-p", dest], timeout=10, mutating=True)
    if r["rc"] != 0:
        return ctx.result("failed", evidence="mkdir failed: %s" % r["err"][:120])

    srcs = [os.path.join(FW_DIR, f) for f in files]
    r = ctx.run(["cp", "-a"] + srcs + [dest], timeout=90, mutating=True)
    if r["rc"] != 0:
        return ctx.result("failed",
                          evidence="cp failed rc=%s: %s" % (r["rc"], r["err"][:120]))

    sums = ctx.run(["sha256sum"] + srcs, timeout=60)
    kern = ctx.run(["uname", "-r"], timeout=10)
    meta = {
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kernel": kern["out"].strip(),
        "firmware_dir": FW_DIR,
        "sha256": {f: (l.split()[0] if l.split() else "?")
                   for f, l in zip(files, sums["out"].splitlines())},
        "files": files,
        "source_sha256_cmd_rc": sums["rc"],
    }
    ctx.file_write(os.path.join(dest, "snapshot.json"),
                   json.dumps(meta, indent=2))
    return ctx.result("ok",
                      evidence="%d firmware files snapshotted to %s"
                               % (len(files), dest),
                      data={"snapshot_dir": dest, "files": files},
                      changed=True)
