# Operations Security and Rollout

## Authority model

Reuse the existing authority matrix and make it explicit on every work item, baton, delta, and capability request.

| Class | Typical scope | Default behavior |
|---|---|---|
| A Autonomous | Katra memory, internal indexes, projections, diagnostics | Execute within bounded policy |
| B Gated | External repositories, user projects, third-party writes | Analyze and prepare; require approval before effect |
| C Cautious | System configuration, networking, service managers | Inspect first, preserve defaults, require explicit gate for material changes |

Mission cognition may be autonomous while external effects remain gated.

## Privacy boundaries

- Private reflection and identity development remain private per identity.
- Agent-profile features exposed to the scheduler must be derived, minimal, and non-narrative.
- Scheduler explanations may say that an agent has high historical success in a work class; they must not quote its private journal.
- Shared mission state contains operational claims and evidence, not private feelings.
- Cross-agent sharing of private reflection is out of scope unless separately designed and consented.

## Security controls

- Resolve caller identity from authenticated context, never payload claims.
- Validate mission membership and operation scope server-side.
- Use vault capability IDs only.
- Redact and denylist secret-bearing fields at every serialization boundary.
- Apply size limits and content-type validation to evidence and artifacts.
- Hash and scan uploaded artifacts before use.
- Prevent SSRF through existing server-side URL controls.
- Sign or hash batons and deltas for tamper evidence.
- Use nonce or idempotency protection against replay.
- Rate-limit expensive baton compilation, blind fan-out, and graph traversal.
- Record human approval identity, time, scope, and exact proposed effect.

## Threat scenarios

| Threat | Control |
|---|---|
| Prompt injection in evidence | Treat evidence as data, isolate instructions, retain provenance, require tool-policy enforcement |
| False consensus | Preserve individual provenance, correlation penalty, blind independent sampling |
| Malicious delta | Schema validation, caller binding, authority gate, version check, audit |
| Secret exfiltration | Capability references, vault execution, redaction tests, denylisted collections |
| Private identity leakage | Existing forced-private kinds plus baton ownership checks |
| Scheduler capture | Explainable scores, deterministic rules, shadow mode, override and audit |
| Skill poisoning | Version pinning, signed sources, replay tests, canary promotion |
| Event loss | Durable outbox, consumer offsets, repair and replay |
| Graph corruption | Authoritative ledger in MongoDB, rebuildable projection |
| Runaway exploration | Budget, fan-out cap, expiry, diminishing-return stop rule |

## Observability

Metrics:

- Accepted, rejected, duplicate, and conflicting deltas.
- Mission version age and checkpoint age.
- Baton compile latency, size, expiry, and stale-submission rate.
- Ledger entries by type and unresolved contradiction count.
- Open uncertainty count, age, trigger source, and resolution outcome.
- Queue depth, allocation latency, leases, retries, cancellations, and duplicate work.
- Scheduler feature contributions and overrides.
- Skill outcomes by version.
- Event lag, projection lag, backup age, rebuild duration, and integrity errors.
- Capability requests, approvals, denials, and failures by scope.

Alerts:

- Mission-state/event mismatch.
- Repeated merge failure for one mission.
- Secret-pattern detection in any model-visible payload.
- Private-scope violation attempt.
- Baton created from a missing or stale mission version.
- Contradiction unresolved beyond policy threshold on critical work.
- Scheduler allocation outside authority policy.
- Custodian heartbeat, backup, or projection failure.

## Backup and recovery

- Include all new MongoDB collections in backups.
- Persist event outbox and consumer positions.
- Back up skill versions and promotion metadata.
- Batons may expire but their audit metadata must remain recoverable.
- Test point-in-time restore followed by state and graph rebuild.
- Verify vault restoration separately without exposing secret material.

Recovery priority:

1. Authentication, identity, and scope.
2. Mission State, ledger, deltas, and audit.
3. Vault and capability resolution.
4. Event delivery and work leases.
5. Graph projections and batons.
6. Autonomous scheduling and model-assisted synthesis.

## Rollout flags

```text
COGNITIVE_CONTROL_ENABLED=off|read|write
COGNITIVE_SCHEDULER_MODE=off|shadow|recommend|allocate_internal|allocate_gated
UNCERTAINTY_TRIGGER_ENABLED=off|observe|open_only|fanout
BATON_WAKE_INTEGRATION=off|pilot|all
SKILL_VERSION_POLICY=pinned|candidate_canary|latest_stable
```

## Rollout stages

1. Developer fixtures and local Docker stack.
2. One synthetic identity and no external capabilities.
3. One persistent agent on internal Katra maintenance missions.
4. Two persistent agents with blind analysis only.
5. Full identity set in shadow scheduler mode.
6. Internal autonomous allocation under class A.
7. Gated user-project pilot.
8. Broader rollout after evaluation gates.

## Rollback

- Disable scheduler and uncertainty fan-out without disabling read access to mission records.
- Preserve all accepted deltas and ledger history.
- Revert to current mission tools through compatibility adapters.
- Pin the previous stable skill versions.
- Rebuild materialized state from the last verified checkpoint.
- Never delete failed candidate records during rollback; mark them inactive for analysis.

## Custodian runbook summary

The custodian should remain outside normal epistemic consensus. Its highest-priority checks are authentication, database availability, scope integrity, backups, event consistency, index health, projection drift, stale leases, and secret-boundary alarms. When integrity is uncertain, stop mutation first, preserve evidence, and degrade to read-only inspection.

## Documentation updates required in the repository

- Add `docs/COGNITIVE-CONTROL-PLANE.md`.
- Add `docs/MISSION-STATE.md`.
- Add `docs/EPISTEMIC-LEDGER.md`.
- Add `docs/COGNITIVE-BATON.md`.
- Add `docs/COGNITIVE-SCHEDULER.md`.
- Add `docs/UNCERTAINTY-TRIGGERS.md`.
- Extend `docs/MCP-TOOLS.md` and REST reference.
- Extend `docs/AUTONOMOUS-LOOP.md` with the cognitive scheduler boundary.
- Extend wake integration documentation and runbooks.
- Add migration, backup, rollback, and dashboard operator guides.
