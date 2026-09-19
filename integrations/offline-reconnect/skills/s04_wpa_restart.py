"""s04: restart wpa_supplicant (and NetworkManager) via systemctl.

Use only when wpa_cli shows wedged supplicant state (e.g. association loops).
"""
from skills.base import Ctx, skill


@skill("s04_wpa_restart",
       when="wpa_supplicant wedged: repeated association failures, wpa_cli errors",
       effect="systemctl restart wpa_supplicant, then NetworkManager",
       risk="mutating", needs_root=True)
def run(ctx: Ctx) -> dict:
    r = ctx.run(["systemctl", "restart", "wpa_supplicant"], timeout=60, mutating=True, elevated=True)
    if r["rc"] != 0:
        return ctx.result("failed", evidence="wpa_supplicant restart failed rc=%s" % r["rc"])
    ctx.run(["systemctl", "restart", "NetworkManager"], timeout=60, mutating=True, elevated=True)
    v = ctx.run(["systemctl", "is-active", "wpa_supplicant"], timeout=15)
    active = v["out"].strip()
    if active != "active":
        return ctx.result("failed", evidence="wpa_supplicant state after restart: %s" % active)
    return ctx.result("ok", evidence="wpa_supplicant + NetworkManager restarted",
                      changed=True)
