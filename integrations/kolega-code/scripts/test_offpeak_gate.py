#!/usr/bin/env python3
"""Off-peak gate — the DeepSeek peak/off-peak windows and the exit contract.

Run:  python3 integrations/kolega-code/scripts/test_offpeak_gate.py
      (from anywhere; stdlib only, no pytest)

`offpeak_gate.py` exits 0 when the DeepSeek API bills off-peak and 1 during
peak, and is meant to be driven by cron/systemd. This script pins:

  1. PEAK_WINDOWS as published: (1, 4) and (6, 10) UTC, Monday-Friday
  2. every weekday boundary — 00:59/01:00, 03:59/04:00, 05:59/06:00,
     09:59/10:00 — plus the full hour sweep of a Mon-Sun week (35 peak hours)
  3. weekends are off-peak for all 24 hours
  4. the timezone contract: the gate reads the datetime's *wall-clock* fields
     and ignores tzinfo, so a caller must hand it a UTC datetime
  5. the exit contract through `--at` (the flag the docstring advertises for
     tests) in a subprocess: 0 = OFF-PEAK, 1 = PEAK, silent without flags

The gate holds no state — it reads no file, writes nothing and makes no
network call — so the only execution this script performs is
`offpeak_gate.py --at <literal>`, which prints one line and exits.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE_PATH = HERE / "offpeak_gate.py"

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
    """Load a module from a path whose file name is not a valid module name."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def utc(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)


def run_gate(*argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(GATE_PATH), *argv],
        cwd=HERE, capture_output=True, text=True, timeout=60,
    )


def main() -> int:
    gate = load_by_path("offpeak_gate_under_test", GATE_PATH)

    # ---- 1: the published windows -----------------------------------------
    section("1. PEAK_WINDOWS is the published DeepSeek schedule")
    check("windows are (1, 4) and (6, 10)", gate.PEAK_WINDOWS == ((1, 4), (6, 10)),
          repr(gate.PEAK_WINDOWS))
    check("windows are UTC half-open [start, end)",
          all(start < end and 0 <= start and end <= 24 for start, end in gate.PEAK_WINDOWS),
          repr(gate.PEAK_WINDOWS))

    # ---- 2: weekday boundaries --------------------------------------------
    section("2. weekday boundaries (Monday 2026-09-28)")
    boundaries = [
        ("2026-09-28T00:00", True),
        ("2026-09-28T00:59", True),   # last minute before window 1
        ("2026-09-28T01:00", False),  # start of window 1, inclusive
        ("2026-09-28T02:00", False),
        ("2026-09-28T03:59", False),  # last minute of window 1
        ("2026-09-28T04:00", True),   # end of window 1, exclusive
        ("2026-09-28T05:59", True),   # gap between the windows
        ("2026-09-28T06:00", False),  # start of window 2, inclusive
        ("2026-09-28T09:59", False),  # last minute of window 2
        ("2026-09-28T10:00", True),   # end of window 2, exclusive
        ("2026-09-28T10:01", True),
        ("2026-09-28T23:59", True),
    ]
    for stamp, expected in boundaries:
        verdict = "OFF-PEAK" if expected else "PEAK"
        check(f"Mon {stamp[11:]} -> {verdict}", gate.is_offpeak(utc(stamp)) is expected)

    check("seconds are ignored (09:59:59 is still peak)",
          gate.is_offpeak(utc("2026-09-28T09:59:59")) is False)
    check("seconds are ignored (10:00:00 is off-peak)",
          gate.is_offpeak(utc("2026-09-28T10:00:00")) is True)
    check("sub-minute peak start is peak (01:00:30)",
          gate.is_offpeak(utc("2026-09-28T01:00:30")) is False)

    section("3. a whole week: 35 peak hours, 133 off-peak")
    monday = utc("2026-09-21T00:00")  # Monday
    week = [monday + timedelta(hours=h) for h in range(24 * 7)]
    peak_hours = [dt.hour for dt in week if not gate.is_offpeak(dt)]
    check("Mon-Fri peak hours are exactly 1-3 and 6-9",
          sorted({h for h in peak_hours}) == [1, 2, 3, 6, 7, 8, 9], str(sorted(set(peak_hours))))
    check("Monday-Friday contribute 7 peak hours each (35 total)",
          len(peak_hours) == 35, str(len(peak_hours)))
    check("no weekend hour is peak",
          all(dt.weekday() < 5 for dt in week if not gate.is_offpeak(dt)))
    check("every weekday off-peak hour is 133 of 168",
          sum(1 for dt in week if gate.is_offpeak(dt)) == 133)

    # ---- 3: weekends -------------------------------------------------------
    section("4. weekends are off-peak in full")
    for day in ("2026-09-26", "2026-09-27"):  # Saturday, Sunday
        weekend = [utc(f"{day}T00:00") + timedelta(hours=h) for h in range(24)]
        check(f"{day} ({weekend[0].strftime('%a')}): all 24 hours off-peak",
              all(gate.is_offpeak(dt) for dt in weekend))
    check("Sunday 01:00 (peak hour on a weekday) is off-peak",
          gate.is_offpeak(utc("2026-09-27T01:00")) is True)
    check("Sunday 06:00 (peak hour on a weekday) is off-peak",
          gate.is_offpeak(utc("2026-09-27T06:00")) is True)
    check("Saturday 02:00 (peak hour on a weekday) is off-peak",
          gate.is_offpeak(utc("2026-09-26T02:00")) is True)

    # ---- 4: timezone handling ---------------------------------------------
    section("5. timezone handling: wall-clock fields only, so pass UTC")
    naive = datetime.fromisoformat("2026-09-28T02:00")
    check("a naive datetime is read as UTC wall clock",
          gate.is_offpeak(naive) is gate.is_offpeak(utc("2026-09-28T02:00")) is False)
    for stamp in ("2026-09-28T00:59", "2026-09-28T01:00", "2026-09-28T03:59",
                  "2026-09-28T04:00", "2026-09-28T09:59", "2026-09-28T10:00"):
        aware = utc(stamp)
        check(f"aware UTC {stamp[11:]} matches the naive reading",
              gate.is_offpeak(aware) is gate.is_offpeak(datetime.fromisoformat(stamp)))

    # 11:00+09:00 is the same instant as 02:00 UTC (peak). The gate has no tz
    # conversion, so it classifies by the caller's clock — proof that a
    # non-UTC datetime silently shifts the window.
    shifted = datetime.fromisoformat("2026-09-28T11:00+09:00")
    check("a non-UTC datetime is classified by its own wall clock "
          "(11:00+09:00 == 02:00 UTC, but reads as off-peak)",
          shifted.astimezone(timezone.utc).hour == 2 and gate.is_offpeak(shifted) is True)
    check("the same instant expressed in UTC is peak",
          gate.is_offpeak(shifted.astimezone(timezone.utc)) is False)
    check("tzinfo is ignored outright (offset does not change the verdict for equal fields)",
          gate.is_offpeak(datetime.fromisoformat("2026-09-28T02:00+09:00"))
          is gate.is_offpeak(datetime.fromisoformat("2026-09-28T02:00-05:00"))
          is False)

    # ---- 5: the exit contract ---------------------------------------------
    section("6. exit contract through --at")
    peak = run_gate("--at", "2026-09-28T02:00")
    check("peak stamp exits 1", peak.returncode == 1, f"rc={peak.returncode}")
    check("peak stamp prints the weekday and PEAK",
          peak.stdout.strip() == "UTC 2026-09-28 02:00 (Mon) -> PEAK", repr(peak.stdout))

    off = run_gate("--at", "2026-09-27T02:00")  # Sunday
    check("off-peak stamp exits 0", off.returncode == 0, f"rc={off.returncode}")
    check("off-peak stamp prints the weekday and OFF-PEAK",
          off.stdout.strip() == "UTC 2026-09-27 02:00 (Sun) -> OFF-PEAK", repr(off.stdout))

    boundary = run_gate("--at", "2026-09-28T04:00")
    check("the 04:00 boundary exits 0 through the CLI too", boundary.returncode == 0,
          f"rc={boundary.returncode}")
    check("the 04:00 boundary also prints OFF-PEAK", boundary.stdout.strip().endswith("-> OFF-PEAK"))

    verbose = run_gate("--verbose", "--at", "2026-09-28T12:00")
    check("--verbose prints the decision", verbose.stdout.strip().endswith("-> OFF-PEAK"),
          repr(verbose.stdout))
    check("--verbose does not change the exit code", verbose.returncode == 0)

    quiet = run_gate()  # cron path: real clock, no flags
    check("quiet mode prints nothing", quiet.stdout == "", repr(quiet.stdout))
    check("quiet mode still exits 0 or 1", quiet.returncode in (0, 1), f"rc={quiet.returncode}")

    missing = run_gate("--at")
    check("--at without a value fails loudly instead of guessing",
          missing.returncode != 0 and "ValueError" in missing.stderr,
          f"rc={missing.returncode}")

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s): {', '.join(failures[:10])}"
              + (" ..." if len(failures) > 10 else ""))
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
