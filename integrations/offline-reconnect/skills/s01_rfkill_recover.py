"""s01: unblock the WiFi radio if it is soft-blocked (rfkill)."""
from skills.base import Ctx, skill


def _wifi_soft_blocked(out: str) -> bool:
    cur_wifi = False
    for line in out.splitlines():
        if line and line[0].isdigit():
            cur_wifi = ("Wireless LAN" in line or "wlan" in line or "phy0" in line)
        elif cur_wifi and "Soft blocked: yes" in line:
            return True
    return False


@skill("s01_rfkill_recover",
       when="rfkill shows WiFi soft-blocked (Fn-key, toggle glitch)",
       effect="rfkill unblock wifi and re-check",
       risk="mutating", needs_root=True)
def run(ctx: Ctx) -> dict:
    r = ctx.run(["rfkill", "list"], timeout=10)
    if r["rc"] != 0:
        return ctx.result("error", evidence="rfkill list failed: %s" % r["err"][:120])
    if not _wifi_soft_blocked(r["out"]):
        return ctx.result("noop", evidence="WiFi radio is not soft-blocked")
    u = ctx.run(["rfkill", "unblock", "wifi"], timeout=10, mutating=True, elevated=True)
    if u["rc"] != 0:
        return ctx.result("failed", evidence="rfkill unblock failed rc=%s" % u["rc"])
    v = ctx.run(["rfkill", "list"], timeout=10)
    if _wifi_soft_blocked(v["out"]):
        return ctx.result("failed", evidence="radio still soft-blocked after unblock")
    return ctx.result("ok", evidence="WiFi radio unblocked", changed=True)
