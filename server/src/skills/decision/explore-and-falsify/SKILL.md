---
name: explore-and-falsify
title: Explore and Falsify — Generate and Discriminate Hypotheses
category: decision
description: Expand a poorly understood solution space, generate genuinely distinct hypotheses, and seek evidence that can distinguish or falsify them before convergence.
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - hypothesis
  - falsify
  - alternatives
  - experiment
---
# Explore and Falsify

## Purpose

Prevent premature convergence by separating hypothesis generation, independent commitment, comparison, and testing.

## Use when

- The solution space is poorly understood.
- Existing evidence supports several explanations.
- A high-impact decision has low hypothesis diversity.
- A surprising result conflicts with the current model.
- Mind-wander or graph traversal reveals a plausible remote connection.

## Procedure

1. Define the question and what would count as materially different hypotheses.
2. List known observations without embedding the incumbent conclusion.
3. Decide whether independent workers are required.
4. Generate hypotheses from distinct causal models, not paraphrases.
5. Commit hypotheses independently before exposing them to one another.
6. For each hypothesis, record assumptions, predictions, failure signatures, and distinguishing evidence.
7. Reject hypotheses that are not falsifiable or do not change action.
8. Design the lowest-cost high-information test.
9. Run or propose tests within authority and capability limits.
10. Update the ledger and mission through State Deltas.
11. Stop exploration when expected information value falls below cost or a decision threshold is met.

## Controlled divergent cognition

`get_mind_wander` may be used to propose remote associations. Treat its output as a hypothesis source, never as evidence. Validate every useful association independently.

## Avoid

- Producing many cosmetic variants.
- Asking agents to be creative after showing them the favored answer.
- Voting before evidence comparison.
- Treating model confidence or rhetorical fluency as validation.
- Continuing fan-out after hypotheses cease to be meaningfully distinct.
