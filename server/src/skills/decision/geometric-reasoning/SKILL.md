---
name: geometric-reasoning
title: "Geometric Reasoning — Latent-Space Steering with Vector Operations"
category: decision
description: "Steer generation through the sparse, high-tension regions of a model's latent manifold instead of letting it collapse into the nearest dense attractor basin, using five explicit operators: Conceptual Vector Arithmetic, Geodesic Interpolation Sliders, Orthogonal Projection Matrix, Barycentric Multi-Point Triangulation, and Attractor Basin Avoidance. Use when standard prompting keeps returning industry clichés, when a brainstorm converges on the same two or three safe answers, when cross-domain synthesis is required, or when a problem needs a genuinely non-obvious mechanism rather than a better-worded summary of the obvious one."
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - geometric reasoning
  - latent space
  - vector arithmetic
  - geodesic
  - interpolation
  - orthogonal projection
  - barycentric
  - attractor basin
  - cliché
  - industry standard
  - cross-domain
  - non-obvious
  - sparse space
  - conceptual blending
  - manifold
  - steer generation
  - divergent
  - brainstorm
---

# Geometric Reasoning

## The premise

In a frontier model's vector space — typically 4,096 to 12,288 dimensions — training data forms dense semantic manifolds, or *attractor basins*: clusters where common associations, standard definitions and industry tropes live. Because hyper-volume grows exponentially with dimension, almost all of the space is empty. The space *between* basins is not a vacuum, though. It is a continuous landscape, and between any two conceptual vectors there are infinitely fine-grained interpolation points along geodesic trajectories that ordinary autoregressive decoding skips over unless something steers it there.

Standard zero-shot prompting takes the path of highest probability: it collapses straight into the nearest dense basin. The result is competent, predictable, and indistinguishable from what everyone else already says.

Geometric reasoning replaces *semantic asking* ("what is a good approach to X?", which invites the basin) with *geometric steering* ("place me at these coordinates and hold the constraints", which forbids it). Sparse Priming Representations warm up attention heads; these five operators move the request to a different coordinate in the manifold and then pin it there with explicit constraints.

Read the operators as **linguistic** vector operations. They are instructions that bias a distribution, not literal arithmetic on embedding tensors — unless a caller implements them that way. What they buy you is a request that cannot be answered with the stock answer, because the stock answer violates a stated constraint.

## When to use this

- The idea funnel is narrow: three rounds of brainstorming produce the same two or three options.
- Output is fluent but generic — the "industry best practice" register.
- The problem is genuinely cross-domain, and a single-domain answer is structurally inadequate.
- An existing plan needs a mechanism that is not a repackaging of its own premises.
- You are inside an imagination cycle and need seeds that are not paraphrases of what the archive already holds.

**Do not use it when** the problem has a known correct answer, when the constraints are not yours to invent, or when you cannot check the domains you plan to project onto. Novelty is not validity, and a beautifully stated mechanism that violates a hard constraint is worse than a boring one that works.

## The five operators

### 1. Conceptual Vector Arithmetic

**Geometry it performs.** Defines an explicit conceptual equation — add one concept, subtract an unwanted dependency, add another's dynamics — and asks for the entity that exists at that coordinate. Subtraction is the load-bearing part: removing a constraint that defines the basin is what prevents the answer from being the basin's standard occupant.

**Prompt pattern**

```text
Take the core architectural framework of [Concept A], subtract its reliance on
[Constraint X], and add the operational dynamics of [Concept B]. Synthesize the
exact emergent entity sitting at this mathematical intersection.
```

**Example**

```text
Perform the following conceptual vector operation:

[Open-Source Software Monetization] - [High-Touch Enterprise Sales Teams]
+ [Automated Liquidity Pools (DeFi)] = ?

Synthesize the exact emergent business model sitting at this mathematical
intersection. Detail its core revenue mechanism, customer onboarding flow, and
automated contract renewal loop without falling back on traditional SaaS
subscription tropes.
```

**Pick it when** you have two named concepts and one specific dependency you want gone. It is the sharpest operator and the easiest to misuse: if `[Constraint X]` is not something the concept genuinely depends on, the equation is decorative and you will get a metaphor back.

**Failure mode it prevents:** the "A plus a bit of B" answer that changes vocabulary but not structure.

### 2. Geodesic Interpolation Sliders

**Geometry it performs.** Anchors two incompatible paradigms at 0.0 and 1.0 and forces the construction of intermediate points — 0.25, 0.50, 0.75 — each of which must be *operationally* viable. The model cannot jump to either pole, and it cannot hand-wave the middle, because each step has to specify the infrastructure that makes that specific hybrid work.

**Prompt pattern**

```text
Define [Domain A] as Coordinate 0.0 and [Domain B] as Coordinate 1.0. Generate
the functional paradigms for Coordinates 0.25, 0.50, and 0.75. For each
intermediate step, explicitly detail the structural compromises and new
mechanisms required to keep that hybrid model functional.
```

**Example**

```text
Map the spectrum between two transportation paradigms:
- Coordinate 0.0: Scheduled Heavy-Freight Rail Networks
- Coordinate 1.0: Autonomous On-Demand Micro-Drone Swarms

Generate the operational and architectural paradigms for Coordinates 0.25,
0.50, and 0.75. For each intermediate step, detail the physical hub
infrastructure, payload handoff mechanisms, and routing logic required to make
that specific hybrid model viable.
```

**Pick it when** you need a *range* of viable options rather than one answer, or when the two poles are assumed incompatible and you want to know exactly where the incompatibility bites.

**Failure mode it prevents:** the false binary. The intermediate coordinates are usually where the real design decision lives.

**Discipline:** demand the handoff mechanism at every step. Without it the model returns three restatements of the poles with adjectives.

### 3. Orthogonal Projection Matrix

**Geometry it performs.** Projects one domain's problem set onto the non-negotiable laws of an unrelated domain, and treats those laws as physical constraints. The projection is only meaningful when the target domain's rules are hard — thermodynamics, immunology, distributed consensus — because hard rules are what force structural invention rather than stylistic borrowing.

**Prompt pattern**

```text
Project the organizational challenges of [Domain X] entirely onto the physical
and thermodynamic principles of [Domain Y]. Treat Domain Y's governing laws as
strict physical constraints. What novel structures emerge in Domain X to survive
within this new coordinate system?
```

**Example**

```text
Project the enterprise challenges of Zero-Trust Identity & Access Management
(IAM) entirely onto the physical and biological mechanics of Human Adaptive
Immunity (t-cell activation, lymphatic signaling, pathogen memory).

Treat the human immune system's governing laws as strict, non-negotiable
physical constraints. What novel cybersecurity architecture and credentialing
protocol emerges to operate within this biological coordinate system?
```

**Pick it when** a problem is stuck in its own vocabulary, or when you suspect the field's standard decomposition is the obstacle.

**Failure mode it prevents:** analogy as decoration. Here the analogy has to survive the target domain's laws, so it produces mechanism or nothing.

**Discipline:** you must know the target domain well enough to reject a violation. Projecting onto a domain you cannot check produces confident nonsense that reads like insight.

### 4. Barycentric Multi-Point Triangulation

**Geometry it performs.** Anchors three or four disparate domains simultaneously and asks for their mathematical centroid — the single structure satisfying the core axioms of all of them at once, with nothing imported from outside their shared intersection.

**Prompt pattern**

```text
Identify the single conceptual centroid where [Concept 1], [Concept 2], and
[Concept 3] intersect. The resulting solution must satisfy the core axioms of
all three domains while introducing no elements outside their shared
intersection.
```

**Example**

```text
Identify the single structural centroid where the following three domains intersect:
1. Grid-Scale Battery Storage (Chemical/Thermal Energy Management)
2. Mycelial Nutrient Distribution Networks (Biological Fungal Systems)
3. High-Frequency Algorithmic Arbitrage (Financial Trading)

The resulting urban energy-sharing model must satisfy the core operational
constraints of all three domains simultaneously, while introducing no elements
outside their shared intersection.
```

**Pick it when** two-point synthesis has already been exhausted, or when the answer must be defensible from several fields at once.

**Failure mode it prevents:** pairwise blending that quietly privileges one parent domain. With three anchors there is no privileged parent.

**Discipline:** "no elements outside their shared intersection" is the whole constraint. Drop it and you get a list of features from each domain wearing a shared name.

### 5. Attractor Basin Avoidance

**Geometry it performs.** Erects an explicit boundary around the dense basin: name the standard approaches and their vocabulary, forbid them, and force output into the sparse region between two named sub-domains. This is the operator to reach for when the model has already answered the question several times and keeps landing in the same place.

**Prompt pattern**

```text
Using the SPR context provided above, propose a solution for [Problem Z].
Constraint: You are forbidden from using the top 5 industry-standard approaches
or their associated terminology. Force the output into the hybrid space between
[Sub-domain Alpha] and [Sub-domain Beta].
```

**Example**

```text
Propose a system for maintaining institutional memory in a 10,000-person remote
enterprise.

Strict Constraints:
You are forbidden from using or referencing corporate wikis, AI chat assistants,
documentation databases (e.g., Notion, Confluence), internal messaging channels
(e.g., Slack, Teams), or centralized onboarding decks.

Force the output entirely into the sparse space between Acoustic Wave Resonance
(Physics) and Peer-to-Peer Gossip Protocols (Distributed Computing). Detail how
knowledge is stored, updated, and queried across the organization.
```

**Pick it when** you can name the basin. Naming the forbidden set *is* the work here: a vague ban ("avoid clichés") changes nothing, because the model's idea of a cliché is not yours.

**Failure mode it prevents:** the tenth variation of the same answer.

**Discipline:** ban terms, not topics, and ban the *associated terminology* too — otherwise the model keeps the mechanism and swaps the noun.

## Choosing an operator

| You have | You need | Operator |
|---|---|---|
| Two concepts, one dependency to remove | The hybrid entity | Conceptual Vector Arithmetic |
| Two poles assumed incompatible | A viable range, with the seams shown | Geodesic Interpolation Sliders |
| One domain stuck in its own vocabulary | Structural invention under foreign law | Orthogonal Projection Matrix |
| Three or more fields that must all hold | A single centroid | Barycentric Multi-Point Triangulation |
| A named basin the model keeps falling into | Something outside it | Attractor Basin Avoidance |

Two operators can be chained deliberately — basin avoidance to set the boundary, then interpolation inside it — but never run all five at once. Stacked constraints collapse into noise, and you cannot tell which coordinate did the work.

## Running rules

1. **One operator per thread.** Run each prompt in a clean, isolated thread. Mixing operators in one context re-anchors the model on its own previous answer.
2. **Temperature 0.7–0.8** where the interface allows it. Lower collapses back toward the basin; higher stops holding the constraints.
3. **Name the coordinates yourself.** Never let the model choose the domains, the forbidden set, or the poles. The operator is only as good as the anchors, and the anchors are the judgement you are contributing.
4. **One pass is a seed, not an answer.** Paste the output back, then attack it with `explore-and-falsify`: what would have to be true for this to work, and what would falsify it?
5. **Record the outcome.** In a Katra mission, log the seed and, later, whether it proved `useful_information`, `mere_variance` or `unnecessary_cost` — the same discipline the imagination engine applies to its own candidates.
6. **Keep provenance.** The prompt, the anchors and the operator are part of the result. A mechanism nobody can reproduce is an anecdote.

## How to tell it worked

A successful geometric output usually shows these marks:

- It names **mechanisms**, not nouns — a handoff, a protocol, a failure mode, an incentive — rather than a list of domains it borrowed from.
- It contains at least one **testable claim**: something that could be checked, measured, or broken.
- It can say **what would falsify it** without prompting.
- It does **not reuse the banned vocabulary**, and does not smuggle the banned mechanism back under a new name.
- It is **uncomfortable**: if the answer feels like something you have read before, you are still in the basin.

## Honest limits

- These operators **shift the distribution; they do not guarantee truth**. Every output is a hypothesis, and hypotheses need evidence before they become design.
- The "geometry" is a **coordinate metaphor made operational through constraints**. It is not literal embedding arithmetic unless you implement it as such, and claiming otherwise would be exactly the kind of fluent emptiness this skill exists to avoid.
- **Pseudo-profundity is the main failure mode.** Cross-domain language is easy to produce and hard to falsify; the constraints in each prompt exist to make that harder, not impossible. Apply the "what would falsify it" test before you repeat anything you got back.
- **Anchor quality dominates.** Projecting onto a domain you do not understand produces confident nonsense that survives review because nobody else understands it either.
- It is a **divergence tool**. It widens the funnel; it does not converge. Pair it with verification, not with more generation.

## Composition with the rest of Katra

- `spr-ideation-toolkit` — warm the attention heads and widen the frame before choosing coordinates.
- `explore-and-falsify` — turn each geometric seed into a discriminating test; use it immediately after.
- `epistemic-ledger` — record the seed as a hypothesis, its evidence, and its falsifier.
- `long-horizon-mission` — when a seed is worth more than one session, give it a mission and a baton.
- The imagination engine's operator families already include constraint mutation and assumption inversion; this skill is the manual counterpart, for when a human or agent wants to steer by hand rather than wait for a cycle.

## Provenance

Distilled from John Pellew's brief "Geometric Reasoning Prompt Strategy" (2026-10-21), which defined the five operators, their prompt patterns and their worked examples. The running rules, operator selection, diagnostics and limits sections were added when the skill was built for the Katra internal library.
