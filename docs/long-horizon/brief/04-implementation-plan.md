# Implementation Plan

## Delivery approach

Use additive, feature-flagged delivery. Start with durable contracts and read-only shadow behavior. Do not permit scheduler-driven external mutation until state reconstruction, audit, security, and uncertainty tests pass.

The plan is expressed as phases rather than calendar promises. The custodian can size each phase against the current codebase and available model capacity.

## Phase 0 Repository verification and design lock

Objectives:

- Confirm current branch, migrations, skill frontmatter parser, mission schema, pub-sub contract, vault capability API, identity scope code, and dashboard architecture.
- Map proposed services to actual modules and naming conventions.
- Record architecture decision records for authoritative stores, event delivery, versioning, and graph projection.
- Add feature flags: `COGNITIVE_CONTROL_ENABLED`, `COGNITIVE_SCHEDULER_MODE`, `UNCERTAINTY_TRIGGER_ENABLED`.

Deliverables:

- Compatibility matrix between this brief and current source.
- Final JSON Schemas and TypeScript interfaces.
- Threat model and migration rollback plan.
- Approved collection and index design.

Exit criteria:

- No unresolved ambiguity about source of truth, caller scope, or secret handling.
- Existing mission and skill clients have a compatibility path.

## Phase 1 Durable mission and ledger foundation

Build:

- New collections and indexes.
- TypeScript domain types and validators.
- Mission State service with version history and checkpoints.
- Epistemic Ledger service with append, supersede, link, query, and confidence history.
- State Delta service with idempotency and optimistic concurrency.
- Event emission and audit records.
- Read-only REST and MCP surfaces.

Key implementation rules:

- Use transactions where supported for delta, ledger, materialized state, and event consistency.
- If transactions are unavailable, use an outbox and a deterministic repair worker.
- Enforce scope using the existing resolved caller identity, not payload `user_id`.
- Hash artifact content and preserve immutable references.

Exit criteria:

- Mission state rebuilds deterministically from checkpoints plus accepted deltas.
- Concurrent conflicting deltas cannot silently overwrite one another.
- Another identity cannot read private records or write as the mission owner.

## Phase 2 Baton compiler and continuity

Build:

- Dependency traversal query layer.
- Baton compiler with mode, recipient, token budget, blindness policy, capabilities, ownership, and expiry.
- Baton cache and durable audit record.
- Checkpoint and resume tools.
- Wake ritual extension that retrieves mission ownership, latest version, changes since checkpoint, and a fresh baton.
- Compression pre-hook to persist pending deltas and checkpoint.

Exit criteria:

- A mission survives clear, compress, process restart, and recipient transfer with no chat replay.
- A blind baton contains no incumbent conclusion or rationale identified by policy tests.
- Capability references resolve, but secret values never appear in serialized baton data or logs.

## Phase 3 Seed skill family

Build:

- Validate and install the nine bundled `SKILL.md` files.
- Add long-horizon activation heuristics to the minimal permanent kernel.
- Record skill name and version in batons, deltas, and outcomes.
- Extend feedback notes with structured mission metrics where the current API permits; otherwise add a compatible metadata field or linked event.
- Pin skill versions within active missions.

Exit criteria:

- Complex multi-session tasks reliably activate the router.
- Simple single-session tasks do not incur the full protocol.
- Every use produces an outcome record or a visible failure alert.

## Phase 4 Cognitive Scheduler shadow mode

Build:

- Cognitive work item generator.
- Priority scoring and explainability record.
- Agent cognitive profile projection.
- Suitability scoring from experience, disposition, performance, diversity, workload, capability access, and independence requirements.
- Shadow recommendations alongside the existing allocator; do not change real allocation.
- Dashboard comparison of existing allocation, proposed allocation, later outcome, and estimated cost.

Initial suitability model:

```text
suitability =
  domain_experience
  + cognitive_disposition_fit
  + relevant_memory_signal
  + historical_performance
  + epistemic_diversity
  + capability_fit
  - workload_penalty
  - correlation_penalty
  - conflict_of_interest_penalty
```

Exit criteria:

- Every score is reproducible and explainable.
- No private memory content is exposed in explanations; only derived, authorized features.
- Shadow evaluation shows no material regression versus current allocation on the pilot set.

## Phase 5 Uncertainty engine and dependency propagation

Build:

- Trigger detectors.
- Assumption dependency traversal.
- Blind independent work generation.
- Hypothesis diversity measurement.
- Decision invalidation and affected-work suspension.
- Experiment registry and discriminating-evidence workflow.
- Trigger precision and cost telemetry.

Start with deterministic triggers. Add model-assisted detection only after labeled examples exist.

Exit criteria:

- Contradicting a high-impact assumption reopens downstream decisions and queues review.
- Blind workers do not receive prohibited incumbent material.
- Trigger evaluation distinguishes useful reopening from performative doubt.

## Phase 6 Controlled scheduler activation

Activation sequence:

1. Recommend only.
2. Auto-allocate read-only analysis.
3. Auto-allocate internal Katra work within authority class A.
4. Allocate gated external work but require approval before effect.
5. Consider broader autonomy only after sustained evaluation.

Add leases, duplicate-work prevention, cancellation, timeout, budget limits, and circuit breakers.

Exit criteria:

- Allocation is idempotent and recoverable after executor restart.
- Duplicate or stale workers cannot commit incompatible state silently.
- Authority gates remain effective under retry and failover.

## Phase 7 Dashboard and operations

Views:

- Mission overview and version timeline.
- Objective and dependency graph.
- Claims, evidence, assumptions, decisions, and contradictions.
- Uncertainty register and trigger history.
- Work queue, ownership, leases, and blockers.
- Scheduler explanation and shadow comparison.
- Baton inspector with redaction and blindness-policy summary.
- Skill versions, outcomes, challenge state, and canary status.
- Integrity, projection lag, backup, and rebuild controls for the custodian.

Exit criteria:

- A human can explain why the system is doing its current work and what would change the plan.
- The custodian can diagnose and repair without joining normal mission cognition.

## Phase 8 Evaluation and skill evolution

Run controlled missions with seeded failure modes: wrong inherited assumption, contradictory evidence, context loss, stale baton, executor duplication, graph lag, LLM outage, and correlated agents.

Refine skills only through candidate, replay, canary, and promotion gates. Compare against a baseline that uses current missions and autonomous allocation without the new layer.

## Workstream backlog

### Domain and persistence

- `CCP-001` Finalize TypeScript domain interfaces.
- `CCP-002` Add JSON Schema validation and schema registry.
- `CCP-003` Create collections and indexes.
- `CCP-004` Implement mission versioning and checkpointing.
- `CCP-005` Implement ledger append, supersession, and graph projection.
- `CCP-006` Implement delta merge, idempotency, conflict, and repair.

### MCP and REST

- `CCP-020` Add mission-state tools and routes.
- `CCP-021` Add ledger query tools and routes.
- `CCP-022` Add baton compile and retrieve tools.
- `CCP-023` Add scheduler queue and explanation tools.
- `CCP-024` Add uncertainty review and checkpoint/resume tools.
- `CCP-025` Add rate limits, audit, pagination, and error contracts.

### Context and wake

- `CCP-040` Build dependency-aware retrieval.
- `CCP-041` Add token-budgeted context selection.
- `CCP-042` Implement blindness filters and leakage tests.
- `CCP-043` Extend wake rituals.
- `CCP-044` Add pre-compression checkpoint hook.
- `CCP-045` Add stale-baton invalidation.

### Scheduler

- `CCP-060` Create work item generator.
- `CCP-061` Implement priority scorer.
- `CCP-062` Build agent profile projection.
- `CCP-063` Implement suitability and diversity scorer.
- `CCP-064` Add shadow mode and explanations.
- `CCP-065` Add leases, cancellation, timeouts, and circuit breakers.

### Uncertainty

- `CCP-080` Implement deterministic trigger rules.
- `CCP-081` Build dependency invalidation traversal.
- `CCP-082` Implement blind fan-out.
- `CCP-083` Add hypothesis diversity metrics.
- `CCP-084` Build experiment and evidence comparison flow.
- `CCP-085` Add trigger effectiveness telemetry.

### Skills and learning

- `CCP-100` Validate seed skill frontmatter against current loader.
- `CCP-101` Install router and subskills.
- `CCP-102` Pin versions by mission.
- `CCP-103` Record structured outcomes.
- `CCP-104` Add replay, canary, and promotion gates.
- `CCP-105` Prevent active-mission silent skill mutation.

### Security and operations

- `CCP-120` Extend threat model and redaction tests.
- `CCP-121` Verify capability-only baton serialization.
- `CCP-122` Add backup and restore coverage.
- `CCP-123` Add integrity scan and projection rebuild.
- `CCP-124` Add metrics, alerts, and dashboard.
- `CCP-125` Add degraded-mode runbooks.

## Definition of done

A feature is done only when domain invariants, authorization, audit, metrics, migration, rollback, unit tests, integration tests, resilience tests, documentation, and dashboard or CLI observability are present. A generated output that merely looks correct is not sufficient; the state transition must be reconstructable and evidence-linked.
