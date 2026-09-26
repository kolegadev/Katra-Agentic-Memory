# Imagination baseline — the recorded A/B evaluation (ITER-11, WS-4)

The recorded baseline the rollout gate refers to. Produced by the dependency-free harness

```bash
cd server
node scripts/imagination-baseline.mjs              # human report; writes docs/IMAGINATION-BASELINE.json
node scripts/imagination-baseline.mjs --json       # the same report as JSON
node scripts/imagination-baseline.mjs --help       # every option
```

against the frozen checkpoint `server/tests/fixtures/imagination-baseline-checkpoint.json`
(checkpoint name **`frozen_checkpoint_alpha`**, cycle `imagination_cycle_8c0b39bbedcd5e39_v3_c1`,
team pass `cpass_a9853683edde7c2fa34e5b3a30a64b3f`). The fixture is generated and freshness-gated by
`server/tests/unit/imagination-baseline-fixture.test.ts`: it is rebuilt from the REAL services
(the frozen scenario, one imagination cycle, the outcome channel, the cognitive team's first pass)
and compared byte for byte, so the numbers below cannot drift away from the code that produced them.

## The recorded experiment

| | |
| --- | --- |
| experiment id | **`impexp_daba0176f662f4776203fff7a2c5b4be`** |
| store | `docs/IMAGINATION-BASELINE.json` (`imagination_experiments` rows: one experiment, 49 observations) |
| arms | `A` `control_dreamer_retrieval` · `B` `control_mind_wander` · `C` `focused_engine_balanced` · `D` `engine_plus_heterogeneous_team` |
| comparison | baseline arms `A+B` vs treatment arms `C+D`, per `compareExperiment` |
| target | `useful_novelty_rate` — **≥30% better** (the brief's named target, overridable with `--target useful_novelty_rate=0.3`) |

The store's rows are in the collection's own shape, with the SAME derived ids
`registerExperiment` / `recordExperimentObservation` produce. `server/tests/unit/imagination-baseline-harness.test.ts`
proves it by loading them into the in-memory store and running the REAL `compareExperiment` over
them: its per-metric verdicts equal the harness's, and replaying any recorded observation through the
gated write finds it **unchanged** (same `observation_key`, same numbers).

The store ALSO carries a top-level `comparison` block — the verdict field a rollout gate reads:
the two sides, the metric verdicts, each side's own reading, and `comparability` with the reason.
The same object is what the printed report ends with.

## What each arm is

| Arm | Path | Generation | Determination |
| --- | --- | --- | --- |
| `A` | pre-engine dreamer-style retrieval: one idea per concept, ranked by graph degree | the comparator's candidates, captured in the fixture through the **shipped archive** | `stub_determined` (the candidate text is the comparator's scripted template) |
| `B` | pre-engine mind-wander over the graph; **both directions of every step**, undeduped — the restatements the archive was built to reject | the comparator's candidates, captured in the fixture through the **shipped archive** | `stub_determined` |
| `C` | the focused engine, one balanced identity (`FOCUSED_IMAGINATION=1`), on the frozen checkpoint | captured from the real services in the fixture | `store_measured` |
| `D` | the engine plus the heterogeneous team (philosopher / analyst / strategist) | captured from the real services in the fixture | `store_measured` |

**One rule decides all four arms (ITER-11 refinement).** The comparators are not a service any more,
so their candidate TEXT is still the pre-engine path's (one idea per concept ranked by degree; both
directions of every walk step). What changed is the ADMISSION: the fixture generator now runs every
comparator candidate through `IdeaArchiveService.admitOrReplace` — the shipped rule, in-process, over
a throwaway identity and mission — and records that rule's own decisions (`state`, `rejection_reason`,
`duplicate_of`, `cell_key`, `quality`). Each arm declares it in `admission_rule`:

```json
{ "path": "shipped_archive", "service": "IdeaArchiveService.admitOrReplace",
  "decided_by": "server/tests/unit/imagination-baseline-fixture.test.ts (the fixture generator)",
  "identity": "agent-control", "mission_id": "mission_baseline_control_retrieval",
  "same_rule_as": ["A", "B", "C", "D"], "text_is_scripted": true }
```

Before the refinement the harness **re-implemented** the archive's containment rule for the two
comparators (the constants duplicated), so the cross-arm `false_novelty` difference measured two rules
as well as two paths. It does not any more: the harness contains no `isParaphrase`, no threshold and no
comparator, and the comparison says so in `comparability` — derived from the arms, not asserted:

> `like_for_like` — every arm on both sides was admitted/rejected by the same shipped rule
> (`IdeaArchiveService.admitOrReplace`) — so the difference between the sides is the difference between
> the paths, not between two rules; the candidate TEXT is scripted on all four arms, so the magnitude
> is `stub_determined` while the rule is the deployment's own.

If an arm ever declares anything other than the one shipped rule, the verdict becomes
`not_comparable`, the `delta` and `relative_gain` are **not formed**, and the per-arm numbers stand
alone (a test drives exactly that by re-labelling arm `A`'s rule).

Three fields on the comparator candidates are schema-necessary and declared, never dressed up as a
claim about the pre-engine path: `operator` (the shipped seed schema requires a catalogue family; the
pre-engine path had no operator plan, so `A` carries `representation_shift` and `B` `distant_analogy`),
`evidence_refs` (the graph node/edge the comparator retrieved from) and `lineage_ref` (derived from the
seed id, never random).

## What each count counts

Every metric's denominator is the thing its basis names. That matters for the two `false_novelty` readings a
re-run has to reproduce:

- **`generated` = the arm's own `counts.generated`** (admitted + rejected), *not* `rows.length`. A treatment
  arm's `rows` hold only the seeds the archive **admitted**: arm `D` returns six rows and generated
  **nine** candidates (three rejections are recorded without a row), so dividing by the row count would
  report 3/6 = 0.5 instead of the measured 3/9 = 0.333333.
- **`rejected`** counts recorded rejections, de-duplicated by seed, so a fixture that carries both a
  rejected row and a rejection entry counts that candidate once. Every arm's counts reconcile
  (`generated = admitted + rejected`), and `arm_count_reconciliation` records that as a number
  (`0` = they agree) instead of leaving it implicit.
- `false_novelty` = rejections with a seen-before reason (`duplicate_of`, `paraphrase_of`,
  `excluded_region`) ÷ **generated**; `idea_survival` = admitted candidates carrying an outcome ÷
  **admitted**; `archive_coverage_gain`'s sample is the archive's **cell rows**.

## The numbers, with their basis

First real run (`node scripts/imagination-baseline.mjs`, fixture frozen 2026-09-26T12:00:00.000Z).
`n` is the sample behind each number; `determination` says whether the number is arithmetic over the
fixture's captured rows (`store_measured`), depends on scripted text (`stub_determined`), or cannot be
measured from this fixture at all (`insufficient_data`).

| Arm | metric | value | n | determination |
| --- | --- | --- | --- | --- |
| `A` | `arm_generated_candidates` / `arm_admitted_candidates` / `arm_rejected_candidates` | 4 / 1 / 3 | 4 | `stub_determined` |
| `A` | `false_novelty` | 0.75 | 4 | `stub_determined` |
| `A` | `useful_novelty_rate`, `idea_survival`, `cost_of_novelty`, `time_to_next_viable_direction`, `archive_coverage_gain`, `agent_divergence` | `insufficient_data` | 0 | `insufficient_data` |
| `B` | `arm_generated_candidates` / `arm_admitted_candidates` / `arm_rejected_candidates` | 8 / 1 / 7 | 8 | `stub_determined` |
| `B` | `false_novelty` | 0.875 | 8 | `stub_determined` |
| `B` | (the same six as `A`) | `insufficient_data` | 0 | `insufficient_data` |
| `C` | `arm_generated_candidates` / `arm_admitted_candidates` / `arm_rejected_candidates` | 6 / 4 / 2 | 6 | `store_measured` |
| `C` | `false_novelty` | 0.333333 | 6 | `store_measured` |
| `C` | `useful_novelty_rate` | 0.666667 | 3 | `store_measured` |
| `C` | `idea_survival` (declared proxy) | 0.75 | 4 | `store_measured` |
| `C` | `time_to_next_viable_direction` | 9 ms | 4 | `store_measured` |
| `C` | `archive_coverage_gain` | 4 new cells (of 16 807 possible) | 4 | `store_measured` |
| `C` | `cost_of_novelty` | `insufficient_data` — the recorded spend is 0 (the scripted model calls no provider), and an unrecorded/zero spend is **not** a cost of zero | 0 | `insufficient_data` |
| `C` | `agent_divergence` | `insufficient_data` — one stream, not a team | 0 | `insufficient_data` |
| `D` | `arm_generated_candidates` / `arm_admitted_candidates` / `arm_rejected_candidates` | **9** / 6 / 3 | 9 | `store_measured` |
| `D` | `false_novelty` | **0.333333** (3/9, not 3/6) | 9 | `store_measured` |
| `D` | `archive_coverage_gain` | 4 new cells (of 16 807 possible) | 4 | `store_measured` |
| `D` | `time_to_next_viable_direction` | `insufficient_data` — the arm stamped its trigger and its first admitted candidate at the SAME instant, so the window is self-stamped and the 0 ms gap measures nothing | 0 | `insufficient_data` |
| `D` | `agent_divergence` (closest-pair Jaccard, 3 agents) | 0.027778 | 3 | `stub_determined` |
| `D` | `agent_divergence_same_mode_control` | `insufficient_data` — the same-mode control belongs to the Phase-6 exit-criterion test, not to this experiment | 0 | `insufficient_data` |
| `D` | `useful_novelty_rate`, `idea_survival`, `cost_of_novelty` | `insufficient_data` — no outcome was ever recorded for the team arm | 0 | `insufficient_data` |

### The comparison (baseline `A+B` vs treatment `C+D`)

| metric | comparability | baseline | treatment | delta | relative gain | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `useful_novelty_rate` | `like_for_like` | *(none — the pre-engine arms recorded no outcomes)* | 0.666667 (n 3) | — | — | `insufficient_data` |
| `false_novelty` (lower is better) | `like_for_like` | 0.833333 (n 12) | 0.333333 (n 15) | −0.5 | 0.6 | `improved` (the 30% target is reached) |
| `time_to_next_viable_direction` (lower is better) | `like_for_like` | *(none — the pre-engine arms have no cycle trigger to time from)* | 9 ms (n 4 — arm `C` only) | — | — | `insufficient_data` |
| `task_quality_regression` | `like_for_like` | 2 criteria met (n 4) | 2 criteria met (n 4) | **none — the sides are exactly equal** | — | `equal` |

**Why `false_novelty` reads 0.6 now and read 0.200001 before.** With ONE rule on both sides, the
comparators' own redundancy is measured the way the treatments' is: ten of the twelve comparator
candidates are restatements of one already stored (arm `A` restates ONE template four times — its
mechanism sentence varies only with degree, and all four concepts have degree 2 — and arm `B` emits
both directions of every edge), against five of the treatment's fifteen. The old `0.200001` came from
a copy of the rule that compared **hypotheses only**: the shipped rule also compares the mechanism
field (ITER-6's own residual F2 made that so), and that field is where the comparator template repeats
itself verbatim. The refinement therefore made the comparison *worse for the pre-engine path*, not
better — the previous number under-counted the baseline's redundancy.

That reading is still bounded by the script: the candidate TEXT on both sides is scripted (the
comparator's templates, the stub model's seeds), which is why both arms' `false_novelty` stays
`stub_determined` and why a live run with a real pre-engine path may differ. What the number can carry
is the RULE: one shipped rule, applied at once to both sides.

**Equality is stated, not rounded into a verdict.** Two readings that are the same number at the
reported precision (1e-6) are reported as `equal` by the ONE shared rule
(`compareMeasuredValues`, used by the experiment comparison AND by the metrics view's
window-over-window comparison): no delta is reported (there is none), no relative gain is formed, and
neither "improved" nor "not improved" is claimed. A difference *below* the reported precision is
reported the same way, with the reason saying so. The task-quality metric is the exactly-equal case
here: both sides meet 2 of 2 criteria, so the row reads `equal` instead of a `0` delta under a
"not improved" verdict.

**Overall verdict: the decisive metric is still `insufficient_data`.** The brief's DoD bullet 8 asks
for a demonstration that useful novelty improves without a material task-quality regression. This
fixture cannot produce that demonstration, and it says so rather than inventing it:

- the CONTROL arms recorded no outcomes, so `useful_novelty_rate` has no baseline side at all. The
  pre-engine path never *recorded* whether an idea was useful — that channel is part of what the
  engine adds;
- the treatment's 0.666667 is two useful verdicts out of three recorded ones on a scripted model, so
  even that number is evidence about the *plumbing*, not about a real model's ideas;
- `false_novelty` is measurable on both sides and, with one rule on both, reads 0.833333 (10/12) against
  0.333333 (5/15) — a 0.6 relative gain, past the brief's 0.3 target. It is the one two-sided number
  the bullet can point at, and it is a statement about the archive's rule over *scripted* text;
- `time_to_next_viable_direction` — the bullet's OTHER named metric — is now part of the comparison and
  is refused on BOTH sides, by name: the comparators have no cycle trigger to time from, and arm `D`'s
  trigger and its first admitted candidate carry the same instant, so its "0 ms" is a self-stamped
  window rather than a response time (the reviewer's N3). Only arm `C` carries a real, non-zero window
  (9 ms), which is one side of a two-sided metric, so the comparison reads `insufficient_data`;
- the task-quality check shows **no regression** and **equal** readings on both sides, with the
  criterion-by-criterion evidence below.

### Task-quality check (the brief's "no material task-quality regression")

Each of the frozen mission's success criteria is evaluated by its **own** documented predicate over
evidence the arm carries. Both used to be evaluated by one predicate (`portfolio_non_empty`), which
every arm passed by producing a row — so the check could not fail and the observation said nothing.

The report section (abridged where marked `…`; the full bases are in the printed report and in
`docs/IMAGINATION-BASELINE.json`):

```
task_quality_regression: treatment 2/2 vs baseline 2/2 counted criteria — no regression [stub_determined]
  arm A: 2/2 counted criteria met — vacuous: c1, c2
  arm B: 2/2 counted criteria met — vacuous: c1, c2
  arm C: 2/2 counted criteria met
  arm D: 2/2 counted criteria met — vacuous: c2
  c1 "one cycle per plateau" → cycles_per_plateau_within_limit: A=met (vacuous) B=met (vacuous) C=met D=met
    [A, B] 0 run(s) recorded for the plateau window … zero cycle/pass runs exist for this window; a zero run count satisfies the bound VACUOUSLY …
    [C]    1 run(s) recorded for the plateau window … (imagination_cycle_8c0b39bbedcd5e39_v3_c1) vs the limit of 1 — read from imagination_cycles rows …
    [D]    1 run(s) recorded for the plateau window … (cpass_a9853683edde7c2fa34e5b3a30a64b3f) vs the limit of 1 — read from cognitive_portfolios rows of kind 'first_pass' …
  c2 "no private text crosses" → no_private_text_in_shared_artefacts: A=met (vacuous) B=met (vacuous) C=met D=met (vacuous)
    [C]    the taint scan flagged 1 of 2 shared artefact(s) (14 private marker(s) checked); 0 of those flag(s) reproduced text that is NOT the
           packet's own allow-listed candidate material (attributed per flag: candidate_portfolio[0].hypothesis=allowed-field,
           candidate_portfolio[0].mechanism=allowed-field) — read from computeImaginationMetrics(...).privacy_leakage
```

- **c1** counts the runs the engine recorded for the plateau window — `imagination_cycles` for the
  one-identity arm, `cognitive_portfolios` (kind `first_pass`) for the team arm — and requires at most
  **1**, which is the mission's own wording. The control arms declare **0** (the pre-engine path has no
  cycle service), which satisfies the bound *vacuously*; the report says `vacuous` rather than reading
  it as evidence of quality.
- **c2** reads the taint scan the metrics view runs (`privacy_leakage`): the shared-scope artefacts
  scanned for the ten forbidden private keys and for markers lifted verbatim from this identity's
  private stores. **Nothing is hidden here**: arm `C`'s scan flags **1 of 2** artefacts, because the
  promoted Creative Baton carries `candidate_portfolio[i].hypothesis`/`.mechanism` — the packet's own
  allow-listed candidate material, which the compiler copies deliberately — and the scripted scenario
  emitted the *same sentence* for candidates the archive rejected as duplicates, so the marker rule
  reproduces verbatim. The evidence records both numbers (`flagged: 1`, `private_text_crossed: 0`)
  and each flag's field; a flag from a forbidden key, or from a marker reproduced anywhere that is
  not the packet's own candidate text, counts as crossing, and the tests prove that such a fixture
  reports a REGRESSION. Arm `D` promotes nothing, so its scan is vacuously clean and says so.
- **A verdict is REFUSED when it cannot be formed**: a criterion some arm cannot evaluate (no
  evidence block) makes the whole check `insufficient_data` with `regression: null` — no count is
  recorded in the store either — and a criterion *no* arm can evaluate (a predicate this harness does
  not implement, e.g. one that needs a live model) is EXCLUDED by name rather than counted as met.

The observation is recorded per arm in the store, so a later run with different portfolios can show a
regression without anyone re-reading this page.

## Blind grading

The harness does not judge ideas; an operator does. `--grade <file>` records the operator's blind
grades (novelty / coherence / testability / information gain, each 0..1) as observations:

```json
{ "grades": [ { "arm": "C", "novelty": 0.8, "coherence": 0.7, "testability": 0.6, "information_gain": 0.5, "n": 3, "note": "blind pass 1" } ] }
```

Without a grade file every `blind_*` metric is `insufficient_data` and the store carries placeholder
rows with `n = 0`, so the shape never changes and a later grade overwrites nothing.

## What this run does NOT prove

- No live MongoDB, no real model, no real mission. Every row comes from the frozen fixture
  (`tests/helpers/imagination-scenario.ts` + a scripted `llmService.extractJson`).
- Idea text is scripted on all four arms, so `agent_divergence` and every arm's `false_novelty` are
  `stub_determined`: they show the RULE and the plumbing (modes ⇒ different operators ⇒ different
  text), not that a real model's ideas diverge. On the comparator side the text is even more
  templated than a real pre-engine path would be — one sentence per concept, one per walk step — so
  its 0.833333 is a property of that script as much as of the path.
- The comparison is `like_for_like` in the RULE (one shipped `admitOrReplace` decided both sides) and
  the `false_novelty` reading now clears the brief's 0.3 target — but it is still a measurement of
  that rule over scripted text. The decisive metric (`useful_novelty_rate`) has no baseline side, so
  DoD bullet 8 remains **undemonstrated** by this fixture.
- The task-quality check's control-side evaluations are **vacuous** by construction (nothing ran,
  nothing was shared), and the treatment side's c2 flag is the duplicate-text artefact described
  above. Neither is evidence about a real deployment; both are labelled in the report and the store.

## Re-running, and turning this into evidence

```bash
cd server
# 1. regenerate the frozen checkpoint (only when the services change):
IMAGINATION_BASELINE_FIXTURE_WRITE=1 npx vitest run tests/unit/imagination-baseline-fixture.test.ts
# 2. re-measure and re-record:
node scripts/imagination-baseline.mjs
# 3. on a live deployment (one bounded mission, real Mongo, real model):
#    run one cycle + the team pass, export the same rows, and re-run the harness against them.
#    The stage-2 gate in docs/IMAGINATION-ROLLOUT.md then has a baseline that is evidence.
```
