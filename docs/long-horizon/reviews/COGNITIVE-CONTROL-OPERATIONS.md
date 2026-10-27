# Cognitive Control Plane — Operations & Limitations

**How to use it, and what to be careful about · 2026-09-20**

Companion to `PHASE-8-FINAL-SUMMARY.md`.

---

## 1. The mental model, in one paragraph

**The mission is the source of truth, not the conversation.** A mission is a durable, versioned record
of what is being worked on, what is believed, what is uncertain, and what was decided. Agents read state
from it and write changes back as *typed deltas*. This means an agent can lose its entire context —
crash, restart, new session, new model — and resume from the **mission id alone**.

Two consequences follow, and they drive everything below:

- **Every write is a delta against a version.** If you write against a stale version you get a
  **`conflict`**, not silent corruption. Nothing is ever dropped; both proposals are kept.
- **Some writes are refused.** A delta that could not actually take effect is rejected before anything is
  written. A refusal is a feature, not an error to work around.

---

## 2. Turning it on and off

| Variable | Values | Current |
|---|---|---|
| `COGNITIVE_CONTROL_ENABLED` | `off` \| `read` \| `write` | `write` |
| `COGNITIVE_SCHEDULER_MODE` | `off` → `shadow` → `recommend` → `allocate_internal` | `shadow` |
| `COGNITIVE_ACTIVATION_KILL_SWITCH` | `0` \| `1` | `0` |
| `COGNITIVE_ACTIVATION_HARD_BOUND` | integer | (bound on influences per window) |

- **`COGNITIVE_ACTIVATION_KILL_SWITCH=1` takes effect immediately** — it is read at runtime, so it
  returns the plane to `off` with **no rebuild**. This is the emergency brake; use it before editing
  anything else.
- **Changing `COGNITIVE_CONTROL_ENABLED` or adding tools requires an image rebuild** —
  `docker compose build server && docker compose up -d server`. Env-var changes alone will not ship a
  code change, because `/app` is baked into the image.
- The **mode ladder moves one rung at a time** via `set_scheduler_mode`, and moving *up* to `recommend`
  or above requires the **evidence gate** to be open.

> **The evidence gate is closed (0 of 50 stored decisions).** `recommend` and `allocate_internal` are
> unreachable today, and attempting to skip the gate is exactly the failure this system was built to
> prevent. `shadow` is the whole of "live" for now.

---

## 3. The working loop

### Start a mission
```
create_mission_v2  → explicit success criteria, stop conditions, authority class (A/B/C), constraints
```

### Do work, record what changes
```
submit_state_delta        typed change against base_mission_version
query_epistemic_ledger    claims, evidence, assumptions, uncertainties, decisions, experiments
list_state_deltas         the audit trail of what was proposed / accepted / rejected / conflicted
```

### Hand an agent a bounded slice of context
```
compile_cognitive_baton   minimum sufficient context for ONE reasoning episode, bound to a version
get_cognitive_baton       retrieve it; stale batons are auto-revoked
```

### Work with uncertainty rather than around it
```
list_uncertainties         open uncertainties
evaluate_triggers          run the eight deterministic detectors (no model calls)
create_blind_work_item     parallel work that carries NO incumbent conclusion — avoids anchoring
get_hypothesis_diversity   are the hypotheses genuinely different, or restatements?
propose_experiment         register a discriminating experiment
record_experiment_result   a result against accepted state opens a contradiction entry
```

### Pause and resume
```
checkpoint_mission    durable version checkpoint
resume_mission        full state + what changed + next action — FROM THE MISSION ID ALONE
```

### Scheduling (shadow)
```
create_cognitive_work_item   queue bounded cognition (requires mode != off; changes no real allocation)
get_cognitive_queue          inspect the prioritised queue and feature vectors
explain_scheduler_decision   ranked candidates, per-feature score contributions, exclusions, rationale
```

### Skills — four gates, and no way around them
```
propose_skill_candidate  →  run_skill_replay  →  start_skill_canary  →  promote
```
Skipping replay or canary is **refused and the refusal is recorded**. A single good run is not enough.
`pin_skill_version` is the explicit migration approval for pinning a version to an active mission.

---

## 4. The dashboard

`http://<host>:9012/dashboard/cognition/`

**Note the port:** `9012` is the REST API (where the dashboard is served). `3112` is the MCP endpoint
and returns 401 for a browser GET — that is correct, not a fault.

**Five top-level views:** Status & flags · Missions · Activation · Operations (custodian) ·
Why is it doing this?

**Eight mission tabs** (select a mission first): Overview + timeline · Objectives + graph ·
Claims & evidence · Uncertainties + triggers · Work & leases · Scheduler · Batons · Skills

Every view carries its **`basis`** — where the numbers came from — so a number can be traced rather than
trusted.

---

## 5. Command-line checks

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
cd ~/Katra-Agentic-Memory/server
# -u KATRA_USER_ID IS REQUIRED. Seven identity tests expect user_id 'katra'; if the
# variable is exported in your shell (an agent dispatch does), they fail with a false
# red. This is environment leakage, not a code defect - but it will waste your time.
npm run typecheck && npm run build && env -u KATRA_USER_ID npx vitest run

# is the plane live, and in which mode?
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3112/health
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9012/dashboard/cognition/

# the allocator must be unchanged from the Phase 6 baseline
git -C .. diff --numstat main -- server/src/services/processing/autonomous-executive.ts   # 51  0
```

---

## 6. Limitations — please read before relying on any of it

### 6.1 It does not act. At all.
The plane runs in **`shadow`**. It recommends and records; it **never allocates**. The live allocator is
byte-for-byte the pre-feature allocator and the plane cannot replace its choice unless every gate holds
— which today it cannot, because the evidence gate is closed at 0/50. Treat every scheduler output as
**advisory**. This is the safety property, not a shortcoming to be fixed casually.

### 6.2 The Phase 8 comparison proves less than it appears to
The baseline was `0/8 by construction` — the detectors only exist inside the plane, so that leg cannot
fail. The comparison demonstrates **detection-logic coverage, not production-outcome superiority**. It
was also measured against an in-memory database, not production traffic. Two of the eight seeded failure
modes — **knowledge-graph lag** and **LLM outage** — have **no detector at all**; on those the plane is
exactly as blind as having no layer.

### 6.3 A refusal is not a bug
Deltas are rejected when they could not take effect: unknown target, vacuous value, missing ledger
content, junk status. If a write is refused, **read the message** — it names the accepted ids and the
required shape. Do not retry unchanged; fix the payload.

### 6.4 Stale versions produce `conflict`, by design
Submitting against an old `base_mission_version` returns **`conflict`** and keeps both proposals. This
happens routinely when two writers interleave. Re-read the version and resubmit. It is *not* an error
state, and nothing is lost.

### 6.5 Three payload traps that will silently cost you time
1. **Paths take ids, not indices.** `/objectives/o1/status` works; `/objectives/0/status` is refused.
2. **`replace` on a `/status` path takes a raw string**, e.g. `"met"` — not `{"status": "met"}`. (Both
   are now accepted for criteria, but the raw string is the natural form.)
3. **Ledger content goes in `ledger_entries`, not in `operations[].value`.** A statement placed in the
   operation value is *discarded* — this is precisely how a set of research findings went missing.

### 6.6 Feature-absence is not fully indistinguishable
With the flag `off`, `tools/list` does hide the cognitive tools — but a **direct `tools/call` by name
still reaches the handler** and returns a distinctive *"Cognitive control plane disabled"* message
rather than *"Unknown tool"*. So an observer who guesses the tool name can tell the plane exists.
Known residual, not fixed.

### 6.7 Retrieval and retention
- The API returns **404-equivalent empty states** for missions the caller cannot see — absence and
  invisibility look the same to a client.
- Retention is enforced: **events 90 days, batons 7 days, and version history keeps 30**. Do not treat
  the version history as a permanent archive; take a checkpoint of anything you need long-term.

### 6.8 Authority is capped
Untrusted callers are pinned to their own identity and capped at **authority class B**. Skill-promotion
and pinning tools are **trusted-caller only**. Do not assume a call succeeded just because it was
accepted by your client — check the returned status.

### 6.9 Naming and cosmetic issues

- ~~`resume_mission` says *"verify success criteria"* even when all are `met`~~ — **fixed**. It
  now says *"all N objectives completed and all N success criteria satisfied — the mission is
  ready to close"*, names the criteria still open, or states plainly that none are declared.
- `/executive` displays a pre-existing "emotional proximity" rationale. The malformed
  `undefined 0.00` fragment is **normalised** and explained in a per-row note. Note that
  `allocation_rationale` is the allocator's verbatim prose: structured `emotional_tags` are
  excluded, but the prose is not.
- ~~The backlog metric in `background-processor.ts` saturates at 1000~~ — **fixed**. It is now a
  true count (live: 3,420, previously reported as 1,000 — a 3.39× under-report). Trust it.

### 6.9b Two failure modes this plane does NOT detect, and should not

`knowledge-graph lag` and `LLM outage` are frequently cited as gaps. They are **not** the
plane's to detect, and adding them would be a mistake:

- **LLM outage is already monitored.** `get_health` actively probes the provider and reports it
  (e.g. `LLM | 🟢 deepseek`). Duplicating it in the plane would erode the Phase 4 boundary
  around `llm-service.ts` for no gain.
- **Both are infrastructure conditions, not epistemic ones.** Every detector in the plane is a
  pure function over *ledger entries* — unsupported confidence, groupthink, contradictions,
  stale plans. Graph lag and LLM outage are whole-system availability conditions; they do not
  fit that interface and would introduce a second category under it.

If you want them watched, the right home is the **health/ops surface** (which already has a
cron and a review job). A graph-staleness alert is computable from `code_graph_status`
(last-sync per root) if it is ever wanted; severity is low, because a stale graph degrades
retrieval quality rather than mission integrity.

### 6.10 This is not published
The branch is **local only**. A `pre-push` guard hook blocks pushing branch names and protected paths,
and there is no remote counterpart. **Do not expect this feature on `main`**, and do not remove the
guard by hand unless you intend to publish.

### 6.11 Resume is only as good as what was recorded
`resume_mission` reconstructs from **stored records, not from your conversation**. If something was never
written as a delta or a ledger entry, resume will not know it — and it will not warn you. The reconstruction
is faithful to the record, so an incomplete record produces a confident, incomplete picture.

---

## 7. When something looks wrong

| Symptom | Likely cause | Action |
|---|---|---|
| Tools missing from `tools/list` | `COGNITIVE_CONTROL_ENABLED=off` | Set to `write`; **rebuild the image** |
| Dashboard 401 | You are on **3112** (MCP), not **9012** | Use the REST API port |
| Scheduler tool says mode is `off` | Kill switch engaged | Unset `COGNITIVE_ACTIVATION_KILL_SWITCH` |
| Delta returns `conflict` | Stale `base_mission_version` | Re-read the version, resubmit |
| Delta refused with "unknown ... id" | Index used instead of id | Use the id the message lists |
| Delta refused, "carries no ledger_entries" | Content in `operations[].value` | Move it to `ledger_entries` |
| `attempt to influence` refused | Evidence gate closed (0/50) | Expected. Do not bypass |
| Code change not visible | Committed but not rebuilt | `docker compose build server && docker compose up -d server` |

---

## 8. The one rule that matters most

**State outranks conversation.** When the transcript and the mission record disagree, the mission record
is right. If something matters, it must be written down as a delta or a ledger entry — because that is
the only version of events that survives a context loss.
