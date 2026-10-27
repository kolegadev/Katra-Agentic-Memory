# CONTRACT.md — Phase 6: Controlled Activation (THE FIRST PHASE THAT CAN TOUCH REAL ALLOCATION)

**Loop:** `new-code` · **Director/Verifier:** Lilly · **Generator:** Satori
**Branch:** `feat/cognitive-control-local` — **LOCAL ONLY, never pushed**
**Authority:** John, explicit — *"Ok then when completed Phase 5 get Satori to proceed with Phase 6"* (2026-09-19)
**Opened:** 2026-09-19 · **Predecessor:** the Phase 5 green ref (to be set on grading)

> ## ⛔ NOT OPEN YET
> This contract is **authorised but not open**. Phase 5 must be completed, graded PASS, and the loop green ref
> advanced **before** any work here begins. It exists so the Generator is not blocked waiting for it.
> Starting Phase 6 with Phase 5 criteria outstanding is a process FAIL, not a head start.

---

## 1. GOAL

Let the scheduler **actually influence allocation** — narrowly, reversibly, with a bounded blast radius and a
recorded counterfactual for every choice it affects — so that a mission can be run by the system rather than
merely advised by it.

One sentence: *take the recommendation that shadow mode proved right, act on it inside one opted-in mission,
and be able to prove exactly what happened and undo it in one command.*

---

## 2. WHY THIS PHASE IS DIFFERENT FROM EVERY PHASE BEFORE IT

For four phases the entire safety architecture has rested on one property: **the scheduler recommends and
never allocates.** That is what made criterion 12, decisive test B, and the byte-identical allocator diff
sufficient — they proved *isolation*, and isolation is easy to prove when nothing is ever connected.

**Phase 6 removes that property by design.** After activation, those same checks stop being sufficient,
because the question changes from *"is it even connected?"* to *"is the wiring correct, and is the blast
radius bounded?"* Everything below is written for that change, and the criteria are ordered so that the
hardest-to-reverse decisions are made last.

**Two consequences that shape the whole contract:**

1. **The counterfactual is not optional.** An activated allocator that does not record what the old allocator
   would have done has made itself unfalsifiable. Regret cannot be measured, success cannot be distinguished
   from luck, and the only remaining way to judge it is by vibes. §4.12–14 exist to prevent exactly that.
2. **Reversibility is a feature, not an incident response.** Every mode must be reachable from every other
   mode, and returning to `off` must be provable rather than hoped for (§4.10, §4.19–20).

---

## 3. BOUNDARIES

### In scope
```
server/src/services/mission-cognition/**      Generator owns
server/src/services/processing/autonomous-executive.ts
                                              ⚠️ NOW IN SCOPE — but see the rule below
server/src/types/cognitive-control.ts         Generator owns
server/src/mcp-server.ts                      (mode + opt-in control surface)
server/tests/**                               (activation tests + the off-state equivalence fixture)
```

### ⚠️ THE `autonomous-executive.ts` RULE — read this twice
This file was **absolutely untouchable** in Phases 4 and 5 and is currently **byte-identical to `main`**.
Phase 6 is the only phase authorised to change it, and only under these conditions:

- **Prefer not to touch it.** If the wiring can live entirely in the mission-cognition layer reading
  allocation state and emitting gated decisions, do that instead. State the choice in the work-log either way.
- If it must change: **additive only**. The existing pre-activation code path must remain, unmodified in
  behaviour, and be the path taken when the flag is `off`.
- **Every changed line is enumerated in the work-log with a one-line justification.** A silent edit here is an
  **automatic FAIL** for the phase, regardless of how well the rest scores.
- The `off`-state equivalence test (§4.16) is written **before** the change, not after.

### ⛔ Still out of scope
| Excluded | Why |
|---|---|
| `llm-service.ts` | Boundary closed and audited in Phase 4. Do not re-open. |
| `services/authority/**`, `server/src/skills/**` | Verifier's file set. |
| Any externally-visible effect without a human gate | §4.6. Phase 7 or later, and separately contracted. |
| Model-assisted trigger detection | Phase 5 deferred it deliberately; it needs labelled examples first. Still deferred. |
| Dashboard | Phase 7. |

---

## 4. SUCCESS CRITERIA

Numbered, testable, graded PASS/FAIL with evidence by the Verifier.

### The evidence gate — you may not activate what you have not measured
1. **`recommend` cannot be enabled without evidence.** A minimum evidenced record of shadow-mode decisions
   must exist — at least **50** recorded `scheduler_decisions` for real missions in which the scheduler ranked
   candidates AND the existing allocator's actual choice is known — together with a measured agreement or
   regret figure that a human has read. Enabling `recommend` below that threshold is a **FAIL**, not a
   judgement call. This is the whole point of having built shadow mode first.
2. The gate reads **stored records**, not an assertion. A test proves the gate refuses when the evidence is
   absent and opens when it is present.

### Mode semantics — one flag, escalating by construction
3. `COGNITIVE_SCHEDULER_MODE = off | shadow | recommend | allocate_internal | allocate_gated`, default `off`.
   Each mode subsumes the safety of the one before it. No mode may be skipped in the implementation order.
4. **`recommend`** produces advisories only. **No allocation call may read a recommendation.** Proved by the
   same call-site discipline as Phase 4's criterion 12 — a static check plus an operational one.
5. **`allocate_internal`** may influence allocation **only** within missions explicitly opted in, and only
   among internal agents. An opted-out mission behaves exactly as today.
6. **`allocate_gated`** — any externally-visible effect requires a human gate. A recommendation alone must
   never produce an external effect. If this cannot be demonstrated, do not implement the mode.

### Blast radius
7. Activation is **per-mission opt-in**. There is no global "turn it on for everything" switch.
8. An opt-in **can be revoked**, and revocation takes effect without a rebuild. Tested.
9. A **hard bound** exists on how many work items one activation cycle may influence. On breach the system
   **halts rather than proceeds** — fail closed, never fail open.

### Kill switch and rollback
10. A single control returns the system to pre-activation behaviour **without a rebuild** (env var plus
    restart, or a runtime toggle). Tested by actually doing it.
11. Documented one-command rollback, and the tag is **verified to contain what its name claims** before it is
    relied on. (We have already shipped one rollback tag that pointed at the wrong build. Verify, do not assume.)

### Counterfactual audit — what makes activation defensible
12. Every allocation influenced by the scheduler records **what the existing allocator would have done
    instead**. Without the counterfactual, activation is unfalsifiable.
13. Records distinguish "the scheduler's choice was taken" from "the existing allocator's choice was taken",
    so an agreement rate is computable from stored data.
14. A human can read, for any influenced allocation, **why it happened and what the alternative was**.

### Safety and deployment
15. `autonomous-executive.ts` changes comply with the §3 rule. Enumerated, additive, justified.
16. With the flag `off`, the allocator's output is **byte-identical to the pre-Phase-6 baseline** over a fixed
    input fixture. This test is written **before** any allocator change.
17. **`NO PUSH`** remains absolute. Guard v4 armed and blocking. Publication is John's decision alone.
18. **Deployment acceptance through the image path** (the Phase 5 criterion-25 discipline carries forward):
    at least one criterion verified via `/app/build` in the running container, not a mounted source tree.

### Reversibility
19. Every mode transition is reachable and verified: `allocate_internal → recommend → shadow → off`.
    A one-way door is a FAIL.
20. Every mode transition is recorded with **who, when, and on what evidence**.

---

## 5. INTERFACES

### 5.1 Control surface (indicative)
```
set_scheduler_mode            off | shadow | recommend | allocate_internal | allocate_gated
opt_in_mission                enable activation for ONE mission, with a stated reason
revoke_mission_opt_in         reverse it; must take effect without a rebuild
get_allocation_evidence       the gate: decisions recorded, agreement/regret, threshold state
get_activation_ledger         who changed what mode, when, on what evidence
get_allocation_counterfactual for an influenced allocation: what was chosen and what the alternative was
```

### 5.2 Flags
```
COGNITIVE_CONTROL_ENABLED = off | read | write     default off
COGNITIVE_SCHEDULER_MODE  = off | shadow | recommend | allocate_internal | allocate_gated
                                                    default off
COGNITIVE_ACTIVATION_KILL_SWITCH = unset | 1       # §4.10, no rebuild required
```

### 5.3 Collections
Add **with indexes** and say so in the work-log: an activation ledger, an opt-in register, and the
counterfactual record. Do not silently invent collections, and do not widen a Phase 1 schema without telling
the Verifier why.

---

## 6. TEST AND VERIFICATION COMMANDS

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd ~/Katra-Agentic-Memory/server
npm run typecheck
npm run build
env -u KATRA_USER_ID npx vitest run                      # full suite
```
*(`env -u KATRA_USER_ID` is required — the agent session exports it and it flips six identity tests.)*

**Also required before grading — the immutable-allocator check, until §4.15 authorises a change:**
```bash
git diff --stat main -- server/src/services/processing/autonomous-executive.ts
```
An empty diff is free evidence. Once it is legitimately non-empty, the §3 enumeration rule replaces it.

**Deployment check (§4.18), against the image:**
```bash
docker exec katra-server sh -c 'ls /app/build/services/mission-cognition | wc -l'
```
Baselines: `86a71fc` = 17 modules, 12 tools, 81 off → 93 on. `be56f35` = 24 modules, 22 tools, 81 off → 103 on.

**The Verifier runs all of these independently. The Generator's own results are not evidence.**

---

## 7. THE DECISIVE TEST FOR PHASE 6

> **A.** Enable the highest mode for **one** opted-in mission. Does anything **outside** that mission change?
>    (Must be **no** — not "probably no".)
>
> **B.** Turn every flag back to `off`. Is the system **provably** exactly as it was — same allocator output,
>    same tool surface, no residue, no scheduled work left behind?
>
> **C.** Before it ever influenced a real allocation, was there **stored evidence that its recommendations were
>    measurably right** — not that it had been running, but that it had been *right*, read by a human?

If A is no, B is yes, and C is yes, Phase 6 is done.

**The failure mode this guards against:** activating something that was never shown to be correct, discovering
that by watching production, and having no counterfactual and no clean way back. Shadow mode existed for four
phases specifically so that this moment would not be a guess.

---

## 8. REVERT AND PROCESS

- **Green ref:** the Phase 5 graded ref. `86a71fc` (Phase 4) remains a standing fallback.
- **Image tags:** verify each tag actually contains what it claims before relying on it. Phase 4's image is gone;
  a rebuild from a git ref is the fallback when no tag exists.
- Max **3 attempts**, then revert and escalate to John.
- **One phase at a time, graded between.** Phase 7 does not start until Phase 6 is graded.
- Generator commits frequently; Verifier never edits `mission-cognition/**`.
- Every iteration posts a Katra work-log.

---

## 9. WHAT PHASE 6 DOES NOT DO

- It does **not** push. Ever. Publication is John's decision and nothing leaves the machine.
- It does **not** activate globally — per-mission opt-in only.
- It does **not** produce externally-visible effects without a human gate.
- It does **not** re-open `llm-service.ts`.
- It does **not** add model-assisted trigger detection.
- It does **not** build the dashboard (Phase 7).
- It does **not** leave the system in a state that cannot be returned to `off` by a single control.
