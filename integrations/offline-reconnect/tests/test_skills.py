"""Unit tests for every skill's decision logic (fully mocked, zero real commands)."""
import unittest

import helpers
from helpers import FakeCtx, as_root, config_with_routers, fail, ok
from skills.base import run_skill


class TestRfkill(unittest.TestCase):
    def setUp(self):
        self._r = as_root()
        self._r.__enter__()

    def tearDown(self):
        self._r.__exit__(None, None, None)

    def test_unblocks_when_blocked(self):
        ctx = FakeCtx(responses={"rfkill list": [
            ok("1: phy0: Wireless LAN\n\tSoft blocked: yes\n\tHard blocked: no\n"),
            ok("1: phy0: Wireless LAN\n\tSoft blocked: no\n\tHard blocked: no\n")]})
        r = run_skill("s01_rfkill_recover", ctx)
        self.assertEqual(r["status"], "ok")
        self.assertTrue(any("unblock" in " ".join(c) for c in ctx.calls))

    def test_noop_when_clear(self):
        ctx = FakeCtx(responses={"rfkill list": ok("1: phy0: Wireless LAN\n\tSoft blocked: no\n")})
        r = run_skill("s01_rfkill_recover", ctx)
        self.assertEqual(r["status"], "noop")

    def test_fails_if_still_blocked(self):
        ctx = FakeCtx(responses={"rfkill list": ok("1: phy0: Wireless LAN\n\tSoft blocked: yes\n")})
        r = run_skill("s01_rfkill_recover", ctx)
        self.assertEqual(r["status"], "failed")


class TestNmProfileUp(unittest.TestCase):
    def test_noop_when_connected(self):
        ctx = FakeCtx(responses={
            "nmcli -t -f DEVICE,STATE device": ok("wlp3s0:connected\n")})
        r = run_skill("s02_nm_profile_up", ctx)
        self.assertEqual(r["status"], "noop")

    def test_ok_when_up_connects(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli -t -f DEVICE,STATE device": ok("wlp3s0:disconnected\n"),
            "nmcli -t -f NAME,TYPE,DEVICE connection show":
                ok("HomeWiFi-prof:802-11-wireless:wlp3s0\n"),
            "nmcli connection up HomeWiFi-prof": ok(),
        })
        # after up: connected
        ctx.responses["nmcli -t -f DEVICE,STATE device"] = ok("wlp3s0:disconnected\n")
        # the skill re-checks state with the same key; simulate change via sequence
        seq = [ok("wlp3s0:disconnected\n"), ok("wlp3s0:connected\n")]
        orig = ctx.run

        def run(argv, **kw):
            if argv == ["nmcli", "-t", "-f", "DEVICE,STATE", "device"]:
                return seq.pop(0) if len(seq) > 1 else seq[0]
            return orig(argv, **kw)
        ctx.run = run
        r = run_skill("s02_nm_profile_up", ctx)
        self.assertEqual(r["status"], "ok")

    def test_failed_without_profile(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli -t -f DEVICE,STATE device": ok("wlp3s0:disconnected\n"),
            "nmcli -t -f NAME,TYPE,DEVICE connection show": ok("Wired:802-3-ethernet:eno1\n")})
        r = run_skill("s02_nm_profile_up", ctx)
        self.assertEqual(r["status"], "failed")
        self.assertIn("s07_profile_rebuild", r["evidence"])


class TestRescanConnect(unittest.TestCase):
    def test_connects_first_router(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli -t -f SSID device wifi list": ok("Neighbour1\nHomeWiFi\n"),
            "nmcli connection up HomeWiFi-prof": ok()})
        r = run_skill("s03_nm_rescan_connect", ctx)
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["data"]["ssid"], "HomeWiFi")

    def test_reports_visible_when_all_fail(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli -t -f SSID device wifi list": ok("Neighbour1\n"),
            "nmcli connection up HomeWiFi-prof": fail("", "secrets required")})
        r = run_skill("s03_nm_rescan_connect", ctx)
        self.assertEqual(r["status"], "failed")
        self.assertIn("Neighbour1", r["evidence"])

    def test_failed_without_config(self):
        ctx = FakeCtx(responses={})
        r = run_skill("s03_nm_rescan_connect", ctx)
        self.assertEqual(r["status"], "failed")


class TestDhcpRenew(unittest.TestCase):
    def setUp(self):
        self._r = as_root()
        self._r.__enter__()

    def tearDown(self):
        self._r.__exit__(None, None, None)

    def test_renew_ok(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli device reapply wlp3s0": ok(),
            "ip -4 -o addr show dev wlp3s0": ok("3: wlp3s0 inet 192.168.1.4/24\n")})
        r = run_skill("s05_dhcp_renew", ctx)
        self.assertEqual(r["status"], "ok")

    def test_dhclient_fallback(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli device reapply wlp3s0": fail(),
            "dhclient -r wlp3s0": ok(),
            "dhclient wlp3s0": ok(),
            "ip -4 -o addr show dev wlp3s0": ok("3: wlp3s0 inet 192.168.1.4/24\n")})
        r = run_skill("s05_dhcp_renew", ctx)
        self.assertEqual(r["status"], "ok")
        # NM is kept out of the transaction and re-managed afterwards
        # (elevated commands carry a sudo -n prefix when run unprivileged)
        joined = [" ".join(c).replace("sudo -n ", "") for c in ctx.calls]
        self.assertIn("nmcli device set wlp3s0 managed no", joined)
        self.assertIn("nmcli device set wlp3s0 managed yes", joined)
        self.assertLess(joined.index("nmcli device set wlp3s0 managed no"),
                        joined.index("dhclient -r wlp3s0"))
        self.assertLess(joined.index("dhclient wlp3s0"),
                        joined.index("nmcli device set wlp3s0 managed yes"))

    def test_no_address_after(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli device reapply wlp3s0": fail(),
            "dhclient -r wlp3s0": ok(),
            "dhclient wlp3s0": ok(),
            "ip -4 -o addr show dev wlp3s0": ok("3: wlp3s0\n")})
        r = run_skill("s05_dhcp_renew", ctx)
        self.assertEqual(r["status"], "failed")
        # interface returned to managed even on failure
        joined = [" ".join(c).replace("sudo -n ", "") for c in ctx.calls]
        self.assertIn("nmcli device set wlp3s0 managed yes", joined)

    def test_dhclient_missing_binary_reports_cleanly(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli device reapply wlp3s0": fail(),
            "dhclient -r wlp3s0": {"rc": -2, "out": "", "err":
                                   "command not found: dhclient", "argv": []},
            "dhclient wlp3s0": {"rc": -2, "out": "", "err":
                                "command not found: dhclient", "argv": []},
            "ip -4 -o addr show dev wlp3s0": ok("3: wlp3s0\n")})
        r = run_skill("s05_dhcp_renew", ctx)
        self.assertEqual(r["status"], "failed")
        self.assertIn("command not found", r["evidence"])


class TestProfileRebuild(unittest.TestCase):
    def test_rebuild_and_connect(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli connection delete HomeWiFi-prof": ok(),
            "nmcli connection add type wifi con-name HomeWiFi-prof ifname wlp3s0 ssid HomeWiFi wifi-security.key-mgmt wpa-psk wifi-security.psk sekret": ok(),
            "nmcli connection up HomeWiFi-prof": ok()})
        r = run_skill("s07_profile_rebuild", ctx)
        self.assertEqual(r["status"], "ok")

    def test_missing_psk_reported(self):
        cfg = config_with_routers()
        cfg["routers"][0]["psk"] = ""
        ctx = FakeCtx(cfg, responses={})
        r = run_skill("s07_profile_rebuild", ctx)
        self.assertEqual(r["status"], "failed")


class TestScanSurvey(unittest.TestCase):
    def test_home_found(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli -t -f SSID,BSSID,CHAN,SIGNAL device wifi list":
                ok("Neighbour1:AA:BB:CC:DD:EE:01:6:55\nHomeWiFi:AA:BB:CC:DD:EE:02:11:80\n")})
        r = run_skill("s08_scan_survey", ctx)
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["data"]["home_found"], ["HomeWiFi"])

    def test_no_networks_diagnosis(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "nmcli -t -f SSID,BSSID,CHAN,SIGNAL device wifi list": ok("")})
        r = run_skill("s08_scan_survey", ctx)
        self.assertIn("driver", r["evidence"])


class TestRouterWanCheck(unittest.TestCase):
    def test_wan_down(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "curl -sk --max-time 10 -u admin:pw http://192.168.1.1/":
                ok("<html>WAN Status: down</html>")})
        r = run_skill("s09_router_wan_check", ctx)
        self.assertEqual(r["data"]["wan"], "down")

    def test_wan_up(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "curl -sk --max-time 10 -u admin:pw http://192.168.1.1/":
                ok("<html>Internet: connected</html>")})
        r = run_skill("s09_router_wan_check", ctx)
        self.assertEqual(r["data"]["wan"], "up")

    def test_wan_unknown_when_page_reveals_nothing(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "curl -sk --max-time 10 -u admin:pw http://192.168.1.1/":
                ok("<html><title>Quick Setup</title><input name=ssid></html>")})
        r = run_skill("s09_router_wan_check", ctx)
        self.assertEqual(r["data"]["wan"], "unknown")

    def test_router_unreachable(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "curl -sk --max-time 10 -u admin:pw http://192.168.1.1/": fail()})
        r = run_skill("s09_router_wan_check", ctx)
        self.assertEqual(r["status"], "failed")

    def test_reachability_without_creds(self):
        cfg = config_with_routers()
        cfg["routers"][0]["admin_user"] = ""
        ctx = FakeCtx(cfg, responses={
            "curl -sk --max-time 10 http://192.168.1.1/":
                ok("<html>login</html>")})
        r = run_skill("s09_router_wan_check", ctx)
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["data"], {"router": "up", "wan": "unknown"})

    def test_unreachable_without_creds(self):
        cfg = config_with_routers()
        cfg["routers"][0]["admin_user"] = ""
        ctx = FakeCtx(cfg, responses={
            "curl -sk --max-time 10 http://192.168.1.1/": fail()})
        r = run_skill("s09_router_wan_check", ctx)
        self.assertEqual(r["status"], "failed")


class TestDriverReload(unittest.TestCase):
    def setUp(self):
        self._r = as_root()
        self._r.__enter__()

    def tearDown(self):
        self._r.__exit__(None, None, None)

    def test_reloads_via_wrapper(self):
        ctx = FakeCtx(config_with_routers(), responses={
            "/usr/local/sbin/net-agent-wifi-reload.sh": ok()})
        r = run_skill("s10_driver_reload", ctx)
        self.assertEqual(r["status"], "ok")

    def test_legacy_fallback_when_wrapper_fails(self):
        import skills.s10_driver_reload as s10
        orig = s10._driver_for
        s10._driver_for = lambda ctx, iface: "iwlwifi"
        try:
            ctx = FakeCtx(config_with_routers(), responses={
                "/usr/local/sbin/net-agent-wifi-reload.sh": fail(err="boom"),
                "modprobe -r iwlwifi": ok(), "modprobe iwlwifi": ok()})
            r = run_skill("s10_driver_reload", ctx)
            self.assertEqual(r["status"], "ok")
            self.assertIn("legacy", r["evidence"])
        finally:
            s10._driver_for = orig

    def test_unknown_driver_fails_after_wrapper_failure(self):
        import skills.s10_driver_reload as s10
        orig = s10._driver_for
        s10._driver_for = lambda ctx, iface: None
        try:
            ctx = FakeCtx(config_with_routers(), responses={
                "/usr/local/sbin/net-agent-wifi-reload.sh": fail(err="boom")})
            r = run_skill("s10_driver_reload", ctx)
            self.assertEqual(r["status"], "failed")
            self.assertIn("identify driver", r["evidence"])
        finally:
            s10._driver_for = orig


class TestMarauder(unittest.TestCase):
    def test_skips_without_port(self):
        ctx = FakeCtx(config_with_routers(), responses={})
        r = run_skill("s11_marauder_survey", ctx)
        self.assertEqual(r["status"], "skipped")


class TestVerifyContract(unittest.TestCase):
    def test_online_requires_all_stages(self):
        import skills.s12_verify_online as s12
        ctx = FakeCtx(config_with_routers(), responses={
            "ping -c 1 -W 2 192.168.1.1": ok("1 received")})
        orig = (s12._gateway_up, s12._dns_ok, s12._tcp_443)
        s12._gateway_up = lambda c: True
        s12._dns_ok = lambda ctx, t=6: True
        s12._tcp_443 = lambda h, t=5: True
        try:
            r = run_skill("s12_verify_online", ctx)
        finally:
            s12._gateway_up, s12._dns_ok, s12._tcp_443 = orig
        self.assertTrue(r["data"]["online"])

    def test_offline_when_dns_down(self):
        import skills.s12_verify_online as s12
        ctx = FakeCtx(config_with_routers())
        orig = (s12._gateway_up, s12._dns_ok, s12._tcp_443)
        s12._gateway_up = lambda c: True
        s12._dns_ok = lambda ctx, t=6: False
        s12._tcp_443 = lambda h, t=5: True
        try:
            r = run_skill("s12_verify_online", ctx)
        finally:
            s12._gateway_up, s12._dns_ok, s12._tcp_443 = orig
        self.assertFalse(r["data"]["online"])


class TestEnvelopes(unittest.TestCase):
    def test_every_skill_returns_envelope(self):
        import time
        import skills.s12_verify_online as s12
        import skills.s13_wait_monitor as s13
        from skills.base import SKILLS
        # hermetic: no real sockets, no real sleeps
        orig = (s12._gateway_up, s12._dns_ok, s12._tcp_443, s13.time.sleep)
        s12._gateway_up = lambda c: True
        s12._dns_ok = lambda ctx, t=6: False
        s12._tcp_443 = lambda h, t=5: False
        s13.time.sleep = lambda s: None
        try:
            for name in SKILLS:
                ctx = FakeCtx(config_with_routers(), responses={
                    "rfkill list": ok("1: phy0: Wireless LAN\n\tSoft blocked: no\n"),
                    "nmcli -t -f DEVICE,STATE device": ok("wlp3s0:connected\n"),
                    "nmcli -t -f SSID,BSSID,CHAN,SIGNAL device wifi list": ok(""),
                    "systemctl restart wpa_supplicant": ok(),
                    "systemctl is-active wpa_supplicant": ok("active"),
                    "resolvectl flush-caches": ok(),
                })
                r = run_skill(name, ctx)
                self.assertIn(r.get("status"), ("ok", "failed", "error", "noop",
                                                "skipped"), name)
                self.assertIsInstance(r.get("evidence", ""), str, name)
        finally:
            s12._gateway_up, s12._dns_ok, s12._tcp_443, s13.time.sleep = orig


if __name__ == "__main__":
    unittest.main()
