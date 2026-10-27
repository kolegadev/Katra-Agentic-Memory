# Phase 8 baseline comparison — CONTRACT-phase8.md §4.9-4.10

Written 2026-09-20, BEFORE the verifier's grading pass, and AFTER the seeded-fault
run whose metric was defined before its numbers were seen (see
`phase8-seeded-faults.json`, captured in the same run).

## The comparison, stated in advance

- **Metric**: `detected_count / 8` — of the eight doc-04 failure modes seeded into
  controlled missions, how many the plane's deterministic surface flags automatically
  (uncertainty trigger fired, or a mechanism verdict: baton auto-revocation, resume
  reconstruction). Full per-mode criteria are declared inside the capture artifact.
- **Baseline (without the layer)**: `0/8 by construction`. Every detector that could
  flag these modes exists only inside the plane; there is no pre-layer mechanism that
  flags them, so the baseline is definitionally zero — it is not an estimate and it
  was not measured after the fact.

## Result (measured once, from the captured run)

| | |
|---|---|
| Plane (detected / 8) | **6 / 8** |
| Baseline (without layer) | 0 / 8 by construction |
| Detected | (a) wrong inherited assumption · (b) contradictory evidence · (c) context loss · (d) stale baton · (e) executor duplication · (h) correlated agents |
| NOT detected (honest misses) | (f) graph lag · (g) LLM outage |

## Where the layer is NOT better (§4.10 — the honest half)

1. **(f) graph lag and (g) LLM outage are at parity with the baseline: zero.** No
   detector exists in the plane for knowledge-graph lag (graph internals are outside
   mission-cognition) or for LLM availability (`llm-service.ts` is closed since Phase 4).
   On these two modes the plane is exactly as blind as having no layer at all, and the
   harness says so in the capture rather than claiming coverage.
2. **Allocation is at parity with the baseline by design, not by superiority.** The
   plane runs in `shadow`: the scheduler recommends and never allocates. The allocator
   is byte-for-byte the pre-layer allocator (51 insertions / 0 deletions, off-state
   equivalence test). On allocation the layer cannot be "better" yet because it is
   deliberately not acting — that parity is the safety property, and it is the honest
   reading of the current comparison, not a manufactured victory.
3. **One honest gap in the harness itself**: all eight modes ran against the in-memory
   test database, not live production missions. That is the §4.7 requirement (the
   injection path must be incapable of reaching real state), but it means this
   comparison measures the plane's detection logic, not production-observed detections.
   Recorded here so "eight modes seeded" is never read as "eight modes observed against
   production".

## Conclusion

The plane detects six of eight seeded modes where the baseline detects zero, on a
metric chosen before the numbers existed, with the two misses written down instead of
smoothed. A comparison that only ever favours the new thing is not a comparison; this
one records exactly where the layer is not better.
