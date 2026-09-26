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
- The views that can span identities are `/overview`, `/cycles`, `/cycles/:cycleId`, `/traces` and
  `/batons` (whose default is the caller's own batons plus the **promoted** — shared — artefact, the
  one surface this feature shares). `/archive`, `/team`, `/metrics`, `/experiments` and
  `/experiments/compare` are measured for exactly ONE identity, so `all_identities` is not offered
  there and their payload states `caller` or `named`.
- `GET /api/v1/imagination/rollout` reads no identity rows at all (it reports the running process's
  flags and kill switches), so it is the one view that carries no `scope`.
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
| 2 | Focused imagination (private) | `FOCUSED_IMAGINATION` | `useful_novelty_rate.status = ok` (n ≥ 5 recorded outcomes); `false_novelty` at or below the recorded baseline; `cost_of_novelty.status = ok` (denominator > 0) | `useful_novelty_rate`, `false_novelty`, `cost_of_novelty`, `time_to_next_viable_direction` |
| 3 | Baton promotion (shared scope) | `CREATIVE_BATON_PROMOTION` | `privacy_leakage.flagged = 0` across every shared artefact scanned; no promotion refusal other than `flag_off` | `privacy_leakage`, `idea_survival`, `archive_coverage_gain` |
| 4 | Cognitive team allocation | `COGNITIVE_TEAM_ALLOCATION` | `agent_divergence` above `agent_divergence_same_mode_control` (the team must diverge more than one mode does); `personality_stability.violations = 0` | `agent_divergence` vs its same-mode control, `personality_stability` |

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

## Rollback commands

These are the same three commands the dashboard's Rollout view (`GET /api/v1/imagination/rollout`,
`rollback.{kill_switch_command,flag_off_command,code_rollback_command}`) reports, so an operator can
copy them from either place.

**1. Disable the surface (fastest, no code change).** Every imagination view is read-only, so
disabling the flags removes the surface without touching stored data:

```bash
echo 'FOCUSED_IMAGINATION=' >> .env && docker compose up -d --force-recreate --wait server
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
   mode would is not a team; this is the stage-4 gate.
7. **`personality_stability.violations`** — expected 0. A non-zero value is a finding: an envelope or
   mode assignment no longer re-verifies (the `by_code` breakdown names which check refused it).
