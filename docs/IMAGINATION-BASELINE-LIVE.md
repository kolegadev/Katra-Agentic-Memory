# The A/B evaluation — the BOUNDED LIVE RUN (ITER-11, WS-4 · DoD #8)

`docs/IMAGINATION-BASELINE.md` measures the **frozen checkpoint** — a fixture whose arm text is
scripted on both sides. This file records the **live run**: the same four arms over the same
checkpoint material, but against a **real store** and a **real model**, with a **blinded judge**
recording an outcome for every candidate on **both** sides. It is the evidence the reviewer's
condition (a) asked for: *run one bounded live mission on real Mongo with a real model, record
outcomes on both sides (≥5 per side), supply `--grade` blind grades for at least one arm, and
re-run `node scripts/imagination-baseline.mjs`.*

## What was run, and with what

| | |
| --- | --- |
| run token | `live-20260926-092417` |
| store | the live MongoDB (`katra`) — the deployment's own, written under the run's own namespaced identities and missions |
| model | `deepseek-flash` — every treatment candidate, every salience trace, and the judge |
| judge | `deepseek-flash`, **blinded**: opaque case ids, deterministic interleave (shuffle seed `20260926`), a frozen prompt recorded with its sha256 `f232a9ce…`; 35 cases in 4 calls, 0 refusals, 10 644 input / 11 743 output tokens |
| instrument | `server/tests/live/imagination-baseline-live.test.ts` (skips unless `IMAGINATION_BASELINE_LIVE=1`; refuses, by name, any missing identity/run token/output path) |
| bounds | 35 candidates judged (bound 60, raised deliberately after the first complete attempt produced 48), one engine cycle, one team first pass |
| flags | `FOCUSED_IMAGINATION`, `CREATIVE_BATON_PROMOTION`, `COGNITIVE_TEAM_ALLOCATION` **in the instrument process only**. The deployment runs with all four flags off; nothing the run wrote changes any process's configuration |
| wrote / deleted | counted by the run's namespaces, from the capture's own `written` block: 35 outcomes, 35 candidate seeds, 25 archive cells, 25 lineages, 1 cycle, 4 engine runs, 6 salience traces, 6 consolidation runs, 1 team portfolio, 3 inheritance envelopes, 1 baton + 1 promotion, 2 mission states, 4 graph nodes + 4 edges, 35 trigger evaluations, 12 mission events, 6 ledger entries, 4 state deltas, 2 work items. **Nothing was deleted or overwritten** |

```bash
# the whole live evaluation, from a checkout of this tree on a machine that can reach the store
IMAGINATION_BASELINE_LIVE=1 IMAGINATION_BASELINE_USER=<sandbox identity> \
IMAGINATION_BASELINE_RUN=<fresh run token> IMAGINATION_BASELINE_OUT=<capture.json> \
  npx vitest run tests/live/imagination-baseline-live.test.ts

node scripts/imagination-baseline.mjs \
  --fixture <capture.json> --store <store.json> --grade <capture-GRADES.json>
```

### The run's configuration (recorded, because an unrecorded override is an unreproducible run)

The first complete run of this instrument used the deployment's default ceilings and **failed**: the
estate's canonical model is a *reasoning* model whose reasoning tokens count against `max_tokens`,
and the engine's own defaults — `FOCUSED_CONSOLIDATION_MAX_TOKENS` **2000**,
`FOCUSED_IMAGINATION_MAX_TOKENS` **3000** — truncate its first JSON reply mid-array. The run that
produced the evidence above set:

| knob | value used | the default it replaces |
| --- | --- | --- |
| `FOCUSED_CONSOLIDATION_MAX_TOKENS` | 16 000 | 2000 |
| `FOCUSED_CONSOLIDATION_TIMEOUT_MS` | 300 000 | 60 000 |
| `FOCUSED_IMAGINATION_MAX_TOKENS` | 16 000 | 3000 |
| `FOCUSED_IMAGINATION_TIMEOUT_MS` | 300 000 | 60 000 |
| `IMAGINATION_CYCLE_MAX_TOKENS_PER_WINDOW` | 200 000 | 20 000 |
| judge batch ceiling | 3 000 + 1 000 per case (capped at the provider's accepted 16 000) | — |
| `IMAGINATION_BASELINE_MAX_CANDIDATES` | 60 | 40 |

At the time of the run those values lived in an **uncommitted runner script**; a reviewer flagged
that the capture did not carry them, so the instrument now records every knob it read — raw value
plus the default the accessor documents — in the capture's `model_environment` block, and prints a
`RUN CONFIGURATION` disclosure line. The numbers above are the ones that run used and the ones this
document is accountable for. **None of them is a deployment change**: the deployment's `.env` is
untouched and the rollout decides the production values before `FOCUSED_IMAGINATION` is switched on
(see the stage gate in `docs/IMAGINATION-ROLLOUT.md`).

## The arms, as the store recorded them

| arm | path | generated | admitted | rejected | outcomes recorded | useful | variance | cost | tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `A` | pre-engine dreamer-style retrieval | 4 | 1 | 3 | 4 | **0** | 4 | 0 | 0 |
| `B` | pre-engine mind-wander | 8 | 1 | 7 | 8 | **0** | 8 | 0 | 0 |
| `C` | focused engine, one balanced identity | 8 | 8 | 0 | 8 | **7** | 1 | 0 | 31 664 |
| `D` | engine + heterogeneous team (3 identities) | 15 | 15 | 0 | 15 | **14** | 1 | 0 | 28 926 |

Every candidate each arm generated was judged — admitted **and** rejected — so each side's
denominator is the set the judge actually saw, not the set the archive kept.

## The comparison (baseline `A+B` vs treatment `C+D`)

| metric | comparability | baseline | treatment | delta | relative gain | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `useful_novelty_rate` | `like_for_like` | **0 (n 12)** | **0.913043 (n 23)** | +0.913043 | *(not formed)* | `insufficient_data` — **the baseline reads 0, so a relative gain cannot be formed from it** |
| `false_novelty` (lower is better) | `like_for_like` | 0.833333 (n 12) | 0 (n 23) | −0.833333 | 1.0 | **`improved`** (the 0.3 target is reached) |
| `time_to_next_viable_direction` (lower is better) | `like_for_like` | 27 273 ms (n 2) | 66 343 ms (n 23) | +39 070 ms | −1.432554 | `not_improved` |
| `task_quality_regression` | `like_for_like` | 2 criteria met (n 4) | 2 criteria met (n 4) | none — exactly equal | — | `equal` (no regression) |

## What the numbers do, and do not, say

- **Both sides of the decisive metric now exist** — for the first time: a store-recorded outcome
  for every candidate on the baseline side (n 12) and the treatment side (n 23). The absolute
  reading is 0 → 0.913043.
- **The decisive metric's VERDICT is refused, by its own rule**: a *relative* gain cannot be formed
  over a zero baseline, and the shipped rule says so in one place used by both the harness and
  `compareMeasuredValues` (`imagination-experiments.ts`). Nothing was adjusted to make the word
  `improved` appear.
- **`time_to_next_viable_direction` — the bullet's alternative metric — reads `not_improved`.**
  The engine is *slower* to its first admitted candidate (66 s vs 27 s) than the comparators are:
  it makes model calls and runs an archive, they emit candidates directly. At this bound the
  timing metric does not favour the engine, and that is reported rather than hidden.
- **`false_novelty` now improves on a REAL model** (0.833333 → 0), not just on scripted text: the
  comparators restated their own material (10 of 12 candidates), the engine's candidates were not
  duplicates of anything already stored (0 of 23).
- **Task quality is untouched** (2/2 criteria on both sides, `equal`).
- **The baseline arms' TEXT is still the checkpoint's scripted comparator templates.** The harness
  prints that beside every magnitude (`text_is_scripted` on `A` and `B`): the baseline's *procedure*
  is the pre-engine path's own (degree-ranked retrieval, an undeduped walk), its *sentences* are the
  frozen fixture's. The treatment side's text is a real model's. **Superseded** by the control fix below
  (`live-20260926-141331`): the comparators now answer the real model on the same graph material, so
  all four arms' text is model-written and no magnitude is `stub_determined`.
- **The blinding is structural, not textual.** No case carried an arm label, an identity or a seed id, and the cases were interleaved across arms — but a candidate's own text is judged as written, and **2 of the 35** cases mention one of the run's mission ids inside their own `cheapest_test` field (a real candidate can name its mission). The instrument now counts those mentions into every capture it writes.
- **The judge is a language model of the same family that wrote the treatment text.** Self-preference
  is possible; the prompt, the shuffle seed and every raw reply are recorded so the reading can be
  re-scored by another judge or by a person without re-running anything.
- **No container executed the engine.** The services ran in the instrument process, against the live
  store and the deployed model provider. Turning `FOCUSED_IMAGINATION` on inside the deployment is
  the stage-gated rollout decision, not this experiment's.

## What the live run found that the fixture could not (all fixed before the run above passed)

Seven earlier attempts failed, each for a **real** reason that only a live store and a live
model can produce (six distinct causes) — every one of them is now either fixed in the instrument or raised as a
deployment finding:

| attempt failed with | what it was | what changed |
| --- | --- | --- |
| `MONGODB_URI` authentication failure (twice: once at connect, once late in a run) | the host's default Mongo port belongs to another project; the deployment's Mongo publishes no host port, so the run reaches it by its container address | the runner derives the store address from the deployment's own `.env`; the late failure remains **not fully explained** (a 200-second idle-then-write probe against the same URI did not reproduce it) and is recorded here rather than papered over |
| malformed / truncated model JSON | **a deployment finding**: the estate's canonical model is a *reasoning* model, its reasoning tokens count against `max_tokens`, and the engine's default ceilings (`FOCUSED_CONSOLIDATION_MAX_TOKENS` 2000, `FOCUSED_IMAGINATION_MAX_TOKENS` 3000) truncate the JSON → the run discloses raised ceilings (16 000) until the rollout decides the production values |
| `E11000 … knowledge_relationships from_to_type` | the store's edge index is GLOBAL on `(from_id, to_id, relationship_type)` | `SeedOptions.idPrefix` (default none — the fixture's bytes unchanged) so a run's graph is its own |
| `E11000 … idea_seeds is_seed_unique` | `seed_id` is GLOBALLY unique, not per identity or mission | the live driver namespaces its comparator candidate ids with its run token |
| `the archive … control_a_01 was already stored` | the comparators' candidate ids repeat across runs under one identity | every sandbox identity carries the run token |
| 48 candidates > the 40 default bound | the real model's operator plan produces more candidates than the stub | the bound was raised **deliberately** to 60 and recorded |

## Retest after the ceilings were reset in the deployment (2026-09-26, run token `live-20260926-101239`)

The deployment's `.env` now carries the five values the first run had to supply ad hoc —
`FOCUSED_CONSOLIDATION_MAX_TOKENS=16000`, `FOCUSED_IMAGINATION_MAX_TOKENS=16000`,
`IMAGINATION_CYCLE_MAX_TOKENS_PER_WINDOW=200000`, and 300 000 ms for both timeouts — verified
inside the running container (`printenv`), with the four feature flags still off. The whole live
evaluation was then **re-run with no ad-hoc overrides**: the runner reads those values from the
deployment's own `.env`, refuses to start if any is missing, and the capture's `model_environment`
block records them (raw value beside the default each one replaces).

| | |
| --- | --- |
| first call that the defaults truncated | **succeeded** — the engine ran end to end (cycle, team first pass, traces) |
| candidates judged | 38 (A 4, B 8, C 8, D 18), 0 judge refusals, 0 outcome refusals |
| `useful_novelty_rate` | baseline **0 (n 12)** vs treatment **1 (n 26)** — the relative verdict is still refused over a zero baseline |
| `false_novelty` | **`improved`** — 0.833333 (n 12) → 0 (n 26) |
| `time_to_next_viable_direction` | `not_improved` — 32 838.5 ms (n 2) vs 72 202.8 ms (n 26) |
| `task_quality_regression` | **`equal`** (2/2 criteria both sides) |
| judge | `deepseek-flash`, prompt sha256 `f232a9ce…` unchanged, shuffle seed `20260926`, 38 cases in 4 calls |

The retest is a *second bounded live run*, not a re-scoring: fresh sandbox identities and missions,
the run's own graph ids, its own outcome rows. Its raw artefacts are in the private repository under
`imagination/evidence/live-run-20260926-101239/`.

## The control fix, and the reading it produced (2026-09-26, run token `live-20260926-141331`)

The two runs above shared one confound, and it was the one that mattered: the **comparators' text was
the fixture's scripted templates** while the treatment arms' text was a real model's, so the judge's
0/12 vs 21/23 measured template prose against model prose at least as much as pre-engine against
engine — and the one `improved` row (`false_novelty`) sat under the same confound, because template
text is self-similar by construction. The independent review named the remedy: an A/B where **both
sides answer the real model**, same blind judge, ≥5 outcomes per side.

The comparators now do. One call per arm, from the mission's own graph material and nothing else (no
salience traces, no operator families, no archive, no novelty instruction), one candidate per item —
and **only that one variable moved**: the items, ids, operators, bins, evidence refs and structure are
the template builders' own, so the frozen fixture's output (and its byte-compare gate) is untouched. A
short or padded reply refuses the whole arm by name rather than silently changing the denominator; each
arm's `admission_rule.text_is_scripted` now reads `false` and its `generation.determination`
`store_measured`; the prompts are pure functions of the recorded `baseline_material`, and their sha256
and the verbatim system prompt ride in the capture's `comparator_text` block.

| | |
| --- | --- |
| comparator calls | `A` 4 items (418 in / 3 493 out), `B` 8 items (449 in / 1 798 out) — `deepseek-flash`, prompt sha256 `d001e6aa…` / `dcbe927b…` |
| arms as the store recorded them | `A` 4 generated / **1 useful** · `B` 8 / **3** · `C` 8 / **8** · `D` 14 / **14** |
| judge | 34 cases in **7 calls at batch size 5**, **0 refusals**, all 34 outcomes recorded (`IMAGINATION_BASELINE_JUDGE_BATCH_SIZE=5`, `…_JUDGE_MAX_TOKENS=16 000`, both recorded in the capture) |
| `useful_novelty_rate` | **`improved`** — baseline 0.333333 (n 12) vs treatment 1 (n 22); relative gain **+2.0** against the named 0.3 target |
| `false_novelty` | **`equal`** — 0 (n 12) vs 0 (n 22) |
| `time_to_next_viable_direction` | `not_improved` — 53 851 ms (n 12) vs 67 598 ms (n 22); a *fair* race now, both sides making model calls |
| `task_quality_regression` | `equal` (2/2 criteria both sides) |

**The reading was fixed before the run.** The disposition was pre-committed in the private record
(`imagination/DOD8-PRECOMMIT-control-fix-20260926.md`, committed ahead of this run): comparator useful
count > 0 **and** engine > comparator ⇒ DoD #8 passes by the bullet's letter. It does — 4 useful of 12
against 22 of 22, `like_for_like`, named target reached.

**What changed in the record, and what did not** — stated plainly, because the two earlier summaries
now read differently:

- `false_novelty`'s `improved` row is **gone** (0 → 0, `equal`): it was the template artefact. The
  comparators, answering the model, produce no seen-before candidates — so the engine's advantage on
  that metric was an artefact of the control, and the record now says so.
- The zero-baseline refusal is **gone too**, and not by tuning: the fair control genuinely produces
  useful candidates sometimes (1 in 4, and 3 in 8). The metric can form a ratio, and the ratio favours
  the engine.
- `time_to_next_viable_direction` stays `not_improved`, and it means more now: with real model calls on
  both sides the engine is still slower to its first admitted candidate (67.6 s vs 53.9 s), because a
  cycle does strictly more per candidate than one retrieval call does.
- `task_quality_regression`'s `equal` still rests on a comparator side whose criteria are **vacuous by
  construction** (a control run promotes no baton, so there is nothing shared to scan). Pre-committed as
  a standing residual; the decisive row is useful novelty.
- **Cost, honestly**: the engine's cost per *useful* candidate (3 310 and 2 208 tokens for `C`/`D`) is
  **higher** than arm `B`'s (749). The engine's case is the rate, not cost-efficiency.

One bounded run on one frozen checkpoint, one run per arm — not a distribution. The judge is a model,
disclosed and re-scorable from the transcript. Raw artefacts: the private repository,
`imagination/evidence/live-run-20260926-141331/` — and `…-140241/`, the first attempt, kept because it
is the finding that made the judge's batch size an experiment parameter (with every candidate
model-written, two ten-case batches spent their whole output ceiling on reasoning and returned nothing
usable, so 22 of 35 cases were refused by name: recorded, not papered over).

## Where the raw evidence lives

The private long-horizon repository, `imagination/evidence/live-run-20260926-092417/`:
`capture.json` (the arms, the capture disclosure, the task-quality evidence), `capture-GRADES.json`
(the `--grade` blind scores), `capture-JUDGE.json` (the judge's prompt, mapping, raw replies and
per-call token usage), `STORE.json` (the experiment-shaped rows the rollout gate reads),
`harness.log` (the printed report), `run.log` and the progress log. Those files carry the host's
own details, which is why they are not in this repository.
