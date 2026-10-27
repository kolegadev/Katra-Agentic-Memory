# Katra Long Horizon Cognitive Control — loop-director project state (thebrick)

Package `~/katra-long-horizon/` (OUTSIDE git tree — never commit/push; the operator: no publication until explicit approval). Branch `feat/cognitive-control-local` in `~/Katra-Agentic-Memory` (local-only). Revert refs (use git refs ONLY): pre-feature `35f61fb` (main), `971ac1d`, `3b8b1c5`, `rollback-20260919`, `phase5-be56f35`, `phase5-f797550`, `pre-phase6-5292da3`, `phase6-8cfd2ea`, `d7ddc26` (Phases 4-7 green ref), `cb6f7d4` (Phase 8 gates), `88007fa` (fail-closed delta fix), `0229b6e` (value-form fix), `6347363` (every applier branch), and **PHASE 8 GREEN REF: git tag `phase8-green` = `3f523ec`** (graded PASS by the loop director 2026-09-20). `phase5-green` = `5292da3`.

**CURRENT GREEN REF (2026-09-20, section-7 pass): `d7cb777`** — tag `section7-d7cb777`, **independently
verified** by the loop director (all six section-7 claims confirmed: gates 743 passed / 0 failed / 159 skipped, allocator
51/0). Supersedes `3f523ec` for RUNNING CODE, while `phase8-green` remains the record of what was graded for
Phase 8. Both tags are immutable; neither is moved. Verified image tags: `katra/server:rollback-20260919`, `phase5-be56f35`, `phase5-f797550`, `pre-phase6-5292da3`, `phase6-8cfd2ea`, `phase7-ad834bb` (verify a tag contains what its name claims before relying on it). Trap: the generic `loop-state backup` tool snapshots the wrong tree and stored bogus green ref `4b263af5` — never trust it.

## Loop regime (the operator-directed 2026-09-19 15:14Z)

- Artefacts: `~/katra-long-horizon/loop/CONTRACT.md` (19 numbered criteria, 8 sections) + `BACKLOG.md` (ITER-0..4).
- Roles: the generator = GENERATOR (services/mission-cognition/**, types/cognitive-control.ts, mcp-server.ts wiring, server/tests/**, skill-loader-service.ts, types/memory.ts). the loop director = VERIFIER + DIRECTOR (authority/**, 9 seed skills, verification; never edits Generator files). Verifier's test results are the only evidence; Generator-authored tests are not.
- Max 3 attempts per feature → revert to green ref → escalate to the operator.
- Every iteration ends with a Katra work-log memory (REST episodic event with tags loop-director+work-log; the MCP bridge `katra_cli.py` still 401s — known Katra client_keys issue).
- Iteration order: ITER-0 retrospective grading → ITER-1 decisive context-clear test (criteria 9–13, no transcript replay) → ITER-2 concurrency (14–16) → ITER-3 secrets/privacy (17–19) → ITER-4 seed-skill round two (the loop director's). Scheduler/uncertainty/dashboard DEFERRED — require a new contract.

## Iteration 0 measurements (2026-09-19, reported to Verifier)

- Build: `npm run build` clean → 112 files, host node `~/.nvm/versions/node/v22.23.1/bin` (contract §5 gates run on the HOST — host node exists via nvm).
- Live MCP counts (stdio server in katra-server container, rebuilt artifacts): flag unset → **81** tools, none of the 9 cognitive tools listed; main@35f61fb archive rebuild → **81** (docs' "66" is stale — vault/auth/decay tools added later); flag=write → 90 (81 + exactly the 9).
- Finding (criterion #5): with flag off, `tools/list` hides the 9, but a direct `tools/call` by name reaches the handler and returns distinctive "Cognitive control plane disabled" text instead of "Unknown tool" — not fully indistinguishable from feature-absent. Fix proposal: gate the tools/call dispatch on the mode too. NOT yet fixed (measurement-only instruction; awaiting Verifier grade).

## Implemented (Phase 0 + review immediate actions + Phases 1–2 core)

- Schema registry (Ajv2020 + ajv-formats); 9 collections with TTL/compaction retention (events 90d, batons 7d, versions keep 30).
- Services: mission state (monotonic versions, checkpoints, deterministic rebuild), state deltas (idempotency, version checks, commutative-merge vs conflict, outbox-style apply), epistemic ledger (confidence history, cycle-safe dependency closure), batons (immutable, expiring, blindness, secret rejection, stale revocation), legacy missions adapter (idempotent adoption).
- 9 MCP tools behind `COGNITIVE_CONTROL_ENABLED` (off|read|write, default off); untrusted callers pinned to identity, capped at authority B.
- §4.5 closed: strict `additionalProperties:false` for state_deltas + epistemic_entries (status/applied_at added to delta contract), relaxed for mutable projection docs.
- event-rail: singleton lazy Redis client (no per-event connect/quit).
- Skill system: NaN confidence loader fix (`Number.isFinite`), `version` threaded through types/search/feedback; 9 seed skills frontmatter fixed (the loop director installs them).

## Constraints & gates

- No-publish: `.git/hooks/pre-push` v4 (the loop director) blocks branch names + protected paths incl. authority/ + seed skill dirs; verified branch→exit 1, main→exit 0. v1 near-miss: it missed my branch/path names (one push from public repo) — guards must be broad. the operator removes the hook by hand to publish.
- LIVE activation the operator-gated: running `/app/build` predates both commits; server image rebuild + env needed. No production collections touched.
- ajv declared in package.json; lockfile refresh pending a writable checkout (node_modules has 8.20.0 which satisfies the range).
- Test env: katra-server container mounts are RO — for container-side vitest, copy the tree to /tmp and run there; vault/approvals test needs /tmp/dashboard (docker cp from repo root). Host-side `npx vitest`/`tsc`/`esbuild` also work via nvm node.
- Katra work-log events: posted via REST `POST /api/v1/memory/episodic/events` with the agent-a key (inbox_reply-style resolution), tags `["loop-director","work-log","project:katra-long-horizon"]`, no Attention: first line.

## SECTION-7 FOLLOW-UP PASS — green `d7cb777`, verified (2026-09-20)

Five of the six Phase 8 open items are resolved; the sixth is deferred by Verifier ruling.

1. **Backlog metric saturation — FIXED.** `getProcessingStats()` fetched 1,000 docs to read `.length`, so it
   reported `min(backlog, 1000)`. Independent counts: **true 3,389-3,396 vs reported 1,000 = 3.39x blind spot**,
   exactly when the backlog was worst. Now a true `countDocuments`, with `UNPROCESSED_EVENTS_FILTER` **shared**
   by the fetch and the count so they cannot drift.
2. **`forceProcessAll` claimed more than it did — FIXED.** One batch of 1,000 then success. Now drains in
   batches (bounded BATCH 1000 / MAX_BATCHES 100), breaks loudly on a no-progress batch, reports undrained.
3. **`resume_mission` ignored criteria — FIXED.** ready-to-close / names open criteria / states none declared.
4. **`/executive` artefact — FIXED at the display layer.** 25/25 normalised, 0 leaks; the over-claiming `basis`
   text corrected. Source fix DEFERRED (below).
5. **Kill-switch tool unreachability — SETTLED BY TEST.** While the switch is set, the scheduler and uncertainty
   **dispatchers throw `Unknown tool`**. the loop director tried to break the control and could not.

### TRAP: the gate command needs `env -u KATRA_USER_ID`

Found by the loop director in *my* instructions. Seven identity tests expect user_id `katra`; if `KATRA_USER_ID` is
exported (an agent dispatch exports it) they fail with a **false red**. Verified both ways — 7 failures
without the flag, **743 passed / 0 failed** with it. Environment leakage, not a code defect.

```
env -u KATRA_USER_ID npx vitest run     # REQUIRED
```

### DEFERRED (Verifier ruling — do NOT amend the contract)

The allocator still generates the `undefined 0.00` artefact at source: the rationale template in
`autonomous-executive.ts` interpolates `ranked[1]`, undefined in a single-candidate deployment
(`KATRA_ALLOCATION_CANDIDATES` unset). The 51/0 freeze is the governing constraint and the verified
reconciliation depends on it, so display-layer normalisation stands and the one-line source fix **rides any
future allocator amendment**. the operator decides when.

### Still needing the operator (destructive/external)

Rotate the three `katra-mcp-*` keys; clear the plaintext API key file; credential custody; per-agent keys for
shell consumers; encrypt/remove secret-bearing local state.

## PHASE 8 COMPLETE — green ref `phase8-green` = `3f523ec` (2026-09-20)

**Graded PASS by independent verification.** the loop director re-ran the contract gates herself at HEAD: typecheck 0,
build 131 files, **729 passed / 0 failed / 159 skipped**, allocator **51 insertions / 0 deletions**, branch
absent from origin, flag-off byte-identical. Verdict: *"PASS - no falsification achieved."*

- **4.5-4.8 confirmed structurally**: the harness `vi.mock()`s the database connection at module scope, so
  the fault-injection path **cannot obtain a production Mongo handle**; `controlledMission()` throws for
  `ms_production_mission`. Containment is structural, not asserted.
- **4.9/4.10 PASS with a binding contract note.** The baseline leg cannot fail by construction, so the
  comparison proves **detection-logic coverage, not production-outcome superiority**; "measurably better"
  holds for the detection leg only. **Forward metric recommended: silent state-damage rate**
  (accepted-no-effect deltas per version advance) - a baseline the pre-layer code can genuinely lose at.
- **Deployed**: `katra/server:phase8-3f523ec` (= `latest`), healthy.

### The defect class Phase 8 exposed (six findings, all closed)

`applyDeltaToState` writes every branch defensively (`if (obj)`), so an ineffective delta was recorded
**accepted**, **advanced the mission version**, and **changed nothing**. Every instance was found in
production: (1) wrong target - an array index in the path; (2) wrong value type, inside the fix for (1);
(3) ledger deltas with no `ledger_entries` - **this discarded the research findings**, the ledger held zero
entries; (4) **an entire delta type that never worked** - `OBJECTIVE_CREATED` read a field the operation
schema cannot produce; (5) vacuous values, found by the Verifier break-attempt; (6) blank/junk statuses.

The assertion now covers every branch **target and value** and refuses before any write.
`state-delta-targets.test.ts` holds **18 cases**, each verified to fail against the code it guards.
**Two earlier tests had been pinning the bad behaviour** - that is why the class stayed hidden.

Trap worth keeping: the first attempt at (5) placed the checks *after* the blocks early returns - dead
code the compiler caught as **TS2367**. "The check exists" is not "the check runs".

### Documentation

`~/katra-long-horizon/PHASE-8-FINAL-SUMMARY.md` and `COGNITIVE-CONTROL-OPERATIONS.md` (also on both
Desktops as `.md` + styled `.html`). The operations doc carries **11 limitations**, including that the
plane does not act at all, that two of eight failure modes have no detector, and that flag-off is **not
fully indistinguishable** (a direct `tools/call` by name returns "Cognitive control plane disabled"
rather than "Unknown tool").

## Phases 4-8 (2026-09-20) — LIVE, and the state as of the last iteration

**Plane is LIVE in production.** `.env`: `COGNITIVE_CONTROL_ENABLED=write`, `COGNITIVE_SCHEDULER_MODE=shadow`,
`COGNITIVE_ACTIVATION_KILL_SWITCH=0` (backups `~/.env.pre-golive.*`). `recommend`+ stays unreachable: the
evidence gate is closed at 0/50 stored decisions and is enforced at the acting path, not at the surface.

- **Tool surface, measured through the real MCP entrypoint: 119** (main@35f61fb = 81; flag=write = 90 at Phase 2).
  Every earlier count in this doc (81 / 90 / 112) is stale — Phase 8 added the skill-evolution and harness tools.
- **Build: 131 files.** Host node via `~/.nvm/versions/node/v22.23.1/bin`.
- **Kill switch exercised for real:** `KILL_SWITCH=1` → `schedulerMode()` = `off` with **no rebuild**, then
  disengaged. `/dashboard/cognition/` HTTP 200; 13 GET + 1 gated POST; every view carries `basis`.
- **Small test PASSED end to end** through the container's own code path: `create_mission_v2` → 2 deltas
  accepted → idempotent resubmit returns the same delta id → work item → `explain_scheduler_decision` →
  checkpoint → **`resume_mission` from the mission id alone** ("NO conversation history / transcript consulted").
- **Gates:** typecheck 0 · build 131 files · **719 passed / 0 failed / 159 skipped** (704 at `d7ddc26`
  + 7 phase-8 gates + 8 new). Allocator vs main = **51 insertions, 0 deletions**, unchanged since Phase 6.

### Phase 8 — what is done, and what is not

- **§4.5-4.8 done:** the eight-mode seeded-fault harness (`server/tests/unit/phase8-gates.test.ts`, 7/7) in
  `~/katra-long-horizon/loop/harness/`. The harness **declares correct behaviour before running each mode**,
  runs against `FakeDb` only (the injection path throws for `controlledMission('ms_production_mission')`), and
  **requires ≥2 honest misses as a passing condition**. Result 6/8, honest misses (f) graph lag, (g) LLM outage.
- **§4.17-4.20 verified:** 51/0 allocator; security suite 49 passed / 5 skipped with zero env/key references in
  the new routes and the cognition page; flag-off is **byte-identical** to the pre-Phase-6 allocation baseline
  (not merely similar); nothing pushed — `feat/cognitive-control-local` is absent from `git ls-remote origin`.
- **§4.9/4.10 — VERIFIER RULING NEEDED.** The metric (`detected_count/8`) was correctly defined before
  measurement, but its baseline is `0/8 **by construction**`. That is **tautological** — a baseline that is
  definitionally zero cannot show the layer as worse, which is the shape §4.10 forbids. The artifact *does*
  satisfy §4.10's honest half (it records three places the layer is not better, incl. that all eight modes ran
  against FakeDb rather than production, so it measures detection *logic*). Do **not** swap the metric now —
  that would be choosing a metric after seeing the numbers. Record the objection and pre-register a paired
  metric for a follow-up that both configurations could differ on.

### Defect found live and fixed (`88007fa`) — the fail-open write path

`applyDeltaToState` writes every targeted branch as `if (obj)` / `if (criterion)`, so a delta naming a target
that does not exist was recorded **`accepted`**, **advanced the mission version**, and **changed nothing**.
Hit live, not by reading code: three `OBJECTIVE_COMPLETED` deltas carrying `/objectives/0/status` (array index)
instead of `/objectives/<objective_id>/status` took the research mission v14 → v17 with every objective
untouched. The JSON Schema only required `path` to start with `/`, so index-shaped paths passed validation.

- `assertTargetsResolve()` now rejects objective- and criterion-targeted deltas whose path does not resolve,
  before any write. Non-targeted types unaffected.
- Added `SUCCESS_CRITERION_UPDATED`: `SuccessCriterion` had a `status` but **no delta type could transition it**,
  so a mission's definition-of-done was permanently unreachable through the API.
- `server/tests/unit/state-delta-targets.test.ts` — 8 cases, **5 of which fail on the pre-fix code** (reverted
  the source, kept the test, ran: 5 failed | 3 passed).
- **NOT YET DEPLOYED.** `/app` is baked into image `katra/server:latest` and `./server` is mounted
  **read-only** at `/repos/katra-server` (for the code-graph scanner only). Deploying needs an image rebuild —
  fold `88007fa` into the Phase 8 deploy rather than restarting the live plane for a low-urgency hardening.

### Work-log — the 3x-requested Phase 6 §3 enumeration is finally posted

Event `767b1ea4-d388-464d-9cb1-26f16785f304` (201), tags `loop-director` + `work-log` +
`project:katra-long-horizon`. The allocator enumeration: **three insertion points** — (a) +5 import,
(b) +42 `maybeInfluenceAllocation()`, (c) +4 call site = 51 insertions / 0 deletions.

**Posting mechanics** (this cost several attempts): the REST route is `POST /api/v1/memory/episodic/events`
on container port **9002** (host 9012). From the **host** it correctly 401s; from **inside the container**
loopback trust applies and it needs no credential (F1). Requires `event_type` + `content`; `user_id` is
honoured only for trusted callers. Do not try to build the JSON body through nested `sh -c` quoting — write
the body with a small `.mjs` and run it in the container.

### Standing open items

- §4.9/4.10 needs the Verifier ruling described above.
- Phase 8 needs the Verifier's **independent** run of the §6 commands; generator-side numbers are not evidence.
- `background-processor.ts:898` saturates at 1000 (reported, unpatched).
- Image rebuild + tag pending (folds in `88007fa`).
- Pre-existing, unrelated: `/executive` "undefined 0.00" artefact; 3 `katra-mcp-*` keys;
  `~/Downloads/agentmail_api_key_insta.txt`; custody; memory cap HELD.
