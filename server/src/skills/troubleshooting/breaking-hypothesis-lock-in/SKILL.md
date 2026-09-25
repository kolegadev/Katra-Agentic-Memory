---
name: breaking-hypothesis-lock-in
title: Breaking Hypothesis Lock-In — Reopening Premature Commitment
category: troubleshooting
description: Diagnose and recover from premature commitment, tunnel vision, or unjustified confidence by restoring structured uncertainty and creating independent discriminating work.
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - lock-in
  - tunnel vision
  - false confidence
  - stuck
---
# Breaking Hypothesis Lock In

## Purpose

Reopen a prematurely collapsed hypothesis space. This is an operational form of the Uncertainty Principle: additional reasoning can deepen an error when weak assumptions have already been promoted to fact.

## Trigger signals

- Repeated failure with unchanged reasoning and high confidence.
- High confidence supported mainly by inferred, inherited, or convenient assumptions.
- One hypothesis dominates a high-impact decision.
- Contradictory evidence is explained away without a discriminating test.
- The plan remains unchanged after a surprising result.
- Several agents agree but share the same prompt, sources, or incumbent rationale.

## Procedure

1. Freeze automatic promotion of the affected conclusion.
2. State the incumbent hypothesis without defending it.
3. Enumerate every necessary assumption.
4. Label each assumption `observed`, `inferred`, `inherited`, or `convenient`.
5. Rank assumptions by consequence if false and evidence weakness.
6. Open or update an uncertainty entry for the highest-impact weakness.
7. Construct at least one coherent model in which that assumption is false.
8. Create blind independent work items that omit the incumbent conclusion and rationale.
9. Require each worker to provide a falsifiable hypothesis, predicted observations, and a distinguishing test.
10. Commit independent outputs before comparison.
11. Run or propose the highest-information feasible test.
12. Update confidence, decisions, and downstream work through State Deltas.
13. Record whether the trigger produced material information and whether activation was justified.

## Do not

- Prompt the same context merely to "be uncertain" or "think harder."
- Reward hedging language without testable alternatives.
- Increase temperature and treat variance as epistemic diversity.
- Expose blind workers to the favored answer through filenames, labels, summaries, or examples.
- Force resolution when evidence remains genuinely insufficient.

## Completion states

- `reaffirmed`: the incumbent survived a meaningful challenge and gained justified confidence.
- `revised`: assumptions or scope changed.
- `replaced`: a better-supported hypothesis became operational.
- `unresolved`: alternatives remain live and action is deferred or risk-accepted.
- `false_trigger`: reopening added cost without plausible information value; record for trigger calibration.
