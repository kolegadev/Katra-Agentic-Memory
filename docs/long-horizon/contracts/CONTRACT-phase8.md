# CONTRACT.md — Phase 8: Evaluation and Skill Evolution (FINAL)

**Loop:** `new-code` · **Director/Verifier:** Lilly · **Generator:** Satori
**Branch:** `feat/cognitive-control-local` — **LOCAL ONLY, never pushed**
**Authority:** John, explicit — *"if passes then tell Satori to proceed with Phase 8 … I want to get to the go live and small test before thebrick move"* (2026-09-20)
**Opened:** 2026-09-20 · **Predecessor:** the Phase 7 green ref (set on grading)

> ## ⛔ NOT OPEN UNTIL PHASE 7 IS GRADED
> Phase 7 has one defect outstanding (§4.14 rebuild not idempotent). This opens the moment it is fixed and
> graded. It is written now because the move window is short.

---

## 0. GO LIVE FIRST — the precondition, and the time-critical part

Phase 8 evaluates the plane, so the plane has to be running. **Before the evaluation work**, bring it up in
production — but only as far as the evidence gate allows:

```
COGNITIVE_CONTROL_ENABLED = write
COGNITIVE_SCHEDULER_MODE  = shadow
```

**`recommend` and above stay forbidden.** The gate requires ≥50 evidenced shadow decisions and cannot be
bypassed; attempting to skip it is exactly the failure six phases were built to prevent. Shadow is the whole
of "go live" for now: the tools become reachable to real clients for the first time, the nine views go live
against real missions, and shadow decisions begin accumulating toward the gate.

**The small test John asked for** — one real mission, end to end, through the real MCP entrypoint:
create a mission → submit deltas → generate a work item → run a shadow pass → read the explanation back →
checkpoint → resume from the mission id alone. Every step through the **container's own code path**, and
allocation provably untouched before and after.

Roll it back with the documented kill switch if anything is wrong. Be commit-clean throughout: the machine
moves today.

---

## 1. GOAL

Two things, and they are separate:

1. **Prove the plane behaves under failure.** Doc 04 names eight seeded modes; run them as controlled missions
   and compare against a baseline that does *not* have the layer.
2. **Let skills evolve — but only through gates.** candidate → replay → canary → promotion, with no path around
   them.

One sentence: *show that the plane is better than not having it, and make self-improvement impossible to skip
the checks.*

---

## 2. WHY THIS PHASE IS DANGEROUS, AND WHAT KEEPS IT SAFE

Everything so far has been built to fail closed. Phase 8 deliberately **injects failure**. That inverts the
risk: for seven phases the danger was a component doing something it should not; here the danger is a seeded
fault escaping the test and touching real state, **and** a skill being promoted on the strength of a run that
did not actually prove anything.

Two rules follow, and they are not negotiable:

- **Failure is injected into controlled missions only.** Never into production collections, never into a
  mission anyone is working on. The injection path must be incapable of reaching real state, not merely
  expected not to.
- **A skill that has not passed every gate is not improved, it is unverified.** The gate chain exists because
  a self-modifying system with a fast path is a system that will eventually take it.

---

## 3. BOUNDARIES

### In scope
```
server/src/services/mission-cognition/**      Generator owns
server/src/routes/cognition-dashboard-routes.ts   (evaluation views, if needed)
server/tests/**                               Generator owns (incl. the seeded-fault harness)
server/src/services/memory/skill-loader-service.ts   ⚠️ shared with Verifier — see below
```

### ⛔ OUT OF SCOPE
| Excluded | Why |
|---|---|
| **`autonomous-executive.ts`** | **CLOSED.** Must remain exactly the Phase 6 change (51 insertions, 0 deletions). Evaluation does not license touching the live allocator. |
| Production collections | Seeded faults go to controlled missions only. |
| `COGNITIVE_SCHEDULER_MODE` above `shadow` without the gate | §0. The gate is the gate. |
| `llm-service.ts` | Closed and audited in Phase 4. |
| `services/authority/**` | Verifier's file set. |
| Anything that pushes | Never. |

### ⚠️ `skill-loader-service.ts`
Phase 8 touches the skill lifecycle, and that file is shared. The rule from earlier phases holds: **any change
is additive and enumerated in the work-log**, and the Verifier's nine seed skills must keep loading unchanged.
If the promotion path can live in mission-cognition instead, put it there.

---

## 4. SUCCESS CRITERIA

Numbered, testable, graded PASS/FAIL with evidence by the Verifier.

### Go live (§0)
1. The plane is running in production as `write` + `shadow`, **verified through the container's own code path**,
   with the MCP tool surface reachable and the nine views live.
2. The small test passes end to end: mission → deltas → work item → shadow pass → explanation → checkpoint →
   resume-from-id, with real data and no transcript replay.
3. **Allocation is provably untouched by the go-live.** The allocator diff is still exactly the Phase 6 change
   and the off-state equivalence test still passes.
4. The kill switch is exercised once, for real, and returns the plane to `off` without a rebuild.

### Seeded failure modes (doc 04) — all eight
5. Each of the eight is seeded and observed: (a) wrong inherited assumption; (b) contradictory evidence;
   (c) context loss; (d) stale baton; (e) executor duplication; (f) graph lag; (g) LLM outage;
   (h) correlated agents.
6. For each: the harness **states what correct behaviour is before running it**, and reports what actually
   happened — including "the plane did not detect this", which is a legitimate and valuable result.
7. **Seeded faults cannot reach production state.** Demonstrated structurally, not asserted: a test proves the
   injection path is incapable of writing to a non-controlled mission.
8. A seeded fault that the plane does **not** handle is reported as a finding, not smoothed over. A clean sweep
   of eight would be suspicious; one honest failure is worth more than eight green ticks.

### Baseline comparison (doc 04)
9. The baseline is **defined before measuring**: current missions and autonomous allocation **without** the new
   layer. State the comparison and the metric in advance; do not choose the metric after seeing the numbers.
10. The comparison is reported honestly, including where the layer is **not** better. A comparison that only
    ever favours the new thing is not a comparison.

### Skill evolution gates (doc 04)
11. The full chain exists and is enforced: **candidate → replay → canary → promotion**.
12. **No path skips a gate.** Promotion without replay, or without canary, is refused and the refusal is
    recorded — asserted by test.
13. Replay runs against **historical missions**, and a candidate that regresses is rejected on that evidence.
14. Canary is scoped and reversible.
15. An active mission's skill version is **pinned** unless an explicit migration is approved.
16. Promotion requires the configured evidence threshold; a single good run is not enough.

### Safety
17. `autonomous-executive.ts` unchanged from Phase 6 (51 insertions, 0 deletions).
18. No new secret exposure; no credential in any response, log, or page source.
19. Flag-off remains indistinguishable from feature-absent on every new surface.
20. No push. Guard armed. The machine may be off by the time this is read.

---

## 5. INTERFACES

### 5.1 Seeded-fault harness
A controlled-mission harness. Fixtures and results live beside the existing harness evidence under
`~/katra-long-horizon/loop/harness/`, and each run is captured, not summarised.

### 5.2 Skill lifecycle
```
propose_skill_candidate      register a candidate against an existing skill
run_skill_replay             replay against historical missions; report regressions
start_skill_canary           scope and start a canary
promote_skill_version        only with replay + canary evidence present
pin_skill_version            pin a version to an active mission
```
Every one gated; every refusal recorded.

### 5.3 Flags
Unchanged. `COGNITIVE_ACTIVATION_KILL_SWITCH` remains the kill switch, and §4.4 exercises it for real.

---

## 6. TEST AND VERIFICATION COMMANDS

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd ~/Katra-Agentic-Memory/server
npm run typecheck && npm run build && env -u KATRA_USER_ID npx vitest run
git -C .. diff --stat main -- server/src/services/processing/autonomous-executive.ts   # 51 insertions
```
**The Verifier runs these independently. The Generator's own results are not evidence.**

---

## 7. THE DECISIVE TEST FOR PHASE 8

> **A.** Seed all eight failure modes into controlled missions. Does the plane **detect and handle** them, and
>    is it **measurably better than the baseline without the layer** — on a metric chosen before the numbers
>    were seen?
>
> **B.** Try to promote a skill by skipping replay, and by skipping canary. Does the system **refuse**, and
>    record the refusal?

If A is yes and B is yes, Phase 8 is done and the plane is complete.

**The failure mode this guards against:** a system that grades its own homework. Phase 8 is the first phase
where the thing being evaluated and the thing doing the evaluating are the same code — which is precisely why
the baseline is defined in advance, the gates cannot be skipped, and "the plane did not detect this" must be
written down rather than quietly dropped.

---

## 8. REVERT AND PROCESS

- **Green ref:** the Phase 7 graded ref. `8cfd2ea` (Phase 6) stands as a fallback.
- **Image tags:** verify a tag contains what its name claims before relying on it.
- Max **3 attempts**, then revert and escalate to John.
- Verifier never edits `mission-cognition/**`; findings are reported, not patched.
- Every iteration posts a Katra work-log.

---

## 9. WHAT PHASE 8 DOES NOT DO

- It does **not** push. Ever.
- It does **not** raise the scheduler mode above `shadow` without the evidence gate.
- It does **not** inject failure into production state.
- It does **not** touch `autonomous-executive.ts` beyond the Phase 6 change.
- It does **not** permit a skill promotion that skips a gate.
- It does **not** choose its metric after seeing its results.
