"""s02: bring up the saved NetworkManager WiFi profile.

This is the common-case fix and the deterministic fallback when the model's
selection is invalid. The saved profile already holds the PSK, so no vault
access is needed here.
"""
from skills.base import Ctx, skill


def _wifi_profile(ctx: Ctx) -> str | None:
    r = ctx.run(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show"],
                timeout=15)
    if r["rc"] != 0:
        return None
    for line in r["out"].splitlines():
        parts = line.split(":")
        if len(parts) >= 2 and "wireless" in parts[1]:
            return parts[0]
    return None


@skill("s02_nm_profile_up",
       when="wifi interface is up but no active connection / NM profile down",
       effect="nmcli connection up on the saved WiFi profile (PSK already stored)",
       risk="mutating")
def run(ctx: Ctx) -> dict:
    iface = ctx.config.get("iface", "wlp3s0")
    st = ctx.run(["nmcli", "-t", "-f", "DEVICE,STATE", "device"], timeout=15)
    if st["rc"] != 0:
        return ctx.result("error", evidence="nmcli device list failed")
    state = ""
    for line in st["out"].splitlines():
        if line.startswith(iface + ":"):
            state = line.split(":", 1)[1]
    if state == "connected":
        return ctx.result("noop", evidence="%s already connected" % iface)
    prof = _wifi_profile(ctx)
    if not prof:
        return ctx.result("failed",
                          evidence="no saved wifi profile found; try s07_profile_rebuild")
    u = ctx.run(["nmcli", "connection", "up", prof], timeout=45, mutating=True)
    if u["rc"] != 0:
        return ctx.result("failed", evidence="nmcli up failed: %s" % u["err"][:160])
    v = ctx.run(["nmcli", "-t", "-f", "DEVICE,STATE", "device"], timeout=15)
    for line in v["out"].splitlines():
        if line.startswith(iface + ":") and "connected" in line:
            return ctx.result("ok", evidence="profile %s connected on %s" % (prof, iface),
                              changed=True)
    return ctx.result("failed",
                      evidence="profile up ran but %s not yet connected (DHCP may be pending)" % iface,
                      changed=True)
