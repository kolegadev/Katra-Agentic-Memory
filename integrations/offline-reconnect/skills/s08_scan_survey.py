"""s08: survey visible WiFi networks (read-only, no monitor mode needed).

Uses nmcli (works unprivileged via NM D-Bus). Output is JSON the dispatcher
feeds back to the model so it can decide whether the home SSIDs exist at all.
"""
import json
from skills.base import Ctx, skill


@skill("s08_scan_survey",
       when="unsure what networks exist: SSID missing, empty scan, or need signal/channel info",
       effect="list visible SSIDs with BSSID, channel, signal (read-only)",
       risk="readonly")
def run(ctx: Ctx) -> dict:
    r = ctx.run(["nmcli", "-t", "-f", "SSID,BSSID,CHAN,SIGNAL", "device", "wifi",
                 "list"], timeout=30)
    if r["rc"] != 0:
        return ctx.result("error", evidence="nmcli wifi list failed: %s" % r["err"][:120])
    aps = []
    for line in r["out"].splitlines():
        parts = line.split(":")
        if len(parts) >= 4 and parts[0]:
            aps.append({"ssid": parts[0], "bssid": parts[1],
                        "chan": parts[2], "signal": parts[3]})
    known = [rt.get("ssid") for rt in ctx.config.get("routers", [])]
    found = [ap for ap in aps if ap["ssid"] in known]
    verdict = ("home networks visible" if found else
               "no home SSID visible (%d other networks)" % len(aps)) if aps else \
              "no networks visible at all (radio/driver suspect -> s10_driver_reload)"
    return ctx.result("ok", evidence=verdict,
                      data={"aps": aps[:40], "home_found": [f["ssid"] for f in found],
                            "total": len(aps)})
