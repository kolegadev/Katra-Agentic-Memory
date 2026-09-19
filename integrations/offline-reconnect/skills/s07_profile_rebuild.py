"""s07: rebuild the NetworkManager WiFi profile from config (vault-seeded).

Used when the saved profile is missing or corrupt. Creates a fresh
wpa-psk connection from config.json router entries and brings it up.
"""
from skills.base import Ctx, skill


@skill("s07_profile_rebuild",
       when="saved wifi profile missing/corrupt; nmcli says 'No suitable device' for profiles",
       effect="delete stale profile and recreate from config (SSID+PSK from vault)",
       risk="mutating")
def run(ctx: Ctx) -> dict:
    routers = ctx.config.get("routers", [])
    if not routers:
        return ctx.result("failed", evidence="no routers in config (vault not provisioned)")
    iface = ctx.config.get("iface", "wlp3s0")
    results = []
    for rt in routers:
        ssid, psk = rt.get("ssid", "").strip(), rt.get("psk", "").strip()
        prof = rt.get("nm_profile") or ("net-agent-%s" % ssid)
        if not ssid or not psk:
            results.append("skip %s: missing ssid/psk in config" % ssid or prof)
            continue
        ctx.run(["nmcli", "connection", "delete", prof], timeout=15, mutating=True, elevated=True)
        r = ctx.run(["nmcli", "connection", "add", "type", "wifi", "con-name", prof,
                     "ifname", iface, "ssid", ssid,
                     "wifi-security.key-mgmt", "wpa-psk",
                     "wifi-security.psk", psk], timeout=30, mutating=True, elevated=True)
        if r["rc"] != 0:
            results.append("add %s rc=%s: %s" % (ssid, r["rc"], r["err"][:100]))
            continue
        u = ctx.run(["nmcli", "connection", "up", prof], timeout=45, mutating=True)
        if u["rc"] == 0:
            return ctx.result("ok", evidence="rebuilt profile %s and connected" % ssid,
                              changed=True)
        results.append("up %s rc=%s" % (ssid, u["rc"]))
    return ctx.result("failed", evidence="; ".join(results) or "nothing to do")
