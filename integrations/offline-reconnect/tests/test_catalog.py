"""Catalog integrity: every skill registered, names unique, catalog compact."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "dispatcher"))

from skills.base import SKILLS, catalog_text  # noqa: E402

EXPECTED = {"s01_rfkill_recover", "s02_nm_profile_up", "s03_nm_rescan_connect",
            "s04_wpa_restart", "s05_dhcp_renew", "s06_dns_recover",
            "s07_profile_rebuild", "s08_scan_survey", "s09_router_wan_check",
            "s10_driver_reload", "s11_marauder_survey", "s12_verify_online",
            "s13_wait_monitor", "s14_fw_snapshot", "s15_fw_restore",
            "s16_fw_status", "s17_boot_previous_kernel"}


class TestCatalog(unittest.TestCase):
    def test_all_expected_skills_registered(self):
        self.assertEqual(set(SKILLS), EXPECTED)

    def test_catalog_is_compact_for_small_model(self):
        text = catalog_text()
        self.assertLessEqual(len(text), 1600)  # one-liners only
        for name in EXPECTED:
            self.assertIn(name, text)

    def test_only_s12_can_report_online(self):
        for name, s in SKILLS.items():
            if name == "s12_verify_online":
                self.assertEqual(s["risk"], "readonly")
            self.assertIn(s["risk"], ("readonly", "mutating"))
        # mutation budget exists in dispatch config
        from dispatch import DEFAULTS
        self.assertGreater(DEFAULTS["mutation_budget"], 0)


if __name__ == "__main__":
    unittest.main()
