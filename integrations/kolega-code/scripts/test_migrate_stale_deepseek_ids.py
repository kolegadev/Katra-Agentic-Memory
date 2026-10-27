#!/usr/bin/env python3
"""Stale DeepSeek id migration — the rewrite rules and the dry-run planner.

Run:  python3 integrations/kolega-code/scripts/test_migrate_stale_deepseek_ids.py
      (from anywhere; stdlib only, no pytest)

`migrate_stale_deepseek_ids.py` rewrites stale model ids to `deepseek-flash` on
an explicit per-machine allowlist, backing every touched file up first. This
script exercises

  1. the token table: the seven retired ids, no duplicates, longest-first, and
     the canonical id itself is not in it
  2. `token_re()` — the right-hand `(?![\\w.-])` guard that keeps a distinct id
     such as `deepseek-v4-flash-0731` from being silently rewritten, the
     case-insensitivity, the escaping of `.`, and the missing left anchor
  3. `migrate_text()` — the id mapping, the counts it reports, the fixtures
     that must stay untouched, idempotence, and the synthetic override that
     `OVERRIDE_TEST_FILES` selects
  4. `main()` in DRY-RUN only, against files this script created in a
     temporary directory: the plan it prints, the exit codes for a missing
     `--files` value and an unknown profile, and proof that a dry run leaves
     the tree byte-identical and writes no backup
  5. the profile tables and the `STAMP`/backup naming convention

`--apply` is never passed and no profile is ever selected (the profiles point
at live files); the harness asserts both before every `main()` call.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
MIGRATOR_PATH = HERE / "migrate_stale_deepseek_ids.py"

TOKEN_RE = re.compile(r"deepseek-[A-Za-z0-9._-]*", re.IGNORECASE)

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


def run_main(module, argv: list[str]) -> tuple[int, str]:
    """Call main() with harness-owned argv. --apply and profiles are refused."""
    assert "--apply" not in argv, "this harness must never apply a migration"
    assert not any(a in module.PROFILES for a in argv), "profiles point at live files"
    assert not any(a.startswith("~") for a in argv), "never touch a home directory"
    out = io.StringIO()
    with mock.patch.object(sys, "argv", [str(MIGRATOR_PATH), *argv]):
        with contextlib.redirect_stdout(out):
            rc = module.main()
    return rc, out.getvalue()


def tree_state(root: Path) -> dict[str, tuple[int, int, str]]:
    state = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            st = path.stat()
            state[str(path.relative_to(root))] = (st.st_size, st.st_mtime_ns, path.read_text(encoding="utf-8"))
    return state


def main() -> int:
    migrator = load_by_path("migrate_stale_deepseek_ids_under_test", MIGRATOR_PATH)

    # ---- 1: the token table ----------------------------------------------
    section("1. STALE_TOKENS: the seven retired ids, longest first")
    check("TARGET is the canonical id", migrator.TARGET == "deepseek-flash", migrator.TARGET)
    check("the canonical id is not in the stale table", migrator.TARGET not in migrator.STALE_TOKENS)
    check("the documented families are exactly what is listed",
          set(migrator.STALE_TOKENS) == {
              "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash", "deepseek-v4-flash",
              "deepseek-v4-pro", "deepseek-reasoner", "deepseek-chat", "deepseek-coder",
          }, str(migrator.STALE_TOKENS))
    check("no duplicates", len(set(migrator.STALE_TOKENS)) == len(migrator.STALE_TOKENS))
    order_violations = [t for i, t in enumerate(migrator.STALE_TOKENS)
                        for earlier in migrator.STALE_TOKENS[:i]
                        if t != earlier and t.startswith(earlier)]
    check("longest-first: no shorter token is listed before a longer one it prefixes",
          order_violations == [], str(order_violations))
    check("the hyphenated vision-exp id is rewritten before its stem",
          migrator.STALE_TOKENS.index("deepseek-v4-flash-vision-exp")
          < migrator.STALE_TOKENS.index("deepseek-v4-flash"))

    # ---- 2: token_re boundaries -------------------------------------------
    section("2. token_re(): where a stale id ends")
    flash = migrator.token_re("deepseek-v4-flash")
    check("a bare id matches", bool(flash.search("deepseek-v4-flash")))
    check("a trailing quote ends the id", bool(flash.search('"deepseek-v4-flash"')))
    check("a trailing comma/paren/slash ends the id",
          all(flash.search(f"deepseek-v4-flash{s}") for s in (",", ")", "/", "\n", " ")))
    check("a digit suffix does not match (-0731 is a distinct id)",
          flash.search("deepseek-v4-flash-0731") is None)
    check("a dot suffix does not match", flash.search("deepseek-v4-flash.vision") is None)
    check("a word character suffix does not match", flash.search("deepseek-v4-flashx") is None)
    check("the longer id is not matched by its stem",
          flash.search("deepseek-v4-flash-vision-exp") is None)
    check("the longer id is matched by its own pattern",
          bool(migrator.token_re("deepseek-v4-flash-vision-exp").search("deepseek-v4-flash-vision-exp")))
    check("case-insensitive", bool(migrator.token_re("deepseek-chat").search("DEEPSEEK-CHAT")))
    dotted = migrator.token_re("deepseek-v4.1-flash")
    check("the dot is escaped, not a wildcard", dotted.search("deepseek-v4X1-flash") is None)
    check("the dotted id itself matches", bool(dotted.search("deepseek-v4.1-flash")))
    check("there is no left anchor: xxdeepseek-chat contains a match "
          "(documented asymmetry)",
          bool(migrator.token_re("deepseek-chat").search("xxdeepseek-chat")))

    # ---- 3: migrate_text ---------------------------------------------------
    section("3. migrate_text(): the rewrite and its plan")
    mixed = ("m1 deepseek-v4-pro m2 deepseek-chat m3 deepseek-reasoner "
             "m4 deepseek-coder m5 deepseek-flash")
    out, counts = migrator.migrate_text(mixed, synthetic=False)
    check("the four stale ids became the canonical id",
          out == ("m1 deepseek-flash m2 deepseek-flash m3 deepseek-flash "
                  "m4 deepseek-flash m5 deepseek-flash"), out)
    check("the canonical id was already correct and is not re-counted",
          "deepseek-flash" not in counts and len(TOKEN_RE.findall(out)) == 5)
    check("counts name each stale token once with its occurrence count",
          counts == {"deepseek-v4-pro": 1, "deepseek-chat": 1, "deepseek-reasoner": 1,
                     "deepseek-coder": 1}, str(counts))
    check("counts is a plain dict with no zero entries",
          type(counts) is dict and all(n > 0 for n in counts.values()))
    check("the plan's total equals the planted stale ids",
          sum(counts.values()) == 4 == len(TOKEN_RE.findall(mixed)) - 1)

    check("the input value is left untouched (dry-run safety at the pure layer)",
          mixed.endswith("m5 deepseek-flash"))
    twice, twice_counts = migrator.migrate_text("deepseek-chat deepseek-chat", synthetic=False)
    check("repeated occurrences are counted per occurrence",
          twice == "deepseek-flash deepseek-flash" and twice_counts == {"deepseek-chat": 2}, twice)
    again, again_counts = migrator.migrate_text(out, synthetic=False)
    check("a migrated text is a fixpoint (re-running changes nothing)",
          again == out and again_counts == {})

    check("json quoting survives",
          migrator.migrate_text('{"model": "deepseek-v4-pro"}', False)[0]
          == '{"model": "deepseek-flash"}')
    multiline = "a: deepseek-chat\nb: deepseek-v4-pro\n"
    migrated_lines, _ = migrator.migrate_text(multiline, synthetic=False)
    check("line structure is preserved",
          migrated_lines == "a: deepseek-flash\nb: deepseek-flash\n", repr(migrated_lines))

    section("3a. ids that must NOT be touched")
    for untouched in ("deepseek-v4-flash-0731", "deepseek-v4.1-flash-0528",
                      "deepseek-v4-pro-0324", "deepseek-v4-flash-vision-exp-2",
                      "deepseek-chat-latest", "deepseek-flash", "deepseek-v4X1-flash"):
        text, tally = migrator.migrate_text(untouched, synthetic=False)
        check(f"{untouched!r} is left alone", text == untouched and tally == {}, str(tally))

    section("3b. the synthetic override (OVERRIDE_TEST_FILES)")
    vision = "model=deepseek-v4-flash-vision-exp fallback=deepseek-v4-pro"
    canonical, canonical_counts = migrator.migrate_text(vision, synthetic=False)
    check("without the override the vision-exp id becomes the canonical id",
          canonical == "model=deepseek-flash fallback=deepseek-flash", canonical)
    check("its count is keyed by the stale id, not the replacement",
          canonical_counts == {"deepseek-v4-flash-vision-exp": 1, "deepseek-v4-pro": 1},
          str(canonical_counts))
    synthetic, synthetic_counts = migrator.migrate_text(vision, synthetic=True)
    check("with the override only that id becomes test-override-model",
          synthetic == "model=test-override-model fallback=deepseek-flash", synthetic)
    check("the override does not change the reported keys",
          set(synthetic_counts) == set(canonical_counts) == {"deepseek-v4-flash-vision-exp",
                                                             "deepseek-v4-pro"})
    check("the override is inert for every other stale id",
          migrator.migrate_text("deepseek-v4.1-flash deepseek-chat", True)[0]
          == "deepseek-flash deepseek-flash")
    check("a test file keeps a real retired alias available as a subject",
          migrator.migrate_text(vision, True)[0] != canonical)

    section("3c. every stale id in one text")
    all_ids = " ".join(migrator.STALE_TOKENS)
    all_migrated, all_counts = migrator.migrate_text(all_ids, synthetic=False)
    check("all seven are replaced, one each",
          all_counts == {tok: 1 for tok in migrator.STALE_TOKENS}, str(all_counts))
    check("no stale id survives",
          set(TOKEN_RE.findall(all_migrated)) == {migrator.TARGET}, str(TOKEN_RE.findall(all_migrated)))
    check("nothing that is not an id is rewritten",
          not TOKEN_RE.findall("no model here"))

    # ---- 4: dry-run planning ----------------------------------------------
    section("4. main() in DRY-RUN against harness-owned files")
    with tempfile.TemporaryDirectory(prefix="stale-models-migrate-") as tmp:
        root = Path(tmp)
        dirty = root / "dirty.py"
        dirty.write_text('MODEL = "deepseek-v4-pro"\nFALLBACK = "deepseek-v4-pro"\n', encoding="utf-8")
        clean = root / "clean.py"
        clean.write_text('MODEL = "deepseek-flash"\n', encoding="utf-8")
        before = tree_state(root)

        rc, printed = run_main(migrator, ["--files", str(dirty)])
        check("a dry run exits 0", rc == 0, f"rc={rc}")
        check("it announces the profile and DRY-RUN mode",
              "profile=explicit-files mode=DRY-RUN" in printed, repr(printed))
        check("it reports the change with the per-token counts",
              f"CHANGE   {dirty}  [deepseek-v4-prox2]" in printed, repr(printed))
        check("it reports the plan total", "total replacements: 2" in printed, repr(printed))
        check("the plan total matches migrate_text on the same content",
              sum(migrator.migrate_text(dirty.read_text(encoding="utf-8"), False)[1].values()) == 2)

        rc, printed = run_main(migrator, ["--files", f"{clean},{root / 'nope.py'}"])
        check("two --files paths are both visited", rc == 0, f"rc={rc}")
        check("an already-canonical file is reported clean", f"clean    {clean}" in printed, repr(printed))
        check("a missing file is reported, not fatal",
              f"MISSING  {root / 'nope.py'}" in printed and "total replacements: 0" in printed,
              repr(printed))

        check("the dry run left every file byte-identical", tree_state(root) == before)
        check("the dry run wrote no backup",
              not list(root.rglob("*.bak-stale-models-*")), str(list(root.rglob("*"))))

        rc, printed = run_main(migrator, ["--files"])
        check("--files without a value exits 2", rc == 2, f"rc={rc}")
        check("and says what is missing", "--files needs a comma-separated list" in printed,
              repr(printed))
        rc, printed = run_main(migrator, ["not-a-profile"])
        check("an unknown profile exits 2 instead of guessing", rc == 2, f"rc={rc}")
        check("and prints the usage block", "Usage: migrate_stale_models.py" in printed,
              repr(printed))
        check("the refusal guards never fired (no live path was passed)",
              tree_state(root) == before)

    # ---- 5: profiles, override table, backup stamp -------------------------
    section("5. profiles, OVERRIDE_TEST_FILES and the backup stamp")
    check("the four machine profiles are present",
          set(migrator.PROFILES) == {"mac", "thebrick", "thebrick2", "natasha"},
          str(sorted(migrator.PROFILES)))
    check("every profile entry is a ~ path",
          all(entry.startswith("~/") for entries in migrator.PROFILES.values() for entry in entries))
    check("no profile lists an entry twice",
          all(len(entries) == len(set(entries)) for entries in migrator.PROFILES.values()))
    check("the override table holds the two fuzzy-test files",
          migrator.OVERRIDE_TEST_FILES == {
              "~/Projects/data-maid/tests/test_maid_fuzzy.py",
              "~/Projects/ConstructionMarketData/tests/test_maid_fuzzy.py",
          }, str(sorted(migrator.OVERRIDE_TEST_FILES)))
    check("every entry of the override table is a test file",
          all("/tests/" in entry for entry in migrator.OVERRIDE_TEST_FILES))
    check("the override match is on the literal allowlist string, so an expanded path "
          "would not select it",
          all(os.path.expanduser(entry) not in migrator.OVERRIDE_TEST_FILES
              for entry in migrator.OVERRIDE_TEST_FILES))
    check("the thebrick profile names the override file verbatim (that is what selects it)",
          "~/Projects/data-maid/tests/test_maid_fuzzy.py" in migrator.PROFILES["thebrick"])
    check("no profile entry would be a surprise rewrite target outside ~/Projects or ~/.katra",
          all(re.match(r"^~/(Projects|creative-discovery|live-polymarket-box|Katra-Agentic-Memory|RankPilot|\.katra|\.)", e)
              or "/" in e for entries in migrator.PROFILES.values() for e in entries))
    check("STAMP is a YYYYmmdd-HHMMSS backup stamp",
          re.fullmatch(r"\d{8}-\d{6}", migrator.STAMP) is not None, migrator.STAMP)
    stamped = datetime.strptime(migrator.STAMP, "%Y%m%d-%H%M%S")
    check("STAMP was taken at import time, not frozen or invented",
          abs((datetime.now() - stamped).total_seconds()) < 300, migrator.STAMP)

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {', '.join(failures[:10])}"
              + (" ..." if len(failures) > 10 else ""))
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
