---
name: mission-replanning
title: Mission Replanning — Responding to Changed Reality
category: decision
description: Determine whether new evidence, contradictions, results, or changed constraints require local adjustment, decision invalidation, or mission-level replanning.
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - replan
  - replanning
  - invalidate
  - plan change
---
# Mission Replanning

## Purpose

Change the plan in proportion to what changed in reality while preserving prior rationale and unaffected progress.

## Trigger conditions

- An experiment contradicts a relied-upon assumption.
- A decision's confidence falls below its action threshold.
- A constraint, authority, budget, deadline, or capability changes.
- An objective becomes blocked, irrelevant, unsafe, or already satisfied.
- New evidence creates a materially better path.
- An uncertainty resolves in a way that changes expected value.

## Procedure

1. Record the new evidence or condition in the ledger.
2. Identify the exact assumptions, decisions, objectives, code components, and tests downstream.
3. Classify impact:
   - `local`: update one work item.
   - `branch`: replace an objective subtree.
   - `strategic`: revisit mission approach or success model.
   - `terminal`: stop, close, or request owner intervention.
4. Suspend affected work while leaving unrelated work active.
5. Request independent verification for high-impact changes.
6. Compare continuation, modification, rollback, and abandonment options.
7. Submit plan-change deltas with rationale, cost, and reversibility.
8. Advance Mission State only after the required gate.
9. Expire stale batons and requeue affected work.
10. Preserve the old plan and reason for change for procedural learning.

## Guardrails

- Do not replan merely because an agent produced a novel idea.
- Do not protect sunk cost by ignoring disconfirming evidence.
- Do not suspend the whole mission when dependency analysis localizes the impact.
- Do not let a plan remain unchanged when its foundational assumption is invalidated.
