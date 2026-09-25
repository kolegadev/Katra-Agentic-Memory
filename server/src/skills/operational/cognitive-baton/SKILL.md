---
name: cognitive-baton
title: Cognitive Baton — Minimum Sufficient Context for an Episode
category: operational
description: Compile or consume a bounded, dependency-aware context packet for a reasoning episode, wake, handoff, or independent worker while enforcing privacy, capability, and blindness boundaries.
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - baton
  - handoff
  - reasoning episode
  - context packet
---
# Cognitive Baton

## Purpose

Provide the minimum sufficient context for one cognitive episode without replaying an entire mission or contaminating independent reasoning.

## Compile a baton

1. Resolve mission, work item, recipient, cognitive mode, base version, and expiry.
2. State the objective, deliverable, explicit non-objectives, and stop conditions.
3. Traverse dependencies from the objective through decisions, assumptions, uncertainty, evidence, experiments, and affected code components.
4. Include current ownership, parallel work, blockers, and collision warnings.
5. Include only the recipient's own relevant private identity memory.
6. Add capability IDs, scopes, operations, and approval class; never include credentials.
7. Apply the blindness policy before token-budget trimming.
8. Prefer dependency-critical records over merely similar memories.
9. Record skill and schema versions.
10. Issue an immutable baton. Amend by successor, not mutation.

## Consume a baton

1. Verify mission ID, version, recipient, expiry, and signature or audit hash.
2. Confirm that the work is still owned and unblocked.
3. If the mission has materially advanced, request a fresh baton.
4. Perform only the requested cognitive mode and authorized operations.
5. Store material artifacts by immutable reference.
6. Return a typed State Delta, not only narrative output.
7. Record skill outcome, cost, blockers, and any suspected context omission.

## Blind baton rules

When independent reasoning is required, exclude the incumbent conclusion, its rationale, other workers' hypotheses, and leading labels. Preserve neutral problem facts, constraints, available evidence, and deliverable format. Record exactly what was withheld.

## Quality checks

- Could the recipient explain the task and success condition?
- Is every included item causally relevant or required for safety?
- Is critical contradictory evidence included unless blindness policy forbids it?
- Are capability boundaries unambiguous?
- Could any content reveal another identity's private memory or a secret?
