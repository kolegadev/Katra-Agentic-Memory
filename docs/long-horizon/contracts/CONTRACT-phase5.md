# CONTRACT.md — Phase 5: Uncertainty Engine (DETERMINISTIC TRIGGERS, SHADOW)

**Loop:** `new-code` · **Director/Verifier:** the loop director · **Generator:** the generator
**Branch:** `feat/cognitive-control-local` — **LOCAL ONLY, never pushed**
**Predecessor:** `86a71fc` (green, Phase 4 PASSED — shadow scheduler + real cost capture)
**Opened:** 2026-09-19 · **Authority:** the operator, explicit direction to proceed with Phases 4–7
**Status of thebrick:** being relocated ~11:00 UK 2026-09-20. This contract is written to survive that.

---

## 1. GOAL

Make the system **notice when it should doubt itself**, reopen exactly what that affects, and ask
independent minds for discriminating evidence — and be able to say afterwards whether the doubt was
worth its cost.

One sentence: *detect the conditions under which a confident conclusion is no longer safe to hold,
reopen precisely what depends on it, and account for whether the reopening earned its keep.*

Doc 03 Workflow 5 is the specification. Doc 04 Phase 5 is the build list. Its three exit criteria are
adopted verbatim in §4.

---

## 2. STATE — WHAT ALREADY EXISTS (read this before designing anything)

**The data model for Phase 5 was already built in Phase 1 and is not in question.** Verified 2026-09-19:

`epistemic-entry.schema.json` already carries `depends_on` (the traversal hook),
`alternative_hypotheses` (diversity), `independence_requirement` with a **`blind_parallel`** mode,
`consequence_if_false` (negligible→critical), `confidence_history`, `information_needed`, and a
status enum containing **`invalidated`**.

`state-delta.schema.json` already carries every delta type Phase 5 needs:
`ASSUMPTION_CHALLENGED`, `UNCERTAINTY_OPENED|UPDATED|RESOLVED`, `HYPOTHESIS_ADDED|REJECTED`,
`EXPERIMENT_PROPOSED|RESULT`, `DECISION_INVALIDATED`, `PLAN_CHANGE_PROPOSED`.

**So Phase 5 is an ENGINE over an existing model, not a modelling exercise.** Do not rebuild the schemas.
If you believe a schema genuinely must change, that is a finding for the Verifier, not a silent edit.

**Also already true, and not to be redone:**

- **The `llm-service.ts` boundary extension is DONE and AUTHORISED** (commit `988be77`). The usage ledger
  exists (`llm-usage-ledger.ts`, AsyncLocalStorage attribution, exactly-once settle, tokens-not-currency)
  and `instrumentClientForUsage` wraps both client-construction paths. **Phase 5 must not re-open it.**
  Phase 5 *consumes* it for trigger-precision telemetry (§5.4). This closes the Phase 4 §2 prerequisite.
- **The container image now contains this branch** (`c8191aa`, rebuilt and verified 2026-09-19). The
  long-standing open item *"the running `/app/build` predates both commits"* is **CLOSED**. Flag-off is
  indistinguishable from the feature being absent: 81 tools off, 93 on, exactly +12, verified through the
  real MCP entrypoint.

---

## 3. BOUNDARIES

### In scope
```
server/src/services/mission-cognition/**      Generator owns
server/src/types/cognitive-control.ts         Generator owns
server/src/mcp-server.ts                      (add tool registrations)
server/tests/**                               (mission-cognition tests + fixtures)
```

### ⛔ ABSOLUTELY OUT OF SCOPE — THE SAFETY-CRITICAL BOUNDARY (unchanged from Phase 4)
| Excluded | Why |
|---|---|
| **`server/src/services/processing/autonomous-executive.ts`** | **DO NOT TOUCH.** Modifying the live allocator is an automatic FAIL. It is currently byte-identical to `main`; it must stay that way. |
| `llm-service.ts` | Boundary already extended and audited. Do not re-open. |
| `services/authority/**`, `server/src/skills/**` | Verifier's file set. |
| Real task allocation of any kind | Phase 6, and only with the operator's explicit approval. |
| Any new scheduler mode beyond `off` / `shadow` | Phase 6. |

**Phase 5 is still shadow.** The uncertainty engine may read state, open uncertainties, traverse
dependencies, generate blind work items and record evaluations. It must not influence a single real
allocation, and it must not send anything outward.

### Privacy boundary — this is where it gets tested for real
Phase 4 asked that no private content leak into an *explanation*. Phase 5 goes further: **blind work
items must not carry the incumbent conclusion, the incumbent rationale, or any private memory content.**
A leaked explanation is embarrassing. A leaked hypothesis contaminates the independence of the very
evidence you are gathering, and the test can no longer tell you anything.

---

## 4. SUCCESS CRITERIA

Numbered, testable, graded PASS/FAIL with evidence by the Verifier. Items 1–3 and 20–24 are
non-negotiable; a partial pass on 4–19 is a FAIL for the phase, not a partial credit.

### Trigger detection — deterministic first (doc 04)
1. **All eight** trigger candidates from doc 03 Workflow 5 are implemented as deterministic detectors over
   existing state: (a) repeated failure with stable/rising confidence; (b) high confidence supported only
   by inferred or inherited assumptions; (c) a single active hypothesis for a high-impact decision;
   (d) material contradictory evidence; (e) unexpected experiment result; (f) plan unchanged despite
   information that should affect it; (g) strong critic disagreement or unstable evidence provenance;
   (h) convergent agents sharing one incumbent rationale.
2. **No model call in the detection path.** Asserted by test: with the LLM client made unavailable,
   detection produces an identical trigger set.
3. Detection is **deterministic** — identical state yields an identical trigger set, asserted by test.
4. Each detector is individually testable with a **firing fixture and a near-miss fixture**. A detector
   that fires on everything is a FAIL, and this is the criterion that catches performative doubt.

### Assumption dependency traversal
5. Given an epistemic entry, the engine returns the **transitive** dependent set through `depends_on`.
6. Traversal is **cycle-safe** and depth-bounded, and reports the bound it applied. A cycle cannot hang it.
7. **Contradicting a high-impact assumption reopens exactly the downstream decisions that depend on it,
   and no others.** *(doc 04 exit criterion 1)*

### Blind independent work generation
8. Blind work items are marked `independence_requirement: blind_parallel`.
9. **A blind item carries no incumbent conclusion, no incumbent rationale, and no private memory
   content.** Test with a fixture containing all three and assert none is reachable from the item payload
   or from any prompt assembled for it. *(doc 04 exit criterion 2)*
10. Two blind workers asked the same question cannot learn from their inputs that the other exists.
11. Reopening queues review — it does not silently resume.

### Hypothesis diversity
12. Diversity is measured over **submitted** hypotheses, and the measurement is reported to a human.
13. Hypotheses are compared **only after independent submissions are committed**. One worker's answer
    cannot reach another before commit — asserted by test.
14. A hypothesis is accepted only with **falsifiable form plus distinguishing evidence**; a generic
    alternative is rejected or explicitly flagged as not-falsifiable.

### Decision invalidation and suspension (doc 03 Workflow 6)
15. Invalidation propagates through **State Deltas** — never by direct mutation of mission state.
16. Suspension is scoped to **affected work only, never the whole mission**.
17. The prior plan and the reason for change are **preserved** for audit and learning.

### Experiment registry
18. Experiments can be proposed, listed and resolved; a discriminating test records **which hypotheses
    it separates**.
19. An experiment result contradicting accepted state **opens a contradiction** rather than silently
    overwriting.

### Trigger precision and cost telemetry (doc 04; uses the Phase 4 ledger)
20. Every fired trigger records its outcome as **useful information / mere variance / unnecessary cost**,
    with token cost taken from the usage ledger — measured, never estimated.
21. Precision is computable from stored records: at minimum **fires, useful, performative, and cost per
    useful trigger**. A trigger mechanism that cannot be scored is not finished. *(doc 04 exit criterion 3)*

### Safety and deployment
22. `COGNITIVE_SCHEDULER_MODE` gains **no new mode**. `recommend` / `allocate_*` remain Phase 6.
23. `autonomous-executive.ts` remains **byte-identical to `main`**, asserted by the existing guard test.
24. With flags `off`, **none of the new tools are reachable — including by direct `tools/call`.**
25. **Deployment-level acceptance:** at least one criterion must be verified through the **container
    image's own code path** (`/app/build`), not a mounted source tree. This is not ceremony — Phase 4's
    entire implementation was invisible to real clients for a day because every check ran against the
    mount. Verification must exercise the artifact that ships.

---

## 5. INTERFACES

### 5.1 New MCP tools (indicative — the Generator may name them better)
```
list_uncertainties            open/active uncertainty entries for a mission
evaluate_triggers             run detection over current state; return fired triggers + reasons
trace_assumption_dependencies transitive dependents of an entry, with the depth bound applied
invalidate_decision           propagate DECISION_INVALIDATED via deltas; suspend affected work
propose_experiment            register a discriminating test and the hypotheses it separates
record_experiment_result      attach a result; open a contradiction if it conflicts with accepted state
get_trigger_report            fires / useful / performative / cost per useful trigger
```
**Every one of these must be unreachable with the flag `off`, including by direct `tools/call`.**

### 5.2 Flags — unchanged
```
COGNITIVE_CONTROL_ENABLED = off | read | write      default off
COGNITIVE_SCHEDULER_MODE  = off | shadow            default off   (Phase 4 set; Phase 5 adds no mode)
```
New engine verbs are gated by `COGNITIVE_CONTROL_ENABLED=write` **and** are additionally unreachable
while `COGNITIVE_SCHEDULER_MODE=off`. Phase 5 never activates allocation.

### 5.3 Collections
Reuse the Phase 1 set. `epistemic_entries` + `state_deltas` + `cognitive_work_items` cover essentially
everything. If trigger evaluation needs its own collection (likely, for §4.20–21), add it to
`collections.ts` **with indexes**, and say so in the work-log. Do not silently invent a collection.

### 5.4 The usage ledger — the Phase 4 payoff
`llm-usage-ledger.ts` gives scope-attributed, exactly-once token accounting. Phase 5 is the first
consumer that makes it *matter*: trigger precision is only honest if "what did this doubt cost" is
measured. Attribute every trigger-scoped call with `runWithUsageOrigin({ mission_id, work_item_id })`
and snapshot deltas with `.since(earlier)`.

**Remember the snapshot semantics:** monotonic counts subtract, but `open` is the CURRENT outstanding
count and is **not** a difference. An unsettled stream left `open` is honest, not a bug.

---

## 6. TEST AND VERIFICATION COMMANDS

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd ~/Katra-Agentic-Memory/server
npm run typecheck
npm run build
env -u KATRA_USER_ID npx vitest run                      # full suite, not just mission-cognition
```
*(`env -u KATRA_USER_ID` is required — the agent session exports it and it flips six identity tests.)*

**The Verifier runs these independently. The Generator's own results are not evidence.** That is the
loop's core safety property and the reason this project exists.

**Deployment check (§4.25), for the image, not the mount:**
```bash
docker exec katra-server sh -c 'ls /app/build/services/mission-cognition | wc -l'
docker exec -e COGNITIVE_CONTROL_ENABLED=write -e COGNITIVE_SCHEDULER_MODE=shadow \
  katra-server node -e 'import("/app/build/services/mission-cognition/mcp-tools.js").then(m=>console.log(m.COGNITIVE_TOOL_DEFS.length))'
```
Baseline at `86a71fc`: **17 modules, 12 tool defs, 81 tools off → 93 on.**

---

## 7. THE DECISIVE TEST FOR PHASE 5

Not "does it detect things." The questions that decide whether this phase succeeded:

> **A.** Contradict a high-impact assumption. Does the system reopen **exactly** what depends on it —
>    not more, not less — give a reason a human can read, and hand a blind worker a brief from which the
>    incumbent conclusion **cannot be reconstructed**?
>
> **B.** Faced with a genuinely uncertain situation **and** a merely noisy one, does it fire in the first
>    and stay quiet in the second — and can it tell you **afterwards** whether the doubt was worth what it
>    cost?

If A is yes and B is yes, Phase 5 is done. An engine that doubts everything is not cautious, it is
useless — and it launders performative doubt into a metric that looks like diligence. An engine that
leaks the incumbent conclusion into a blind brief has destroyed the only thing blind parallelism is for.

---

## 8. REVERT AND PROCESS

- **Green ref:** `86a71fc` — the known-good fallback, graded Phase 4 PASS.
  `katra/server:rollback-20260919` is the matching image rollback.
- Max **3 attempts**, then revert and escalate to the operator.
- **One phase at a time, graded between.** Do not start Phase 6.
- Generator commits frequently and keeps the tree consistent.
- Every iteration posts a Katra work-log.
- Verifier never edits `mission-cognition/**`; findings are reported, not patched.
- Generator never edits `services/authority/**` or `server/src/skills/**`.

---

## 9. WHAT PHASE 5 DOES NOT DO

Restating so it cannot drift:

- It does **not** change allocation. Shadow only.
- It does **not** implement `recommend` / `allocate_*` (Phase 6, and only with the operator's explicit approval).
- It does **not** re-open `llm-service.ts` — that boundary is closed and audited.
- It does **not** rebuild the epistemic schemas — Phase 1 built them and they are sufficient.
- It does **not** activate model-assisted trigger detection. **Deterministic triggers first.** A model may
  only be added after labelled examples exist, and that is a separate, later, graded change.
- It does **not** touch the dashboard (Phase 7).
- It does **not** modify `autonomous-executive.ts` under any circumstances.
- It does **not** push anything. Publication is the operator's decision and nothing leaves the machine.
