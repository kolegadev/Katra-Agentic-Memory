# Seed Skill Catalog

The detailed procedures are supplied in `skills/<name>/SKILL.md`. All are deliberately seeded at candidate status and should be validated against Katra's current frontmatter parser before installation.

| Skill | Category | Primary activation |
|---|---|---|
| `long-horizon-mission` | decision | Work spans contexts, agents, staged evidence, or meaningful uncertainty |
| `mission-state-management` | operational | Shared operational truth, ownership, dependencies, or mission status changes |
| `cognitive-baton` | operational | A bounded episode, wake, handoff, transfer, or blind worker needs context |
| `epistemic-ledger` | decision | Claims, evidence, assumptions, confidence, contradictions, decisions, or experiments matter |
| `explore-and-falsify` | decision | The solution space is poorly understood or several hypotheses remain plausible |
| `distributed-cognition` | decision | Work may benefit from persistent identities, independent minds, challengers, or bounded workers |
| `mission-replanning` | decision | Evidence, constraints, or results may invalidate part of the current plan |
| `context-transition` | operational | Clear, compression, restart, model switch, machine transfer, or ownership handoff is imminent |
| `breaking-hypothesis-lock-in` | troubleshooting | Confidence has hardened despite weak assumptions, repeated failure, or contradictory evidence |

## Minimal permanent kernel instruction

The permanent agent instruction should remain small:

```text
For work likely to span contexts, sessions, agents, or substantial uncertainty:

1. Search procedural memory for applicable long-horizon skills.
2. Treat Mission State as authoritative continuity, not conversation history.
3. Persist mission-significant discoveries before context loss.
4. Reconstruct current mission state after wake, compression, or reset.
5. Record outcomes for every procedural skill used.
```

## Installation sequence

1. Validate frontmatter fields and allowed categories against the live loader.
2. Install `long-horizon-mission` first but keep activation manual during development.
3. Install state, baton, ledger, and context skills after the corresponding runtime tools exist.
4. Install exploration, distributed cognition, replanning, and lock-in recovery in observe-only or recommendation mode.
5. Pin exact versions in pilot missions.
6. Capture outcomes and human corrections.
7. Refine candidate versions, replay historical missions, canary, then promote.

## Outcome note structure

Where the current `record_skill_outcome` API accepts only notes, serialize a compact structured note until a metadata field is available:

```yaml
mission_class: research
work_mode: challenge
mission_result: partial
useful_new_evidence: true
decision_changed: false
hypothesis_diversity_before: 1
hypothesis_diversity_after: 3
human_correction: none
cost_band: medium
comments: Blind fan out produced two genuinely distinct causal models.
```

## Promotion policy

Do not allow a skill to rewrite itself in place for active missions. Refinement creates a candidate version. Promotion requires replay tests, security checks, cost review, and a canary. Severe safety failure may immediately challenge a version, but one ordinary failure should not.
