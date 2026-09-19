---
name: long-horizon-mission
title: Long Horizon Mission — Router for Continuity-Spanning Work
category: decision
description: Route and govern work that spans contexts, sessions, agents, substantial uncertainty, staged evidence, or durable mission state. Use before complex work when continuity and epistemic control matter.
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - continuity
  - long horizon
  - multi-session
  - durable mission
---
# Long Horizon Mission

## Purpose

Use Katra Mission State as authoritative continuity and select the smallest applicable long-horizon procedure. This skill is the router; it does not duplicate the detailed methods in its subskills.

## Activate when

Any of the following is true:

- Work is likely to outlive the current context or session.
- More than one agent or machine will contribute.
- Important decisions depend on uncertain or changing evidence.
- The work has external dependencies, approvals, experiments, or staged artifacts.
- A wrong assumption could invalidate substantial downstream work.
- The user explicitly requests durable mission tracking.

Do not activate the full protocol for a bounded, low-risk task that can be completed and verified in one context.

## Procedure

1. Query skill activation context for relevant long-horizon subskills.
2. Find an existing active mission before creating a new one.
3. If none exists, define intent, measurable success criteria, constraints, authority, stop conditions, and initial unknowns.
4. Separate observations, claims, assumptions, hypotheses, decisions, and open uncertainty.
5. Create only the first useful objectives and dependency links. Do not freeze the whole mission into a premature checklist.
6. Select the next cognitive mode:
   - `explore` for poorly understood solution space.
   - `challenge` for possible lock-in or fragile assumptions.
   - `synthesize` for competing evidence.
   - `verify` for consequential claims.
   - `execute` for sufficiently resolved action.
   - `monitor` for an external condition or delayed result.
7. Compile or request a Cognitive Baton for the next episode.
8. Require a typed State Delta for any mission-significant discovery or change.
9. Record the skill outcome when the episode closes or suspends.

## Subskill routing

- Mission truth changed: load `mission-state-management`.
- A handoff, wake, or bounded episode is required: load `cognitive-baton`.
- Claims, evidence, assumptions, confidence, or contradictions are involved: load `epistemic-ledger`.
- Alternatives or falsification are required: load `explore-and-falsify`.
- Several persistent agents or ephemeral workers may help: load `distributed-cognition`.
- New evidence may alter the plan: load `mission-replanning`.
- Compression, restart, clear, or ownership transfer is imminent: load `context-transition`.
- Confidence appears unjustifiably hardened: load `breaking-hypothesis-lock-in`.

## Invariants

- Mission State outranks chat history for current operational truth.
- Private identity memory influences how an agent thinks but is not copied into shared mission truth.
- Important uncertainty remains explicit until evidence justifies resolution.
- Credentials are never included; reference vault-backed capabilities only.
- Preserve provenance of thought and evidence.
- A task marked complete is not proof that the mission outcome was achieved.

## Completion

Before leaving the episode, ensure mission-significant changes are committed, unresolved items are explicit, ownership is current, a checkpoint exists if context may be lost, and the next recommended cognitive action is visible.
