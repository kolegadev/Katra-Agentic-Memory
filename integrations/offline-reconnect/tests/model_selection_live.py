"""Real-model skill-selection scenarios (no skill execution, no mutations).

Runs the actual Ollama dispatcher ask() against qwen2.5-coder:7b with
synthetic-but-realistic snapshots. Verifies the small model can ROUTE.
Run: python3 tests/test_model_selection.py [model]
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "dispatcher"))

from skills.base import catalog_text  # noqa: E402
from ollama_client import ask  # noqa: E402
import dispatch as D  # noqa: E402

MODEL = sys.argv[1] if len(sys.argv) > 1 else "qwen2.5-coder:7b"

SCENARIOS = [
    {
        "name": "rfkill soft-block",
        "snap": {"iface": "wlp3s0", "link": "up", "ipv4": None,
                 "gateway": None, "gw_ping": "down",
                 "rfkill_wifi_blocked": True,
                 "nm_device_state": "wlp3s0:unavailable",
                 "active_connections": [], "wifi_profiles": ["netis"],
                 "dns_resolves": False, "visible_ssids": [],
                 "dmesg_wifi_tail": []},
        "expect": {"s01_rfkill_recover"},
    },
    {
        "name": "dhcp lost (associated, no IPv4)",
        "snap": {"iface": "wlp3s0", "link": "up", "ipv4": None,
                 "gateway": None, "gw_ping": "down",
                 "rfkill_wifi_blocked": False,
                 "nm_device_state": "wlp3s0:connected",
                 "active_connections": ["netis:802-11-wireless:wlp3s0"],
                 "wifi_profiles": ["netis"], "dns_resolves": False,
                 "visible_ssids": ["netis"],
                 "dmesg_wifi_tail": []},
        "expect": {"s05_dhcp_renew"},
    },
    {
        "name": "dns dead, gateway fine",
        "snap": {"iface": "wlp3s0", "link": "up", "ipv4": "192.168.1.4",
                 "gateway": "192.168.1.1", "gw_ping": "up",
                 "rfkill_wifi_blocked": False,
                 "nm_device_state": "wlp3s0:connected",
                 "active_connections": ["netis:802-11-wireless:wlp3s0"],
                 "wifi_profiles": ["netis"], "dns_resolves": False,
                 "visible_ssids": ["netis"],
                 "dmesg_wifi_tail": []},
        "expect": {"s06_dns_recover"},
    },
    {
        "name": "LAN ok but no internet (ISP?)",
        "snap": {"iface": "wlp3s0", "link": "up", "ipv4": "192.168.1.4",
                 "gateway": "192.168.1.1", "gw_ping": "up",
                 "rfkill_wifi_blocked": False,
                 "nm_device_state": "wlp3s0:connected",
                 "active_connections": ["netis:802-11-wireless:wlp3s0"],
                 "wifi_profiles": ["netis"], "dns_resolves": True,
                 "visible_ssids": ["netis"],
                 "dmesg_wifi_tail": []},
        "expect": {"s09_router_wan_check", "s13_wait_monitor"},
    },
    {
        "name": "no networks visible (driver suspect)",
        "snap": {"iface": "wlp3s0", "link": "down", "ipv4": None,
                 "gateway": None, "gw_ping": "down",
                 "rfkill_wifi_blocked": False,
                 "nm_device_state": "wlp3s0:disconnected",
                 "active_connections": [], "wifi_profiles": ["netis"],
                 "dns_resolves": False, "visible_ssids": [],
                 "dmesg_wifi_tail": ["iwlwifi firmware error restarting"]},
        "expect": {"s10_driver_reload", "s08_scan_survey"},
    },
]


class TestModelRouting(unittest.TestCase):
    def test_model_routes_scenarios(self):
        catalog = catalog_text()
        ok, total = 0, 0
        misses = []
        for sc in SCENARIOS:
            hint = D.deterministic_hint(sc["snap"])
            name, why, raw = ask(MODEL, sc["snap"], catalog, [],
                                 extra_hint=hint)
            total += 1
            hit = name in sc["expect"]
            ok += hit
            print("\n[%s] hint=%r\n  picked=%s (expect %s) why=%s %s"
                  % (sc["name"], hint, name, sorted(sc["expect"]), why,
                     "PASS" if hit else "MISS"))
            if not hit:
                misses.append(sc["name"])
        print("\n%d/%d scenarios routed correctly (model=%s)" % (ok, total, MODEL))
        self.assertEqual(misses, [])


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
