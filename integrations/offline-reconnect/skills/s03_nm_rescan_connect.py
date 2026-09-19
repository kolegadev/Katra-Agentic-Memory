"""s03: rescan and connect to the known home SSIDs from config (vault-seeded).

Tries each configured router SSID in order. Falls back to direct
`nmcli device wifi connect` when the saved profile is unusable.
"""
from skills.base import Ctx, skill


def _scan_ssids(ctx: Ctx) -> list[str]:
    r = ctx.run(["nmcli", "-t", "-f", "SSID", "device", "wifi", "list"],
                timeout=30)
    if r["rc"] != 0:
        return []
    return [line for line in r["out"].splitlines() if line.strip()]


@skill("s03_nm_rescan_connect",
       when="saved profile fails, SSID changed/not visible, or no wifi networks listed",
       effect="nmcli wifi rescan, then connect to each known home SSID from config",
       risk="mutating")
def run(ctx: Ctx) -> dict:
    iface = ctx.config.get("iface", "wlp3s0")
    routers = ctx.config.get("routers", [])
    if not routers:
        return ctx.result("failed", evidence="no routers in config (vault not provisioned)")
    ctx.run(["nmcli", "device", "wifi", "rescan"], timeout=30, mutating=True)
    seen = _scan_ssids(ctx)
    evidence = []
    for rt in routers:
        ssid = rt.get("ssid", "").strip()
        if not ssid:
            continue
        prof = rt.get("nm_profile", "")
        if prof:
            r = ctx.run(["nmcli", "connection", "up", prof], timeout=45, mutating=True)
        else:
            r = ctx.run(["nmcli", "device", "wifi", "connect", ssid,
                         "password", rt.get("psk", "")], timeout=60, mutating=True)
        if r["rc"] == 0:
            return ctx.result("ok", evidence="connected to %s" % ssid,
                              data={"ssid": ssid}, changed=True)
        evidence.append("connect %s rc=%s (%s)" % (ssid, r["rc"],
                                                  (r["err"] or r["out"]).strip()[:100]))
    visible = "visible: %s" % (", ".join(seen[:12]) or "none") if seen else "no scan data"
    return ctx.result("failed", evidence="; ".join(evidence) + " | " + visible,
                      data={"visible_ssids": seen})
