---
name: mathematical-problem-solving-framework
title: "Mathematical Problem-Solving Framework — IMO-Style Rigor for Hard Problems"
category: decision
description: "Solve hard mathematical and structural problems with a coverage-first discipline: analyze the statement, explore small and edge cases, form and attack hypotheses, map the full case space, then construct and verify a proof. Use when a problem resists the first approach, when a claim needs to be provably complete over all cases, when an 'obviously true' step has not been stress-tested, or when a derivation must survive citation by someone else."
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - hard problem
  - proof
  - counterexample
  - case analysis
  - edge cases
  - induction
  - invariant
  - extremal
  - pigeonhole
  - rigorous verification
  - mathematical
  - derivation
  - completeness
---
# Mathematical Problem-Solving Framework

## Purpose

Solve hard mathematical problems — IMO-level in difficulty, but the discipline
generalizes to any problem that demands a rigorous, fully-cased, verifiable answer.

The value is not the list of techniques. It is the **forcing order**: analyze, explore
small cases, form hypotheses, and only then commit to a strategy. Most failures on hard
problems are failures of *coverage*, not of cleverness — an approach that works on the
case you pictured, applied to a problem statement that quietly admitted more cases than
you pictured.

## Use when

- A problem resists the first obvious approach.
- A solution must be provably complete over all cases, not merely plausible.
- A claim is "obviously true" and has not been stress-tested.
- A derivation will be published, cited, or relied on by someone else.
- Numerical or structural work needs adversarial self-review before handoff.

## Procedure

### 1. Problem analysis

- Read the statement multiple times. Read it again after the first attempt.
- List all key information, constraints, and goals explicitly.
- Identify the mathematical domains involved (number theory, geometry, combinatorics,
  algebra, analysis).
- Identify **implicit assumptions or conditions** — these are where problems are lost.
- Consider the full range of possible inputs or scenarios the statement admits.

### 2. Initial exploration

- Visualize where applicable (draw diagrams for geometry; sketch the curve; plot the
  sequence).
- Consider special cases and simplified versions.
- Look for patterns and invariants.
- Test the conditions with simple examples, **including edge cases**.
- Actively seek counterexamples to your initial hypotheses.

### 3. Hypothesis formulation and verification

- Form initial hypotheses from the exploration.
- Rigorously test them — *especially* the ones that seem obvious. "Obvious" is the
  most reliable signal of an untested assumption.
- Use small, manageable examples to verify your thinking.
- When a hypothesis fails, analyze *why*. That reason is usually the key to the problem.

### 4. Strategy selection

Draw on the standard technique inventory:

- Proof by contradiction
- Induction (simple and strong)
- Pigeonhole principle
- Invariance, monovariance, and covariance
- Extremal principle
- Symmetry and transformation

Consider multiple approaches before committing to one. Match technique to the problem's
domain and structure rather than to your habits.

### 5. Comprehensive case analysis

Break the problem into **exhaustive, mutually exclusive** cases. Verify that the cases
cover the entire problem space, including edge cases.

For number-theoretic and real-analytic problems, run a sparse-priming pass over the
number universe before declaring the case split complete — the case you forgot is
usually a number type you did not think of:

- Natural numbers
- Integers (positive, negative, zero; odd, even; prime, composite; polygonal,
  Fibonacci, factorial, perfect)
- Rational numbers
- Real numbers (positive, negative, zero; odd, even)
- Irrational numbers
- Imaginary numbers (note: zero is both real and imaginary)
- Complex numbers
- Hypercomplex numbers
- p-adic numbers
- Algebraic numbers
- Transcendental numbers
- Trigonometric numbers
- Quadratic surds
- Constructible numbers
- Algebraic integers
- Non-standard numbers: transfinite, ordinal, cardinal, infinitesimal, hyperreal,
  surreal, fuzzy

Treat rational and irrational cases separately where it matters — the difference is
frequently the whole difficulty.

Analyze each case rigorously with the technique appropriate to it.

### 6. Solution development

- Build the solution step by step, justifying each move.
- Use clear, precise notation.
- Watch for classic pitfalls: division by zero, domain restrictions, and overlooked
  edge cases.
- Consider asymptotic behaviour of any sequences or functions involved.
- For real-valued problems, attend specifically to the rational/irrational split.

### 7. Proof construction

- Organize the argument logically and coherently.
- Use the appropriate proof technique (direct, contradiction, induction, construction).
- Ensure each step follows rigorously from the previous one.
- Be explicit about assumptions and about previously established results you invoke.
- For induction: check **all** base cases, and ensure the inductive step is
  comprehensive. A base case that was never verified is the most common silent failure.

### 8. Verification and refinement

- Check the solution against every constraint and condition in the statement.
- Confirm the proof covers every case identified in step 5.
- Test against varied examples, edge cases, and potential counterexamples.
- Look for simplifications or a more elegant reframing.
- Consider whether the result generalizes or implies something stronger.

### 9. Alternative approaches

- After a solution exists, consider whether other methods solve it.
- Compare approaches on elegance, generalizability, and insight — not only correctness.

### 10. Communication

- Present the solution clearly and concisely.
- Explain the key insights and the non-obvious steps.
- Use proper mathematical language and notation.
- Pair intuitive explanation with formal proof where the intuition carries the idea.

## Domain knowledge to activate

- **Number theory** — prime factorization, modular arithmetic, Diophantine equations,
  properties of rational and irrational numbers
- **Geometry** — circle theorems, similarity, transformations, coordinate and vector
  methods
- **Algebra** — polynomials, functional equations, inequalities, abstract structures
- **Combinatorics** — counting principles, graph theory, invariance, generating functions
- **Calculus** — limits, series, extrema, where applicable
- **Analysis** — properties of the reals, convergence, continuity

## Core strategies

- Look for invariants and monovariant quantities.
- Consider extreme cases; construct extremal examples.
- Break into exhaustive cases and solve each separately.
- Transform into an equivalent but more tractable form.
- Use algebraic manipulation to reveal hidden structure.
- Apply standard theorems creatively (CRT, Fermat's little theorem, …).
- Analyze asymptotic behaviour for large inputs.
- Separate rational and irrational cases when reals are involved.

## When stuck

Work the list in order; do not repeat the same attempt with more determination.

1. Restate the problem in different terms.
2. Solve a simpler related problem; try to generalize.
3. Look for analogies with known problems or results.
4. Ask what additional information would make it easy, then try to derive that
   information.
5. Re-examine your assumptions — check for overlooked possibilities.
6. Try to construct a counterexample to your current approach.

## Avoid

- Committing to a strategy before the case space is mapped.
- Treating an "obvious" step as verified.
- Declaring a case analysis complete without enumerating what a case even is.
- Confusing a solution that works on the general case with one that covers the edge
  cases.
- Reporting a result as established when a base case or boundary was never checked.

## Related skills

- `explore-and-falsify` — when the blocker is hypothesis diversity rather than proof
  discipline.
- `spr-mathematical-reasoning-models` — staged scaffolds for intuition, refutation, and
  generalization.
- `spr-ideation-toolkit` — when the search space itself needs widening.
- `epistemic-ledger` — when claims, evidence, and uncertainty must be recorded durably.

## Provenance

Adapted from *Enhanced Mathematical Problem-Solving Framework for IMO-style Problems*
(John Pellew, `~/Downloads/`). Converted to skill form; the phase order, technique
inventory, number taxonomy, and stuck-protocol are preserved from the source.
