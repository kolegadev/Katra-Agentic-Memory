"""Tests for the firmware update/rollback skills (s14-s17) and fixed s10.

Fully mocked: FakeCtx returns canned outputs; no real commands run.
"""
import os
import tempfile
import unittest
from unittest import mock

import helpers
from helpers import FakeCtx, as_root, ok, fail
from skills.base import run_skill
from skills import s14_fw_snapshot as s14
from skills import s15_fw_restore as s15
from skills import s16_fw_status as s16
from skills import s17_boot_previous_kernel as s17
from skills import s10_driver_reload as s10


class _RootCase(unittest.TestCase):
    def setUp(self):
        self._r = as_root()
        self._r.__enter__()

    def tearDown(self):
        self._r.__exit__(None, None, None)


class TestFwSnapshot(_RootCase):
    def test_snapshots_firmware_files(self):
        files = ["iwlwifi-ty-a0-gf-a0-86.ucode.zst",
                 "iwlwifi-ty-a0-gf-a0-89.ucode.zst",
                 "iwlwifi-ty-a0-gf-a0.pnvm.zst"]
        with mock.patch.object(s14, "_fw_files", return_value=files):
            ctx = FakeCtx(config={"state_dir": "/tmp/na"}, responses={
                "mkdir -p /tmp/na/fw-backup/snap-": ok(),
                "cp -a /lib/firmware/iwlwifi-ty-a0-gf-a0": ok(),
                "sha256sum /lib/firmware/iwlwifi-ty-a0-gf-a0":
                    ok("a1  x\nb2  y\nc3  z\n"),
                "uname -r": ok("6.8.0-139-generic\n"),
            })
            r = run_skill("s14_fw_snapshot", ctx)
            self.assertEqual(r["status"], "ok")
            self.assertTrue(any(c[0] == "write" for c in ctx.calls))
            # mkdir + cp + metadata write = 3 mutations, within budget
            self.assertEqual(ctx.mutations, 3)

    def test_fails_without_firmware_files(self):
        with mock.patch.object(s14, "_fw_files", return_value=[]):
            ctx = FakeCtx(config={"state_dir": "/tmp/na"})
            r = run_skill("s14_fw_snapshot", ctx)
            self.assertEqual(r["status"], "failed")


class TestFwRestore(_RootCase):
    def test_fails_without_snapshot(self):
        with mock.patch.object(s15, "_newest_snapshot", return_value=None):
            ctx = FakeCtx(config={"state_dir": "/tmp/na"})
            r = run_skill("s15_fw_restore", ctx)
            self.assertEqual(r["status"], "failed")
            self.assertIn("no snapshots", r["evidence"])

    def test_restores_newest_snapshot(self):
        with mock.patch.object(s15, "_newest_snapshot",
                               return_value="/tmp/na/fw-backup/snap-1"):
            ctx = FakeCtx(config={"state_dir": "/tmp/na"}, responses={
                "/usr/local/sbin/net-agent-fw-restore.sh": ok()})
            r = run_skill("s15_fw_restore", ctx)
            self.assertEqual(r["status"], "ok")
            # restore-target file written, wrapper invoked elevated
            writes = [c for c in ctx.calls if c[0] == "write"]
            self.assertEqual(writes[0][1], "/tmp/na/restore-target")
            self.assertIn(["sudo", "-n", "/usr/local/sbin/net-agent-fw-restore.sh"],
                          ctx.calls)

    def test_reports_wrapper_failure(self):
        with mock.patch.object(s15, "_newest_snapshot",
                               return_value="/tmp/na/fw-backup/snap-1"):
            ctx = FakeCtx(config={"state_dir": "/tmp/na"}, responses={
                "/usr/local/sbin/net-agent-fw-restore.sh":
                    fail(err="restore failed")})
            r = run_skill("s15_fw_restore", ctx)
            self.assertEqual(r["status"], "failed")
            self.assertIn("restore failed", r["evidence"])


class TestFwStatus(_RootCase):
    def test_reports_loaded_disk_and_snapshots(self):
        with tempfile.TemporaryDirectory() as td:
            os.makedirs(os.path.join(td, "fw-backup", "snap-20260911-100000"))
            with open(os.path.join(td, "restore-target"), "w") as f:
                f.write(os.path.join(td, "fw-backup", "snap-20260911-100000"))
            with mock.patch.object(
                    s16, "_disk_files",
                    return_value=["iwlwifi-ty-a0-gf-a0-86.ucode.zst",
                                  "iwlwifi-ty-a0-gf-a0-89.ucode.zst"]):
                ctx = FakeCtx(config={"state_dir": td, "iface": "wlp3s0"},
                              responses={
                    "uname -r": ok("6.8.0-139-generic\n"),
                    "journalctl -k -b 0 --no-pager":
                        ok("iwlwifi: loaded firmware version 86.fb5c9aeb.0\n"
                           "iwlwifi: loaded PNVM version 581d4936\n"),
                    "nmcli -t -f DEVICE,STATE,CONNECTION device":
                        ok("wlp3s0:connected:netis\n"),
                })
                r = run_skill("s16_fw_status", ctx)
                self.assertEqual(r["status"], "ok")
                self.assertEqual(r["data"]["kernel"], "6.8.0-139-generic")
                self.assertEqual(r["data"]["newest_disk"],
                                 "iwlwifi-ty-a0-gf-a0-89.ucode.zst")
                self.assertEqual(len(r["data"]["snapshots"]), 1)
                self.assertTrue(r["data"]["restore_target"].endswith("snap-20260911-100000"))

    def test_no_snapshots_ok(self):
        with tempfile.TemporaryDirectory() as td:
            ctx = FakeCtx(config={"state_dir": td}, responses={
                "uname -r": ok("6.8.0-139-generic\n"),
                "journalctl -k -b 0 --no-pager": ok(""),
                "nmcli -t -f DEVICE,STATE,CONNECTION device": ok(""),
            })
            r = run_skill("s16_fw_status", ctx)
            self.assertEqual(r["status"], "ok")
            self.assertEqual(r["data"]["snapshots"], [])


class TestBootPrevious(_RootCase):
    def test_invokes_wrapper(self):
        ctx = FakeCtx(responses={
            "/usr/local/sbin/net-agent-boot-previous.sh": ok()})
        r = run_skill("s17_boot_previous_kernel", ctx)
        self.assertEqual(r["status"], "ok")
        self.assertIn(["sudo", "-n", "/usr/local/sbin/net-agent-boot-previous.sh"],
                      ctx.calls)

    def test_reports_refusal(self):
        ctx = FakeCtx(responses={
            "/usr/local/sbin/net-agent-boot-previous.sh":
                fail(err="no grub entry for kernel 6.8.0-138-generic")})
        r = run_skill("s17_boot_previous_kernel", ctx)
        self.assertEqual(r["status"], "failed")
        self.assertIn("no grub entry", r["evidence"])


class TestDriverReload(_RootCase):
    def test_wrapper_success(self):
        ctx = FakeCtx(responses={
            "/usr/local/sbin/net-agent-wifi-reload.sh": ok()})
        r = run_skill("s10_driver_reload", ctx)
        self.assertEqual(r["status"], "ok")
        self.assertIn("/usr/local/sbin/net-agent-wifi-reload.sh",
                      r["evidence"])

    def test_falls_back_to_legacy_when_wrapper_fails(self):
        with mock.patch.object(s10, "_driver_for", return_value="iwlwifi"):
            ctx = FakeCtx(responses={
                "/usr/local/sbin/net-agent-wifi-reload.sh": fail(err="boom"),
                "modprobe -r iwlwifi": ok(),
                "modprobe iwlwifi": ok(),
            })
            r = run_skill("s10_driver_reload", ctx)
            self.assertEqual(r["status"], "ok")
            self.assertIn("legacy", r["evidence"])
            self.assertIn(["sudo", "-n", "modprobe", "iwlwifi"], ctx.calls)

    def test_fails_when_both_paths_fail(self):
        with mock.patch.object(s10, "_driver_for", return_value="iwlwifi"):
            ctx = FakeCtx(responses={
                "/usr/local/sbin/net-agent-wifi-reload.sh": fail(err="boom"),
                "modprobe -r iwlwifi": fail(err="in use"),
                "modprobe iwlwifi": ok(),
            })
            r = run_skill("s10_driver_reload", ctx)
            self.assertEqual(r["status"], "failed")
            self.assertIn("in use", r["evidence"])


if __name__ == "__main__":
    unittest.main()
