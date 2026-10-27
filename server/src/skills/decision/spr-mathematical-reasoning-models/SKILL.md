---
name: spr-mathematical-reasoning-models
title: "SPR Mathematical Reasoning Models — Six Staged Frameworks for Hard Problems"
category: decision
description: "Six staged reasoning scaffolds — Intuition-Driven, Schoenfeld, Lakatos, Abstraction and Generalization, Analogy and Metaphor, and Meta — each a sparse priming representation of a process rather than a problem. Use when a problem is unsolved after a direct attempt, when the approach funnel is narrow, when a conjecture needs adversarial pressure before being built on, when a result should transfer domains, or when a long attempt needs metacognitive re-entry."
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - stuck
  - narrow approach
  - conjecture
  - refutation
  - lakatos
  - generalization
  - abstraction
  - analogy
  - metaphor
  - metacognition
  - schoenfeld
  - reasoning model
  - intuition
  - problem solving scaffold
---
# SPR Mathematical Reasoning Models

## Purpose

Six staged reasoning scaffolds, expressed as sparse priming representations (SPRs) of
the *process* rather than the problem. Each model is a different cognitive route to the
same target: a defensible result.

They are not alternatives to rigor — they are the different ways rigor gets *reached*.
Intuition finds the claim, Lakatos attacks it, abstraction generalizes it, analogy
transfers it, Schoenfeld monitors whether the attempt is working, and the meta-model
sequences all of it.

Because each model primes a different region of the problem, running two or three of
them over the same problem yields materially more distinct candidate approaches than
running one of them twice.

## Use when

- A problem is unsolved after a direct attempt.
- The initial funnel of approaches is narrow (one or two ideas).
- A conjecture needs adversarial pressure before being built upon.
- A result from one domain should transfer to another.
- A long attempt has drifted and needs metacognitive re-entry.

## The models

Each model below is a phase chain. `CONNECT` gives the forward flow; `ITERATE` gives the
return edge that closes the loop. Run the chain, take the return edge, and re-enter —
the second pass is where the model earns its value.

### 1. Intuition-Driven Problem Solving

```
PROBLEM_FAMILIARIZATION → SMALL_CASE_ANALYSIS → PATTERN_RECOGNITION →
MOTIVATION_EXTRACTION → OBSTACLE_IDENTIFICATION → HYPOTHESIS_FORMATION →
APPROACH_DEVELOPMENT → LEAP_OF_FAITH_REASONING → RIGOROUS_PROOF_CONSTRUCTION →
SOLUTION_VERIFICATION → REFLECTION_AND_GENERALIZATION
```

`ITERATE: REFLECTION_AND_GENERALIZATION → PROBLEM_FAMILIARIZATION`

Phases:

- **PROBLEM_FAMILIARIZATION** — understand the statement; identify key components;
  recognize constraints and conditions.
- **SMALL_CASE_ANALYSIS** — identify the simplest cases; examine trivial solutions;
  calculate explicit examples.
- **PATTERN_RECOGNITION** — observe recurring behaviour; identify cycles and
  periodicities; note exceptional cases.
- **MOTIVATION_EXTRACTION** — uncover *why* the observed pattern holds; extract the key
  insight; articulate the intuitive understanding.
- **OBSTACLE_IDENTIFICATION** — pinpoint what prevents the desired outcome; analyze
  boundary conditions; recognize critical thresholds.
- **HYPOTHESIS_FORMATION** — generalize the pattern; propose an underlying mechanism;
  state a testable conjecture.
- **APPROACH_DEVELOPMENT** — construct the general framework; identify key parameters;
  design the proof strategy.
- **LEAP_OF_FAITH_REASONING** — make educated guesses on intuition; bridge gaps in the
  formal logic; propose the candidate solution.
- **RIGOROUS_PROOF_CONSTRUCTION** — define essential variables; establish logical steps;
  apply relevant theorems.
- **SOLUTION_VERIFICATION** — test against the initial cases; ensure comprehensive
  coverage; address counterexamples.
- **REFLECTION_AND_GENERALIZATION** — analyze the process; extract generalizable
  principles; identify where else it applies.

**Distinctive operator:** `INTUITION_FORMALIZATION` — transform concrete observations
and motivations into abstract principles.

### 2. Schoenfeld

```
RESOURCES → BELIEFS_ORIENTATIONS → PROBLEM_ANALYSIS → MONITORING_CONTROL →
HEURISTIC_STRATEGIES → VERIFICATION
```

`ITERATE: VERIFICATION → PROBLEM_ANALYSIS`

Phases:

- **RESOURCES** — identify domain knowledge; assess heuristics; evaluate control
  systems.
- **BELIEFS_ORIENTATIONS** — examine personal views; consider the mathematical
  worldview in play; assess perceived difficulty.
- **PROBLEM_ANALYSIS** — define the problem space; identify key components; explore
  relationships.
- **MONITORING_CONTROL** — track solution progress; evaluate strategy effectiveness;
  adjust approach dynamically.
- **HEURISTIC_STRATEGIES** — apply relevant techniques; explore multiple paths;
  simplify complex elements.
- **VERIFICATION** — check validity; consider alternative methods; reflect on process.

**Distinctive operator:** `METACOGNITION` — reflect on thought processes throughout.

Schoenfeld's contribution is the insistence that *control* — monitoring and adjusting —
is a first-class part of problem solving, not an afterthought. Use this model when the
risk is not ignorance but an unproductive attempt being continued out of momentum.

### 3. Lakatos

```
PRIMITIVE_CONJECTURE → {GLOBAL_COUNTEREXAMPLE, LOCAL_COUNTEREXAMPLE} →
PROOF_ANALYSIS → {CONCEPT_STRETCHING, MONSTER_BARRING, EXCEPTION_BARRING} →
PROOFS_AND_REFUTATIONS
```

`ITERATE: PROOFS_AND_REFUTATIONS → PRIMITIVE_CONJECTURE`

Phases:

- **PRIMITIVE_CONJECTURE** — formulate the initial theorem; state an informal proof.
- **GLOBAL_COUNTEREXAMPLE** — find a case contradicting the conjecture outright;
  reevaluate.
- **PROOF_ANALYSIS** — examine the proof steps; identify the crucial lemma.
- **LOCAL_COUNTEREXAMPLE** — find a case contradicting the *lemma*; refine the theorem's
  conditions.
- **CONCEPT_STRETCHING** — redefine terms; expand conceptual boundaries.
- **MONSTER_BARRING** — exclude the counterexample; narrow the theorem's scope.
- **EXCEPTION_BARRING** — identify exceptional cases; modify the theorem accordingly.
- **PROOFS_AND_REFUTATIONS** — reformulate the theorem; develop the improved proof.

**Distinctive operator:** `DIALECTIC` — continuous thesis, antithesis, synthesis.

This is the strongest model for **turn a failed claim into a better theorem**. The
counterexample is not an obstacle; it is the instrument. Use it whenever a conjecture
is being relied on before it has survived an attack.

### 4. Abstraction and Generalization

```
CONCRETE_ANALYSIS → ABSTRACTION → GENERALIZATION → FORMAL_DEFINITION →
THEOREM_FORMULATION → SPECIALIZATION
```

`ITERATE: SPECIALIZATION → CONCRETE_ANALYSIS`

Phases:

- **CONCRETE_ANALYSIS** — examine specific instances; identify common patterns; note
  unique features.
- **ABSTRACTION** — remove specific detail; retain essential structure; formulate the
  abstract concept.
- **GENERALIZATION** — extend the pattern broadly; propose general principles; test on
  new instances.
- **FORMAL_DEFINITION** — articulate precise terms; establish clear conditions; ensure
  logical consistency.
- **THEOREM_FORMULATION** — state the general claim; outline the proof strategy;
  identify key lemmas.
- **SPECIALIZATION** — apply the general concept back to specifics; verify concrete
  implications; refine the abstraction.

**Distinctive operator:** `BALANCE` — maintain equilibrium between abstract and
concrete.

The `SPECIALIZATION` return edge is what makes this safe: a generalization that has not
been specialized back to its motivating cases is unverified.

### 5. Analogy and Metaphor in Mathematics

```
SOURCE_DOMAIN → TARGET_DOMAIN → ANALOGY_MAPPING → METAPHORICAL_REASONING →
INFERENCE_GENERATION → ANALOGY_LIMITS → FORMALIZATION
```

`ITERATE: FORMALIZATION → SOURCE_DOMAIN`

Phases:

- **SOURCE_DOMAIN** — identify a familiar concept; analyze its key properties;
  understand its structural relationships.
- **TARGET_DOMAIN** — recognize the problem's elements; map them to the source; identify
  corresponding structures.
- **ANALOGY_MAPPING** — establish clear correspondences; transfer relevant properties;
  preserve structural relations.
- **METAPHORICAL_REASONING** — apply intuitive understanding; leverage conceptual
  metaphors; bridge abstract and concrete.
- **INFERENCE_GENERATION** — derive new insights; propose hypotheses; extend knowledge.
- **ANALOGY_LIMITS** — recognize where the analogy breaks; identify non-transferable
  aspects; refine its scope.
- **FORMALIZATION** — translate analogical insight into rigorous argument; establish the
  proof.

**Distinctive operator:** `CREATIVE_SYNTHESIS` — combine multiple analogies for deeper
understanding.

`ANALOGY_LIMITS` is not optional. An analogy that has not been probed for its breakdown
point is a source of confident error — the transfer looks valid precisely because the
disanalogy has not been named.

### 6. Meta Mathematical Problem Solving

The full-sequence model. Use it when no single model above is clearly right, or when the
problem is large enough to need all the moves in one pass.

```
PROBLEM_ANALYSIS → RESOURCE_ASSESSMENT → CONCRETE_EXPLORATION →
ABSTRACTION_AND_GENERALIZATION → ANALOGY_AND_METAPHOR → MOTIVATION_EXTRACTION →
CONJECTURE_FORMULATION → PROOF_STRATEGY_DEVELOPMENT → RIGOROUS_ANALYSIS →
OBSTACLE_NAVIGATION → CREATIVE_SYNTHESIS → VERIFICATION_AND_REFLECTION →
KNOWLEDGE_INTEGRATION
```

`ITERATE: KNOWLEDGE_INTEGRATION → PROBLEM_ANALYSIS`

Phases:

- **PROBLEM_ANALYSIS** — understand the statement; identify components and constraints;
  relate to known domains.
- **RESOURCE_ASSESSMENT** — evaluate relevant knowledge and theorems; identify
  applicable heuristics; assess the mathematical worldview in play.
- **CONCRETE_EXPLORATION** — examine small cases and examples; identify patterns and
  regularities; explore boundary conditions.
- **ABSTRACTION_AND_GENERALIZATION** — extract essential structure; formulate abstract
  concepts; propose general principles.
- **ANALOGY_AND_METAPHOR** — identify similar problems or concepts; map corresponding
  structures; apply intuitive understanding.
- **MOTIVATION_EXTRACTION** — uncover why the observations hold; articulate the intuitive
  insight; identify the drivers of the pattern.
- **CONJECTURE_FORMULATION** — state the initial claim; outline an informal proof
  attempt; identify the critical lemmas and subproblems.
- **PROOF_STRATEGY_DEVELOPMENT** — design the overall proof structure; identify key steps
  and techniques; plan the lemma sequence.
- **RIGOROUS_ANALYSIS** — construct formal definitions; develop precise arguments; apply
  the relevant theorems.
- **OBSTACLE_NAVIGATION** — identify proof breakdown points; refine theorem statements or
  conditions; explore alternative proof paths.
- **CREATIVE_SYNTHESIS** — combine multiple approaches; bridge intuition and formalism;
  make the innovative connection.
- **VERIFICATION_AND_REFLECTION** — check validity and completeness; consider alternative
  methods; reflect on the process.
- **KNOWLEDGE_INTEGRATION** — contextualize the solution in the broader theory; identify
  new connections; extract generalizable principles.

## Cross-cutting stances

Apply these over whichever model is running:

- **DYNAMIC_ADAPTATION** — flexibly apply and combine strategies based on problem
  characteristics and current cognitive state.
- **METACOGNITION** — continuously monitor and adjust both approach and mental state.
- **NEUROPLASTICITY** — embrace the ability to form new connections and reorganize
  approach.
- **COGNITIVE_DIVERSITY** — leverage different thinking styles and perspectives.
- **EMBODIED_COGNITION** — recognize the role of physical state and environment in
  thinking.

## Choosing a model

| Situation | Model |
|---|---|
| No idea where to start | Intuition-Driven |
| Attempt is running but not working | Schoenfeld |
| A claim is being relied on untested | Lakatos |
| A special result should become general | Abstraction and Generalization |
| The problem resembles something solved | Analogy and Metaphor |
| Large or unfamiliar; no clear route | Meta |

Running two models over one problem is cheap and routinely surfaces a second approach.
Running the same model twice rarely does.

## Avoid

- Running a model as a ritual, producing the phase names without their content.
- Treating `LEAP_OF_FAITH_REASONING` output as established — it is a candidate, and the
  chain exists to test it.
- Skipping `ANALOGY_LIMITS` or the `SPECIALIZATION` return edge.
- Selecting a model by habit rather than by what the current blocker is.
- Confusing fluency in the vocabulary with progress on the problem.

## Related skills

- `mathematical-problem-solving-framework` — the rigorous, coverage-first companion.
- `explore-and-falsify` — formal hypothesis generation and discrimination.
- `spr-ideation-toolkit` — widening the search space before choosing a model.
- `breaking-hypothesis-lock-in` — when a model has been run into tunnel vision.

## Provenance

Adapted from *SPR Prompt Models for Mathematical Problem Solving* (the operator Pellew,
`~/Downloads/`). All six models, their phase chains, their `CONNECT` / `ITERATE` edges,
their distinctive operators, and the five cross-cutting stances are preserved from the
source.
