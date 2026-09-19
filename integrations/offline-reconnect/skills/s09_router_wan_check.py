"""s09: check the router for reachability and WAN status (read-only).

Two credential levels:
  * no admin creds (vault never returns plaintext — by design): plain GET to
    the admin URL; ANY HTTP response proves the router is up, so the loop can
    distinguish 'router down' (keep repairing wifi) from 'router up, internet
    still down' (likely ISP outage → wait-monitor).
  * admin creds in config: authenticated GET, so the page body is parsed for
    an actual WAN state.
Only GET requests to the configured admin URL are made.
"""
import re
from skills.base import Ctx, skill

WAN_UP_PATTERNS = [r"wan.*?(up|connected|online)", r"pppoe.*?(up|connected)",
                   r"internet.*?(up|connected|online)"]
WAN_DOWN_PATTERNS = [r"wan.*?(down|disconnected|offline)",
                     r"pppoe.*?(down|disconnected)", r"internet.*?(down|disconnected)",
                     r"disconnected"]


@skill("s09_router_wan_check",
       when="wifi to router OK (gateway reachable) but internet still down",
       effect="GET router admin page; reachability always, WAN state when creds present",
       risk="readonly")
def run(ctx: Ctx) -> dict:
    rt = (ctx.config.get("routers") or [{}])[0]
    url = rt.get("admin_url") or ctx.config.get("router_admin_url")
    if not url:
        return ctx.result("skipped", evidence="no router admin_url in config")
    cmd = ["curl", "-sk", "--max-time", "10"]
    has_creds = bool(rt.get("admin_user"))
    if has_creds:
        cmd += ["-u", "%s:%s" % (rt["admin_user"], rt.get("admin_pass", ""))]
    cmd += [url]
    r = ctx.run(cmd, timeout=15)
    if r["rc"] != 0:
        return ctx.result("failed",
                          evidence="router admin page unreachable (router down?)")
    if not has_creds:
        return ctx.result("ok",
                          evidence="router reachable; WAN state unknown (no admin "
                                   "creds in config — vault never returns plaintext)",
                          data={"router": "up", "wan": "unknown"})
    body = (r["out"] + r["err"]).lower()
    if any(re.search(p, body) for p in WAN_UP_PATTERNS):
        return ctx.result("ok", evidence="router reachable, WAN reports UP "
                                          "(upstream fault elsewhere)",
                          data={"wan": "up", "router": "up"})
    if any(re.search(p, body) for p in WAN_DOWN_PATTERNS):
        return ctx.result("ok", evidence="router reachable, WAN reports DOWN "
                                          "(ISP outage -> wait-monitor)",
                          data={"wan": "down", "router": "up"})
    return ctx.result("ok",
                      evidence="router reachable but page reveals no WAN state "
                               "(firmware status not parsed; treating as unknown)",
                      data={"wan": "unknown", "router": "up"})
