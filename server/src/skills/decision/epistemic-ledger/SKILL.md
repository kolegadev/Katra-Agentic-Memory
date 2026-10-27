---
name: epistemic-ledger
title: Epistemic Ledger — Claims, Evidence, Assumptions and Contradictions
category: decision
description: Record and update provenance-aware claims, evidence, assumptions, hypotheses, uncertainty, contradictions, decisions, experiments, and results for a mission.
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - assumption
  - contradiction
  - evidence
  - confidence
---
# Epistemic Ledger

## Purpose

Make the mission's reasoning inspectable, challengeable, and reconstructable without forcing agents to share a private worldview.

## Classification

Classify each material statement before relying on it:

- Observation or evidence: what was measured, read, or produced.
- Claim: a falsifiable proposition.
- Assumption: relied upon without sufficient confirmation.
- Hypothesis: one possible explanation or solution model.
- Uncertainty: unresolved alternatives that matter.
- Contradiction: incompatible records or outcomes.
- Decision: a chosen action with dependencies and alternatives.
- Experiment: a test intended to distinguish hypotheses.
- Result: the observed outcome of a test or action.

## Procedure

1. Preserve original author, source, time, artifact hash, and mission context.
2. Link evidence to the claims it supports or contradicts.
3. Link decisions to assumptions, claims, alternatives, and success criteria.
4. Record confidence as a current estimate plus a change history, not an overwritten scalar.
5. When evidence conflicts, create a contradiction instead of averaging it away.
6. When an entry changes, supersede or invalidate it while retaining history.
7. Traverse downstream dependencies after material confidence loss or contradiction.
8. Create work items for missing discriminating information.

## Evidence quality

Record source type, directness, recency, independence, reproducibility, and known limitations. Repetition by correlated agents is not independent support.

## Decision discipline

Before accepting a consequential decision, require:

- Explicit alternatives considered.
- Assumptions and uncertainties.
- Evidence for and against.
- Consequence if wrong.
- Reversal cost and review condition.
- Owner and authority classification.

## Completion

The ledger is complete enough when a reviewer can reconstruct why the current model exists, what could falsify it, and what downstream work would change if it is wrong.
