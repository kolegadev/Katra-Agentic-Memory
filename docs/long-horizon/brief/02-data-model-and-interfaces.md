# Data Model and Interface Specification

## Storage strategy

Use MongoDB for durable mission and epistemic records, Redis for leases, short-lived baton caches, scheduler queues, and idempotency locks, and the existing knowledge graph for navigable relationships. Keep large artifacts in MinIO with content hashes and immutable references.

Recommended new collections:

| Collection | Purpose | Write pattern |
|---|---|---|
| `mission_states` | Current materialized mission state and version | Optimistic update |
| `mission_state_versions` | Immutable snapshots or compacted checkpoints | Append |
| `epistemic_entries` | Claims, evidence, assumptions, hypotheses, contradictions, decisions, experiments, unknowns | Append with supersession |
| `state_deltas` | Proposed and applied mutations | Append |
| `cognitive_batons` | Generated context packets with expiry and recipients | Append and expire |
| `cognitive_work_items` | Scheduler queue and lifecycle | Mutable status plus audit |
| `agent_cognitive_profiles` | Suitability features and observed performance by work class | Versioned update |
| `scheduler_decisions` | Ranked candidates, scores, exclusions, budgets, and rationale | Append |
| `mission_events` | Domain event stream for rebuild and subscriptions | Append |

## Mission State

Mission State is the authoritative operational model for continuity. It should contain:

- Identity: mission ID, owner, title, intent, phase, status, version, timestamps.
- Success model: outcomes, acceptance tests, stop conditions, failure budget.
- Constraints: authority class, cost, time, privacy, safety, legal, infrastructure.
- Current model: agreed facts, active hypotheses, decisions, assumptions, uncertainties, contradictions, experiments, results.
- Work: objectives, dependencies, owners, blockers, due conditions, progress evidence.
- Resources: artifacts, code components, relevant memories, capabilities by opaque ID.
- Governance: review policy, quorum where needed, human gates, retention, visibility.
- Continuity: last checkpoint, active baton IDs, next recommended cognition.

The current mission document should reference ledger entry IDs rather than duplicate complete evidence and rationale.

## Epistemic Ledger

Every entry has a stable ID, mission ID, type, statement or result, author identity, source, time, confidence, status, evidence links, dependency links, and version history.

Supported entry types for v1:

| Type | Meaning |
|---|---|
| `claim` | Falsifiable proposition about the world or system |
| `evidence` | Observation, source, artifact, test result, or measurement |
| `assumption` | Proposition temporarily relied upon without sufficient confirmation |
| `hypothesis` | Candidate explanation or solution model under evaluation |
| `uncertainty` | Addressable unresolved alternative with consequence and information need |
| `contradiction` | Explicit incompatibility among entries or outcomes |
| `decision` | Chosen course with rationale, alternatives, and dependency set |
| `experiment` | Planned discriminating test with protocol and expected observations |
| `result` | Observed experiment or execution outcome |
| `unknown` | Known missing information not yet structured as alternatives |

Recommended relationships:

- `supports`, `contradicts`, `assumes`, `tests`, `result_of`, `distinguishes_between`
- `depends_on`, `invalidates`, `supersedes`, `caused_by`, `touches_component`
- `originated_by`, `challenged_by`, `reviewed_by`, `assigned_to`

Confidence must never overwrite history. Store confidence changes with reason, actor, evidence IDs, prior value, and new value.

## Uncertainty object

Uncertainty is first class. It records:

- The unresolved subject.
- Source: insufficient evidence, conflict, model ambiguity, unexpected result, distribution shift, or inherited assumption.
- Current leading model confidence.
- Consequence if false.
- Alternative hypotheses.
- Evidence for and against.
- Information needed and candidate discriminating experiments.
- Independence requirement for future reasoning.
- State: open, investigating, narrowed, resolved, accepted-risk, or deferred.
- Trigger history and downstream dependencies.

## Cognitive Baton

A baton is a compiled, bounded view for one cognitive episode. It is not authoritative state and must carry the mission version from which it was compiled.

Sections:

1. Recipient identity or worker class.
2. Objective and explicit non-objectives.
3. Requested cognitive mode: execute, explore, challenge, synthesize, verify, or monitor.
4. Current mission version and checkpoint.
5. Dependency-linked claims, decisions, assumptions, uncertainties, contradictions, and evidence.
6. Relevant private memories only when the recipient is the owning identity.
7. Existing ownership and parallel work to avoid collision.
8. Allowed vault capability IDs and operation scopes.
9. Deliverable contract and required State Delta types.
10. Budget, deadline, expiry, stop conditions, and escalation policy.
11. Blindness policy specifying which incumbent material must be withheld.

Batons must be immutable after issue. Amend by issuing a successor baton.

## State Delta

A State Delta proposes a typed change against `base_mission_version`.

Required fields:

- Delta ID, idempotency key, mission ID, base version.
- Author and execution identity.
- Baton ID and work-item ID.
- Delta type and operations.
- Ledger entries created or referenced.
- Rationale and confidence.
- Evidence and artifact references.
- Expected downstream effects.
- Human gate classification.
- Skill names and versions used.
- Timestamp and signature or audit hash.

Initial delta types:

- `CLAIM_ADDED`, `EVIDENCE_ADDED`, `ASSUMPTION_CHALLENGED`
- `UNCERTAINTY_OPENED`, `UNCERTAINTY_UPDATED`, `UNCERTAINTY_RESOLVED`
- `HYPOTHESIS_ADDED`, `HYPOTHESIS_REJECTED`
- `EXPERIMENT_PROPOSED`, `EXPERIMENT_RESULT`
- `DECISION_PROPOSED`, `DECISION_ACCEPTED`, `DECISION_INVALIDATED`
- `OBJECTIVE_CREATED`, `OBJECTIVE_UPDATED`, `OBJECTIVE_COMPLETED`
- `BLOCKED`, `CAPABILITY_REQUESTED`, `PLAN_CHANGE_PROPOSED`
- `CHECKPOINT_CREATED`, `MISSION_STATUS_CHANGED`

## Merge rules

1. Reject malformed deltas before any write.
2. Enforce caller identity and mission visibility server-side.
3. Deduplicate by idempotency key.
4. Compare base version with current mission version.
5. Auto-merge commutative additions when dependencies still exist.
6. Route conflicting decisions, status changes, removals, and confidence collapses to conflict resolution.
7. Append ledger and delta records before materializing Mission State.
8. Commit mission version and event atomically where supported.
9. Recompute affected dependency nodes and uncertainty triggers.
10. Emit a typed mission event and invalidate stale batons.

## Proposed MCP tools

Keep v1 small and composable:

| Tool | Purpose |
|---|---|
| `create_mission_v2` | Create rich mission intent, constraints, success criteria, and initial state |
| `get_mission_state` | Read the current state or a specified version |
| `submit_state_delta` | Validate and merge a delta |
| `list_state_deltas` | Audit mission change history |
| `query_epistemic_ledger` | Retrieve typed, dependency-linked entries |
| `compile_cognitive_baton` | Build a baton for objective, agent, and mode |
| `get_cognitive_baton` | Retrieve an issued baton if authorized and unexpired |
| `create_cognitive_work_item` | Add bounded cognition to the scheduler queue |
| `get_cognitive_queue` | Inspect prioritized work and ownership |
| `explain_scheduler_decision` | Return scores, exclusions, and rationale |
| `trigger_uncertainty_review` | Force structured lock-in review for an object or decision |
| `checkpoint_mission` | Create a durable version checkpoint before transition |
| `resume_mission` | Return the current mission, baton, deltas since checkpoint, and owned work |

Retain current mission tools during migration. Internally adapt their output into Mission State where safe; do not break existing clients in v1.

## Proposed REST resources

- `/api/v1/missions-v2`
- `/api/v1/missions-v2/:id/state`
- `/api/v1/missions-v2/:id/deltas`
- `/api/v1/missions-v2/:id/ledger`
- `/api/v1/missions-v2/:id/batons`
- `/api/v1/missions-v2/:id/work-items`
- `/api/v1/missions-v2/:id/scheduler-decisions`
- `/api/v1/missions-v2/:id/checkpoints`

Use cursor pagination, version ETags, scope filtering, audit records, and strict request size limits.

## Event contract

Publish typed events on the existing shared event rail:

- `mission.created`, `mission.version.advanced`, `mission.checkpoint.created`
- `delta.accepted`, `delta.rejected`, `delta.conflict`
- `ledger.entry.created`, `ledger.entry.superseded`
- `uncertainty.opened`, `uncertainty.triggered`, `uncertainty.resolved`
- `decision.invalidated`, `baton.issued`, `baton.expired`
- `work.queued`, `work.allocated`, `work.blocked`, `work.completed`
- `scheduler.shadow.scored`, `scheduler.allocation.explained`

Events carry IDs and summaries, never secrets or full private reflections.

## Graph integration

Project the ledger into the existing graph so the context compiler can traverse from objective to decision, assumption, evidence, experiment, code component, tests, and agent provenance. Keep MongoDB records authoritative; the graph is a query projection that can be rebuilt.

## Capability model

Batons contain only opaque capability references:

```yaml
capabilities:
  - capability_id: github.kolega.write
    scope: repo-183
    operations: [read, commit, create_pr]
    approval: gated
```

Resolution occurs server-side through Katra Vault. Log capability use by reference, scope, caller, approval, and result, never by secret value.

## Compatibility and schema versioning

- Add `schema_version` to every new object.
- Reject unknown major versions; tolerate additive minor fields.
- Store skill version in batons and outcomes.
- Keep migrations idempotent and restart-safe.
- Provide a rebuild command for Mission State and graph projections from accepted deltas and ledger entries.
