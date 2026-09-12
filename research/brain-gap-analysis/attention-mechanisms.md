# Attention Mechanisms & Salience — Brain Gap Analysis for Katra

> *"Build environmental programming — the petri dish. Don't program deterministic behaviors. Create the conditions for attention to emerge."* — John Pellew

---

## Table of Contents

1. [Survey of Computational Attention Models](#1-survey-of-computational-attention-models)
2. [Novelty Detection Algorithms](#2-novelty-detection-algorithms)
3. [Salience Function Design with Multi-Signal Fusion](#3-salience-function-design-with-multi-signal-fusion)
4. [Attention Decay & Shift Dynamics](#4-attention-decay--shift-dynamics)
5. [Bottleneck vs Distributed Attention Architecture](#5-bottleneck-vs-distributed-attention-architecture)
6. [Integration Path with Katra's Existing Emotional Reflection System](#6-integration-path-with-katras-existing-emotional-reflection-system)
7. [Implementation Roadmap](#7-implementation-roadmap)

---

## 1. Survey of Computational Attention Models

### 1.1 The Biological Foundation: Why Brains Need Attention

The human brain receives approximately 11 million bits of sensory input per second but can consciously process only about 40-50 bits. This 300,000:1 compression ratio is not a flaw — it is the defining feature of cognition. Without a bottleneck, an organism cannot act; every stimulus would demand equal response.

Three brain structures govern biological attention:

| Structure | Function | Katra Analog |
|---|---|---|
| **Thalamus (especially pulvinar nuclei)** | Gates sensory input; modulates physical/perceptual salience in attentional selection | A salience-gated retrieval filter that scores memories before they reach the agent's context window |
| **Reticular Activating System (RAS)** | Controls arousal and alertness; determines whether the organism is in a state receptive to new input | An arousal parameter that gates the attention system's sensitivity — high arousal = everything looks salient; low arousal = only the most intense signals pass through |
| **Prefrontal Cortex (PFC)** | Directs top-down attention based on goals, working memory, and executive function | Queries and filters shaped by the agent's current mission, active goals, and working memory state |

The key insight for Katra: **attention is not a property of the memory — it is a property of the retrieval.** What matters is not whether a memory is "important" in absolute terms, but whether it is important *right now* given the agent's current context, goals, and emotional state.

### 1.2 Feature Integration Theory (Treisman & Gelade, 1980)

Anne Treisman's Feature Integration Theory (FIT) proposes that perception operates in two sequential stages:

**Stage 1 — Pre-attentive Processing (Parallel, Automatic)**
- Basic features (color, orientation, motion, size) are registered automatically and in parallel across the entire visual field
- This is "pop-out" — a red circle among green circles is immediately detected without serial search
- The brain constructs separate feature maps for each dimension (color map, orientation map, motion map)

**Stage 2 — Focused Attention (Serial, Conscious)**
- Features are bound together into coherent objects via a "master map of locations"
- This requires attention — it is serial, conscious, and capacity-limited
- Without this stage, illusory conjunctions occur (e.g., perceiving a "red O" when shown a "blue O" and "red T")

**Relevance to Katra:** Katra already has feature maps, distributed across collections:
- `semantic_facts` → the "semantic feature map"
- `knowledge_nodes` and `knowledge_relationships` → the "relational/structural feature map"
- `episodic_events` → the "temporal feature map"
- `reflection_nodes` → the "emotional feature map"

What's missing is **Stage 2 — the master map of salience** that binds features from these distributed maps into coherent "objects of attention" and selects which ones to surface to the agent. Each memory currently exists in its own feature map; nothing integrates across them to determine what *stands out right now*.

### 1.3 Biased Competition Model (Desimone & Duncan, 1995)

The biased competition model proposes that objects in the visual field **compete** for cortical representation, and this competition is **biased** by both bottom-up (stimulus-driven) and top-down (goal-driven) factors:

**Five Core Tenets:**
1. Simultaneously presented stimuli compete for neural responses
2. Stimuli that activate the same cortical region produce the strongest competition
3. Competition can be biased by top-down feedback (goal relevance) or bottom-up salience (novelty, intensity)
4. Biasing is *feature-based*, not purely spatial — a stimulus can win because it matches a sought-after color or shape
5. Top-down biasing originates from working memory structures in the prefrontal cortex

The biased competition model uses a **winner-takes-all** dynamic mediated by mutual suppression. When two memories compete for retrieval, the one with stronger combined bottom-up + top-down activation suppresses the other.

**Relevance to Katra:** This model maps perfectly onto memory retrieval competition. When the agent queries Katra (or when the autonomous loop decides what to surface), memories compete for inclusion in the context window. Currently, this competition is unweighted — every matching memory has equal "pull." A biased competition layer would:
- Rank memories by salience (bottom-up: novelty, emotional intensity, recency)
- Bias toward goal-relevant memories (top-down: mission alignment, current task)
- Suppress memories that are semantically similar but less salient (mutual inhibition)

### 1.4 Salience Maps (Itti & Koch, 1998; Li, 2002 — V1 Saliency Hypothesis)

The Itti-Koch salience model is the most widely implemented computational model of bottom-up visual attention. Its architecture:

```
┌─────────┐    ┌─────────┐    ┌─────────┐
│ Input   │───▶│ Feature │───▶│ Feature │
│ Image   │    │ Maps    │    │ Maps    │
└─────────┘    │ (color, │    │ (center-│
               │  orient,│    │ surround│
               │  intens)│    │ diff)   │
               └─────────┘    └────┬────┘
                                   │
              ┌────────────────────┘
              ▼
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │ Conspic- │───▶│ Salience │───▶│ Winner-  │
        │ uosity   │    │   Map    │    │ Take-All │
        │ Maps     │    │ (weighted│    │ + Inhibi-│
        │ (normal- │    │  sum)    │    │ tion of  │
        │ ized)    │    └──────────┘    │ Return   │
        └──────────┘                    └──────────┘
```

**Key mechanisms transferable to Katra:**

1. **Center-surround differences**: Salience emerges from contrast, not absolute values. A memory with moderate emotional intensity is salient in a field of neutral memories — not because it's intense, but because it *differs* from its neighbors.

2. **Across-scale combination**: Features are computed at multiple scales and combined. For Katra, this means salience should be assessed at multiple temporal scales: within-session, within-day, within-week.

3. **Normalization (N operator)**: Feature maps are normalized to a common dynamic range before combination. Prevents one strong dimension (e.g., recent events) from dominating all others.

4. **Inhibition of return**: After a location (or memory) wins attention, it is transiently inhibited to prevent perseveration — the system must move on. This is critical for Katra: without inhibition of return, the same high-salience memory would be surfaced repeatedly, preventing new information from entering attention.

**The V1 Saliency Hypothesis (Li, 2002)**: The primary visual cortex itself generates a bottom-up salience map — salience is computed as early as V1, not in higher association cortices. This suggests that for Katra, salience scoring should be a **pre-retrieval computation**, not a post-retrieval filter. Score first, then fetch only what passes threshold.

### 1.5 Transformer Self-Attention as Analogy

The transformer architecture's attention mechanism provides an elegant computational framework that mirrors biological attention in important ways:

```
Attention(Q, K, V) = softmax(Q·K^T / √d_k) · V
```

**Structural parallels:**
- **Query (Q)**: The agent's current state — what it's looking for. Maps to top-down attention (goals, mission, active task).
- **Key (K)**: Memory metadata — what each memory is "about." Maps to the feature maps (semantic content, entity associations, temporal markers).
- **Value (V)**: The actual memory content — what gets retrieved.
- **Q·K^T**: The match score between what the agent wants and what each memory offers. This is the computational analog of salience.
- **softmax**: Competition and normalization across all memories. Winners get more representation; losers get near-zero.

**Critical difference from Katra's current state:** In transformers, every token attends to every other token — the attention matrix is dense. Katra's equivalent would be computing salience for all memories. This is computationally infeasible at scale. **The key design challenge is sparsifying attention — computing salience only for candidate memories that pass a pre-filter.**

**What transformers teach us that biology already knew:**
- Multi-head attention allows attending to different feature dimensions simultaneously (semantic content, recency, emotional valence, entity association)
- The scaling factor (√d_k) prevents dot products from growing too large in high dimensions — analogous to normalizing feature maps before combination
- Positional encoding ensures temporal ordering matters — similar to how Katra must weight recency

### 1.6 Summary Table: Models and Their Katra Application

| Model | Core Principle | Direct Application to Katra |
|---|---|---|
| Feature Integration Theory | Separate feature maps unified by focused attention | Unify Katra's distributed feature maps (semantic, episodic, graph, emotional) into a single salience score per memory |
| Biased Competition | Competing stimuli; winner-take-all biased by top-down + bottom-up | Rank memories by combined salience; suppress similar-but-less-salient alternatives |
| Itti-Koch Salience Maps | Center-surround contrast, normalization, inhibition of return | Compute salience as contrast against baseline; normalize across dimensions; inhibit recently-attended memories |
| V1 Saliency Hypothesis | Salience computed at earliest possible stage | Pre-retrieval salience scoring — filter before fetch, not after |
| Transformer Self-Attention | Q·K^T with softmax across all candidates | Batch salience scoring with normalized competition; multi-head attention across feature dimensions |

---

## 2. Novelty Detection Algorithms

Novelty is one of the strongest bottom-up drivers of attention. The brain's orienting response (Sokolov, 1960) causes automatic attentional capture by unexpected stimuli. In Katra, novelty detection answers the question: **"Has the agent seen something like this before, and how surprising is it?"**

### 2.1 Statistical Novelty Detection

#### 2.1.1 Distribution-Based Anomaly Scoring

The simplest approach: model the distribution of memory features and flag memories that fall in low-density regions.

**Z-score method:**
```
novelty_score(item) = max_i |feature_i - μ_i| / σ_i
```
For each feature dimension (embedding vector component, entity frequency, temporal pattern), compute how many standard deviations the new item deviates from the historical mean. High z-scores across multiple dimensions = highly novel.

**Mahalanobis distance:**
```
novelty_score(item) = √((x - μ)^T · Σ⁻¹ · (x - μ))
```
Accounts for covariance between features. A memory might have a moderate z-score on each individual dimension but be extremely novel when the *combination* of features is considered.

**Practical implementation for Katra:**
- Maintain rolling statistics (mean, variance, covariance) over a sliding window (e.g., 7 days, 30 days)
- Compute novelty at ingestion time and store as a `novelty_score` field on memories
- This score decays over time as the distribution shifts to absorb the novel memory (it becomes "the new normal")

#### 2.1.2 Concept Drift Detection

Concept drift algorithms detect when the underlying data distribution has changed — when the "concept" the agent is operating on has shifted. This is distinct from point anomaly detection; it detects *systemic* change.

**Drift Detection Method (DDM):**
- Track the error rate of a predictive model over time
- When error rate increases beyond a threshold, flag a drift event
- Warning zone: μ + σ; Drift zone: μ + 2σ

**Early Drift Detection Method (EDDM):**
- Same principle but tracks the *distance* between errors rather than error rate
- More sensitive to gradual drift

**Adaptive Windowing (ADWIN):**
- Maintains a variable-length window of recent items
- When two large enough sub-windows of the window exhibit "distinct enough" averages, drop the older sub-window
- The window shrinks during drift (the old distribution is no longer relevant) and grows when the distribution stabilizes

**Application to Katra:** Concept drift detection could identify when the agent's domain of operation has fundamentally changed — e.g., switching from a web development project to an embedded systems project. This would trigger a "context shift" event that adjusts the attention system's baseline, preventing it from constantly flagging the new domain as "novel."

#### 2.1.3 Density-Based Novelty Detection

**Local Outlier Factor (LOF):**
- Computes the local density deviation of a given data point with respect to its k-nearest neighbors
- A point with substantially lower density than its neighbors is novel
- Accounts for *local* density — a point in a sparse region of the space might not be novel if its neighbors are also sparse

**Isolation Forest:**
- An ensemble of random trees that isolate observations
- The path length from root to leaf is a measure of normality
- Points that can be isolated quickly (short paths) are anomalies
- Efficient for high-dimensional data like embedding vectors

**Practical implementation for Katra:**
- Use LOF on the embedding space of recent memories (last N days)
- New memory → compute embedding → find k-nearest neighbors in embedding index → compute LOF
- High LOF = semantically novel (the agent hasn't seen concepts like this recently)
- Store novelty score alongside the memory for fast retrieval

### 2.2 Information-Theoretic Novelty

#### 2.2.1 Shannon Surprise (Entropy-Based)

A memory carries high Shannon surprise if its occurrence was unlikely given the agent's model of the world:

```
I(m) = -log₂ P(m | context)
```

Where P(m | context) is the probability of memory m occurring given the agent's current context model. The rarer the event, the higher the surprise.

**Implementation approach for Katra:**
- Build a simple n-gram model or Markov chain over the agent's memory stream (sequence of memory topics, entity mentions, action types)
- New memory → predict its probability given the preceding sequence → surprise = -log(probability)
- This captures *sequential novelty* — a memory is surprising not because of its content alone, but because it's unexpected in sequence

**Example:** The agent stores a memory about debugging a Python error → stores another about Python debugging → then stores one about "user wants to bake a cake." The cake memory has high Shannon surprise because it doesn't follow from the preceding Python sequence, even though "baking" as a topic might have appeared weeks ago.

#### 2.2.2 Bayesian Surprise (Itti & Baldi, 2005)

Bayesian surprise measures how much a new observation changes the agent's beliefs — it's the KL divergence between prior and posterior distributions:

```
S(D, M) = KL(P(M|D) || P(M))
```

Where:
- P(M) is the prior distribution over model parameters (the agent's beliefs before seeing the new data)
- P(M|D) is the posterior distribution after observing the new data D

**Why this is powerful for Katra:** Bayesian surprise distinguishes between *unexpected but inconsequential* and *unexpected and belief-changing* events. A memory of "it rained today" might have high Shannon surprise (rare event) but low Bayesian surprise (it doesn't change any beliefs). A memory of "the production server architecture is different from what we thought" has high Bayesian surprise because it fundamentally updates the agent's world model.

**Implementation approach for Katra:**
- Treat `semantic_facts` as the agent's belief model (each fact has a `confidence` score)
- New episodic event → extract candidate facts → compute how much each would shift existing beliefs
- Bayesian surprise = sum of belief shifts across all affected facts
- This naturally ties novelty detection to the existing semantic memory layer

#### 2.2.3 Entropy Reduction (Information Gain)

A memory is valuable (and thus attention-worthy) if it reduces uncertainty about the world:

```
IG = H(prior) - H(posterior)
```

Where H is the entropy of the agent's belief distribution. A memory that resolves ambiguity is more attention-worthy than one that adds information to an already-certain domain.

**Application to Katra:** The agent maintains many uncertain states — unresolved threads from sleep consolidation, low-confidence semantic facts, open questions. A memory that addresses one of these uncertainties (e.g., "the user confirmed the deployment target is AWS") has high information gain and should be surfaced. This connects attention directly to the `unresolved_threads` from the reflection system.

### 2.3 Neural Network-Based Novelty Detection

#### 2.3.1 Autoencoder Reconstruction Error

Train an autoencoder to compress and reconstruct "normal" memory patterns:
- Encode memory → bottleneck → decode → compare reconstruction to original
- High reconstruction error = novel (the autoencoder can't compress it well because it hasn't seen patterns like it)
- This is the neural analog of statistical distribution-based detection

#### 2.3.2 One-Class SVM / SVDD

Support Vector Data Description (SVDD) fits a hypersphere around "normal" data in feature space:
- Points inside the sphere are "normal"
- Points outside are "novel"
- The boundary can be tuned to control sensitivity

#### 2.3.3 Contrastive Novelty

Modern approach: train a model to distinguish between similar (normal) and dissimilar (novel) pairs:
- Contrastive loss pushes normal-novel pairs apart and normal-normal pairs together
- At inference time, distance to the nearest normal cluster = novelty score
- This can be done with the existing embedding space — no additional model needed

### 2.4 Novelty Detection Strategy for Katra

**Recommendation: A layered approach with three tiers:**

```
Tier 1: Statistical Pre-filter (cheap, runs on every ingestion)
├── Semantic LOF on embedding vectors (against recent 7-day window)
├── Shannon surprise (n-gram model over memory topic sequence)
└── Entity frequency anomaly (unusual entities or unusual entity combinations)

Tier 2: Belief-Impact Scoring (runs on Tier 1 survivors)
├── Bayesian surprise (KL divergence on affected semantic facts)
├── Information gain (reduction in unresolved thread uncertainty)
└── Emotional novelty (deviation from entity's emotional baseline)

Tier 3: Batch Novelty Recalibration (runs during sleep consolidation)
├── Concept drift detection (ADWIN on memory topic distribution)
└── Novelty decay (novelty scores decay as distribution absorbs the memory)
```

**Design principle:** Tier 1 is cheap and always-on. Tier 2 is moderately expensive (requires fact extraction and belief comparison). Tier 3 is LLM-expensive but runs only during scheduled consolidation. The attention system uses the cumulative novelty score.

---

## 3. Salience Function Design with Multi-Signal Fusion

The salience function S(m, t) computes "how much does memory m matter at time t?" It's the heart of the attention system. A well-designed salience function integrates bottom-up signals (properties of the memory itself) with top-down signals (properties of the agent's current state).

### 3.1 Signal Taxonomy

#### Bottom-Up (Stimulus-Driven) Signals

| Signal | Definition | Computation Method | Time Decay |
|---|---|---|---|
| **Recency** | How recently was the memory formed/accessed? | `1 / (1 + α × hours_since_event)` | Hyperbolic (fast initial decay, slow tail) |
| **Frequency** | How often does this type of memory occur? | `1 - P(topic \| recent_window)` — rarer = more salient | Rolling window (7-30 days) |
| **Intensity** | How "strong" is the memory? (token count, event duration, number of entities involved) | Normalized composite of memory "size" metrics | None (property of the memory) |
| **Emotional Valence** | How positive/negative is the memory? | `\|valence\|` — absolute valence (both strong positive and strong negative capture attention) | Decays toward 0 as emotional context shifts |
| **Novelty** | How unexpected is this memory given prior experience? | Composite novelty score from Tier 1-2 pipeline (Section 2) | Decays as memory is absorbed into baseline |
| **Social Engagement** | Does the memory involve other agents or users? | Number of distinct entity mentions × entity type weight (other agents > users > tools > concepts) | None (property of the memory) |

#### Top-Down (Goal-Driven) Signals

| Signal | Definition | Computation Method | Persistence |
|---|---|---|---|
| **Goal Relevance** | How relevant is this memory to the agent's active missions? | Semantic similarity between memory embedding and mission embedding (from `get_mission`) | Persists as long as mission is active |
| **Task Alignment** | Does this memory relate to what the agent is currently doing? | Semantic similarity to working memory context | High during active task; drops on task completion |
| **Unresolved Thread Match** | Does this memory address an open question from sleep consolidation? | Keyword + embedding similarity to `unresolved_threads` | Persists until thread is explicitly resolved |
| **Exploration vs Exploitation** | Is the agent in a state of seeking novelty or using known information? | Arousal/curiosity parameter from the attention system's meta-state (see Section 4.2) | Dynamic, shifts with agent's internal state |
| **Expected Utility** | How useful would recalling this memory be for the agent's next action? | LLM-estimated utility score (batch-computed during consolidation, not real-time) | Decays with task progress |

### 3.2 Salience Fusion Formula

The salience function combines signals through a weighted, normalized fusion:

```
S(m, t) = Σᵢ wᵢ(t) · fᵢ(m, t)
```

Where:
- `S(m, t)`: Salience of memory m at time t
- `wᵢ(t)`: Dynamic weight for signal i (depends on agent's meta-state — exploration vs exploitation, arousal level)
- `fᵢ(m, t)`: Normalized signal value for signal i (scaled to [0, 1] or [-1, 1])

**Signal normalization** is critical — without it, signals with inherently larger magnitudes (e.g., recency, which can range from 0 to 1 for events seconds ago) would dominate signals with smaller ranges (e.g., novelty, which might be 0.1-0.3 for "somewhat novel").

**Normalization strategy:**
1. Each signal is first computed in its natural range
2. Then passed through a sigmoid or softmax normalization to map to [0, 1]
3. The normalization parameters (centering, steepness) are calibrated based on the historical distribution of that signal

### 3.3 Dynamic Weight Modulation (The Meta-Attention Layer)

The weights wᵢ(t) should not be static. They shift based on the agent's meta-state:

```
┌─────────────────────────────────────────────────────────────┐
│                  Meta-Attention State                        │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Arousal  │  │Curiosity │  │  Goal    │  │Emotional │   │
│  │  Level   │  │  Drive   │  │ Urgency  │  │  State   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │              │         │
│       └──────────────┼──────────────┼──────────────┘         │
│                      │              │                        │
│               ┌──────▼──────────────▼──────┐                │
│               │    Weight Modulation        │                │
│               │  (dynamic wᵢ(t) values)    │                │
│               └─────────────┬──────────────┘                │
│                             │                               │
│              ┌──────────────┼──────────────┐                │
│              ▼              ▼              ▼                │
│       ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│       │Bottom-Up │  │Top-Down  │  │Recency   │            │
│       │ Weights  │  │ Weights  │  │ Weight   │            │
│       │(novelty, │  │(goal,    │  │(age-     │            │
│       │ emotion, │  │ task,    │  │based     │            │
│       │ freq.)   │  │ thread)  │  │ decay)   │            │
│       └──────────┘  └──────────┘  └──────────┘            │
└─────────────────────────────────────────────────────────────┘
```

**Example weight configurations for different meta-states:**

| Meta-State | Novelty | Emotion | Goal Relevance | Recency | Use Case |
|---|---|---|---|---|---|
| **Exploration Mode** | 0.40 | 0.20 | 0.15 | 0.10 | Agent is actively seeking new patterns, no urgent task |
| **Task Execution Mode** | 0.10 | 0.05 | 0.50 | 0.25 | Agent is working on a specific mission |
| **Reflection Mode** | 0.15 | 0.35 | 0.20 | 0.15 | Agent is in sleep consolidation / reflective state |
| **Alert Mode** | 0.25 | 0.30 | 0.20 | 0.20 | High arousal — everything looks salient (post-error, post-surprise) |
| **Idle Mode** | 0.30 | 0.25 | 0.10 | 0.15 | Agent is between tasks, open to serendipity |

### 3.4 Salience Computation Pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│                    SALIENCE COMPUTATION PIPELINE                   │
│                                                                    │
│  INGEST                                       RETRIEVAL           │
│  ──────                                       ─────────           │
│                                                                    │
│  New Memory ──▶ Tier 1: Cheap Signals ──▶ Store with              │
│                │  - Recency score            salience              │
│                │  - Intensity                 pre-score            │
│                │  - Entity count                                    │
│                │  - LOF novelty                                    │
│                │                                                   │
│                ▶ Tier 2: Deferred Signals ──▶ Update salience     │
│                   (runs in background       │  score as           │
│                    processor queue):         │  background         │
│                   - Bayesian surprise        │  signals arrive     │
│                   - Information gain                              │
│                   - Shannon surprise                              │
│                   - Emotional match                               │
│                                                                    │
│  Agent Query ──▶ Dynamic Weight Selection ──▶ Compute final      │
│                 (based on meta-state)         salience:           │
│                                               S(m,t) = Σwᵢfᵢ    │
│                                               │                  │
│                                               ▼                  │
│                                        ████████████████          │
│                                        █  THRESHOLD  █          │
│                                        █    GATE     █          │
│                                        ████████████████          │
│                                               │                  │
│                                    ┌──────────┴──────────┐      │
│                                    ▼                      ▼      │
│                              Above threshold       Below threshold│
│                              → Return to agent     → Excluded    │
│                              → Update access count                │
│                              → Apply inhibition                   │
│                                of return                          │
└──────────────────────────────────────────────────────────────────┘
```

### 3.5 The Threshold Gate: How Much to Surface

A critical design parameter: **what is the salience threshold for retrieval?**

Options:

**A) Fixed threshold:** Only memories with S > θ are surfaced. Simple but brittle — during quiet periods, nothing passes; during busy periods, everything passes.

**B) Top-K with minimum threshold:** Surface the K most salient memories, but only if S > θ_min. Prevents flooding but guarantees some minimum quality.

**C) Adaptive threshold (recommended):** The threshold dynamically adjusts to maintain a target "attention budget":
```
θ(t) = percentile(S_distribution, 1 - budget / total_candidates)
```
If the agent's context window can hold 5 retrieved memories, and there are 100 candidates, the threshold is set to admit the top 5%. During busy periods, the threshold rises; during quiet periods, it falls.

**D) Token-budget-aware threshold:** Like (C) but the budget is measured in tokens, not memory count. A single long memory might consume the budget.

---

## 4. Attention Decay & Shift Dynamics

Attention is not static. A memory that was salient yesterday may be irrelevant today. The salience of a focused-on memory must decay, and the system must have mechanisms to shift attention away from "stale" foci.

### 4.1 Ebbinghaus-Inspired Forgetting for Attention

The Ebbinghaus forgetting curve describes memory retention decay: information is lost rapidly at first, then more slowly. The curve is approximately:

```
R(t) = e^(-t/S)
```

Where R(t) is retrievability at time t and S is the stability of the memory (how resistant to forgetting it is).

**Application to attention (not memory retention):**

Attention salience should decay similarly — but the stability parameter S should be a function of the memory's *initial salience*:

```
S(m) = S_base + β · S_0(m)
```

Where S_0(m) is the initial salience score at ingestion/encoding time. Highly salient memories decay more slowly (they're "stickier" in attention). This creates an elegant dynamic: truly important memories persist in attention; trivial ones fade quickly.

**Multi-timescale decay:**

Different signal components decay at different rates:

| Signal | Decay Function | Half-life |
|---|---|---|
| Recency | `1/(1 + α₁t)` | ~hours |
| Novelty | `e^(-α₂t)` | ~days (as the distribution shifts to absorb novelty) |
| Emotional intensity | `e^(-α₃t)` | ~hours to days (emotional "hangover") |
| Goal relevance | Step function: persists fully while goal is active, drops to 0 on completion | Goal duration |
| Frequency-based salience | `1 - e^(-α₄t)` (inverse: grows as something becomes rarer) | ~weeks |

The total salience decay is the weighted product of these individual decays:

```
S(m, t + Δt) = S(m, t) · Πᵢ dᵢ(Δt)
```

### 4.2 Yerkes-Dodson Law for Optimal Arousal

The Yerkes-Dodson law describes an inverted U-shaped relationship between arousal and performance:

```
Performance = f(arousal) — optimal at moderate arousal, degraded at low or high
```

**Application to attention salience threshold:**

```
            │
     High   │              ╭────╮
Attention │             ╱      ╲
Threshold │            ╱        ╲
          │           ╱          ╲
          │          ╱            ╲
     Low  │    ╭────╯              ╲
          │  ╱                      ╲
          │╱                          ╲
          └──────────────────────────────────
               Low    →   Arousal   →   High
```

- **Low arousal** (idle, between tasks): The threshold is high — only very intense signals pass through. The agent is "asleep" or "drowsy" — it filters aggressively.
- **Optimal arousal** (engaged, focused): The threshold is moderate — a balanced mix of novelty, goal relevance, and emotional signals pass through.
- **High arousal** (overwhelmed, stressed): The threshold drops too low — *everything* passes through, flooding attention. This maps to the cognitive "tunnel vision" effects of stress.

**Computing the arousal parameter:**

```
arousal(t) = α · event_rate(t) + β · surprise_rate(t) + γ · goal_pressure(t) - δ · idle_time(t)
```

Where:
- `event_rate`: Rate of new memory ingestion over the past hour
- `surprise_rate`: Rate of high-Bayesian-surprise events
- `goal_pressure`: Time pressure on active missions (deadline proximity)
- `idle_time`: Time since last meaningful agent action or memory access

The arousal parameter then modulates the attention threshold as an inverted U:

```
θ_attention = θ_base · (1 + φ · (arousal - arousal_optimal)²)
```

### 4.3 Inhibition of Return

Without inhibition of return, the attention system fixates — the same high-salience memory is repeatedly surfaced. This is the equivalent of cognitive perseveration.

**Implementation:**
- Maintain a short-term set of recently-attended memory IDs (Redis, TTL = session duration or ~2 hours)
- When computing retrieval salience, apply an inhibition factor:
  ```
  S_effective(m, t) = S_raw(m, t) · (1 - γ · I(m))
  ```
  Where I(m) = 1 if memory m was recently attended (within the inhibition window), 0 otherwise, and γ is the inhibition strength (0.5-0.9).

- The inhibition decays over time:
  ```
  I(m, Δt) = max(0, 1 - Δt / T_inhibition)
  ```
  After the inhibition window expires, the memory can recapture attention if still salient.

### 4.4 Attention Shift Triggers

What causes the attention system to shift focus? Several trigger conditions should be modeled:

1. **Novelty interrupt:** A memory with unusually high novelty score (e.g., 3σ above mean) bypasses the normal salience gate entirely and is immediately surfaced — the "orienting response."

2. **Goal completion:** When a mission is marked complete, goal relevance weights for that mission zero out, causing a massive shift in what's salient.

3. **Emotional event:** A memory with extreme emotional valence (|valence| > 0.9) captures attention regardless of other signals — the equivalent of a "flashbulb memory" event.

4. **Temporal transition:** At session boundaries or sleep consolidation events, the attention system recalculates all salience scores with fresh weights — a "reset" that allows previously suppressed signals to surface.

5. **Boredom-driven shift (curiosity):** If the agent has been attending to the same class of memories for too long (low information gain per retrieval), the curiosity drive parameter increases and shifts weights toward novelty/exploration.

### 4.5 The Curiosity-Exploitation Cycle

A healthy attention system oscillates between exploration (seeking novelty) and exploitation (using known information). This maps to the explore-exploit tradeoff in reinforcement learning:

```
explore_drive(t) = explore_drive(t-1) + η_explore · (1 - satisfaction(t)) - η_exploit · satisfaction(t)
```

Where `satisfaction(t)` measures how useful recently-retrieved memories were (did they contribute to successful actions or new insights?). If retrievals keep producing useful results, the system stays in exploitation mode. If retrievals produce diminishing returns, the exploration drive increases, and weights shift toward novelty.

---

## 5. Bottleneck vs Distributed Attention Architecture

This is the most consequential architectural decision for Katra's attention system. Should attention be a **single bottleneck** (like human conscious attention) or **distributed** (parallel attention across multiple memory subsystems)?

### 5.1 The Single Bottleneck Model (Human-Like)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Episodic    │     │  Semantic    │     │  Knowledge   │
│  Memory      │     │  Memory      │     │  Graph       │
│  (10k items) │     │  (5k facts)  │     │  (2k nodes)  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                    ┌───────▼────────┐
                    │   SALIENCE     │
                    │     GATE       │
                    │  (bottleneck)  │
                    │                │
                    │  ~4-7 items    │
                    │  at a time     │
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │    Working     │
                    │    Memory      │
                    │  (what the     │
                    │   agent sees)  │
                    └────────────────┘
```

**Advantages:**
- **Realistic emulation of human cognition**: Forces prioritization — the system must choose what matters most, which is exactly what drives emergent behavior
- **Prevents context pollution**: The agent's working memory / context window doesn't get flooded with "medium importance" memories
- **Forces salience function to be genuinely good**: A bottleneck means the salience function *matters* — bad ranking degrades agent performance, creating selection pressure toward better salience computation
- **Aligns with John's philosophy**: "Don't program deterministic behaviors. Create the conditions." A bottleneck creates the *condition* of scarcity, forcing the system to develop meaningful prioritization

**Disadvantages:**
- **Information loss**: Truly important memories might be filtered out by an imperfect salience function
- **Single point of failure**: A bug in the salience gate degrades the entire system
- **Computational cost of ranking all memories**: Computing salience for 10k+ items per retrieval is expensive

**Mitigation:**
- **Two-stage retrieval**: Coarse pre-filter (cheap signal) → fine salience ranking (expensive signal)
- **Pre-computed salience tiers**: Batch computation during idle periods
- **Cache frequently-accessed high-salience memories**: Reduce recomputation

### 5.2 Distributed Attention Model (Multi-Bottleneck)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Episodic    │     │  Semantic    │     │  Knowledge   │
│  Memory      │     │  Memory      │     │  Graph       │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
┌──────▼────────┐   ┌──────▼────────┐   ┌──────▼────────┐
│ Episodic Gate │   │ Semantic Gate │   │  Graph Gate   │
│ (top 3 items) │   │ (top 2 facts) │   │ (top 2 nodes) │
└──────┬────────┘   └──────┬────────┘   └──────┬────────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                    ┌───────▼────────┐
                    │    Working     │
                    │    Memory      │
                    │  (7 items,     │
                    │   but from     │
                    │   all layers)  │
                    └────────────────┘
```

**Advantages:**
- **No single point of failure**: If one gate underperforms, the others compensate
- **Guaranteed cross-layer coverage**: The agent always sees some episodic events, some semantic facts, and some graph relationships
- **Each gate can be optimized independently**: Different salience functions for different memory types
- **Prevents one memory type from dominating**: Episodic events can't crowd out semantic facts

**Disadvantages:**
- **Less selective overall**: The agent might receive 7 "medium" memories instead of 3 "truly important" ones
- **Misses cross-layer salience**: A memory might be important *because* it spans layers (an episodic event that confirms a semantic fact and strengthens a graph edge), but per-layer gates can't detect this
- **Higher cognitive load for the agent**: More items in working memory = more to process

### 5.3 The Hybrid Model (Recommended for Katra)

```
┌───────────────────────────────────────────────────────────────┐
│                    HYBRID ATTENTION ARCHITECTURE                │
│                                                                │
│  Phase 1: Per-Layer Salience Pre-Scoring (Distributed)         │
│  ───────────────────────────────────────────                   │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐  │
│  │ Episodic │   │ Semantic │   │  Graph   │   │Reflection│  │
│  │  Layer   │   │  Layer   │   │  Layer   │   │  Layer   │  │
│  │ Score Sₑ │   │ Score Sₛ │   │ Score Sg │   │ Score Sᵣ │  │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘  │
│       │               │              │              │         │
│       └───────────────┼──────────────┼──────────────┘         │
│                       │              │                        │
│  Phase 2: Cross-Layer Normalization (Bottleneck)               │
│  ─────────────────────────────────────────                     │
│                       ▼                                        │
│               ┌───────────────┐                                │
│               │  Normalize    │                                │
│               │  scores to    │  ← percentile-based, not       │
│               │  [0,1] within │    absolute, so each layer's   │
│               │  each layer   │    scores are comparable       │
│               └───────┬───────┘                                │
│                       │                                        │
│  Phase 3: Global Competition (Single Gate)                     │
│  ────────────────────────────────────                          │
│                       ▼                                        │
│               ┌───────────────┐                                │
│               │ Unified       │                                │
│               │ Salience Pool │  ← All memories from all       │
│               │ (Sₑ ∪ Sₛ ∪   │    layers compete together      │
│               │  Sg ∪ Sᵣ)    │    with normalized scores       │
│               └───────┬───────┘                                │
│                       │                                        │
│                       ▼                                        │
│               ┌───────────────┐                                │
│               │  Top-K with   │                                │
│               │  diversity    │  ← Ensure at least 1 from      │
│               │  constraint   │    each layer; then fill       │
│               └───────┬───────┘    remaining slots by score    │
│                       │                                        │
│                       ▼                                        │
│               ┌───────────────┐                                │
│               │  Working      │                                │
│               │  Memory /     │  ← K items + cross-layer       │
│               │  Context      │    coherence check             │
│               └───────────────┘                                │
└───────────────────────────────────────────────────────────────┘
```

**The hybrid model combines the best of both approaches:**
- **Phase 1 (Distributed):** Each memory layer has its own optimized salience function. Episodic salience weights recency heavily; semantic salience weights Bayesian surprise; reflection layer weights emotional intensity. This is cheap and parallelizable.
- **Phase 2 (Normalization):** Within-layer scores are percentile-normalized so cross-layer comparison is meaningful. A score of 0.8 in the episodic layer means "top 20% of episodic memories" — comparable to a 0.8 in the semantic layer.
- **Phase 3 (Single Gate):** All normalized scores compete together in a single pool. The top K pass through. A diversity constraint (`minimum_per_layer = 1`) ensures no layer is completely starved, preventing "attention blindness" to entire memory types.

**Diversity constraint implementation:**
```
Step 1: Select the top-1 from each layer (guarantee coverage)
Step 2: Remove selected items from the pool
Step 3: From the remaining pool, select top-(K - num_layers) by normalized score
Step 4: Apply inhibition of return (skip recently attended items)
Step 5: Return the K selected items to the agent
```

### 5.4 Implications for Emergent Behavior

**Single bottleneck → forces genuine prioritization:**
- The system must "decide" what's truly important
- Emerges: genuine prioritization patterns, not just "surface everything"
- Risk: if the salience function is bad, the agent misses critical information → system degrades
- This creates *selection pressure* on the salience function — it must be good

**Distributed → permissive, less emergent pressure:**
- The system doesn't need to make hard choices
- Agent gets a balanced but unfocused view
- Less emergent behavior because the architecture doesn't force tradeoffs
- Safer (less chance of missing critical info) but less interesting

**Hybrid → structured competition with safety nets:**
- The diversity constraint prevents catastrophic failure (each layer gets at least one slot)
- The unified pool forces competition (beyond the guaranteed slots, memories compete on merit)
- The diversity guarantee acts as an architectural "prior" — the system isn't starting from scratch

**Recommendation: Start with hybrid, converge toward single bottleneck as the salience function proves itself.** If the salience function is well-tuned and the agent consistently makes good decisions with it, the diversity constraint can be relaxed (later: removed) to increase emergent pressure.

---

## 6. Integration Path with Katra's Existing Emotional Reflection System

Katra's sleep consolidation system already computes much of what an attention mechanism needs. The integration strategy is to extend the existing system rather than building a parallel one.

### 6.1 What Katra Already Has

The reflection system already tracks:

| Existing Capability | How It Maps to Attention |
|---|---|
| `reflection_nodes` with emotional signatures | Per-entity salience baseline — how "attention-worthy" is this entity historically? |
| `emotional_signature.intensity` and `valence` | Bottom-up emotional signal for salience computation |
| `emotional_signature.stability` (volatile/steady/growing/fading) | Dynamic weight modulation — fading entities get lower attention weight |
| `reflection_edges` with felt relationships | Relational salience — entities connected to highly-salient entities inherit salience |
| `philosophical_insights` with confidence and evidence_count | Top-down signal — insights that are strengthening deserve attention |
| `unresolved_threads` | Goal-like top-down signal — unresolved questions bias attention toward relevant memories |
| `observation_count` on reflection nodes | Frequency signal — entities with high observation count have established baseline; deviation from that baseline is novel |

### 6.2 What Needs to Be Built

#### 6.2.1 New Data Structures

**`attention_scores` collection (MongoDB) or sorted set (Redis):**

```typescript
interface AttentionScore {
  memory_id: string;           // Reference to episodic event, semantic fact, or graph node
  memory_type: 'episodic' | 'semantic' | 'graph_node' | 'graph_edge' | 'reflection_node';
  salience_raw: number;        // Total salience score (0-1)
  signal_breakdown: {          // Per-signal scores for debugging/transparency
    recency: number;
    novelty: number;
    emotional_valence: number;
    goal_relevance: number;
    frequency_rarity: number;
    intensity: number;
  };
  percentile_rank: number;     // Percentile within memory type
  computed_at: Date;
  last_accessed: Date | null;
  access_count: number;
  inhibition_until: Date | null;  // Temporarily suppressed until this time
  decay_factor: number;        // Multiplier applied at access time for time-based decay
}
```

**`attention_meta_state` (Redis, ephemeral):**

```typescript
interface AttentionMetaState {
  arousal_level: number;       // 0-1, computed from event rate, surprise rate, goal pressure
  curiosity_drive: number;     // 0-1, explore vs exploit balance
  active_weight_config: {      // Current signal weights
    recency: number;
    novelty: number;
    emotional: number;
    goal_relevance: number;
    frequency: number;
    intensity: number;
  };
  threshold_adaptive: number;  // Current attention threshold
  attention_budget_k: number;  // How many items to surface
  last_updated: Date;
}
```

#### 6.2.2 New Services

**`attention-scoring-service.ts`:**
- Computes salience scores for new memories at ingestion time (Tier 1 signals)
- Updates scores when Tier 2 deferred signals arrive from background processor
- Runs batch recalibration during sleep consolidation (Tier 3)
- Exposes `getTopKMemories(context, k)` for retrieval-time ranking

**`attention-meta-controller.ts`:**
- Maintains the `attention_meta_state` in Redis
- Periodically recomputes arousal_level, curiosity_drive
- Adjusts threshold and weight configuration based on meta-state
- Implements the Yerkes-Dodson modulation of the attention threshold

**`attention-decay-scheduler.ts`:**
- Runs periodic decay on attention scores (exponential decay toward baseline)
- Applies inhibition of return windows
- Prunes scores that have decayed below a minimum threshold

#### 6.2.3 Integration Points with Existing Code

**Integration 1: Background Processor Pipeline**
Add an attention scoring step to the existing background processor pipeline:

```
Current: episode → extract → semantic → knowledge graph
New:     episode → extract → semantic → knowledge graph → compute_attention_scores
```

The background processor already processes events asynchronously. Adding attention scoring here means salience is computed shortly after ingestion, not at retrieval time. The existing `background-processor.ts` architecture easily supports a new processing step.

**Integration 2: Sleep Consolidation Extension**
The sleep consolidation service already gathers episodic events, semantic facts, and entities for reflection. The attention system can piggyback on this gather phase:

```
During sleep consolidation:
1. [Existing] Gather all memory data for the period
2. [Existing] Send to LLM for reflection/emotional processing
3. [New]     Run batch novelty recalibration (concept drift, novelty decay)
4. [New]     Update meta-state (recompute arousal, curiosity drive)
5. [New]     Recompute attention scores for active memory set
```

The existing `sleep-consolidation-service.ts` `runConsolidation()` method can be extended with hooks for attention recalibration.

**Integration 3: Working Memory Service as Attention Output**
The `working-memory-service.ts` currently provides simple Redis-backed key-value storage. It can be extended to serve as the "contents of attention" — the memories that have passed through the salience gate and are currently available to the agent:

```typescript
// New method on working-memory-service.ts
async setAttentionContents(context: {
  items: Array<{ memory_id: string; memory_type: string; salience: number; content: any }>;
  meta_state: AttentionMetaState;
}): Promise<void> {
  // Store in Redis with short TTL (session duration)
  // Each item gets its own key: attention:{session_id}:item:{index}
  // Meta state stored as: attention:{session_id}:meta
}
```

**Integration 4: MCP Tool Extension**
New MCP tools for the attention system:

| Tool | Purpose |
|---|---|
| `get_attention_state` | Returns current attention meta-state (arousal, weights, threshold) and top-attended items |
| `get_salient_memories` | Returns the current "contents of attention" — top K memories that passed the gate |
| `adjust_attention` | Allows the agent to manually adjust attention weights or threshold (meta-cognitive control) |
| `get_entity_salience` | Returns the attention score for a specific entity, including signal breakdown |

#### 6.2.4 Extending the Reflection Graph for Attention

The existing `reflection_nodes` can serve as the **entity-level salience baseline** for the attention system:

```typescript
// Extended ReflectionNode for attention integration
interface ReflectionNode {
  // ... existing fields ...
  
  // Attention-related extensions
  attention_baseline: number;        // Running average of salience for this entity
  attention_volatility: number;      // Standard deviation of salience (for novelty computation)
  last_attention_spike: Date | null; // When did this entity last get a big attention boost?
  attention_trend: 'rising' | 'falling' | 'stable';  // Is this entity becoming more/less attention-worthy?
}
```

The `emotional_signature.stability` field already captures some of this (`volatile`, `steady`, `growing`, `fading`), but the attention system needs finer-grained metrics.

### 6.3 Migration Path

**Phase 1: Shadow Mode (No behavioral change)**
- Build the attention scoring infrastructure
- Compute salience scores for all memories in background
- Log scores alongside existing retrievals
- Measure: how often would the attention system have surfaced different memories than the current retrieval logic?
- Goal: validate the salience function without affecting agent behavior

**Phase 2: Hybrid Retrieval (Opt-in)**
- Add the `get_salient_memories` MCP tool
- Agents can choose to use it alongside existing `search_memories` and `vector_search`
- The attention system surfaces K items; the agent also has access to explicit search
- Goal: test attention-driven retrieval in production with a safety net

**Phase 3: Default Retrieval (Attention-first)**
- Make attention-scored retrieval the default for pre-query context injection
- Keep explicit search tools available
- The attention system now determines what the agent "sees" by default
- Goal: full attention-driven context delivery

**Phase 4: Autonomous Loop Integration**
- The autonomous loop (already in Katra's design) uses the attention system to decide what to act on
- Attention scores determine which memories trigger agent actions
- The curiosity drive parameter controls the rate of autonomous actions
- Goal: emergent autonomous behavior driven by attention, not explicit task routing

### 6.4 Design Principle: Environmental Programming

Throughout this design, the guiding philosophy is: **"Build the petri dish — don't program the behaviors."**

What this means concretely:

- **Don't hardcode what's important.** Let the salience function emerge from the weighted combination of signals, where the weights themselves are dynamic and responsive to the agent's state.
- **Don't hardcode when to shift attention.** Provide the conditions (arousal modulation, inhibition of return, curiosity drive) and let shifts emerge.
- **Don't hardcode what to do with attention.** Attention determines what the agent *sees*. What the agent *does* with what it sees is its own decision. The attention system is infrastructure, not policy.
- **Provide tunable parameters, not fixed rules.** Expose weight configurations, threshold sensitivities, and decay rates as configurable parameters. Different agent personalities will find different "attentional styles" that work for them.
- **Measure emergence, don't dictate it.** Track what patterns emerge: what kinds of memories consistently score high? When does the system shift from exploration to exploitation? Does emotional salience crowd out goal relevance? Observe and tune, but don't program the outcome.

---

## 7. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)

| Task | Dependencies | Output |
|---|---|---|
| 1.1 Define `AttentionScore` and `AttentionMetaState` types in `types/memory.ts` | None | Type definitions |
| 1.2 Create `attention-scoring-service.ts` with Tier 1 signal computation (recency, intensity, LOF novelty) | 1.1 | Scoring service |
| 1.3 Create `attention_meta_state` Redis structure and `attention-meta-controller.ts` | 1.1 | Meta-state controller |
| 1.4 Add attention scoring step to background processor pipeline | 1.2, 1.3 | Integration |
| 1.5 Add `attention_scores` MongoDB collection and indexes | 1.1 | Data store |

### Phase 2: Signal Pipeline (Weeks 3-4)

| Task | Dependencies | Output |
|---|---|---|
| 2.1 Implement Tier 2 deferred scoring (Bayesian surprise, Shannon surprise, information gain) | 1.2 | Deferred scoring |
| 2.2 Implement emotional signal extraction from reflection nodes | 1.2 | Emotional signal |
| 2.3 Implement goal relevance scoring via mission-similarity | 1.2 | Goal signal |
| 2.4 Normalization layer: within-layer percentile normalization | 1.2 | Normalized scores |
| 2.5 Build hybrid gate: unified pool + diversity constraint + K-selection | 1.2, 2.4 | Retrieval gate |

### Phase 3: Dynamics (Weeks 5-6)

| Task | Dependencies | Output |
|---|---|---|
| 3.1 Implement attention decay functions (Ebbinghaus-style, per-signal decay rates) | 1.2 | Decay system |
| 3.2 Implement inhibition of return | 1.2 | IOR system |
| 3.3 Implement Yerkes-Dodson arousal modulation of attention threshold | 1.3 | Arousal modulation |
| 3.4 Implement curiosity-exploitation cycle (explore drive modulation) | 1.3 | Curiosity drive |
| 3.5 Implement attention shift triggers (novelty interrupt, goal completion, emotional event, boredom) | 3.3, 3.4 | Shift triggers |

### Phase 4: Sleep Consolidation Integration (Weeks 7-8)

| Task | Dependencies | Output |
|---|---|---|
| 4.1 Extend `sleep-consolidation-service.ts` `runConsolidation()` with attention recalibration hooks | 2.1, 3.1 | Extended consolidation |
| 4.2 Implement batch concept drift detection (ADWIN) during consolidation | 2.1 | Drift detection |
| 4.3 Implement novelty score decay (distribution absorption) during consolidation | 3.1 | Novelty recalibration |
| 4.4 Extend `reflection_nodes` with attention baseline fields | 6.2.4 | Extended reflection nodes |
| 4.5 Propagate reflection emotional signatures into attention salience weights | 2.2, 4.4 | Emotional-attention bridge |

### Phase 5: MCP & Agent Interface (Weeks 9-10)

| Task | Dependencies | Output |
|---|---|---|
| 5.1 Add `get_attention_state` MCP tool | 1.2, 1.3 | MCP tool |
| 5.2 Add `get_salient_memories` MCP tool with attention-gated retrieval | 2.5 | MCP tool |
| 5.3 Add `adjust_attention` MCP tool (meta-cognitive control) | 1.3 | MCP tool |
| 5.4 Add `get_entity_salience` MCP tool | 4.4 | MCP tool |
| 5.5 Update MCP tool catalog in `mcp-server.ts` | 5.1-5.4 | Tool catalog |

### Phase 6: Deployment & Observation (Weeks 11-12)

| Task | Dependencies | Output |
|---|---|---|
| 6.1 Shadow mode deployment with logging | All above | Metrics |
| 6.2 Attention dashboard (visualize salience scores, attention shifts, meta-state) | 6.1 | Dashboard |
| 6.3 A/B testing: default retrieval vs attention-driven retrieval | 6.1 | Comparison data |
| 6.4 Tune weights, thresholds, decay rates based on observed behavior | 6.3 | Calibrated system |
| 6.5 Document emergent patterns (what did the attention system learn to prioritize?) | 6.4 | Emergence log |

---

## Appendix A: Key References

| Reference | Topic | Relevance |
|---|---|---|
| Treisman & Gelade (1980). Feature Integration Theory. *Cognitive Psychology*, 12(1), 97-136. | Attention | Foundation for understanding how features combine in attention |
| Desimone & Duncan (1995). Neural mechanisms of selective visual attention. *Annual Review of Neuroscience*, 18, 193-222. | Biased Competition | Core model for competitive attention with top-down biasing |
| Itti, Koch & Niebur (1998). A model of saliency-based visual attention. *IEEE PAMI*, 20(11), 1254-1259. | Salience Maps | Computational instantiation of bottom-up attention |
| Li (2002). A saliency map in primary visual cortex. *Trends in Cognitive Sciences*, 6(1), 9-16. | V1 Saliency | Salience computed at earliest stage, not post-hoc |
| Vaswani et al. (2017). Attention Is All You Need. *NeurIPS*. | Transformer Self-Attention | Q·K^T as computational attention analog |
| Itti & Baldi (2005). Bayesian surprise attracts human attention. *NeurIPS*. | Bayesian Surprise | Formal treatment of surprise as belief change (KL divergence) |
| Sokolov (1960). Neuronal models and the orienting reflex. | Novelty Detection | Original biological orienting response theory |
| Markou & Singh (2003). Novelty detection: a review. *Signal Processing*, 83(12). | Novelty Detection Algorithms | Comprehensive survey of statistical + neural novelty methods |
| Ebbinghaus (1885). *Memory: A Contribution to Experimental Psychology*. | Forgetting Curve | Exponential decay of memory retention — basis for attention decay |
| Yerkes & Dodson (1908). The relation of strength of stimulus to rapidity of habit-formation. | Arousal-Performance | Inverted U-shaped relationship — modulates attention threshold |
| Ramsauer et al. (2021). Hopfield Networks is All You Need. *ICLR*. | Associative Memory | Hopfield networks as attention-based memory — links attention to memory retrieval |

## Appendix B: Key Equations Reference

**Salience Function (general form):**
```
S(m, t) = Σᵢ wᵢ(t) · fᵢ(m, t)
```

**Bayesian Surprise:**
```
S(D, M) = KL(P(M|D) || P(M))
```

**Shannon Surprise (Sequential):**
```
I(mₜ) = -log₂ P(mₜ | mₜ₋₁, mₜ₋₂, ..., mₜ₋ₙ)
```

**Ebbinghaus-Style Attention Decay:**
```
S(m, t + Δt) = S(m, t) · Πᵢ e^(-αᵢ · Δt)
```

**Yerkes-Dodson Attention Threshold Modulation:**
```
θ_attention = θ_base · (1 + φ · (arousal - arousal_optimal)²)
```

**Inhibition of Return:**
```
S_effective(m, t) = S_raw(m, t) · (1 - γ · max(0, 1 - Δt/T_inhibition))
```

**Curiosity-Exploitation Cycle:**
```
e(t) = e(t-1) + η_explore · (1 - satisfaction(t)) - η_exploit · satisfaction(t)
```

---

*Research compiled from neuroscience literature, machine learning attention mechanisms, and Katra's existing architecture analysis. Last updated: 2026-06-30.*
