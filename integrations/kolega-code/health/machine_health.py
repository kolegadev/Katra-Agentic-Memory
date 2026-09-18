#!/usr/bin/env python3
"""Machine health collector — pushes one tagged health event to Katra per run.

Runs on every team machine via cron (default cadence 15 min). Gathers machine
facts + live checks, computes a status (ok / degraded / down), and POSTs a
single episodic event (event_type "machine_health", tags
[machine-health, health-log]) into the shared scope so the host's reviewer
(health_review.py) and every agent can see it.

Design rules:
- stdlib only; must run with the system python3 (no uv venv needed).
- Fail-silent: a broken check must never crash cron; the failure is *data*
  (recorded in the event), so it lands in the health log instead of a logfile.
- Identity: KATRA_USER_ID env, else derived from ~/.katra/keys/katra-<user>.key,
  else the machine's configured katra-hook.json user_id, else "unknown".
- Auth: KATRA_API_KEY env, else the key file above, else the api_key in the
  local katra-hook.json.

Env:
  KATRA_HOST        Katra REST host (default localhost)
  KATRA_PORT        Katra REST port (default 9012)
  HEALTH_INTERVAL_M interval between runs, minutes (default 15; used by the
                    reviewer's staleness math)
  HEALTH_VERBOSE    when set, print the payload instead of only errors

Usage:
  python3 machine_health.py
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

INTERVAL_MIN = int(os.environ.get("HEALTH_INTERVAL_M", "15"))
KATRA_HOST = os.environ.get("KATRA_HOST", "localhost")
KATRA_PORT = os.environ.get("KATRA_PORT", "9012")
API = f"http://{KATRA_HOST}:{KATRA_PORT}/api/v1"

# Hosts probed every run: package infra (uv/PyPI), tailscale control, and the
# tiktoken BPE download host that bit us on 2026-09-16.
DNS_PROBE_HOSTS = [
    "pypi.org",
    "controlplane.tailscale.com",
    "openaipublic.blob.core.windows.net",
]

KEY_DIR = Path.home() / ".katra" / "keys"


# ── facts ─────────────────────────────────────────────────────────────────

def sh(cmd: list[str], timeout: float = 15.0) -> str:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=timeout)
        return (out.stdout or "").strip()
    except Exception:
        return ""


def machine_facts() -> dict:
    facts: dict = {"hostname": socket.gethostname(), "os": sys.platform}
    uname = platform.uname()
    facts["arch"] = uname.machine
    if sys.platform == "darwin":
        v = sh(["sw_vers", "-productVersion"])
        facts["os_version"] = f"macOS {v}"
    else:
        facts["os_version"] = platform.version().split(" ")[0] if platform.version() else ""
    boot_sec: int | None = None
    if sys.platform == "darwin":
        m = re.search(r"sec = (\d+)", sh(["sysctl", "-n", "kern.boottime"]))
        boot_sec = int(m.group(1)) if m else None
    else:
        try:
            with open("/proc/stat") as f:
                m = re.search(r"^btime (\d+)", f.read(), re.M)
            boot_sec = int(m.group(1)) if m else None
        except OSError:
            pass
    if boot_sec:
        facts["boot_time_utc"] = datetime.fromtimestamp(boot_sec, tz=timezone.utc).isoformat()
        facts["uptime_s"] = int(time.time() - boot_sec)
    else:
        facts["boot_time_utc"] = None
        try:
            with open("/proc/uptime") as f:
                facts["uptime_s"] = int(float(f.read().split()[0]))
        except OSError:
            facts["uptime_s"] = None
    if sys.platform == "darwin":
        load = sh(["sysctl", "-n", "vm.loadavg"]).strip("{}").split()
    else:
        load = sh(["cat", "/proc/loadavg"]).split()[:3]
    facts["load"] = load[:3] if load else None
    return facts


def disk_free_pct() -> float | None:
    try:
        usage = shutil.disk_usage(str(Path.home()))
        return round(usage.free / usage.total * 100, 1)
    except Exception:
        return None


def mem_used_pct() -> float | None:
    try:
        if sys.platform == "darwin":
            out = sh(["vm_stat"])
            page = 4096
            def grab(key: str) -> int:
                m = re.search(rf"{re.escape(key)}:\s+(\d+)", out)
                return int(m.group(1)) * page if m else 0
            used = grab("Pages active") + grab("Pages wired") + grab("Pages speculative")
            total = sum(grab(k) for k in ("Pages free", "Pages active", "Pages inactive",
                                          "Pages speculative", "Pages wired", "Pages purgeable"))
            return round(used / total * 100, 1) if total else None
        with open("/proc/meminfo") as f:
            lines = f.read()
        total = int(re.search(r"MemTotal:\s+(\d+)", lines).group(1))
        avail = int(re.search(r"MemAvailable:\s+(\d+)", lines).group(1))
        return round((1 - avail / total) * 100, 1)
    except Exception:
        return None


def dns_resolvers() -> list[str]:
    if sys.platform == "darwin":
        out = sh(["scutil", "--dns"])
        return re.findall(r"nameserver\[(\d+)\]\s*:\s*([\d.a-fA-F:]+)", out) and \
            [f"{a}:{b}" for a, b in re.findall(r"nameserver\[(\d+)\]\s*:\s*([\d.a-fA-F:]+)", out)][:6]
    out = sh(["cat", "/etc/resolv.conf"])
    return [l.split()[1] for l in out.splitlines()
            if l.startswith("nameserver")][:6]


def dns_probes() -> dict:
    probes: dict = {}
    for host in DNS_PROBE_HOSTS:
        t0 = time.time()
        try:
            socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
            probes[host] = {"ok": True, "ms": round((time.time() - t0) * 1000)}
        except Exception as exc:
            probes[host] = {"ok": False, "error": str(exc)[:120]}
    return probes


def tailscale_state() -> dict:
    ts = shutil.which("tailscale")
    if not ts and sys.platform == "darwin":
        cand = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
        ts = cand if os.path.exists(cand) else None
    if not ts:
        return {"installed": False}
    raw = sh([ts, "status", "--json"], timeout=20)
    if not raw:
        return {"installed": True, "error": "status failed"}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"installed": True, "error": "unparseable status"}
    self_node = data.get("Self") or {}
    return {
        "installed": True,
        "backend_state": data.get("BackendState"),
        "self_online": self_node.get("Online"),
        "peers": len(data.get("Peer", {})),
        "dns": (self_node.get("DNSName") or "").rstrip("."),
    }


def kolega_state() -> dict:
    bin_path = shutil.which("kolega-code")
    if not bin_path:
        cand = Path.home() / ".local" / "bin" / "kolega-code"
        bin_path = str(cand) if cand.exists() else None
    if not bin_path:
        return {"installed": False}
    return {"installed": True, "version": sh([bin_path, "--version"], timeout=20) or "unknown"}


def bridge_state() -> dict:
    state_dir = (Path(os.environ["KOLEGA_CODE_STATE_DIR"]) if os.environ.get("KOLEGA_CODE_STATE_DIR")
                 else (Path.home() / "Library" / "Application Support" / "kolega-code"
                       if sys.platform == "darwin"
                       else Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "kolega-code"))
    cfg = state_dir / "katra-hook.json"
    result: dict = {"config_present": cfg.exists()}
    if cfg.exists():
        try:
            data = json.loads(cfg.read_text())
            result["config_user"] = data.get("user_id")
            result["config_enabled"] = bool(data.get("enabled"))
        except Exception:
            result["config_error"] = "unparseable"
    try:
        with urllib.request.urlopen(f"{API}/health", timeout=5) as resp:
            result["katra_health_ok"] = resp.status == 200
    except Exception as exc:
        result["katra_health_ok"] = False
        result["katra_health_error"] = str(exc)[:120]
    return result


def resolve_identity() -> str:
    env = os.environ.get("KATRA_USER_ID", "").strip()
    if env:
        return env
    # The machine's bridge config IS its identity (katra-hook.json carries
    # the per-machine agent — identities are deployment data).
    state_dir = (Path.home() / "Library" / "Application Support" / "kolega-code"
                 if sys.platform == "darwin"
                 else Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "kolega-code")
    cfg = state_dir / "katra-hook.json"
    if cfg.exists():
        try:
            uid = (json.loads(cfg.read_text()).get("user_id") or "").strip()
            if uid:
                return uid
        except Exception:
            pass
    if KEY_DIR.exists():
        keys = sorted(KEY_DIR.glob("katra-*.key"))
        if keys:
            return keys[0].name[len("katra-"):-len(".key")]
    return "unknown"


def resolve_key() -> str:
    env = os.environ.get("KATRA_API_KEY", "").strip()
    if env:
        return env
    user = resolve_identity()
    key_file = KEY_DIR / f"katra-{user}.key"
    if key_file.exists():
        return key_file.read_text().strip()
    # Katra host machines keep the admin key in the repo .env (the REST API
    # does not accept the MCP key that katra-hook.json carries).
    env_file = Path.home() / "Katra-Agentic-Memory" / ".env"
    if env_file.exists():
        try:
            for line in env_file.read_text().splitlines():
                if line.strip().startswith("KATRA_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        except OSError:
            pass
    state_dir = (Path.home() / "Library" / "Application Support" / "kolega-code"
                 if sys.platform == "darwin"
                 else Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "kolega-code")
    cfg = state_dir / "katra-hook.json"
    if cfg.exists():
        try:
            return (json.loads(cfg.read_text()).get("api_key") or "").strip()
        except Exception:
            pass
    return ""


def compute_status(checks: dict) -> tuple[str, list[str]]:
    reasons: list[str] = []
    dns = checks["dns_probes"]
    failures = [h for h, r in dns.items() if not r.get("ok")]
    ts = checks["tailscale"]
    br = checks["bridge"]
    disk = checks["disk_free_pct"]
    if failures:
        reasons.append(f"dns failures: {', '.join(failures)}")
    if ts.get("installed") and ts.get("backend_state") not in (None, "Running"):
        reasons.append(f"tailscale: {ts.get('backend_state')}")
    if br.get("config_present") is False:
        reasons.append("bridge config missing")
    if br.get("katra_health_ok") is False:
        reasons.append("katra unreachable")
    if disk is not None and disk < 10:
        reasons.append(f"disk free {disk}%")
    if checks.get("kolega", {}).get("installed") is False:
        reasons.append("kolega-code not installed")
    if len(failures) == len(dns) or (ts.get("installed") and ts.get("backend_state") not in (None, "Running")
                                     and failures):
        status = "down"
    elif reasons:
        status = "degraded"
    else:
        status = "ok"
    return status, reasons


def main() -> int:
    checks: dict = {"machine": machine_facts()}
    checks["disk_free_pct"] = disk_free_pct()
    checks["mem_used_pct"] = mem_used_pct()
    checks["dns_resolvers"] = dns_resolvers()
    checks["dns_probes"] = dns_probes()
    checks["tailscale"] = tailscale_state()
    checks["kolega"] = kolega_state()
    checks["bridge"] = bridge_state()
    status, reasons = compute_status(checks)
    checks["_status"] = status
    checks["_reasons"] = reasons

    payload = {
        "user_id": resolve_identity(),
        "session_id": f"health:{checks['machine']['hostname']}",
        "event_type": "machine_health",
        "content": {
            "machine": checks["machine"]["hostname"],
            "collected_at_utc": datetime.now(timezone.utc).isoformat(),
            "checks": checks,
        },
        "metadata": {"tags": ["machine-health", "health-log"],
                     "interval_min": INTERVAL_MIN},
    }

    if os.environ.get("HEALTH_VERBOSE"):
        print(json.dumps(payload, indent=2, default=str))
        return 0

    key = resolve_key()
    if not key:
        print(f"machine_health[{checks['machine']['hostname']}]: no Katra key found — "
              f"status={status} reasons={reasons}", file=sys.stderr)
        return 1
    try:
        req = urllib.request.Request(
            f"{API}/memory/episodic/events",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {key}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read(200)
        ok = json.loads(body or b"{}").get("success")
        if not ok:
            raise RuntimeError(body[:200])
    except Exception as exc:
        print(f"machine_health[{checks['machine']['hostname']}]: POST failed: {exc}",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
