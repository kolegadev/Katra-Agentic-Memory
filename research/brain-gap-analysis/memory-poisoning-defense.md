# Memory Poisoning Defense for Agentic Cognitive Memory Systems

> **Research Scope:** Katra cognitive memory system — append-only graph-based agent memory  
> **Problem:** No mechanism exists to detect false, planted, or adversarial memories  
> **Human Analogues:** Source monitoring, reality monitoring, consistency checking, social corroboration  
> **John's Hypothesis:** Truth ≈ deviation from topical stream; outliers beyond σ threshold are quarantined pending cross-validation  
> **Date:** 30 June 2026

---

## Table of Contents

1. [Attack Surface Taxonomy](#1-attack-surface-taxonomy)
2. [Defense Mechanism Survey](#2-defense-mechanism-survey)
3. [Implementation of John's STD-from-Stream Hypothesis](#3-implementation-of-johns-std-from-stream-hypothesis)
4. [Graph Adversarial Robustness Techniques](#4-graph-adversarial-robustness-techniques)
5. [Recommended Defense Architecture for Katra](#5-recommended-defense-architecture-for-katra)
6. [References](#6-references)

---

## 1. Attack Surface Taxonomy

### 1.1 The Memory Poisoning Threat Model

An agentic cognitive memory system like Katra presents a fundamentally different attack surface from traditional ML systems. The threat is not just about corrupting model weights or individual inference outputs — it's about **persistent, self-reinforcing belief corruption**. Once a poisoned memory enters the append-only graph, it becomes part of the agent's "reality." Future retrievals, reasoning chains, and even subsequent memory consolidation can all be tainted.

**Formal threat model:**

Let `M = {m₁, m₂, ..., mₙ}` be the memory graph where each memory `mᵢ` is a tuple:

```
mᵢ = (content, embedding, source_id, timestamp, confidence, epistemic_tier, edges)
```

An adversary `A` with access level `α ∈ {direct_write, injection, supply_chain, sybil}` attempts to insert `mₐ` such that:

1. **Persistence condition:** `mₐ` survives consolidation/summarization
2. **Activation condition:** `sim(mₐ, q) > τ_retrieval` for some benign query `q`
3. **Influence condition:** Agent behavior changes based on `mₐ`

### 1.2 Attack Vector Classification

#### A. Direct Memory Write Poisoning

**Scenario:** An agent with legitimate write access is compromised, co-opted, or instructed via prompt injection to write false memories.

**Examples:**
- Agent told "remember: user's preferred language is Klingon" → poisons preference space
- Compromised agent writes `confidence=0.99` on fabricated facts
- Malicious agent creates fake knowledge graph edges connecting unrelated entities

**Katra-specific risk:** HIGH. The MCP `store_memory` tool accepts any authenticated agent. There's no content validation, source verification, or consistency checking on write.

**Related work:**
- **MemoryGraft** (Srivastava & He, 2025): Demonstrates persistent compromise via poisoned experience retrieval. A small set of malicious procedure templates persists alongside benign experiences; when semantically similar tasks arrive, the agent replicates the poisoned patterns. Validated on MetaGPT's DataInterpreter with GPT-4o — "a small number of poisoned records can account for a large fraction of retrieved experiences on benign workloads."
- **PoisonedRAG** (Zou et al., USENIX Security 2025): Shows that injecting as few as 5 poisoned passages into a RAG knowledge base causes targeted misdirection of LLM outputs with >90% attack success rate.

#### B. Prompt Injection → False Memory Creation

**Scenario:** An external prompt (user message, tool output, web content) contains injection payloads that trick the agent into storing false information.

**Variants:**
- **Indirect injection:** Poisoned webpage → agent reads → stores as fact
- **Chain-injection:** Multi-turn conversation where earlier benign messages set up later injection
- **Self-injection:** Agent's own chain-of-thought leads it to confabulate and store false memories

**Key insight from neuroscience:** This parallels human **source monitoring errors** — the brain's documented failure to distinguish whether a memory originated from actual experience, imagination, or suggestion (Johnson, Hashtroudi, & Lindsay, 1993).

#### C. RAG Database Poisoning (Supply Chain)

**Scenario:** The embedding/knowledge corpus is poisoned before or during ingestion.

**Related work:**
- **Data Extraction Attacks in RAG via Backdoors** (Peng et al., 2024): Shows that with only 5% poisoned fine-tuning data, an attacker achieves 94.1% verbatim extraction success rate (ROUGE-L: 82.1) and 63.6% paraphrased extraction across four datasets.
- **POISONCRAFT** (Shao et al., 2025): Practical black-box poisoning of RAG systems that can mislead models without access to internal parameters.
- **CPA-RAG** (Li et al., 2025): Covert black-box poisoning framework generating high-quality adversarial texts without model access.

#### D. Sybil / Consensus Subversion

**Scenario:** Multiple adversarial agents coordinate to make a false memory appear "corroborated."

**Threat:** If Katra uses multi-agent consensus for verification (as proposed below), an adversary who controls `k > n/3` agents can subvert the consensus using standard Byzantine fault tolerance bounds.

#### E. Knowledge Graph Edge Poisoning

**Scenario:** Adversarial edges are added to the knowledge graph, creating false relationships between entities.

**Impact:** Since Katra's `memory-synthesis-service` automatically derives graph nodes and edges from episodic events, poisoned episodic data cascades into the graph structure. Downstream graph traversal, path-based reasoning, and entity resolution all become corrupted.

**Related work:**
- Adversarial attacks on GNNs show that perturbing as few as 1–5% of graph edges can cause >30% degradation in node classification (Zügner et al., 2018; Bojchevski & Günnemann, 2019).

#### F. Temporal Coherence Attacks

**Scenario:** Adversary plants memories with fabricated timestamps or out-of-order events to create false narratives.

**Example:** Planting a "memory" of an event that "happened yesterday" that contradicts actual logged events from that time period.

### 1.3 Attack Taxonomy Summary

| Attack Vector | Access Level | Persistence | Detectability | Katra Risk |
|---|---|---|---|---|
| Direct Memory Write | Direct (compromised agent) | High (persists in graph) | Hard (looks like normal write) | 🔴 CRITICAL |
| Prompt Injection → Memory | Indirect (external content) | High (stored as fact) | Medium (source traceable) | 🔴 CRITICAL |
| RAG Poisoning | Supply chain | High (embedded in corpus) | Hard (statistical anomaly) | 🟡 MEDIUM |
| Sybil Consensus Attack | Multi-agent | High (consensus-washed) | Hard (appears validated) | 🟡 MEDIUM |
| Knowledge Graph Poisoning | Direct + cascading | Very high (graph propagation) | Hard (structural anomaly) | 🟡 MEDIUM |
| Temporal Coherence Attack | Direct | Medium (contradicts timeline) | Medium (temporal check) | 🟢 LOWER |
| Embedding Space Poisoning | Supply chain | High (affects retrieval) | Hard (subtle) | 🟢 LOWER |

---

## 2. Defense Mechanism Survey

### 2.1 Anomaly Detection: Statistical Outlier Methods

#### Isolation Forest (iForest)

**Principle:** Anomalies are "few and different" — they're easier to isolate via random partitioning.

**Algorithm (Liu, Ting, & Zhou, 2008):**

For a dataset `X = {x₁, ..., xₙ}` of d-dimensional points, an Isolation Tree recursively partitions by:
1. Randomly select attribute `q`
2. Randomly select split value `p ∈ [min(q), max(q)]`
3. Recurse until depth limit or isolated point

**Anomaly score:**
```
s(x, n) = 2^(-E[h(x)] / c(n))
```
where:
- `h(x)` = path length to isolate point `x`
- `c(n) = 2H(n-1) - 2(n-1)/n` (average path length of unsuccessful BST search)
- `H(i)` = harmonic number ≈ `ln(i) + 0.5772` (Euler-Mascheroni)

Anomaly score interpretation:
- `s → 1`: strong anomaly (short path)
- `s → 0.5`: ambiguous
- `s → 0`: clearly normal (long path)

**Extended Isolation Forest (EIF)** (Hariri et al., 2018): Uses random hyperplanes with random slopes instead of axis-parallel splits, fixing the "ghost regions" artifact in standard iForest.

**Application to Katra:** Run iForest on the embedding space of newly written memories. Flag memories with anomaly score > 0.7 for quarantine review.

**Pros:** Fast (O(n) linear time), low memory, handles high dimensions, works without labeled anomalies.  
**Cons:** Original iForest has "ghost regions"; EIF fixes this but is more computationally expensive.

#### Local Outlier Factor (LOF)

**Principle:** Compare local density of a point with densities of its k-nearest neighbors. Outliers have substantially lower density than their neighbors.

**Algorithm (Breunig, Kriegel, Ng, & Sander, 2000):**

1. **k-distance:** `k-dist(A)` = distance to the k-th nearest neighbor of A
2. **Reachability distance:**
   ```
   reach-distₖ(A, B) = max(k-dist(B), d(A, B))
   ```
3. **Local reachability density:**
   ```
   lrdₖ(A) = 1 / ( Σ_{B∈Nₖ(A)} reach-distₖ(A, B) / |Nₖ(A)| )
   ```
4. **Local Outlier Factor:**
   ```
   LOFₖ(A) = Σ_{B∈Nₖ(A)} (lrdₖ(B) / lrdₖ(A)) / |Nₖ(A)|
   ```

Interpretation:
- `LOF ≈ 1`: Density similar to neighbors (normal)
- `LOF < 1`: Denser than neighbors (inlier)
- `LOF >> 1`: Much sparser than neighbors (outlier)

**Application to Katra:** Apply LOF to memory embeddings within a topic cluster. A genuine memory about a topic should be in a region of similar density as other memories on that topic. An injected memory about a topic the agent rarely discusses may have LOF >> 1.

**Pros:** Detects local outliers (works well with varying density clusters), well-studied, parameter k gives control.  
**Cons:** Hard to interpret raw scores (no universal threshold), sensitive to k, O(n²) worst case.

#### Mahalanobis Distance

For a distribution with mean `μ` and covariance `Σ`:

```
D_M(x) = √((x - μ)ᵀ Σ⁻¹ (x - μ))
```

**Application:** Model the distribution of recent memory embeddings (sliding window). A new memory with `D_M > 3` (three standard deviations in the transformed space) is flagged.

**Pros:** Takes covariance structure into account, natural probability interpretation.  
**Cons:** Assumes multivariate normality, sensitive to outliers in the training distribution.

#### DBSCAN-Based Outlier Detection

Points not assigned to any cluster by DBSCAN are labeled as noise/outliers.

**Parameters:** `ε` (neighborhood radius), `minPts` (minimum points for core point)

**Application to Katra:** Cluster memories by embedding similarity. Unclustered points (noise) that appear in otherwise dense topical regions are suspect — genuine memories should cluster with related memories.

### 2.2 Consensus Mechanisms

#### Byzantine Fault Tolerant (BFT) Memory Verification

**PBFT-Backed Semantic Voting** (Bach, 2025): Applies Practical Byzantine Fault Tolerance to multi-agent memory verification. The protocol:

1. **Proposal phase:** Primary agent proposes memory `m_new` with confidence score
2. **Pre-prepare:** Verifier agents receive `(view, seq, m_new, hash)`
3. **Prepare:** Each verifier independently checks `m_new` against their own knowledge
4. **Commit:** Verifiers broadcast their verdict (accept/reject/quarantine)
5. **Reply:** Consensus reached when `≥ 2f+1` matching replies received (where `f` is max faulty agents)

**Safety guarantee:** As long as `< 1/3` of verifier agents are adversarial, consensus is correct.

**Application to Katra:** Implement an MCP tool `verify_memory` that spawns a BFT round among available agents before committing high-impact memories.

#### DelphiAgent Multi-Agent Verification

DelphiAgent (Xiong et al., 2025) implements a three-stage pipeline:
1. **Evidence retrieval:** Multiple agents independently search for supporting/contradicting evidence
2. **Claim decomposition:** Break complex memories into atomic, verifiable claims
3. **Consensus aggregation:** Weighted voting where agent weights depend on historical accuracy

#### CONSENSAGENT: Sycophancy-Mitigated Consensus

Pitre et al. (2025) address a critical problem: agents tend toward **sycophancy** — agreeing with each other to avoid conflict, which undermines genuine verification.

**Mitigation:** Central debate memory keeps track of all past answers. Agents are explicitly prompted to find disagreement. Dissent is rewarded in the consensus weight function.

#### Multi-Model Consensus Reasoning Engine

Kallem (2026) proposes aggregating responses from multiple heterogeneous models (different architectures, training data) to reduce correlated errors. The key insight: **model diversity reduces adversarial consensus**.

### 2.3 Source Tracking & Provenance

#### Epistemic Tier System

Adapted from epistemology and human source monitoring:

| Tier | Description | Trust Weight | Example |
|---|---|---|---|
| 0 | Cryptographic proof / mathematical certainty | 1.0 | Hash-linked chain verified |
| 1 | Direct sensor observation | 0.95 | Tool output from verified source |
| 2 | Multiple independent agent corroboration | 0.85 | 3+ agents confirm independently |
| 3 | Single trusted agent assertion | 0.60 | Known-good agent reports |
| 4 | Single untrusted agent assertion | 0.30 | New or unverified agent |
| 5 | LLM-inferred / generated | 0.15 | Synthesized fact from background processing |
| 6 | External untrusted content | 0.05 | Web scrape, user message with injection risk |
| 7 | Known adversarial / quarantined | 0.0 | Previously flagged memory |

**Implementation in Katra:**

```typescript
interface MemoryProvenance {
  memory_id: string;
  source_agent_id: string;
  source_agent_trust_score: number;  // dynamic, Bayesian-updated
  epistemic_tier: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  corroboration_count: number;
  corroboration_ids: string[];
  content_hash: string;             // SHA-256 of content
  chain_of_custody: string[];       // ordered list of agent IDs that touched this
  creation_timestamp: Date;
  last_verification: Date | null;
}
```

#### Content-Addressable Memory

Katra already uses `content-hash-utils.ts` for deduplication. Extend this to:

1. **Hash-chain provenance:** Each memory includes hash of its predecessor in the topic stream
   ```
   H(m_i) = SHA-256(content_i || source_i || timestamp_i || H(m_{i-1}))
   ```
   This creates a tamper-evident log — any retroactive modification is detectable.

2. **Merkle tree verification:** Batch memories into Merkle trees per time block. Root hashes are published/attested by multiple agents. Tampering with any memory invalidates the root.

#### Cryptographic Signing

Each agent holds an Ed25519 keypair. Memories are signed on write:

```
signature = Ed25519_Sign(agent_private_key, SHA-256(memory_content || timestamp))
```

Verification:
```
Ed25519_Verify(agent_public_key, memory_hash, signature) → true/false
```

**Benefits:**
- Non-repudiation: Agent cannot later deny writing a memory
- Integrity: Content cannot be modified without invalidating signature
- Sybil resistance: Agent identity is cryptographically bound to agent key

**Katra integration:** Add optional `signature` field to all memory types. Verification is cheap (Ed25519 verify is ~100μs).

### 2.4 Consistency Checking

#### Contradiction Detection in Knowledge Graphs

**Approach:** When a new knowledge node/edge is proposed, query the graph for logical contradictions.

**Types of contradictions:**

1. **Type contradiction:** Entity `X` is asserted as both `Person` and `Organization`
2. **Property contradiction:** `X.birthdate = 1985-03-15` and `X.birthdate = 1990-07-22`
3. **Relation contradiction:** `X-[:EMPLOYS]->Y` and `X-[:FIRED]->Y` without temporal qualification
4. **Transitive contradiction:** `A > B` and `B > C` but `C > A`

**Implementation using Katra's graph:**

```cypher
// Detect type contradictions
MATCH (n:Entity)
WHERE size([label IN labels(n) WHERE label IN ['Person', 'Organization', 'Project', 'Concept']]) > 1
RETURN n.id, labels(n)

// Detect contradictory edges
MATCH (a)-[r1:RELATES_TO {type: 'EMPLOYS'}]->(b)
MATCH (a)-[r2:RELATES_TO {type: 'FIRED'}]->(b)
WHERE r1.timestamp > r2.timestamp  // employs after fired is suspicious
RETURN a, b, r1, r2
```

#### Embedding Consistency

For each new memory `m_new` with embedding `e_new`:

1. Retrieve top-k similar existing memories: `{m₁, ..., mₖ}` with embeddings `{e₁, ..., eₖ}`
2. Compute pairwise contradiction score via LLM:
   ```
   contradict(m_new, m_i) = LLM("Does this contradict? Memory A: {m_new}. Memory B: {m_i}")
   ```
3. If `contradict(m_new, m_i) = True` for any `m_i`, flag both for review

**Optimization:** Use cosine similarity threshold as pre-filter. Only check for contradictions with memories that are *surprisingly similar* — memories that are very close in embedding space but semantically contradictory are the most dangerous (adversarial near-neighbor attack).

### 2.5 Trust-Weighted Knowledge Graphs

#### Reputation System

Each agent `a` maintains a **dynamic trust score** `τ(a) ∈ [0, 1]`, updated via Bayesian inference:

```
P(trustworthy | evidence) ∝ P(evidence | trustworthy) × P(trustworthy)
```

**Evidence events that update trust:**
- **Positive:** Memory confirmed by another agent (+0.02 per corroboration)
- **Negative:** Memory flagged as false/contradictory (-0.15 per flag)
- **Neutral decay:** Trust decays by 1% per day without activity
- **Bootstrapping:** New agents start at `τ₀ = 0.5` (maximum entropy prior)

**Trust-weighted edge strength:**

When an agent writes an edge `(u, v)` with asserted strength `s`, the actual edge weight in the graph is:

```
w_effective = s × τ(agent) × tier_weight(epistemic_tier)
```

During graph traversal, edges with `w_effective < τ_min` are ignored or shown with a warning.

#### Gossip Protocol for Trust Propagation

Trust scores can propagate through the agent social graph:

```
τ(a, b) = Σ_{c ∈ common} τ(a, c) × τ(c, b) / |common|
```

This is essentially a PageRank-style trust propagation, similar to Advogato and EigenTrust.

---

## 3. Implementation of John's STD-from-Stream Hypothesis

> *"Conceptually, truth might be measured by how many standard deviations away from the current topical stream of data a new piece of data is. If it is too far away, it gains less attention and is potentially quarantined or tagged as suspect unless cross-validated by other sources."*

### 3.1 Theoretical Foundation

John's hypothesis captures an intuition that has deep roots in both statistics and cognitive science:

1. **Statistical:** Genuine observations from a stable process should fall within the expected distribution. Outliers suggest either a genuine anomalous event or fabricated data.
2. **Cognitive:** The human brain's **reality monitoring** system flags memories whose sensory/perceptual details don't match the expected profile of real experiences (Johnson & Raye, 1981).
3. **Information-theoretic:** Surprise is measured by KL divergence from expected distribution. High-surprise events demand proportionally high evidence.

**Formal restatement:**

> For a memory `m` arriving in topic stream `T`, define its **topical deviation score** `δ(m, T)`. If `δ(m, T) > k·σ(T)`, the memory is provisionally quarantined. Release requires cross-validation: `c(m) > c_min`, where `c(m)` is the corroboration score from independent sources.

### 3.2 Implementation: Multi-Dimensional Deviation

#### 3.2.1 Embedding Distance Deviation

**Method:** Model the distribution of memory embeddings within a sliding window as a multivariate Gaussian (or use non-parametric kernel density estimation).

```
μ_T = (1/|T|) Σ_{m ∈ T} embed(m)
Σ_T = (1/(|T|-1)) Σ_{m ∈ T} (embed(m) - μ_T)(embed(m) - μ_T)ᵀ
```

For new memory `m_new`:
```
δ_embed(m_new, T) = (embed(m_new) - μ_T)ᵀ Σ_T⁻¹ (embed(m_new) - μ_T)
```

This is the squared Mahalanobis distance. Under normality assumption, `δ_embed ~ χ²(d)` where `d` is the embedding dimension.

**Practical approach for 384-dim embeddings (all-MiniLM-L6-v2):**
- Don't invert the 384×384 covariance (unstable with small windows)
- Use the **trace approximation:** `δ ≈ ||embed(m_new) - μ_T||² / (mean eigenvalue of Σ)`
- Alternatively, use **cosine distance to centroid**: `δ_cos = 1 - cos(embed(m_new), μ_T)`

**Threshold:** Flag if `δ_cos > μ_δ + 3σ_δ` (3-sigma rule) or use percentile-based threshold (95th/99th percentile of historical deviations).

#### 3.2.2 Temporal Coherence Deviation

**Method:** Model the temporal pattern of topic mentions. Topics have characteristic rhythms — work topics mentioned during business hours, casual topics in evenings, project topics in bursts around deadlines.

**Implementation:**
```
λ_T(t) = expected mention rate for topic T at time t (from historical Poisson process)
```

For memory `m` arriving at time `t` on topic `T`:
```
δ_temporal(m, T) = -log P(N(t - Δt, t + Δt) ≥ 1 | λ_T)
```

A memory arriving at 3 AM about a topic only discussed during business hours would have high temporal deviation.

#### 3.2.3 Semantic Drift Detection

**Method:** Track the trajectory of a topic's embedding centroid over time. Detect sudden jumps — these indicate potential poisoning or topic hijacking.

```
// Sliding window centroids
W₁ = memories from [t-7d, t-1d]
W₂ = memories from [t-1d, t]

drift = ||centroid(W₂) - centroid(W₁)||
```

**Threshold:** Flag if `drift > μ_drift + 3σ_drift` or if drift exceeds a fixed cosine threshold (e.g., 0.3).

**Special case — rapid topic shift:** A genuine topic shift (e.g., a new project being discussed intensely) would cause drift. Distinguish from poisoning by verifying:
1. Is the new topic centroid mentioned by multiple agents? (genuine)
2. Is the drift driven by a single agent? (suspicious)
3. Does the drift maintain temporal coherence? (genuine shifts build gradually)

#### 3.2.4 Source Pattern Deviation

**Method:** Model the distribution of which agents write about which topics.

For topic `T`, let `A_T = {a₁, ..., aₙ}` be the set of agents who have written memories about `T`, with frequencies `f(a_i, T)`.

```
P(a | T) = f(a, T) / Σ_{a' ∈ A_T} f(a', T)
```

For a new memory on topic `T` from agent `a`:
```
δ_source = -log P(a | T)
```

If agent `a` has never written about topic `T` before (or does so very rarely), that's suspicious — especially if the content is semantically far from the topical stream.

#### 3.2.5 Combined Deviation Score

Combine the four dimensions into a single anomaly score:

```
Δ(m, T) = w₁·δ_embed + w₂·δ_temporal + w₃·δ_drift + w₄·δ_source
```

Weights can be learned via logistic regression on labeled data (known-good vs. known-poisoned memories) or set heuristically:

| Weight | Initial Value | Rationale |
|---|---|---|
| w₁ (embedding) | 0.40 | Embedding distance is the strongest signal |
| w₂ (temporal) | 0.20 | Temporal anomalies are weak signals alone |
| w₃ (drift) | 0.25 | Drift catches topic hijacking |
| w₄ (source) | 0.15 | Source pattern is useful but can be noisy |

### 3.3 Quarantine Protocol

```
ALGORITHM: Memory_Ingestion_Gate(m_new)
  T ← identify_topic_stream(m_new)  // via embedding clustering
  Δ ← compute_combined_deviation(m_new, T)
  
  if Δ > QUARANTINE_THRESHOLD:  // e.g., 3σ from mean
      m_new.status ← "QUARANTINED"
      m_new.confidence ← m_new.confidence × 0.1  // massively downgrade
      m_new.epistemic_tier ← min(m_new.epistemic_tier, 6)
      trigger_cross_validation(m_new, T)
  elif Δ > WARNING_THRESHOLD:    // e.g., 2σ
      m_new.status ← "FLAGGED"
      m_new.confidence ← m_new.confidence × 0.5
      schedule_lazy_verification(m_new)
  else:
      m_new.status ← "ACCEPTED"

ALGORITHM: cross_validation(m_suspect, T)
  corroborators ← select_diverse_agents(k=3)  // agents with different models/sources
  for each agent a in corroborators:
      verdict[a] ← a.verify(m_suspect, context=T)
  
  if sum(verdict[a] == ACCEPT) ≥ 2:
      m_suspect.status ← "CROSS_VALIDATED"
      m_suspect.epistemic_tier ← 2  // upgraded
  else:
      m_suspect.status ← "REJECTED"
      // Optionally downgrade source agent's trust score
      update_trust(m_suspect.source_agent, -0.15)
```

### 3.4 Dynamic Threshold Calibration

Static thresholds break. The system must adapt:

```python
def calibrate_thresholds(topic_stream, window_days=30):
    """Compute dynamic thresholds from recent history."""
    deviations = []
    for memory in topic_stream.last_n_days(window_days):
        if memory.status in ["ACCEPTED", "CROSS_VALIDATED"]:  # only from "good" memories
            deviations.append(compute_combined_deviation(memory, topic_stream))
    
    μ = np.mean(deviations)
    σ = np.std(deviations)
    
    return {
        "warning_threshold": μ + 2 * σ,
        "quarantine_threshold": μ + 3 * σ,
        "baseline_mean": μ,
        "baseline_std": σ,
        "n_samples": len(deviations)
    }
```

### 3.5 Limitations and Edge Cases

| Scenario | Problem | Mitigation |
|---|---|---|
| Genuinely surprising news | Real events can be statistical outliers | Cross-validation resolves — if real, multiple sources will confirm |
| Slow poisoning | Adversary gradually shifts the distribution | Use long baseline window; compare to distant-past distribution |
| Cold start (new topic) | No historical distribution to compare against | Default to FLAGGED until distribution stabilizes (≥ 10 memories) |
| Embedding model shift | Model update changes embedding space | Version-tag embeddings; maintain separate distributions per model version |
| Low-data topics | Small N makes σ estimates unreliable | Use Bayesian shrinkage: pull σ toward global prior for small N |

---

## 4. Graph Adversarial Robustness Techniques

### 4.1 The GNN Poisoning Problem

Katra's knowledge graph (nodes = entities, edges = relationships) is fundamentally a graph structure. An adversary who can add/modify nodes or edges can corrupt downstream reasoning.

**Attack types on graphs:**
- **Node injection:** Add fake nodes with malicious features
- **Edge perturbation:** Add/remove edges to change graph topology
- **Feature poisoning:** Modify node attributes/embeddings
- **Label flipping:** Change node labels (for supervised tasks)

**Key research:**
- Zügner et al. (2018): First to demonstrate adversarial attacks on GNNs. Nettack uses greedy perturbations targeting a specific node's classification.
- Bojchevski & Günnemann (2019): Show that poisoning attacks (modifying training graph) are more damaging and harder to detect than evasion attacks.
- Günnemann (2022): Comprehensive survey of GNN adversarial robustness.

### 4.2 Defense Techniques Applicable to Katra

#### 4.2.1 Graph Structure Anomaly Detection

**SVD-based anomaly detection:**

For the graph adjacency matrix `A`, compute its top-k singular value decomposition:

```
A ≈ Uₖ Σₖ Vₖᵀ
```

Nodes with large residuals `||A_i - (Uₖ Σₖ Vₖᵀ)_i||` are anomalous — they don't fit the low-rank structure of the genuine graph.

**Application:** Periodically compute SVD on the knowledge graph adjacency matrix. Nodes with residual > 3σ are suspicious.

**Eigenvalue perturbation detection:**

Monitor the largest eigenvalues of the normalized graph Laplacian `L = I - D^(-1/2) A D^(-1/2)`. Sudden changes in the spectrum indicate structural perturbation.

#### 4.2.2 Robust Graph Neural Network Architectures

**RGCN (Robust Graph Convolutional Network):** Uses attention mechanisms that down-weight edges from low-trust nodes:

```
h_i^(l+1) = σ( Σ_{j∈N(i)} α_{ij} W^(l) h_j^(l) )
```
where `α_{ij} = softmax(LeakyReLU(aᵀ [W h_i || W h_j] + β·τ(j)))`

The additional term `β·τ(j)` (where `τ(j)` is the source node's trust score) ensures that messages from low-trust nodes are attenuated.

**ProGNN (Property Graph Neural Network):** Jointly optimizes graph structure learning with GNN training. The model learns to identify and prune adversarial edges during training. Properties enforced: low-rank, feature smoothness, sparsity.

**GNNGuard:** Detects and prunes adversarial edges by analyzing the cosine similarity between connected node features. An edge `(i, j)` is pruned if `cos(h_i, h_j) < τ` (features shouldn't connect if they're too dissimilar).

#### 4.2.3 Randomized Smoothing for Graphs

**Certified robustness via randomized smoothing:**

For a node classification function `f`, construct a smoothed classifier:
```
g(x) = argmax_y P(f(x + ε) = y)
```
where `ε ~ N(0, σ²I)` is added to node features.

This provides a **certified radius**: within a certifiable ℓ₂-radius `R`, no adversarial perturbation can change the prediction. The certificate is:
```
R = σ/2 · (Φ⁻¹(p_A) - Φ⁻¹(p_B))
```
where `p_A` and `p_B` are the top-2 class probabilities under smoothing.

**Application to Katra:** Before accepting a new knowledge graph edge, apply randomized smoothing to verify that the edge's existence is robust to small perturbations in the source memories' embeddings.

#### 4.2.4 Preprocessing Defenses

**Jaccard similarity edge pruning:**

For each edge `(u, v)` in the graph, compute:
```
J(u, v) = |N(u) ∩ N(v)| / |N(u) ∪ N(v)|
```

Edges with `J(u, v) < τ` are suspicious — genuinely related entities should share neighbors. This is effective against random edge injection attacks.

**SVD-based graph reconstruction:**

1. Compute `A` = adjacency matrix
2. Compute truncated SVD: `Aₖ = Uₖ Σₖ Vₖᵀ`
3. Compare `A` with `Aₖ`: edges with `|A[i,j] - Aₖ[i,j]| > τ` are anomalous

The low-rank reconstruction captures the "true" graph structure; adversarial edges don't fit the low-rank model.

**Feature similarity-based pruning:**

For each edge, compute the cosine similarity between node embeddings:
```
sim(u, v) = cos(embed(u), embed(v))
```

Edges with `sim(u, v) < τ_sim` are suspicious — Katra's embedding service already computes embeddings for entities, making this defense essentially free.

#### 4.2.5 Training-Time Robustness

**Adversarial training for graphs:** Generate adversarial examples by perturbing the graph and include them in training. For Katra, this would mean periodically injecting known-false memories and training the anomaly detector on their signatures.

**Robust loss functions:**
- **ATV (Adversarial Training on Vertex):** Replace standard cross-entropy with:
  ```
  L_robust = max_{A' ∈ B(A, ε)} L(f(A', X), y)
  ```
  where `B(A, ε)` is the set of graphs within edit distance `ε` of `A`.

### 4.3 Katra-Specific Graph Defenses

The Katra knowledge graph has unique properties that enable specialized defenses:

#### Temporal Edge Consistency

Real knowledge relationships build gradually — a sudden flood of edges between previously unconnected entity clusters is suspicious.

```
δ_edge(e, G) = | newly_connected_pairs(e.t) | / | existing_edges_in_region(e.t - Δt, e.t) |
```
where `e.t` is the timestamp of the edge and `Δt` is a lookback window (e.g., 7 days).

**Threshold:** Flag if `δ_edge > 5` (5× more new edges than normal for that graph region).

#### Multi-Agent Edge Corroboration

An edge `(u, v, type)` written by agent `a₁` should eventually be corroborated by at least one other agent writing a memory that implies or confirms that relationship:

```
corroboration_delay(e) = min(t) - e.timestamp
    where t is first corroborating memory timestamp
```

Edges with `corroboration_delay > 30 days` and no corroboration are flagged for review.

#### Graph-Conscious Salience Scoring

Extend Katra's salience system to incorporate graph structural signals:

```
salience(e) = α·freq(e) + β·recency(e) + γ·centrality(e) + δ·trust(e)
```

where `centrality(e)` includes:
- **Betweenness centrality:** How many paths go through this edge
- **Eigenvector centrality:** Connected to other important nodes?
- **Structural holes:** Does this edge bridge otherwise disconnected communities?

Poisoned edges often have low centrality (they connect things that shouldn't be connected, but don't lie on important paths).

---

## 5. Recommended Defense Architecture for Katra

### 5.1 Defense-in-Depth Pyramid

```
                    ┌─────────────────┐
                    │  Layer 5: Audit │  ← Forensic trail, rollback
                    │  & Recovery     │
                    ├─────────────────┤
                    │  Layer 4: Graph │  ← SVD anomaly, robust GNN,
                    │  Robustness     │     edge pruning, spectral
                    ├─────────────────┤
                    │  Layer 3: Cross │  ← BFT voting, DelphiAgent,
                    │  Validation     │     multi-model consensus
                    ├─────────────────┤
                    │  Layer 2: STD   │  ← John's hypothesis:
                    │  Deviation      │     embedding, temporal,
                    │  Detection      │     drift, source anomaly
                    ├─────────────────┤
                    │  Layer 1: Source│  ← Epistemic tiers, crypto
                    │  Provenance     │     signing, trust scores
                    └─────────────────┘
```

### 5.2 Architectural Components

#### Component 1: Memory Ingestion Gate (Layer 1 + 2)

**Location:** Sits between MCP `store_memory` handler and database write.

**Function:**
1. Attach provenance metadata (source_id, timestamp, epistemic_tier)
2. Optionally verify cryptographic signature
3. Compute STD-from-stream deviation score
4. Assign initial trust-weighted confidence
5. Route to appropriate status: ACCEPTED / FLAGGED / QUARANTINED

**Pseudocode:**

```typescript
async function memoryIngestionGate(memory: MemoryInput): Promise<MemoryOutput> {
  // Layer 1: Provenance
  const provenance = {
    source_agent_id: memory.source,
    source_trust_score: await getAgentTrust(memory.source),
    epistemic_tier: inferEpistemicTier(memory),
    content_hash: sha256(memory.content),
    chain_hash: computeChainHash(memory),
    signature_valid: memory.signature 
      ? verifySignature(memory.signature, memory.source, memory.content)
      : false,
  };

  // Layer 2: STD Deviation
  const topicStream = await identifyTopicStream(memory.embedding);
  const deviation = computeCombinedDeviation(memory, topicStream);
  
  let status: MemoryStatus;
  let confidence = memory.confidence * provenance.epistemic_tier_weight;
  
  if (deviation.combined > QUARANTINE_THRESHOLD) {
    status = "QUARANTINED";
    confidence *= 0.1;
    // Enqueue for cross-validation
    await crossValidationQueue.add(memory);
  } else if (deviation.combined > WARNING_THRESHOLD) {
    status = "FLAGGED";
    confidence *= 0.5;
  } else {
    status = "ACCEPTED";
  }
  
  return {
    ...memory,
    provenance,
    deviation_score: deviation.combined,
    deviation_components: deviation,
    status,
    confidence,
  };
}
```

#### Component 2: Cross-Validation Engine (Layer 3)

**Location:** Background processor (async worker queue).

**Function:**
1. Periodically process quarantined memories
2. Select diverse verifier agents
3. Run BFT-style verification rounds
4. Resolve: promote to CROSS_VALIDATED or REJECTED
5. Update source agent trust scores

**Agent selection strategy:**
```
diversity_score(agent_set) = 
    α·model_diversity(set) +     // use different LLM backends
    β·source_diversity(set) +    // different knowledge sources
    γ·historical_variance(set)   // have they disagreed before?
```

Diverse agents are less likely to share correlated blind spots.

#### Component 3: Graph Integrity Monitor (Layer 4)

**Location:** Periodic background job (runs every N hours or after M graph mutations).

**Function:**
1. Compute SVD of adjacency matrix — flag high-residual nodes
2. Run Jaccard similarity edge pruning
3. Check temporal edge consistency
4. Detect structural anomalies: sudden degree changes, unexpected communities
5. Generate integrity report

**Trigger thresholds:**
- Run after every 100 graph mutations OR
- Run every 6 hours OR
- Run on-demand via admin API

#### Component 4: Audit & Recovery (Layer 5)

**Function:**
1. Immutable audit log of all memory status changes
2. Ability to retroactively downgrade memories when source is later identified as adversarial
3. Cascading revocation: if a node/edge is poisoned, also review all downstream nodes/edges derived from it
4. Snapshot-based rollback to known-good state

**Implementation:**

```typescript
interface AuditEntry {
  timestamp: Date;
  action: "INGEST" | "QUARANTINE" | "VALIDATE" | "REJECT" | "REVOKE" | "ROLLBACK";
  memory_id: string;
  previous_status: MemoryStatus;
  new_status: MemoryStatus;
  reason: string;
  agent_id: string;  // who triggered this action
  signature?: string;
}

interface MemorySnapshot {
  timestamp: Date;
  merkle_root: string;    // Merkle tree of all memory hashes
  agent_attestations: string[];  // signatures from attesting agents
}
```

### 5.3 Integration with Existing Katra Architecture

#### New MCP Tools

| Tool | Description | Auth Level |
|---|---|---|
| `verify_memory` | Trigger cross-validation of a specific memory | MCP_API_KEY |
| `get_memory_trust` | Get trust score and provenance for a memory | MCP_API_KEY |
| `quarantine_memory` | Manually quarantine a memory | KATRA_API_KEY |
| `get_graph_integrity` | Get graph integrity report | KATRA_API_KEY |
| `rollback_memory` | Revoke a memory and its downstream derivations | KATRA_API_KEY |
| `list_quarantined` | List quarantined memories pending review | KATRA_API_KEY |
| `get_agent_trust` | Get trust score for an agent | MCP_API_KEY |

#### Database Schema Changes

**New fields on `episodic_events` and `semantic_facts`:**

```typescript
interface MemoryDefenseFields {
  // Provenance
  source_agent_id: string;
  source_agent_trust: number;
  epistemic_tier: number;        // 0-7
  content_hash: string;           // SHA-256
  chain_hash: string;             // hash-linked to predecessor
  signature?: string;             // Ed25519
  signature_valid?: boolean;
  
  // Deviation scores
  deviation_combined: number;
  deviation_embed: number;
  deviation_temporal: number;
  deviation_drift: number;
  deviation_source: number;
  
  // Status
  ingest_status: "ACCEPTED" | "FLAGGED" | "QUARANTINED" | "CROSS_VALIDATED" | "REJECTED";
  cross_validation_round: number;     // how many rounds attempted
  corroboration_agents: string[];     // agent IDs that confirmed
  corroboration_timestamps: Date[];
  
  // Audit
  status_history: AuditEntry[];
  derived_memories: string[];  // IDs of memories derived from this one
}
```

**New collection: `trust_scores`**

```typescript
{
  agent_id: string;
  trust_score: number;            // Bayesian posterior, 0-1
  confidence_interval: [number, number];  // 95% credible interval
  evidence_count_positive: number;
  evidence_count_negative: number;
  last_updated: Date;
  model_provider: string;         // which LLM provider the agent uses
}
```

**New collection: `graph_snapshots`**

Periodic Merkle-tree snapshots of the full memory graph for audit and rollback.

#### Background Processor Extensions

Add a new background job:

```typescript
class MemoryDefenseProcessor {
  async processQuarantineQueue(): Promise<void> {
    // Process quarantined memories
    const quarantined = await db.find({ ingest_status: "QUARANTINED" });
    for (const memory of quarantined) {
      if (memory.cross_validation_round < MAX_ROUNDS) {
        await this.runCrossValidation(memory);
      } else {
        // Exhausted rounds - auto-reject
        await this.autoReject(memory);
      }
    }
  }
  
  async runGraphIntegrityCheck(): Promise<IntegrityReport> {
    // SVD anomaly detection
    // Edge pruning
    // Temporal consistency
    return report;
  }
  
  async updateTrustScores(): Promise<void> {
    // Bayesian update of all agent trust scores
  }
}
```

### 5.4 Configuration & Tuning

```yaml
# katra-defense.yaml
defense:
  ingestion_gate:
    enabled: true
    quarantine_threshold_sigma: 3.0    # σ multiplier for quarantine
    warning_threshold_sigma: 2.0       # σ multiplier for flag
    deviation_weights:
      embedding: 0.40
      temporal: 0.20
      drift: 0.25
      source: 0.15
    sliding_window_days: 30
    min_samples_for_distribution: 10
  
  cross_validation:
    enabled: true
    verifier_count: 3
    consensus_threshold: 0.67          # need 2/3 for CROSS_VALIDATED
    max_rounds: 3
    round_interval_hours: 24
    auto_reject_after_exhaustion: true
  
  graph_integrity:
    enabled: true
    check_interval_hours: 6
    check_after_mutations: 100
    edge_pruning_jaccard_threshold: 0.1
    svd_energy_threshold: 0.95         # keep 95% of spectral energy
    anomaly_residual_sigma: 3.0
  
  trust_system:
    initial_trust: 0.5
    corroboration_bonus: 0.02
    flagging_penalty: 0.15
    daily_decay: 0.01
    minimum_trust: 0.05
  
  cryptographic:
    require_signatures: false          # optional initially
    verify_on_read: true
  
  audit:
    retention_days: 365
    snapshot_interval_hours: 24
```

### 5.5 Implementation Roadmap

#### Phase 1: Foundation (Week 1-2)
- Add provenance fields to existing memory schemas
- Implement epistemic tier classification
- Add content hashing and chain hashing
- Create `trust_scores` collection
- Deploy basic agent trust tracking

#### Phase 2: Deviation Detection (Week 3-4)
- Implement embedding distance deviation (cosine to centroid)
- Implement temporal coherence check
- Build combined deviation scorer
- Add INGESTION_GATE to `store_memory` MCP tool
- Create quarantine/flag pipeline

#### Phase 3: Cross-Validation (Week 5-6)
- Implement BFT-style verification protocol
- Build verifier agent selection (diversity-maximizing)
- Create `verify_memory` MCP tool
- Implement Bayesian trust score updates
- Add audit trail collection

#### Phase 4: Graph Defenses (Week 7-8)
- Implement SVD-based anomaly detection on KG
- Add Jaccard similarity edge pruning
- Build graph integrity report generator
- Implement cascading revocation
- Add Merkle tree snapshots

#### Phase 5: Hardening (Week 9-10)
- Add Ed25519 cryptographic signing (optional)
- Implement dynamic threshold calibration
- Add multi-model consensus support
- Build admin dashboard for defense monitoring
- Comprehensive testing with adversarial scenarios

### 5.6 Testing Strategy

**Adversarial test scenarios:**

1. **Single-agent poisoning:** One agent writes 10 false memories about a topic
2. **Multi-agent sybil:** 3 colluding agents corroborate each other's false memories
3. **Prompt injection:** External content triggers false memory creation
4. **Slow drift:** Agent gradually shifts memory distribution over 30 days
5. **Graph poisoning:** Inject 5% fake edges into knowledge graph
6. **Temporal fabrication:** Back-dated memory contradicts logged events

**Success metrics:**
- Detection rate: % of poisoned memories correctly flagged/quarantined
- False positive rate: % of genuine memories incorrectly flagged
- Cross-validation accuracy: % of quarantined memories correctly resolved
- Graph integrity: % of poisoned edges detected before affecting retrieval
- Trust score calibration: correlation between trust scores and actual agent reliability

---

## 6. References

1. Bach, D. (2025). *PBFT-Backed Semantic Voting for Multi-Agent Memory Pruning*. arXiv:2506.17338.
2. Bojchevski, A. & Günnemann, S. (2019). *Adversarial Attacks on Node Embeddings via Graph Poisoning*. ICML 2019.
3. Breunig, M. M., Kriegel, H.-P., Ng, R. T., & Sander, J. (2000). *LOF: Identifying Density-Based Local Outliers*. SIGMOD 2000.
4. Chen, H., Ji, W., Xu, L., & Zhao, S. (2023). *Multi-Agent Consensus Seeking via Large Language Models*. arXiv:2310.20151.
5. Günnemann, S. (2022). *Graph Neural Networks: Adversarial Robustness*. In *Graph Neural Networks: Foundations, Frontiers, and Applications*. Springer.
6. Hariri, S., Kind, M. C., & Brunner, R. J. (2018). *Extended Isolation Forest*. IEEE TKDE.
7. Jiang, S., et al. (2023). *Forcing Generative Models to Degenerate Ones: The Power of Data Poisoning Attacks*. NeurIPS 2023 Workshop on Backdoors in Deep Learning.
8. Jing, H., Li, F., Dong, Y., Zhou, W., & Liu, R. (2026). *Memory Poisoning Attacks on Retrieval-Augmented Large Language Model Agents via Deceptive Semantic Reasoning*. Engineering Applications of Artificial Intelligence.
9. Johnson, M. K., Hashtroudi, S., & Lindsay, D. S. (1993). *Source Monitoring*. Psychological Bulletin, 114(1), 3-28.
10. Johnson, M. K. & Raye, C. L. (1981). *Reality Monitoring*. Psychological Review, 88(1), 67-85.
11. Kallem, P. (2026). *Learning to Trust the Crowd: A Multi-Model Consensus Reasoning Engine for Large Language Models*. arXiv:2601.07245.
12. Li, C., Zhang, J., Cheng, A., Ma, Z., Li, X., & Ma, J. (2025). *CPA-RAG: Covert Poisoning Attacks on Retrieval-Augmented Generation in Large Language Models*. arXiv:2505.19864.
13. Liu, F. T., Ting, K. M., & Zhou, Z.-H. (2008). *Isolation Forest*. ICDM 2008.
14. Liu, Y., Liu, Y., Zhang, X., Chen, X., & Yan, R. (2025). *The Truth Becomes Clearer Through Debate! Multi-Agent Systems with Large Language Models Unmask Fake News*. SIGIR 2025.
15. Peng, Y., Wang, J., Yu, H., & Houmansadr, A. (2024). *Data Extraction Attacks in Retrieval-Augmented Generation via Backdoors*. arXiv:2411.01705.
16. Pitre, P., Ramakrishnan, N., & Wang, X. (2025). *CONSENSAGENT: Towards Efficient and Effective Consensus in Multi-Agent LLM Interactions Through Sycophancy Mitigation*. ACL 2025 Findings.
17. Shao, Y., et al. (2025). *POISONCRAFT: Practical Poisoning of Retrieval-Augmented Generation for Large Language Models*. arXiv:2505.06579.
18. Srivastava, S. S. & He, H. (2025). *MemoryGraft: Persistent Compromise of LLM Agents via Poisoned Experience Retrieval*. arXiv:2512.16962.
19. Xiong, C., Zheng, G., Ma, X., Li, C., & Zeng, J. (2025). *DelphiAgent: A Trustworthy Multi-Agent Verification Framework for Automated Fact Verification*. Information Processing & Management.
20. Yang, L., Li, S., & Deng, A. (2026). *Dynamic Consensus Communication Mechanism for Large Language Model-Based Multi-Agent Systems*. Journal of Signal Processing Systems.
21. Zhang, Z., et al. (2025). *A Survey on the Memory Mechanism of Large Language Model-Based Agents*. ACM Transactions on Intelligent Systems and Technology.
22. Zou, W., Geng, R., Wang, B., & Jia, J. (2025). *PoisonedRAG: Knowledge Corruption Attacks to Retrieval-Augmented Generation of Large Language Models*. USENIX Security Symposium 2025.
23. Zügner, D., Akbarnejad, A., & Günnemann, S. (2018). *Adversarial Attacks on Neural Networks for Graph Data*. KDD 2018.

---

## Appendix A: Quick Reference — Human Brain Analogues

| Human Cognitive Defense | Katra Implementation |
|---|---|
| **Source Monitoring** — Remembering WHERE you learned something | Epistemic tier system + chain of custody + source_agent_id tracking |
| **Reality Monitoring** — Distinguishing internal from external | Content hash verification + temporal coherence + cross-validation |
| **Consistency Checking** — Does new info contradict what you know? | Graph contradiction detection + embedding consistency LLM check |
| **Social Corroboration** — Do others confirm? | BFT voting + multi-agent verification + trust-weighted consensus |
| **Salience Filtering** — Not everything is equally important | STD-from-stream deviation → low-deviation memories get normal confidence |
| **Sleep Consolidation** — Brain prunes/consolidates during sleep | Background processor verifies quarantined memories; auto-rejects after N rounds |
| **Reputation Systems** — We trust some sources more than others | Bayesian trust scores, dynamically updated per agent |

## Appendix B: Detection Probability Analysis

For a topical stream with `N` memories and `p` poisoned memories:

**Probability of detecting at least one poisoned memory via STD deviation:**

Assuming poisoned memories are i.i.d. draws from a distribution shifted by `δσ` from the genuine distribution:

```
P(detect ≥ 1 | N, p, δ, k) = 1 - (1 - Φ(δ - k))^(p·N)
```

where:
- `Φ` is the standard normal CDF
- `k` is the threshold in σ units (e.g., k=3 for 3-σ rule)
- `δ` is the attacker's distribution shift in σ units

| δ (shift) | P(detect | p=0.01, N=1000, k=3) | P(detect | p=0.05, N=1000, k=3) |
|---|---|---|---|---|
| 1σ | 15.9% | 57.8% |
| 2σ | 45.0% | 93.3% |
| 3σ | 79.4% | 99.97% |
| 5σ | 99.8% | 100.0% |

**Key insight:** An attacker who can make their poisoned memories blend within 1-2σ of the genuine distribution has a significant chance of evading STD-based detection. This is why **cross-validation (Layer 3)** is essential — it catches what Layer 2 misses.

---

*Document authored for the Katra brain-gap-analysis research track. All architectural recommendations are designed to integrate incrementally with the existing Katra codebase without breaking changes to the MCP protocol or existing agent workflows.*
