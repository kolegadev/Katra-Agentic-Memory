# BACKLOG & ITERATION PLAN — Katra Long Horizon Cognitive Control

**Loop:** `new-code` · **Director:** Lilly · **Generator:** Satori · **Verifier:** Lilly
**Contract:** `CONTRACT.md` (this directory) · **Branch:** `feat/cognitive-control-local`

---

## Revert points — correcting a tooling failure

`loop-state backup` **does not work for this project.** It has no `--project`/`--workdir`
option; it snapshots whatever repository it sits in, which is `~/kolega-code-loop-engineering`.
The stored green ref came back as `4b263af5e31f11df51f42e968cee0d15d9459616` — a *loop-engineering*
commit that **does not exist in the Katra repository at all**. Recorded as an anti-pattern.

**Revert points are therefore the Katra git commits themselves:**

| Ref | Meaning |
|---|---|
| `971ac1d` | **current green** — schema strictness split + singleton Redis rail |
| `3b8b1c5` | Phase 0–2 plane landed |
| `35f61fb` | pre-feature baseline (main) |

Recovery: `git reset --hard <ref>` inside `~/Katra-Agentic-Memory`. The working tree also
holds Lilly's untracked files (`services/authority/`, the 9 skills) which are **not** covered
by a reset — they must be re-shipped from the Mac copies if lost. Both sets are backed up in
`~/katra-long-horizon/loop/`.

---

## THE ATOMIC FEATURES

Each is independently verifiable with a clean PASS/FAIL. Ordered by dependency and risk.

### ITER-0 — Retrospective baseline *(no new code; grade what exists)*
**Why first:** we wrote code before writing a contract. Before building anything else, grade
the existing work against `CONTRACT.md` §3 criteria 1–8, so we know what we actually have.
**Generator:** none. **Verifier:** Lilly.
**Blocked on:** a `npm run build` so the flag path can be exercised.
**Exit:** 8 criteria graded PASS/FAIL with evidence.

### ITER-1 — Context-clear continuity *(THE DECISIVE TEST)*
**The claim:** a mission survives a total context clear and resumes without transcript replay.
**Why it is first among new work:** it proves or kills the entire project. Everything else is
elaboration.
**Generator:** Satori. **Verifier:** Lilly.
**Contract criteria:** 9–13.
**Approach:** create a mission, accept 2 deltas, assign work, checkpoint. Then kill the
context completely — fresh process, no history. Resume and grade what the agent can report.
**Honest risk:** this may FAIL. If it does, that is the most valuable result available and
must not be softened. A failure here means the baton/checkpoint design needs rework, not
that we need more features.
**Exit:** criteria 9–13 graded.

### ITER-2 — Concurrency and integrity
Idempotency, optimistic concurrency, monotonic versions, deterministic replay.
**Contract criteria:** 14–16. **Generator:** Satori. **Verifier:** Lilly.

### ITER-3 — Secret and privacy boundary *(safety)*
No credential in any serialized artefact; blind batons carry no incumbent material;
untrusted callers cannot escalate.
**Contract criteria:** 17–19. **Generator:** Satori. **Verifier:** Lilly.

### ITER-4 — The nine seed skills, round two
Add `title`/`triggers`/`confidence` to the two **pre-existing** skills that also have
`triggers: []` (`katra-health-remediation`, `wifi-firmware-recovery`) — review §3.7.
Small, independent, Lilly's file set.

### DELIBERATELY DEFERRED — do not start without a new contract
- Cognitive Scheduler (design Phase 4) and its 4 MCP tools
- Uncertainty engine / hypothesis-lock-in triggers (design Phase 5)
- Dashboard (Phase 7)

**Rationale:** these carry the cost and the risk, and **neither is needed to prove the
central claim.** Scheduling errors are also the hardest to attribute, so they must follow a
trusted state layer, not precede it.

---

## ROLE AND PROCESS RULES

1. **Generator never edits** `services/authority/**` or `server/src/skills/**`.
2. **Verifier never edits** `services/mission-cognition/**` — findings are reported, not patched.
3. **Verifier runs the gates independently.** The Generator's own test results are not evidence.
   This is the loop's core safety property, and the reason we are doing this at all: previously
   the Generator wrote both the code *and* the tests that judged it.
4. **Max 3 attempts** per feature, then revert to `971ac1d` and escalate to John.
5. Every iteration ends with a Katra `work-log` memory.

---

## OPEN ITEMS CARRIED FORWARD

| # | Item | Owner |
|---|---|---|
| 1 | `loop-state backup` snapshots the wrong tree — no `--project` option. Anti-pattern recorded. | tooling / John |
| 2 | Satori's `event-rail.ts` singleton — **closed** in `971ac1d` | ✅ |
| 3 | §4.5 schema strictness split — **closed** correctly in `971ac1d` | ✅ |
| 4 | The running `/app/build` predates both commits — Iteration 0 is blocked on a rebuild | Satori |
| 5 | **ROTATE `KATRA_API_KEY` / `KATRA_TOKEN`** from `~/.katra/loop.env` (my exposure, `event_06951603`) — plus mode is 0644, should be 0600 | John |
| 6 | **ROTATE the 3 `katra-mcp-*` keys** (`event_f5386df2`) | John |
| 7 | `~/Downloads/agentmail_api_key_insta.txt` — plaintext key in Downloads | John |
