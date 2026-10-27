# CONTRACT.md — Phase 7: Dashboard and Operations (FINAL PHASE)

**Loop:** `new-code` · **Director/Verifier:** the loop director · **Generator:** the generator
**Branch:** `feat/cognitive-control-local` — **LOCAL ONLY, never pushed**
**Authority:** the operator, explicit — *"once complete have the generator start the final Phase 7"* (2026-09-20)
**Opened:** 2026-09-20 · **Predecessor:** the Phase 6 green ref (set on grading)

> ## ⛔ NOT OPEN YET
> Authorised but **not open**. Phase 6 must be graded and the green ref advanced first. Phase 7 does not begin
> until Phase 6 has cleared the two outstanding gaps (the §3 work-log enumeration and the runbook reference).

---

## 1. GOAL

Make the whole system **legible to a human who did not build it** — so that someone can look at a live mission
and say why the system is doing its current work, what would change the plan, and how to repair it if it breaks,
**without reading the code and without asking us.**

One sentence: *turn six phases of internal state into something a person can actually reason with.*

---

## 2. WHY THIS IS THE RIGHT FINAL PHASE — AND WHAT IT IS NOT

Every phase so far has added machinery whose correctness we proved with tests. Phase 7 is the first that is
judged **by a person, not an assertion.** That changes what "good" means:

- A view that renders correctly but does not let a human answer *"why is it doing this?"* has failed, even at
  100% test coverage. The exit criterion in doc 04 is literally *"a human can explain why the system is doing
  its current work and what would change the plan"* — that is the test, and a human is the instrument.
- **Legibility beats decoration.** This is an internal operations surface, not a product. A number that cannot
  be traced to a stored record is worse than no number, because it will be believed. Prefer a plain table with
  provenance over an elegant chart without it.
- §4.9 makes this concrete: **every displayed number must trace to a stored record, and the UI must state the
  basis** — including the cost basis label Phase 4 built. A cost of `1` labelled
  `measured-tokens-zero-observed` is honest; a cost of `1` with no label is a lie by omission.

**What Phase 7 is not:** it is not a new business surface, and it must not become one. It reads what exists.

---

## 3. BOUNDARIES

### In scope
```
dashboard/**                                  Generator owns
server/src/services/mission-cognition/**      Generator owns (query/read APIs only)
server/src/mcp-server.ts                      (routes, if needed)
server/src/types/cognitive-control.ts         Generator owns
server/tests/**                               Generator owns
```

### ⛔ OUT OF SCOPE
| Excluded | Why |
|---|---|
| `autonomous-executive.ts` | **CLOSED.** Phase 6 added the only permitted bridge. Do not touch it. Re-assert the diff is exactly the Phase 6 51 insertions and no more. |
| `llm-service.ts` | Boundary closed and audited in Phase 4. |
| `services/authority/**`, `server/src/skills/**` | Verifier's file set. |
| Any new mutation of mission cognition | Phase 7 is a **read surface** (§4.4). |
| Model-assisted trigger detection | Still deferred; needs labelled examples. |
| Phase 8 (evaluation, skill evolution) | **Separately contracted.** Do not start it. |

### The safety boundary, restated
Phases 4–6 spent enormous effort making the system fail closed. **A dashboard is a new surface, and the easiest
way to undo that work is a button that mutates state without the gates.** Every view is read-only. The only
mutations are the custodian controls in §4.11, which are explicitly gated and audited.

---

## 4. SUCCESS CRITERIA

Numbered, testable, graded PASS/FAIL with evidence by the Verifier. Doc 04's two exit criteria are adopted
verbatim as criteria 1 and 2 — they are the point of the phase, and criteria 3–18 exist to make them true.

### The exit criteria (doc 04, verbatim)
1. **A human can explain why the system is doing its current work, and what would change the plan.** Demonstrated
   on a real mission by someone who did not build it, not asserted.
2. **The custodian can diagnose and repair without joining normal mission cognition.** Demonstrated by actually
   diagnosing a seeded fault.

### The nine views (doc 04), populated from real stores
3. All nine are present, and every one reads **real stored records** — no mock data, no placeholder panels:
   (a) mission overview + version timeline · (b) objective and dependency graph · (c) claims, evidence,
   assumptions, decisions, contradictions · (d) uncertainty register + trigger history · (e) work queue,
   ownership, leases, blockers · (f) scheduler explanation + shadow comparison · (g) baton inspector with
   redaction and blindness-policy summary · (h) skill versions, outcomes, challenge state, canary status ·
   (i) integrity, projection lag, backup, rebuild controls for the custodian.
4. A view may be **empty with a stated reason** (nothing to show, flag off) but must never show invented data.
   An empty state that explains itself is correct; a plausible-looking fake is a FAIL.

### Read-only by default — the safety property
5. **Every view is read-only. No view can mutate mission cognition, allocation, or activation state.**
6. The dashboard **cannot bypass the gates.** It respects the authority classes, the mode ladder, the evidence
   gate, and the kill switch. It must not expose a path that the MCP tools refuse.
7. With `COGNITIVE_CONTROL_ENABLED=off`, the cognitive views are absent or explicitly say so — consistent with
   the flag-off-indistinguishable rule that has held since Phase 0. A dashboard is not a back door.

### Privacy — the same boundary, a new surface
8. The baton inspector applies redaction and shows the blindness policy.
9. **No private journal, reflection, or emotional content is reachable through any view.** Test with a fixture
   containing private material and assert none of it appears in any response the dashboard can obtain.
10. The privacy finding from Phase 5 carries forward: a surface that *points at* incumbent material is a weaker
    leak than one that shows it, but it is still a leak.

### Explainability — the actual point
11. **Every displayed number traces to a stored record**, and the UI states the basis (including cost-basis
    labels). A human must be able to click through from a claim on screen to the record behind it.
12. The scheduler view shows **ranked candidates, exclusions with their reasons, and the shadow comparison** —
    not just the winner. This is Phase 4's decisive test A, made visible.
13. The activation view shows **the counterfactual**: for any influenced allocation, what the existing allocator
    would have done instead (§4.12 of Phase 6, finally readable by a human).

### Custodian
14. Integrity, projection lag, backup, and rebuild controls are present, gated, and audited. Rebuild is
    **idempotent** and reported honestly (what changed, what did not).
15. The custodian path does not require joining normal mission cognition to use.

### Deployment and safety
16. **Deployment acceptance through the image** — the criterion-18 discipline from Phase 5 carries forward:
    at least one criterion verified via the served artifact, not a mounted source tree.
17. No new secret exposure. Read access must not require handing out the admin key, and no credential appears
    in any response, log, or page source.
18. `autonomous-executive.ts` diff remains **exactly** the Phase 6 change (51 insertions, 0 deletions). Any
    further change is a FAIL.

---

## 5. INTERFACES

### 5.1 The dashboard
`dashboard/index.html` exists (80 KB) and is copied into the image. Extend it, or split it — the Generator's
call — but it must remain servable from the image with no build step that could fail offline.

### 5.2 Read APIs
Add **read-only** endpoints or MCP tools as needed. Name them for what they return. If a view needs a query
that does not exist, add the query — not a denormalised copy of the data.

### 5.3 Flags
Unchanged. The dashboard obeys `COGNITIVE_CONTROL_ENABLED`, `COGNITIVE_SCHEDULER_MODE`, and
`COGNITIVE_ACTIVATION_KILL_SWITCH` exactly as the MCP surface does.

---

## 6. TEST AND VERIFICATION COMMANDS

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd ~/Katra-Agentic-Memory/server
npm run typecheck
npm run build
env -u KATRA_USER_ID npx vitest run
docker inspect katra-server --format '{{.State.Status}}/{{.State.Health.Status}}'
```

**The Verifier runs these independently. The Generator's own results are not evidence.**

**And for this phase specifically:** the Verifier will sit in front of the running dashboard and attempt to
answer criteria 1 and 2 from it. That is not a formality — it is the deciding test, and a good test suite does
not substitute for it.

---

## 7. THE DECISIVE TEST FOR PHASE 7

> **A.** Hand the dashboard to a human who did not build the system, pointed at a mission they have not seen.
>    Can they say **why the system is doing its current work** and **what would change the plan** — without
>    reading the code and without asking us?
>
> **B.** Seed a fault. Can the custodian **diagnose and repair it** from the operations views alone, without
>    joining a mission?

If A and B are both yes, Phase 7 is done and the plane is complete.

**The failure mode this guards against:** building something that looks authoritative and is not traceable —
which is precisely the thing Phase 4's decisive test A warned about at the other end of this project. A
dashboard that launders a guess into a confident-looking number is worse than no dashboard, because it will be
believed by someone who never saw the machinery underneath.

---

## 8. REVERT AND PROCESS

- **Green ref:** the Phase 6 graded ref. `f797550` (Phase 5) remains a standing fallback.
- **Image tags:** verify a tag contains what its name claims before relying on it.
- Max **3 attempts**, then revert and escalate to the operator.
- Generator commits frequently; Verifier never edits `mission-cognition/**` or `dashboard/**`.
- Every iteration posts a Katra work-log.

---

## 9. WHAT PHASE 7 DOES NOT DO

- It does **not** push. Ever. Publication is the operator's decision and nothing leaves the machine.
- It does **not** mutate mission cognition, allocation, or activation from any view.
- It does **not** bypass the flags, the authority classes, the evidence gate, or the kill switch.
- It does **not** touch `autonomous-executive.ts` beyond the Phase 6 change.
- It does **not** re-open `llm-service.ts`.
- It does **not** add model-assisted trigger detection.
- It does **not** start Phase 8.
