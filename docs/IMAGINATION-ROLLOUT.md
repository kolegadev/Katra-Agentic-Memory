# Imagination observability — canary and rollout policy (ITER-9, Phase 7 · tightened in ITER-10)

Branch `feat/imagination-engine` · the observability layer is **read-only** except one gated
experiment write.

Policy file: `docs/IMAGINATION-ROLLOUT.md` (this page). Dashboard view:
`/api/v1/imagination/rollout`.

This runbook is the operator's side of the imagination feature. It states the read scope every view
obeys, the staged rollout (per-identity personality → focused imagination → baton promotion →
cognitive team), the metric gates each stage has to pass, the kill switches, the executable rollback
commands and what to watch.

Two things are checked mechanically, so this page cannot drift away from the code:

- every kill switch and environment variable named here is the name the code actually reads
  (`server/src/routes/imagination-dashboard-routes.ts` derives the rollout view from those same
  functions — `perIdentityPersonalityEnabled()`, `focusedImaginationEnabled()`,
  `creativeBatonPromotionEnabled()`, `cognitiveTeamAllocationEnabled()`, `killSwitchActive()`);
- the dashboard's **Rollout** view (`GET /api/v1/imagination/rollout`) reads the flag and
  kill-switch state from the running process, so it reports what is actually on rather than what
  this page claims. If the two ever disagree, the view is right.

## Read scope — the caller's own identity by default, everything else on request (ITER-10 F4)

Every view of `/api/v1/imagination` is read for **one identity by default: the caller's own** — for a
trusted caller too. Trust no longer widens a read on its own; an operator who wants another
identity's rows has to say so. The scope in force is stated IN the payload, so a response can never
be mistaken for a wider or narrower read than it is:

| `scope.kind` | What was read | How to ask for it |
| --- | --- | --- |
| `caller` | the caller's own identity — the DEFAULT, for trusted and untrusted callers alike | no parameter (or, for an untrusted caller, any parameter: they are ignored) |
| `named` | exactly ONE identity | `?user_id=<identity>` from a **trusted** caller |
| `all` | every identity | `?all_identities=1` from a **trusted** caller, on a view that can span identities |

- `scope.identities` says how many identities the payload's rows actually span: the single identity
  a pinned read covers (1), and for `all` the number of distinct identities found (0 when none).
- **An untrusted caller's `user_id` and `all_identities` are ignored, never honoured** — the read
  stays pinned to the caller and a non-owner sees no row, no marker text and no existence leak.
- `user_id` wins when both are supplied: the narrower instruction is the one honoured, so a read can
  never widen by accident.
- The views that can span identities are `/overview`, `/cycles`, `/cycles/:cycleId`, `/traces`,
  `/batons` (whose default is the caller's own batons plus the **promoted** — shared — artefact, the
  one surface this feature shares) and `/rollout` (only for its deprecation-counter block: the flag
  and kill-switch blocks it reports are process state and span no identity). `/archive`, `/team`,
  `/metrics`, `/experiments` and `/experiments/compare` are measured for exactly ONE identity, so
  `all_identities` is not offered there and their payload states `caller` or `named`.
- `GET /api/v1/imagination/rollout` reports the running process's flags and kill switches, which span
  no identity — but since ITER-11 it also carries the deprecation counters, which ARE identity rows,
  so it states the scope of THAT block: the caller's own identity by default, one named identity or
  every identity only for a trusted caller that asked (`scope` at the top level and inside
  `deprecation_telemetry`).
- The one write (`POST /experiments/observations`) is **caller-owned by construction** — the row's
  `user_id` is the caller's own — and its payload states `scope: { kind: "caller", identities: 1 }`.
  A `note` is capped at 2000 characters by `EXPERIMENT_NOTE_MAX_LENGTH` (the same constant the MCP
  schema caps with, so the two cannot drift); anything longer is refused by name as `note_too_long`
  before a row is touched, at the route and at the service alike.

## The traces basis, and a cost that is never reported as free (ITER-10 F1, F3)

Two more things worth knowing before reading a payload:

- **`/traces` carries a view-level `basis`** of the same house shape the metrics carry — `window`
  (`from`/`days` null: a live listing, not a windowed rate, with `to` the moment of the read), `n`
  (the rows returned), `sources` and `measurement`. No view's number is left without one.
- **`cost_of_novelty` is `insufficient_data` when the spend is UNRECORDED**, not 0: it reports `ok`
  only when at least one included cycle recorded a non-zero `budget.tokens_spent_this_cycle`. A
  window with useful candidates but no recorded spend states that the spend is unrecorded rather
  than reading as "free" (the zero-denominator case keeps its own, different, stated reason).

## Deployment precondition — inherited from ITER-2 (server and bridge deploy together)

`GET /api/v1/admin/personality` is **caller-pinned and authenticated**: it resolves the caller's own
identity record and requires a key, and `?user_id=<another identity>` requires the admin key. From
ITER-2 the Kolega Code bridge does exactly that — `kolega_katra_bridge/config.py`
(`_fetch_server_personality`) sends `Authorization: Bearer <api_key>` with `?user_id=<its identity>`,
caches per identity, and reports a rejected key once per cache window ("personality sync rejected the
bridge key; continuing with the local personality") instead of failing open in silence.

A bridge still running the pre-ITER-2 fetch (a plain `client.get(url)`, no `Authorization` header) is
rejected by this server and **fails open**, so the dashboard silently stops governing its retrieval.
**Deploy the bridge with — or before — the server change.** Verify from the bridge host:

```bash
python3 integrations/kolega-code/scripts/test_bridge_personality_fetch.py
node scripts/generate-personality-registry.mjs --check
```

## Staged rollout

One stage at a time, in this order. Each stage is a flag; a stage is only promoted to the next when
its gates pass on the **metrics view** (`GET /api/v1/imagination/metrics`, or the
`get_imagination_metrics` MCP tool) for the identities the change touches. Every gate names a metric
that reports its own `basis` (window, n, sources) and says `insufficient_data` below its documented
minimum — a gate that cannot be measured is not a gate that passed.

| # | Stage | Flag (default off) | Gates to pass | What to watch |
| --- | --- | --- | --- | --- |
| 1 | Per-identity personality | `PER_IDENTITY_PERSONALITY` | `personality_stability.violations = 0`; the bridge fetches with its own key and reports no rejection | `personality_stability`, inheritance-envelope refusals |
| 2 | Focused imagination (private) | `FOCUSED_IMAGINATION` | `useful_novelty_rate.status = ok` (n ≥ 5 recorded outcomes); `false_novelty` at or below the **recorded baseline** — experiment `impexp_daba0176f662f4776203fff7a2c5b4be`, arms `A+B` (control, pooled) vs `C+D` (treatment), metrics **`false_novelty`** and **`useful_novelty_rate`** as recorded in `docs/IMAGINATION-BASELINE.json` (verdict block: `comparison.metrics[]`) and reported in `docs/IMAGINATION-BASELINE.md`; `cost_of_novelty.status = ok` (denominator > 0); **and the model ceilings are sized for a reasoning model BEFORE the flag is set** — `FOCUSED_CONSOLIDATION_MAX_TOKENS` and `FOCUSED_IMAGINATION_MAX_TOKENS` ≥ 16000, `IMAGINATION_CYCLE_MAX_TOKENS_PER_WINDOW` ≥ 200000. **These are now SET in this deployment** (2026-09-26: 16000 / 16000 / 200000 with 300 000 ms timeouts, verified inside the running container with `printenv`), so this clause of the gate is satisfied; the retest in `docs/IMAGINATION-BASELINE-LIVE.md` re-ran the whole live evaluation reading those values from the deployment's own `.env`, and the engine's first JSON call — the one the defaults truncated — succeeded (38 candidates, 0 judge refusals, 38 outcomes recorded). A deployment WITHOUT them would still fail this clause: the canonical model's reasoning tokens count against `max_tokens`, and the defaults (2000 / 3000 / 20000) truncate the first reply | `useful_novelty_rate`, `false_novelty`, `cost_of_novelty`, `time_to_next_viable_direction` |
| 3 | Baton promotion (shared scope) | `CREATIVE_BATON_PROMOTION` | `privacy_leakage.flagged = 0` across every shared artefact scanned; no promotion refusal other than `flag_off` | `privacy_leakage`, `idea_survival`, `archive_coverage_gain` |
| 4 | Cognitive team allocation | `COGNITIVE_TEAM_ALLOCATION` | `agent_divergence` above `agent_divergence_same_mode_control` (the team must diverge more than one mode does); `personality_stability.violations = 0` | `agent_divergence` vs its same-mode control, `personality_stability` |

**Stage 2's baseline is RECORDED, not deferred** (ITER-11, WS-4). The number the gate compares
against comes from the harness in `server/scripts/imagination-baseline.mjs`, run over the frozen
checkpoint and stored as an experiment in `imagination_experiments` form:

| | |
| --- | --- |
| experiment | `impexp_daba0176f662f4776203fff7a2c5b4be` (`imagination-baseline-vs-engine (ITER-11 WS-4)`) |
| store | `docs/IMAGINATION-BASELINE.json` · report: `docs/IMAGINATION-BASELINE.md` |
| arms | `A` dreamer retrieval · `B` mind-wander (controls) · `C` focused engine, balanced · `D` engine + heterogeneous team |
| metric keys the gate uses | `false_novelty` (lower is better, target 0.3), `useful_novelty_rate` (higher is better, target 0.3 — the brief's "≥30% better useful novelty"), plus `task_quality_regression` and `time_to_next_viable_direction` |
| **what is compared** | baseline arms `A+B` (the pre-engine comparators) vs treatment arms `C+D` (the engine, and the engine with a heterogeneous team) over ONE frozen checkpoint; **one rule decided both sides** — every arm's candidates were admitted/rejected by the shipped `IdeaArchiveService.admitOrReplace` (the comparators' in the fixture generator, the treatments' inside the engine), so the difference between the sides is the difference between the paths, not between two rules. The artefact records this per arm (`comparison.admission_rule_per_arm`) and derives `comparability` from it |
| recorded verdict, FIXTURE (`comparison.metrics[]` in `docs/IMAGINATION-BASELINE.json`) | `false_novelty` **improved** — baseline 0.833333 (10/12) vs treatment 0.333333 (5/15), delta −0.5, relative gain **0.6**, `comparability: like_for_like`; `useful_novelty_rate` **insufficient_data** (the control arms recorded no outcomes — no baseline side exists); `task_quality_regression` **equal** (2/2 counted criteria on every arm — the sides are exactly equal, so the row reports equality and no delta) |
| honest reading | the recorded baseline is a STUB measurement in one deliberate sense — the candidate TEXT is scripted on all four arms (the comparators' templates, the stub model's seeds) — so the gate is a shape the deployment must fill with its own live numbers; the harness marks every number `store_measured` / `stub_determined` / `insufficient_data` and never reports a stub as evidence. The `false_novelty` gain is real and *like-for-like* (one shipped rule on both sides) but bounded by that script: the comparators restate one template (arm `A`'s mechanism sentence varies only with degree, and the fixture's four concepts share degree 2) and both directions of every wander step, which the shipped rule catches at 10 of 12. The task-quality check evaluates each of the mission's success criteria with its OWN predicate (`c1` = at most one run for the plateau window, `c2` = the taint scan crossing nothing) and REFUSES a verdict it cannot form. Arm `C`'s taint scan flags 1 of 2 shared artefacts — the promoted baton reproducing the candidates' own allow-listed text, which the scripted stub also emitted for two rejected duplicates — and the evidence records the audit's raw count beside the attributed crossing count (0) instead of hiding either. **The live run supplies the baseline side the fixture could not** (ITER-11, DoD #8 closure): `docs/IMAGINATION-BASELINE-LIVE.md` records one bounded live run over the same checkpoint material on the real store with the real model, with a blinded judge and store-recorded outcomes on BOTH sides — `useful_novelty_rate` baseline **0 (n 12)** vs treatment **0.913043 (n 23)** (the relative verdict is refused over a zero baseline), `false_novelty` **improved** (0.833333 → 0), `time_to_next_viable_direction` **not_improved** (the engine is slower to its first admitted candidate), `task_quality_regression` **equal**. Its raw artefacts (capture, judge transcript, grades, store, harness report) are archived in the private repository under `imagination/evidence/live-run-20260926-092417/`. **Stage 2 remains a gate the deployment must pass with its OWN numbers**: the live run's reading is about the frozen checkpoint on the live store, not about production traffic, and the flag stays off until the ceilings above are set and the deployment's own `useful_novelty_rate` and `false_novelty` are recorded over a live window |

Re-measure at any time (dependency-free Node, no Mongo, no provider):

```bash
cd server && node scripts/imagination-baseline.mjs --help
cd server && node scripts/imagination-baseline.mjs          # rewrites docs/IMAGINATION-BASELINE.json
```

Its rows are the collection's own shape with the same derived ids, so `compareExperiment` (and the
`/experiments/compare` view) reads the recorded baseline unchanged.

Stages 2–4 are independent flags, but the **gates are not**: promotion (3) only means anything once
2 has run and written something to promote, and the team (4) is measured over first-pass portfolio
records that only exist once its own flag is on.

### Where the metrics come from

| Metric | What it is | Minimum before it reports a number |
| --- | --- | --- |
| `useful_novelty_rate` | recorded outcomes whose verdict is `useful_information`, over every recorded outcome | 5 outcomes |
| `archive_coverage_gain` | mean `new_cells` per cycle over the window, plus the live cell total and the newest cycle's gaps | 1 cycle |
| `idea_survival` | **proxy**: admitted candidates carrying a recorded outcome, over every admitted candidate | 1 admitted candidate |
| `time_to_next_viable_direction` | median gap between a cycle's trigger and its first admitted candidate | 1 measurable cycle |
| `false_novelty` | generated candidates rejected as `duplicate_of` / `paraphrase_of` / `excluded_region`, over every generated candidate | 5 generated candidates |
| `agent_divergence` | mean pairwise statement similarity across agents (the archive's own metric), plus the same-mode control | 2 agents |
| `privacy_leakage` | an **audit count**: shared-scope artefacts carrying a forbidden private key or a marker lifted from this identity's private stores | n/a — a count with its scanned-row basis |
| `cost_of_novelty` | measured tokens per distinct useful candidate; `ok` only when at least one included cycle recorded a non-zero token count | denominator > 0 **and** a recorded spend (a zero denominator keeps its own stated reason; an unrecorded spend is `insufficient_data` too, **not** 0) |
| `personality_stability` | stored envelopes and mode assignments that fail re-verification (expected 0) | n/a — a count with its basis |

The measurement window defaults to 14 days; override it per call with `window_days`, or for a
deployment with `IMAGINATION_METRICS_WINDOW_DAYS`.

## Kill switches (no rebuild, no code change)

| Switch | Environment variable | What it does | Verify |
| --- | --- | --- | --- |
| Per-identity personality | `PER_IDENTITY_PERSONALITY` | removal returns resolution and writes to the legacy global record; nothing else changes | `get_my_personality`, Rollout view |
| Focused imagination | `FOCUSED_IMAGINATION` | disables the whole ITER-5/6/7/9 surface: the tools are `Unknown tool`, the `/api/v1/imagination` views say so, nothing is written and no model call is made | Rollout view (`flags[].on`) |
| Baton promotion | `CREATIVE_BATON_PROMOTION` | promotion stops; cycles still compile PRIVATE batons and record `promotion_skipped: flag_off` | `GET /api/v1/imagination/batons` (`promotion_flag`) |
| Cognitive team | `COGNITIVE_TEAM_ALLOCATION` | the team layer (modes, envelopes, allocations, first pass, synthesis) is disabled; the team view states why it is empty | Rollout view |
| Cognitive activation | `COGNITIVE_ACTIVATION_KILL_SWITCH=1` | forces `COGNITIVE_SCHEDULER_MODE` to `off` regardless of every other flag | Rollout view (`kill_switch_active`) |
| Cognitive plane | `COGNITIVE_CONTROL_ENABLED` | `off` disables the Phase 7 cognitive-control plane and its views (no back door) | Rollout view (`plane`) |

**Flag off (env + restart):**

```bash
# In the deployment directory (the .env that docker compose reads):
echo 'FOCUSED_IMAGINATION=' >> .env
docker compose up -d --force-recreate --wait server
```

**Kill switch armed (env + restart) — the widest stop:**

```bash
echo 'COGNITIVE_ACTIVATION_KILL_SWITCH=1' >> .env
docker compose up -d --force-recreate --wait server
```

A flag that is missing, empty or not `1|true|yes` (case-insensitive) is **off** — the flags fail
closed, so removing the line is a rollback too.

## The global concurrency cap — `IMAGINATION_MAX_CONCURRENT_CYCLES` (ITER-11 refinement)

The per-mission single-flight slot, the persisted cooldown and the per-mission window budget bound
ONE mission. Nothing bounded the process — and since the executive tick can now start cycles with no
human caller, N stalled missions could each run a cycle at once. The cap is that bound:

| | |
| --- | --- |
| variable | `IMAGINATION_MAX_CONCURRENT_CYCLES` — cycles **in flight at once across every identity and mission in this process** |
| default | **2** (a missing, non-numeric or non-positive value falls back to it, so the bound cannot be switched off; `1` serialises every cycle) |
| enforced in | the cycle service's single-flight path, immediately after the per-mission join: a caller that finds the cap reached is refused with reason **`concurrency_cap`** |
| what a refusal does | reads nothing, calls no model, claims no cycle and writes no row — the reading is returned and nothing else changes (a refused cycle leaves no partial state; a test asserts the whole store is byte-identical across the refusal) |
| released | in a `finally`, on every exit path — a completed, failed, skipped or throwing cycle all release their slot; a same-mission caller still JOINS the running cycle instead of being refused |
| surfaced | the cycle row and the tool result carry `concurrency` (`max_concurrent_cycles`, `in_flight_before`, `in_flight_after`, `capped`); the executive sweep's report carries the reading plus `capped: true` when the cap refused it |
| the executive sweep | respects it: a refusal stops the sweep for that tick (the cap is process-wide, so retrying the remaining missions would only be refused again) and is recorded in the sweep's `skipped` list with reason `concurrency_cap` — `cycles_run` stays 0 |

```bash
# serialise every imagination cycle in the process (the conservative setting):
echo 'IMAGINATION_MAX_CONCURRENT_CYCLES=1' >> .env
docker compose up -d --force-recreate --wait server
```

Raising it trades model spend for latency: a cycle is a multi-call model workload (focused
consolidation + one operator batch per spread), so the default of two keeps a stalled fleet from
spending N cycles' worth of calls in one tick.

## The descriptor space is configuration — `IMAGINATION_BINS` (ITER-11, WS-2)

The diversity bins the archive files cells in are **configurable**, and the default is exactly the
closed five-dimension space every stored row was written against:

```bash
# unset (or empty) ⇒ the closed defaults, byte for byte
# plain form: EXTEND/OVERRIDE — a default dimension's bins are replaced, a new key is APPENDED
IMAGINATION_BINS={"mechanism":["a","b"],"risk":["low","high"]}
# structured form: REPLACE the default dimensions entirely
IMAGINATION_BINS={"dimensions":{"mechanism":["a"],"risk":["low"]},"replace":true}
```

Fail-closed, and never silent:

- a config that is not JSON, not an object, over 8192 characters, with a malformed or reserved
  dimension name (`unclassified`, `dimensions`, `replace`), with a name that resolves through
  `Object.prototype` (`constructor`, `toString`, `__proto__` — refused as `prototype_dimension` /
  `prototype_bin` for the same reason: a lookup for such a name reads the prototype, not the space),
  with bins that are not lowercase slugs, with an empty/duplicated list, with the reserved
  `unclassified` bin, with more than 64 bins per dimension or more than 16 dimensions is **refused by
  name** and the DEFAULTS STAY IN FORCE — a refused config can never narrow the space (which would
  strand stored cells) or widen it;
- the refusal is visible on this view: `descriptor_space.refused` (code + reason), beside the active
  `dimensions`, `bins_per_dimension` and `possible_cells`;
- a stored cell whose dimensions are not in the ACTIVE space is **counted**
  (`archive` view → `coverage.scan.cells_unknown_dimension`) and left out of the occupancy maps
  instead of being folded into a lookalike dimension, and the baton compiler drops such a gap as
  `dropped_unknown_dimension`. Changing the space therefore never rewrites history — it moves which
  cells the engine can address from here on.

## Deprecation telemetry of the legacy personality record (ITER-11, WS-3)

The brief's §6.2 asks the changed personality path to "emit deprecation telemetry, not hard
failures". With `PER_IDENTITY_PERSONALITY` **on**, the server counts the requests that are still
served by the **legacy global record**: `legacy_read` (the identity has no record, so resolution fell
back), `no_user_id_path` (a request that named no identity of its own) and `legacy_write` (a write
that resolved back to the legacy key). The counters are:

- **bounded by construction** — one row per `{identity, kind, UTC day}` in
  `personality_deprecation_events`, so a flood adds no rows at all;
- **TTL'd** — `expires_at` is stamped 30 days out and a TTL index is installed, and reads filter
  expired rows in code as well, so the count is right on a store without TTL enforcement;
- **rate-limited** — at most one write per `{identity, kind}` per minute, so a hot read path pays
  almost nothing;
- **surfaced here**: `deprecation_telemetry` (`events`, `by_kind`, `rows`, `identities`, `ttl_days`,
  `basis`). A non-zero `legacy_read` means a consumer has not moved to its identity record yet — the
  flag-off path itself is NOT a deprecation and counts nothing.
- **Pinned like every other view** (ITER-11 refinement): the counters are PER IDENTITY, so the read
  is the caller's own identity by default — an untrusted caller's `user_id` and `all_identities` are
  ignored, and it never sees another identity's counts. A **trusted** caller may read exactly one
  identity with `?user_id=<identity>` or, with `?all_identities=1`, the cross-identity total; the
  payload states which with `scope` (`caller` / `named` / `all`, and `scope.identities`), both at the
  top level and inside `deprecation_telemetry`. `/rollout` is the only view whose flag and
  kill-switch blocks span no identity at all — the `scope` it reports is the scope of its
  deprecation-count block.

They are written by the same read/write paths that serve the bridge, so the number answers "is
anything still reading the old key?" with evidence rather than with a promise.

## Rollback commands

These are the same three commands the dashboard's Rollout view (`GET /api/v1/imagination/rollout`,
`rollback.{kill_switch_command,flag_off_command,code_rollback_command}`) reports, so an operator can
copy them from either place.

**1. Disable the surface (fastest, no code change).** Every imagination view is read-only, so
disabling the flags removes the surface without touching stored data:

```bash
echo 'FOCUSED_IMAGINATION=' >> .env && docker compose up -d --force-recreate --wait server
```

**1a. Roll back STAGE 1 only (per-identity personality).** The stage-1 flag has its own documented
command — the Rollout view hands it out as
`rollback.personality_flag_off_command`, and the executed rollback test
(`tests/unit/personality-rollback.test.ts`) runs exactly this command against a temporary `.env`
before proving the legacy read/write path is byte-identical to the pre-feature shape. Removing the
flag returns resolution and writes to the legacy global record and leaves stage 2 alone:

```bash
sed -i.bak 's/^PER_IDENTITY_PERSONALITY=.*/PER_IDENTITY_PERSONALITY=/' .env && docker compose up -d --force-recreate --wait server
```

To clear a flag that was explicitly enabled rather than append an empty line:

```bash
sed -i.bak 's/^FOCUSED_IMAGINATION=.*/FOCUSED_IMAGINATION=/' .env && docker compose up -d --force-recreate --wait server
```

**2. Arm the kill switch (widest stop, still no code change):**

```bash
echo 'COGNITIVE_ACTIVATION_KILL_SWITCH=1' >> .env && docker compose up -d --force-recreate --wait server
```

**3. Revert the code (if a defect is in the iteration itself).**

```bash
git revert --no-edit <ITER-9 commit> && docker compose up -d --build --wait server
```

**4. Drop the additive storage (only if the experiment records themselves are the problem).** The
observability layer adds ONE collection, `imagination_experiments`; it is written only by the gated
experiment-observation write and read only by the experiments view, so dropping it loses experiment
history and nothing else:

```bash
mongosh "$MONGODB_URI" --eval 'db.imagination_experiments.drop()'
```

Nothing else in this iteration is additive: the metrics are computed on read from collections the
earlier iterations own, and the routes are new mounts (`/api/v1/imagination`) that a revert removes
whole.

## Verifying a rollback

```bash
# The views must now state the flag reason rather than serve data:
curl -s -H "Authorization: Bearer $KATRA_API_KEY" \
  'http://localhost:9012/api/v1/imagination/metrics' | head -c 400
# → {"plane":"off","flag":{"name":"FOCUSED_IMAGINATION","on":false},"reason":"FOCUSED_IMAGINATION=off — …"}

# The MCP surface must be back to its default size (81 tools):
#   tools/list, with every flag off
```

The Rollout view is the single place to read all of this at once:
`GET /api/v1/imagination/rollout` (dashboard → **Imagination: rollout**).

## What to watch after a stage is enabled

1. **`privacy_leakage.flagged`** — must stay 0, and the basis tells you how many shared artefacts and
   markers were actually checked. A non-zero value stops the rollout: it means a shared-scope row
   carries private keys or text.
2. **`useful_novelty_rate`** — the point of the exercise. If it stays `insufficient_data` for the
   whole window, the loop is running but nothing is being judged: record outcomes
   (`record_candidate_outcome`) before promoting a stage on it.
3. **`false_novelty`** — a rising share of duplicates and paraphrases means the operators are
   re-covering known ground; watch it before raising the cycle budget.
4. **`cost_of_novelty`** — tokens per useful candidate. `insufficient_data` means there are no useful
   candidates yet **or** that no cycle in the window recorded a non-zero token count (the basis says
   which): an unrecorded spend is not a cost of zero.
5. **`time_to_next_viable_direction`** — the plateau trigger working as designed: the gap between the
   trigger and the first admitted candidate.
6. **`agent_divergence` vs `agent_divergence_same_mode_control`** — a team that agrees as much as one
   mode would is not a team; this is the stage-4 gate. The exit-criterion measurement in
   `server/tests/unit/cognitive-team.test.ts` reports three same-mode controls (all philosopher, all
   analyst, and all analyst under a **varied seed**) beside the three-mode treatment, plus the
   OPERATOR-plan divergence of each. **Statement-level magnitudes there are stub-determined**: the
   model is a scripted stub whose text depends only on the operator family, so the numbers show the
   plumbing (modes ⇒ different operators ⇒ different text) and are not evidence that a real model's
   ideas diverge. The operator-plan numbers and the recorded baseline in
   `docs/IMAGINATION-BASELINE.md` carry the same warning.
7. **`personality_stability.violations`** — expected 0. A non-zero value is a finding: an envelope or
   mode assignment no longer re-verifies (the `by_code` breakdown names which check refused it).
