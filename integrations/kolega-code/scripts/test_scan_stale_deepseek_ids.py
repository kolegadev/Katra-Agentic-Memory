#!/usr/bin/env python3
"""Stale DeepSeek id scanner — classification, detection and the scan walk.

Run:  python3 integrations/kolega-code/scripts/test_scan_stale_deepseek_ids.py
      (from anywhere; stdlib only, no pytest)

`scan_stale_deepseek_ids.py` inventories stale model-id references under one or
more roots and writes a report to /tmp. This script never scans the live
machine: it exercises

  1. `classify()` against a synthetic path table — CONFIG, the data hints
     (which only match absolute paths, because every hint starts with "/"),
     doc, the .jsonl branch and the code default, plus the precedence order
     CONFIG > data > doc > code
  2. `TOKEN_RE` — which ids it does and does not see (bare `deepseek-v4`,
     `deepseek-` with nothing after it, underscore spellings, greedy tails)
  3. `scan()` over a fixture tree built in a temporary directory, entered so
     the walk yields relative paths: per-token counts, per-class buckets, the
     SKIP_DIRS filter, the TEXT_EXT filter and the MAX_BYTES guard, at the
     exact byte boundaries
  4. the report line format and its 220-character clamp

`main()` is not called (it writes /tmp/stale-models-<host>.txt and takes its
roots from argv); the STALE-vs-current marker it prints is therefore out of
scope here — see the module docstring of the test report.
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCANNER_PATH = HERE / "scan_stale_deepseek_ids.py"

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS  {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


def section(name: str) -> None:
    print(f"\n{name}")


def load_by_path(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write(root: Path, rel: str, text: str, size: int | None = None) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
        if size is not None:
            fh.truncate(size)


def build_fixture(root: Path) -> None:
    write(root, "src/app.py", 'MODEL = "deepseek-v4-pro"\nFALLBACK = "deepseek-flash"\n')
    write(root, "src/multi.py", 'a deepseek-v4-pro b DeepSeek-V4-PRO c deepseek-reasoner\n')
    write(root, "settings.json", '{"model": "deepseek-v4.1-flash"}\n')
    write(root, "docs/readme.md", "we used deepseek-chat before\n")
    write(root, "x/docs/guide.py", 'MODEL = "deepseek-chat"\n')          # doc via the /docs/ hint
    write(root, "x/results/bench.json", '{"model": "deepseek-reasoner"}\n')  # data via the /results/ hint
    write(root, "notes.txt", "no model id here\n")
    write(root, "assets/logo.png", "deepseek-v4-pro\n")                  # non-text extension
    write(root, "node_modules/pkg/index.js", 'x = "deepseek-flash"\n')   # skipped dir
    write(root, ".git/config", "deepseek-chat\n")                        # skipped dir
    write(root, "long/line.py", "deepseek-v4-pro " + "y" * 400 + "\n")   # 220-char clamp
    write(root, "big/exact.py", 'MODEL = "deepseek-v4-pro"\n', size=2_000_000)   # == MAX_BYTES: read
    write(root, "big/over.py", 'MODEL = "deepseek-v4-pro"\n', size=2_000_001)    # > MAX_BYTES: skipped


def scan_fixture(scanner, root: Path):
    detail: list[str] = []
    per_token: Counter = Counter()
    per_class: dict[str, list[str]] = defaultdict(list)
    scanner.scan(str(root), detail, per_token, per_class)
    return detail, per_token, per_class


def main() -> int:
    scanner = load_by_path("scan_stale_deepseek_ids_under_test", SCANNER_PATH)

    # ---- 1: classify() ----------------------------------------------------
    section("1. classify(): the path table")
    expected = {
        # CONFIG — exact basenames and the settings.json substring rule
        "/Users/x/.env": "CONFIG",
        "/etc/settings.json": "CONFIG",
        "/x/.config/Code/User/settings.json": "CONFIG",
        "/x/config.yaml": "CONFIG",
        "/x/.bashrc": "CONFIG",
        "/x/compose.yaml": "CONFIG",
        "/x/loop.env": "CONFIG",
        "/x/wake-env.sh": "CONFIG",
        "/x/crontab": "CONFIG",
        "/x/settings.json.bak": "CONFIG",     # substring rule, not an exact name
        # data hints — every hint is absolute-path shaped
        "/x/results/a.py": "data",
        "/x/data/a.md": "data",               # data wins over the .md rule
        "/x/fixtures/a.ts": "data",
        "/x/exports/a.yaml": "data",
        "/x/logs/run.sh": "data",
        "/tmp/a.py": "data",
        "/x/.ollama/models.json": "data",
        "/x/session.jsonl": "data",           # the .jsonl branch
        # doc
        "/x/docs/a.py": "doc",
        "/x/doc/b.ts": "doc",
        "/x/README.md": "doc",
        "/x/notes.MD": "doc",                 # the rule runs on the lowercased path
        # code — the default
        "/x/src/app.py": "code",
        "/x/Makefile": "code",
        "/x/scan.md5": "code",                # ".md5" is not ".md"
        # documented asymmetries
        "/x/.ENV": "code",                    # CONFIG_NAMES is case-sensitive
        "/x/SETTINGS.JSON": "code",
    }
    for path, want in expected.items():
        got = scanner.classify(path)
        check(f"classify({path!r}) == {want}", got == want, f"got {got!r}")
    check("every data hint is absolute-path shaped, so relative roots never match one",
          all(hint.startswith("/") for hint in scanner.DATA_HINTS), repr(sorted(scanner.DATA_HINTS)))
    check("the .jsonl branch is unreachable from scan() (TEXT_EXT excludes it)",
          ".jsonl" not in scanner.TEXT_EXT)
    check("precedence is CONFIG > data > doc > code",
          scanner.classify("/x/results/settings.json") == "CONFIG"
          and scanner.classify("/x/results/a.md") == "data"
          and scanner.classify("/x/docs/a.py") == "doc"
          and scanner.classify("/x/src/a.py") == "code")

    # ---- 2: TOKEN_RE ------------------------------------------------------
    section("2. TOKEN_RE: which ids are visible")
    check("TARGET is the canonical id", scanner.TARGET == "deepseek-flash", scanner.TARGET)
    check("MACRO case is matched verbatim (callers lowercase it)",
          scanner.TOKEN_RE.findall("DeepSeek-V4-Pro") == ["DeepSeek-V4-Pro"])
    check("two ids on one line are both found",
          scanner.TOKEN_RE.findall('a="deepseek-v4-pro", b="deepseek-flash"')
          == ["deepseek-v4-pro", "deepseek-flash"])
    check("a hyphenated id stays one token",
          scanner.TOKEN_RE.findall("deepseek-v4-flash-vision-exp") == ["deepseek-v4-flash-vision-exp"])
    check("bare version ids are seen (deepseek-v3*, deepseek-r1*)",
          scanner.TOKEN_RE.findall("deepseek-v3 deepseek-r1") == ["deepseek-v3", "deepseek-r1"])
    for spelling in ("deepseek", "deepseek-", "deepseek_v4", "deepseek/"):
        check(f"{spelling!r} is not a token", scanner.TOKEN_RE.findall(spelling) == [
            ], str(scanner.TOKEN_RE.findall(spelling)))
    check("a trailing dot is swallowed into the token (`deepseek-v4-pro.`)",
          scanner.TOKEN_RE.findall("use deepseek-v4-pro.") == ["deepseek-v4-pro."])
    check("a trailing quote stops the token",
          scanner.TOKEN_RE.findall('"deepseek-v4-pro"') == ["deepseek-v4-pro"])

    # ---- 3: the walk ------------------------------------------------------
    section("3. scan() over a fixture tree (never the live machine)")
    check("SKIP_DIRS covers the noise directories",
          {".git", "node_modules", "__pycache__", ".venv", "site-packages"} <= scanner.SKIP_DIRS)
    check("MAX_BYTES is 2 MB", scanner.MAX_BYTES == 2_000_000, str(scanner.MAX_BYTES))

    with tempfile.TemporaryDirectory(prefix="stale-models-fixture-") as tmp:
        tree = Path(tmp) / "tree"
        tree.mkdir()
        build_fixture(tree)
        cwd = os.getcwd()
        os.chdir(tree)  # relative walk: no /tmp/ prefix that would trip a data hint
        try:
            detail, per_token, per_class = scan_fixture(scanner, Path("."))
        finally:
            os.chdir(cwd)

        section("3a. per-token counts")
        check("counts match the fixture exactly",
              dict(per_token) == {
                  "deepseek-v4-pro": 5,   # src/app.py, 2x src/multi.py, big/exact.py, long/line.py
                  "deepseek-flash": 1,    # src/app.py, plus the skipped node_modules copy
                  "deepseek-reasoner": 2,  # src/multi.py, x/results/bench.json
                  "deepseek-v4.1-flash": 1,
                  "deepseek-chat": 2,     # docs/readme.md, x/docs/guide.py (+ the skipped .git copy)
              }, str(dict(per_token)))
        check("the current id is counted too (the regex cannot tell stale from current)",
              per_token[scanner.TARGET] == 1)
        check("nothing from node_modules/ or .git/ was counted",
              not any("node_modules" in ref or ".git/" in ref
                      for refs in per_class.values() for ref in refs))
        check("the >2 MB file was skipped and the exactly-2 MB file was read",
              len([r for r in per_class["code"] if "big/" in r]) == 1,
              str([r for r in per_class["code"] if "big/" in r]))
        check("the non-text extension was skipped", not any("logo" in d for d in detail))
        check("the token-free file was skipped", not any("notes.txt" in d for d in detail))

        section("3b. per-class buckets")
        class_of = {
            "CONFIG": {"settings.json": 1},
            "code": {"src/app.py": 2, "src/multi.py": 3, "big/exact.py": 1, "long/line.py": 1},
            "doc": {"docs/readme.md": 1, "x/docs/guide.py": 1},
            "data": {"x/results/bench.json": 1},
        }
        seen: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for kind, refs in per_class.items():
            for ref in refs:
                path, _line, _tok = ref.rsplit(":", 2)
                seen[kind][path.lstrip("./")] += 1
        check("refs land in the bucket classify() names",
              {k: dict(v) for k, v in seen.items()} == class_of,
              str({k: dict(v) for k, v in seen.items()}))
        check("refs carry the lowercased token", all(
            ref.rsplit(":", 1)[1] == ref.rsplit(":", 1)[1].lower()
            for refs in per_class.values() for ref in refs))
        check("the .md file is doc and the /results/ json is data",
              len(per_class["doc"]) == 2 and len(per_class["data"]) == 1)

        section("3c. detail lines and the 220-character clamp")
        check("one detail line per reference, not per file or per line",
              len(detail) == sum(per_token.values()) == 11, str(len(detail)))
        check("a line with three ids produces three detail lines",
              len([d for d in detail if "src/multi.py" in d]) == 3)
        ref_re = re.compile(r"^\[(CONFIG|code|doc|data)\] \S+:\d+: ")
        check("every detail line is [class] path:line: text",
              all(ref_re.match(d) for d in detail), str(detail[:2]))
        long_lines = [d for d in detail if "long/line.py" in d]
        check("the long line is clamped to 220 characters",
              len(long_lines) == 1
              and len(long_lines[0][ref_re.match(long_lines[0]).end():]) == 220,
              str(len(long_lines[0]) if long_lines else None))

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {', '.join(failures[:10])}"
              + (" ..." if len(failures) > 10 else ""))
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
