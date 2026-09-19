"""Shared runtime for net-agent skills.

Skills are deterministic, stdlib-only Python modules. The local LLM never
writes commands: it only *selects* a skill by name. All execution, safety
checks, and evidence collection happen here.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from typing import Any, Callable

MAX_OUTPUT = 4000  # bytes of command output we keep for evidence


class SkillError(Exception):
    pass


class Ctx:
    """Execution context handed to every skill.

    run() is the ONLY way skills may execute commands. Tests replace it with
    a fake so no real command ever runs. The mutation budget is enforced
    HERE — the single choke point — so no skill can overshoot it.
    """

    def __init__(self, config: dict, dry_run: bool = False, log_path: str | None = None,
                 mutation_budget: int | None = None):
        self.config = config
        self.dry_run = dry_run
        self.log_path = log_path
        self.commands: list[dict] = []
        self.mutations: int = 0
        self.mutation_budget = mutation_budget
        self.now = time.time

    def run(self, argv: list[str], *, timeout: float = 20, mutating: bool = False,
            stdin: str | None = None, elevated: bool = False) -> dict:
        """Run one command. Returns {rc, out, err, argv}. Records mutations.

        elevated=True prefixes `sudo -n` when not already root (user-mode
        installs with a NOPASSWD sudoers allowlist)."""
        full = list(argv)
        if elevated and os.geteuid() != 0:
            full = ["sudo", "-n"] + full
        if self.dry_run and mutating:
            return {"rc": -3, "out": "", "err": "dry_run_skipped",
                    "argv": full, "dry_run_skipped": True}
        if mutating and self.mutation_budget is not None and \
                self.mutations >= self.mutation_budget:
            return {"rc": -4, "out": "", "err": "mutation_budget_exhausted",
                    "argv": full}
        self.commands.append({"argv": full, "mutating": mutating,
                              "ts": self.now()})
        if mutating:
            self.mutations += 1
        try:
            p = subprocess.run(
                [str(a) for a in full], capture_output=True, timeout=timeout,
                text=True, input=stdin, errors="replace")
            out, err = p.stdout, p.stderr
            rc = p.returncode
        except subprocess.TimeoutExpired:
            rc, out, err = -1, "", "TIMEOUT after %ss" % timeout
        except FileNotFoundError:
            rc, out, err = -2, "", "command not found: %s" % full[0]
        return {"rc": rc,
                "out": out[:MAX_OUTPUT],
                "err": err[:MAX_OUTPUT],
                "argv": full}

    def file_write(self, path: str, content: str) -> dict:
        """Controlled filesystem mutation, recorded like a command and
        budgeted. Returns a run()-style dict."""
        if self.dry_run:
            return {"rc": -3, "out": "", "err": "dry_run_skipped",
                    "argv": ["write", path], "dry_run_skipped": True}
        if self.mutation_budget is not None and \
                self.mutations >= self.mutation_budget:
            return {"rc": -4, "out": "", "err": "mutation_budget_exhausted",
                    "argv": ["write", path]}
        self.commands.append({"argv": ["write", path], "mutating": True,
                              "ts": self.now()})
        self.mutations += 1
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(content)
            return {"rc": 0, "out": "", "err": "", "argv": ["write", path]}
        except OSError as e:
            return {"rc": -5, "out": "", "err": str(e), "argv": ["write", path]}

    def log(self, msg: str) -> None:
        if self.log_path:
            try:
                with open(self.log_path, "a") as f:
                    f.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
            except OSError:
                pass

    def result(self, status: str, *, evidence: str = "", data: dict | None = None,
               changed: bool = False) -> dict:
        """Standard skill result envelope. status ∈ ok|failed|error|noop|skipped."""
        r: dict[str, Any] = {"status": status, "evidence": evidence,
                             "changed": changed, "commands": len(self.commands),
                             "mutations": self.mutations,
                             "dry_run": self.dry_run}
        if data:
            r["data"] = data
        self.log("RESULT %s: %s" % (status, evidence[:160]))
        return r


# ── skill registry ────────────────────────────────────────────────────────────

SKILLS: dict[str, dict] = {}


def skill(name: str, when: str, effect: str, risk: str,
          needs_root: bool = False) -> Callable:
    """Register a skill. `when` is the one-line trigger the small model reads."""
    def deco(fn: Callable) -> Callable:
        SKILLS[name] = {"name": name, "when": when, "effect": effect,
                        "risk": risk, "needs_root": needs_root, "fn": fn}
        return fn
    return deco


def has_root() -> bool:
    return os.geteuid() == 0


_CAN_ELEVATE: bool | None = None


def can_elevate() -> bool:
    """True if root, or if `sudo -n` works (user-mode with sudoers grant)."""
    global _CAN_ELEVATE
    if has_root():
        return True
    if _CAN_ELEVATE is None:
        try:
            p = subprocess.run(["sudo", "-n", "true"], capture_output=True,
                               timeout=10)
            _CAN_ELEVATE = p.returncode == 0
        except Exception:
            _CAN_ELEVATE = False
    return _CAN_ELEVATE


def require_root(ctx: Ctx) -> dict | None:
    """Privilege gate: skip when neither root nor passwordless sudo."""
    if not can_elevate():
        return ctx.result("skipped",
                          evidence="requires root or NOPASSWD sudo grant")
    return None


def catalog_text(max_per_line: int = 90) -> str:
    """Compact one-line-per-skill catalog for the small model's prompt."""
    lines = []
    for name in sorted(SKILLS):
        s = SKILLS[name]
        risk = "MUT" if s["risk"] == "mutating" else "RO "
        line = "%s [%s] %s" % (name, risk, s["when"])
        lines.append(line[:max_per_line])
    return "\n".join(lines)


def load_all(skills_dir: str) -> None:
    """Import the skills package so the registry fills (idempotent)."""
    import importlib
    for fname in sorted(os.listdir(skills_dir)):
        if not fname.startswith("s") or not fname.endswith(".py"):
            continue
        mod = "skills." + fname[:-3]
        if mod not in sys.modules:
            importlib.import_module(mod)


def run_skill(name: str, ctx: Ctx) -> dict:
    if name not in SKILLS:
        return {"status": "error", "evidence": "unknown skill: %s" % name,
                "changed": False}
    s = SKILLS[name]
    if s["needs_root"]:
        gate = require_root(ctx)
        if gate:
            return gate
    try:
        return s["fn"](ctx)
    except Exception as e:  # a skill must never crash the loop
        return {"status": "error", "evidence": "%s: %s" % (name, e),
                "changed": False, "commands": ctx.commands and len(ctx.commands) or 0}
