"""Loop behavior tests with a fake model — verifies the dispatcher contract.

Covers: success exit, mutation budget, invalid picks, STOP file, cumulative
history across runs, and the "loop continues until solved" re-arm semantics
(exit 2 → watchdog re-invokes → eventually exit 0).
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
from helpers import FakeCtx, fail, ok  # noqa: E402
from skills.base import load_all  # noqa: E402

load_all(str(ROOT / "skills"))

SNAP = {"iface": "wlp3s0", "link": "up", "ipv4": None, "gateway": "192.168.1.1",
        "gw_ping": "down", "rfkill_wifi_blocked": False,
        "nm_device_state": "wlp3s0:disconnected", "active_connections": [],
        "wifi_profiles": ["HomeWiFi-prof"], "dns_resolves": False,
        "visible_ssids": ["HomeWiFi"], "dmesg_wifi_tail": []}


def cfg(tmp):
    return {"iface": "wlp3s0", "gateway": "192.168.1.1",
            "routers": [{"ssid": "HomeWiFi", "psk": "x", "nm_profile":
                         "HomeWiFi-prof"}],
            "max_cycles": 4, "mutation_budget": 3, "cycle_sleep_s": 0,
            "model": "fake", "state_dir": str(tmp), "katra_url": ""}


class FakeModel:
    def __init__(self, picks):
        self.picks = list(picks)
        self.asked = 0

    def __call__(self, model, snap, catalog, history, extra_hint=""):
        self.asked += 1
        if self.picks:
            pick = self.picks.pop(0)
            if isinstance(pick, str):
                return pick, "fake pick", "raw"
            return pick
        return "s02_nm_profile_up", "fallback", "raw"


class FakeVerify:
    """Simulates the contract verifier: online after N verifications."""
    def __init__(self, online_after=None):
        self.n = 0
        self.online_after = online_after

    def __call__(self, cfg, ctx):
        self.n += 1
        return self.online_after is not None and self.n >= self.online_after


class TestDispatchLoop(unittest.TestCase):
    def make(self, tmp):
        import skills.base as base
        base.load_all(str(ROOT / "skills"))

    def test_success_on_first_cycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = FakeModel(["s02_nm_profile_up"])
            v = FakeVerify(online_after=2)
            D._verify_now = lambda cfg, ctx: v(cfg, ctx)
            rc = D.run_loop(cfg(tmp), ask_fn=m, collect=lambda c: dict(SNAP),
                            dry_run=True)
            self.assertEqual(rc, 0)
            state = json.loads(Path(tmp, "net-agent-state.json").read_text())
            self.assertEqual(state["consecutive_failures"], 0)
            self.assertEqual(state["history"][-1]["online_after"], True)

    def test_still_offline_exits_2_and_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = FakeModel(["s02_nm_profile_up"] * 10)
            v = FakeVerify(online_after=None)
            D._verify_now = lambda cfg, ctx: v(cfg, ctx)
            rc = D.run_loop(cfg(tmp), ask_fn=m, collect=lambda c: dict(SNAP),
                            dry_run=True)
            self.assertEqual(rc, 2)
            state = json.loads(Path(tmp, "net-agent-state.json").read_text())
            self.assertEqual(state["consecutive_failures"], 1)
            self.assertGreaterEqual(len(state["history"]), 4)

    def test_loop_continues_across_runs_until_solved(self):
        """Watchdog re-arms: run1 fails, run2 (new invocation) succeeds."""
        with tempfile.TemporaryDirectory() as tmp:
            v = FakeVerify(online_after=None)
            D._verify_now = lambda cfg, ctx: v(cfg, ctx)
            rc1 = D.run_loop(cfg(tmp), ask_fn=FakeModel(["s02_nm_profile_up"]),
                             collect=lambda c: dict(SNAP), dry_run=True)
            self.assertEqual(rc1, 2)
            # second invocation sees history + a model that can now win
            v2 = FakeVerify(online_after=2)
            D._verify_now = lambda cfg, ctx: v2(cfg, ctx)
            rc2 = D.run_loop(cfg(tmp), ask_fn=FakeModel(["s07_profile_rebuild"]),
                             collect=lambda c: dict(SNAP), dry_run=True)
            self.assertEqual(rc2, 0)

    def test_invalid_pick_falls_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = FakeModel(["definitely_not_a_skill"])
            v = FakeVerify(online_after=2)
            D._verify_now = lambda cfg, ctx: v(cfg, ctx)
            rc = D.run_loop(cfg(tmp), ask_fn=m, collect=lambda c: dict(SNAP),
                            dry_run=True)
            self.assertEqual(rc, 0)  # fallback skill ran, verify succeeded
            state = json.loads(Path(tmp, "net-agent-state.json").read_text())
            self.assertEqual(state["history"][0]["skill"], "s02_nm_profile_up")

    def test_mutation_budget_stops_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            v = FakeVerify(online_after=None)
            D._verify_now = lambda cfg, ctx: v(cfg, ctx)
            real_ctx = D.Ctx

            def fake_ctx_factory(cfg, dry_run=False, log_path=None,
                                 mutation_budget=None):
                return FakeCtx(cfg, responses={
                    "nmcli -t -f DEVICE,STATE device": ok("wlp3s0:disconnected\n"),
                    "nmcli -t -f NAME,TYPE,DEVICE connection show":
                        ok("HomeWiFi-prof:802-11-wireless:wlp3s0\n")},
                    mutation_budget=mutation_budget)
            D.Ctx = fake_ctx_factory
            try:
                m = FakeModel(["s02_nm_profile_up"] * 10)
                rc = D.run_loop(cfg(tmp), ask_fn=m, collect=lambda c: dict(SNAP),
                                dry_run=False)
            finally:
                D.Ctx = real_ctx
            self.assertEqual(rc, 2)
            state = json.loads(Path(tmp, "net-agent-state.json").read_text())
            # budget 3 → at most 3 mutating skill executions recorded
            self.assertLessEqual(len(state["history"]), 3)

    def test_stop_file_halts(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "STOP").write_text("")
            v = FakeVerify(online_after=None)
            D._verify_now = lambda cfg, ctx: v(cfg, ctx)
            rc = D.run_loop(cfg(tmp), ask_fn=FakeModel([]),
                            collect=lambda c: dict(SNAP), dry_run=True)
            self.assertEqual(rc, 3)

    def test_online_at_start_short_circuits(self):
        with tempfile.TemporaryDirectory() as tmp:
            v = FakeVerify(online_after=1)  # start check consumes 1 → online
            D._verify_now = lambda cfg, ctx: v(cfg, ctx)
            m = FakeModel([])
            rc = D.run_loop(cfg(tmp), ask_fn=m, collect=lambda c: dict(SNAP),
                            dry_run=True)
            self.assertEqual(rc, 0)
            self.assertEqual(m.asked, 0)

    def test_hint_rules(self):
        self.assertIn("s01", D.deterministic_hint({**SNAP, "rfkill_wifi_blocked": True}))
        self.assertIn("s05", D.deterministic_hint({**SNAP, "link": "up",
                                                   "ipv4": None}))
        self.assertIn("s06", D.deterministic_hint({**SNAP, "gw_ping": "up",
                                                   "dns_resolves": False}))
        self.assertIn("s09", D.deterministic_hint({**SNAP, "gw_ping": "up",
                                                   "dns_resolves": True}))


class TestEscalation(unittest.TestCase):
    def test_failed_skill_is_never_retried(self):
        """Drill regression: model stuck on s06 → ladder walks forward."""
        import time
        import skills.s13_wait_monitor as s13
        orig_sleep = s13.time.sleep
        s13.time.sleep = lambda s: None
        with tempfile.TemporaryDirectory() as tmp:
            v = FakeVerify(online_after=None)
            D._verify_now = lambda cfg, ctx: v(cfg, ctx)
            real_ctx = D.Ctx

            def fake_ctx_factory(cfg, dry_run=False, log_path=None,
                                 mutation_budget=None):
                # s06 must FAIL here: resolver probes return failure
                return FakeCtx(cfg, mutation_budget=mutation_budget, responses={
                    "getent hosts one.one.one.one": fail("", "resolver down"),
                    "python3 -c": fail("", "udp query failed")})
            D.Ctx = fake_ctx_factory
            try:
                m = FakeModel(["s06_dns_recover"] * 10)  # stuck model
                rc = D.run_loop(cfg(tmp), ask_fn=m,
                                collect=lambda c: dict(SNAP), dry_run=False)
            finally:
                D.Ctx = real_ctx
            state = json.loads(Path(tmp, "net-agent-state.json").read_text())
            skills = [h["skill"] for h in state["history"]]
            self.assertEqual(skills[0], "s06_dns_recover")
            # after s06 fails once, every subsequent pick escalates forward
            self.assertEqual(skills[1], D.escalate("s06_dns_recover"))
            self.assertNotIn("s06_dns_recover", skills[1:])
            # no skill repeats across the whole run
            self.assertEqual(len(skills), len(set(skills)))
            s13.time.sleep = orig_sleep

    def test_escalate_ladder_wraps(self):
        self.assertEqual(D.escalate("s01_rfkill_recover"), "s02_nm_profile_up")
        self.assertEqual(D.escalate("s13_wait_monitor"), "s01_rfkill_recover")
        self.assertEqual(D.escalate("not_a_skill"), "s01_rfkill_recover")


class TestSnapshotGwPing(unittest.TestCase):
    def test_failing_ping_reads_as_down_not_up(self):
        """Drill root-cause regression: stderr text must not count as 'up'."""
        import subprocess
        import dispatcher.snapshot as S
        real_run = subprocess.run
        calls = []

        def fake_run(cmd, **kw):
            calls.append(cmd)
            if "ping" in cmd:
                return subprocess.CompletedProcess(cmd, 1,
                                                   stdout="",
                                                   stderr="ping: connect: Network is unreachable")
            if "getaddrinfo" in " ".join(cmd):
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="")
            return real_run(cmd, **kw)
        subprocess.run = fake_run
        try:
            snap = S.collect({"iface": "wlp3s0", "gateway": "192.168.1.1"})
        finally:
            subprocess.run = real_run
        self.assertEqual(snap["gw_ping"], "down")


class TestOllamaHistoryRendering(unittest.TestCase):
    def test_history_blocks_failed_skills(self):
        from ollama_client import ask
        # offline (no server) — ask raises, but we only test message building:
        import ollama_client as O
        orig_chat = O._chat
        captured = {}

        def fake_chat(model, messages, timeout=240):
            captured["messages"] = messages
            return {"message": {"tool_calls": [{"function": {
                "name": "pick_skill",
                "arguments": {"name": "s02_nm_profile_up", "why": "x"}}}]}}
        O._chat = fake_chat
        try:
            name, why, raw = O.ask("m", {}, "catalog", [
                {"skill": "s06_dns_recover", "result": "failed"}], "")
        finally:
            O._chat = orig_chat
        self.assertEqual(name, "s02_nm_profile_up")
        user_msgs = "\n".join(m["content"] for m in captured["messages"]
                              if m["role"] == "user")
        self.assertIn("NEVER pick these again", user_msgs)
        self.assertIn("s06_dns_recover", user_msgs)


class TestOllamaParsing(unittest.TestCase):
    def test_extract_native_tool_call(self):
        from ollama_client import _extract_call
        msg = {"tool_calls": [{"function": {"name": "pick_skill",
                "arguments": {"name": "s05_dhcp_renew", "why": "no ip"}}}]}
        name, why = _extract_call(msg)
        self.assertEqual((name, why), ("s05_dhcp_renew", "no ip"))

    def test_extract_json_in_content(self):
        from ollama_client import _extract_call
        msg = {"content": '{"name": "pick_skill", "arguments": '
                          '{"name": "s06_dns_recover", "why": "dns dead"}}'}
        name, why = _extract_call(msg)
        self.assertEqual((name, why), ("s06_dns_recover", "dns dead"))

    def test_garbage_falls_back(self):
        from ollama_client import _extract_call
        self.assertEqual(_extract_call({"content": "no json here"}), (None, None))


if __name__ == "__main__":
    unittest.main()
