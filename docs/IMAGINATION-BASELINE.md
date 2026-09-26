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
| experiment id | **`impexp_c4bbc105e90760b919a5b28f46eb225b`** |
| store | `docs/IMAGINATION-BASELINE.json` (`imagination_experiments` rows: one experiment, 49 observations) |
| arms | `A` `control_dreamer_retrieval` · `B` `control_mind_wander` · `C` `focused_engine_balanced` · `D` `engine_plus_heterogeneous_team` |
| comparison | baseline arms `A+B` vs treatment arms `C+D`, per `compareExperiment` |
| target | `useful_novelty_rate` — **≥30% better** (the brief's named target, overridable with `--target useful_novelty_rate=0.3`) |

The store's rows are in the collection's own shape, with the SAME derived ids
`registerExperiment` / `recordExperimentObservation` produce. `server/tests/unit/imagination-baseline-harness.test.ts`
proves it by loading them into the in-memory store and running the REAL `compareExperiment` over
them: its per-metric verdicts equal the harness's, and replaying any recorded observation through the
gated write finds it **unchanged** (same `observation_key`, same numbers).

## What each arm is

| Arm | Path | Generation | Determination |
| --- | --- | --- | --- |
| `A` | pre-engine dreamer-style retrieval: one idea per concept, ranked by graph degree | implemented in the harness (`controlArmA`) | `stub_determined` |
| `B` | pre-engine mind-wander over the graph; **both directions of every step**, undeduped — the restatements the archive was built to reject | implemented in the harness (`controlArmB`) | `stub_determined` |
| `C` | the focused engine, one balanced identity (`FOCUSED_IMAGINATION=1`), on the frozen checkpoint | captured from the real services in the fixture | `store_measured` |
| `D` | the engine plus the heterogeneous team (philosopher / analyst / strategist) | captured from the real services in the fixture | `store_measured` |

The two control arms are implemented IN the harness because the pre-engine path is not a service any
more. Their idea text is the harness's own, so every text-derived magnitude attributed to them is
`stub_determined` — including the dedupe they are measured against, which is the harness's own
re-implementation of the archive's containment rule (labelled as such in the report's basis).

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
fixture's captured rows (`store_measured`), depends on the scripted model's text
(`stub_determined`), or cannot be measured from this fixture at all (`insufficient_data`).

| Arm | metric | value | n | determination |
| --- | --- | --- | --- | --- |
| `A` | `arm_generated_candidates` / `arm_admitted_candidates` / `arm_rejected_candidates` | 4 / 3 / 1 | 4 | `stub_determined` |
| `A` | `false_novelty` | 0.25 | 4 | `stub_determined` |
| `A` | `useful_novelty_rate`, `idea_survival`, `cost_of_novelty`, `time_to_next_viable_direction`, `archive_coverage_gain`, `agent_divergence` | `insufficient_data` | 0 | `insufficient_data` |
| `B` | `arm_generated_candidates` / `arm_admitted_candidates` / `arm_rejected_candidates` | 8 / 4 / 4 | 8 | `stub_determined` |
| `B` | `false_novelty` | 0.5 | 8 | `stub_determined` |
| `B` | (the same six as `A`) | `insufficient_data` | 0 | `insufficient_data` |
| `C` | `arm_generated_candidates` / `arm_admitted_candidates` / `arm_rejected_candidates` | 6 / 4 / 2 | 6 | `store_measured` |
| `C` | `false_novelty` | 0.333333 | 6 | `store_measured` |
| `C` | `useful_novelty_rate` | 0.666667 | 3 | `store_measured` |
| `C` | `idea_survival` (declared proxy) | 0.75 | 4 | `store_measured` |
| `C` | `time_to_next_viable_direction` | 10 ms | 4 | `store_measured` |
| `C` | `archive_coverage_gain` | 4 new cells (of 16 807 possible) | 4 | `store_measured` |
| `C` | `cost_of_novelty` | `insufficient_data` — the recorded spend is 0 (the scripted model calls no provider), and an unrecorded/zero spend is **not** a cost of zero | 0 | `insufficient_data` |
| `C` | `agent_divergence` | `insufficient_data` — one stream, not a team | 0 | `insufficient_data` |
| `D` | `arm_generated_candidates` / `arm_admitted_candidates` / `arm_rejected_candidates` | **9** / 6 / 3 | 9 | `store_measured` |
| `D` | `false_novelty` | **0.333333** (3/9, not 3/6) | 9 | `store_measured` |
| `D` | `archive_coverage_gain` | 4 new cells (of 16 807 possible) | 4 | `store_measured` |
| `D` | `time_to_next_viable_direction` | 0 ms (the team pass stamps its own window) | 6 | `store_measured` |
| `D` | `agent_divergence` (closest-pair Jaccard, 3 agents) | 0.027778 | 3 | `stub_determined` |
| `D` | `agent_divergence_same_mode_control` | `insufficient_data` — the same-mode control belongs to the Phase-6 exit-criterion test, not to this experiment | 0 | `insufficient_data` |
| `D` | `useful_novelty_rate`, `idea_survival`, `cost_of_novelty` | `insufficient_data` — no outcome was ever recorded for the team arm | 0 | `insufficient_data` |

### The comparison (baseline `A+B` vs treatment `C+D`)

| metric | baseline | treatment | delta | relative gain | verdict |
| --- | --- | --- | --- | --- | --- |
| `useful_novelty_rate` | *(none — the pre-engine arms recorded no outcomes)* | 0.666667 (n 3) | — | — | `insufficient_data` |
| `false_novelty` (lower is better) | 0.416667 (n 12) | 0.333333 (n 15) | −0.083334 | 0.200001 | `not_improved` (the 30% target is not reached) |
| `task_quality_regression` | 2 criteria met (n 4) | 2 criteria met (n 4) | **none — the sides are exactly equal** | — | `equal` |

**Equality is stated, not rounded into a verdict.** Two readings that are the same number at the
reported precision (1e-6) are reported as `equal` by the ONE shared rule
(`compareMeasuredValues`, used by the experiment comparison AND by the metrics view's
window-over-window comparison): no delta is reported (there is none), no relative gain is formed, and
neither "improved" nor "not improved" is claimed. A difference *below* the reported precision is
reported the same way, with the reason saying so. The task-quality metric is the exactly-equal case
here: both sides meet 2 of 2 criteria, so the row reads `equal` instead of a `0` delta under a
"not improved" verdict.

**Overall verdict: `insufficient_data` for the decisive metric.** The brief's DoD bullet 8 asks for a
demonstration that useful novelty improves without a material task-quality regression. This fixture
cannot produce that demonstration, and it says so rather than inventing it:

- the CONTROL arms recorded no outcomes, so `useful_novelty_rate` has no baseline side at all. The
  pre-engine path never *recorded* whether an idea was useful — that channel is part of what the
  engine adds;
- the treatment's 0.666667 is two useful verdicts out of three recorded ones on a scripted model, so
  even that number is evidence about the *plumbing*, not about a real model's ideas;
- `false_novelty` is measurable on both sides — 0.416667 (5/12, the controls) against 0.333333
  (5/15, the treatments), a 20% relative gain, short of the brief's 30% target — which is the honest
  reading of a stub whose ideas are equally redundant on both paths;
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
- Idea text is the scripted model's, so `agent_divergence` and the control arms' `false_novelty` are
  `stub_determined`: they show the plumbing differs (modes ⇒ different operators ⇒ different text),
  not that a real model's ideas diverge.
- The adversarial reading of both sides' `false_novelty` is the honest one: the fixture's stub cannot
  show the engine's archive beating the pre-engine path (20% against a 30% target), and the harness
  says `not_improved` rather than smoothing it into a win.
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
