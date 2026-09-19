"""Deterministic network state snapshot — the small model's only input.

Every probe is timeout-bounded; total collection < ~15s. Pure evidence,
no repairs. The model reads this compact JSON and picks ONE skill.
"""
from __future__ import annotations

import json
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from skills.base import Ctx  # noqa: E402


def _sh(cmd: list, timeout: float = 8) -> str:
    import subprocess
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout, text=True,
                           errors="replace")
        return (p.stdout or p.stderr or "").strip()
    except Exception:
        return ""


def _sh_ok(cmd: list, timeout: float = 8) -> bool:
    """Boolean probe: returncode 0 only. (Do NOT reuse _sh output as truth —
    a failing command's stderr is non-empty and would read as success.)"""
    import subprocess
    try:
        return subprocess.run(cmd, capture_output=True, timeout=timeout,
                              text=True, errors="replace").returncode == 0
    except Exception:
        return False


def _dns_quick() -> bool:
    # bounded via subprocess timeout (glibc getaddrinfo has no timeout)
    try:
        import subprocess
        p = subprocess.run(
            ["python3", "-c", "import socket; "
             "socket.getaddrinfo('one.one.one.one', 443, "
             "proto=socket.IPPROTO_TCP)"],
            capture_output=True, timeout=5)
        return p.returncode == 0
    except Exception:
        return False


def collect(config: dict) -> dict:
    iface = config.get("iface", "wlp3s0")
    gw = config.get("gateway")
    snap: dict = {"iface": iface}

    snap["link"] = _sh(["cat", "/sys/class/net/%s/operstate" % iface], 3) or "unknown"

    ip = _sh(["ip", "-4", "-o", "addr", "show", "dev", iface], 6)
    snap["ipv4"] = ip.split()[3].split("/")[0] if " inet " in ip else None

    routes = _sh(["ip", "route"], 6)
    if not gw:
        for line in routes.splitlines():
            if line.startswith("default "):
                gw = line.split()[2]
                break
    snap["gateway"] = gw or None
    snap["gw_ping"] = "up" if gw and _sh_ok(["ping", "-c", "1", "-W", "2", gw], 6) \
        else "down"

    rf = _sh(["rfkill", "list"], 6)
    cur_wifi, blocked = False, False
    for l in rf.splitlines():
        if l and l[0].isdigit():
            cur_wifi = ("Wireless LAN" in l or "wlan" in l or "phy0" in l)
        elif cur_wifi and "Soft blocked: yes" in l:
            blocked = True
    snap["rfkill_wifi_blocked"] = blocked

    snap["dns_resolves"] = _dns_quick()

    dev_states = _sh(["nmcli", "-t", "-f", "DEVICE,STATE", "device"], 6)
    snap["nm_device_state"] = (dev_states.split("\n")[0] if dev_states else "")
    act = _sh(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show",
               "--active"], 6)
    snap["active_connections"] = act.splitlines()[:5] if act else []

    profs = _sh(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"], 6)
    snap["wifi_profiles"] = [l.split(":")[0] for l in profs.splitlines()
                             if "wireless" in l][:5]

    snap["dns_resolves"] = _dns_quick()

    scan = _sh(["nmcli", "-t", "-f", "SSID,SIGNAL", "device", "wifi", "list",
                "--rescan", "no"], 10)
    snap["visible_ssids"] = [l.split(":")[0] for l in scan.splitlines()
                             if l and ":" in l][:12]

    dm = _sh(["dmesg", "--ctime"], 8)
    wifi_errs = [l for l in dm.splitlines()[-200:]
                 if any(k in l.lower() for k in
                        ("firmware", "wifi", "wlan", "iwlwifi", "mt76", "rtw",
                         "ath", "error", "fail", "crash", "reset"))][-6:]
    snap["dmesg_wifi_tail"] = [l[-160:] for l in wifi_errs]

    return snap


def main() -> int:
    cfg = {"iface": "wlp3s0", "gateway": None}
    snap = collect(cfg)
    print(json.dumps(snap, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
