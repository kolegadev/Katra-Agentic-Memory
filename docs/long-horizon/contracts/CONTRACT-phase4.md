# CONTRACT.md — Phase 4: Cognitive Scheduler (SHADOW MODE)

**Loop:** `new-code` · **Director/Verifier:** Lilly · **Generator:** Satori
**Branch:** `feat/cognitive-control-local` — **LOCAL ONLY, never pushed**
**Predecessor:** `1a55b1f` (green, Phase 0–3 complete, decisive test passed)
**Opened:** 2026-09-19 · **Authority:** John, explicit direction to proceed with Phases 4–7

---

## 1. GOAL

Build a cognitive scheduler that decides **what deserves cognition next and which mind should do it**,
and that can **explain every score it produces** — while changing nothing about how work is actually
allocated today.

One sentence: *produce ranked, explainable recommendations in shadow mode, and be measurably right
about them before anyone acts on them.*

---

## 2. ⚠️ PREREQUISITE — RESOLVE BEFORE ANY SCORING CODE

**The scheduler's formulas need cost data that does not exist.**

Design doc 03 specifies:
```
priority = mission_impact * max(uncertainty, uncertainty_floor) * expected_information_value
         * dependency_centrality * urgency / max(cognitive_cost, cost_floor)
```
and doc 04's suitability model includes a `workload_penalty` and `capability_fit`.

**Verified state:** there is no cost telemetry anywhere in the server. `cognitive-control.ts:166` has
`budget?: { max_cost?, max_hours? }` — a *declared* budget, not a measured one. `llm-service.ts` tracks
`cacheStats.totalTokens` for caching, not per-call cost. No `token_usage` / `cost_usd` collection exists.
This is review finding §4.2 and it is still open.

**DECIDE AND RECORD ONE OF:**
- **(a) Capture real cost** — attribute token counts (and therefore cost) per LLM call, keyed so a
  cognitive work item can look them up. Cleanest, but a real piece of work.
- **(b) Use a documented proxy** — e.g. a coarse cost band derived from call count × model tier, with
  the proxy stated in the explanation output so a reader knows what they are looking at.

**Either is acceptable. Silently inventing numbers is not.** The explanation record must state which
basis was used. A score that cannot be justified to a human fails §3.1.

---

## 3. BOUNDARIES

### In scope
```
server/src/services/mission-cognition/**      Generator owns
server/src/types/cognitive-control.ts         Generator owns
server/src/mcp-server.ts                      (add 3 tool registrations)
server/tests/**                               (mission-cognition tests)
```

### ⛔ ABSOLUTELY OUT OF SCOPE — THIS IS THE SAFETY-CRITICAL BOUNDARY
| Excluded | Why |
|---|---|
| **`server/src/services/processing/autonomous-executive.ts`** | **DO NOT TOUCH.** The design requires shadow mode: "Shadow recommendations alongside the existing allocator; do not change real allocation." Modifying the live allocator is an automatic FAIL. |
| `adaptive-heartbeat` / salience / drive services | existing allocation inputs; read-only if needed, never written |
| Real task allocation of any kind | Phase 6 is where activation happens, and only after evaluation |
| Scheduler-driven external effects | Phase 6+ |
| `services/authority/**`, `server/src/skills/**` | Verifier's file set |

**Shadow means shadow.** If the feature flag is set to `shadow`, the scheduler may read state and write
recommendations. It must not influence a single real allocation.

### Privacy boundary (criterion 3.3)
Scheduler explanations may say *"this agent has high historical success in this work class."*
They must **never** quote an agent's private journal, reflection, or emotional state. Features exposed
to the scheduler must be **derived, minimal, and non-narrative**. `agent-cognitive-profile.schema.json`
already has `derived_from_private_memory: {"const": false}` — that constraint must be enforced, not decorative.

---

## 4. SUCCESS CRITERIA

Numbered, testable, graded PASS/FAIL with evidence by the Verifier.

### Prerequisite
1. The cost basis is decided, recorded in the code and in the explanation output, and is either real
   measurement or an explicitly labelled proxy. No invented numbers.

### Work generation and scoring
2. Work items can be generated from real triggers: open objectives, invalidated decisions, unresolved
   uncertainties, stale checkpoints, blocked dependencies.
3. Every work item carries the priority feature vector (`mission_impact`, `uncertainty`,
   `information_value`, `dependency_centrality`, `urgency`, `cognitive_cost`).
4. Priority score is **deterministic** — identical inputs produce an identical score, asserted by test.
5. Zero, missing, or absent `cognitive_cost` / `uncertainty` does **not** cause division errors or
   infinite scores (doc 05 requires this explicitly).

### Explainability
6. Every score has a persisted explanation naming each contributing feature, its value, and its weight.
7. `explain_scheduler_decision` returns the ranked candidates, the exclusions **with reasons**, and the
   rationale — for the decision as a whole, not just the winner.
8. **No private memory content appears in any explanation.** Test with a fixture containing private
   material and assert none of it is reachable through the explanation surface.

### Suitability
9. An agent cognitive profile can be projected from observable outcomes (work class, attempts, success,
   cost) without reading private content.
10. Suitability ranks candidates using the design's factors, and the **correlation penalty** is present
    and observable — agents sharing an incumbent rationale must be penalised.
11. Workload penalty applies; a saturated agent cannot outrank an idle one on equal merit.

### Shadow mode — the safety property
12. With `COGNITIVE_SCHEDULER_MODE=shadow`, **no real allocation changes.** Prove it: run the existing
    allocator path before and after and show identical output.
13. With the flag `off`, none of the 3 new tools are reachable — including by direct `tools/call`
    (the Phase 0 criterion-#5 standard).
14. Recommendations are recorded even when not acted upon, so they can be evaluated later.

### Integrity
15. Every recommended choice records what was recommended, what the existing allocator chose, and (when
    known) which turned out better — the allocation-regret input doc 05 asks for.

---

## 5. INTERFACES

### New MCP tools (3 — bringing the branch to 12 cognitive tools)
```
create_cognitive_work_item     add bounded cognition to the queue
get_cognitive_queue            inspect prioritised work and ownership
explain_scheduler_decision     return scores, exclusions and rationale
```

### Flag
```
COGNITIVE_SCHEDULER_MODE = off | shadow | recommend | allocate_internal | allocate_gated
                           default: off        (Phase 4 implements off + shadow ONLY)
```
`recommend` and beyond belong to Phase 6. **Do not implement them now.**

### Collections — already created in Phase 1, now populated
```
cognitive_work_items       queue + lifecycle + leases
agent_cognitive_profiles   suitability features and observed performance
scheduler_decisions        ranked candidates, scores, exclusions, budgets, rationale
```

---

## 6. TEST AND VERIFICATION COMMANDS

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd ~/Katra-Agentic-Memory/server
npm run typecheck
npm run build
env -u KATRA_USER_ID npx vitest run tests/unit/mission-cognition*.test.ts
```
*(`env -u KATRA_USER_ID` is required — the agent session exports it and it flips six identity tests.)*

**The Verifier runs these independently. The Generator's own results are not evidence.**

---

## 7. THE DECISIVE TEST FOR PHASE 4

Not "does it score things." The questions that decide whether this phase succeeded:

> **A.** Can a human read `explain_scheduler_decision` and say why the system wants to do *this* next,
>    and what would change its mind?
>
> **B.** Has anything about real allocation changed? (Must be **no**.)

If A is yes and B is no, Phase 4 is done. A scheduler nobody can interrogate is worse than no scheduler,
because it launders a guess into an authoritative-looking number.

---

## 8. REVERT AND PROCESS

- **Green ref:** `1a55b1f` — the known-good fallback. `971ac1d` also stands.
- Max **3 attempts**, then revert and escalate to John.
- Generator commits frequently and keeps the tree consistent — **thebrick is being relocated tomorrow
  (~11:00 UK) and will be powered off mid-flight.** An interrupted iteration costs a rebuild, not a loss,
  provided work is committed.
- Do not start Phase 5 until Phase 4 is graded.
- Every iteration posts a Katra work-log.

---

## 9. WHAT PHASE 4 DOES NOT DO

Restating so it cannot drift:
- It does **not** change allocation (shadow only).
- It does **not** implement `recommend` / `allocate_*` (Phase 6).
- It does **not** build the uncertainty engine or trigger detection (Phase 5).
- It does **not** touch the dashboard (Phase 7).
- It does **not** modify `autonomous-executive.ts` under any circumstances.
