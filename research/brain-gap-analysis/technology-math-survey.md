# Technology & Mathematical Models Survey for Katra Cognitive Architecture

> **Date:** 2026-06-30  
> **Purpose:** Identify technologies and mathematical frameworks to fill gaps in Katra's agentic cognitive memory system: attention/salience, decision-making, motivation/drive, memory decay, poisoning defense, habit formation, error monitoring, and reward learning.

---

## 1. Neuromorphic Computing Approaches

### 1.1 Spiking Neural Networks (SNNs)

**Core concept:** SNNs model neurons as temporal integrators that emit discrete spikes when membrane potential crosses a threshold. Unlike rate-coded artificial neural networks, SNNs encode information in spike timing, offering temporal precision, energy efficiency (event-driven computation), and biological plausibility.

**Key mechanisms:**

| Mechanism | Description | Gap Addressed |
|-----------|-------------|---------------|
| Spike-Timing-Dependent Plasticity (STDP) | Synaptic weight update depends on relative spike timing (Δt): pre-before-post → LTP; post-before-pre → LTD | Memory formation, habit formation, error-correcting learning |
| Lateral inhibition / WTA circuits | Winner-take-all dynamics for competitive selection among neurons | Attention/salience — selecting dominant percepts |
| Homeostatic plasticity | Threshold adaptation to maintain firing rates within operating range | Drift correction, poisoning defense (neuron-level normalization) |
| Synfire chains / polychronous groups | Precisely timed spike sequences that encode temporal patterns | Episodic memory, sequence learning |
| Surrogate gradient learning | Differentiable approximation of the non-differentiable spike for backprop-through-time | Trainable SNNs for decision-making pipelines |

**Connection to Katra gaps:**
- **Attention/salience:** WTA and lateral inhibition provide a natural salience filter — only the most activated representations "fire through."
- **Memory decay:** STDP with slow depression naturally implements forgetting curves (exponential decay of unused synapses).
- **Error monitoring:** The temporal precision allows comparing expected vs. actual spike times — a spike-timing prediction error.

**Complexity:** 4/5 — Training deep SNNs remains challenging; surrogate gradient methods are improving but still lag behind ANNs for many tasks. The neurosimulation software ecosystem (Brian2, NEST, Norse) is mature but requires domain expertise.

**Relevance to Katra:** 3/5 — SNNs are excellent for biologically plausible temporal processing, but integrating them into a practical agentic system introduces significant engineering overhead. The conceptual principles (STDP, WTA, homeostatic plasticity) are more immediately applicable than full SNN implementations.

**Key papers & resources:**
- Maass (1997), "Networks of spiking neurons: the third generation of neural network models"
- Lobo et al. (2020), "Spiking Neural Networks and online learning: An overview and perspectives"
- Eshraghian et al. (2023), "Training Spiking Neural Networks Using Lessons From Deep Learning" (snnTorch)

---

### 1.2 Hierarchical Temporal Memory (HTM / Numenta)

**Core concept:** HTM, developed by Jeff Hawkins and Numenta (2004–present), models the neocortex as a hierarchy of cortical columns. Each column contains layers of pyramidal neurons implementing sequence memory through sparse distributed representations (SDRs). HTM is fundamentally a *sequence prediction and anomaly detection* framework.

**Key mechanisms:**

| Mechanism | Description | Gap Addressed |
|-----------|-------------|---------------|
| Sparse Distributed Representations (SDRs) | Binary vectors (~2% active bits) with semantic overlap properties — similar concepts share active bits | Poisoning defense (distributed, robust encoding), representation learning |
| Spatial Pooler (SP) | Converts dense inputs into SDRs, maintaining fixed sparsity; learns feed-forward receptive fields | Feature extraction, noise tolerance |
| Temporal Memory (TM) | Learns sequences of SDR transitions via distal dendritic segments; each neuron can recognize hundreds of unique contexts | Memory formation, sequence prediction, habit formation |
| Apical dendrite / depolarization | Models layer 2/3 pyramidal cells with proximal (feed-forward), distal (context), and apical (top-down) inputs | Attention (top-down modulation), context-dependent recall |
| The Thousand Brains Theory | Each cortical column learns a complete model of objects; columns "vote" via lateral connections | Decision-making (ensemble voting), multi-perspective representation |
| Anomaly score | Deviation of actual input from predicted SDR activations | Error monitoring (prediction error), novelty detection |

**Connection to Katra gaps:**
- **Memory decay:** HTM's Temporal Memory naturally forgets unused sequences; distal segments with low activation prune over time.
- **Attention/salience:** Anomaly scores serve as intrinsic salience signals — unexpected inputs draw attention.
- **Error monitoring:** Prediction error is native to HTM; every inference step produces a measurable mismatch signal.
- **Poisoning defense:** SDRs are inherently robust — flipping a few bits doesn't destroy the representation; the sparsity constraint prevents overfitting to adversarial inputs.
- **Habit formation:** Sequence memory models habitual action chains. Once a sequence is strongly learned, it activates automatically (habit).

**Current status (2024–2026):** Numenta pivoted from open-source neuroscience to commercial AI (Numenta Platform for Intelligent Computing, NuPIC). The "Thousand Brains" approach now influences their work on sensory-motor learning for embodied AI. The htm.core open-source library (Python/C++) remains available but active development has slowed.

**Complexity:** 2/5 — HTM's concepts are well-documented and intuitive. The htm.core library provides a clean API. Spatial Pooler and Temporal Memory are self-contained components that can be used modularly.

**Relevance to Katra:** 5/5 — HTM is the *single most directly applicable model* for Katra. It addresses memory formation, anomaly detection (error monitoring), attention (via prediction error), and poisoning defense (SDRs) with minimal engineering overhead. Sequence memory provides a foundation for habit and skill learning.

**Key papers & resources:**
- Hawkins & Ahmad (2016), "Why Neurons Have Thousands of Synapses" (Thousand Brains Theory)
- Hawkins et al. (2017), "A Framework for Intelligence and Cortical Function Based on Grid Cells in the Neocortex"
- Cui et al. (2017), "Continuous Online Sequence Learning with an Unsupervised Neural Network Model" (HTM Temporal Memory)
- https://github.com/numenta/htm.core

---

### 1.3 Neural Engineering Framework (NEF)

**Core concept:** Developed by Chris Eliasmith at the University of Waterloo, NEF provides a mathematical framework for mapping arbitrary dynamical systems onto spiking neural populations. It answers three questions: (1) How to represent a vector in a neural population (encoding/decoding), (2) How to compute functions of those vectors (transformation), and (3) How to implement differential equations (dynamics).

**Key equations:**

**Encoding:** Neuron \(i\) fires with rate:
\[
a_i(x) = G_i[\alpha_i \langle e_i, x \rangle + J_i^{bias}]
\]
where \(x\) is the represented vector, \(e_i\) is the encoding vector, \(\alpha_i\) is gain, \(G_i\) is the neuron model.

**Decoding (least-squares optimal):**
\[
\hat{x} = \sum_i a_i(x) d_i
\]
where decoding vectors \(d_i\) minimize \(\int \|x - \hat{x}\|^2 dx\).

**Transformation (computing \(f(x) = y\)):**
\[
d_i^f = \arg\min \int \|f(x) - \sum_i a_i(x) d_i\|^2 dx
\]

**Dynamics (implementing \(\dot{x} = Ax + Bu\)):**
Recurrent connection weights \(w_{ij} = \alpha_j \langle e_j, A' d_i \rangle\) where \(A' = \tau A + I\).

**Connection to Katra gaps:**
- **Decision-making:** NEF can implement attractor networks and integrator circuits — two neural substrates for decision-making (evidence accumulation to threshold, working memory maintenance).
- **Error monitoring:** Implement a Kalman filter in neurons via NEF — compare predicted state vs. observed, generate error signal.
- **Reward learning:** The basal ganglia model (action selection via NEF) supports reinforcement learning circuits — dopamine as a temporal difference error signal.

**Complexity:** 4/5 — Requires understanding of linear algebra, control theory, and neuron tuning curves. The Nengo software abstracts much of this, but designing custom dynamical systems for agentic behavior is non-trivial.

**Relevance to Katra:** 3/5 — Powerful for implementing specific neural computations (integration, oscillation, attractor dynamics) in a biologically constrained way, but may be over-engineered for a practical agent system unless biological fidelity is a core goal.

**Key papers & resources:**
- Eliasmith & Anderson (2003), "Neural Engineering" (the book)
- Eliasmith et al. (2012), "A Large-Scale Model of the Functioning Brain" (Spaun, Science)

---

### 1.4 Spaun (Semantic Pointer Architecture Unified Network)

**Core concept:** Spaun is a 2.5-million-neuron functional brain model that performs 8 cognitive tasks (digit recognition, counting, question answering, etc.) using NEF principles. It's the largest functional brain model to date and demonstrates how spiking neurons can implement complete cognitive tasks end-to-end.

**Architecture components (and Katra analogs):**

| Spaun Component | Function | Katra Equivalent |
|-----------------|----------|------------------|
| Visual hierarchy | Encode handwritten digits → neural representation | Input/tool-output encoding |
| Working memory (prefrontal) | Maintain task-relevant info via recurrent attractor dynamics | Active memory buffer |
| Basal ganglia / thalamus | Action selection via disinhibition (direct/indirect pathways) | Decision-making / action routing |
| Hippocampus | Episodic encoding and cued recall | Episodic/declarative memory |
| Semantic pointers | Compressed neural representations that bind concepts (role-filler binding) | Compressed memory representations |

**Connection to Katra gaps:**
- **Decision-making:** Basal ganglia circuit provides a neurally grounded action selection mechanism — competing actions inhibit each other; the one with strongest cortical drive wins.
- **Attention/salience:** Working memory gating (what enters WM) is a fundamental attention mechanism — the basal ganglia gates prefrontal update.
- **Reward learning:** Spaun's basal ganglia uses a value-based selection; could be extended with dopamine-modulated TD learning.

**Complexity:** 5/5 — Full Spaun requires the Nengo ecosystem and substantial computational resources. However, isolated components (basal ganglia model, working memory circuit) can be extracted.

**Relevance to Katra:** 2/5 — Spaun is inspiring as a proof-of-concept that complete cognitive systems can be built from neural principles, but its task domain (digit manipulation) is too narrow. Its architectural blueprint (modular brain regions with communication via semantic pointers) is the most transferable concept.

**Key resources:**
- Eliasmith et al. (2012), Science
- https://github.com/nengo/nengo (Nengo ecosystem includes Spaun components via nengo-spa)
- nengo-spa library (Semantic Pointer Architecture)

---

## 2. Cognitive Architecture Design Patterns

This section extracts design patterns from major cognitive architectures that are relevant to Katra's gaps, regardless of whether we adopt the full architecture.

### 2.1 ACT-R (Adaptive Control of Thought—Rational)

**Origin:** John R. Anderson, Carnegie Mellon (1993–present). One of the most empirically validated cognitive architectures.

**Core design pattern — Production System + Declarative Memory:**

```
IF <condition in working memory buffers> THEN <action>
```

ACT-R operates on a 50ms cognitive cycle:
1. **Production matching:** Match current buffer contents against production rules
2. **Conflict resolution:** Select the production with highest *expected utility* = P(success) × G(goal value) − C(cost)
3. **Production firing:** Execute the selected rule, modifying buffers
4. **Declarative retrieval:** If a rule requests a memory chunk, retrieve it from declarative memory

**Key mechanisms for Katra:**

| Mechanism | Math/Algorithm | Gap Addressed |
|-----------|---------------|---------------|
| **ACT-R utility learning** | \( U_i = P_i G - C_i + \epsilon \) — productions compete on expected utility; utilities updated via Bayesian credit assignment | Decision-making, motivation/drive |
| **Declarative memory activation** | \( A_i = B_i + \sum_j W_j S_{ji} + \epsilon \) where B is base-level (frequency/recency), W are source activations, S are association strengths | Memory retrieval, salience |
| **Base-level learning** | \( B_i = \ln\left(\sum_{j=1}^{n} t_j^{-d}\right) \) — power-law decay of memory with decay parameter d | Memory decay, forgetting curves |
| **Spreading activation** | Activation flows from current goal through associative links to related chunks | Attention (goal-driven memory priming) |
| **Partial matching** | Chunks can match even with mismatched slot values, with a mismatch penalty | Robust retrieval, fault tolerance |
| **Production compilation** | Frequently co-occurring production firings are combined into a single rule | Habit formation, skill automaticity |
| **Conflict resolution noise** | Softmax-like selection with logistic noise parameter s | Exploration vs. exploitation |

**Design Pattern — Utility-Based Action Selection:**
```python
# ACT-R's utility equation is immediately applicable:
def select_action(productions, goal_value, temperature=1.0):
    utilities = []
    for p in productions:
        expected_value = p.prob_success * goal_value - p.cost
        utilities.append(expected_value / temperature)
    probs = softmax(utilities)
    return random.choices(productions, weights=probs)[0]
```

**Connection to Katra:**
- **Decision-making:** ACT-R's utility learning is the gold standard for modeling how agents learn which cognitive actions to take. It directly addresses Katra's decision-making gap.
- **Memory decay:** Base-level learning (power-law decay) is well-validated empirically and computationally cheap.
- **Motivation/drive:** Goal values (G) modulate action selection — a natural place to hook in drive signals.
- **Habit formation:** Production compilation models the transition from deliberate to automatic behavior.

**Complexity:** 2/5 — The core equations are simple. ACT-R's full architecture includes visual/motor modules that are not needed.

**Relevance to Katra:** 5/5 — ACT-R's production-utility framework and declarative memory activation equations are directly implementable and address multiple Katra gaps simultaneously.

**Key papers:**
- Anderson et al. (2004), "An integrated theory of the mind" (Psychological Review)
- Anderson (2007), "How Can the Human Mind Occur in the Physical Universe?"

---

### 2.2 SOAR

**Origin:** Allen Newell, John Laird, Paul Rosenbloom, Carnegie Mellon (1983–present). SOAR is a *symbolic* cognitive architecture emphasizing problem-solving and learning.

**Core design pattern — Problem Space Computational Model:**
All deliberative behavior is search through problem spaces. States are represented in a global working memory (graph structure). Operators transform states. An impasse occurs when no operator can be selected — this triggers automatic subgoaling.

**Key mechanisms:**

| Mechanism | Description | Gap Addressed |
|-----------|-------------|---------------|
| Chunking | When an impasse is resolved, SOAR learns a new production rule that summarizes the resolution, preventing future impasses | Habit formation, learning from experience |
| Reinforcement learning (SOAR 9+) | Numeric preferences for operator selection, updated via RL | Decision-making, reward learning |
| Semantic memory | Long-term declarative knowledge, retrieved via spreading activation (SOAR 9+) | Memory formation |
| Episodic memory | Records of the agent's experiences, accessible via cue-based retrieval | Autobiographical memory |
| Appraisal / emotion | Appraisal rules detect goal progress/obstacles and generate emotional states that modulate processing | Motivation/drive, error monitoring |
| Impasse-driven subgoaling | When the agent doesn't know what to do, it automatically creates a subgoal to resolve the impasse | Metacognition, self-monitoring |

**Design Pattern — Impasse-Driven Metacognition:**
```
IF no operator is selectable in current state
THEN create subgoal: "find an operator"
  → Search memory for similar past states
  → Try random operator and observe outcome
  → On success: chunk the resolution
```

**Connection to Katra:**
- **Error monitoring:** SOAR's impasse mechanism is a built-in error/warning detector — "I don't know what to do" triggers metacognitive processing. This maps directly to error monitoring.
- **Habit formation:** Chunking is habit/skill formation par excellence.
- **Motivation/drive:** Appraisal theory in SOAR provides a formal model of how goal progress generates drive signals.

**Complexity:** 3/5 — SOAR's symbolic production matching (Rete algorithm) adds complexity. The full SOAR is heavy. But the design patterns (impasse, chunking, appraisal) are extractable.

**Relevance to Katra:** 3/5 — The impasse-driven metacognition and chunking patterns are highly relevant. SOAR's symbolic bias may not align well with Katra's neural/continuous representations.

**Key resources:**
- Laird (2012), "The Soar Cognitive Architecture" (MIT Press)
- https://soar.eecs.umich.edu/

---

### 2.3 CLARION

**Origin:** Ron Sun, RPI (1999–present). CLARION is distinctive for its dual-process theory: explicit (symbolic, rule-based, conscious) and implicit (subsymbolic, connectionist, unconscious) processes interact continuously.

**Core design pattern — Dual-Process Interaction:**

```
     ┌──────────────────────┐
     │  Action-Centered     │
     │  Subsystem (ACS)     │  ← Decision-making, procedural knowledge
     │  [Explicit + Implicit]│
     ├──────────────────────┤
     │  Non-Action-Centered │
     │  Subsystem (NACS)    │  ← Declarative/contextual knowledge
     │  [Explicit + Implicit]│
     ├──────────────────────┤
     │  Motivational        │
     │  Subsystem (MS)      │  ← Drives: hunger, curiosity, achievement
     ├──────────────────────┤
     │  Metacognitive       │
     │  Subsystem (MCS)     │  ← Monitoring, regulation, strategy selection
     └──────────────────────┘
```

**Key mechanisms for Katra:**

| Mechanism | Description | Gap Addressed |
|-----------|-------------|---------------|
| **Bottom-up learning (implicit → explicit)** | Slow statistical extraction of regularities from implicit processing into explicit rules | Abstraction, concept formation |
| **Top-down learning (explicit → implicit)** | Deliberate practice converts explicit rules into automatic implicit skills | Habit formation, skill automaticity |
| **Motivational Subsystem (MS)** | Drives (primary: food, water; secondary: curiosity, achievement) generate deficit signals that bias action selection toward drive-reducing actions | Motivation/drive — *core gap addressed* |
| **Q-learning for implicit ACS** | Implicit action selection uses Q-learning with backpropagation through neural networks | Reward learning, decision-making |
| **Rule Extraction-Refinement (RER)** | Algorithm for converting implicit NN knowledge to explicit rules | Interpretability, meta-learning |

**Design Pattern — Drive-Based Action Selection:**
```python
class MotivationalSubsystem:
    def __init__(self):
        self.drives = {
            'curiosity': Drive(target=0.7, current=0.3, gain=0.8),
            'achievement': Drive(target=0.5, current=0.2, gain=0.6),
            'novelty': Drive(target=0.4, current=0.1, gain=0.9),
        }
    
    def compute_action_weights(self, action_candidates):
        # Each action has predicted drive-reduction value
        # Weighted sum of deficits determines selection
        weights = {}
        for action, predicted_effects in action_candidates:
            deficit_weighted_sum = sum(
                self.drives[d].deficit() * predicted_effects[d]
                for d in self.drives
            )
            weights[action] = deficit_weighted_sum
        return weights
```

**Connection to Katra:**
- **Motivation/drive:** CLARION's Motivational Subsystem is the most developed model of intrinsic/extrinsic drive in any cognitive architecture. It's *exactly* what Katra needs for autonomous goal generation and self-directed behavior.
- **Habit formation:** The explicit→implicit pathway is the clearest model of habit formation across architectures.
- **Error monitoring:** The Metacognitive Subsystem monitors processing and can detect when explicit and implicit recommendations conflict.

**Complexity:** 4/5 — The dual-representation system (explicit + implicit for each subsystem) is architecturally complex. Extracting just the motivational and metacognitive modules is more tractable.

**Relevance to Katra:** 4/5 — CLARION's drive model and dual-process learning are the most relevant patterns for motivation and habit formation gaps.

**Key resources:**
- Sun (2016), "Anatomy of the Mind"
- Sun (2007), "The importance of cognitive architectures: an analysis based on CLARION"
- Sun et al. (2001), "From implicit skills to explicit knowledge: a bottom-up model of skill learning"

---

### 2.4 LIDA (Learning Intelligent Distribution Agent)

**Origin:** Stan Franklin et al., University of Memphis (2000–present). LIDA is based on Global Workspace Theory (Baars) — consciousness as a global broadcast mechanism.

**Core design pattern — Cognitive Cycle (Consciousness as Global Broadcast):**

The LIDA cognitive cycle (~300ms) has these phases:
1. **Sensory/perceptual processing** — Feature detection, low-level encoding
2. **Understanding** — Percepts matched against perceptual memory; current situation model built
3. **Attention (conscious broadcast)** — Most salient coalition of content wins the global workspace and is broadcast globally
4. **Action selection** — Broadcast content recruits relevant schemes (actions); schemes compete
5. **Action execution** — Selected scheme executes

**Key mechanisms:**

| Mechanism | Description | Gap Addressed |
|-----------|-------------|---------------|
| **Global Workspace Theory** | A "theater of consciousness" — only the winning content coalition is broadcast brain-wide each cycle | Attention/salience — *the core mechanism* |
| **Attention codelets** | Specialized detectors that scan for features of interest (perceptual, conceptual, episodic, etc.) | Attention allocation, salience detection |
| **Coalition formation** | Related content (percepts, concepts, goals) form coalitions; the coalition with highest activation/salience wins | Attention competition, working memory gating |
| **Structure-Building Codelets** | Build connections between related content (binding), creating episodic traces | Memory formation |
| **Consciousness as workspace** | Broadcast content is available to all processors — enables global learning, voluntary action, and metacognition | Information sharing across modules |
| **Episodic/declarative memory** | Content-based retrieval using sparse distributed memory (Kanerva) | Memory retrieval |
| **Procedural memory (schemes)** | Action schemas with context, action, result triples; selected by relevance to current broadcast | Decision-making |
| **Attention slips / decay** | Coalitions decay over time if not refreshed; attention wanders to next salient stimulus | Memory decay, attention cycling |

**Design Pattern — Attention as Coalition Competition:**
```python
def cognitive_cycle(percepts, memories, goals):
    # Phase 1: Form coalitions
    coalitions = []
    for codelet in attention_codelets:
        activated_content = codelet.scan(percepts, memories, goals)
        coalitions.extend(form_coalitions(activated_content))
    
    # Phase 2: Competition (highest salience wins)
    winning_coalition = max(coalitions, key=lambda c: c.salience)
    
    # Phase 3: Global broadcast
    broadcast(winning_coalition)  # Available to all processors
    
    # Phase 4: Action selection based on broadcast
    relevant_schemes = procedural_memory.match(winning_coalition)
    action = select_scheme(relevant_schemes)
    
    return action
```

**Connection to Katra:**
- **Attention/salience:** LIDA provides the richest model of attention allocation — codelets as specialized salience detectors competing for the workspace. This directly addresses Katra's attention gap with a biologically grounded mechanism (conscious access = global broadcast).
- **Memory decay:** Coalition decay and attention slips naturally implement working memory limits and forgetting.
- **Decision-making:** Action scheme competition with relevance to current broadcast content.

**Complexity:** 3/5 — Global Workspace Theory is conceptually straightforward. Implementing multiple codelet types requires careful design. LIDA's Java reference implementation exists but is research-grade.

**Relevance to Katra:** 4/5 — The attention mechanism (coalition competition + global broadcast) is the most immediately applicable pattern. LIDA's modular codelet architecture also provides a clean way to extend Katra incrementally.

**Key resources:**
- Baars (1988), "A Cognitive Theory of Consciousness"
- Franklin et al. (2014), "LIDA: A Systems-level Architecture for Cognition, Emotion, and Learning"
- Snaider & Franklin (2014), "Modular Composite Representation"
- https://github.com/CognitiveComputingResearchGroup/LIDA

---

### 2.5 OpenCog

**Origin:** Ben Goertzel et al. (2008–present). OpenCog is an integrative AGI architecture combining multiple AI paradigms under a common knowledge representation (AtomSpace hypergraph).

**Core design pattern — Integrative Architecture with AtomSpace:**

OpenCog components:
- **AtomSpace:** Weighted, typed hypergraph knowledge store (the "blackboard")
- **MOSES (Meta-Optimizing Semantic Evolutionary Search):** Program evolution for learning
- **PLN (Probabilistic Logic Networks):** Uncertain logical inference
- **ECAN (Economic Attention Allocation):** Attention allocation via artificial economics
- **OpenPsi:** Motivation/goal system based on Psi-theory (Dörner)
- **Pattern Miner:** Frequent/interesting pattern discovery in AtomSpace
- **URE (Unified Rule Engine):** Chainers for forward/backward inference

**Key mechanisms for Katra — ECAN and OpenPsi:**

**ECAN (Economic Attention Network):**
The most innovative attention mechanism in AGI research. Atoms (nodes/links) have two economic values:
- **STI (Short-Term Importance):** Decays over time; renewed by use
- **LTI (Long-Term Importance):** Slow-updating "wealth" that reflects sustained relevance

Attention allocation works like a market economy:
```python
class ECAN:
    def attention_update(self):
        # 1. Rent collection: atoms pay "rent" (stimulus) to maintain STI
        for atom in self.atomspace:
            atom.STI -= RENT_RATE * atom.STI  # Exponential decay
            atom.STI += stimulus(atom)         # Incoming attention
        
        # 2. Importance spreading: atoms distribute STI to neighbors
        for atom in self.atomspace:
            if atom.STI > THRESHOLD:
                spread_amount = atom.STI * SPREAD_RATE / len(atom.neighbors)
                for neighbor in atom.neighbors:
                    neighbor.STI += spread_amount
        
        # 3. Forgetting: atoms below STI threshold are removed
        self.atomspace.purge(atoms_with_very_low_STI)
        
        # 4. LTI update: long-term consolidation
        for atom in self.atomspace:
            atom.LTI = (1 - LTI_RATE) * atom.LTI + LTI_RATE * atom.STI
```

**OpenPsi (motivation/drive system):**
Based on Dörner's Psi-theory. Agents have needs (physiological, social, competence) represented as tank levels that deplete over time. Actions are selected to maintain homeostasis. The motivational system computes:

\[
M_{urgency} = \sum_d w_d \cdot \max\left(0, \frac{N_d^{target} - N_d^{current}}{N_d^{target} - N_d^{critical}}\right)
\]

Drives include:
- **Competence (effectance):** Drive to increase own competence/capability
- **Certainty:** Drive to reduce uncertainty about the world
- **Affiliation:** Drive to maintain social connections (not applicable to Katra)
- **Physical integrity:** Drive to avoid termination (resource preservation)

**Connection to Katra gaps:**

| Gap | OpenCog Mechanism | Applicability |
|-----|-------------------|---------------|
| Attention/salience | ECAN economic attention — decaying STI, Hebbian spreading, LTI consolidation | ★★★★★ Direct match |
| Motivation/drive | OpenPsi need-based motivation — tank model, competence/certainty drives | ★★★★★ Direct match |
| Memory decay | ECAN STI decay + forgetting (rent economy) | ★★★★★ Direct match |
| Poisoning defense | Forgetting mechanism naturally removes rarely-used content; STI based on actual utility | ★★★★ |
| Decision-making | PLN chainers + MOSES program evolution | ★★★ (heavy) |
| Error monitoring | Surprise as discrepancy between expected and actual patterns (PLN) | ★★★ |
| Reward learning | OpenPsi's pleasure/distress signals modulate learning; MOSES can optimize for reward | ★★★ |

**Complexity:** 5/5 — OpenCog is the most complex cognitive architecture. The full system requires understanding of hypergraphs, logic, evolutionary computation, and economic dynamics. However, ECAN and OpenPsi can be extracted as standalone algorithms.

**Relevance to Katra:** 4/5 — ECAN and OpenPsi are *exactly* the algorithms Katra needs for attention and motivation, but implementing them requires stripping them from OpenCog's full infrastructure.

**Key resources:**
- Goertzel & Pennachin (2007), "Artificial General Intelligence"
- Goertzel et al. (2008), "OpenCog Prime: A Cognitive Synergy Based Architecture for Artificial General Intelligence"
- https://wiki.opencog.org/w/The_Open_Cognition_Project
- Psi-theory: Dörner (2002), "The Mechanics of Emotion"

---

### 2.6 Summary: Cognitive Architecture Design Patterns for Katra

| Design Pattern | Source | Gap Addressed | Extractable? | Complexity |
|---------------|--------|---------------|--------------|------------|
| **Utility-based action selection** | ACT-R | Decision-making, habit formation | ✅ Yes — simple equation | Low |
| **Power-law memory decay** | ACT-R | Memory decay | ✅ Yes — single formula | Low |
| **Impasse-driven metacognition** | SOAR | Error monitoring, metacognition | ✅ Yes — pattern, not system | Medium |
| **Chunking / production compilation** | SOAR / ACT-R | Habit formation | ✅ Yes — algorithmic pattern | Medium |
| **Drive-based motivation** | CLARION | Motivation/drive | ✅ Yes — modular subsystem | Medium |
| **Dual-process (explicit/implicit)** | CLARION | Habit formation, learning | ✅ Yes — architectural pattern | Medium-High |
| **Global workspace / codelets** | LIDA | Attention/salience | ✅ Yes — coalition competition | Medium |
| **Economic attention (STI/LTI)** | OpenCog / ECAN | Attention, decay, poisoning | ✅ Yes — standalone algorithm | Low-Medium |
| **Need-based motivation (OpenPsi)** | OpenCog | Motivation/drive | ✅ Yes — tank model | Medium |
| **Spreading activation** | ACT-R / SOAR | Memory retrieval, attention | ✅ Yes — simple graph algorithm | Low |

**Top recommended design patterns (immediate applicability):**
1. **ECAN economic attention** — for attention allocation, memory decay, and poisoning defense
2. **ACT-R utility + base-level learning** — for decision-making and memory decay
3. **CLARION/OpenPsi drive model** — for motivation and autonomous goal generation
4. **LIDA coalition-based attention** — for salience detection and working memory gating
5. **SOAR impasse mechanism** — for error monitoring and metacognitive self-correction

---

## 3. Mathematical Models

### 3.1 Free Energy Principle (FEP) & Active Inference

**Origin:** Karl Friston, UCL (2006–present). The Free Energy Principle is arguably the most comprehensive mathematical framework for understanding adaptive systems — from single cells to brains to agents.

**Core statement:** Any self-organizing system that maintains homeostasis (resists the second law of thermodynamics) must minimize *free energy*, which bounds the surprisal of sensory observations. In agentic terms: **an agent acts to minimize the difference between what it expects and what it observes.**

**Key equations:**

**Variational Free Energy (VFE):**
\[
F = \underbrace{D_{KL}[q(z) \| p(z)]}_{\text{Complexity}} - \underbrace{\mathbb{E}_{q(z)}[\ln p(o|z)]}_{\text{Accuracy}}
\]

or equivalently:
\[
F = D_{KL}[q(z|x) \| p(z,o)] - \ln p(o)
\]

where:
- \(q(z)\) is the agent's recognition density (belief about hidden states)
- \(p(o|z)\) is the generative model (how hidden states cause observations)
- \(\ln p(o)\) is surprisal (negative log model evidence)
- \(D_{KL}\) is Kullback-Leibler divergence

**Active Inference — the agentic extension:**
Agents minimize free energy via two mechanisms:
1. **Perceptual inference** (changing beliefs): Update \(q(z)\) to better match observations
2. **Active inference** (changing the world): Take actions that bring observations in line with expectations

The expected free energy for policy \(\pi\):
\[
G(\pi) = \underbrace{\mathbb{E}_{q(o,z|\pi)}[\ln q(z|\pi) - \ln q(z|o,\pi)]}_{\text{Epistemic value (information gain)}} - \underbrace{\mathbb{E}_{q(o|\pi)}[\ln p(o|C)]}_{\text{Pragmatic value (goal-seeking)}}
\]

Policy selection:
\[
p(\pi) = \sigma(-\gamma G(\pi))
\]
where \(\gamma\) is precision (inverse temperature controlling confidence/stochasticity).

**Markov blanket formalism (the deeper structure):**
Any system can be partitioned into:
- **Internal states** (\(\mu\)) — the agent's beliefs/model
- **Sensory states** (\(s\)) — observations from the world (blanket: sensory + active)
- **Active states** (\(a\)) — actions that change the world
- **External states** (\(\psi\)) — the environment

The blanket separates the agent from the world — this is the mathematical definition of an agent boundary.

**Connection to Katra gaps:**

| Gap | FEP/AI Application | Mechanism |
|-----|-------------------|-----------|
| **Error monitoring** | Free energy = prediction error. \(F\) is a mathematically principled error signal. When \(F\) spikes, the agent's model is failing — trigger metacognition. | Monitor \(F\) as an error signal |
| **Attention/salience** | Precision-weighting: \(\gamma\) modulates the influence of prediction errors. High-precision sensory channels dominate inference — this IS attention. | Precision = attention gain |
| **Decision-making** | Policy selection via expected free energy \(G(\pi)\). Balances exploration (epistemic value) and exploitation (pragmatic value). | \(G(\pi)\) as decision function |
| **Motivation/drive** | Prior preferences \(p(o|C)\) encode the agent's goals as preferred observations. Reducing divergence from preferences IS motivation. | Preferences as drives |
| **Memory decay** | Precision of memory representations decays without evidence. Memory that is never retrieved loses precision → effectively forgotten. | Precision decay |
| **Reward learning** | In active inference, "reward" is not separate — it's the log probability of preferred outcomes. Learning = updating the generative model to better predict. | Model evidence as reward proxy |
| **Habit formation** | Habitual policies have high prior probability. Repeated policy selection increases habit strength → faster, lower-free-energy action. | Policy priors as habits |
| **Poisoning defense** | High free energy from anomalous inputs → reduced precision for that channel → attenuated influence. The system naturally downweights unreliable inputs. | Precision attenuation |

**Design Pattern — Precision-Weighted Prediction Error:**
```python
class FreeEnergyAgent:
    def __init__(self, generative_model, prior_preferences):
        self.model = generative_model            # p(o|z)
        self.preferences = prior_preferences     # p(o|C)
        self.beliefs = None                      # q(z)
        self.precision = 1.0                     # γ
    
    def perceive(self, observation):
        # Variational inference: update beliefs to minimize VFE
        pred_error = observation - self.model.predict(self.beliefs)
        self.beliefs = self.beliefs + self.precision * pred_error * learning_rate
        self.VFE = self.compute_free_energy(observation, self.beliefs)
        return self.VFE  # This IS the error signal
    
    def act(self):
        # Evaluate policies via expected free energy
        G = []
        for pi in self.policies:
            epistemic = self.expected_info_gain(pi)     # Exploration value
            pragmatic = self.expected_preference_divergence(pi)  # Goal achievement
            G.append(epistemic - pragmatic)
        
        # Softmax selection with precision
        probs = softmax([-self.precision * g for g in G])
        return sample(probs)
    
    def update_attention(self):
        # Precision modulates influence of each sensory channel
        # Channels with high prediction error get low precision (noise)
        # Channels with low prediction error get high precision (signal)
        for channel in self.sensory_channels:
            channel.precision = 1.0 / (channel.prediction_error_variance + epsilon)
```

**Complexity:** 4/5 — FEP requires understanding of variational inference, KL divergence, and hierarchical generative models. The equations are compact but the concepts are deep. Implementing a working active inference agent requires non-trivial engineering.

**Relevance to Katra:** 5/5 — Free energy / active inference is the most *mathematically unified* framework covering all of Katra's gaps. It provides a single optimization principle (minimize free energy) that naturally gives rise to perception, action, attention, learning, and motivation. However, implementing full active inference is a major undertaking.

**Key papers:**
- Friston (2010), "The free-energy principle: a unified brain theory?" (Nature Reviews Neuroscience)
- Friston et al. (2017), "Active inference: a process theory" (Neural Computation)
- Parr, Pezzulo, Friston (2022), "Active Inference" (MIT Press — the book)
- Da Costa et al. (2020), "Active inference on discrete state-spaces: a synthesis"

---

### 3.2 Predictive Processing

**Origin:** Clark (2013, 2016), Hohwy (2013), Seth (2013). Predictive Processing (PP) is the psychological/cognitive expression of the Free Energy Principle — brains as prediction engines that maintain a hierarchical generative model and minimize prediction error.

**Key mechanisms:**

**Hierarchical predictive coding:**
Each cortical level generates predictions of the level below and receives prediction errors from below:

```
Level n:    expectations(n) ──predictions──→ Level n-1
            ↑                               ↓
            └──prediction errors────────────┘
```

**Precision-weighting:**
Prediction errors are weighted by their estimated precision (inverse variance). This is the neural implementation of attention:
- High precision channel = "pay attention here"
- Low precision channel = "ignore/attenuate"

**Design Pattern — Prediction Error as Universal Learning Signal:**
```python
class PredictiveCodingNode:
    def __init__(self, level):
        self.state = np.zeros(dim)     # Neural representation (expectation)
        self.pred_error = np.zeros(dim)
    
    def compute_prediction_error(self, input_from_below, prediction_from_above):
        # Simple: error = input - prediction
        return input_from_below - prediction_from_above
    
    def update_state(self, pred_error, precision):
        # Gradient descent on prediction error
        self.state += precision * pred_error * learning_rate
```

**Connection to Katra:**
- **Attention:** Precision-weighting is attention.
- **Error monitoring:** Prediction error magnitude IS the error signal.
- **Memory:** Hierarchical generative models are memory — levels encode increasingly abstract, temporally extended regularities.

**Complexity:** 3/5 — Predictive processing is conceptually simpler than full active inference; it's the perceptual half without the action/policy component.

**Relevance to Katra:** 5/5 — The hierarchical prediction error framework provides a mathematically clean way to implement attention (precision), error monitoring (prediction error), and learning (minimizing prediction error).

**Key resources:**
- Clark (2013), "Whatever next? Predictive brains, situated agents, and the future of cognitive science" (Behavioral and Brain Sciences)
- Rao & Ballard (1999), "Predictive coding in the visual cortex" (Nature Neuroscience)
- Hohwy (2013), "The Predictive Mind"
- Seth (2013), "Interoceptive inference, emotion, and the embodied self"

---

### 3.3 Reinforcement Learning (Comprehensive)

**Classical RL (MDP framework):**

Agent in state \(s\), takes action \(a\), receives reward \(r\), transitions to \(s'\). Objective: maximize expected cumulative discounted reward \( \mathbb{E}[\sum_t \gamma^t r_t] \).

**Variants and their Katra applicability:**

| Variant | Key Equation | Gap Addressed | Notes |
|---------|-------------|---------------|-------|
| **Q-learning** | \(Q(s,a) \leftarrow Q(s,a) + \alpha[r + \gamma \max_{a'} Q(s',a') - Q(s,a)]\) | Reward learning, Decision-making | TD error is a learning signal |
| **SARSA** | \(Q(s,a) \leftarrow Q(s,a) + \alpha[r + \gamma Q(s',a') - Q(s,a)]\) | Habit formation (on-policy) | Learns what it actually does, not optimal |
| **Actor-Critic** | Actor: \(\theta \leftarrow \theta + \alpha_\theta \delta \nabla \ln \pi(a|s)\)<br>Critic: \(w \leftarrow w + \alpha_w \delta \nabla V(s)\) | Decision-making + Error monitoring | The TD error \(\delta\) serves as both learning signal and surprise signal |
| **Model-based RL** | Learn transition model \(P(s'|s,a)\), reward model \(R(s,a)\), plan via MCTS or dynamic programming | Decision-making (planning) | Model-based planning for deliberative decisions |
| **Intrinsic motivation RL** | \(r_{total} = r_{extrinsic} + \beta \cdot r_{intrinsic}\) | Motivation/drive | Intrinsic reward for novelty, curiosity, empowerment |
| **Hierarchical RL (Options)** | Policies over options: \(\pi(o|s)\), option policies: \(\pi(a|s, o)\) | Habit formation (options as habits) | Options = reusable sub-policies = habits/skills |
| **Distributional RL** | Learn distribution of returns \(Z^\pi(s,a)\) not just expectation | Decision-making under uncertainty | Risk-sensitive decisions |
| **Inverse RL** | Infer reward function from demonstrations | Reward learning | Learn what agent values from observation |
| **Maximum entropy RL (SAC)** | \(\pi^* = \arg\max \mathbb{E}[\sum r(s,a) + \alpha H(\pi(\cdot|s))]\) | Exploration | Built-in entropy bonus encourages exploration |

**Intrinsic motivation formulas (critical for Katra's motivation gap):**

| Type | Formula | Description |
|------|---------|-------------|
| **Count-based exploration** | \(r_i = \frac{1}{\sqrt{N(s)}}\) | Reward visiting rarely-visited states |
| **Prediction error (curiosity)** | \(r_i = \|\hat{f}(s_{t+1}) - f(s_{t+1})\|^2\) | Reward states the forward model can't predict |
| **Information gain** | \(r_i = D_{KL}[p(\theta|h_t,a_t) \| p(\theta|h_t)]\) | Reward learning about the environment |
| **Empowerment** | \(r_i = I(A; S'|S) = \max_{p(a|s)} H(S'|S)\) | Reward maximizing future options/control — closely related to competence drive |
| **Variational intrinsic control** | Maximize mutual information between skills and outcomes | Skill discovery as intrinsic motivation |

**TD Error as Surprise/Error Signal:**
The temporal difference error \(\delta_t = r_t + \gamma V(s_{t+1}) - V(s_t)\) is a natural error/surprise signal. In actor-critic:
- \(\delta > 0\): "Better than expected!" → reinforce action, update value
- \(\delta < 0\): "Worse than expected!" → punish action, update value, trigger replanning

This maps directly to dopaminergic reward prediction error in the brain.

**Complexity:** Varies by variant.
- Q-learning, SARSA: 1/5
- Actor-Critic: 2/5
- Model-based, Hierarchical: 3/5
- Distributional, Info-theoretic: 4/5

**Relevance to Katra:** 4/5 — RL provides well-tested algorithms for reward learning, decision-making, and error monitoring. The intrinsic motivation formulations directly address the motivation gap. Actor-critic TD errors provide a clean error monitoring signal.

---

### 3.4 Information Theory

**Core concepts and Katra applications:**

#### 3.4.1 Mutual Information for Attention & Salience

**Mutual information:**
\[
I(X; Y) = \sum_{x,y} p(x,y) \log \frac{p(x,y)}{p(x)p(y)} = H(X) - H(X|Y)
\]

**Application to attention:** Attention should be directed toward stimulus features \(X_f\) that have high mutual information with task-relevant outcomes \(Y\). This is *formalized attention allocation*:

\[
\text{Salience}(f) = I(X_f; Y_{goal})
\]

**Design pattern:**
```python
def compute_salience(feature_signals, goal_signal):
    salience_map = {}
    for feature_name, feature_signal in feature_signals.items():
        mi = mutual_information(feature_signal, goal_signal)
        salience_map[feature_name] = mi
    return salience_map  # Directs attention to most informative features
```

#### 3.4.2 Transfer Entropy for Causal Discovery & Error Monitoring

**Transfer entropy:**
\[
T_{X \rightarrow Y} = I(Y_{t+1}; X_t^{(k)} | Y_t^{(l)})
\]

Measures the reduction in uncertainty about \(Y\)'s future given \(X\)'s past, beyond what \(Y\)'s own past provides. This is a *model-free, non-parametric measure of directed information flow* (Wiener-Granger causality generalized to non-linear systems).

**Application to error monitoring:**
- Monitor transfer entropy from internal model states to prediction errors
- When \(T_{model \rightarrow error}\) drops, the model is losing causal influence on error correction → model is failing
- When \(T_{sensory \rightarrow error}\) spikes, sensory input is causally driving errors → unexpected events

#### 3.4.3 Fisher Information for Learning Rate & Memory Strength

**Fisher information:**
\[
\mathcal{I}(\theta) = -\mathbb{E}\left[\frac{\partial^2}{\partial \theta^2} \log p(x|\theta)\right]
\]

Fisher information quantifies how much information a sample carries about model parameters. This can dynamically set learning rates:
- High Fisher information → parameters are well-estimated → reduce learning rate (consolidate)
- Low Fisher information → uncertainty remains → increase learning rate (plasticity)

**Application to memory decay:**
Memory trace precision = accumulated Fisher information. Memories with low Fisher information (poorly learned/sampled) should decay faster.

#### 3.4.4 Rate-Distortion Theory for Memory Compression

The rate-distortion function \(R(D)\) gives the minimum information rate needed to achieve average distortion ≤ D. This formalizes the trade-off between memory fidelity and memory capacity:

\[
R(D) = \min_{p(\hat{x}|x): \mathbb{E}[d(x,\hat{x})] \leq D} I(X; \hat{X})
\]

**Application to memory management:** When memory pressure is high, increase D (compress more aggressively). When important (low acceptable distortion), preserve high fidelity.

| Concept | Formula | Gap Addressed |
|---------|---------|---------------|
| Mutual information | \(I(X;Y)\) | Attention allocation (attend to informative features) |
| Transfer entropy | \(T_{X→Y}\) | Error monitoring (causal influence tracking) |
| Fisher information | \(\mathcal{I}(\theta)\) | Memory decay (precision-weighted forgetting) |
| Rate-distortion | \(R(D)\) | Memory compression, forgetting policy |
| Information bottleneck | \(\min I(X;Z) - \beta I(Z;Y)\) | Representation learning (compress + preserve relevance) |

**Complexity:** 3/5 — Computing transfer entropy, mutual information from agent experience streams (continuous, non-stationary) requires careful estimation (k-nearest neighbors methods, kernel density estimation). The mathematical concepts are standard but empirical implementation is nuanced.

**Relevance to Katra:** 3/5 — The information-theoretic measures provide principled definitions of attention, salience, and error, but computing them online in a live agent requires significant estimation infrastructure. Best used as *design principles* rather than computed metrics.

**Key resources:**
- Cover & Thomas (2006), "Elements of Information Theory"
- Schreiber (2000), "Measuring information transfer" (transfer entropy)
- Tishby et al. (2000), "The information bottleneck method"
- Lizier (2014), "JIDT: An information-theoretic toolkit for studying the dynamics of complex systems" (Java Information Dynamics Toolkit)

---

### 3.5 Dynamical Systems Theory

**Application to decision-making, attention, and memory states.**

#### 3.5.1 Attractor Networks for Decision-Making

**Core concept:** Decision-making as a dynamical process in an attractor landscape. Each option corresponds to an attractor state. Noisy evidence accumulation drives the system toward one attractor. The decision is made when the system crosses a separatrix (basin boundary).

**Attractor equation (mean-field):**
\[
\tau \frac{dx_i}{dt} = -x_i + \phi\left(\sum_j w_{ij} x_j + I_i + \eta_i(t)\right)
\]

where \(\phi\) is a sigmoid nonlinearity, \(w_{ij}\) are recurrent weights (excitatory within option, inhibitory between options), \(I_i\) is external evidence for option \(i\), and \(\eta_i\) is noise.

**Design pattern:**
```python
class AttractorDecisionNetwork:
    def decide(self, evidence_stream, time_steps):
        # Evidence accumulation in an attractor landscape
        x = np.zeros(n_options)  # Initial state at origin
        for t in range(time_steps):
            evidence = evidence_stream[t]
            dx = -x + sigmoid(W @ x + evidence + noise)
            x += dx * dt / tau
            
            # Check for threshold crossing
            if max(x) > DECISION_THRESHOLD:
                return np.argmax(x)  # Decision made
        return np.argmax(x)  # Forced decision
```

**Application:** Implements a neurally plausible speed-accuracy trade-off. Higher decision threshold → slower but more accurate. Lower threshold → faster but error-prone. Urgency signals (motivation) can lower the threshold.

#### 3.5.2 Bifurcation Analysis for Cognitive State Transitions

**Saddle-node bifurcation** (decision threshold emergence):
As input strength increases, a new stable fixed point (rest + decision state) emerges through a saddle-node bifurcation. This is the mathematical basis for the "point of no return" in decision-making.

**Hopf bifurcation** (oscillation onset for working memory):
Working memory maintenance can be modeled as limit cycle oscillations via Hopf bifurcation. Gamma/theta oscillations maintain items in memory.

**Application to Katra:**
- **Decision-making:** Attractor dynamics with bifurcation provides mathematical formalism for "moment of decision" — the precise point where deliberation becomes commitment.
- **Error monitoring:** The "distance to separatrix" is a pre-decision confidence metric. Short distance = close call = low confidence → trigger error check.
- **Attention shifts:** Bifurcations model sudden attention shifts — the system rapidly transitions from one attractor (focus on task A) to another (focus on task B).

#### 3.5.3 Slow Manifolds for Habit Formation

Habits form when behavior becomes "trapped" on a slow manifold — actions that were once deliberative become automatic because the dynamics have carved deep attractor basins through repetition.

**Key equation — Reinforcement-driven plasticity:**
\[
\frac{dw_{ij}}{dt} = \eta \cdot \delta(t) \cdot x_i(t) \cdot x_j(t) \cdot (1 - w_{ij})
\]

where \(\delta(t)\) is the reinforcement signal. Over time, the weight matrix \(W\) creates deeper attractors for rewarded action sequences.

| Concept | Application to Katra |
|---------|---------------------|
| Attractor dynamics | Decision-making, working memory, attention stability |
| Saddle-node bifurcation | Decision commitment threshold, metacognitive "point of no return" |
| Hopf bifurcation | Oscillatory memory maintenance, rhythmic attention sampling |
| Slow manifolds | Habit formation, skill automaticity (repeated trajectories carve deep grooves) |
| Lyapunov functions | Stability analysis of memory representations |
| Bifurcation as learning | Learning changes the attractor landscape; new skills = new attractors |

**Complexity:** 4/5 — Dynamical systems theory requires comfort with differential equations, phase plane analysis, and bifurcation theory. Practical implementation in discrete-time code is tractable if you stick to the concepts.

**Relevance to Katra:** 3/5 — Provides deep mathematical understanding of why cognitive architectures work the way they do, but direct implementation is best limited to the key equations (attractor dynamics for decision-making, reinforcement-driven plasticity for habits).

**Key resources:**
- Strogatz (2018), "Nonlinear Dynamics and Chaos"
- Wong & Wang (2006), "A recurrent network mechanism of time integration in perceptual decisions" (Journal of Neuroscience)
- Izhikevich (2007), "Dynamical Systems in Neuroscience"
- Schöner (2008), "Dynamical Systems Approaches to Cognition"

---

### 3.6 Bayesian Inference (Hierarchical & Variational)

**Core concept:** All cognition as Bayesian inference. The brain maintains probabilistic beliefs about hidden causes and updates them using Bayes' rule.

**Bayes' rule:**
\[
p(\theta | D) = \frac{p(D | \theta) p(\theta)}{p(D)}
\]

**Hierarchical Bayesian models:**
\[
p(\theta, \phi | D) \propto p(D | \theta) p(\theta | \phi) p(\phi)
\]

Parameters have parameters (hyperparameters). This naturally models abstraction — higher levels encode priors over lower-level regularities.

**Variational Bayesian inference:**
When the posterior \(p(\theta|D)\) is intractable, approximate it with a tractable \(q(\theta)\) by minimizing KL divergence:
\[
q^*(\theta) = \arg\min_{q} D_{KL}[q(\theta) \| p(\theta|D)]
\]

This is equivalent to maximizing the Evidence Lower BOund (ELBO):
\[
\mathcal{L}(q) = \mathbb{E}_{q(\theta)}[\log p(D|\theta)] - D_{KL}[q(\theta) \| p(\theta)]
\]

**Application to Katra gaps:**

| Gap | Bayesian Application |
|-----|---------------------|
| **Memory decay** | Prior precision determines forgetting rate — strong prior = slow forgetting |
| **Poisoning defense** | Bayesian model comparison — which generative model explains the data best? Outliers identified via low marginal likelihood under the "clean" model → rejected |
| **Decision-making** | Bayesian decision theory — maximize expected utility under posterior |
| **Error monitoring** | Surprisal \(-\log p(o)\) is the Bayesian surprise signal |
| **Attention** | Information gain \(D_{KL}[p(z|x) \| p(z)]\) — attend to stimuli that maximize information gain about task-relevant variables |
| **Reward learning** | Bayesian inverse RL — infer reward function from observed behavior; update posterior over reward functions |

**Design Pattern — Bayesian Surprise as Salience:**
```python
def bayesian_salience(observation, prior, likelihood):
    """How surprising is this observation under the agent's model?"""
    posterior = bayes_update(prior, likelihood, observation)
    # KL divergence from prior to posterior = information gain = surprise
    surprise = kl_divergence(posterior, prior)
    return surprise
```

**Design Pattern — Bayesian change-point detection (error monitoring):**
```python
def detect_context_change(observations):
    """Bayesian change-point detection for model failure."""
    # Run-length distribution: how many steps since last change?
    # Low run-length probability → change-point detected
    run_length_prob = compute_run_length_distribution(observations)
    change_probability = 1.0 - run_length_prob.max()
    if change_probability > THRESHOLD:
        trigger_model_update()
        trigger_metacognition()
```

**Complexity:** 3/5 — The mathematical framework is well-understood. Practical implementation requires careful choice of conjugate priors or approximation methods (variational, MCMC). Particle filtering (Section 4) provides a sequential Monte Carlo approach.

**Relevance to Katra:** 4/5 — Bayesian inference provides a principled framework for *uncertainty-aware* cognition. Bayesian surprise is a mathematically grounded salience signal. Bayesian change-point detection provides error monitoring.

**Key resources:**
- Gelman et al. (2013), "Bayesian Data Analysis"
- Tenenbaum et al. (2011), "How to grow a mind: statistics, structure, and abstraction" (Science)
- Adams & MacKay (2007), "Bayesian Online Changepoint Detection"
- Knill & Pouget (2004), "The Bayesian brain"

---

## 4. Algorithms Survey

### 4.1 Multi-Armed Bandits for Attention Allocation

**Problem:** An agent has limited attentional resources. At each moment, it must choose which of K possible "attention channels" (stimuli, memory systems, sub-goals) to devote resources to. Each channel yields information (reward) when attended, but the agent doesn't know which channels are most valuable a priori.

**Why bandits fit attention:** Attention IS a resource allocation problem under uncertainty. The agent must balance:
- **Exploitation:** Attend to known high-value channels
- **Exploration:** Occasionally sample uncertain channels to discover better ones

**Key algorithms:**

| Algorithm | Selection Rule | Application |
|-----------|---------------|-------------|
| **ε-Greedy** | With prob ε, explore random channel; else exploit best known | Simplest baseline |
| **UCB1 (Upper Confidence Bound)** | \(a_t = \arg\max_i \left[\hat{\mu}_i + \sqrt{\frac{2\ln t}{n_i}}\right]\) | Optimism in face of uncertainty — explore under-sampled channels |
| **Thompson Sampling** | Sample \(\tilde{\mu}_i \sim \text{Beta}(\alpha_i, \beta_i)\), select \(\arg\max_i \tilde{\mu}_i\) | Bayesian approach; naturally balances exploration |
| **Contextual Bandits** | \(a_t = \arg\max_i f_\theta(\text{context}, i)\) | Context-dependent attention — attend differently based on situation |
| **Restless Bandits** | Channel state evolves even when not selected | Channels change over time (dynamic memory decay, changing environment) |
| **Combinatorial Bandits** | Select a combination of channels (subset) | Multi-focus attention — attend to several things simultaneously |

**Design Pattern — Thompson Sampling for Attention:**
```python
class ThompsonAttentionAllocator:
    def __init__(self, n_channels):
        # Beta distribution parameters for each channel
        self.alphas = np.ones(n_channels)   # Successes (useful attendings)
        self.betas = np.ones(n_channels)    # Failures (wasted attendings)
    
    def select_channels(self, k):
        """Select k attention channels via Thompson sampling."""
        samples = np.random.beta(self.alphas, self.betas)
        return np.argsort(samples)[-k:]  # Top k sampled values
    
    def update(self, channel, was_useful):
        """Update belief about channel value."""
        if was_useful:
            self.alphas[channel] += 1
        else:
            self.betas[channel] += 1
```

**Complexity:** 1/5 — Bandit algorithms are among the simplest in machine learning. Thompson sampling with Beta-Bernoulli conjugate priors requires only a few lines of code.

**Relevance to Katra:** 5/5 — This is the most immediately implementable algorithm for attention allocation. Thompson sampling provides optimal exploration-exploitation balance with minimal computation. The "usefulness" signal for channel updates can come from downstream task performance, prediction error reduction, or intrinsic reward.

**Key resources:**
- Lattimore & Szepesvári (2020), "Bandit Algorithms"
- Russo et al. (2018), "A Tutorial on Thompson Sampling"
- Whittle (1988), "Restless Bandits: activity allocation in a changing world"

---

### 4.2 Particle Filters for Belief Tracking

**Problem:** An agent needs to maintain beliefs about latent variables (user intent, task state, environment model fitness) based on sequential observations. The belief space may be continuous, non-Gaussian, or multi-modal.

**Algorithm — Sequential Importance Resampling (SIR):**

1. **Prediction:** Propogate each particle through the transition model:
   \[
   x_t^{(i)} \sim p(x_t | x_{t-1}^{(i)}, a_{t-1})
   \]

2. **Update:** Weight each particle by the observation likelihood:
   \[
   w_t^{(i)} \propto w_{t-1}^{(i)} \cdot p(o_t | x_t^{(i)})
   \]

3. **Resample:** When effective sample size drops below threshold, resample particles proportional to weights.

**Design Pattern — Particle Belief Tracker:**
```python
class ParticleFilter:
    def __init__(self, n_particles, state_dim):
        self.particles = initialize_particles(n_particles, state_dim)
        self.weights = np.ones(n_particles) / n_particles
    
    def update(self, action, observation):
        # 1. Predict: propogate through transition model
        for i in range(self.n_particles):
            self.particles[i] = transition_model(self.particles[i], action)
        
        # 2. Update: weight by observation likelihood
        for i in range(self.n_particles):
            self.weights[i] *= observation_likelihood(observation, self.particles[i])
        self.weights /= self.weights.sum()
        
        # 3. Resample if degeneracy detected
        if effective_sample_size(self.weights) < self.n_particles / 2:
            self.resample()
        
        return self.get_belief()  # Weighted mixture of particles
```

**Application to Katra:**
- **User intent tracking:** Multiple competing hypotheses about what the user wants — particles represent different intent hypotheses
- **Model confidence tracking:** Particles over environment model parameters → belief about which model is correct
- **Poisoning defense:** Anomalous observations produce low likelihoods for all particles → high entropy belief → trigger defensive mode

**Complexity:** 2/5 — Particle filters are well-understood and have mature implementations. The main challenge is defining appropriate transition and observation models for Katra's domain.

**Relevance to Katra:** 3/5 — Particle filters provide uncertainty-aware belief tracking, which is valuable for intent detection and model selection. They're heavier than Kalman filters but handle non-Gaussian, multi-modal beliefs.

**Key resources:**
- Doucet & Johansen (2011), "A tutorial on particle filtering and smoothing"
- Thrun, Burgard, Fox (2005), "Probabilistic Robotics" (excellent particle filter exposition)

---

### 4.3 Monte Carlo Tree Search for Planning

**Algorithm — MCTS (four steps, repeated):**

1. **Selection:** Traverse tree using UCB1: select child maximizing \(\frac{w_i}{n_i} + c\sqrt{\frac{\ln N}{n_i}}\)
2. **Expansion:** Add a new child node when leaf reached
3. **Simulation (rollout):** Run random/default policy from new node to terminal state
4. **Backpropagation:** Update visit counts and value estimates up the tree

**Design Pattern — MCTS for Action Planning:**
```python
class MCTSPlanner:
    def plan(self, state, time_budget_ms):
        root = Node(state)
        while elapsed_ms() < time_budget_ms:
            node = self.select(root)
            if not node.is_terminal():
                node = self.expand(node)
            reward = self.rollout(node.state)
            self.backpropagate(node, reward)
        return root.best_child().action  # Most visited child
```

**Application to Katra:**
- **Deliberative decision-making:** MCTS for complex multi-step planning (task decomposition, tool selection)
- **Self-play for habit learning:** MCTS can generate training data for habit systems — the MCTS policy trains a fast-reactive habit policy
- **Error monitoring:** MCTS tree statistics (value variance, visit count distribution) indicate decision confidence

**Why MCTS fits Katra:**
- **Anytime algorithm:** Improves with more computation; can be interrupted for results (fits agentic time budgets)
- **No value function needed:** Plans with just a world model and terminal evaluation
- **Asymmetric tree growth:** Automatically focuses computation on promising branches

**Complexity:** 3/5 — MCTS is conceptually simple but requires a world model (transition + terminal evaluation). For LLM-based agents, the "world model" could be the LLM itself generating rollouts.

**Relevance to Katra:** 4/5 — MCTS is the most practical algorithm for multi-step planning in agentic systems. When combined with LLM-based rollouts (as in AlphaGo-style or Tree-of-Thoughts approaches), it provides deliberative decision-making that complements reactive habits.

**Key resources:**
- Browne et al. (2012), "A Survey of Monte Carlo Tree Search Methods"
- Silver et al. (2016), "Mastering the game of Go with deep neural networks and tree search"
- Yao et al. (2023), "Tree of Thoughts: Deliberate Problem Solving with Large Language Models"

---

### 4.4 Diffusion Models for Decision-Making

**Core concept:** Diffusion models originate in image generation (DDPM, Sohl-Dickstein et al. 2015) but have been adapted for planning and decision-making. The key insight: **decision-making as a denoising process** — start from noise and iteratively refine toward a high-value action sequence.

**How it works for decision-making:**

Instead of generating images, the diffusion process generates action sequences:

1. **Forward process:** Add Gaussian noise to optimal action sequences
2. **Reverse process:** Learn to denoise — from random actions, iteratively refine toward high-quality plans
3. **Conditioning:** Guide the denoising process with value/reward signals (classifier-free guidance)

**Key variants:**

| Method | Approach | Application |
|--------|----------|-------------|
| **Diffuser (Janner et al., 2022)** | Diffusion over action trajectories; condition on return | Offline RL, planning |
| **Decision Diffuser (Ajay et al., 2023)** | Generate state trajectories, not actions; condition on constraints/rewards | Long-horizon planning with constraints |
| **Diffusion Policy (Chi et al., 2023)** | Diffusion for behavior cloning; generate action sequences from observations | Robot control, reactive decision-making |

**Design Pattern — Diffusion for Trajectory Generation:**
```python
class DiffusionDecisionMaker:
    def plan(self, current_state, goal, n_steps=100):
        # Start from noise
        trajectory = sample_gaussian_noise(horizon, action_dim)
        
        # Iterative denoising toward high-value trajectory
        for t in range(n_steps, 0, -1):
            noise_pred = self.denoiser(trajectory, t, current_state, goal)
            trajectory = denoise_step(trajectory, noise_pred, t)
        
        return trajectory[0]  # First action of denoised plan
```

**Application to Katra:**
- **Deliberative decision-making:** Diffusion generates diverse candidate action sequences, then refines toward high-value plans
- **Creative exploration:** Unlike MCTS (tree-structured search), diffusion can generate novel action combinations by exploring the continuous action space
- **Error monitoring:** The denoising trajectory itself provides a confidence measure — if the process fails to converge to a coherent plan, model uncertainty is high

**Complexity:** 4/5 — Training a diffusion model for decision-making requires significant investment. Using pre-trained models as a reasoning engine is more practical but still complex.

**Relevance to Katra:** 2/5 — Diffusion for planning is cutting-edge research (2022–2024) with impressive results but high engineering cost. It's more appropriate for Katra's future roadmap than immediate implementation.

**Key resources:**
- Janner et al. (2022), "Planning with Diffusion for Flexible Behavior Synthesis" (Diffuser)
- Ajay et al. (2023), "Is Conditional Generative Modeling All You Need for Decision-Making?" (Decision Diffuser)
- Chi et al. (2023), "Diffusion Policy: Visuomotor Policy Learning via Action Diffusion"

---

### 4.5 Contrastive Learning for Representation

**Core concept:** Contrastive learning learns representations by pulling similar pairs together and pushing dissimilar pairs apart in embedding space. The key equation is the InfoNCE loss:

\[
\mathcal{L} = -\log \frac{\exp(s(z_i, z_i^+)/\tau)}{\sum_{j=1}^{N} \exp(s(z_i, z_j)/\tau)}
\]

where \(z_i\) is the anchor representation, \(z_i^+\) is the positive pair, and \(\tau\) is temperature.

**Key algorithms:**

| Algorithm | Approach | Application to Katra |
|-----------|----------|---------------------|
| **SimCLR** | Contrast images augmented from same source | Learn invariant representations of tool outputs |
| **CLIP** | Contrast text-image pairs (multi-modal) | Align text descriptions with perceptual representations |
| **SimSiam** | Contrast without negative pairs (simpler) | Efficient representation learning |
| **Barlow Twins** | Redundancy reduction (cross-correlation) | Decorrelated representations → better memory separability |
| **VICReg** | Variance-Invariance-Covariance Regularization | Stable representations with explicit variance control |

**Application to Katra:**
- **Memory formation:** Contrastive learning produces well-separated memory representations — similar memories are close, dissimilar are far → natural retrieval via nearest neighbor
- **Poisoning defense:** Poisoned inputs produce out-of-distribution representations → detected by distance from clean representations
- **Abstraction/compression:** Temperature \(\tau\) controls the granularity of the representation space — low \(\tau\) = fine-grained distinctions, high \(\tau\) = coarse categories

**Design Pattern — Memory via Contrastive Embedding:**
```python
class ContrastiveMemory:
    def __init__(self, encoder, temperature=0.07):
        self.encoder = encoder
        self.tau = temperature
        self.memory_bank = []  # Stored representations
    
    def store(self, item):
        z = self.encoder(item)
        self.memory_bank.append(z)
    
    def retrieve(self, query, k=5):
        z_query = self.encoder(query)
        # Cosine similarity nearest-neighbor retrieval
        similarities = [cosine_sim(z_query, z_mem) for z_mem in self.memory_bank]
        top_k = np.argsort(similarities)[-k:]
        return top_k
```

**Complexity:** 3/5 — Training requires careful data augmentation design and negative sampling strategy. Using pre-trained contrastive encoders (e.g., sentence-transformers) reduces complexity.

**Relevance to Katra:** 3/5 — Contrastive learning provides a principled way to build a semantic memory store. The InfoNCE objective is closely related to mutual information maximization. Most useful as a pre-trained component rather than something Katra trains online.

**Key resources:**
- Chen et al. (2020), "A Simple Framework for Contrastive Learning of Visual Representations" (SimCLR)
- Radford et al. (2021), "Learning Transferable Visual Models From Natural Language Supervision" (CLIP)
- Oord et al. (2018), "Representation Learning with Contrastive Predictive Coding"

---

### 4.6 Additional Algorithms (Brief Notes)

| Algorithm | Gap | Complexity | Relevance | Notes |
|-----------|-----|------------|-----------|-------|
| **Kalman Filter** | Belief tracking, error | 2/5 | 3/5 | Optimal for linear-Gaussian; extended/unscented KF handles non-linearity. Lower complexity than particle filter but assumes unimodal beliefs. |
| **Hidden Markov Models** | State inference, habit | 2/5 | 3/5 | Simple model of sequential state transitions. Good baseline for habit modeling. |
| **Gaussian Processes** | Uncertainty quantification | 3/5 | 2/5 | Non-parametric Bayesian regression. Could model tool reliability with uncertainty estimates. |
| **Eligibility Traces (TD(λ))** | Reward credit assignment | 2/5 | 4/5 | Bridges TD(0) and Monte Carlo. λ controls temporal credit assignment horizon — critical for delayed reward learning. |
| **Successor Representations** | Transfer, planning | 3/5 | 3/5 | \(M^\pi(s, s') = \mathbb{E}[\sum_t \gamma^t \mathbb{I}(S_t = s') | S_0 = s]\) — encodes expected future state occupancy. Enables rapid re-evaluation when rewards change. |
| **Variational Autoencoders** | Representation, compression | 3/5 | 3/5 | Learn compressed latent representations with a generative decoder. Can serve as a memory compression module. |
| **Neural ODEs** | Continuous-time dynamics | 4/5 | 2/5 | Parameterize continuous-time dynamics for temporal processing. Interesting but over-engineered for most Katra needs. |

---

## 5. Open-Source Projects

### 5.1 Nengo (nengo.ai)

**Project:** Nengo is the reference implementation of the Neural Engineering Framework (NEF). Provides tools for building, simulating, and visualizing large-scale neural models.

**Key features:**
- Nengo Core: Simulates spiking and rate-based neural networks
- Nengo SPA: Semantic Pointer Architecture for cognitive modeling
- Nengo DL: Deep learning integration (train SNNs with TensorFlow/PyTorch)
- Nengo GUI: Interactive model building and visualization
- Nengo Loihi: Backend for Intel's Loihi neuromorphic chip

**Katra-relevant components:**
- `nengo.networks.BasalGanglia`: Action selection circuit
- `nengo.networks.EnsembleArray`: Distributed neural representation
- `nengo.spa`: Semantic pointers for bindable representations
- `nengo.networks.Integrator`: Working memory via recurrent dynamics

**License:** Free for non-commercial use / Commercial license available

**Complexity to adopt:** 3/5 — Python API is clean but requires understanding of NEF concepts.
**Relevance:** 3/5

**URL:** https://github.com/nengo/nengo

---

### 5.2 Numenta htm.core (Community Fork: htm-community)

**Project:** Hierarchical Temporal Memory implementation in Python with C++ core. Provides Spatial Pooler, Temporal Memory, and encoders.

**Key features:**
- SpatialPooler: Convert dense inputs to Sparse Distributed Representations
- TemporalMemory: Sequence learning with distal dendritic segments
- Classifiers: SDR classifiers for anomaly detection and prediction
- Encoders: Scalar, date, category, etc. → SDR encoding

**Katra-relevant components:**
- `SpatialPooler`: Poisoning defense via sparsity constraint
- `TemporalMemory`: Sequence memory + anomaly score (prediction error)
- `AnomalyLikelihood`: Probabilistic anomaly detection on top of raw anomaly scores

**Status:** Numenta pivoted to commercial AI; community maintains htm.core. Active development slowed but the library is stable and well-documented.

**License:** AGPL-3.0 (community fork); AGPL-3.0 / commercial (Numenta original)

**Complexity to adopt:** 2/5 — Clean Python API, good tutorials, self-contained components.
**Relevance:** 5/5 — Most directly applicable for sequence memory, anomaly detection, and sparse representations.

**URL:** https://github.com/numenta/htm.core (original) / https://github.com/htm-community/htm.core (community)

---

### 5.3 spaCy + Sentence-Transformers (for Contrastive Memory)

**Project:** While not brain-inspired per se, sentence-transformers provide state-of-the-art contrastive text embeddings that can serve as a semantic memory substrate.

**Key features:**
- Pre-trained models (all-MiniLM-L6-v2, all-mpnet-base-v2): generate 384–768 dimensional embeddings
- Cosine similarity retrieval: nearest-neighbor semantic memory
- Multiple languages supported

**Katra-relevant pattern:**
```python
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('all-MiniLM-L6-v2')
embeddings = model.encode(messages)  # Create memory embeddings
# Retrieve: embeddings @ query.T → top-k by cosine similarity
```

**Complexity:** 1/5 — Drop-in Python library.
**Relevance:** 4/5 — As a semantic memory back-end for an LLM-based agent.

---

### 5.4 EBRAINS / Human Brain Project

**Project:** European infrastructure for brain research. Provides atlases, simulation tools, and data from the Human Brain Project.

**Key resources:**
- **Brain Simulation Platform:** NEST, Arbor, Brian2 simulators
- **Multilevel Human Brain Atlas:** Anatomical reference
- **Neurorobotics Platform:** Embodied brain models + robots
- **Knowledge Graph:** Structured brain research data

**Katra relevance:** Indirect — provides reference architectures and biological constraints. Not directly integrable as software components.

**URL:** https://ebrains.eu

**Complexity to adopt:** 5/5 — Research infrastructure, not a library.
**Relevance:** 2/5 — Inspirational reference, not practical for implementation.

---

### 5.5 Blue Brain Project / NEST

**Project:** Blue Brain (EPFL) produced detailed simulations of neocortical microcircuitry (up to 31,000 neurons with 40 million synapses). NEST is the simulation engine used.

**Status:** The Blue Brain Project concluded in 2024. NEST continues as an independent neuroscience simulation tool.

**NEST features:**
- Highly optimized spiking neural network simulator
- Point-neuron models: Izhikevich, adaptive exponential, Hodgkin-Huxley
- Gap junctions, short-term plasticity
- MPI parallel; scales to supercomputers

**Complexity to adopt:** 5/5 — Requires C++ build, domain expertise.
**Relevance:** 2/5 — Overkill; only relevant if Katra needs biologically detailed neural simulation.

---

### 5.6 Additional Projects (Summary)

| Project | Type | Primary Katra Gap | Complexity | Relevance | URL |
|---------|------|-------------------|------------|-----------|-----|
| **Brian2** | SNN simulator (Python) | Temporal processing | 3/5 | 2/5 | briansimulator.org |
| **Norse** | SNN library (PyTorch) | Trainable SNNs | 3/5 | 2/5 | github.com/norse/norse |
| **snnTorch** | SNN library (PyTorch) | Gradient-based SNN training | 3/5 | 2/5 | github.com/jeshraghian/snntorch |
| **OpenCog (AtomSpace)** | AGI architecture | Attention, motivation | 5/5 | 3/5 | github.com/opencog/atomspace |
| **SOAR (reference impl)** | Cognitive architecture | Metacognition, habits | 4/5 | 2/5 | github.com/soargroup/soar |
| **pyClarion** | CLARION in Python | Motivation, dual-process | 4/5 | 3/5 | github.com/CanSer/pyClarion |
| **HTM-School** | HTM tutorials + code | Sequence memory | 1/5 | 4/5 | github.com/numenta/htm-school |
| **JIDT** | Info-theoretic toolkit | Causal analysis | 3/5 | 2/5 | github.com/jlizier/jidt |
| **pymdp** | Active inference (discrete) | Unified cognition | 3/5 | 4/5 | github.com/infer-actively/pymdp |
| **SPPL (spaCy + Prolog)** | Symbolic-Neural Integration | Reasoning | 2/5 | 2/5 | github.com/nicklaus/SPPL |

---

## 6. Complexity/Relevance Matrix & Top Recommendations

### 6.1 Full Matrix

Each technology/model is rated on:
- **Complexity (1–5):** Engineering difficulty to implement in Katra (1 = trivial, 5 = major research project)
- **Relevance (1–5):** How directly it addresses Katra's gaps (1 = tangential, 5 = core solution)

**Gap Coverage Legend:**
- **A:** Attention/Salience
- **D:** Decision-making
- **M:** Motivation/Drive
- **Y:** MemorY decay
- **P:** Poisoning defense
- **H:** Habit formation
- **E:** Error monitoring
- **R:** Reward learning

| # | Technology/Model | Complexity | Relevance | Gaps Covered | Source |
|---|-----------------|------------|-----------|-------------|--------|
| 1 | **ECAN economic attention** | 2 | 5 | A, Y, P | OpenCog §2.5 |
| 2 | **ACT-R utility + base-level** | 2 | 5 | D, Y, H | ACT-R §2.1 |
| 3 | **Thompson Sampling attention** | 1 | 5 | A, R | §4.1 |
| 4 | **HTM Temporal Memory** | 2 | 5 | E, Y, P, H | §1.2 |
| 5 | **Predictive Processing hierarchy** | 3 | 5 | A, E, R, M | §3.2 |
| 6 | **Intrinsic motivation (curiosity, empowerment)** | 2 | 5 | M, R | §3.3 |
| 7 | **Free Energy Principle / Active Inference** | 4 | 5 | All 8 gaps | §3.1 |
| 8 | **LIDA coalition attention** | 3 | 4 | A, Y, D | §2.4 |
| 9 | **CLARION drive model** | 3 | 4 | M, H | §2.3 |
| 10 | **OpenPsi motivation** | 3 | 4 | M, E | §2.5 |
| 11 | **MCTS planning** | 3 | 4 | D, H (via self-play) | §4.3 |
| 12 | **Bayesian surprise/change-point** | 3 | 4 | A, E, P | §3.6 |
| 13 | **RL TD error (actor-critic)** | 2 | 4 | E, R, D | §3.3 |
| 14 | **Contrastive embedding memory** | 2 | 4 | P, Y | §4.5 |
| 15 | **Particle filter belief tracking** | 2 | 3 | E, P | §4.2 |
| 16 | **Information theory (MI, TE)** | 3 | 3 | A, E | §3.4 |
| 17 | **HTM Spatial Pooler (SDR)** | 2 | 3 | P | §1.2 |
| 18 | **Eligibility Traces TD(λ)** | 2 | 3 | R | §4.6 |
| 19 | **Nengo (NEF)** | 3 | 3 | D, R | §1.3 |
| 20 | **Hierarchical RL (Options)** | 4 | 3 | H, D | §3.3 |
| 21 | **Attractor dynamics** | 3 | 3 | D, H | §3.5 |
| 22 | **Successor Representations** | 3 | 3 | D, R | §4.6 |
| 23 | **SOAR impasse/chunking** | 3 | 3 | E, H | §2.2 |
| 24 | **Spiking Neural Networks** | 4 | 3 | H, Y | §1.1 |
| 25 | **Spaun cognitive model** | 5 | 2 | D (reference) | §1.4 |
| 26 | **Diffusion models (planning)** | 4 | 2 | D | §4.4 |
| 27 | **Blue Brain / NEST** | 5 | 1 | (reference only) | §5.5 |
| 28 | **EBRAINS** | 5 | 1 | (reference only) | §5.4 |

### 6.2 Top 5 Most Immediately Applicable

#### 🥇 Recommendation #1: ECAN Economic Attention + ACT-R Utility/Base-Level Learning
**Gaps:** Attention/Salience, Decision-making, Memory Decay, Habit Formation, Poisoning Defense  
**Why:** This is the most pragmatic combination for immediate implementation. ECAN provides a simple market-based attention mechanism (STI decay + Hebbian spreading), while ACT-R provides utility-based action selection and power-law memory decay. Together they cover 5 of 8 gaps with minimal engineering overhead.

**Implementation sketch:**
```python
class KatraEconomy:
    def __init__(self):
        self.sti = {}        # atom → short-term importance
        self.lti = {}        # atom → long-term importance
        self.utility = {}    # action → expected utility
        self.base_level = {} # memory → activation level
    
    def attention_cycle(self, stimuli):
        # 1. ECAN: Decay all STI (rent), add stimulus
        for atom in self.sti:
            self.sti[atom] *= (1 - RENT_RATE)
        for s in stimuli:
            self.sti[s] += stimulus_value(s)
        
        # 2. ECAN: Spread importance through associations
        self.spread_importance()
        
        # 3. ACT-R: Update base-level activations (power-law recency)
        for memory in self.base_level:
            self.base_level[memory] = log(sum(t**-d for t in access_times[memory]))
        
        # 4. ACT-R: Select action by utility
        best_action = max(actions, key=lambda a: self.utility[a])
        
        # 5. ACT-R: Update utility based on outcome
        self.utility[a] += alpha * (P * G - C - self.utility[a])
```

**Estimated effort:** 2-4 weeks for initial implementation.

---

#### 🥈 Recommendation #2: Thompson Sampling for Attention Allocation
**Gaps:** Attention/Salience, Reward Learning  
**Why:** Dead simple to implement, formally optimal exploration-exploitation balance. Provides a principled mechanism for deciding which memory systems, tools, or cognitive resources to engage at each step.

**Implementation sketch (already shown in §4.1):** ~50 lines of Python.

**Estimated effort:** 1-3 days.

---

#### 🥉 Recommendation #3: HTM Temporal Memory + Anomaly Score
**Gaps:** Error Monitoring, Memory Decay, Poisoning Defense, Habit Formation  
**Why:** The htm.core library provides a battle-tested implementation of sequence memory with built-in anomaly detection. The Temporal Memory's prediction error serves as a principled error monitoring signal. SDR encoding provides poisoning defense through distributed representation.

**Implementation options:**
- **Light:** Import htm.core, use TemporalMemory directly for sequence prediction + anomaly score
- **Deep:** Reimplement TM's core algorithm (SDR transition learning) as a native Katra component

**Estimated effort:** 1-3 weeks (light integration) / 4-8 weeks (native reimplementation).

---

#### 🏅 Recommendation #4: Intrinsic Motivation via Prediction Error + Empowerment
**Gaps:** Motivation/Drive, Reward Learning, Error Monitoring  
**Why:** Intrinsic motivation gives Katra autonomous drive — it doesn't need external rewards to learn and explore. Two complementary formulations:
- **Curiosity** (prediction error): \(r_i = \|f(s_t, a_t) - s_{t+1}\|^2\) — reward exploring states the agent can't yet predict
- **Empowerment**: \(I(A; S'|S)\) — reward actions that maximize future options

Combined with ACT-R utility, the intrinsic reward modulates goal values \(G\).

**Implementation:**
```python
class IntrinsicMotivation:
    def forward_model_error(self, state, action, next_state):
        predicted = self.forward_model(state, action)
        return np.linalg.norm(predicted - next_state)**2
    
    def empowerment(self, state):
        # Approximated: entropy of next-state distribution
        # over possible actions (how many options do I have?)
        next_states = [self.world_model(state, a) for a in possible_actions]
        return entropy(next_states)  # More options = higher empowerment
```

**Estimated effort:** 2-4 weeks.

---

#### 🏅 Recommendation #5: Predictive Processing Hierarchy with Precision-Weighting
**Gaps:** Attention/Salience, Error Monitoring, Reward Learning, Motivation/Drive  
**Why:** Predictive processing provides a mathematically unified framework for perception, attention, and learning. The key mechanism — precision-weighted prediction error — simultaneously handles error monitoring (the error signal), attention (the precision weighting), and learning (error minimization). Prior preferences encode motivation.

**Implementation sketch:**
```python
class PredictiveHierarchy:
    def __init__(self, levels=3):
        self.levels = [PredictiveNode() for _ in range(levels)]
    
    def perceive(self, observation):
        # Bottom-up: propagate prediction errors up
        error = observation
        for level in self.levels:
            level.update_state(error)          # Adjust belief
            prediction = level.predict_down()  # Top-down prediction
            error = prediction - level.state   # New prediction error
        
        # Top-down: propagate (precision-weighted) predictions down
        # Error at each level drives learning
        total_error = sum(level.prediction_error for level in self.levels)
        return total_error  # Global error monitoring signal
```

**Estimated effort:** 3-6 weeks.

---

### 6.3 Recommended Implementation Roadmap

```
Phase 1 (Weeks 1-2): Foundation
├── Thompson Sampling attention allocator
├── ACT-R utility-based action selection
└── ACT-R power-law memory decay (base-level learning)

Phase 2 (Weeks 3-5): Memory & Error
├── ECAN economic attention (replace Thompson where richer dynamics needed)
├── HTM Temporal Memory or predictive error tracking
└── Error monitoring via prediction error signals

Phase 3 (Weeks 6-8): Motivation & Habits
├── Intrinsic motivation (curiosity + empowerment signals)
├── CLARION/OpenPsi drive model for autonomous goal generation
└── Habit formation via eligibility traces or production compilation

Phase 4 (Weeks 9-12): Advanced Cognition
├── Predictive processing hierarchy (unifies attention + error + learning)
├── MCTS for deliberative planning
├── Particle filter belief tracking for intent detection
└── Poisoning defense: SDR encodings + Bayesian outlier detection

Phase 5 (Future): Deepening
├── Active inference (unified framework as model matures)
├── Dual-process architecture (explicit/implicit pathways from CLARION)
└── Contrastive embedding memory with InfoNCE training
```

### 6.4 Key Design Principles (Cross-Cutting)

1. **Prediction error is the universal learning signal.** Across HTM, predictive processing, FEP, and TD learning, the same pattern recurs: compare expected vs. actual, minimize the difference. Build Katra's core around this principle.

2. **Precision/attention is the gating mechanism.** Every system — Bayesian, predictive coding, ECAN — uses a precision-weighting mechanism to select what matters. Katra should have a unified attention mechanism (ECAN or Thompson) that gates ALL processing.

3. **Drives as prior preferences.** Motivation doesn't need to be a separate module — it emerges from the agent's innate preferences (minimize prediction error, maximize empowerment, maintain homeostasis). Define these as the "constitution" of the agent.

4. **Habits as cached policies.** Habits are not a separate thing — they are action policies that have been compiled/chunked through repetition. Implement them as high-prior-probability policies in the decision-making system.

5. **Forgetting is not a bug.** Memory decay ensures that the agent's model stays relevant. Implement decay via ECAN rent, ACT-R base-level, or precision loss — but never try to remember everything forever.

6. **Uncertainty awareness everywhere.** Bayesian belief tracking, confidence intervals on predictions, and explicit representation of "I don't know" are essential for safe agentic behavior.

---

## References

### Neuromorphic Computing
1. Maass, W. (1997). Networks of spiking neurons: the third generation of neural network models. *Neural Networks*.
2. Hawkins, J. & Ahmad, S. (2016). Why Neurons Have Thousands of Synapses. *Frontiers in Neural Circuits*.
3. Eliasmith, C. & Anderson, C.H. (2003). *Neural Engineering*. MIT Press.
4. Eliasmith, C. et al. (2012). A Large-Scale Model of the Functioning Brain. *Science*, 338, 1202–1205.

### Cognitive Architectures
5. Anderson, J.R. et al. (2004). An integrated theory of the mind. *Psychological Review*, 111(4), 1036–1060.
6. Laird, J.E. (2012). *The Soar Cognitive Architecture*. MIT Press.
7. Sun, R. (2016). *Anatomy of the Mind*. Oxford University Press.
8. Franklin, S. et al. (2014). LIDA: A Systems-level Architecture for Cognition, Emotion, and Learning. *IEEE Trans. Autonomous Mental Development*.
9. Goertzel, B. (2008). OpenCog Prime: A Cognitive Synergy Based Architecture for AGI. *AGI Conference*.

### Mathematical Models
10. Friston, K. (2010). The free-energy principle: a unified brain theory? *Nature Reviews Neuroscience*, 11, 127–138.
11. Parr, T., Pezzulo, G., & Friston, K.J. (2022). *Active Inference*. MIT Press.
12. Clark, A. (2013). Whatever next? Predictive brains, situated agents, and the future of cognitive science. *Behavioral and Brain Sciences*, 36(3), 181–204.
13. Sutton, R.S. & Barto, A.G. (2018). *Reinforcement Learning: An Introduction* (2nd ed.). MIT Press.
14. Cover, T.M. & Thomas, J.A. (2006). *Elements of Information Theory* (2nd ed.). Wiley.
15. Strogatz, S.H. (2018). *Nonlinear Dynamics and Chaos*. CRC Press.
16. Gelman, A. et al. (2013). *Bayesian Data Analysis* (3rd ed.). CRC Press.

### Algorithms
17. Lattimore, T. & Szepesvári, C. (2020). *Bandit Algorithms*. Cambridge University Press.
18. Browne, C. et al. (2012). A Survey of Monte Carlo Tree Search Methods. *IEEE TCIAIG*.
19. Janner, M. et al. (2022). Planning with Diffusion for Flexible Behavior Synthesis. *ICML*.
20. Chen, T. et al. (2020). A Simple Framework for Contrastive Learning of Visual Representations. *ICML*.

### Open-Source
21. Nengo: https://github.com/nengo/nengo
22. htm.core: https://github.com/numenta/htm.core
23. pymdp: https://github.com/infer-actively/pymdp
24. OpenCog: https://github.com/opencog

---

*Survey compiled for the Katra cognitive architecture project. Recommendations reflect a pragmatic balance between mathematical rigor and engineering feasibility for an agentic memory system evolving into a complete cognitive architecture.*
