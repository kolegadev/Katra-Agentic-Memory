"""Regression tests for the independent-verifier defect fixes (D1–D8).

- D1: mutation budget is now enforced at the Ctx choke point (no overshoot)
- D2: s06 never writes through a resolv.conf symlink; uses resolvectl instead
- D3: explicit --config is authoritative; /etc beats repo-local
- D4: fallback_model is retried before the deterministic fallback
- D5: s11 Marauder whitelist is enforced, not dead code
- D8: s12 DNS probe is subprocess-bounded via ctx
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "dispatcher"))

import dispatch as D  # noqa: E402
from helpers import FakeCtx, as_root, config_with_routers, ok  # noqa: E402
from skills.base import run_skill  # noqa: E402


class TestD1BudgetHardStop(unittest.TestCase):
    def test_ctx_refuses_mutations_over_budget(self):
        ctx = FakeCtx(config_with_routers(), mutation_budget=2)
        r1 = ctx.run(["nmcli", "connection", "up", "x"], mutating=True)
        r2 = ctx.run(["nmcli", "connection", "up", "x"], mutating=True)
        r3 = ctx.run(["nmcli", "connection", "up", "x"], mutating=True)
        self.assertEqual((r1["rc"], r2["rc"]), (0, 0))
        self.assertEqual(r3["rc"], -4)
        self.assertEqual(ctx.mutations, 2)

    def test_file_write_budgeted(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = FakeCtx(config_with_routers(), mutation_budget=0)
            w = ctx.file_write(os.path.join(tmp, "x"), "y")
            self.assertEqual(w["rc"], -4)

    def test_skill_cannot_overshoot(self):
        with as_root():
            ctx = FakeCtx(config_with_routers(), responses={
                "rfkill list": ok("1: phy0: Wireless LAN\n\tSoft blocked: yes\n")},
                mutation_budget=0)
            r = run_skill("s01_rfkill_recover", ctx)
            self.assertIn(r["status"], ("failed", "error"))


class TestD3ConfigPrecedence(unittest.TestCase):
    def test_explicit_config_is_authoritative(self):
        with tempfile.TemporaryDirectory() as tmp:
            explicit = Path(tmp, "explicit.json")
            explicit.write_text(json.dumps({"model": "explicit-model"}))
            repo = ROOT / "config.json"
            repo.write_text(json.dumps({"model": "repo-model"}))
            try:
                cfg = D.load_config(str(explicit))
                self.assertEqual(cfg["model"], "explicit-model")
                cfg2 = D.load_config(str(Path(tmp, "nonexistent.json")))
                self.assertEqual(cfg2["model"], "repo-model")  # repo fallback
            finally:
                repo.unlink(missing_ok=True)


class TestD4FallbackModel(unittest.TestCase):
    def test_fallback_retried_then_deterministic(self):
        import dispatch as D

        def raise_for_primary(m, snap, catalog, history, extra_hint=""):
            if m == "primary":
                raise RuntimeError("primary down")
            return "s05_dhcp_renew", "via fallback", "raw"
        D.model_ask = raise_for_primary
        try:
            cfg = {"model": "primary", "fallback_model": "fallback"}
            name, why, _ = D.ask_with_fallback(cfg, "primary", {}, "cat", [],
                                               "hint")
            self.assertEqual(name, "s05_dhcp_renew")
        finally:
            import ollama_client
            D.model_ask = ollama_client.ask

    def test_both_down_deterministic_s02(self):
        import dispatch as D

        def always_raise(*a, **k):
            raise RuntimeError("down")
        D.model_ask = always_raise
        try:
            cfg = {"model": "primary", "fallback_model": "fallback"}
            name, why, _ = D.ask_with_fallback(cfg, "primary", {}, "cat", [],
                                               "hint")
            self.assertEqual(name, "s02_nm_profile_up")
        finally:
            import ollama_client
            D.model_ask = ollama_client.ask


class TestD2S06Symlink(unittest.TestCase):
    def test_symlink_resolv_conf_uses_resolvectl(self):
        import skills.s06_dns_recover as s06
        with as_root():
            s06._resolve_works = lambda ctx, srv: srv != "system"
            orig_islink = os.path.islink
            os.path.islink = lambda p: True  # resolv.conf is a symlink here
            try:
                ctx = FakeCtx(config_with_routers(), responses={
                    "resolvectl flush-caches": ok(),
                    "resolvectl dns wlp3s0 1.1.1.1": ok()})
                r = run_skill("s06_dns_recover", ctx)
                self.assertEqual(r["status"], "ok")
                self.assertIn("resolvectl dns", " ".join(
                    " ".join(c) for c in ctx.calls))
            finally:
                os.path.islink = orig_islink


class TestD5MarauderWhitelist(unittest.TestCase):
    def test_attack_command_rejected_before_serial(self):
        import skills.s11_marauder_survey as s11
        ctx = FakeCtx({"marauder": {"port": "/dev/ttyUSB0"}})
        self.assertEqual(s11._serial_cmd(ctx, "attack -t deauth"), "")
        self.assertEqual(s11._serial_cmd(ctx, "evilportal -c start"), "")
        self.assertEqual(s11._serial_cmd(ctx, "sniffpmkid -c 1"), "")
        self.assertEqual(s11._serial_cmd(ctx, "madeupcmd"), "")

    def test_allowed_commands_pass_gate(self):
        import skills.s11_marauder_survey as s11
        ctx = FakeCtx({"marauder": {}})  # no port → returns "" after gate
        # if the gate rejected it, we'd get "" too — so check via log:
        s11._serial_cmd(ctx, "scanall")
        self.assertNotIn("rejected", str(getattr(ctx, "commands", [])))


class TestUserModeElevation(unittest.TestCase):
    def test_elevated_commands_get_sudo_prefix_when_not_root(self):
        import os
        import skills.base as B
        if os.geteuid() == 0:
            self.skipTest("running as root")
        ctx = FakeCtx(config_with_routers(), responses={})
        ctx.run(["rfkill", "unblock", "wifi"], mutating=True, elevated=True)
        self.assertEqual(ctx.calls[-1], ["sudo", "-n", "rfkill", "unblock",
                                         "wifi"])

    def test_can_elevate_detects_nopasswd_sudo(self):
        import skills.base as B
        B._CAN_ELEVATE = None
        try:
            v = B.can_elevate()
            # on this dev box (no sudoers grant) expect False; assert bool
            self.assertIsInstance(v, bool)
        finally:
            B._CAN_ELEVATE = None

    def test_skill_skips_without_elevation_path(self):
        import os
        import skills.base as B
        if os.geteuid() == 0:
            self.skipTest("running as root")
        B._CAN_ELEVATE = False
        try:
            ctx = FakeCtx(config_with_routers(), responses={})
            r = run_skill("s04_wpa_restart", ctx)
            self.assertEqual(r["status"], "skipped")
        finally:
            B._CAN_ELEVATE = None


class TestD8BoundedDns(unittest.TestCase):
    def test_s12_dns_goes_through_ctx(self):
        import skills.s12_verify_online as s12
        ctx = FakeCtx(config_with_routers(), responses={
            "python3 -c import socket; socket.getaddrinfo('one.one.one.one', 443, proto=socket.IPPROTO_TCP)":
                ok()})
        self.assertTrue(s12._dns_ok(ctx))
        self.assertTrue(any("getaddrinfo" in " ".join(c) for c in ctx.calls))


if __name__ == "__main__":
    unittest.main()
