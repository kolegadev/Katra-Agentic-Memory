"""Test helpers: fake execution context so tests never run real commands."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "skills"))
sys.path.insert(0, str(ROOT / "dispatcher"))

from skills.base import Ctx, SKILLS, load_all  # noqa: E402
import skills.base as _B  # noqa: E402

load_all(str(ROOT / "skills"))


class as_root:
    """Context manager: pretend the suite can elevate (root or NOPASSWD sudo)."""
    def __enter__(self):
        self.orig = _B.can_elevate
        self.orig_cache = _B._CAN_ELEVATE
        _B.can_elevate = lambda: True
        _B._CAN_ELEVATE = True
        return self

    def __exit__(self, *a):
        _B.can_elevate = self.orig
        _B._CAN_ELEVATE = self.orig_cache


class FakeCtx(Ctx):
    """Ctx whose run() returns canned outputs per argv match."""

    def __init__(self, config=None, responses=None, dry_run=False,
                 mutation_budget=None):
        super().__init__(config or {"iface": "wlp3s0", "gateway": None,
                                    "routers": []},
                         dry_run=dry_run, mutation_budget=mutation_budget)
        self.responses = responses or {}
        self.calls = []

    def run(self, argv, timeout=20, mutating=False, stdin=None, elevated=False):
        full = list(argv)
        import os as _os
        if elevated and _os.geteuid() != 0:
            full = ["sudo", "-n"] + full
        self.calls.append(full)
        if mutating and self.dry_run:
            return {"rc": -3, "out": "", "err": "dry_run_skipped",
                    "argv": full, "dry_run_skipped": True}
        if mutating and self.mutation_budget is not None and \
                self.mutations >= self.mutation_budget:
            return {"rc": -4, "out": "", "err": "mutation_budget_exhausted",
                    "argv": full}
        if mutating:
            self.mutations += 1
        key = " ".join(str(a) for a in argv)
        if key in self.responses:
            r = self.responses[key]
            if isinstance(r, list):  # sequential canned outputs
                r = r.pop(0) if len(r) > 1 else r[0]
            return r
        # longest-prefix match for things like nmcli variants
        best = None
        for k, v in self.responses.items():
            if key.startswith(k) and (best is None or len(k) > len(best[0])):
                best = (k, v)
        if best:
            return best[1]
        return {"rc": 0, "out": "", "err": "", "argv": full}

    def file_write(self, path, content):
        self.calls.append(["write", path])
        if self.dry_run:
            return {"rc": -3, "out": "", "err": "dry_run_skipped",
                    "argv": ["write", path], "dry_run_skipped": True}
        if self.mutation_budget is not None and \
                self.mutations >= self.mutation_budget:
            return {"rc": -4, "out": "", "err": "mutation_budget_exhausted",
                    "argv": ["write", path]}
        self.mutations += 1
        return {"rc": 0, "out": "", "err": "", "argv": ["write", path]}


def ok(out=""):
    return {"rc": 0, "out": out, "err": "", "argv": []}


def fail(out="", err="failed"):
    return {"rc": 1, "out": out, "err": err, "argv": []}


def config_with_routers():
    return {"iface": "wlp3s0", "gateway": "192.168.1.1",
            "routers": [{"ssid": "HomeWiFi", "psk": "sekret",
                         "nm_profile": "HomeWiFi-prof", "admin_url":
                         "http://192.168.1.1/", "admin_user": "admin",
                         "admin_pass": "pw"}]}
