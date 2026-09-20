---
name: spr-ideation-toolkit
title: "SPR Ideation Toolkit — Latent-Space Priming and Divergent Generation"
category: decision
description: "Widen the funnel before converging using nine sparse-priming tools: Latent Space Primer, Analogical Reasoner, Concept Hierarchizer, Context Expander, Multi-Modal Integrator, Temporal Knowledge Layerer, Concept Blender, Back Propagation, and SPR Graphing with proven/theoretical/abstract edge classes. Use when a problem is novel or open-ended, when the idea funnel is narrow, when creative cross-domain synthesis is needed, when an ensemble is converging on the same one or two options, or when a mission is still in framing and the frame itself is suspect."
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - ideation
  - brainstorm
  - creative
  - novel approach
  - divergent
  - sparse priming
  - latent space
  - cross-domain
  - concept blending
  - analogy
  - priming
  - widen the funnel
  - open-ended problem
  - design alternatives
  - lateral thinking
  - wild card
---
# SPR Ideation Toolkit

## Purpose

Widen the funnel **before** converging. Most unsolved problems are not unsolved for lack
of rigor — they are unsolved because the search space was entered too narrowly, and the
productive frame was never generated.

This toolkit applies Sparse Priming Representation (SPR) and latent-space priming to a
problem: it deliberately over-generates related, tangential, cross-domain, and apparently
irrelevant concepts, then wires them into a graph whose edge classes record how strong
each connection actually is. The output is a primed associative field that subsequent
problem-solving acts draw on.

## Use when

- The problem is novel, open-ended, or has resisted direct attack.
- The initial idea funnel is narrow.
- A creative synthesis is needed across domains.
- A team or agent ensemble is converging on the same one or two options.
- A long-horizon mission is still in framing and the frame itself is suspect.

## Pre-processing (applies to every tool)

Before running any tool below:

1. **Define the bracketed inputs.** Use semantic understanding to determine the values
   for the `[..]` inputs the tool requires. Choosing `[domain]` or `[root_concept]` well
   is most of the tool's value.
2. **Prime from context.** Use *all* prior information in the context window and
   memory for this problem, to maximize the latent-space priming available to
   subsequent solving.
3. **Do not over-constrain.** Reserved judgement belongs at evaluation time, not
   generation time.

## The tools

### Tool 1 — Latent Space Primer

- **Input:** `[problem_description]`, `[domain]`
- **Output:** `[domain]`, `[core_concept]`, `[tangentially_related_concept]`,
  `[cross_domain_connection]`, `[wild_card]`, `[synthesized_narrative]`, `[SPR1]`

Instructions:

1. Identify 5–10 core concepts directly related to `[problem_description]`.
2. For each `[core_concept]`, list 3–5 tangentially related concepts from the `[domain]`.
3. For each `[tangentially_related_concept]`, provide 2–3 concepts from *different*
   domains that share abstract similarities.
4. Generate 3–5 random "wild card" concepts that seem unrelated but might spark novel
   connections.
5. **Iterate to completeness.** Loop steps 1–4 until: every `[core_concept]` has had
   step 2 applied; every `[tangentially_related_concept]` has had all possible step-3
   connections identified; and every prior output has been examined against each
   `[wild_card]`. This iteration is essential — the first pass is not the output.
6. Synthesize a brief narrative loosely connecting all the concepts.
7. Create a Sparse Priming Representation `[SPR1]` of each output.
8. Build triplets (nodes and edges) from `[SPR1]` and render a Mermaid graph relating
   `[SPR1]` to `[problem_description]`.

### Tool 2 — Analogical Reasoner

- **Input:** `[source_problem]`, `[target_domain]`
- **Output:** `[fundamental_component]`, `[relationship]`, `[abstract_pattern]`,
  `[analogical_mapping]`, `[discrepancy]`, `[potential_insights]`, `[critical_eval]`,
  `[SPR2]`

Instructions:

1. Decompose `[source_problem]` into its fundamental components and relationships.
2. Identify abstract patterns or principles in the source.
3. Find analogous components or situations in the `[target_domain]`.
4. Map relationships from source to target, **noting discrepancies**.
5. Generate potential solutions or insights for the target from the mapping.
6. Evaluate the strengths and limitations of the analogy.
7. Create `[SPR2]` of each output.
8. Build triplets from `[SPR2]` and render a Mermaid graph relating `[SPR2]` to
   `[source_problem]`.

### Tool 3 — Concept Hierarchizer

- **Input:** `[root_concept]`, `[depth_level]`
- **Output:** hierarchical concept map — `[root_concept]`, `[depth_level]`, `[up_link]`,
  `[down_link]`, `[cross_link]`, `[link_justification]`

Instructions:

1. Place `[root_concept]` at the root of a hierarchical tree.
2. For each of 3–5 `[depth_level]`s:
   a. Identify broader categories the concept belongs to (moving up) — `[up_link]`.
   b. List sub-concepts or specific instances (moving down) — `[down_link]`.
   c. Note lateral connections to related concepts at the same level — `[cross_link]`.
3. At each node, give a brief justification of how it relates to its parent and
   children.
4. Identify cross-branch relationships or influences.
5. Create `[SPR3]` of each output.
6. Build triplets from `[SPR3]` and render a Mermaid graph relating `[SPR3]` to
   `[root_concept]`.

### Tool 4 — Context Expander

- **Input:** `[initial_context]`, `[expansion_rounds]`
- **Output:** `[expanded_context]`, `[influential_factors]`,
  `[revised_problem_assessment]`

For each expansion round:

1. Summarize the current context.
2. Identify the boundaries or limits of the current context.
3. List 3–5 factors just *outside* those boundaries that could be relevant —
   `[expanded_context]`.
4. For each factor, explain how it might influence or be influenced by the current
   context — `[influential_factors]`.
5. Select the most promising factor and integrate it into the context.
6. Reassess the problem with the expanded context — `[revised_problem_assessment]`.
7. Create `[SPR4]` of each output.
8. Build triplets from `[SPR4]` and render a Mermaid graph relating `[SPR4]` to the
   expansion round.

### Tool 5 — Multi-Modal Integrator

**Skip this tool if the problem has no multi-modal dimension.** Not all problems do.

- **Input:** `[concept1]`, `[available_modalities]`
- **Output:** `[MM_concept_description]`, `[CM_insight]`, `[novel_insight]`

Instructions:

1. For each modality (text, image, audio, …):
   a. Describe how `[concept1]` is represented or expressed in it.
   b. Identify unique aspects the modality highlights — `[unique_aspects]`.
2. Compare and contrast the concept's representation across modalities.
3. Identify conflicts and complementary insights between modalities.
4. Synthesize a holistic understanding integrating all modalities.
5. Propose how this understanding could lead to novel insights or applications.
6. Create `[SPR5]` of each output.
7. Build triplets from `[SPR5]` and render a Mermaid graph relating `[SPR5]` to
   `[concept1]`.

### Tool 6 — Temporal Knowledge Layerer

- **Input:** `[concept2]`, `[time_periods]`
- **Output:** `[temporal_evolution]`, `[key_trend]`, `[fwd_insight]`

For each period in `[time_periods]`:

1. Describe the state or understanding of `[concept2]` during that period.
2. Identify key factors or trends influencing its development or perception.
3. Note significant changes or pivotal events.
4. Compare with the previous period, highlighting the evolution.
5. Predict potential future developments from observed trends.

Then synthesize:

6. Build a timeline of the concept's evolution.
7. Identify overarching patterns or cycles.
8. Discuss how past understanding might inform current problems or future innovation.
9. Create `[SPR6]` of each output.
10. Build triplets from `[SPR6]` and render a Mermaid graph relating `[SPR6]` to
    `[concept2]`.

This tool is the natural companion to any forward-looking question, and to any claim of
the form "this trend will continue".

### Tool 7 — Concept Blender

- **Input:** `[concept_A]`, `[concept_B]`, `[problem_domain]`
- **Output:** `[hybrid_concept_description]`, `[potential_application]`,
  `[feasibility_assessment]`, `[overlapping]`, `[non_overlapping]`, `[unique]`

Instructions:

1. List 5–7 key attributes or principles of `[concept_A]`.
2. List 5–7 key attributes or principles of `[concept_B]`.
3. Build a Venn diagram identifying `[overlapping]` and `[unique]` attributes.
4. For `[non_overlapping]` attributes, explore how they might complement each other.
5. Generate 3–5 novel hybrid concepts combining elements of both.
6. **Iterate step 5 `n` times, where `n` is the number of novel concepts listed in
   step 5.** Iteration is what converts a list into a developed idea.
7. For each hybrid, describe potential applications or insights in `[problem_domain]`.
8. Evaluate feasibility and potential impact of each hybrid.
9. Create `[SPR7]` of each output.
10. Build triplets from `[SPR7]` and render a Mermaid graph relating `[SPR7]` to the
    `[concept_A]` + `[concept_B]` pair.

### Tool 8 — Back Propagation

Run this **after** the generation tools, over the collected `[SPR1]`…`[SPR7]`.

1. Sweep the `[SPRn]` sets produced by each tool process and check for completeness.
2. Where a later step generated an idea or concept that is missing from, or interesting
   for, an earlier stage — **add it back to that earlier stage and re-run that tool.**
3. Iterate this back-propagation until you reach the **Pareto line** for the task: the
   point where further iteration is no longer producing materially new connections.
4. Then proceed to the graph.

This is the step that makes the toolkit more than a list of prompts. Generation runs
forward; quality is recovered by propagating discoveries backward.

### Tool 9 — Graphing SPR

- **Input:** `[SPRn]`
- **Output:** Mermaid code visualising the nodes and edges found across the `[SPRn]`
  datasets

Instructions:

1. Aggregate every `[SPRn]` generated earlier in the thread into a single combined SPR
   `[SPRZ]`.
2. Use `[SPRZ]` to semantically define the appropriate nodes.
3. Review the potential relationships between each permutation of node pairs to
   identify edges. **Label every edge by the strength of the connection:**
   - `proven` — strong, well-understood connection
   - `theoretical` — conceptually linked
   - `abstract` — novel or very distant
4. Colour the edges by class: **`proven` = GREEN, `theoretical` = BLUE,
   `abstract` = PURPLE.**
5. Build triplets from the node set, the edge set, and the label and colour
   representation.
6. Write Mermaid code to visualise the triplets. **Attach the raw data underpinning each
   node to that node**, so the graph is searchable and studyable rather than merely
   drawable.

The edge classes are the epistemically important part of this tool: they record *how
much* a connection is being claimed, so a reader can tell an established relationship
from a speculative one at a glance.

> **Note on numbering.** The source document labels the tools inconsistently — the
> back-propagation step is called "Tool 7" and the graph step is labelled "Tool 8:" /
> "Tool9:", while the Concept Blender carries no number. Nine tools are described; this
> skill numbers them 1–9 in the order given, and keeps the `SPR1`…`SPR7` tags as the
> source uses them, since back-propagation is defined as operating over "the 7 tool
> processes".

## Where the yield actually comes from

Observed on a first real run of this toolkit (an open estimating problem, 18 candidate
approaches produced). Recorded because it should change how you budget effort across
the tools — treat it as guidance, not law:

- **The wild cards and Tool 4 produce nearly all the new material.** On that run, every
  genuinely new approach traced to a wild card, to Tool 4's boundary expansion, or to
  the point where the two met. The expansions that paid were the ones that attacked a
  boundary the original framing had *silently accepted* — "we may only use these three
  sources", "we only care about one year". Boundaries are often unchosen, and therefore
  unchallenged.
- **Tool 1's steps 1–3 mostly index what is already in the frame.** Core concepts,
  tangentials, and cross-domain links produced volume and little novelty; most
  cross-domain links generated no candidate approach. They are scaffolding for the later
  steps, not output.
- **Tool 1's step-5 iteration is where Tool 1 earns its place.** The first pass was
  close to a restatement; new material appeared when the prior outputs were swept
  against the wild cards. Skipping the iteration skips the only part that worked.
- **Step 7 (SPR formatting) and Tool 9 (the graph) added no ideas.** They are
  presentation. Pay for them when a reader needs the structure, not when you need the
  funnel.
- **The epistemic-discipline section below is load-bearing on a no-guessing engagement.**
  Without it the toolkit's own outputs drift toward the forbidden moves — extrapolating
  a ratio across a censored band, or imputing a gap. On a published-sources-only job,
  the guard is what makes the rest usable.

Practical consequence: if you have limited budget, run **Tool 4 first**, then the wild
cards, then Tool 1's iteration. That ordering front-loads the productive part.

## Epistemic discipline — read before use

**Every output of this toolkit is a hypothesis. None of it is evidence.**

These tools generate associations by design; association is not support. The graph's
`proven` / `theoretical` / `abstract` labels describe the *character of a proposed
connection*, not its verification status — an edge labelled `proven` means "this link is
well understood", not "this link has been checked against a source in this problem".

Therefore:

- Do **not** promote an output into a claim, figure, citation, or recommendation without
  independent verification.
- Do **not** let a primed concept become a premise. `explore-and-falsify` is the correct
  next step for anything the priming surfaced.
- When the toolkit produces a lead that will be acted on, record it in the
  `epistemic-ledger` with its provenance as *generated*, not *sourced*.
- In a mission with a no-guessing constraint, this toolkit is a **source of questions**,
  never a source of answers.

This is the difference between a wider funnel and a contaminated one: the priming is
allowed to be wild precisely because nothing from it is trusted until verified.

## Avoid

- Skipping the pre-processing step — running the tools on an undefined `[domain]`
  produces generic output.
- Running one pass and stopping. Tools 1, 7, and 8 are explicitly iterative; the first
  pass is seed material.
- Treating the wild-card concepts as noise and pruning them early. They are the point.
- Drawing the graph before back-propagation has run — it will be a picture of the first
  pass only.
- Omitting edge classes, which makes a speculative graph look like an established one.
- Mistaking volume of generated concepts for progress on the problem.

## Related skills

- `explore-and-falsify` — discriminate the hypotheses this toolkit generates.
- `mathematical-problem-solving-framework` — coverage-first rigor, once the frame is set.
- `spr-mathematical-reasoning-models` — staged scaffolds to run over the primed field.
- `long-horizon-mission` — when ideation belongs to a larger continuity-spanning effort.
- `epistemic-ledger` — durable provenance for anything the priming surfaces.

## Provenance

Adapted from *SPR Tools for Ideation* (John Pellew, `~/Downloads/`). All nine tools,
their inputs, outputs, and instruction steps — including the completeness loops, the
multi-modal skip condition, the Pareto-line stopping rule, and the edge-class
colour scheme — are preserved from the source.

Two sections are additions, not source material: the **epistemic-discipline** section,
which binds this generative toolkit to the existing verification discipline, and the
**where the yield actually comes from** section, which records what a first real run
produced. Both are marked here so they can be revised or removed on further evidence.
