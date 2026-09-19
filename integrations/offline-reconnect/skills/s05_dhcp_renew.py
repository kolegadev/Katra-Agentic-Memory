"""s05: renew the DHCP lease on the wifi interface.

Primary: `nmcli device reapply` (NetworkManager's own DHCP).
Fallback (requires isc-dhcp-client): an independent dhclient run — the
interface is briefly set unmanaged so NM and dhclient don't fight, then
returned to managed regardless of outcome.
"""
from skills.base import Ctx, skill


@skill("s05_dhcp_renew",
       when="wifi associated but no IPv4 address / stale lease (169.254 or none)",
       effect="nmcli device reapply; fallback: unmanage → dhclient → re-manage",
       risk="mutating", needs_root=True)
def run(ctx: Ctx) -> dict:
    iface = ctx.config.get("iface", "wlp3s0")
    r = ctx.run(["nmcli", "device", "reapply", iface], timeout=30,
                mutating=True, elevated=True)
    if r["rc"] == 0:
        v = ctx.run(["ip", "-4", "-o", "addr", "show", "dev", iface], timeout=10)
        if " inet " in v["out"]:
            return ctx.result("ok", evidence="lease renewed via nmcli reapply",
                              changed=True)
    # independent DHCP fallback: keep NM out of the way for the transaction
    ctx.run(["nmcli", "device", "set", iface, "managed", "no"], timeout=20,
            mutating=True, elevated=True)
    d = ctx.run(["dhclient", "-r", iface], timeout=30, mutating=True, elevated=True)
    d2 = ctx.run(["dhclient", iface], timeout=45, mutating=True, elevated=True)
    ctx.run(["nmcli", "device", "set", iface, "managed", "yes"], timeout=20,
            mutating=True, elevated=True)
    if d2["rc"] != 0:
        return ctx.result("failed",
                          evidence="dhclient failed rc=%s: %s"
                                   % (d2["rc"], d2["err"][:120]), changed=True)
    v = ctx.run(["ip", "-4", "-o", "addr", "show", "dev", iface], timeout=10)
    if " inet " not in v["out"]:
        return ctx.result("failed", evidence="dhclient ran but no address assigned",
                          changed=True)
    return ctx.result("ok", evidence="DHCP lease renewed via dhclient", changed=True)
