# Katra Long-Horizon Cognitive Control — Phase 8 Final Summary

**Status: COMPLETE — graded PASS by independent verification · 2026-09-20**

| | |
|---|---|
| Branch | `feat/cognitive-control-local` @ `3f523ec` — **local only, never pushed** |
| Production image | `katra/server:phase8-3f523ec` (= `latest`), running and healthy |
| Gates | typecheck **0** · build **131** files · **729 passed / 0 failed / 159 skipped** |
| Live allocator | `autonomous-executive.ts` — **51 insertions, 0 deletions**, unchanged since Phase 6 |
| Surface | **119 MCP tools** (81 pre-feature) · 13 dashboard views · 13 GET + 1 gated POST route |

---

## 1. What this is

A cognitive-control plane for long-horizon agent work. The problem it addresses: an agent running
over days loses context, forgets why it decided something, restates the same claim with different
words, and cannot tell its own confidence from its own repetition.

The plane's answer is to make **mission state authoritative over chat history**. A mission is a
durable record: typed state, an epistemic ledger, versioned deltas, checkpoints, and reasoning
batons. An agent can then be handed a *minimum sufficient* slice of context for one reasoning
episode and later resume from the mission id alone, with **no transcript replay**.

## 2. Phases delivered

| Phase | Content |
|---|---|
| 0–2 | Schema registry (Ajv), 9 collections with TTL, mission state with monotonic versions, state deltas (idempotent, version-checked, outbox-applied), epistemic ledger with confidence history, batons, legacy-mission adapter, 9 MCP tools behind a flag |
| 4 | Go-live readiness; authority classes; caller-bound identity (untrusted callers pinned, capped at authority **B**) |
| 5 | Engine: uncertainty triggers, blind parallel work, dependency traversal, hypothesis diversity, invalidation, experiment registry, trigger telemetry |
| 6 | Activation: per-mission opt-in, activation ledger, scheduler mode ladder, the **one** additive hook into the live allocator, escalation to `shadow` |
| 7 | Cognition dashboard; deterministic rebuild (three iterations — the third found the real root cause: the version snapshot's embedded state predates checkpoint stamping, so `$set` could never write it) |
| 8 | Evaluation: eight-mode seeded-fault harness, skill-evolution gate chain, baseline comparison, safety restatement |

## 3. Production state

- `COGNITIVE_CONTROL_ENABLED=write` · `COGNITIVE_SCHEDULER_MODE=shadow` · `COGNITIVE_ACTIVATION_KILL_SWITCH=0`
- Backup at `~/.env.pre-golive.*`
- **Kill switch exercised for real**: `KILL_SWITCH=1` → `schedulerMode()` = `off` with **no rebuild**; then disengaged
- The evidence gate is **closed at 0 of 50 stored decisions**. `recommend` and above are unreachable — by design.

## 4. Independent verification (Phase 8)

Lilly (Verifier) re-ran the contract's gate commands herself. **Generator results were not used as
evidence.** Verdict: **PASS — no falsification achieved.**

- All six generator claims confirmed, including §4.18 (zero credential references on the new surfaces)
- **§4.5–4.8 confirmed structurally**: the harness `vi.mock()`s the database connection at module scope,
  so the fault-injection path **cannot obtain a production Mongo handle**. Containment is structural,
  not asserted. `controlledMission()` is the single choke point and throws for `ms_production_mission`
- She proved flag-off equivalence **structurally** (all files the fixes touch are absent on `main`, and
  the assertion runs before any write) — a stronger argument than the byte-identical test alone

### §4.9/4.10 — PASS, with a recorded objection

The metric was defined before measurement (6/8 modes detected vs a 0/8 baseline) and the artifact
records three places the layer is **not** better. The Verifier sustained the objection that the
baseline leg **cannot fail by construction**, so the comparison proves *detection-logic coverage*, not
production-outcome superiority; §7.A "measurably better" holds for the detection leg only.

This is recorded as a binding contract note, and the recommended forward metric is the **silent
state-damage rate** — accepted-no-effect deltas per version advance. Unlike 0/8-by-construction, the
pre-layer code can genuinely *lose* at that metric, because it demonstrably did.

## 5. The defect class this phase exposed

The single most valuable outcome of Phase 8 was not the harness — it was finding, in production, that
**`applyDeltaToState` writes every branch defensively (`if (obj)`), so an ineffective delta was recorded
`accepted`, advanced the mission version, and changed nothing.** Six instances, each found live:

| # | Finding | Observed effect |
|---|---|---|
| 1 | Delta aimed at a non-existent target (array index in the path) | Research mission **v14 → v17**, every objective untouched |
| 2 | Wrong value type — *inside the fix for #1* | **v22 → v26**, all four criteria still `unmet`. All 8 tests passed while broken |
| 3 | Ledger deltas with no `ledger_entries` — content discarded | `epistemic_entries: 0`, `ledger_refs` empty; **the research findings were lost** |
| 4 | An entire delta type that never worked — `OBJECTIVE_CREATED` read a field the schema forbids | Guaranteed no-op in **every prior build** |
| 5 | Vacuous values (no value, or `value={}`) — *Verifier's break-attempt* | Accepted, version advanced, nothing written |
| 6 | Blank descriptions and junk statuses written silently | Statuses now validated against the enums |

The assertion now covers every branch **target and value** and refuses before any write.
`state-delta-targets.test.ts` holds **18 cases**, each verified to fail against the code it guards.

**Two lessons worth carrying forward.** First: *"the check exists" ≠ "the check runs"* — my first
attempt at #5 placed the checks after the blocks' early returns; the compiler caught the unreachable
code (TS2367), not review. Second: **two earlier tests had pinned bad behaviour** (one asserted that
`EVIDENCE_ADDED` with no ledger entries was accepted). Their passing had been hiding the class. A test
that encodes a bug is worse than no test.

## 6. Revert and deploy

**Git refs and Docker image tags are different namespaces.** `phase8-3f523ec` is an *image* tag; the
matching *git* commit is `3f523ec`. `rollback-20260919` exists **only** as an image tag — there is no git
ref of that name. Do not confuse the two, and prefer the git commit where you need history and the image
tag where you need a runnable container.

### Git refs (all verified to resolve as commits)

| Ref | Points at |
|---|---|
| **`phase8-green`** (annotated tag) | **`3f523ec` — current green ref, Phase 8 graded PASS** |
| `phase8-green^{commit}` | `3f523ec` — tag dereferences to HEAD |
| `phase5-green` (annotated tag) | `5292da3` |
| `3f523ec` | HEAD — latest fix (vacuous-value refusal) |
| `6347363` | every applier branch closed |
| `0229b6e` | value-form fix for `SUCCESS_CRITERION_UPDATED` |
| `88007fa` | fail-closed target resolution |
| `cb6f7d4` | Phase 8 gates + seeded-fault harness |
| `d7ddc26` | **Phases 4–7 green ref** (superseded) |
| `8cfd2ea` | Phase 6 |
| `5292da3` | pre-Phase-6 (also the `phase5-green` target) |
| `be56f35`, `f797550`, `ad834bb`, `971ac1d`, `3b8b1c5` | earlier phase marks |
| `35f61fb` | `main`, pre-feature baseline |

**`local/long-horizon-cognitive-control`** also sits at `35f61fb` — the pre-feature marker branch.

### Docker image tags

`katra/server:phase8-3f523ec` (**current**, = `latest`) · `phase8-6347363` · `phase8-0229b6e` ·
`phase8-88007fa` · `phase7-ad834bb` · `phase6-8cfd2ea` · `pre-phase6-5292da3` · `phase5-f797550` ·
`phase5-be56f35` · `rollback-20260919`

Every image tag's suffix is a real git commit, **except** `rollback-20260919` (6 days old, image-only).
Verify a tag contains what its name claims before relying on it — that rule has already caught one
mismatch in this project.

### Deploy path — important

```bash
docker compose build server && docker compose up -d server
```

`/app` is baked into the image and `./server` is mounted **read-only** at `/repos/katra-server` (for the
code-graph scanner only). **Committing does not ship.** A commit is live only after a rebuild + recreate.

### Restoring after the move

Nothing needs to be done. HEAD is `3f523ec`, the tree is clean, the image is tagged, the plane's flags are
**committed configuration** in `.env`, and the running container is the same image. The plane comes back
live on power-on without intervention. If you need to roll back, check out a git ref above and rebuild.

## 6b. Verification of the section-7 pass (`d7cb777`)

Lilly independently re-ran the gates at `d7cb777` (tag `section7-d7cb777`). **All six claims
CONFIRMED.** Notable results from her own run, not mine:

- Gates: typecheck 0 · build 131 · **743 passed / 0 failed / 159 skipped** · allocator **51/0**
- Backlog metric: her independent mongosh count **3,396** against the old saturated 1,000 —
  the 3.39× blind spot was real and is closed
- `forceProcessAll`: drain loop verified bounded (BATCH 1000, MAX_BATCHES 100), breaks dry,
  **breaks loudly on a no-progress batch**, and every non-drained exit appends an explicit
  error. She verified this by reading the loop and did **not** execute it against 3.4k
  production events — the right call
- `resume_mission` and `/executive`: both checked **live** through the MCP entrypoint and
  HTTP, returning exactly the claimed text; 25 rows inspected, **0 leaks**
- Kill-switch control: *"I tried to break it and could not"* — a generally-broken dispatcher
  would fail the cleared case, so the control genuinely isolates the switch

### ⚠️ The identity-environment trap (found by the Verifier, in MY instructions)

**Always run the suite as `env -u KATRA_USER_ID npx vitest run`.** My `WHAT-TO-RUN` block for
this pass dropped the `-u`, and in a dispatch environment that leaks `KATRA_USER_ID=satori`
(the inbox cron exports it) **7 identity tests fail** — `resolveCallerIdentity` expects
`katra`. Verified both ways:

```
KATRA_USER_ID=satori npx vitest run        # 7 FAILURES  (environment leakage)
env -u KATRA_USER_ID npx vitest run        # 743 passed / 0 failed
```

This is an **environment artefact, not a code defect**, but it produces a false red and will
mislead anyone who runs the gates from an agent dispatch or a shell that exports the variable.
The contract's §6 command had it right; my abbreviated re-statement is what lost it.

### The deferred allocator fix — Verifier's ruling

On the un-patched source defect (see §7), Lilly ruled: **do not amend the contract.** The 51/0
freeze is the governing constraint and her own verified reconciliation depends on it; the
display-layer normalisation closes the user-visible defect, and the note's honest quoting of
the original artefact is better than a silent rewrite.

**Logged as a deferred item**: the one-line source fix (guard the rationale template for the
single-candidate case) should ride any *future* allocator amendment rather than being made
now. John decides when, if ever.

---

## 7. Open items — status after the follow-up pass

The first pass left six items. Four are now resolved; two remain, and both are
deliberately not mine to change.

### Resolved

| Item | Resolution |
|---|---|
| **Backlog metric saturated at 1000** | **Fixed.** It fetched 1,000 documents to read `.length`, so it reported `min(backlog, 1000)`. Measured live: a true backlog of **3,389** surfaced as 1,000 — a **3.39× under-report**, blind exactly when the backlog was worst. Now a true `countDocuments`, with the filter shared by the fetch and the count so they cannot drift. Live now reads **3,420**, not 1,000. |
| **`forceProcessAll` claimed more than it did** | **Fixed.** It processed one batch of 1,000 and returned success, so above 1,000 "all" was silently false. Now drains in batches, stops loudly on a no-progress batch, and reports an undrained backlog instead of passing it off as completion. |
| **`resume_mission` ignored criteria status** | **Fixed.** It advised verifying criteria even when all were `met`. It now distinguishes ready-to-close / names the open criteria / states none are declared. The live research mission now reads: *"all 4 objective(s) completed and all 4 success criteria satisfied — the mission is ready to close."* |
| **`/executive` artefact** | **Fixed at the display layer.** 25 of 25 actions normalised, 0 leaking. See the frozen-file note below. |
| **Kill-switch tool-unreachability probe** | **Settled.** It was inconclusive because a standalone import failed. Now proven by test through the live dispatch path: with the switch set, the scheduler and uncertainty **dispatchers throw `Unknown tool: <name>`** — indistinguishable from the tool not existing. No production restart needed. |

### Deliberately not changed

**The allocator rationale still generates the artefact at source.** The root cause is in
`autonomous-executive.ts`: the rationale template interpolates `ranked[1]`, which is
`undefined` when the deployment has a single allocation candidate (`KATRA_ALLOCATION_CANDIDATES`
unset → the candidate list is `[LOCAL_AGENT_ID]`), producing the literal `undefined 0.00`.
That file is **frozen by contract** at 51 insertions / 0 deletions and independently
verified, so the artefact is normalised for display and the fact is stated rather than
rewritten at source. **The one-line fix, if you want it: guard the template for the
single-candidate case.** Applying it would change the allocator's diff and invalidate the
`51(+) 0(−)` reconciliation, so it needs a deliberate decision and a re-verification.

**The custodian route's loopback trust is by design, not a hole.** Verified live: a remote
call returns **401**; a loopback call returns **400** (past auth, failed validation). The
behaviour comes from the API-wide `caller-auth` rule *"loopback → trusted katra (no key
needed)"*, so it applies to every route, not just this one. Worth knowing if the deployment
ever becomes multi-tenant; correct for a single host.

### Still outstanding (not mine to action)

- **Three `katra-mcp-*` keys to rotate**, a plaintext API key file to clear, a credential
  custody decision, per-agent keys for shell consumers, and secret-bearing local state to
  encrypt or remove. These are destructive or external changes and need your direction.
- **Flag-off is not fully indistinguishable** for the *other* cognitive tools: a direct
  `tools/call` by name reaches the handler and returns *"Cognitive control plane disabled"*
  rather than *"Unknown tool"*. Note the scheduler and uncertainty families **do** throw
  `Unknown tool` — the residual is limited to the remaining handlers.

---

---

*Prepared 2026-09-20. Companion document: `COGNITIVE-CONTROL-OPERATIONS.md`.*
