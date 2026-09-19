"""s11: out-of-band WiFi survey via ESP32 Marauder over USB serial.

Passive-only. If no Marauder device is configured or reachable, this skill
skips gracefully. Command whitelist is hardcoded: scan/list/sniff only.
"""
from skills.base import Ctx, skill

ALLOWED = {"help", "channel", "stopscan", "scanall", "list", "select", "sigmon",
           "packetcount", "reboot", "sniffbeacon", "sniffprobe"}
FORBIDDEN_PREFIXES = ("attack", "evilportal", "blespam", "spoofat", "sniffpmkid",
                      "ssid -a", "deauth")


def _serial_cmd(ctx: Ctx, cmd: str, timeout: float = 45) -> str:
    # ENFORCED passive-only gate: first token must be whitelisted and the
    # full command must not match any forbidden prefix.
    tokens = cmd.strip().split()
    if not tokens or tokens[0] not in ALLOWED:
        ctx.log("marauder command rejected (not allowed): %s" % cmd)
        return ""
    if cmd.strip().startswith(FORBIDDEN_PREFIXES):
        ctx.log("marauder command rejected (forbidden): %s" % cmd)
        return ""
    # single UART transaction: write line, read until timeout or marker
    import time
    port = ctx.config.get("marauder", {}).get("port")
    if not port:
        return ""
    try:
        import serial
    except ImportError:
        ctx.log("pyserial not installed; s11 disabled")
        return ""
    try:
        s = serial.Serial(port, 115200, timeout=1)
    except Exception as e:
        ctx.log("marauder serial open failed: %s" % e)
        return ""
    try:
        time.sleep(0.2)
        s.reset_input_buffer()
        s.write((cmd + "\n").encode())
        out, deadline = b"", time.time() + timeout
        while time.time() < deadline:
            chunk = s.read(4096)
            if not chunk:
                if out and b"\n" in out:
                    break
                continue
            out += chunk
            if b"OK" in out[-64:] or out.count(b"\n") > 20:
                break
        return out.decode(errors="replace")
    finally:
        s.close()


@skill("s11_marauder_survey",
       when="host radio cannot scan (driver wedge) but ESP32 Marauder is attached",
       effect="scanall + list APs over serial; passive commands only",
       risk="readonly")
def run(ctx: Ctx) -> dict:
    if not ctx.config.get("marauder", {}).get("port"):
        return ctx.result("skipped", evidence="no marauder.port in config")
    raw = _serial_cmd(ctx, "scanall", timeout=60)
    if "scan" not in raw.lower() and not raw.strip():
        return ctx.result("failed", evidence="marauder serial not responding")
    out = _serial_cmd(ctx, "list -a", timeout=30)
    if not out.strip():
        return ctx.result("failed", evidence="marauder returned empty AP list")
    aps = []
    for line in out.splitlines():
        line = line.strip()
        if line and any(c.isdigit() for c in line) and ":" not in line.split()[0][:2] or (
                ":" in line and len(line.split()) >= 3):
            aps.append(line[:80])
    return ctx.result("ok",
                      evidence="marauder survey: %d AP lines" % len(aps),
                      data={"ap_lines": aps[:40]})
