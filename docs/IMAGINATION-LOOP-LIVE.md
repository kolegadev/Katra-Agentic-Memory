# The full imagination loop, live — the instrument and its first real-mission run

`docs/IMAGINATION-BASELINE-LIVE.md` records the **A/B evaluation** (a purpose-built checkpoint, four
arms, a blinded judge). This file records the other live instrument: the **whole loop**, end to end,
on a mission that already exists.

## The instrument

`server/tests/live/imagination-loop-live.test.ts` (skipped unless `IMAGINATION_LOOP_LIVE=1`; it
refuses, by name, any missing identity / mission / run token / output path **before** it imports the
connection module). It walks the loop's own stages and records each one's row-level evidence:

| stage | what it calls |
| --- | --- |
| 1 before | the mission state + the mission's counts in the twelve collections the loop touches |
| 2 consolidation | `runFocusedConsolidation` → the salience trace |
| 3 plateau → cycle | the cycle service's own `evaluatePlateau` (every condition with its numbers), then `runImaginationCycle` — **UNFORCED**; a gate refusal is stored verbatim and only `IMAGINATION_LOOP_FORCE=1` re-runs it, marked as bypassed |
| 4 verification | `rankCheapTests`, the blinded judge (`imagination-blind-judge.ts`), then `executePermittedTest` for the top-ranked permitted test |
| 5 baton | the cycle's compiled packet, integrity + schema + secret scan + payload hash re-verified, then the gated `promoteCreativeBaton` and its audit row |
| 6 adapter | `batonCandidatesToWorkItems` **twice** — the second pass proves idempotency |
| 7 outcome | the `idea_candidate_outcomes` rows the run wrote, by verdict |
| 8 resume | `buildResumeReport` — the `creative_baton` section, its attention targets and portfolio summary, and a prose-leak test |
| 9 capture | the whole record, plus `written` (collection → count) and `written_filters`, and a `disclosure` array |

Same posture as the A/B instrument: no mocks, the real store, the real model, the flags set in the
**instrument process only** (the deployment keeps all four off), ceilings read from the deployment's
`.env`, nothing deleted, a bounded judged set, and nine invariants asserted *after* the capture is on
disk so a red run still leaves its evidence.

```bash
IMAGINATION_LOOP_LIVE=1 IMAGINATION_LOOP_USER=<owner> IMAGINATION_LOOP_MISSION=<mission id> \
IMAGINATION_LOOP_RUN=<fresh token> IMAGINATION_LOOP_OUT=<capture.json> \
  npx vitest run tests/live/imagination-loop-live.test.ts
```

## The first real-mission run (2026-09-26)

The subject: a real, parked research mission that had never been through the engine — 107 versions of
mission state, 325 epistemic entries, 106 state deltas, **zero** traces, cycles, seeds or work items.
The identity and mission id, and the candidates' content, are in the **private** record
(`imagination/LOOP-LIVE-pvsnp-20260926-103553.md`) — the mission's own constraints include *nothing
pushed*, so its content does not belong in this repository.

What the mechanics did, on real material, **unforced** (the real plateau gate fired):

- the plateau evaluation met three of its five conditions on genuine evidence — *below-minimum active
  candidates*, *archive coverage below floor*, *contradiction pressure above threshold*;
- the cycle ran: **8 candidates generated, 8 admitted, 0 rejected**, 8 new archive cells, 54 447
  measured tokens;
- verification ranked the eight cheap tests by expected information gain ÷ cost, permitted six under
  the mission's authority class (two refused **by name**), judged all eight blind (0 refusals) and
  **executed** the top-ranked permitted one through the shipped path — its verdict recorded with the
  novelty replenishment;
- the baton (6 attention targets, 0 excluded regions) passed schema, secret scan, integrity and a
  recomputed payload hash, and was **promoted** to the mission's own team scope — the driver's second
  promotion call returned `reused`, which is the gated promotion's idempotency proof;
- the controller adapter enqueued **8 work items** (each with a `provenance` row), and its second
  pass created **0**;
- the resume came back carrying the promoted baton, 6 attention targets and 8 candidate summaries
  with **16 prose fields omitted and no prose leak**.

All nine invariants passed. The run also found a real defect and it is fixed in the same commit: the
resume section reported `code: 'no_baton'` even when it **included** the baton (the code the ABSENT
and failed-read cases use), so a reader branching on the code alone read "there is no baton" from the
section that had just included one. `BatonResumeCode` gained `'included'`, the success path sets it,
and the resume test pins it.

## What this run does and does not establish

- It establishes that the **loop's own path works on a real mission with real history**: consolidation
  → plateau → cycle → archive → verification → baton → promotion → controller work items → outcome →
  resume, with the deployment's own model and ceilings.
- It does **not** turn the engine on in the deployment: the flags were set in the instrument process,
  and the container still runs with all four off. Turning `FOCUSED_IMAGINATION` on (stage 2) remains a
  gated rollout decision.
- The candidates it produced are *generated hypotheses*. Their content, their quality and what they
  are worth is the mission owner's judgement — not this repository's claim.
