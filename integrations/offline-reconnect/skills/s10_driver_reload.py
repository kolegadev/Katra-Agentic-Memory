"""s10: reload the WiFi driver module (firmware hang recovery).

Primary path: the fixed root wrapper /usr/local/sbin/net-agent-wifi-reload.sh,
which un-manages the interface, deletes the netdev, unloads the full module
stack (iwlmvm/iwlwifi/mac80211) and reloads + reconnects. A bare
`modprobe -r iwlwifi` fails while wlp3s0 exists ("module in use"), so the
wrapper is required for this hardware.

Fallback path (wrapper missing or failed): autodetect the module bound to
the interface via /sys and attempt a plain modprobe -r / modprobe cycle.
"""
import os
from skills.base import Ctx, skill

RELOAD_WRAPPER = "/usr/local/sbin/net-agent-wifi-reload.sh"


def _driver_for(ctx: Ctx, iface: str) -> str | None:
    base = "/sys/class/net/%s/device/driver/module" % iface
    if os.path.islink(base):
        return os.path.basename(os.path.realpath(base))
    r = ctx.run(["ethtool", "-i", iface], timeout=10)
    for line in r["out"].splitlines():
        if line.startswith("driver:"):
            return line.split(":", 1)[1].strip()
    return None


def _legacy_reload(ctx: Ctx, iface: str) -> dict:
    mod = _driver_for(ctx, iface)
    if not mod:
        return {"rc": -9, "err": "could not identify driver module for %s" % iface}
    ctx.run(["nmcli", "device", "disconnect", iface], timeout=20,
            mutating=True, elevated=True)
    r1 = ctx.run(["modprobe", "-r", mod], timeout=30, mutating=True, elevated=True)
    r2 = ctx.run(["modprobe", mod], timeout=30, mutating=True, elevated=True)
    if r1["rc"] != 0 or r2["rc"] != 0:
        return {"rc": -10, "err": "driver reload failed rm=%s ins=%s: %s"
                % (r1["rc"], r2["rc"], (r1["err"] or r2["err"])[:120])}
    return {"rc": 0, "err": ""}


@skill("s10_driver_reload",
       when="no networks visible + dmesg shows firmware errors (e.g. iwlwifi crash), or firmware was changed and must be reloaded",
       effect="clean driver reload via the fixed wrapper (netdev down, full module stack), fallback to plain modprobe cycle",
       risk="mutating", needs_root=True)
def run(ctx: Ctx) -> dict:
    iface = ctx.config.get("iface", "wlp3s0")
    r = ctx.run([RELOAD_WRAPPER], timeout=180, mutating=True, elevated=True)
    if r["rc"] == 0:
        return ctx.result("ok",
                          evidence="driver reloaded via %s" % RELOAD_WRAPPER,
                          changed=True)
    wrapper_err = (r["err"] or r["out"])[:120] or "rc=%s" % r["rc"]
    leg = _legacy_reload(ctx, iface)
    if leg["rc"] == 0:
        return ctx.result("ok",
                          evidence="wrapper failed (%s); legacy modprobe cycle reloaded %s"
                                   % (wrapper_err, _driver_for(ctx, iface)),
                          changed=True)
    return ctx.result("failed",
                      evidence="wrapper failed (%s); legacy failed too: %s"
                               % (wrapper_err, leg["err"]),
                      changed=True)
