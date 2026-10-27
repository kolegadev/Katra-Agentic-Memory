---
name: mission-state-management
title: Mission State Management — Versioned Operational Truth
category: operational
description: Create, read, version, update, checkpoint, and reconcile durable Mission State for long-running work. Use when operational truth, ownership, dependencies, or mission continuity changes.
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - mission state
  - checkpoint
  - state delta
  - mission version
---
# Mission State Management

## Purpose

Maintain a compact, versioned representation of what the collective currently treats as operationally true for a mission.

## Authoritative records

Treat the current Mission State version, accepted State Deltas, and linked Epistemic Ledger entries as authoritative. Treat transcripts, messages, and unmerged agent conclusions as evidence or proposals.

## Procedure

1. Read the current mission version and status.
2. Confirm intent, success criteria, constraints, authority, and stop conditions.
3. Identify the exact field or linked ledger object that needs change.
4. Retrieve dependencies and state changes since the working baton was issued.
5. Express the change as a typed State Delta against the base version.
6. Include provenance, evidence, confidence, downstream effects, skill version, and idempotency key.
7. Submit the delta through the merger; never directly overwrite the materialized state.
8. If a version conflict exists:
   - Re-read current state.
   - Preserve both proposals.
   - Auto-merge only declared commutative additions.
   - Route incompatible changes to synthesis or a human gate.
9. Verify the returned version and resulting events.
10. Create a checkpoint at meaningful phase boundaries or before context transition.

## State hygiene

- Link to ledger IDs instead of duplicating long evidence.
- Keep current state compact; move history into versions, deltas, and the ledger.
- Distinguish accepted, proposed, superseded, invalidated, and deferred objects.
- Store artifact hashes and immutable references.
- Expire or supersede batons compiled from materially outdated state.

## Completion criteria

- The latest version reflects the accepted change.
- The reason and author are auditable.
- Affected dependencies have been traversed.
- Invalidated decisions or blocked objectives are visible.
- Follow-on cognition has been queued when needed.

## Failure handling

If state, delta history, and event replay disagree, stop mutation and notify the custodian. Do not repair by choosing the most recent timestamp without deterministic reconstruction.
