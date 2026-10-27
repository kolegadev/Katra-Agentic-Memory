# CONTRACT.md — Katra Long Horizon Cognitive Control Plane

**Loop:** `new-code` · **Loop director:** the loop director
**Generator:** the generator · **Verifier:** the loop director
**Branch:** `feat/cognitive-control-local` — **LOCAL ONLY, never pushed**
**Opened:** 2026-09-19
**Baseline commit:** `3b8b1c5` (Generator's Phase 0–2 work, already landed)

> This contract was written **after** implementation began. That is a deviation from the
> loop protocol and is recorded honestly rather than hidden. Its purpose now is to
> re-baseline: everything that follows is graded against this document, and the
> already-built code is graded against it retrospectively in Iteration 0.

---

## 1. GOAL

Build an additive cognitive control plane that lets Katra's persistent agents sustain
**uncertain work across sessions, context resets and machines** — preserving evidence,
provenance, dissent and identity privacy — without relying on conversation history.

**The single claim this must prove:** a mission survives a genuine, total context clear and
resumes correctly without transcript replay.

---

## 2. BOUNDARIES

### In scope (may be modified)
```
server/src/services/mission-cognition/**      Generator owns
server/src/types/cognitive-control.ts         Generator owns
server/src/mcp-server.ts                      (cognitive tool wiring ONLY)
server/src/services/memory/skill-loader-service.ts   (version + confidence)
server/src/types/memory.ts                    (version field)
server/tests/**                               (mission-cognition tests)
server/src/skills/**                          Verifier owns the 9 seed skills
server/src/services/authority/**              Verifier owns
```

### Explicitly OUT of scope — must NOT be touched
| Area | Why |
|---|---|
| `server/src/services/memory/` (other than the loader) | core memory subsystem, unrelated |
| `server/src/services/processing/sleep-consolidation-service.ts` | separate learning loop — doc 01 requires the three loops stay distinct |
| `server/src/services/processing/autonomous-executive.ts` | the existing allocator; the scheduler stays shadow-mode and MUST NOT change real allocation |
| `server/src/services/vault/**` | credential handling — no new code path may touch secrets |
| `scripts/python/authority_matrix.py` | left in place; superseded by the TS service, not deleted (other callers exist) |
| `system_settings` collection writes | `apply_config()` clears all providers — dangerous, unrelated |
| Any `docs/**` on a pushed line | no-publish constraint |
| **Anything pushed to `origin`** | see §6 |

### Authority boundaries
- The **Generator must not** edit `services/authority/**` or the 9 seed skills. Those are the
  Verifier's file set.
- The **Verifier must not** edit `services/mission-cognition/**`. Findings are reported, not patched.
- This separation is not bureaucracy — it is the loop's core safety property.

---

## 3. SUCCESS CRITERIA

Numbered and testable. Each is graded PASS/FAIL with evidence in the verification report.

### Iteration 0 — retrospective baseline (grade what already exists)
1. `npm run typecheck` exits 0 on the whole server.
2. `npm run build` completes clean.
3. All mission-cognition tests pass; the count is recorded (currently 17).
4. With `COGNITIVE_CONTROL_ENABLED` unset, the MCP tool count is **exactly 66** (unchanged).
5. With the flag `off`, none of the 9 cognitive tools are reachable.
6. All 9 seed skills load via the **real compiled loader**, each with `title`, `triggers`,
   and a finite `confidence`. (Verified: 18 skills loaded, 0 problems.)
7. The TS authority service classifies **identically** to `scripts/python/authority_matrix.py`
   on the 37-subject corpus (semantic parity, casing exempt).
8. Unknown subjects default to class **B** (deny-by-default).

### Iteration 1 — THE DECISIVE TEST (context-clear continuity)
9. A mission can be created, two state deltas accepted, work assigned, and a checkpoint taken.
10. The agent context is then **genuinely cleared** — new process, no chat history, no transcript.
11. On resume the agent correctly reports: mission version, owner, what changed since the
    checkpoint, active uncertainties, and the next unblocked action.
12. **No transcript replay is used.** If the answer depends on conversation history, this FAILS.
13. Reconstruction is deterministic: re-running from the same checkpoint + deltas yields
    byte-identical Mission State.

### Iteration 2 — concurrency and integrity
14. The same `idempotency_key` submitted twice produces exactly one accepted delta.
15. Two deltas against the same `base_mission_version` cannot silently overwrite — one is
    accepted, the other is routed to conflict, and **neither is dropped**.
16. Mission versions are monotonic; replaying accepted deltas from a checkpoint reproduces state.

### Iteration 3 — secret and privacy boundary (safety, non-negotiable)
17. No credential value can appear in a baton, ledger entry, delta, event, or log.
    Batons carry capability IDs only.
18. A blind baton contains no incumbent conclusion or rationale (fixture test).
19. An untrusted MCP caller cannot declare `authority_class: A`, and cannot author records
    as another identity.

---

## 4. INTERFACES

### 4.1 MCP tools (9, all behind `COGNITIVE_CONTROL_ENABLED`)
```
create_mission_v2        get_mission_state       submit_state_delta
list_state_deltas        query_epistemic_ledger  compile_cognitive_baton
get_cognitive_baton      checkpoint_mission      resume_mission
```
**Deferred by design (do NOT add without a new contract):**
`create_cognitive_work_item`, `get_cognitive_queue`, `explain_scheduler_decision`,
`trigger_uncertainty_review` — the scheduler and uncertainty surface.

### 4.2 Flag
```
COGNITIVE_CONTROL_ENABLED = off | read | write      default: off
```
`off` must be indistinguishable from the feature not existing.

### 4.3 Collections (9)
```
mission_states            mission_state_versions   epistemic_entries
state_deltas              cognitive_batons         cognitive_work_items
agent_cognitive_profiles  scheduler_decisions      mission_events
```
Retention: `mission_events` TTL 90d · `cognitive_batons` TTL 7d ·
`mission_state_versions` keep last 30 · deltas and ledger entries retained (they are the audit).

### 4.4 Authority service
```ts
inferAuthority(subject, thread?): AuthorityDecision          // ADVISORY ONLY
gateAction(subject, thread?): AuthorityDecision              // ported gate_action()
resolveAuthority(subject, declared?): AuthorityDecision
resolveEffectiveClass(declared, callerCtx): { effectiveClass, autonomy, clamped, reason }
permittedClassFor(ctx): AuthorityClass                       // trusted→A, untrusted→B
mayTakeExternalEffect(effective, ctx): boolean               // trusted && class A
assertCallerMayAuthorAs(ctx, targetId): void                 // throws on impersonation
```
**Invariant:** a declaration may only ever *restrict* authority, never expand it.

### 4.5 Skill frontmatter (the 9 seed skills)
```yaml
name, title, category, description, status, version,
observation_count, success_count, failure_count, confidence, triggers[]
```
`category` must match the parent directory. `triggers` must be non-empty — a skill with
`triggers: []` cannot score on the activation path worth `WEIGHT_B = 0.3`.

---

## 5. TEST COMMANDS

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd ~/Katra-Agentic-Memory/server
npm run typecheck                                  # gate 1
npm run build                                      # gate 2
npx vitest run tests/unit/mission-cognition*.test.ts   # gate 3
```

The Verifier runs these **independently** and reports actual output. The Generator's own
test results are NOT accepted as evidence — that is the entire point of the separation.

---

## 6. NO-PUBLISH CONSTRAINT

`github.com/kolegadev/Katra-Agentic-Memory` is **public**. the operator has not decided on
publication or monetisation. Nothing from this work may be pushed.

Enforced mechanically by `.git/hooks/pre-push` (v4), which blocks the branch by name and the
capability's paths on any branch. **The guard has now been extended three times because the
work outgrew it each time.** Every new file must be checked against it, not assumed covered.

To publish, the operator removes the hook by hand. Neither agent may grant that.

---

## 7. ROLE AND REVERT RULES

- **Generator (the generator):** implements against this contract, writes its own tests, reports
  `{files_created, files_modified, tests_written, known_limitations}`.
- **Verifier (the loop director):** does NOT see the Generator's plan — only the contract and the code.
  Runs the full suite, grades each numbered success criterion, checks for "poison" (code that
  passes tests while violating an invariant), returns `{verdict, tests_passing, tests_failing,
  contract_violations, failures}`.
- **Max 3 refinement attempts** per atomic feature. Then revert to the last green state via
  `loop-state` and escalate to the operator.
- **`loop-state backup` before every iteration.** On a no-publish branch with no CI, that
  snapshot is the only safety net.
- Every iteration records a work-log entry in Katra.

---

## 8. ITERATION 0 STATUS — retrospective grading of `3b8b1c5`

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | typecheck exit 0 | ✅ PASS | run by Verifier, exit 0 |
| 2 | build clean | ⏳ pending | not yet re-run since the commit |
| 3 | tests pass | ✅ PASS | 17/17 (5 MCP + 12 unit) |
| 4 | tool count 66 when flag off | ⏳ pending | needs a rebuild + live MCP query |
| 5 | flag off hides tools | ⏳ pending | code path verified; not exercised at runtime |
| 6 | 9 skills load with fields | ✅ PASS | real compiled loader, 18 loaded, 0 problems |
| 7 | authority parity | ✅ PASS | 37 subjects, 0 semantic differences |
| 8 | deny-by-default → B | ✅ PASS | all 4 unmatched subjects → class B |

**Iteration 0 verdict: PASS with 3 criteria pending**, all blocked on the same thing — the
running `/app/build` predates the commit, so the flag path and tool count can only be
exercised after a rebuild. That rebuild is Iteration 1's first step.
