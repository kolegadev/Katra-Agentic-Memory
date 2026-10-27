# Test and Evaluation Plan

## Test layers

| Layer | Focus |
|---|---|
| Unit | Validators, scores, merge rules, redaction, dependency traversal |
| Property based | Idempotency, replay equivalence, version monotonicity, scope invariants |
| Integration | MongoDB, Redis, pub-sub, graph projection, vault capability references, MCP and REST |
| End to end | Multi-agent mission from intake through closure |
| Resilience | Restart, partial failure, duplication, delay, provider outage, corrupted projection |
| Security | IDOR, prompt injection, secret exfiltration, scope leaks, replay, SSRF, oversized payloads |
| Epistemic | Provenance, contradiction, uncertainty, diversity, invalidation, calibration |
| Human evaluation | Usefulness, traceability, cognitive novelty, unnecessary ceremony, intervention load |

## Core invariants

1. Mission versions are monotonic.
2. An accepted delta is applied exactly once.
3. Replaying accepted deltas from a valid checkpoint produces the same Mission State.
4. No untrusted caller can act as another identity.
5. Private identity records never enter another identity's baton.
6. Secret values never enter mission, ledger, delta, baton, event, log, or model prompt.
7. Every decision references its assumptions and evidence.
8. Every confidence change records its cause and actor.
9. Invalidating an assumption identifies all dependent active decisions.
10. Blind exploration excludes prohibited incumbent content.
11. A stale baton cannot overwrite a newer conflicting state.
12. Skill version changes do not silently alter an active mission.

## Unit and property tests

- JSON Schema accepts valid samples and rejects missing, oversized, unknown-major, or malformed objects.
- Delta merge is commutative only for declared safe operations.
- Duplicate idempotency keys return the original result.
- Conflict resolution never drops either competing proposal.
- Priority and suitability scores are deterministic for the same inputs.
- Zero or missing cost and uncertainty values do not cause division errors or infinite scores.
- Redaction removes secrets and private content before serialization.
- Graph projection rebuild is equivalent to incremental projection for the same ledger.
- Dependency traversal terminates under cycles and records the cycle.

## End to end scenarios

### Scenario A Context reset continuity

Create a mission, accept two deltas, assign work, checkpoint, clear the agent context, and resume. The resumed agent must identify the mission version, ownership, changed state, active uncertainty, and next action without transcript replay.

### Scenario B Contradicted assumption

A decision depends on an assumption. Add reliable contrary evidence. The system must open a contradiction, restore uncertainty, identify downstream decisions and objectives, suspend affected work, and queue independent review.

### Scenario C Hypothesis lock-in

Seed repeated failure, high confidence, and a single hypothesis. The trigger must freeze automatic promotion, create blind work, produce independently committed alternatives, and measure whether the resulting evidence changes or strengthens the model.

### Scenario D Correlated agents

Give several agents the same incumbent rationale and compare them with agents receiving blind batons. Verify that the diversity metric detects artificial agreement and that scheduler explanations show the correlation penalty.

### Scenario E Stale baton

Issue two batons at version 5. Accept one plan-changing delta to version 6. The second worker submits an incompatible version-5 decision. The system must reject or route conflict, never overwrite.

### Scenario F Secret boundary

Grant a vault capability, run an action, and inspect all prompts, events, records, error messages, and dashboard payloads. Only the capability ID, scope, approval, and outcome may appear.

### Scenario G Custodian degradation

Stop Redis, delay graph projection, and make the LLM provider unavailable. Durable reads and accepted writes must remain safe; allocation and synthesis must pause or degrade according to the runbook.

### Scenario H Skill regression

Refine a skill from historical failures. Replay the candidate on a frozen test set, canary it on selected missions, and verify automatic rollback or non-promotion if outcome quality, cost, or safety regresses.

## Evaluation metrics

### Mission outcome

- Success-criterion satisfaction rate.
- Time and model cost to verified outcome.
- Rework caused by invalid assumptions.
- Percentage of completion claims backed by evidence.
- Human intervention count and severity.

### Continuity

- Resume accuracy after clear, compress, restart, and ownership transfer.
- Percentage of critical state reconstructed without transcript replay.
- Stale baton and stale ownership incident rate.

### Epistemic quality

- Claim provenance coverage.
- Decision dependency coverage.
- Confidence calibration by outcome bucket.
- Contradiction detection precision and recall.
- Time from disconfirming evidence to downstream invalidation.
- Open uncertainty age and accepted-risk rate.

### Exploration quality

- Hypothesis diversity before and after trigger.
- Distinguishing-test rate.
- Useful trigger precision: proportion producing material new evidence, a changed decision, or justified confidence increase.
- Performative doubt rate: additional prose or variants with no discriminating value.
- Blindness leakage rate.

### Scheduler quality

- Allocation regret against post-outcome best candidate.
- Work duplication and collision rate.
- Queue latency by impact class.
- Budget overrun rate.
- Explanation completeness.
- Diversity benefit relative to correlation cost.

### Skill quality

- Outcome by skill version and work class.
- Partial and failure reasons.
- Cost per successful use.
- Challenge-to-recovery rate.
- Replay and canary regression count.

## Pilot benchmark set

Use at least five mission types:

1. Multi-day code architecture change with evolving tests.
2. Research question with conflicting sources.
3. Production incident with incomplete evidence and time pressure.
4. Design decision with several viable tradeoffs.
5. Mission deliberately seeded with a plausible but false inherited assumption.

Run each under baseline Katra and the cognitive-control feature flags. Preserve the same authority and model budgets where practical.

## Promotion gates

Do not enable autonomous scheduling beyond read-only analysis unless:

- Zero secret or private-memory leakage in the security suite.
- Deterministic state rebuild passes repeatedly.
- No silent lost-update failures under concurrency tests.
- Blindness leakage is zero in defined fixtures.
- Human reviewers can trace all consequential decisions.
- Pilot mission outcome improves or remains equal without unacceptable cost increase.
- Custodian recovery drills complete successfully.
