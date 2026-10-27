#!/usr/bin/env python3
"""Memory-growth check for the Katra episodic store.

Why: on 2026-10-21 the store held 969,766 episodic rows that collapsed to
437,026 propositions (53.8% redundant), and one proposition — "katra-server was
restarted to recover from an unhealthy state." — had been written 4,759 times.
Three changes followed: a proposition key that merges repeats on write, a
compaction of the existing rows, and a per-session extraction cursor so the
extractor only distils new text.

This script is the check that those changes actually stemmed the flow. It
answers one question at each health review: are new rows appearing for repeats,
or are repeats being absorbed as `occurrences` on an existing proposition?

The signal, read together:
  * rows added in the window  — should stay near the genuinely-new propositions
  * occurrences added         — expected to keep climbing; that is the merge
  * collapsed ratio           — occurrences per new row (higher = more absorbed)

Writes a labelled block to health-reports.md (read by the 06:30Z review) and
keeps a JSON baseline so the next run reports deltas.

Usage:
  katra_memory_growth.py                 # measure, append report, update baseline, print
  katra_memory_growth.py --no-report     # measure + print only; no report, no baseline save
  katra_memory_growth.py --quiet         # measure, append report, update baseline; no stdout
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

REPO = os.environ.get("KATRA_REPO", os.path.expanduser("~/Katra-Agentic-Memory"))
ENV_FILE = os.path.join(REPO, ".env")
BASELINE = os.path.expanduser("~/.katra/inbox/memory-growth-baseline.json")
REPORT = os.path.expanduser("~/.katra/inbox/health-reports.md")

JS = r"""
const dbx = db.getSiblingDB(process.env.D);
const c = dbx.episodic_events;
const now = new Date();
const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
const out = {
  measured_at: now.toISOString(),
  docs_total: c.estimatedDocumentCount(),
  rows_24h: c.countDocuments({ timestamp: { $gte: dayAgo } }),
  derived_24h: c.countDocuments({
    timestamp: { $gte: dayAgo },
    event_type: { $in: ['goal','plan','problem','insight','decision','solution','mind_wander','machine_health','bridge_health','executive_action'] },
  }),
  facts_24h: dbx.semantic_facts.countDocuments({ created_at: { $gte: dayAgo } }),
  facts_total: dbx.semantic_facts.estimatedDocumentCount(),
  prop_rows_24h: c.countDocuments({ timestamp: { $gte: dayAgo }, proposition_key: { $exists: true } }),
  prop_rows: c.countDocuments({ proposition_key: { $exists: true } }),
  occurrence_total: 0,
  cursors: dbx.extraction_cursors.countDocuments(),
  top: [],
};
const occ = c.aggregate([
  { $match: { proposition_key: { $exists: true } } },
  { $group: { _id: null, n: { $sum: { $ifNull: ['$occurrences', 1] } } } },
]).toArray();
out.occurrence_total = occ.length ? occ[0].n : 0;
c.find({ occurrences: { $gt: 1 } }, { occurrences: 1, event_type: 1, 'content.description': 1 })
  .sort({ occurrences: -1 }).limit(6).forEach(d => out.top.push({
    type: d.event_type,
    occ: d.occurrences,
    text: String((d.content && d.content.description) || '').slice(0, 80),
  }));
out.sentinels = [
  'katra-server was restarted to recover from an unhealthy state',
  'katra-server experienced an outage.',
].map(text => {
  const docs = c.find({ 'content.description': text }, { occurrences: 1 }).toArray();
  return { text, count: docs.length, occ: docs.reduce((a, d) => a + (d.occurrences || 1), 0) };
});
print(JSON.stringify(out));
"""


def read_env() -> dict:
    env = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def measure() -> dict:
    env = read_env()
    tmp = f"/tmp/katra-growth-{os.getpid()}.js"
    with open(tmp, "w") as f:
        f.write(JS)
    subprocess.run(["docker", "cp", tmp, "katra-mongo:/tmp/growth.js"],
                   check=True, capture_output=True)
    proc = subprocess.run(
        ["docker", "exec",
         "-e", f"U={env['MONGO_USER']}",
         "-e", f"P={env['MONGO_PASS']}",
         "-e", f"D={env.get('DATABASE_NAME', 'katra')}",
         "katra-mongo", "sh", "-c",
         'mongosh "mongodb://$U:$P@localhost:27017/$D?authSource=admin" --quiet --file /tmp/growth.js'],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"measure failed: {proc.stderr.strip()[:300]}")
    for line in reversed(proc.stdout.strip().splitlines()):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    sys.exit("measure: no JSON in output")


def load_baseline() -> dict | None:
    try:
        with open(BASELINE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def save_baseline(m: dict) -> None:
    os.makedirs(os.path.dirname(BASELINE), exist_ok=True)
    tmp = BASELINE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(m, f, indent=2)
    os.replace(tmp, BASELINE)


def top_delta(before: list, after: list) -> list:
    prev = {t["text"]: t["occ"] for t in before}
    now = {t["text"]: t["occ"] for t in after}
    out = []
    for t in after:
        was = prev.get(t["text"])
        out.append({
            **t,
            "delta": (t["occ"] - was) if was is not None else None,
            "state": ("climbing" if was is not None and t["occ"] > was
                      else ("flat" if was is not None else "new")),
        })
    for t in before:
        if t["text"] not in now:
            out.append({**t, "delta": None, "state": "dropped"})
    return out


def verdict_text(d_docs: int, d_prop: int, d_occ: int) -> str:
    """Return the one-line verdict for a delta window.

    The ordering is deliberate: a shrinking store is a compaction, not a quiet
    window; rows arriving with no proposition key are the failure the check
    exists to catch; "no activity" is reserved for a window where nothing at
    all moved.
    """
    if d_docs < 0 or d_prop < 0:
        return (
            f"COMPACTION SEEN — store shrank by {abs(min(d_docs, 0)):,} docs / "
            f"{abs(min(d_prop, 0)):,} propositions; deltas restart here"
        )
    if d_docs == 0 and d_prop == 0 and d_occ == 0:
        return "NO ACTIVITY in this window — too short to judge; compare at the next daily check"
    if d_prop == 0 and d_docs > 0:
        return (
            f"KEY NOT WRITTEN — {d_docs:,} rows added, 0 propositions; "
            "the write path is not keying them"
        )
    if d_prop == 0:
        return "FLOW STEMMED — every repeat absorbed into an existing proposition, 0 new rows"
    ratio = d_occ / d_prop
    if ratio >= 1:
        return f"ABSORPTION WORKING — {ratio:.1f} repeats absorbed per new proposition"
    return (
        f"REVIEW — {d_prop} new propositions vs {d_occ} absorbed repeats; "
        "more new rows than repeats is worth a look"
    )


def render(m: dict, base: dict | None) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%MZ")
    lines = [f"# MEMORY GROWTH {stamp} — delta-capture check (Lilly; for the 07:30Z review)"]
    lines.append(
        f"- store: {m['docs_total']:,} episodic docs | {m['prop_rows']:,} propositions | "
        f"{m['occurrence_total']:,} represented occurrences | {m['cursors']} session cursors"
    )
    lines.append(
        f"- last 24h: {m['rows_24h']:,} rows added, of which {m['prop_rows_24h']:,} carry a proposition key"
    )
    # Flow ceilings. Post-fix observed rates on 2026-10-22 were ~1.0 derived
    # events/min and ~2.7 facts/min, i.e. ~1,400 and ~3,900 per day. The
    # pre-fix derivation loop ran at ~5.8 derived/min (~8,300/day). These
    # ceilings sit between the two: a resumption trips the line, normal
    # traffic does not. Tune from measurement, not from hope.
    derived_24h = m.get("derived_24h", 0)
    facts_24h = m.get("facts_24h", 0)
    over = []
    if derived_24h > 5000:
        over.append(f"derived {derived_24h:,} > 5,000")
    if facts_24h > 8000:
        over.append(f"facts {facts_24h:,} > 8,000")
    flag = "  ** FLOW ABOVE CEILING (" + ", ".join(over) + ") **" if over else ""
    lines.append(
        f"- last 24h flow: {derived_24h:,} derived events, {facts_24h:,} semantic facts "
        f"(store total {m.get('facts_total', 0):,} facts){flag}"
    )

    if base:
        d_docs = m["docs_total"] - base["docs_total"]
        d_prop = m["prop_rows"] - base["prop_rows"]
        d_occ = m["occurrence_total"] - base["occurrence_total"]
        # Compare NEW PROPOSITIONS against absorbed repeats. Raw rows (health
        # samples, messages, conversations) are expected to grow and say nothing
        # about whether the merge works.
        ratio = (d_occ / d_prop) if d_prop > 0 else None
        if d_docs < 0 or d_prop < 0:
            lines.append(
                f"- since {base['measured_at'][:16]}Z baseline: {d_docs:+,} docs "
                f"({d_prop:+,} propositions), occurrences {d_occ:+,} — compaction, deltas restart here"
            )
        else:
            lines.append(
                f"- since {base['measured_at'][:16]}Z baseline: {d_docs:+,} docs "
                f"({d_prop:+,} propositions), occurrences {d_occ:+,}"
                + (f", {ratio:.1f} absorbed repeats per new proposition" if ratio is not None
                   else (", repeats absorbed into existing propositions only" if d_occ > 0
                         else ", no occurrences added"))
            )
        sentinels = m.get("sentinels") or []
        if sentinels:
            lines.append("- pinned sentinels: " + "; ".join(
                f"“{s['text'][:60]}” x{s['occ']} ({s['count']} rows)" for s in sentinels))
        deltas = top_delta(base.get("top", []), m.get("top", []))
        hot = [d for d in deltas if d.get("delta") is not None and d["delta"] > 0]
        dropped = [d for d in deltas if d.get("state") == "dropped"]
        if hot:
            lines.append("- top propositions still climbing: " + "; ".join(
                f"“{d['text'][:60]}” x{d['occ']} ({d['delta']:+d})" for d in hot[:3]))
        elif dropped:
            lines.append("- top propositions: " + "; ".join(
                f"“{d['text'][:60]}” dropped out of top 6" for d in dropped[:3]))
        else:
            lines.append("- top propositions: flat since baseline")
        lines.append(f"- verdict: {verdict_text(d_docs, d_prop, d_occ)}")
    else:
        lines.append("- verdict: BASELINE ESTABLISHED (no prior measurement to compare)")
        if m.get("top"):
            lines.append("- top propositions: " + "; ".join(
                f"“{t['text'][:60]}” x{t['occ']}" for t in m["top"][:3]))
        sentinels = m.get("sentinels") or []
        if sentinels:
            lines.append("- pinned sentinels: " + "; ".join(
                f"“{s['text'][:60]}” x{s['occ']} ({s['count']} rows)" for s in sentinels))

    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-report", action="store_true",
                    help="print only; do not append to health-reports.md and do not save the baseline")
    ap.add_argument("--quiet", action="store_true",
                    help="no stdout; the health report and baseline are still written")
    args = ap.parse_args()

    m = measure()
    base = load_baseline()
    block = render(m, base)

    if not args.no_report:
        with open(REPORT, "a") as f:
            f.write("\n" + block + "\n")
        save_baseline(m)

    if not args.quiet:
        print(block)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
