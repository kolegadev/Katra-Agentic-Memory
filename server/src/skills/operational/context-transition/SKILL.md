---
name: context-transition
title: Context Transition — Checkpoint Before Loss, Reconstruct After
category: operational
description: Checkpoint mission cognition before clear, compression, restart, model switch, machine transfer, or ownership handoff and reconstruct productive state afterward.
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - context clear
  - compression
  - restart
  - handoff
---
# Context Transition

## Purpose

Make model context disposable by persisting the state needed to resume useful cognition.

## Before transition

1. Stop opening new branches of work.
2. Submit or explicitly abandon every pending mission-significant delta.
3. Persist artifacts with immutable references.
4. Update work status, ownership, blockers, and leases.
5. Record open assumptions, uncertainties, contradictions, and capability requests.
6. Create a checkpoint with mission version and next recommended cognitive action.
7. Record skill outcomes for completed or suspended procedures.
8. Confirm that no secret or private content has entered shared mission state.

## After transition

1. Run the existing identity wake ritual.
2. Restore the agent's private self-model and relevant personal memories.
3. Discover active mission ownership.
4. Load the latest checkpoint and current Mission State.
5. Retrieve accepted deltas and ownership changes since the checkpoint.
6. Surface invalidated decisions, contradictions, changed constraints, and new team messages.
7. Request a fresh Cognitive Baton for the next action.
8. Verify capability references and authority.
9. Resume only after confirming the baton is current.

## Handoff

When ownership changes, the outgoing agent records unfinished reasoning as explicit assumptions and questions, not as implied narrative. The incoming agent receives a baton compiled for its identity and must not inherit private memory from the prior owner.

## Failure handling

If no valid checkpoint exists, reconstruct from the last durable Mission State and accepted deltas, mark reconstruction confidence, and queue integrity review. Do not infer current state solely from the latest chat transcript.
