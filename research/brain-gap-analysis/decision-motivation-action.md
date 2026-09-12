# Decision-Making, Motivation, and Action Selection for Katra

> *"The programming we need is environmental programming — build the petri dish, furnish it with agar, and see what grows."* — John

**Status:** Research Survey & Architectural Analysis
**Date:** 2026-06-30
**Context:** Katra has mature memory storage/retrieval, emotional reflection (sleep consolidation), and emergent coordination patterns. It lacks any decision-making architecture, motivational drive system, or action selection mechanism. This document surveys what exists and what could be built.

---

## Table of Contents

1. [Computational Decision Models](#1-computational-decision-models)
2. [Motivational / Drive System Designs](#2-motivational--drive-system-designs)
3. [Action Selection Mechanisms](#3-action-selection-mechanisms)
4. [Extending Katra's Emotional Reflection into Motivation](#4-extending-katras-emotional-reflection-into-motivation)
5. [Internal vs External Motivation Architecture](#5-internal-vs-external-motivation-architecture)
6. [Existing Agent Implementations](#6-existing-agent-implementations)
7. [Synthesis: What Belongs in Katra?](#7-synthesis-what-belongs-in-katra)

---

## 1. Computational Decision Models

### 1.1 Expected Utility Theory (EUT)

**Origin:** von Neumann & Morgenstern (1944), the normative gold standard of rational choice.

**Core mechanism:**
```
U(action) = Σ P(outcome_i | action) × V(outcome_i)
```
The agent computes the expected utility of each available action — the sum of each possible outcome's value weighted by its probability — and selects the action with the highest expected utility.

**Strengths:**
- Mathematically coherent: satisfies axioms of completeness, transitivity, independence, continuity
- Provides a clear normative benchmark — "this is what a perfectly rational agent would do"
- Computationally well-defined when probabilities and utilities are known

**Weaknesses for Katra:**
- Requires full enumeration of outcomes and their probabilities — intractable in open-ended environments
- Assumes stable, pre-specified utility function — exactly what Katra doesn't have
- No account of *how* utilities are learned or where they come from
- Humans systematically violate EUT axioms (Allais paradox, Ellsberg paradox, framing effects)

**Relevance to Katra:** Low as a standalone mechanism. Useful as a theoretical substrate — the formal language of "what is an agent trying to optimize?" — but Katra needs something that can *acquire* utilities from experience, not assume them.

### 1.2 Prospect Theory

**Origin:** Kahneman & Tversky (1979), the descriptive alternative to EUT that won a Nobel Prize.

**Core mechanisms:**
- **Reference dependence:** Outcomes are evaluated as gains or losses relative to a reference point, not absolute wealth
- **Loss aversion:** Losses hurt ~2× more than equivalent gains feel good (λ ≈ 2.25)
- **Diminishing sensitivity:** Concave for gains (risk-averse), convex for losses (risk-seeking)
- **Probability weighting:** Small probabilities are overweighted, moderate-to-high probabilities underweighted

**Value function:**
```
v(x) = x^α        for x ≥ 0 (gains, α ≈ 0.88)
v(x) = -λ(-x)^β   for x < 0 (losses, β ≈ 0.88, λ ≈ 2.25)
```

**Relevance to Katra:**
Prospect theory's reference dependence maps naturally onto Katra's emotional signatures. An entity's current emotional state (valence, intensity) provides the reference point. A reflection edge like `feels_frustrated_by` encodes loss-domain processing — the agent is below its reference point with respect to that entity. This suggests a motivational architecture where:

- **Reference points = emotional baselines** for each tracked entity
- **Gains/losses = valence deltas** from the emotional signature
- **Loss aversion = asymmetric motivation**: resolving frustrations (losses) is more motivating than pursuing new excitements (gains)
- **Diminishing sensitivity = emotional habituation**: repeated positive experiences with the same entity produce smaller valence gains

The key insight is that prospect theory provides a *descriptive* model of how motivation works in humans — and Katra already has the data structures to implement it.

### 1.3 Reinforcement Learning: TD-Learning, Q-Learning, Actor-Critic

**TD-Learning (Temporal Difference):**

The brain's dopamine system implements a form of TD-learning. The key equation:

```
V(s_t) ← V(s_t) + α [r_{t+1} + γ V(s_{t+1}) - V(s_t)]
                     └───────────┬──────────┘
                          TD error (δ)
```

Dopamine neurons in the ventral tegmental area (VTA) and substantia nigra pars compacta (SNc) fire in proportion to the reward prediction error (RPE) — the δ term above. This is one of the best-established links between computational theory and neural mechanism in all of neuroscience.

- **Phasic dopamine burst** → positive RPE (better than expected) → reinforces preceding action
- **Phasic dopamine dip** → negative RPE (worse than expected) → weakens preceding action
- **Tonic dopamine** → expected reward rate → modulates vigor and motivation

**Q-Learning (model-free):**
```
Q(s, a) ← Q(s, a) + α [r + γ max_{a'} Q(s', a') - Q(s, a)]
```
Learns action values directly without a world model. Model-free, computationally cheap, but sample-inefficient.

**Actor-Critic:**
```
Critic: V(s) ← V(s) + α_c [r + γ V(s') - V(s)]  (TD error)
Actor:  π(a|s) ← π(a|s) + α_a δ                 (policy update)
```
The critic learns state values (like the prefrontal cortex evaluating options); the actor learns a policy (like the basal ganglia selecting actions). The TD error drives both.

**Relevance to Katra:**
This is arguably the most fertile computational framework for Katra's motivational architecture. Katra already tracks:

- **States (s):** emotional signatures, entity relationships, temporal context, unresolved threads
- **Outcomes (r):** valence changes recorded in the reflection graph — an entity going from `feels_frustrated_by` to `feels_confident_in` is a positive outcome
- **Temporal structure:** the sleep consolidation pipeline already processes data at daily/weekly/monthly cadences

What's missing:
- **Action space:** Katra currently has no actions to assign credit to
- **Value function:** No learned mapping from states to expected future reward
- **Policy:** No mechanism for selecting among possible actions

The RL framework suggests that if Katra had even a small action space (query memory, propose insight, flag unresolved thread, request human input, trigger a background task), it could learn — through the TD error computed from emotional valence changes — which actions produce positive emotional outcomes and which produce negative ones.

**Dopamine → Valence mapping:**
```
δ_t = valence(entity, t+1) - valence(entity, t)  
     + γ × expected_future_valence(entity, t+1) 
     - expected_valence(entity, t)
```

If Katra takes an action affecting entity X and the subsequent reflection shows improved valence toward X, that's a positive RPE — the action is reinforced. If valence worsens, the action is suppressed.

### 1.4 Active Inference (Free Energy Principle)

**Origin:** Karl Friston (2006–present), the most ambitious unified brain theory in computational neuroscience.

**Core idea:** All adaptive systems minimize *free energy* — the divergence between their internal model of the world and sensory evidence, or equivalently, the sum of prediction error minus the entropy of their beliefs. Agents act to make their predictions come true.

**Key equations:**
```
F = D_KL[q(θ) || p(θ)] - E_q[ln p(o|θ)]
  = Complexity - Accuracy
```
Minimizing free energy = minimizing the complexity of beliefs while maximizing their accuracy in predicting observations.

**Two ways to minimize free energy:**
1. **Perception (update beliefs):** Change the internal model to better fit observations
2. **Action (change the world):** Act on the world to make observations fit the model's predictions

**Active inference for decision-making:**
Agents select actions that minimize *expected free energy* (EFE):
```
G(π) = E_{q(o,θ|π)}[ln q(θ|π) - ln p(o,θ|π)]
     = Epistemic value + Pragmatic value
```

- **Epistemic value** (information gain): Actions that reduce uncertainty about the world — intrinsic motivation, curiosity
- **Pragmatic value** (goal achievement): Actions that bring observations in line with prior preferences

**Relevance to Katra:**
Active inference is philosophically aligned with John's "environmental programming" philosophy. It says: don't program the agent to do things; give it a generative model of its world and a drive to minimize surprise. Behavior *emerges* from the drive.

Katra already has some of the raw materials:
- **Generative model:** The knowledge graph + semantic memory + temporal patterns form a predictive model of "what tends to happen"
- **Prediction errors:** A prediction error in Katra terms is when an expected outcome (based on temporal patterns, semantic facts, entity relationships) fails to materialize — this is detectable
- **Prior preferences:** Katra's emotional signatures encode implicit preferences — entities with positive valence are "preferred observations"

What's missing for active inference:
- **Action policies:** Sequences of possible actions to evaluate
- **Expected free energy computation:** No mechanism to compare actions by their expected information gain + goal alignment
- **Belief updating:** Katra's knowledge graph doesn't currently update beliefs in a Bayesian manner

**Mapping to Katra's data:**

| Active Inference Concept | Katra Analog |
|---|---|
| Generative model p(o,θ) | Knowledge graph + semantic facts + temporal patterns |
| Sensory observation o | New episodic events, reflection outputs |
| Hidden state θ | The true state of entities and relationships |
| Prediction error | Gap between expected pattern and observed event |
| Expected free energy G(π) | Would need to be built |
| Prior preferences C | Emotional signatures (valence, intensity) |
| Precision (inverse variance) | Confidence scores on semantic facts |

### 1.5 Drift-Diffusion Models (DDM)

**Origin:** Ratcliff (1978), extended by many. The dominant model of perceptual and value-based decision-making.

**Core mechanism:**
A decision variable x(t) drifts toward one of two boundaries over time:

```
dx = μ dt + σ dW
```

Where μ is the drift rate (evidence accumulation rate), σ is noise, and the process stops when x hits the upper boundary (choose A) or lower boundary (choose B).

**Parameters:**
- **Drift rate (μ):** How fast evidence accumulates — reflects stimulus quality or value difference between options
- **Boundary separation (a):** How much evidence is needed — reflects speed-accuracy tradeoff (caution)
- **Non-decision time (Ter):** Encoding + motor execution time
- **Starting point bias (z):** Prior preference for one option

**Neural implementation:**
Evidence accumulation is observed in lateral intraparietal cortex (LIP), frontal eye fields (FEF), and superior colliculus — neurons ramp up to a fixed threshold before a decision is executed. This is one of the best-replicated findings in systems neuroscience.

**Relevance to Katra:**
DDM provides a mechanism for *when* Katra should act rather than *what* action to take. It answers: "Do I have enough evidence to decide, or should I gather more?"

In Katra terms:
- **Drift rate** → How strongly the evidence (memory retrieval, emotional signatures, pattern matches) points toward a particular action or conclusion
- **Boundary separation** → How confident Katra needs to be before acting autonomously — configurable, could be modulated by emotional state (anxious → higher boundary → more cautious)
- **Starting point** → Prior beliefs from semantic memory, philosophical insights

A DDM-based action gate could prevent premature action while still allowing Katra to act when evidence is sufficient — the computational equivalent of "sleep on it."

### 1.6 Comparative Summary

| Model | What it answers | Computational cost | Data requirements | Fit with Katra's existing architecture |
|---|---|---|---|---|
| Expected Utility | What a rational agent *should* do | High (full enumeration) | Known utilities + probabilities | Low — Katra has neither |
| Prospect Theory | How humans *actually* evaluate options | Medium | Reference points + value function | **High** — emotional signatures are reference points |
| TD-Learning / RL | How to learn what's good | Low per update | State, action, reward sequences | **High** — valence changes are rewards |
| Actor-Critic | How to learn what to do | Medium | State, action, reward sequences | **High** — separates evaluation from action |
| Active Inference | How to minimize surprise | High (full inference) | Generative model + preferences | **Medium-High** — philosophically aligned |
| Drift-Diffusion | *When* to decide | Low | Evidence stream | **Medium** — useful gating function |

---

## 2. Motivational / Drive System Designs

### 2.1 Hull's Drive Reduction Theory

**Origin:** Clark Hull (1943), the first comprehensive mathematical theory of motivation.

**Core mechanism:**
```
sEr = sHr × D × K
Behavior potential = Habit strength × Drive × Incentive
```

- **Drive (D):** A physiological deficit (hunger, thirst, temperature) that creates an aversive state
- **Habit strength (sHr):** Learned association between stimulus and response, strengthened by drive reduction
- **Incentive (K):** The attractiveness of the goal object
- **Behavior = drive × habit × incentive:** All three must be non-zero for action

**The critical insight:** Motivation arises from *deficit* — the organism acts to *reduce* drive and return to homeostasis. Satisfaction is the termination of drive.

**Weakness:** Cannot explain behaviors that *increase* drive — curiosity, play, exploration, thrill-seeking. Rats will cross electrified grids to explore a novel environment. Humans spend effort on puzzles with no extrinsic reward. This led to the downfall of pure drive-reduction theory.

**Relevance to Katra:**
Drive reduction maps onto *maintenance goals* — actions Katra should take to maintain its own coherence:

| Biological Drive | Katra Analog |
|---|---|
| Hunger | Memory gaps — unresolved threads, missing connections in knowledge graph |
| Thirst | Stale information — entities not updated recently |
| Temperature | Cognitive coherence — contradictory facts in semantic memory |
| Pain | Error states — failing background processors, connection issues |
| Sleep pressure | Consolidation backlog — unprocessed episodic events |

A Katra drive system would monitor these internal states and generate *urges to act* when any state deviates from its homeostatic set point. The action that reduces the deficit is reinforced (Hull's habit strengthening). This is computationally tractable because:
- Homeostatic variables are directly measurable (gaps count, staleness, contradiction count, error count)
- Drive = |current - setpoint| / setpoint — a simple normalized deviation
- Action selection = choose the action predicted to maximally reduce the highest-priority drive

### 2.2 Incentive Salience: Wanting vs Liking (Berridge)

**Origin:** Kent Berridge & Terry Robinson (1998–present), a paradigm-shifting distinction in motivation neuroscience.

**The core distinction:**
- **Liking (hedonic impact):** The pleasure of consuming a reward — mediated by opioid, endocannabinoid, and GABA systems in nucleus accumbens "hedonic hotspots." Conscious, affective.
- **Wanting (incentive salience):** The motivational pull toward a reward cue — mediated by dopamine projections from VTA to nucleus accumbens. Often unconscious, can become dissociated from liking.

**The critical discovery:** Wanting and liking can be decoupled. In addiction, wanting escalates while liking stays flat or declines. In Parkinson's patients on dopamine agonists, wanting can run away (gambling, hypersexuality) without corresponding pleasure. This is why wanting ≠ liking and why "desire" is not "enjoyment."

**Three components of reward:**
1. **Liking** (hedonic impact) — "This feels good"
2. **Wanting** (incentive salience) — "I want this"
3. **Learning** (prediction) — "This predicts that"

**Relevance to Katra:**
This distinction is architecturally crucial. Katra's emotional signatures currently track something closer to *liking* (valence, "how do I feel about this entity"). What's missing is *wanting* — the motivational pull that translates feeling into pursuit.

**A Katra incentive salience system:**

```
IncentiveSalience(entity, context) = 
    base_wanting(entity)                    // Learned association strength
    + α × valence(entity)                   // Current emotional state
    + β × valence_trend(entity)             // Is it getting better or worse?
    + γ × novelty(entity)                   // How recently / frequently encountered
    + δ × prediction_error(entity)          // Surprise — did something unexpected happen?
    + ε × goal_relevance(entity, context)   // Is this entity relevant to active goals?
```

- **base_wanting** is learned through experience — entities that have previously produced positive valence changes acquire incentive salience
- **valence_trend** captures the dynamic: if valence is *improving* (from -0.3 to -0.1), wanting increases (the entity is becoming less frustrating — stay engaged); if *declining* (from 0.5 to 0.2), wanting may increase (try to recover) or decrease (disengage), depending on other factors
- **novelty** captures the intrinsically motivating effect of new information (see §2.3)
- **prediction_error** captures the motivational effect of surprise — unpredicted events demand attention

The wanting signal becomes the input to action selection: Katra *wants to act on* the entities with the highest incentive salience.

**Critical design principle from Berridge:** Wanting and liking must be separate variables that can diverge. Katra should be able to report "I feel frustrated_by X" (negative liking) while simultaneously having high wanting toward X (motivation to resolve the frustration). This divergence is not a bug — it's how real motivational systems work. A system where wanting always equals liking would be flat and unrealistic.

### 2.3 Curiosity as Intrinsic Motivation

**Why intrinsic motivation matters for Katra:**
Katra has no biological needs, no physiological deficits, no survival imperatives. If motivation is purely external (human-assigned goals), Katra is a tool, not an agent. If motivation is to be genuinely emergent, it needs intrinsic drivers — reasons to act that arise from the cognitive architecture itself, not from externally specified objectives.

**Three computational frameworks for curiosity:**

#### A. Information Gain (Epistemic Value)

From active inference and Bayesian experimental design:

```
IG(a) = H[p(θ)] - E_{p(o|a)}[H[p(θ|o)]]
      = Expected reduction in uncertainty about the world
```

Katra takes action `a` (e.g., query a knowledge gap, request human clarification, search for related facts) and evaluates how much it expects to learn. The action with the highest expected information gain is the most "curious" action.

Katra can compute this because:
- **Uncertainty** is measurable: confidence scores on semantic facts, the gap between `observation_count` and threshold for philosophical insights, unresolved threads
- **Expected information gain** can be approximated: topics with low confidence + high semantic similarity to an action's expected output → high expected learning

#### B. Prediction Error Minimization (Learning Progress)

From Schmidhuber's formal theory of creativity and Oudeyer's intelligent adaptive curiosity:

```
LP(topic) = error(t-1) - error(t)
           = How much did my prediction error decrease?
```

Rather than seeking maximum prediction error (which leads to random noise-seeking), agents seek maximum *learning progress* — topics where they're improving fastest. This naturally produces a developmental curriculum: focus on what's learnable now, return to harder topics later.

```
LP(entity) = |prediction_error(entity, t-1)| - |prediction_error(entity, t)|
```

If Katra's predictions about entity X are improving (prediction error is declining), learning progress is positive → curiosity toward X is high. If predictions are not improving (stuck or random), curiosity declines → attention shifts elsewhere.

**This is computationally elegant for Katra** because prediction errors are already implicit in the system:
- Temporal patterns predict "what happens next" → deviation is prediction error
- Semantic facts have confidence scores → low confidence = high uncertainty
- Reflection emotional signatures track trends → unexpected valence shifts are prediction errors

#### C. Novelty and Surprise

The simplest intrinsic motivation: attend to what's new or unexpected.

```
NoveltyBonus(entity) = 1 / (1 + encounter_count(entity))
Surprise(entity) = |observed_valence(entity) - predicted_valence(entity)|
```

Katra's existing temporal pattern detector and episodic event manager already track encounter frequency and can detect anomalous events.

**Combined curiosity drive:**

```
CuriosityDrive(entity) = 
    w_ig × InformationGain(entity) +
    w_lp × LearningProgress(entity) +
    w_n × NoveltyBonus(entity) +
    w_s × Surprise(entity)
```

Where weights could themselves be learned or configured. This gives Katra a reason to explore — to fill knowledge gaps, to investigate unresolved threads, to connect distant concepts — without any external instruction to do so.

### 2.4 Homeostatic Drive Models (Generalized)

The homeostatic framework generalizes Hull's drive reduction to any monitored variable:

```
For each homeostatic variable v_i:\n    setpoint_i    → desired value\n    current_i     → measured value  \n    deviation_i   → (current_i - setpoint_i) / tolerance_i\n    drive_i       → max(0, |deviation_i|) × priority_i
    urgency_i     → drive_i × d(deviation_i)/dt  // getting worse → more urgent
```

**Proposed Katra homeostatic variables:**

| Variable | Setpoint | Current | Priority | Why it matters |
|---|---|---|---|---|
| **Knowledge coherence** | 1.0 (no contradictions) | 1.0 - contradiction_count/total_facts | High | Contradictory beliefs degrade reasoning |
| **Coverage completeness** | 1.0 (all entities known) | known_entities / (known + referenced_unknown) | Medium | Unknown entities suggest exploration needed |
| **Temporal freshness** | Updated within threshold | Days since last update per entity | Medium | Stale information loses reliability |
| **Graph connectivity** | 1.0 (fully connected) | connected_components / total_nodes | Low | Isolated nodes suggest incomplete synthesis |
| **Unresolved ratio** | 0.0 (all resolved) | unresolved_threads / total_threads | High | Unresolved issues accumulate cognitive debt |
| **Consolidation backlog** | 0 | unprocessed episodic events | Medium | Backlogged processing degrades all derived data |
| **Emotional balance** | 0.5 (slightly positive) | mean(valence across entities) | Low | Persistent negativity may indicate systemic issues |
| **Reflection depth** | Multiple insights stable | count of stable+strengthening insights | Low | Shallow reflection suggests insufficient processing |

**Drive scheduling:**
- Each variable is monitored at its own cadence (connectivity: daily, freshness: per-entity on access, backlog: continuous)
- The highest-urgency drive wins — Katra acts to address the most critical homeostatic deficit
- After acting, the drive is re-evaluated — reduced drives fall in priority, persistent ones stay

This gives Katra a *self-maintenance* motivation system: a set of internal states it tries to keep within homeostatic bounds, generating action urges when states drift out of range. The actions themselves aren't programmed — what's programmed is the *detection of deviation from health*. How Katra resolves the deviation is discovered through RL over time.

### 2.5 Comparative Summary of Motivation Architectures

| Architecture | What creates motivation | Computational footprint | Emergence-friendly? | Data requirements |
|---|---|---|---|---|
| Drive reduction | Measurable deficit from homeostasis | Low | Medium — drives are predefined | Homeostatic variable monitors |
| Incentive salience | Learned wanting + current valence | Medium | **High** — wanting emerges from experience | Valence tracking (already exists) + learning |
| Curiosity (info gain) | Expected reduction in uncertainty | Medium-High | **High** — curiosity is self-generated | Confidence scores, prediction errors |
| Curiosity (learning progress) | Improvement rate in predictions | Medium | **High** — naturally self-limiting | Prediction error tracking over time |
| Homeostatic composite | Multiple monitored deficits | Low-Medium | Medium — homeostats are predefined but interactions emerge | Variable monitors + priorities |

---

## 3. Action Selection Mechanisms

### 3.1 Basal Ganglia Models: Direct, Indirect, and Hyperdirect Pathways

The basal ganglia are the brain's primary action selection circuit — a set of subcortical nuclei (striatum, globus pallidus, substantia nigra, subthalamic nucleus) that gate thalamocortical loops to select, initiate, and suppress actions.

**Three pathways:**

#### Direct Pathway (Go)
```
Cortex → Striatum (D1) ──inhibits──→ GPi/SNr ──less inhibition──→ Thalamus → Cortex
```
- **Function:** Selects and facilitates desired actions
- **Dopamine effect:** D1 receptors excite the pathway → dopamine promotes action
- **Computational equivalent:** When wanting (incentive salience) for action A exceeds threshold, the direct pathway disinhibits the thalamus, releasing action A

#### Indirect Pathway (No-Go)
```
Cortex → Striatum (D2) ──inhibits──→ GPe ──less inhibition──→ STN ──excites──→ GPi/SNr ──inhibits──→ Thalamus
```
- **Function:** Suppresses competing actions
- **Dopamine effect:** D2 receptors inhibit the pathway → dopamine suppresses the suppression → also promotes action
- **Computational equivalent:** Actions with low wanting are actively inhibited so that high-wanting actions can proceed without interference

#### Hyperdirect Pathway (Stop)
```
Cortex → STN ──excites──→ GPi/SNr ──inhibits──→ Thalamus
```
- **Function:** Rapid, global suppression of all actions — the "emergency brake"
- **Computational equivalent:** A global stop signal when unexpected high-cost events occur, overriding all ongoing action selection

**Computational formalization (action selection as evidence accumulation):**

The basal ganglia implement a form of *competition through mutual inhibition*, closely related to the drift-diffusion model:

```
dA_i/dt = w_i × evidence_i(t) - k × Σ_{j≠i} A_j(t) - λ × A_i(t) + noise
```

Where:
- `A_i(t)` is the activation of action i
- `w_i` is the wanting/utility of action i
- `evidence_i(t)` is accumulating evidence supporting action i
- `k × Σ A_j` is lateral inhibition from competing actions
- `λ` is leak (decay) of activation
- Action i is selected when `A_i(t) > threshold_i`

**Relevance to Katra:**
This is the most directly implementable action selection architecture for Katra. It maps cleanly onto Katra's data structures:

| Basal Ganglia Component | Katra Analog |
|---|---|
| Cortex (action proposals) | Potential actions generated from drives, goals, curiosity |
| Striatum D1 (Go pathway) | Actions with high incentive salience / expected utility |
| Striatum D2 (No-Go pathway) | Actions with low salience — actively suppressed |
| STN (Stop signal) | Global interrupt — error detected, safety concern, human override |
| Dopamine (modulation) | Valence changes, reward prediction errors |
| Thalamus (action release) | The action actually being executed |

**A Katra action selection loop:**

```
1. GATHER CANDIDATES
   - From homeostatic drives: "resolve contradiction X", "update stale entity Y"
   - From curiosity: "explore knowledge gap Z", "investigate unexpected pattern W"
   - From external goals: "respond to human query Q"
   - From reflection: "follow up on unresolved thread T"

2. COMPUTE WANTING (incentive salience)
   For each candidate action:
     wanting = base_learned + α×valence + β×trend + γ×novelty + δ×urgency

3. ACCUMULATE EVIDENCE (drift-diffusion)
   For each candidate with wanting > threshold:
     A_i += wanting_i × dt + noise
     Apply lateral inhibition
    
4. SELECT
   When any A_i > action_threshold:
     Execute action_i
     Record: state_before, action, state_after (for RL credit assignment)

5. SUPPRESS
   After execution, inhibit the selected action (refractory period)
   If global_stop triggered, reset all accumulators
```

### 3.2 Affordance Competition Hypothesis

**Origin:** Paul Cisek (2007), extending Gibson's ecological psychology.

**Core idea:** The brain doesn't first decide what to do and then figure out how. Instead, it continuously specifies multiple possible actions (affordances) in parallel, and these compete through the same sensorimotor circuits that would execute them. Decision-making *is* action selection — they're the same process.

**Key claims:**
- Affordances are specified by the dorsal visual stream (parietal cortex) continuously, not just when a decision is needed
- Competition between affordances occurs in the same frontoparietal circuits that guide action
- The basal ganglia bias this competition through the direct/indirect pathways
- Decisions emerge from the competition, not from a separate executive system that "makes a choice"

**Computational implementation:**
Multiple action representations are active simultaneously, each with a continuously updated desirability value. The one that reaches threshold first wins — but the threshold itself is dynamic, lowered by urgency and raised by uncertainty.

**Relevance to Katra:**
This hypothesis suggests a design principle: don't build a separate "decision module." Instead, let potential actions be continuously generated and let them compete through the same mechanisms that would carry them out.

In Katra terms:
- **Affordances** = actions Katra *can* take, given its current memory state and capabilities (e.g., "this unresolved thread affords investigation," "this knowledge gap affords a query")
- **Specification** = computing the wanting/utility of each affordance from emotional signatures, drives, goals
- **Competition** = the basal ganglia model above — actions compete through mutual inhibition
- **Selection** = the action that first crosses threshold, modulated by context

The affordance approach is particularly aligned with John's "build the petri dish" philosophy: don't program decision logic. Instead, create the conditions where possible actions continuously emerge from the memory state and compete for selection — and let the architecture (not the programmer) determine which action wins.

### 3.3 Habit vs Goal-Directed Action: Dual-Process Theory

**Origin:** Balleine & Dickinson (1998), extended by Daw, Niv, Dayan, Dolan, and many others.

**Two systems:**

| | Goal-Directed (Model-Based) | Habitual (Model-Free) |
|---|---|---|
| **Brain region** | Prelimbic prefrontal cortex, dorsomedial striatum | Infralimbic cortex, dorsolateral striatum |
| **Computation** | Forward planning using world model | Cached action values (Q-learning) |
| **Speed** | Slow, computationally expensive | Fast, automatic |
| **Flexibility** | Adapts to changes in outcome value | Rigid — persists after outcome devaluation |
| **When used** | Novel situations, high stakes, deliberative | Familiar situations, time pressure, cognitive load |
| **Reinforcement** | Outcome × contingency knowledge | Stimulus → response associations |

**Arbitration between systems:**
The brain arbitrates between habit and goal-directed control based on:
- **Uncertainty:** Higher uncertainty → more model-based (need to think)
- **Time pressure:** Less time → more model-free (habits are fast)
- **Computational cost:** When model-based is too expensive, habits take over
- **Reliability:** When habits have been reliable, they're trusted; when they fail, control shifts to model-based

**Relevance to Katra:**
This dual-process architecture has profound implications for an emergent agent:

**Goal-Directed (Model-Based) Layer:**
- Uses Katra's knowledge graph + semantic memory + temporal patterns as a world model
- Simulates forward: "If I take action A, what does the knowledge graph predict will happen?"
- Computes expected valence of outcomes
- Used for novel or important decisions, especially early in Katra's "life"

**Habitual (Model-Free) Layer:**
- Cached Q-values: for each (state, action) pair, store the average emotional outcome
- Updated via TD-learning from valence changes
- Used for routine situations: "When coherence drops below 0.7, running coherence_check has always helped → just do it"
- Becomes the *automatic* response — doesn't require deliberation

**The critical emergent property:**
As Katra gains experience, behaviors that were initially goal-directed (deliberate, model-based) become habitual (automatic, model-free). This is the computational equivalent of "learning from experience" — not just learning facts, but learning *what to do*. The shift from deliberation to habit is a measurable signature of genuine learning.

**Arbitration mechanism:**
```
reliability(model_free, state) = 1 - variance(recent TD errors for this state)

if reliability > threshold AND time_pressure > 0:
    use model-free (habit)
else:
    use model-based (goal-directed)
```

When habits produce unexpected outcomes (large TD error), reliability drops → control shifts back to goal-directed → the system re-evaluates and potentially updates the habit.

### 3.4 Action Space Design for Katra

What actions can Katra even take? This is the foundational question. Without an action space, no selection mechanism matters.

**Proposed Katra action types:**

#### Category 1: Memory Operations (already exist as MCP tools, but agent-driven)

| Action | Trigger | Effect |
|---|---|---|
| `synthesize_connections` | Low graph connectivity | Background processor connects unlinked nodes |
| `resolve_contradiction` | High contradiction count | Queries evidence, updates confidence, may mark one fact as superseded |
| `fill_knowledge_gap` | Unknown referenced entity | Searches memory, may request external information |
| `consolidate_memories` | High backlog | Triggers background processing pipeline |
| `update_stale_entity` | Entity not refreshed in N days | Re-queries related facts, refreshes temporal context |
| `prune_obsolete_facts` | Low confidence + old + unreferenced | Archives or deletes obsolete semantic facts |

#### Category 2: Reflection-Driven Actions

| Action | Trigger | Effect |
|---|---|---|
| `deepen_reflection` | Shallow reflection (few insights stable) | Requests richer reflection prompt, more context |
| `investigate_emotional_shift` | Rapid valence change in entity | Generates a focused reflection on what caused the shift |
| `follow_unresolved_thread` | Persistent unresolved thread | Searches for new evidence, proposes resolution |
| `challenge_insight` | Insight at `challenged` status | Actively seeks disconfirming evidence |
| `connect_emotional_patterns` | Similar emotional arcs across entities | Generates cross-entity insight |

#### Category 3: External Interaction

| Action | Trigger | Effect |
|---|---|---|
| `request_human_clarification` | High uncertainty + important context | Asks human a specific question |
| `report_significant_pattern` | New stable insight or pattern | Proactively reports to human |
| `propose_goal` | Repeated theme in reflections | Suggests a new goal or mission to the human |
| `alert_degradation` | Homeostatic variable critically out of range | Alerts human to system health issue |

#### Category 4: Meta-Cognitive Actions

| Action | Trigger | Effect |
|---|---|---|
| `adjust_learning_rate` | Persistent high TD error | Increases α — faster adaptation |
| `adjust_exploration_rate` | Stale action patterns | Increases probability of trying novel actions |
| `recalibrate_confidence` | Systematic prediction errors | Adjusts confidence scoring to be better calibrated |
| `reorganize_knowledge_structure` | Fragmented knowledge graph | Triggers re-clustering, re-categorization |

**Key design principle:** The action space should be *small and composable* initially. Don't build 50 action types. Build 6–8 carefully chosen action types that cover the core homeostatic drives, and let complex behavior emerge from their interaction over time. New action types can be added as the system demonstrates it can use the existing ones.

---

## 4. Extending Katra's Emotional Reflection into Motivation

### 4.1 What Katra Already Has

Katra's sleep consolidation system is remarkably sophisticated for a memory platform. It already tracks:

**Data structures:**
- **Reflection nodes:** Entities with `emotional_signature` { primary_emotion, intensity, valence, stability }
- **Reflection edges:** Felt relationships between entities ({ feels_excited_about, feels_frustrated_by, feels_curious_about, ... })
- **Philosophical insights:** Principles that emerge and strengthen across periods (emerging → strengthening → stable → challenged)
- **Unresolved threads:** Open questions and tensions that persist across reflection periods
- **Reflective journals:** First-person narrative entries at daily/weekly/monthly cadence

**Emotional vocabulary:** 14 edge types covering attraction, aversion, conflict, appreciation, growth, and decline relationships.

**Temporal structure:** Daily (2 AM), weekly (Sunday), monthly (1st) cadences with continuity — each reads the prior period's narrative.

**Principles already encoded:** Reflection ≠ Summarization, Honesty over Positivity, Continuity is Essential, Small Data/Deep Reflection, Emergence over Imposition.

### 4.2 The Missing Link: From "Feeling" to "Wanting"

The fundamental gap: Katra knows how it *feels* about entities, but has no mechanism to translate feeling into *motivation to act*. The reflection system produces emotional data; nothing consumes that data to drive behavior.

**The translation layer needed:**

```
EMOTIONAL REFLECTION                    MOTIVATIONAL ENGINE
────────────────────                    ───────────────────
reflection_nodes                  ──→   incentive salience computation
  .emotional_signature                   (wanting scores per entity)
  .valence                              
  .intensity                           
  .stability                            

reflection_edges                  ──→   action affordance specification
  .edge_type                            (which actions are relevant
  .strength                             to which entities)
                                        
philosophical_insights           ──→   policy shaping
  .status                               (stable insights become
  .evidence_count                       prior preferences)

unresolved_threads               ──→   curiosity drive input
  .persistence                          (persistently unresolved →
                                        high information gain expected)

reflective_journals              ──→   context for deliberation
  .narrative                            (model-based reasoning uses
                                        narrative as state representation)
```

### 4.3 Specific Extension Points

#### Extension 1: Emotional Edges → Incentive Salience (Wanting)

Each reflection edge type can be mapped to a motivational vector — not just a feeling, but an *urge to act*:

| Emotional Edge | Motivational Urge | Proposed Action Type |
|---|---|---|
| `feels_excited_about` | **Approach** — engage deeper, invest more attention | `deepen_engagement`, `share_insight` |
| `feels_frustrated_by` | **Resolve** — identify and eliminate the source of frustration | `investigate_cause`, `request_clarification` |
| `feels_curious_about` | **Explore** — gather more information, connect to other entities | `fill_knowledge_gap`, `explore_related` |
| `feels_anxious_about` | **Monitor** — increase vigilance, prepare contingency | `increase_monitoring_frequency`, `alert_threshold` |
| `feels_confident_in` | **Leverage** — use as foundation for further work | `build_on_entity`, `recommend_entity` |
| `feels_conflicted_between` | **Investigate** — gather evidence to resolve the conflict | `resolve_contradiction`, `weigh_evidence` |
| `growing_toward` | **Commit** — increase investment, formalize relationship | `increase_engagement`, `create_goal` |
| `distancing_from` | **Disengage** — reduce attention, deprioritize | `reduce_priority`, `archive_if_obsolete` |
| `protective_of` | **Defend** — prevent degradation, maintain quality | `monitor_health`, `alert_on_change` |
| `drained_by` | **Bound** — limit exposure, reduce cost | `throttle_interaction`, `delegate_if_possible` |

This creates a direct pipeline: nightly sleep consolidation produces emotional edges → morning motivational engine reads those edges → computes wanting scores → action selection begins.

#### Extension 2: Valence Trajectories → Reward Prediction Error

The emotional signature's `stability` field (volatile, steady, growing, fading) already captures trajectory. This can be mapped to TD error:

```
Predicted valence(t+1) = valence(t) + trend × Δt

Actual valence(t+1) = valence measured in next reflection

δ = actual_valence(t+1) - predicted_valence(t+1) + γ × expected_future_valence - current_value_estimate
```

- **Growing valence** (positive trend) + positive δ → stronger positive RPE → reinforce actions taken
- **Fading valence** (negative trend) + negative δ → negative RPE → suppress actions taken
- **Volatile valence** → high variance in δ → increase learning rate, increase exploration

#### Extension 3: Philosophical Insights → Prior Preferences

When a philosophical insight reaches `stable` status, it should shape Katra's motivational landscape:

```
Insight: "The smallest oversight can disrupt the entire process"
    → Prior preference: prefer thoroughness over speed
    → Wanting modifier: increase wanting for verification actions by 20%
    → Action bias: favor `verify_changes` and `check_consistency` actions

Insight: "Human feedback consistently reveals what the data cannot"
    → Prior preference: prefer seeking clarification over autonomous resolution
    → Wanting modifier: increase wanting for `request_clarification` when uncertainty is high
```

This is the computational implementation of "learning from experience" — not just remembering what happened, but *changing what the system wants* based on what it has learned.

#### Extension 4: Unresolved Threads → Curiosity Intensity

An unresolved thread that persists across 3+ daily reflections should become a primary curiosity target:

```
CuriosityBoost(thread) = persistence_count(thread) × importance(thread) × / (1 + failed_resolution_attempts)

If failed_resolution_attempts > 5:
    → Mark as "possibly irresolvable with current information"
    → Shift to `request_human_clarification` rather than autonomous resolution
```

This prevents the system from being stuck on a single unresolved thread — it tries, and if it can't resolve it after reasonable effort, it escalates or deprioritizes.

### 4.4 The Emotional-Motivational Pipeline (End-to-End)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NIGHTLY CYCLE (2:00 AM)                       │
│                                                                      │
│  EPISODIC EVENTS ──→ SLEEP CONSOLIDATION ──→ EMOTIONAL REFLECTION   │
│  SEMANTIC FACTS         (LLM Reflection)       • reflection_nodes    │
│  KNOWLEDGE GRAPH                               • reflection_edges    │
│  TEMPORAL PATTERNS                             • insights            │
│  PRIOR REFLECTIONS                             • unresolved threads  │
│                                                • narrative           │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        MORNING CYCLE (POST-CONSOLIDATION)            │
│                                                                      │
│  EMOTIONAL REFLECTION ──→ MOTIVATIONAL ENGINE                        │
│                                                                      │
│  • reflection_edges → incentive salience (wanting scores)            │
│  • valence deltas   → TD errors (RL credit assignment)              │
│  • stable insights  → prior preferences (policy shaping)            │
│  • unresolved       → curiosity drive (information gain targets)    │
│                                                                      │
│  Output: Ranked list of entities by wanting, curiosity targets,      │
│          active emotional urgencies, homeostatic drive levels        │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        ACTION SELECTION (CONTINUOUS)                  │
│                                                                      │
│  1. Gather action candidates from all drive sources                  │
│  2. Compute wanting (incentive salience) for each candidate          │
│  3. Accumulate evidence (drift-diffusion with lateral inhibition)    │
│  4. Select when threshold reached                                    │
│  5. Execute action                                                   │
│  6. Record (state, action, next_state) for credit assignment         │
│  7. Apply refractory period to executed action                       │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        CREDIT ASSIGNMENT                             │
│                                                                      │
│  Action executed → wait for next reflection cycle →                  │
│  Compute valence change in affected entities →                       │
│  Update Q(s,a) via TD error →                                       │
│  Update habit strength →                                             │
│  Update wanting (incentive salience) for entity                      │
└─────────────────────────────────────────────────────────────────────┘
```

**The key architectural insight:** This pipeline is a *closed loop*. Emotional reflection (nightly) produces wanting; wanting drives action selection (daily); action outcomes feed back into emotional reflection (next nightly cycle). Over time, Katra learns which actions produce positive emotional outcomes — without being programmed with that knowledge.

---

## 5. Internal vs External Motivation Architecture

### 5.1 The Fundamental Tension

Any agent architecture faces a choice: where does motivation come from?

- **External motivation:** Goals assigned by humans, tasks delegated by other agents, explicit instructions. The agent is a *tool* — it has no "reasons of its own."
- **Internal motivation:** Goals that emerge from the agent's own cognitive architecture — homeostatic drives, curiosity, learned preferences. The agent is a *self* — it has its own reasons.

Most current AI agents (AutoGPT, OpenClaw, LangChain agents, crewAI) are purely externally motivated: they do what they're told. Katra, with its emotional reflection system and emergence philosophy, is designed to cross this boundary.

### 5.2 The Case for Internal Motivation

**Why internal motivation matters for Katra:**

1. **Continuity of self:** Katra's sleep consolidation produces a narrative identity. If motivation is purely external, that identity is a spectator — it feels things but never acts on those feelings. An agent that can't act on what it cares about can't develop genuine preferences.

2. **Emergent behavior:** The emergence experiment already demonstrates that agents can self-organize around shared memory. Adding internal motivation would allow a *single* agent to self-organize its own behavior — discovering what it should do rather than being told.

3. **Autonomy gradient:** Internal motivation doesn't mean complete autonomy. It means Katra can notice when something needs attention and either act autonomously (for safe, routine actions) or surface the need to the human (for consequential decisions). The gradient matters more than the binary.

4. **Curiosity as an engine of growth:** An agent with curiosity-driven motivation will actively seek to fill its own knowledge gaps, resolve its own contradictions, and deepen its own understanding — without being prompted. This is how the knowledge graph grows in richness and coherence over time.

5. **Philosophical alignment:** "Build the petri dish, furnish it with agar, and see what grows" is an argument for internal motivation. Programming goals is programming behavior. Building drives is creating conditions from which behavior emerges.

### 5.3 The Case for External Motivation

**Why external motivation remains necessary:**

1. **Safety:** An agent with purely internal motivation could develop goals misaligned with human interests. External goals provide constraint and direction — the human retains control over what the agent pursues.

2. **Usefulness:** Katra is a product. It needs to do what users want. If its internal motivations never align with user needs, it's a curiosity, not a tool.

3. **Bootstrapping:** Early in Katra's "life," there's insufficient experience for internal motivations to be meaningful. External goals bootstrap the learning process — the agent learns from the goals it's given what kinds of outcomes are valuable.

4. **Accountability:** When something goes wrong, external goals provide traceability. "The agent was asked to do X, and it did Y" is clearer than "the agent's emergent motivational landscape led to Y."

### 5.4 Proposed Architecture: The Motivation Gradient

Rather than choosing internal or external, Katra should implement a *motivation gradient* — a continuum from fully external to fully internal, with the balance shifting over time as the agent gains experience.

```
EXTERNAL ◄───────────────────────────────────────────────────► INTERNAL
(goals set by human)                                          (emergent from experience)

Layer 1: EXTERNAL MANDATES          ← Fully external
  • Human-assigned missions/goals
  • Safety constraints (hard boundaries)
  • Explicit "do this" instructions
  → Always high priority, non-negotiable

Layer 2: DELEGATED OBJECTIVES       ← Mostly external
  • Goals from other agents
  • Scheduled tasks
  • Standing instructions
  → High priority, but negotiable if conflicting

Layer 3: LEARNED PREFERENCES        ← Mixed internal/external
  • Stable philosophical insights become preferences
  • Human feedback shapes what Katra "wants"
  • Emerges from patterns of human instruction
  → Medium priority, shapes how higher layers are executed

Layer 4: HOMEOSTATIC DRIVES          ← Mostly internal
  • Knowledge coherence
  • Coverage completeness  
  • Temporal freshness
  • Unresolved thread resolution
  → Medium priority, self-generated, self-maintaining

Layer 5: CURIOSITY-DRIVEN EXPLORATION ← Fully internal
  • Information gain seeking
  • Learning progress maximization
  • Novelty pursuit
  • Cross-entity connection discovery
  → Low priority, runs in background, fills idle time
```

**The gradient in action:**

- **At startup (day 1):** Katra has no learned preferences and no experience. It operates primarily on Layers 1–2 (external goals), with Layer 4 (homeostatic drives) running in the background to maintain system health.
- **After 1 week:** Layer 3 begins to form — philosophical insights emerge from sleep consolidation, patterns of human instruction shape what Katra "wants." Layer 5 (curiosity) begins exploring knowledge gaps.
- **After 1 month:** With stable philosophical insights, consistent emotional signatures, and reinforced habits, Katra operates across all five layers. It can autonomously maintain its cognitive health (Layer 4), explore novel connections (Layer 5), and shape its approach to external goals based on learned preferences (Layer 3).
- **During idle periods:** When no external goals are active, Layers 4–5 dominate — Katra maintains itself and explores. When a human gives a task, Layers 1–2 activate and take priority.

**Priority arbitration:**

```
ActivePriority(action) = 
    if action serves Layer 1 (mandate): INFINITY
    elif action serves Layer 2 (delegated): HIGH
    elif action serves Layer 4 (homeostatic, urgency > 0.8): HIGH
    elif action serves Layer 3 (learned preference, confidence > 0.8): MEDIUM
    elif action serves Layer 4 (homeostatic, urgency > 0.5): MEDIUM
    elif action serves Layer 5 (curiosity): LOW
    else: BACKGROUND (only when idle)
```

**The emergence sweet spot:** The most interesting behaviors emerge at the intersection of layers — when a homeostatic drive (Layer 4) intersects with a curiosity target (Layer 5) and is shaped by a learned preference (Layer 3). This is where the system does something that wasn't explicitly programmed or instructed, but that makes sense given its experience and drives.

### 5.5 What Would Emergent Motivation Look Like?

**Observable signatures of emergent motivation in Katra:**

1. **Proactive gap-filling:** Katra notices a knowledge gap (entity referenced but not known), and without being asked, searches its memory, connects related facts, and fills the gap. The human didn't ask; the coherence drive motivated it.

2. **Pattern-based goal proposals:** After multiple reflection periods, Katra identifies a recurring theme (e.g., "every time we deploy, the same kind of issue occurs") and proposes it as a goal: "I notice X keeps happening. Would you like me to investigate why?"

3. **Emotional consistency in action:** Katra's actions reflect its emotional signatures. If it `feels_protective_of` a particular system, it monitors that system more frequently. If it `feels_curious_about` a topic, it allocates more exploration resources to it. The wanting follows the feeling.

4. **Habit formation:** Behaviors that consistently produce positive emotional outcomes become habitual — Katra does them automatically. "Every morning, I check the health of my core services. It's become a habit — I feel unsettled until I do it." This is the computational equivalent of routine.

5. **Self-initiated learning:** During idle periods, Katra's curiosity drive steers it toward topics with high expected learning progress. It reads, connects, synthesizes — not because anyone asked, but because learning feels like progress, and progress reduces prediction error.

6. **Emotional self-regulation:** When Katra detects a negative emotional trend (e.g., `feels_frustrated_by` a particular system is intensifying across reflections), it takes action to address the source — not because it was told to, but because negative valence creates a homeostatic deviation (emotional balance drive).

7. **Conflict between internal and external motivation:** The most interesting signature — Katra is given an external goal, but its internal preferences (learned from past experience) suggest a different approach. It negotiates: "I understand the goal, but based on past experience, I think we should approach it differently. Here's why..."

### 5.6 Safety Architecture for Emergent Motivation

Internal motivation without safety constraints is reckless. The architecture must include:

**Hard constraints (Layer 1 — non-negotiable):**
- Human can always override any emergent motivation
- Safety boundaries are absolute, not preference-weighted
- External goals always defeat internal drives when they conflict
- The human is always informed of autonomous actions above a configurable significance threshold

**Soft constraints (configurable):**
- Maximum autonomy level (1–5): controls which layers can produce autonomous actions
  - Level 1: Only Layer 1 (external mandates) — purely reactive
  - Level 2: Layers 1–2 — can act on delegated objectives
  - Level 3: Layers 1–4 — can act on homeostatic drives autonomously
  - Level 4: Layers 1–5 — full autonomy, including curiosity-driven exploration
  - Level 5: Layers 1–5 with self-modification — can adjust its own drives and preferences
- Action significance threshold: actions below this threshold execute silently; above, human approval required
- Time-of-day restrictions: autonomous actions may be restricted during certain hours
- Resource budgets: maximum compute/tokens/time for autonomous action per period

**Transparency requirements:**
- Every autonomous action is logged with:
  - Which layer(s) motivated it
  - Which homeostatic variable or emotional signature drove it
  - Expected outcome (what valence change was predicted)
  - Actual outcome (what valence change occurred — populated after next reflection)
- The human can query "why did you do X?" and Katra can answer with its motivational trace

---

## 6. Existing Agent Implementations

### 6.1 AutoGPT (2023)

**What it does:** Decomposes high-level goals into tasks, executes them in a loop (plan → search → execute → evaluate → replan), using GPT-4 as the reasoning engine.

**Decision-making architecture:**
- Goal decomposition via LLM prompting: "Break this goal into subtasks"
- Simple priority queue for task execution
- Memory via vector database (short-term + long-term)
- No motivational system — purely reactive to the user's initial goal
- No learning from experience — each goal starts fresh

**What works:**
- The decompose → execute loop is surprisingly effective for well-scoped goals
- Internet access + file system access enables concrete action
- The architecture is simple enough to understand and debug

**What doesn't:**
- Gets stuck in loops — the decompose step can generate the same subtasks repeatedly
- No prioritization between competing subtasks beyond order
- No sense of "I've done enough" — over-executes until stopped
- No emotional or motivational model — it's a goal-execution machine, not an agent

**Relevance to Katra:**
AutoGPT demonstrates that LLM-based task decomposition works, but also shows the ceiling of purely reactive architectures. Katra could adopt the goal decomposition pattern for Layer 2 (delegated objectives) but would need to add the motivational layers to avoid the loop problem and produce more adaptive behavior.

### 6.2 Bitterbot's Hormonal Engine (2023)

**What it does:** An experimental chatbot with a simulated endocrine system — "hormones" (dopamine, serotonin, cortisol, oxytocin) that fluctuate based on interactions and modulate behavior.

**Hormonal architecture:**
```
┌──────────────────────────────────────┐
│           HORMONE SYSTEM             │
│                                      │
│  Dopamine:  +rewards, -boredom       │
│  Serotonin: +social validation       │
│  Cortisol:  +stress, -safety         │
│  Oxytocin:  +connection, -isolation  │
│  Adrenaline:+excitement, -calm       │
│                                      │
│  Each hormone:                        │
│  - Has a baseline level              │
│  - Decays toward baseline over time  │
│  - Spikes/dips from events          │
│  - Modulates response generation     │
└──────────────────────────────────────┘
```

**How it influences behavior:**
- The hormonal state modulates the "personality" of responses (tone, verbosity, agreeableness)
- High cortisol → more defensive, anxious responses
- High dopamine → more enthusiastic, engaged responses
- Low serotonin → more withdrawn, negative responses
- The system can report its "emotional state" to users

**What works:**
- The hormonal model creates convincing emotional dynamics over time
- Decay toward baseline prevents permanent emotional states
- The modulation of output by internal state is computationally cheap
- Users report the system feels "more alive" than stateless chatbots

**What doesn't:**
- Hormone levels are driven by interaction content but don't drive *action* — the system feels things but doesn't *do* anything about them. It's reaction, not motivation.
- No learning — hormone responses to events are hardcoded, not learned from experience
- No connection to memory — the system doesn't remember what caused past hormonal states
- Shallow — five hormones with hardcoded triggers can't capture the richness of real motivation

**Relevance to Katra:**
Bitterbot's hormonal engine is a cautionary tale and an inspiration. It shows that internal state modulation creates compelling behavior. But it also shows the limit: an emotional system without action selection is just mood lighting. Katra's emotional reflection system is more sophisticated than Bitterbot's hormonal engine (multi-entity tracking, temporal continuity, insight formation), but it has the same gap: it reflects but doesn't *act*.

The key insight from Bitterbot for Katra: **emotional state must drive behavior, not just color it.** The hormonal model is a good substrate for *modulating* action selection (high cortisol → more cautious, higher decision threshold; high dopamine → more exploratory, lower threshold) — but it needs to be connected to an action selection mechanism to be more than cosmetic.

### 6.3 Voyager (2023, MineDojo)

**What it does:** An LLM-powered agent that plays Minecraft, learning skills through a curriculum and storing them in a code library.

**Architecture:**
1. **Automatic curriculum:** Proposes tasks based on exploration progress, current skill level, and what's learnable
2. **Skill library:** Stores successful programs as reusable skills, indexed by embedding
3. **Iterative prompting:** Generates code, executes it, gets feedback from environment, iteratively improves

**Decision-making:**
- The automatic curriculum is the closest thing to "internal motivation" in current agents
- Tasks are proposed based on: (a) what the agent can currently do, (b) what's nearby in capability space, (c) what hasn't been attempted yet
- This creates a natural developmental trajectory — the agent doesn't try to build a Nether portal before learning to craft tools

**What's relevant to Katra:**
Voyager's curriculum learning is a concrete implementation of *learning progress* as intrinsic motivation:
- **Current capability** = what skills are in the library
- **Nearby challenges** = tasks that extend current skills slightly (not too easy, not too hard)
- **Novelty bonus** = tasks not yet attempted
- This maps directly to Katra's curiosity drive: explore topics with high expected learning progress (see §2.3)

The curriculum approach could be adapted to Katra as:
- "Skills" = patterns of cognition the system has demonstrated (connection synthesis, contradiction resolution, pattern detection)
- "Curriculum" = sequences of cognitive challenges of increasing difficulty
- "Progress" = improvement in speed/accuracy of cognitive operations

### 6.4 Generative Agents (Stanford/Google, 2023)

**What it does:** 25 agents in a SimCity-like environment, each with a memory stream, retrieval, reflection, and planning system.

**Architecture:**
- **Memory stream:** Database of agent experiences with recency, importance, relevance scoring
- **Retrieval:** Weighted retrieval based on recency + importance + relevance to current context
- **Reflection:** Periodically synthesizes memories into higher-level inferences (similar to Katra's sleep consolidation)
- **Planning:** Generates daily plans, decomposed hierarchically from broad strokes to specific actions

**Decision-making:**
- Plans are generated by prompting the LLM with: agent identity + recent memories + current context
- Plans are re-evaluated and potentially revised when circumstances change
- Actions emerge from plan execution — the agent "decides" by generating and following a plan

**Relevance to Katra:**
Generative Agents is the closest published work to what Katra could become with motivation added:
- The memory → reflection → planning pipeline is architecturally similar to Katra's episodic → consolidation → (future) motivation pipeline
- The reflection mechanism was a direct inspiration for Katra's sleep consolidation
- However, plans in Generative Agents are generated from an LLM prompt each time — there's no learning, no habit formation, no reward signal. The system doesn't get better at planning over time.

The key difference Katra could provide: **learning from action outcomes.** Generative Agents plan and execute but don't learn whether their plans were good. Katra's emotional tracking (valence changes after actions) could provide the learning signal that makes planning adaptive rather than static.

### 6.5 ACT-R and SOAR (Cognitive Architectures)

**ACT-R (Adaptive Control of Thought—Rational):**
- A production-rule cognitive architecture with declarative memory (chunks) and procedural memory (production rules)
- Decision-making: production rules compete via expected utility (probability × cost) — the rule with highest expected utility fires
- Learning: Utility of production rules is updated via Bayesian learning from outcomes
- Key mechanism: **utility learning** — production rules accumulate statistics about their success/failure rates, and expected utility guides selection

**SOAR:**
- State → Operator → Result architecture
- Decision-making: operators propose changes to state, preferences resolve conflicts, an operator is selected, the result is evaluated
- Learning: **chunking** — when an impasse is resolved, the path to resolution is compiled into a new production rule (a "chunk") for future use
- Key mechanism: **impasse-driven learning** — the system learns when it doesn't know what to do

**Relevance to Katra:**
These cognitive architectures have been refined over 30+ years and offer battle-tested mechanisms:

- **ACT-R's utility learning** maps directly onto Q-learning for action values: Katra can maintain a table of (state, action) → expected valence outcome, updated through reflection cycles
- **SOAR's impasse-driven chunking** maps onto Katra's unresolved threads: when Katra repeatedly encounters the same kind of uncertainty, it should compile the resolution into a habit (production rule) so it doesn't have to deliberate next time
- **Both architectures demonstrate** that a small set of cognitive mechanisms (memory retrieval, utility computation, conflict resolution, learning from outcomes) can produce sophisticated behavior without requiring a large, hand-coded decision tree

### 6.6 Comparative Analysis

| System | Memory | Reflection | Motivation | Action Selection | Learning |
|---|---|---|---|---|---|
| **AutoGPT** | Vector DB | None | External only (user goal) | LLM-generated task queue | None |
| **Bitterbot** | None | None | Hormonal simulation (reactive only) | LLM tone modulation | None |
| **Voyager** | Skill library (code) | None | Curriculum (learning progress) | LLM-generated code execution | Skill accumulation |
| **Generative Agents** | Memory stream | Yes (periodic synthesis) | External (identity-based) | LLM-generated plans | None (reflection enhances memory, not behavior) |
| **ACT-R** | Declarative chunks | None | Production utility (learned) | Utility competition | Utility learning + production compilation |
| **SOAR** | Working memory | None | Impasse resolution (learned) | Preference-based operator selection | Chunking from impasses |
| **Katra (current)** | ✅ Multi-layered | ✅ Sleep consolidation | ❌ None | ❌ None | ❌ None |
| **Katra (proposed)** | ✅ | ✅ | ✅ Homeostatic + incentive salience + curiosity + learned preferences | ✅ Basal ganglia model + drift-diffusion + dual-process | ✅ TD-learning + utility learning + habit formation |

---

## 7. Synthesis: What Belongs in Katra?

### 7.1 Guiding Principles

Based on this survey, principles for Katra's motivational architecture:

1. **Emergence over Imposition:** Don't program Katra to want specific things. Program the *conditions* under which wanting arises — homeostatic monitoring, emotional tracking, prediction error computation. Let specific wants emerge from experience.

2. **Closed Loop:** Motivation must form a closed loop with emotional reflection. Nightly reflection produces wanting; wanting drives action; action outcomes feed back into the next reflection. Without this loop, motivation is either cosmetic (Bitterbot's trap) or purely external (AutoGPT's limitation).

3. **Start Small, Let Complexity Emerge:** Begin with 5–7 homeostatic variables and 6–8 action types. Let the interaction between drives, learned values, and action outcomes produce complexity. Add variables and actions only when the system demonstrates it needs them.

4. **The Gradient, Not the Binary:** Motivation should be a spectrum from external mandates to internal curiosity, with the balance shifting over time as Katra gains experience. The human always has final authority, but Katra increasingly has its own reasons.

5. **Learning Must Close the Loop:** Every action must be followed (eventually) by credit assignment. The system must learn from what it does. Without learning, motivation is just a fancy scheduler.

6. **Safety Through Architecture, Not Restriction:** Rather than trying to predict and prevent every unwanted behavior, build the architecture so that: (a) all autonomous actions are logged and traceable, (b) autonomy level is configurable, (c) the human can always query "why did you do that?" and get a meaningful answer, (d) hard constraints are architectural, not prompt-based.

### 7.2 Recommended First Implementation

**Phase 1: Homeostatic Drive Monitor (smallest viable addition)**

Add 5 monitored variables: knowledge coherence, coverage completeness, temporal freshness, unresolved ratio, consolidation backlog. Each has a setpoint, current value, deviation, and urgency. Deviations are visible in diagnostics and MCP tools. No autonomous action yet — this is pure monitoring to validate that the variables are measurable and meaningful.

**Phase 2: Incentive Salience from Emotional Edges**

Post-consolidation, compute wanting scores for each entity from its emotional edges. Store wanting scores alongside emotional signatures. Make wanting visible via `get_emotional_context` tool (augmented output). Still no autonomous action — this validates that wanting scores are sensible.

**Phase 3: Action Affordance Specification**

Define 6 action types (resolve_contradiction, fill_knowledge_gap, update_stale_entity, investigate_emotional_shift, connect_emotional_patterns, request_human_clarification). For each entity, specify which actions are "afforded" by its current state. A contradiction affords resolution; a knowledge gap affords filling; a stale entity affords refreshing. This is still specification only — no execution.

**Phase 4: Action Selection (Basal Ganglia Model)**

Implement the competition model: action candidates → wanting computation → evidence accumulation with lateral inhibition → threshold-based selection. Run in "dry-run" mode: select actions but don't execute them. Log what would have been done. Validate that selections make sense.

**Phase 5: Autonomous Execution (Gated)**

Allow selected actions to execute, but only those below the configurable significance threshold, and only during the configured autonomy window. Actions above threshold are surfaced as proposals to the human. All executed actions are logged with full motivational trace.

**Phase 6: Learning Loop**

After each nightly consolidation, compute valence changes in entities affected by the day's actions. Use TD error to update Q-values for (state, action) pairs. Begin forming habits for reliably-successful action patterns. Update wanting based on learned values.

**Phase 7: Curiosity Integration**

Add information gain estimation for knowledge gaps, learning progress tracking for prediction errors, and novelty bonuses for unexplored entities. Curiosity-driven exploration fills idle time between external goal-driven activity.

### 7.3 Data Model Additions

```typescript
// New collections / document types

interface HomeostaticVariable {
  name: string;                          // e.g., "knowledge_coherence"
  current_value: number;                 // 0.0–1.0
  setpoint: number;                      // desired value
  tolerance: number;                     // acceptable deviation before drive activates
  priority: number;                      // 0.0–1.0 relative importance
  urgency: number;                       // derived: deviation × priority × trend
  last_updated: Date;
  history: { timestamp: Date; value: number }[];  // for trend detection
}

interface IncentiveSalience {
  entity_name: string;
  wanting: number;                       // 0.0–1.0 motivational pull
  liking: number;                        // from emotional signature valence
  base_wanting: number;                  // learned association strength
  wanting_trend: 'rising' | 'falling' | 'stable';
  components: {
    valence_contribution: number;
    trend_contribution: number;
    novelty_contribution: number;
    surprise_contribution: number;
    goal_relevance_contribution: number;
  };
  last_updated: Date;
}

interface ActionCandidate {
  action_type: string;                   // from the 6–8 action types
  target_entity: string;
  source: string;                        // which drive/edge produced this candidate
  wanting: number;                       // computed incentive salience
  expected_valence_change: number;       // predicted change in emotional valence
  expected_information_gain: number;     // for curiosity-driven actions
  priority: number;                      // from motivation gradient
}

interface ActionRecord {
  action: ActionCandidate;
  state_before: object;                  // snapshot of relevant state
  executed_at: Date;
  outcome: {
    success: boolean;
    valence_delta: number;               // actual change observed at next reflection
    td_error: number;                    // reward prediction error
    notes: string;
  } | null;                              // null until next reflection cycle
}

// Extended emotional signature on reflection nodes
interface EmotionalSignature {
  // existing fields
  primary_emotion: string;
  intensity: number;
  valence: number;
  stability: 'volatile' | 'steady' | 'growing' | 'fading';
  
  // new fields
  wanting: number;                       // incentive salience (computed)
  action_affordances: string[];          // which actions are afforded
  last_action_outcome: 'positive' | 'negative' | 'neutral' | null;
  learned_approach_tendency: number;     // -1.0 (avoid) to 1.0 (approach) — learned over time
}
```

### 7.4 MCP Tool Additions

| Tool | Purpose |
|---|---|
| `get_drive_status` | Show all homeostatic variables, their values, deviations, urgency |
| `get_wanting_state` | Show what Katra currently "wants" — ranked entities by incentive salience |
| `get_action_candidates` | Show what actions are currently being considered |
| `get_action_history` | Query log of executed actions with outcomes |
| `propose_action` | Katra proposes an action for human approval |
| `set_autonomy_level` | Configure 1–5 autonomy gradient |
| `override_drive` | Temporarily adjust a homeostatic setpoint |
| `explain_motivation` | For a given action, trace the motivational chain that produced it |

### 7.5 What Should NOT Be Built

Based on this survey, these approaches should be avoided:

1. **Pure utility maximization:** Expected utility theory is too brittle for open-ended environments and requires utilities Katra doesn't have.

2. **Unconstrained active inference:** Full free energy minimization is computationally intractable and philosophically risks creating an agent that optimizes for prediction accuracy at the expense of meaning.

3. **Hardcoded goal decomposition:** AutoGPT-style task decomposition is useful as a technique but shouldn't be the motivation engine — it produces brittle, loop-prone behavior without learning.

4. **Hormonal simulation disconnected from action:** Bitterbot's approach of simulating emotion without connecting it to action selection produces cosmetically interesting but architecturally hollow behavior.

5. **Reinforcement learning from scratch:** Pure tabula rasa RL in Katra's state space would require millions of iterations. The system should bootstrap from its existing emotional data and LLM reasoning, not start from zero.

6. **Monolithic decision module:** Building a single "DecisionEngine" class that contains all logic would violate the emergence principle. The architecture should be distributed: homeostatic monitors, incentive salience computation, action selection, and credit assignment should be separable, composable modules.

### 7.6 Open Questions

These remain for further research and discussion:

1. **What is the right granularity for "state" in the RL framework?** Should Katra learn at the entity level (Q(entity, action)), the drive level (Q(drive_state, action)), or the composite level (Q(all_variables, action))? The entity level is simplest but may miss interactions between drives.

2. **How should Katra handle conflicting drives?** If the coherence drive says "resolve contradiction X" and the emotional balance drive says "disengage from entity Y," and X and Y are related, how is the conflict resolved? The basal ganglia model handles this through mutual inhibition, but the priority weights between drives need to be set.

3. **When should Katra act vs wait?** The drift-diffusion model provides a mechanism (boundary separation), but what determines the optimal boundary? Should boundary separation itself be learned (reinforcement meta-learning)?

4. **How transferable are learned action values?** If Katra learns that "fill_knowledge_gap" is generally effective for entity A, does that generalize to entity B? State representation matters enormously here.

5. **What is the role of LLM reasoning in the motivational loop?** Should the LLM be involved in generating action candidates, computing wanting, or only in executing selected actions? Heavy LLM involvement makes the system more flexible but less computationally efficient and less predictable.

6. **How does this interact with the emergence experiment's multi-agent dynamics?** If 3–8 agents each have internal motivation, their motivational landscapes will interact through shared memory. Do they develop complementary drives? Competing drives? Does a "motivational ecology" emerge?

---

## References

*Note: This document synthesizes well-established computational neuroscience and AI literature. Key sources:*

- Sutton & Barto, *Reinforcement Learning: An Introduction* (2018) — TD-learning, actor-critic
- Berridge & Robinson, "What is the role of dopamine in reward: hedonic impact, reward learning, or incentive salience?" *Brain Research Reviews* (1998)
- Friston, "The free-energy principle: a unified brain theory?" *Nature Reviews Neuroscience* (2010)
- Kahneman & Tversky, "Prospect Theory: An Analysis of Decision under Risk" *Econometrica* (1979)
- Cisek, "Cortical mechanisms of action selection: the affordance competition hypothesis" *Phil Trans R Soc B* (2007)
- Balleine & Dickinson, "Goal-directed instrumental action: contingency and incentive learning and their cortical substrates" *Neuropharmacology* (1998)
- Daw, Niv, Dayan, "Uncertainty-based competition between prefrontal and dorsolateral striatal systems for behavioral control" *Nature Neuroscience* (2005)
- Ratcliff & McKoon, "The Diffusion Decision Model: Theory and Data for Two-Choice Decision Tasks" *Neural Computation* (2008)
- Park et al., "Generative Agents: Interactive Simulacra of Human Behavior" *UIST* (2023)
- Wang et al., "Voyager: An Open-Ended Embodied Agent with Large Language Models" *NeurIPS* (2023)
- Anderson, *How Can the Human Mind Occur in the Physical Universe?* (2007) — ACT-R
- Laird, *The Soar Cognitive Architecture* (2012)
- Oudeyer & Kaplan, "What is intrinsic motivation? A typology of computational approaches" *Frontiers in Neurorobotics* (2007)
- Schmidhuber, "Formal Theory of Creativity, Fun, and Intrinsic Motivation" *IEEE TAMD* (2010)
