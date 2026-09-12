# Memory Decay Models for Katra

> Research for Katra's agentic cognitive memory system — brain-gap analysis.
> **Date:** 2026-06-30
> **Status:** Draft

---

## 1. Survey of Mathematical Models with Formulas

### 1.1 Ebbinghaus Exponential Forgetting Curve (1885)

The original and most famous model of memory decay. Hermann Ebbinghaus memorized nonsense syllables and measured savings (retention) over time.

**Original Formula (Ebbinghaus, 1885):**

```
b = 100k / ((log t)^c + k)
```

Where:
- `b` = savings percentage (retention)
- `t` = time in minutes since learning
- `c` = 1.25, `k` = 1.84 (empirically fit constants)

**Modern Exponential Formulation:**

```
R(t) = e^(-t / S)
```

Or equivalently in the spaced-repetition literature:

```
R(t) = 0.9^(t / S)
```

Where:
- `R(t)` = retrievability at time t (0 to 1)
- `t` = time elapsed since last review/encoding
- `S` = memory stability (the time for R to drop from 100% to 90% — the "half-life")

**Key Properties:**
- **Rapid initial decay** followed by gradual flattening
- **Single parameter** (stability/half-life) controls the curve
- Information is halved after each period (roughly)
- **No frequency effect** — only cares about time since last encoding
- **Drops to near-zero quickly**: at t = 10× half-life, R ≈ 0.01

**Critique:** While simple and intuitive, exponential decay does not match human memory data well beyond short timescales. Real memories show a much longer tail.

---

### 1.2 Power-Law Forgetting (Wixted & Ebbesen, 1991)

Established by Jost (1897) and formalized by Wixted and Ebbesen (1991). **This is now considered the best-fitting model across most experimental memory data.**

**Formula:**

```
R(t) = a · t^(-b)
```

Where:
- `R(t)` = retention (proportion recalled, 0 to 1)
- `t` = time since learning
- `a` = initial memory strength (encoding quality)
- `b` = rate of forgetting (power-law exponent)

**Key Properties:**
- **Long tail**: memories never truly hit zero — they approach zero asymptotically but much more slowly than exponential
- **Better fit** than exponential across weeks, months, and years
- **Mirrors environmental statistics**: Anderson & Schooler (1991) showed that the probability information will be needed again follows a power law of elapsed time — memory is rationally adapted to information relevance patterns
- **Two parameters** (a, b) allow tuning of initial strength and decay rate

**Comparison — Power Law vs Exponential at Different Timescales (d=0.5 vs λ=0.001):**

| Time Since Access | Power-Law (d=0.5) | Exponential (λ=0.001) |
|---|---|---|
| 1 hour (3,600s) | 0.0167 | 0.027 |
| 1 day (86,400s) | 0.0034 | ~1.2 × 10⁻³⁸ |
| 1 week (604,800s) | 0.0013 | ~0 |
| 1 month (2.6M s) | 0.00062 | ~0 |

The exponential drops to effectively zero within a day, while power-law maintains meaningful accessibility for weeks to months.

---

### 1.3 ACT-R Base-Level Activation (Anderson, 1993–present)

The ACT-R cognitive architecture implements power-law decay directly in its declarative memory system. This is arguably the most well-tested computational model of human memory decay.

**Formula:**

```
B(t) = ln( Σᵢ₌₁ⁿ (t - tᵢ)^(-d) )
```

Where:
- `B(t)` = base-level activation at current time t (higher = more accessible)
- `n` = number of times this memory chunk has been accessed
- `tᵢ` = timestamp of the i-th access
- `t` = current time
- `d` = decay exponent (typically **0.5**, the default ACT-R value)
- `ln()` = natural log compresses the range

**How It Works:**

Each access contributes a term `(t - tᵢ)^(-d)` to the sum. Recent accesses contribute large values; old accesses contribute small values. The sum captures both **recency** (how long ago) and **frequency** (how many times) — with power-law diminishing returns on both axes.

**Example Calculation:**
- Memory A: accessed once, 86,400s ago (1 day) → contribution = (86400)^(-0.5) = 0.0034 → B = ln(0.0034) = **-5.68**
- Memory B: accessed 10 times over the past month, most recently 1 week ago → sum ≈ 0.012 → B = ln(0.012) = **-4.42**

Memory B has **higher activation** (less negative) despite being less recently accessed, because accumulated frequency outweighs recency. **This is the killer feature** — it automatically balances recency and frequency without separate parameters.

**Normalization for Retrieval:**
Raw B values are negative (typically -8 to +2). Pass through sigmoid for use alongside similarity scores:

```python
def normalize(bla):
    return 1.0 / (1.0 + math.exp(-bla))
```

Maps B=-5 → 0.007, B=-2 → 0.12, B=0 → 0.5, B=+2 → 0.88.

**Parameter `d` Behavior:**
- `d = 0.5` (default): moderate decay, good for general declarative memory
- `d < 0.5` (e.g., 0.3): slower decay, memories persist longer
- `d > 0.5` (e.g., 0.7): faster decay, useful for working/short-term memory simulation
- `d = 0.0`: no decay (all accesses contribute equally, B = ln(n))

---

### 1.4 Spaced Repetition Algorithms

#### 1.4.1 SM-2 (SuperMemo 2, Wozniak, 1987)

The first computer algorithm for optimal spaced repetition scheduling. Still used by Anki (in modified form).

**Core Mechanism — Easiness Factor (EF):**

```
EF' = EF + (0.1 - (5 - q) × (0.08 + (5 - q) × 0.02))
```

Where:
- `EF` = easiness factor (starts at 2.5, clamped to ≥1.3)
- `q` = quality of recall (0-5, where 5 = perfect, 0 = total blackout)

**Interval Calculation:**
```
I(1) = 1 day          (first interval)
I(2) = 6 days         (second interval)
I(n) = I(n-1) × EF    (subsequent intervals, n ≥ 3)
```

If recall fails (q < 3): reset interval to 1 day, reset EF to starting value.

**Key Properties:**
- Simple, deterministic, well-understood
- EF adapts to individual item difficulty
- No modeling of the forgetting curve itself — purely a scheduling heuristic
- **No decay function** — it schedules when to review, not how retrievability changes between reviews

#### 1.4.2 Leitner System (Leitner, 1972)

Physical/manual system using boxes:
- **Box 1**: review daily
- **Box 2**: review every 2 days
- **Box 3**: review every 4 days
- ... (typically geometric progression)
- Correct recall → promote to next box (longer interval)
- Incorrect recall → demote to box 1

Not a mathematical model per se, but the simplest form of spaced repetition. The intervals are fixed, not adaptive to item difficulty.

#### 1.4.3 FSRS — Free Spaced Repetition Scheduler (v6, 2025)

The state-of-the-art open-source algorithm now used by Anki (since version 25.07). Based on the **DSR model** (Difficulty, Stability, Retrievability) originally proposed by Piotr Wozniak.

**Forgetting Curve (FSRS-6):**

```
R(t, S) = (1 + w20 × t / (9 × S))^(-1/w20)
```

Where:
- `R` = retrievability (probability of successful recall, 0 to 1)
- `t` = elapsed time since last review
- `S` = memory stability (time for R to drop to 90%)
- `w20` = personalizable parameter (0.1 to 0.8, typically <0.2 for most users)

When `t = S`: R = 90% (by definition of stability).
This is a power function, chosen because it better fits real-world review data than exponential.

**Stability Update (successful review):**

```
S' = S × SInc
SInc = 1 + e^(w8) × f(D) × f(S) × f(R) × w15 × w16
```

Where:
- `SInc` = stability increase factor (≥1)
- `f(D)` = function of difficulty: `(11 - D)` → harder material gives smaller boost
- `f(S)` = function of current stability: larger S → smaller boost (diminishing returns, stability saturates)
- `f(R)` = function of retrievability at review time: **lower R → larger boost** (reviewing when almost forgotten gives the biggest stability gain)
- `w15`, `w16` = grade-dependent multipliers (Hard/Good/Easy)
- `w8` = global scale parameter
- `D` = difficulty (1-10), updated after each review

**Stability Update (failed review — "Again"):**

```
S' = min(w11 × S^w12 × f(D), S)
```

Post-lapse stability can never exceed pre-lapse stability. `w11, w12` are optimizable parameters.

**Difficulty Update:**
```
D' = D + ΔD × (10 - D)/9
ΔD = grade_based_change
```

With "mean reversion" toward a default value (`w4`). Pressing "Again" adds a lot to D, "Hard" adds a little, "Good" = neutral, "Easy" subtracts.

**Key Properties:**
- **19+ optimizable parameters** (w0–w20) — trained on user's review history
- **DSR triad**: Difficulty (static trait), Stability (storage strength), Retrievability (momentary access)
- **Desired retention** (DR): user sets target (e.g., 90%), intervals calculated to maintain it
- **Personalized**: parameters are optimized per-user from their review data
- Power-law forgetting curve with personalizable exponent

**Comparison of Algorithms:**

| Feature | Leitner | SM-2 | FSRS |
|---|---|---|---|
| Model | Box levels | Easiness Factor | DSR (19+ params) |
| Forgetting curve | None | None | Power-law with w20 |
| Adaptive difficulty | ✗ | ✓ (EF) | ✓ (D parameter) |
| Personalized to user | ✗ | ✗ | ✓ (per-user training) |
| Handles lapses | Simple reset | EF reset | Separate post-lapse formula |
| Parameter count | 0 (fixed intervals) | 2 (EF, interval) | 19+ (optimized) |

---

### 1.5 Interference Theory (McGeoch, 1932; Underwood, 1957)

Not a decay function per se, but a complementary mechanism. Interference theory proposes that forgetting is caused not by time passing, but by **competition between similar memories**.

**Types of Interference:**

1. **Proactive Interference (PI):** Old memories interfere with retrieval of new memories
   - Example: Learning Spanish vocabulary, then trying to recall newly learned Italian words — Spanish intrudes
   - Mechanism: "old blocks new"

2. **Retroactive Interference (RI):** New memories interfere with retrieval of old memories
   - Example: Learning a new phone number overwrites recall of the old one
   - Mechanism: "new overwrites old"

**Key Finding (Underwood, 1957):** Re-analyzed Ebbinghaus data and found that **most forgetting was due to interference from previously learned materials**, not time-based decay alone.

**Mathematical Formulation (loose):**

```
Effective_Retrievability(memory_m) = Base_Decay(m) - Σᵢ Interference(m, i)
```

Where `Interference(m, i)` is a function of the **similarity** between memory `m` and competing memory `i`, and the **relative ages** of the memories. Higher similarity → stronger interference. This is not a single formula but a class of models; ACT-R handles this partially through its spreading activation and partial matching mechanisms.

**Relevance to Katra:** In a knowledge graph, adding a new edge that contradicts or is semantically similar to an existing edge should weaken the older edge. This is interference, not mere time decay.

---

### 1.6 Sleep-Based Consolidation Model

In biological memory, sleep serves to:
- **Strengthen** emotionally salient and recently important memories (synaptic consolidation)
- **Weaken** irrelevant memories (synaptic downscaling/homeostasis)
- **Integrate** new memories with existing schemas (systems consolidation)

**Synaptic Homeostasis Hypothesis (Tononi & Cirelli, 2006):**

During wake, synaptic strength increases globally. During slow-wave sleep, synapses are downscaled proportionally — weak connections are eliminated, strong connections are preserved. This is a **relative, not absolute, pruning mechanism**.

**Relevance to Katra:** An agent system could implement a "sleep cycle" — a periodic batch process that:
1. Computes importance scores for all memory edges
2. Weakens or prunes edges below a relative threshold
3. Strengthens edges that were accessed/used during the "waking" period

---

## 2. Suitability Matrix for Katra Memory Types

Katra currently has (or will have) multiple memory subsystems. Different decay models suit different types.

| Memory Type | Recommended Model | Rationale | Key Parameters |
|---|---|---|---|
| **Episodic Event Memory** (timestamped events, "what happened") | **ACT-R Base-Level Activation** (power-law, recency+frequency) | Episodic memory fades with time but frequency of recall/rehearsal boosts access. The power-law tail means old significant events remain retrievable. No "review" events — just natural recall tracking. | `d = 0.5` (default), `d = 0.3` for "nostalgic" agents |
| **Semantic Fact Confidence** (beliefs, knowledge, propositions) | **FSRS-style DSR model** or **Power-law with reinforcement** | Facts are reinforced by corroboration and recall. The DSR model's difficulty/stability/retrievability triad maps well: difficulty = how hard the fact is to internalize, stability = how well it's known, retrievability = current access probability. | Desired retention = 0.85–0.95, D = 3–7 (fact-dependent) |
| **Knowledge Graph Edge Strength** (relationships between entities) | **Power-Law Decay + Interference Term** | Edges should decay over time (unused connections weaken) AND be subject to interference (new similar edges compete). The power-law provides the base decay; an interference term adds cross-edge competition. | Base `b = 0.3–0.5`, interference weight `α = 0.1–0.3` |
| **Emotional Intensity Decay** (affective tags on memories) | **Exponential Decay with Floor** | Emotional intensity decays quickly initially (the "acute" phase) then stabilizes at a lower baseline. Exponential gives the sharp initial drop; a floor value prevents total loss. | Half-life: 1–7 days, Floor: 0.1–0.2 of original intensity |
| **Short-Term / Working Memory** (current context, recent messages) | **Rapid Exponential Decay** | Working memory should clear quickly (minutes to hours). Simple exponential with short half-life. | Half-life: 5–30 minutes, Hard cap: 24 hours |
| **Procedural Memory** (learned behaviors, skills, tool usage patterns) | **Power-Law with Very Slow Decay** (`d = 0.1–0.2`) | Once learned, skills decay very slowly. The "bicycle effect" — you never really forget. Very low decay exponent. | `d = 0.1`, practically permanent |
| **Social/Relationship Memory** (people, interactions, trust scores) | **Power-Law + Emotional Modulation** | Relationships decay slowly but are boosted by interactions. Emotional weight of interactions modulates the decay rate. | `d = 0.3–0.5`, emotional modulation factor |

### Detailed Parameter Tuning Guidance

**For Episodic Memory (ACT-R):**

```python
# Katra episodic decay function
def episodic_activation(event_timestamps, current_time, d=0.5):
    """
    event_timestamps: list of UNIX timestamps when this event was accessed/recalled
    current_time: current UNIX timestamp
    d: decay exponent (0.5 = moderate, 0.3 = nostalgic, 0.7 = amnesic)
    """
    contributions = [(current_time - ts) ** (-d) for ts in event_timestamps]
    return math.log(sum(contributions))

# Normalized to [0, 1] for blending with semantic similarity
def retrieval_score(activation):
    return 1.0 / (1.0 + math.exp(-activation))
```

**For Knowledge Graph Edges:**

```python
def edge_strength(edge, current_time, similar_edges=[], d=0.4, interference_alpha=0.15):
    """
    edge: {created_at, last_accessed, access_count, initial_strength}
    similar_edges: list of competing edges to the same target
    """
    # Power-law base decay
    age = current_time - edge.last_accessed
    base = edge.initial_strength * (age ** (-d))
    
    # Frequency boost (diminishing returns)
    freq_boost = math.log(1 + edge.access_count) * 0.1
    
    # Interference penalty from similar edges
    interference = 0
    for other in similar_edges:
        similarity = cosine_similarity(edge.embedding, other.embedding)
        other_age = current_time - other.created_at
        # Newer similar edges cause more interference
        interference += similarity * (other_age ** (-0.3)) * interference_alpha
    
    return max(0.01, min(1.0, base + freq_boost - interference))
```

---

## 3. Implementation Approaches

### 3.1 Approach A: Configurable Decay Functions with Half-Lives

**Concept:** Every memory node/edge has a decay function and a half-life parameter. Retrieval queries compute current strength on-the-fly from metadata.

**Implementation:**
```
Memory Schema:
  - content: str | embedding
  - created_at: timestamp
  - last_accessed: timestamp
  - access_count: int
  - decay_model: "exponential" | "power_law" | "act-r" | "static"
  - half_life: float (seconds)
  - decay_params: JSON (model-specific parameters)
```

**Strength Computation (at query time):**
```python
def compute_current_strength(memory, now):
    if memory.decay_model == "exponential":
        age = now - memory.last_accessed
        return memory.initial_strength * math.exp(-age / memory.half_life)
    elif memory.decay_model == "power_law":
        age = now - memory.last_accessed
        return memory.initial_strength * (age ** (-memory.decay_params.get('b', 0.5)))
    elif memory.decay_model == "act-r":
        return episodic_activation(memory.access_timestamps, now, memory.decay_params.get('d', 0.5))
    elif memory.decay_model == "static":
        return memory.initial_strength
```

**Pros:**
- Simple to implement
- Each memory type can use the most appropriate model
- Query-time computation is cheap (O(1) for exponential/power-law, O(n) for ACT-R)
- No periodic batch jobs required

**Cons:**
- No cross-memory interference effects
- Strength computed in isolation per memory
- ACT-R requires storing all access timestamps (grows over time)

---

### 3.2 Approach B: Spaced Repetition for Fact Reinforcement

**Concept:** Treat semantic facts like flashcards. Each time the agent "recalls" (uses) a fact, it's a review event. The FSRS algorithm schedules when the fact should be "reviewed" again.

**Schedule of Review Events:**
1. **Agent creation:** Fact is encoded as "New" with initial difficulty
2. **Agent uses the fact:** Triggers a review event → stability updates
3. **Fact is challenged/contradicted:** Treated as a "lapse" → stability decreases
4. **Fact is idle:** Retrievability decays according to the FSRS forgetting curve
5. **Retrievability falls below threshold:** Fact is flagged for "review" (could trigger proactive re-check)

**Implementation Sketch:**
```python
class FactMemory:
    def __init__(self):
        self.stability = initial_stability  # S
        self.difficulty = 5.0               # D (1-10)
        self.last_review = now()
        self.review_count = 0
    
    def retrievability(self, now):
        t = now - self.last_review
        w20 = self.params['w20']
        return (1 + w20 * t / (9 * self.stability)) ** (-1/w20)
    
    def review(self, grade, now):
        r = self.retrievability(now)
        # Apply FSRS stability update formulas
        self.stability = new_stability(self.stability, self.difficulty, r, grade)
        self.difficulty = new_difficulty(self.difficulty, grade)
        self.last_review = now
        self.review_count += 1
```

**Pros:**
- Battle-tested in human learning (billions of reviews)
- Gives precise predictions of when knowledge will be "forgotten"
- Naturally handles reinforcement, lapses, and difficulty

**Cons:**
- Requires "review events" — needs integration into agent's workflow
- 19 trainable parameters need data to optimize (or use defaults)
- Best suited for factual knowledge, not episodic events

---

### 3.3 Approach C: Interference-Based Decay

**Concept:** Memories don't decay in isolation. When a new memory is similar to an existing one, the old one is weakened. This implements retroactive interference computationally.

**Implementation (Knowledge Graph):**
```python
def apply_interference(new_edge, existing_edges, graph):
    """
    When adding a new edge to the knowledge graph,
    weaken existing edges that are semantically similar.
    """
    new_embedding = embed(new_edge.content)
    
    for existing in existing_edges:
        similarity = cosine(new_embedding, existing.embedding)
        if similarity > SIMILARITY_THRESHOLD:
            # Retroactive interference: new weakens old
            weakening = similarity * INTERFERENCE_STRENGTH
            existing.strength *= (1 - weakening)
            
            # Proactive interference: old resists new
            new_edge.strength *= (1 - similarity * PROACTIVE_FACTOR)
```

**Key Parameters:**
- `SIMILARITY_THRESHOLD`: minimum cosine similarity to trigger interference (e.g., 0.7)
- `INTERFERENCE_STRENGTH`: how much the old edge weakens (e.g., 0.05–0.15)
- `PROACTIVE_FACTOR`: how much the old edge resists encoding of new (e.g., 0.03–0.08)

**Pros:**
- Matches how human interference works
- Naturally handles contradictory information (new "truth" weakens old "truth")
- No time-based computation needed — interference applied at encoding time

**Cons:**
- Computationally expensive for large graphs (O(n) per new edge)
- Requires embedding similarity computation
- Can cause "semantic drift" — accumulated interference too aggressive

---

### 3.4 Approach D: Periodic Pruning with Sleep Cycle

**Concept:** A periodic batch process (the "sleep cycle") that:
1. Scores all memories by a composite function of recency, frequency, emotional weight, and graph centrality
2. Applies a threshold: memories below the threshold are pruned (soft or hard)
3. Strengthens memories above the threshold (consolidation)

**Batch Scoring Function:**
```python
def consolidate_memories(memories, now):
    scores = []
    for mem in memories:
        recency = 1 / (1 + (now - mem.last_accessed) / DAY)
        frequency = math.log(1 + mem.access_count)
        emotional = mem.emotional_intensity * math.exp(-(now - mem.created_at) / EMOTIONAL_HALF_LIFE)
        centrality = graph_pagerank(mem.id)  # importance in knowledge graph
        score = (recency * 0.3 + frequency * 0.2 + emotional * 0.3 + centrality * 0.2)
        scores.append((mem.id, score))
    
    # Prune bottom percentile
    threshold = percentile([s for _, s in scores], PRUNE_PERCENTILE)
    for mem_id, score in scores:
        if score < threshold:
            if HARD_PRUNE:
                delete(mem_id)
            else:
                mark_as_archival(mem_id, score)
        else:
            # Consolidation boost
            boost_strength(mem_id, factor=1 + CONSOLIDATION_GAIN * score)
```

**Parameters:**
- `PRUNE_PERCENTILE`: bottom N% are candidates for pruning (e.g., 10-20%)
- `CONSOLIDATION_GAIN`: strength multiplier for kept memories (e.g., 0.01-0.05)
- `EMOTIONAL_HALF_LIFE`: how fast emotional weight decays (e.g., 7 days)
- Sleep cycle frequency: daily, during low-usage hours

---

### 3.5 Recommended Composite Approach for Katra

**A layered system combining multiple mechanisms:**

```
Layer 1: Per-Memory Decay (Approach A)
  - Every memory has a configurable decay function
  - Computed at query time, stored as metadata
  - Handles: basic time-based forgetting

Layer 2: Reinforcement via Access (ACT-R / FSRS)
  - Each time a memory is retrieved/used, its stability increases
  - ACT-R for episodic, FSRS for semantic facts
  - Handles: "use it or lose it" principle

Layer 3: Interference at Encoding Time (Approach C)
  - When new memories are similar to existing ones, weaken old
  - Applied at write time, bounded to prevent excessive weakening
  - Handles: contradictory/updated information

Layer 4: Periodic Consolidation (Approach D)
  - Daily "sleep cycle" batch process
  - Scores and prunes based on composite importance
  - Handles: garbage collection of truly irrelevant memories
```

---

## 4. Soft Decay vs Hard Decay

### Definitions

| | **Soft Decay** | **Hard Decay** |
|---|---|---|
| **What happens** | Memory's retrieval score decreases; falls below recall threshold | Memory is permanently deleted from storage |
| **Recovery** | Can be "re-remembered" with a strong enough retrieval cue | Gone forever (unless re-encoded from external source) |
| **Storage cost** | Full — all memories persist forever | Decreasing — storage reclaimed |
| **Biological analogue** | Retrieval failure (tip-of-the-tongue) | Complete synaptic elimination |
| **Risk** | Storage bloat | Irreversible information loss |

### Tradeoff Analysis

**Arguments for Soft Decay:**
1. **Safety**: Information is never truly lost. If the agent needs a fact it "forgot," a strong retrieval cue (context, related facts, user prompt) can reactivate it.
2. **Learnable**: The system can discover over time which "forgotten" facts still matter by observing which ones get re-accessed.
3. **Biological plausibility**: Human memories are rarely truly deleted; most "forgetting" is retrieval failure. Hypnosis, brain stimulation, and contextual cues can recover memories thought lost.
4. **Simplicity**: No need for complex garbage collection policies. Storage is cheap.
5. **Non-destructive**: If the decay model is misconfigured, you don't lose data — you just adjust parameters.

**Arguments for Hard Decay:**
1. **Storage costs**: At scale (millions of memories over years), indefinite storage costs accumulate. MongoDB indices grow, queries slow.
2. **Noise reduction**: Truly irrelevant memories pollute retrieval results. A decay model that only demotes but never deletes leads to "semantic sludge."
3. **Cognitive realism**: The brain does physically prune synapses. Some memories are genuinely gone.
4. **Privacy compliance**: GDPR "right to be forgotten" and data retention policies may require deletion.
5. **Agent focus**: An agent with 100,000 "forgotten but recoverable" memories will have worse retrieval precision than one with 10,000 strong memories.

### Recommended Katra Policy: **Soft Decay + Archival Tier + Hard Pruning at Extreme Ages**

```
┌─────────────────────────────────────────────────────┐
│                  MEMORY LIFECYCLE                    │
├───────────────┬──────────────┬───────────────────────┤
│ ACTIVE TIER   │ ARCHIVAL     │ DELETION              │
│ (MongoDB)     │ TIER (S3/FS) │ (Hard Prune)          │
├───────────────┼──────────────┼───────────────────────┤
│ Strength > θ₁ │ θ₂ < S ≤ θ₁  │ Age > T_max AND       │
│               │              │ access_count = 0      │
│ Full access   │ Compressed   │ AND emotional = 0     │
│ Fast query    │ Slow retrieval│ Permanent removal    │
│ Active decay  │ Frozen decay  │                       │
└───────────────┴──────────────┴───────────────────────┘
```

**Tiers:**
1. **Active Tier** (MongoDB): Strength above threshold. Full decay computation, fast retrieval.
2. **Archival Tier** (cold storage, S3 or compressed files): Strength below threshold but not yet deletion-eligible. Frozen decay state, accessible on explicit request, not included in normal retrieval.
3. **Deleted**: Age exceeds maximum retention, zero access count, zero emotional weight. Hard deleted.

**Thresholds (configurable):**
- `θ₁` (active threshold): retrieval_score > 0.05
- `θ₂` (archival threshold): retrieval_score ≤ 0.05
- `T_max` (hard delete): age > 2–5 years AND access_count = 0

**This gives Katra:**
- **Soft decay** for most memories (strength-based retrieval filtering)
- **Archival** for very old memories (storage cost reduction, still recoverable)
- **Hard delete** only for truly irrelevant memories (extreme age, never accessed, no emotional weight)

---

## 5. Existing Implementations in Other Agent Memory Systems

### 5.1 Mem0 (mem0ai/mem0)

**Architecture:** Universal memory layer for AI agents. Stores memories as vector embeddings + metadata with temporal reasoning.

**Decay Mechanism:** **None found.** Mem0's documentation emphasizes ADD-only extraction: "memories accumulate; nothing is overwritten." The system uses single-pass extraction (no UPDATE/DELETE) and temporal reasoning to rank the "right dated instance" for time-sensitive queries. There is no explicit forgetting curve, no decay parameter, and no pruning mechanism documented.

**Relevance to Katra:** Mem0 represents the baseline that Katra's decay model would improve upon. It's a pure append-only store with relevance ranking but no biological forgetting.

---

### 5.2 Letta (formerly MemGPT, letta-ai/letta)

**Architecture:** Stateful agents with "memory blocks" — a hierarchical memory system with core memory (always in context), archival memory (vector database), and recall memory (recent conversation).

**Decay Mechanism:** **Partial — archival/recall distinction.** Letta separates memory into:
- **Core memory blocks** (persona, human info): Always in context, no decay
- **Archival memory**: Long-term storage in vector DB, retrieved by similarity
- **Recall memory**: Recent conversation, effectively a sliding window

The archival/recall distinction is a crude form of decay: recent memories are in the "recall" window, older memories move to "archival" (lower retrieval priority). But there is no continuous decay function, no spaced repetition, and no interference model documented in the core architecture.

**Relevance to Katra:** Letta's hierarchical memory (core → archival) is a useful design pattern. Katra could extend this with continuous decay within each tier.

---

### 5.3 Cognee (topoteretes/cognee)

**Architecture:** Knowledge graph memory for AI agents. Builds a graph from conversations, code, and documents. Nodes are entities/concepts; edges are relationships.

**Decay Mechanism:** **None found.** Cognee focuses on graph construction (entity extraction, relationship inference) and graph-based retrieval (graph traversal + vector search). No documentation of decay, forgetting, or edge weakening over time.

**Relevance to Katra:** Cognee's knowledge graph architecture is the closest structural analogue to Katra's append-only graph. Cognee demonstrates the need for decay — without it, contradictory edges accumulate. Katra could pioneer graph-native decay.

---

### 5.4 Bitterbot's Hormonal Engine

**Reference:** Referenced in the Katra task description. Bitterbot is a Discord chatbot by @maya that uses a "hormonal engine" to modulate behavior.

**Decay Mechanism:** **Hormone-modulated decay (inferred).** Based on the description, Bitterbot uses hormonal states (analogous to neurotransmitter levels) that:
- Rise and fall over time (natural decay)
- Modulate the weight/accessibility of memories
- Affect agent "mood" and behavior selection

Specific technical details are not publicly documented, but the concept is relevant:

```
Hormonal State → Memory Access Weights → Behavior
     ↓
  Hormone Decay → Lower weight on old memories
```

**Relevance to Katra:** The hormonal modulation approach could add emotional/contextual modulation to Katra's decay model. A "dopamine" equivalent could strengthen recently rewarded memories; a "cortisol" equivalent could weaken memories associated with negative outcomes.

---

### 5.5 ACT-R Implementations (Academic)

Multiple open-source ACT-R implementations exist (Python ACT-R, ACT-UP, jsACT-R). All implement base-level activation decay. Key implementations:

- **python-act-r** (CCM lab): Full ACT-R declarative memory with base-level activation, spreading activation, partial matching, and noise
- **ACT-UP** (van Rij et al.): Lightweight Python ACT-R implementation used in cognitive modeling research
- **Adaptive Recall** (adaptiverecall.com): Developer-focused implementation of ACT-R base-level activation for search/retrieval systems

**Relevance to Katra:** These are the most mature implementations of power-law memory decay that Katra could draw from. The Adaptive Recall implementation is particularly interesting — it applies ACT-R to general retrieval systems, not just cognitive modeling.

---

### 5.6 Summary: Gap in the Ecosystem

```
┌──────────────────────────────────────────────────────────────┐
│          DECAY SUPPORT IN AGENT MEMORY SYSTEMS                │
├────────────────────┬─────────────────────────────────────────┤
│ System             │ Decay Support                            │
├────────────────────┼─────────────────────────────────────────┤
│ Mem0               │ None (pure append-only)                  │
│ Letta (MemGPT)     │ Crude tiering (core vs archival)         │
│ Cognee             │ None (graph accumulation)                │
│ LangChain Memory   │ Sliding window / token limit (not decay) │
│ Chroma/Weaviate    │ None (vector stores, no time-awareness)  │
│ ACT-R (academic)   │ Full power-law decay (not agent-focused) │
│ Bitterbot          │ Hormonal modulation (limited details)    │
│ **Katra (proposed)**│ **Multi-layer decay: ACT-R + FSRS +     │
│                    │  interference + sleep consolidation**    │
└────────────────────┴─────────────────────────────────────────┘
```

**Key finding:** No existing production agent memory system implements a principled, neuroscience-informed decay model. Katra has the opportunity to be the first.

---

## 6. Recommendations for Katra

### Immediate (Phase 1): Per-Memory Power-Law Decay

Add these fields to every memory node/edge in the MongoDB schema:

```json
{
  "decay": {
    "model": "power_law",
    "d": 0.5,
    "initial_strength": 1.0,
    "created_at": "2026-06-30T19:00:00Z",
    "last_accessed": "2026-06-30T19:30:00Z",
    "access_timestamps": [1749772800, 1749774600],
    "access_count": 2
  }
}
```

Query-time strength computation filters memories below `MIN_RETRIEVAL_STRENGTH`.

### Near-term (Phase 2): Access-Based Reinforcement

Track every retrieval event. Each time a memory is accessed (used in context, referenced in response), append to `access_timestamps`. ACT-R base-level activation computed from timestamps provides natural frequency + recency balance.

### Medium-term (Phase 3): Interference at Encoding

When adding new edges to the knowledge graph, compute similarity to existing edges on the same nodes. Apply retroactive interference to weaken semantically similar older edges. Add proactive interference factor that slightly resists encoding of near-duplicates.

### Long-term (Phase 4): Sleep Cycle Consolidation

Daily batch job (during low-usage hours) that:
1. Scores all memories on composite importance
2. Moves low-score memories to archival tier
3. Boosts high-score memories (consolidation gain)
4. Hard-deletes extreme-age zero-access zero-emotion memories

---

## References

1. Ebbinghaus, H. (1885). *Über das Gedächtnis* (Memory: A Contribution to Experimental Psychology).
2. Wixted, J. T., & Ebbesen, E. B. (1991). On the form of forgetting. *Psychological Science*, 2(6), 409–415.
3. Anderson, J. R., & Schooler, L. J. (1991). Reflections of the environment in memory. *Psychological Science*, 2(6), 396–408.
4. Anderson, J. R. (1993). *Rules of the Mind*. ACT-R base-level activation equation.
5. Wozniak, P. (1987). Algorithm SM-2. SuperMemo 1.0 for DOS.
6. Leitner, S. (1972). *So lernt man lernen* (How to Learn to Learn).
7. Ye, J. et al. (2023–2025). FSRS: Free Spaced Repetition Scheduler. open-spaced-repetition/fsrs-rs.
8. Underwood, B. J. (1957). Interference and forgetting. *Psychological Review*, 64(1), 49–60.
9. Tononi, G., & Cirelli, C. (2006). Sleep function and synaptic homeostasis. *Sleep Medicine Reviews*, 10(1), 49–62.
10. Kahana, M. J., & Adler, M. (2002). Note on the power law of forgetting. University of Pennsylvania.
11. Mem0 Documentation. https://docs.mem0.ai
12. Letta Documentation. https://docs.letta.com
13. Adaptive Recall — Base-Level Activation for Developers. https://www.adaptiverecall.com/act-r/base-level-activation.php
14. Expertium's Blog — A Technical Explanation of FSRS. https://expertium.github.io/Algorithm.html
