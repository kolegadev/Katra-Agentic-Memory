# Katra Long Horizon Cognitive Control Handoff

Version: 0.1 design baseline  
Prepared: 19 September 2026  
Audience: Katra memory custodian and implementation agents

This package specifies an additive long-horizon mission cognition layer for Katra. It preserves the existing memory, identity, sleep consolidation, skill learning, knowledge graph, code graph, vault, wake ritual, autonomous loop, and shared-memory communication model.

The design adds five runtime capabilities:

1. Mission State as the versioned operational truth for a mission.
2. An Epistemic Ledger for claims, evidence, assumptions, hypotheses, contradictions, uncertainty, decisions, and experiments.
3. A Cognitive Baton that compiles the minimum sufficient context for a reasoning episode or handoff.
4. State Deltas as typed, provenance-preserving mission updates.
5. A Cognitive Scheduler that selects what deserves cognition next and which persistent mind or ephemeral worker should do it.

The package also seeds nine procedural skills. These skills contain the method; the permanent agent kernel only needs to detect long-horizon work, load the router skill, preserve mission state before context loss, and report skill outcomes.

## Package contents

- `docs/01-scoping-brief.md` — scope, baseline, target architecture, and boundaries.
- `docs/02-data-model-and-interfaces.md` — proposed collections, schemas, events, MCP tools, and integration points.
- `docs/03-workflows.md` — end-to-end operating workflows.
- `docs/04-implementation-plan.md` — workstreams, phases, backlog, dependencies, and definition of done.
- `docs/05-test-and-evaluation-plan.md` — unit, integration, resilience, epistemic, and mission-level evaluation.
- `docs/06-operations-security-and-rollout.md` — authority, privacy, failure modes, observability, migration, and rollout.
- `skills/*/SKILL.md` — seed procedural skills ready for parser validation and installation.
- `schemas/*.schema.json` — draft JSON Schema contracts for persisted objects and tool payloads.
- `Katra_Long_Horizon_Cognitive_Control_Scoping_Brief.docx` — readable approval and implementation brief.

## Recommended build order

1. Collections, indexes, validators, and optimistic concurrency.
2. Mission State and State Delta service.
3. Epistemic Ledger and invalidation propagation.
4. Cognitive Baton compiler and wake integration.
5. Scheduler in shadow mode.
6. Seed skill installation and outcome feedback.
7. Uncertainty trigger and blind independent exploration.
8. Dashboard, operations, evaluation, and progressive activation.

## Critical design constraints

- Personal identity memory remains private and is never rewritten into shared mission truth.
- Mission State is authoritative for project continuity; chat history is evidence, not authority.
- The Epistemic Ledger is append-oriented and provenance-preserving.
- State Deltas are idempotent, version-checked, auditable, and reversible where feasible.
- Credentials never enter batons, prompts, ledgers, or state deltas. They are referenced only as vault-backed capabilities.
- The custodian remains infrastructure-plane first and is excluded from normal mission debate and allocation.
- The initial skills are seeded deliberately, then improved through Katra's existing outcome and refinement loop.
- "Uncertainty" means explicit unresolved alternatives, not verbosity, hesitation, or random generation.

## Implementation status labels

- `confirmed-existing` — verified in the public repository documentation.
- `extend-existing` — an existing subsystem is the intended integration point.
- `new` — a new collection, service, tool, event, or workflow is required.
- `optional-later` — useful after the first controlled pilot.

## Source baseline

The design was checked against the public Katra repository and its current documentation on 19 September 2026:

- https://github.com/kolegadev/Katra-Agentic-Memory
- https://github.com/kolegadev/Katra-Agentic-Memory/blob/main/docs/ARCHITECTURE.md
- https://github.com/kolegadev/Katra-Agentic-Memory/blob/main/docs/MCP-TOOLS.md
- https://github.com/kolegadev/Katra-Agentic-Memory/blob/main/docs/AUTONOMOUS-LOOP.md
- https://github.com/kolegadev/Katra-Agentic-Memory/blob/main/docs/SLEEP-CONSOLIDATION.md

The repository currently documents 66 MCP tools, basic missions and goal decomposition, procedural skills with feedback and refinement, Katra Graph, private reflection, hybrid memory scope, a vault-backed capability layer, wake rituals, and an emotion/salience-driven autonomous loop. This package does not assume that the proposed long-horizon collections, typed deltas, batons, epistemic ledger, or cognitive scheduler already exist.
