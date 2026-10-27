# Long Horizon Cognitive Workflows

## Workflow 1 Mission intake and activation

1. Receive user intent through the normal agent interface.
2. Classify the request as long-horizon when it spans contexts, sessions, agents, meaningful uncertainty, external dependencies, or staged evidence.
3. Load `long-horizon-mission` through the existing skill activation path.
4. Create Mission State with success criteria, constraints, authority class, initial unknowns, and stop conditions.
5. Convert current facts and assumptions into ledger entries with provenance.
6. Decompose only enough to expose the first decision and evidence dependencies; avoid turning the whole mission into a fixed checklist.
7. Create initial cognitive work items.
8. Compile the first baton.
9. Record mission activation and skill versions.

## Workflow 2 Cognitive scheduling cycle

1. Read current Mission State, unresolved uncertainties, contradiction queue, blocked dependencies, and available budgets.
2. Generate candidate work items from open objectives, invalidated decisions, experiment results, new evidence, and stale checkpoints.
3. Score each item using impact, uncertainty, expected information value, dependency centrality, urgency, and cognitive cost.
4. Determine mode: explore, challenge, synthesize, verify, execute, or monitor.
5. Determine independence requirement and incumbent-information withholding.
6. Rank persistent agents using relevant experience, cognitive disposition, performance history, epistemic diversity, workload, capability access, and conflict-of-interest penalties.
7. Select a persistent agent, several blind agents, or ephemeral workers.
8. Record the scheduler decision before issuing batons.
9. Re-score after every accepted plan-changing delta.

Suggested normalized priority:

```text
priority =
  mission_impact
  * max(uncertainty, uncertainty_floor)
  * expected_information_value
  * dependency_centrality
  * urgency
  / max(cognitive_cost, cost_floor)
```

Treat this as an explainable ranking heuristic, not a claim of mathematical optimality. Calibrate with observed outcomes.

## Workflow 3 Baton compile and reasoning episode

1. Resolve the work item, recipient, mode, mission version, and blindness policy.
2. Traverse dependency links from the objective rather than retrieving only semantically similar memories.
3. Include required claims, assumptions, uncertainties, evidence, contradictions, decisions, artifacts, and affected code components.
4. Add only the recipient's own relevant private identity memory.
5. Add ownership, collision warnings, allowed capability references, and deliverable contract.
6. Enforce token and item budgets by preserving dependency-critical nodes first.
7. Sign and issue an immutable baton with expiry.
8. Recipient performs the bounded episode and returns a State Delta, artifacts, and skill outcome.
9. Reject prose-only completion for work that requires a typed delta.

## Workflow 4 State Delta merge

1. Authenticate caller and authorize mission access.
2. Validate JSON Schema and semantic invariants.
3. Check baton validity and base mission version.
4. Deduplicate the idempotency key.
5. Append proposed ledger records and delta.
6. Detect conflicts with state changes since the baton was compiled.
7. Auto-merge safe additions; route conflicts to a synthesizer or human gate.
8. Materialize the next Mission State version.
9. Traverse affected dependencies.
10. Reopen uncertainty or invalidate decisions when required.
11. Emit events, expire stale batons, and queue follow-on cognition.

## Workflow 5 Uncertainty trigger and hypothesis lock-in recovery

Trigger candidates:

- Repeated failure combined with stable or rising confidence.
- High confidence supported only by inferred or inherited assumptions.
- One active hypothesis for a high-impact decision.
- Material contradictory evidence.
- An unexpected experiment result.
- A plan unchanged despite information that should affect it.
- Strong critic disagreement or unstable evidence provenance.
- Convergent agents whose contexts share the same incumbent rationale.

On trigger:

1. Freeze the affected conclusion from automatic promotion.
2. List every assumption required for it to be true.
3. Label each assumption as observed, inferred, inherited, or convenient.
4. Open or update an uncertainty entry.
5. Generate at least one model in which the highest-impact assumption is false.
6. Create blind independent work items that exclude the incumbent conclusion and rationale.
7. Ask each worker for a falsifiable hypothesis and distinguishing evidence, not generic alternatives.
8. Compare hypotheses only after independent submissions are committed.
9. Design or run discriminating tests.
10. Update confidence and dependencies through State Deltas.
11. Record whether the trigger produced useful information, mere variance, or unnecessary cost.

## Workflow 6 Plan-changing discovery

1. Agent submits evidence or a result marked `plan_changing_candidate`.
2. State merger identifies assumptions, decisions, objectives, code components, and tests downstream.
3. Open a contradiction if the discovery conflicts with accepted state.
4. Suspend only affected work, not the entire mission.
5. Issue challenge and verification batons to independent reviewers.
6. If confirmed, invalidate affected decisions and reopen their uncertainties.
7. Scheduler creates replacement work and updates priority.
8. Preserve the prior plan and reason for change for audit and learning.

## Workflow 7 Wake, restart, clear, or compression

Before transition:

1. Finish or explicitly suspend the current reasoning episode.
2. Submit pending State Deltas.
3. Store artifact references and capability requests.
4. Create a mission checkpoint containing current version, owned work, active uncertainty, blockers, and next recommended cognition.
5. Record skill outcomes.

After wake:

1. Restore identity through the existing wake ritual.
2. Restore private self-model and personally relevant memories.
3. Query active mission ownership.
4. Load the latest checkpoint and Mission State version.
5. Retrieve deltas since the checkpoint.
6. Surface contradictions, invalidated decisions, and changed ownership.
7. Compile a fresh baton; never reuse a stale pre-reset baton.
8. Resume from the next unblocked cognitive action.

## Workflow 8 Skill lifecycle

1. Router and subskill versions are recorded in every baton and State Delta.
2. At episode completion, call `record_skill_outcome` with structured notes: objective class, result, cost, trigger precision, merge conflicts, and human corrections.
3. Aggregate outcomes across missions, not just repeated turns within one mission.
4. Mark a skill challenged only after a configured evidence threshold or severe safety failure.
5. Refine to a candidate version and run replay tests against historical missions.
6. Canary the candidate on selected missions.
7. Promote only when it improves mission outcomes without unacceptable cost or regression.
8. Pin the skill version for an active mission unless an explicit migration is approved.

## Workflow 9 Custodian health and degraded mode

The custodian monitors database health, Redis, object storage, event lag, index consistency, stale leases, orphaned batons, schema errors, merge failures, backup freshness, and projection drift.

Degraded mode rules:

- If Redis fails, pause new allocation and use durable mission state; do not lose accepted deltas.
- If graph projection lags, compile from MongoDB dependency records and mark reduced retrieval quality.
- If the LLM provider is unavailable, permit deterministic reads, writes, merges, and health repair; pause synthesis and autonomous confidence changes.
- If Mission State and event replay disagree, stop mutation, enter integrity mode, and require rebuild or human review.
- If the custodian is unavailable, health alerts may route to a designated backup identity, but that identity receives infrastructure-only authority.

## Workflow 10 Mission closure

1. Evaluate success criteria against evidence, not task count.
2. Resolve, accept, defer, or transfer each open uncertainty.
3. Mark final decisions and retained assumptions.
4. Produce a mission synthesis with provenance links.
5. Record skill outcomes and scheduler calibration data.
6. Archive active batons and release leases.
7. Allow later sleep consolidation to influence personal learning without rewriting the mission record.
