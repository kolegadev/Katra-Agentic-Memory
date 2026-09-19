"""s13: wait-and-monitor for cases nothing local can fix (ISP down).

When the router is reachable and WAN is down, the correct action is to stop
mutating the wifi stack, poll periodically, and exit with a status the loop
uses to back off longer. This prevents destructive thrashing during outages.
"""
import time
from skills.base import Ctx, skill


@skill("s13_wait_monitor",
       when="router+WAN confirmed DOWN (ISP outage): nothing local can fix it",
       effect="idle-poll for 60s (verify every 15s), report; loop backs off longer",
       risk="readonly")
def run(ctx: Ctx) -> dict:
    from skills.s12_verify_online import run as verify
    first = verify(ctx)
    if first["data"]["online"]:
        return ctx.result("ok", evidence="internet already back; no wait needed")
    for i in range(3):
        time.sleep(15)
        v = verify(ctx)
        if v["data"]["online"]:
            return ctx.result("ok", evidence="internet restored during wait-monitor "
                                             "(cycle %d)" % (i + 1), changed=True)
    return ctx.result("failed",
                      evidence="still offline after 60s wait; ISP-down mode, "
                               "back off and retry later")
