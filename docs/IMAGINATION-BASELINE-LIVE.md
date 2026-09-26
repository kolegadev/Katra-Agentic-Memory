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
| wrote / deleted | 35 outcomes, 8 + 15 candidates, 2 cycles, 3 team portfolios, 1 baton, 4 missions, 16 graph rows — counted by the run's namespaces. **Nothing was deleted or overwritten** |

```bash
# the whole live evaluation, from a checkout of this tree on a machine that can reach the store
IMAGINATION_BASELINE_LIVE=1 IMAGINATION_BASELINE_USER=<sandbox identity> \
IMAGINATION_BASELINE_RUN=<fresh run token> IMAGINATION_BASELINE_OUT=<capture.json> \
  npx vitest run tests/live/imagination-baseline-live.test.ts

node scripts/imagination-baseline.mjs \
  --fixture <capture.json> --store <store.json> --grade <capture-GRADES.json>
```

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
  frozen fixture's. The treatment side's text is a real model's.
- **The judge is a language model of the same family that wrote the treatment text.** Self-preference
  is possible; the prompt, the shuffle seed and every raw reply are recorded so the reading can be
  re-scored by another judge or by a person without re-running anything.
- **No container executed the engine.** The services ran in the instrument process, against the live
  store and the deployed model provider. Turning `FOCUSED_IMAGINATION` on inside the deployment is
  the stage-gated rollout decision, not this experiment's.

## What the live run found that the fixture could not (all fixed before the run above passed)

Each of the five earlier attempts failed for a **real** reason that only a live store and a live
model can produce — every one of them is now either fixed in the instrument or raised as a
deployment finding:

| attempt failed with | what it was | what changed |
| --- | --- | --- |
| `MONGODB_URI` authentication failure | the host's default Mongo port belongs to another project; the deployment's Mongo publishes no host port | the runner derives the store address from the deployment's own `.env` |
| malformed / truncated model JSON | **a deployment finding**: the estate's canonical model is a *reasoning* model, its reasoning tokens count against `max_tokens`, and the engine's default ceilings (`FOCUSED_CONSOLIDATION_MAX_TOKENS` 2000, `FOCUSED_IMAGINATION_MAX_TOKENS` 3000) truncate the JSON → the run discloses raised ceilings (16 000) until the rollout decides the production values |
| `E11000 … knowledge_relationships from_to_type` | the store's edge index is GLOBAL on `(from_id, to_id, relationship_type)` | `SeedOptions.idPrefix` (default none — the fixture's bytes unchanged) so a run's graph is its own |
| `E11000 … idea_seeds is_seed_unique` | `seed_id` is GLOBALLY unique, not per identity or mission | the live driver namespaces its comparator candidate ids with its run token |
| `the archive … control_a_01 was already stored` | the comparators' candidate ids repeat across runs under one identity | every sandbox identity carries the run token |
| 48 candidates > the 40 default bound | the real model's operator plan produces more candidates than the stub | the bound was raised **deliberately** to 60 and recorded |

## Where the raw evidence lives

The private long-horizon repository, `imagination/evidence/live-run-20260926-092417/`:
`capture.json` (the arms, the capture disclosure, the task-quality evidence), `capture-GRADES.json`
(the `--grade` blind scores), `capture-JUDGE.json` (the judge's prompt, mapping, raw replies and
per-call token usage), `STORE.json` (the experiment-shaped rows the rollout gate reads),
`harness.log` (the printed report), `run.log` and the progress log. Those files carry the host's
own details, which is why they are not in this repository.
