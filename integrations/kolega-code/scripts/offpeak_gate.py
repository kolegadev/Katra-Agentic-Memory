#!/usr/bin/env python3
"""DeepSeek off-peak gate — exit 0 when the API bills off-peak, 1 during peak.

DeepSeek's published schedule (effective 2026-08-16 16:00 UTC):
  PEAK (2x price): 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday,
                   excluding Chinese public holidays.
  OFF-PEAK (50% off): every other hour, all Saturday and Sunday, and Chinese
                   public holidays in full.

Chinese public holidays are not resolved here on purpose: treating a holiday as
peak can only ever *skip* a run, it can never cause peak-hour spend.

Usage:
  offpeak_gate.py                     quiet, cron/systemd friendly (exit 0/1)
  offpeak_gate.py --verbose           print the decision
  offpeak_gate.py --at 2026-09-28T02:00   classify a given UTC timestamp (tests)
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone

PEAK_WINDOWS = ((1, 4), (6, 10))  # UTC hours [start, end)


def is_offpeak(now: datetime) -> bool:
    if now.weekday() >= 5:  # Saturday / Sunday — off-peak all day
        return True
    hour = now.hour + now.minute / 60.0
    return not any(start <= hour < end for start, end in PEAK_WINDOWS)


def main() -> int:
    argv = sys.argv[1:]
    verbose = "--verbose" in argv
    if "--at" in argv:
        idx = argv.index("--at")
        stamp = argv[idx + 1] if idx + 1 < len(argv) else ""
        now = datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)
    else:
        now = datetime.now(timezone.utc)

    off = is_offpeak(now)
    if verbose or "--at" in argv:
        print("UTC %s (%s) -> %s" % (
            now.strftime("%Y-%m-%d %H:%M"),
            now.strftime("%a"),
            "OFF-PEAK" if off else "PEAK",
        ))
    return 0 if off else 1


if __name__ == "__main__":
    sys.exit(main())
