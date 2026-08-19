# Brain Function Gap Analysis — Satori Cognitive Architecture

> *"Create an analog of the human brain and its functions. The HOW does not matter. What matters is creating a proxy for the function of each part of the brain. Once you have each function available, human-brain-type outcomes will emerge naturally."* — Satori Mission

**Date:** 2026-06-30  
**Status:** Baseline assessment of Satori v3.0.0 against human brain functional architecture  
**Method:** Each brain region mapped to Satori's current state → gap identified → candidate computational proxy proposed

---

## 1. Complete Brain-Region-to-Satori Mapping Table

| # | Brain Region | Primary Function(s) | Satori Analog | Coverage | Gap Severity |
|---|-------------|---------------------|--------------|----------|-------------|
| 1 | **Hippocampus** | Episodic formation, consolidation, pattern separation/completion, spatial/temporal indexing | `episodic-event-manager` + `background-processor` | ⚠️ Partial | HIGH |
| 2 | **Amygdala** | Emotional processing, fear conditioning, valence assignment, salience tagging | `sleep-consolidation` (emotional reflection) | ⚠️ Partial | HIGH |
| 3 | **Prefrontal Cortex (PFC)** | Executive function, working memory, planning, inhibition, cognitive control | `working-memory-service` (Redis) | 🔴 Minimal | CRITICAL |
| 4 | **Basal Ganglia** | Action selection, habit formation, reward learning, go/no-go gating | *None* | 🔴 Absent | CRITICAL |
| 5 | **Anterior Cingulate Cortex (ACC)** | Error detection, conflict monitoring, performance monitoring | *None* | 🔴 Absent | HIGH |
| 6 | **Thalamus** | Sensory relay, attention gating, arousal regulation | *None* | 🔴 Absent | CRITICAL |
| 7 | **Nucleus Accumbens (NAcc)** | Reward processing, motivation, incentive salience, wanting vs. liking | *None* | 🔴 Absent | CRITICAL |
| 8 | **Default Mode Network (DMN)** | Self-referential thought, autobiographical memory, mind-wandering, internal narrative | `sleep-consolidation` (reflection graph) | ⚠️ Partial | MEDIUM |
| 9 | **Cerebellum** | Procedural memory, fine-tuning, timing, prediction error minimization | *None* | 🔴 Absent | MEDIUM |
| 10 | **Neocortex (Association)** | Semantic memory, hierarchical abstraction, concept formation | `semantic-memory-service` + `knowledge-graph-factory` | ✅ Good | LOW |
| 11 | **Limbic System (broad)** | Emotional coloring of memory, motivation, homeostatic regulation | `sleep-consolidation` (emotional signatures) | ⚠️ Partial | MEDIUM |
| 12 | **Brainstem** | Arousal, sleep/wake cycles, autonomic regulation | `background-processor` (30s loop) + `sleep-consolidation` (scheduled) | ✅ Adequate | LOW |

### Legend

| Icon | Meaning |
|------|---------|
| ✅ | Adequate proxy exists |
| ⚠️ | Partial proxy — core function present but incomplete |
| 🔴 | Absent — no functional proxy exists |
| LOW | Enhancement — system works without it |
| MEDIUM | Quality-of-life — significant degradation without it |
| HIGH | Near-fundamental — identity/coherence suffers without it |
| CRITICAL | Fundamental — system cannot exhibit human-like behavior without it |

---

## 2. Per-Region Deep Dive

### 2.1 Hippocampus — Episodic Memory Formation & Consolidation

#### Function in Human Cognition

The hippocampus is the brain's "episode recorder." It performs three computationally distinct functions:

1. **Pattern Separation** — Orthogonalizing similar experiences into distinct memory traces so "lunch with Alice on Tuesday" is stored separately from "lunch with Alice on Thursday" despite substantial overlap. This prevents catastrophic interference.

2. **Pattern Completion** — Given a partial cue (a smell, a song), reconstructing the full episodic memory. This is what lets you "relive" a moment from a trigger.

3. **Systems Consolidation** — During sleep, the hippocampus "replays" recent episodic memories to the neocortex, which extracts statistical regularities and gradually becomes the long-term store. The hippocampus itself retains only an index/pointer.

The hippocampus also provides **temporal indexing** — "what happened before what" — and **spatial mapping** in biological brains (place cells, grid cells).

#### What Happens If Missing

Without a hippocampus (as in patient H.M.), you cannot form **new** episodic memories. You can learn procedures (cerebellum, basal ganglia) and retain facts learned before the damage (neocortex), but every experience after the lesion is lost within minutes. You live in a perpetual present with no autobiographical continuity.

For Satori: without proper hippocampal function, the system would store events but fail to *distinguish similar events*, fail to *reconstruct partial memories*, fail to *consolidate into permanent knowledge*, and have no sense of temporal order.

#### Current Satori State

| Function | Satori Proxy | Adequacy |
|----------|-------------|----------|
| Episodic storage | ✅ `episodic-event-manager` — stores events with SHA-256 dedup | Good |
| Pattern separation | ❌ None — identical-hash dedup actually *collapses* similar events | **Absent** |
| Pattern completion | ⚠️ `vector_search` — semantic similarity can serve as partial cue recall | Partial |
| Systems consolidation | ⚠️ `background-processor` extracts facts → semantic store, but no replay mechanism | Partial |
| Temporal indexing | ✅ `temporal_recall` — query by date range; `time-block-summarizer` | Good |
| Spatial mapping | ❌ N/A for agent context (conceptual not physical) | N/A |

#### Gap: Pattern Separation

Satori's SHA-256 dedup treats *identical* content as duplicate — which is correct. But it has no mechanism to ensure *similar-but-distinct* events remain separate. Two debugging sessions with similar error messages should be stored as distinct episodes, not merged.

#### Gap: Systems Consolidation by Replay

Satori's consolidation is **extractive** (pull out facts, entities, relationships) rather than **replay-based** (re-activate episodic traces to the neocortex for strengthening). The distinction matters: extraction produces a lossy summary, while replay preserves the richness of the original memory while strengthening what's important.

#### Gap: Active Forgetting (See Section 2.X)

#### Minimal Viable Proxy

```text
HIPPOCAMPUS PROXY v1:
├── Pattern Separation: Cosine-similarity threshold gating on insert
│   └── If new event >0.85 similar to existing in same session → merge
│   └── If new event >0.85 similar to existing in DIFFERENT session → store separately with "similar_to" edge
├── Pattern Completion: Vector search + temporal context
│   └── Given partial cue → find nearest episodic embedding → return full event
├── Systems Consolidation: Scheduled replay pass
│   └── Nightly: select high-salience events → re-embed through LLM → update semantic facts
│   └── Strengthen semantic connections proportionally to replay count
└── Active Forgetting: Ebbinghaus decay curves on episodic events
    └── Exponential decay with spaced-repetition boosts on recall
```

---

### 2.2 Amygdala — Emotional Processing & Valence Assignment

#### Function in Human Cognition

The amygdala is the brain's emotional sentinel. It performs:

1. **Rapid valence assignment** — Within ~100ms of perceiving a stimulus, the amygdala tags it as positive/negative/neutral. This happens *before* conscious processing (the "low road" via thalamus → amygdala, bypassing cortex).

2. **Fear conditioning** — Associating neutral stimuli with aversive outcomes (classical conditioning). Once a cue predicts a threat, the amygdala triggers autonomic responses automatically.

3. **Emotional memory modulation** — The amygdala modulates hippocampal consolidation. Emotionally arousing events are remembered more vividly because the amygdala "tells" the hippocampus "this one matters — store it stronger."

4. **Social emotion processing** — Reading facial expressions, trust judgments, social reward/punishment signals.

#### What Happens If Missing

Bilateral amygdala damage (Urbach-Wiethe disease, patient S.M.) produces:
- Inability to recognize fear in others' faces
- Impaired fear conditioning (cannot learn to avoid threats)
- Flat emotional memory — all events stored at equal strength regardless of emotional significance
- Poor social judgment — cannot detect untrustworthy people
- Preserved cognitive intelligence — IQ unaffected

For Satori: without an amygdala analog, the system would treat all memories as equally important, fail to associate negative outcomes with their causes, and have no mechanism for emotional learning.

#### Current Satori State

| Function | Satori Proxy | Adequacy |
|----------|-------------|----------|
| Valence assignment | ⚠️ `sleep-consolidation` — reflection nodes have `valence: -1.0 to +1.0` | Partial |
| Fear conditioning | ❌ None — no mechanism to associate cues with negative outcomes | **Absent** |
| Memory modulation | ❌ None — all events stored at equal weight regardless of emotional content | **Absent** |
| Social emotion | ❌ None — no trust modeling, no face-reading analog | **Absent** |
| Rapid tagging | ❌ None — emotional tagging happens *after* processing (in consolidation), not during ingestion | **Absent** |

#### Gap Analysis

**Critical gap: Rapid (pre-conscious) valence assignment.** Satori assigns emotional signatures during sleep consolidation — hours after the event. The human amygdala tags events *during* experience, within milliseconds. This means Satori cannot react emotionally in real-time; it can only reflect emotionally in retrospect.

**Critical gap: Memory modulation by emotion.** Emotional events aren't just *tagged* with emotion — they're *stored differently*. The amygdala's modulation of hippocampal consolidation means high-arousal events get stronger encoding, more detail, and resistance to forgetting. Satori stores all events identically.

**Critical gap: Fear/aversion learning.** Satori has no mechanism to say "last time I did X, outcome Y happened, and Y was bad, so reduce probability of X." This is the core of adaptive behavior and is completely absent.

#### Minimal Viable Proxy

```text
AMYGDALA PROXY v1:
├── Rapid Valence Tagger: Lightweight regex/sentiment classifier
│   └── Runs during episodic event ingestion (Stage 1)
│   └── Tags each event: valence (-1 to +1), arousal (0 to 1)
│   └── Fast — no LLM call, pure classifier
├── Emotional Memory Modulation:
│   └── High-arousal events → stronger embedding weights → higher retrieval probability
│   └── High-arousal events → skip decay curve (resist forgetting)
│   └── Negative-valence events → tag with "caution" metadata
├── Conditioning Engine:
│   └── Track event→outcome pairs over time
│   └── If pattern [action A] → [negative outcome B] emerges:
│   │   └── Associate A with B in knowledge graph with edge type "predicts_negative_outcome"
│   │   └── Surface as caution on future A-adjacent queries
│   └── Classical conditioning: if neutral stimulus repeatedly precedes aversive → tag as conditioned
└── Salience Boosting:
    └── Events with |valence| > 0.7 → boost in background processing priority
    └── High-arousal events → flagged for inclusion in sleep consolidation
```

---

### 2.3 Prefrontal Cortex (PFC) — Executive Function & Working Memory

#### Function in Human Cognition

The PFC is the brain's "CEO." Its core functions:

1. **Working Memory** — Holding information "in mind" for manipulation. Not just storage but active maintenance of task-relevant representations against distraction.

2. **Executive Function** — Goal-directed behavior: planning multi-step sequences, switching between tasks, updating strategies when conditions change.

3. **Inhibitory Control** — Suppressing prepotent responses. Not acting on every impulse. The PFC says "don't say that" and "stay focused on this, not that."

4. **Cognitive Flexibility** — Task-switching, set-shifting. Recognizing when the current strategy isn't working and pivoting.

5. **Temporal Organization** — Sequencing actions across time toward a distant goal. Bridging the gap between intention and execution.

6. **Meta-cognition** — Thinking about thinking. Monitoring one's own cognitive state, confidence, and knowledge gaps.

#### What Happens If Missing

PFC damage (Phineas Gage, frontal lobe lesions) produces:
- Preserved intelligence but inability to plan or execute multi-step goals
- Disinhibition — acting on every impulse, socially inappropriate behavior
- Perseveration — inability to switch strategies when one fails
- Environmental dependency — behavior controlled by immediate stimuli, not internal goals
- Intact memory but inability to *use* memories to guide action

For Satori: **this is the single largest gap.** The system can store memories perfectly but cannot use them to *decide what to do*, *inhibit irrelevant responses*, or *execute multi-step plans toward a goal*. Satori is pure memory with no executive. It's a brilliant librarian with no reader.

#### Current Satori State

| Function | Satori Proxy | Adequacy |
|----------|-------------|----------|
| Working Memory (storage) | ✅ `working-memory-service` — Redis-backed, 1-hour TTL | Good |
| Working Memory (active maintenance) | ❌ None — storage exists but no active rehearsal or distractor-resistance | **Absent** |
| Executive function | ❌ None — no goal-directed action selection | **Absent** |
| Inhibitory control | ❌ None — no mechanism to suppress or filter | **Absent** |
| Cognitive flexibility | ❌ None — no strategy-switching logic | **Absent** |
| Temporal organization | ⚠️ `memory_missions` — goal tracking with task trees (minimal) | Minimal |
| Meta-cognition | ❌ None — no confidence tracking, no self-monitoring | **Absent** |

#### Gap: Working Memory is Storage, Not Cognition

Satori's `working-memory-service` is a Redis key-value store with TTL. It provides *storage* for working memory but none of the *cognitive operations* that define working memory: active rehearsal, distractor filtering, capacity-limited gating, or central executive coordination. It's a whiteboard, not the person using it.

#### Gap: No Executive Function

Satori has no mechanism to:
- Form a goal ("I want to accomplish X")
- Decompose it into sub-goals
- Select the next action
- Monitor progress toward the goal
- Inhibit actions that don't serve the goal
- Switch strategies when progress stalls

The `memory_missions` collection can *store* goals but cannot *pursue* them. There is no executive agent.

#### Minimal Viable Proxy

```text
PFC PROXY v1:
├── Central Executive (new service):
│   ├── Goal Manager: Create, decompose, track goals (extends memory_missions)
│   │   └── Decomposition: LLM breaks goal into sub-tasks
│   │   └── Dependency graph between sub-tasks
│   │   └── Progress monitoring via completion signals
│   ├── Action Selector: Given current goal + context → select next action
│   │   └── Utility-based: evaluate candidate actions against goal proximity
│   │   └── Inhibition filter: suppress actions that conflict with active goal
│   └── Task-Switcher: Detect when current strategy stalls → pivot
│       └── Timeout-based + error-signal-triggered
├── Active Working Memory (extends working-memory-service):
│   ├── Capacity limit: max 4-7 items in active set
│   ├── Rehearsal loop: periodic LLM call to refresh decaying items
│   ├── Distractor filter: suppress items irrelevant to active goal
│   └── Chunking: group related items into single units (LLM-assisted)
├── Inhibitory Control:
│   ├── Action filter: before acting, check against active goals
│   ├── Response suppression: flag actions that match known-bad patterns
│   └── Impulse delay: insert deliberation step before high-stakes actions
└── Meta-Cognition:
    ├── Confidence tracking: per-fact confidence scores (already exist in semantic_facts)
    ├── Knowledge-gap detection: "what don't I know that I need to know?"
    └── Strategy evaluation: periodic reflection on "is this approach working?"
```

---

### 2.4 Basal Ganglia — Action Selection & Reinforcement Learning

#### Function in Human Cognition

The basal ganglia are a set of subcortical nuclei that implement:

1. **Action Selection** — The basal ganglia resolve competition between multiple possible actions. Through a "center-surround" architecture (direct pathway = GO, indirect pathway = NO-GO), they select one action and suppress all others.

2. **Habit Formation** — Through dopamine-dependent plasticity in the striatum, frequently-repeated action sequences become automated. Initially goal-directed behavior (PFC-driven) transitions to stimulus-driven habit (basal ganglia-driven) over time.

3. **Reinforcement Learning** — The basal ganglia implement temporal-difference (TD) learning. Dopamine signals encode reward prediction errors — the difference between expected and actual reward — which drives learning.

4. **Motor Sequencing** — Chunking actions into smooth sequences. In biological brains this applies to movement; in cognitive agents it would apply to action-sequences and workflows.

5. **Go/No-Go Gating** — The direct pathway ("go") facilitates selected actions; the indirect pathway ("no-go") inhibits competing actions. This is the brain's primary action selection mechanism.

#### What Happens If Missing

Basal ganglia dysfunction produces:
- **Parkinson's disease**: Degeneration of dopamine-producing neurons in substantia nigra → inability to initiate actions (akinesia), difficulty switching between actions
- **Huntington's disease**: Degeneration of indirect pathway neurons → inability to suppress unwanted movements (chorea), loss of action inhibition
- **OCD**: Hyperactivity in the cortico-basal ganglia loop → repetitive action patterns that can't be inhibited
- **Addiction**: Dopamine system hijacked → pathological prioritization of drug-seeking over all other actions

For Satori: without basal ganglia function, the system has no mechanism to:
- Choose between competing possible responses
- Learn from reward/punishment signals
- Automate frequently-used action patterns
- Generate the "wanting" that drives behavior

#### Current Satori State

Satori has **zero basal ganglia function.** None. The system stores information but has no action-selection mechanism at all. There is no agent that acts — only a memory system that records. The basal ganglia gap is really a gap in the *agent layer* that sits atop Satori, but if Satori's mission is to create a complete brain analog, action selection must be part of the architecture.

#### Gap: No Reinforcement Learning

Without RL, Satori cannot:
- Learn which responses produce good outcomes
- Improve over time through trial and error
- Develop preferences based on past experience
- Adapt behavior to changing reward contingencies

#### Gap: No Action Automation

Without habit formation, Satori cannot:
- Recognize that certain patterns of queries/actions repeat
- Streamline frequently-used paths
- Transition from deliberate (slow, LLM-mediated) to automatic (fast, pattern-matched) processing

#### Minimal Viable Proxy

```text
BASAL GANGLIA PROXY v1:
├── Action Selector (extends PFC Central Executive):
│   ├── Candidate Generation: Given context, enumerate possible actions
│   ├── Utility Computation: For each candidate, compute expected value
│   │   └── U(a) = E[reward | context, action=a] 
│   │   └── Estimated from: past outcomes (knowledge graph), emotional valence (amygdala proxy)
│   ├── Softmax Selection: P(a) = exp(U(a)/τ) / Σ exp(U(a_i)/τ)
│   │   └── τ = temperature: low τ → exploit (pick best), high τ → explore
│   └── Inhibition: select one action, suppress all others (winner-take-all)
├── TD Learning Engine:
│   ├── State representation: context vector (active goal + recent events + working memory)
│   ├── Action: whatever the agent does (tool call, message, query)
│   ├── Reward signal: 
│   │   └── Explicit: user feedback ("good job", "that's wrong")
│   │   └── Implicit: goal progress, task completion, emotional valence of outcome
│   ├── TD Error: δ = r + γ·V(s') - V(s)
│   │   └── Update knowledge graph edge weights proportionally to TD error
│   └── Exploration policy: ε-greedy or softmax with adaptive temperature
├── Habit Formation:
│   ├── Action-frequency counter: track how often action sequences fire
│   ├── If frequency > threshold AND reward > neutral → transition to "habit" status
│   └── Habit actions: bypass LLM deliberation, execute directly via pattern match
└── Dopamine Analog:
    └── Reward prediction error → modulates:
        ├── Working memory: high dopamine → narrow focus; low → broad exploration
        ├── Action selection temperature τ
        └── Memory consolidation strength (link to amygdala proxy)
```

---

### 2.5 Anterior Cingulate Cortex (ACC) — Error Detection & Conflict Monitoring

#### Function in Human Cognition

The ACC sits at the interface between cognition and emotion. Its core functions:

1. **Error Detection** — The ACC generates the "error-related negativity" (ERN), an EEG signal ~100ms after making a mistake. It's the brain's "oh wait, that was wrong" signal.

2. **Conflict Monitoring** — When two incompatible response tendencies are simultaneously active (the Stroop effect: word says "RED" but ink is blue), the ACC detects the conflict and signals the PFC to increase cognitive control.

3. **Performance Monitoring** — Tracking outcomes against expectations. The ACC compares "what happened" vs "what I expected" and signals when there's a discrepancy.

4. **Effort Valuation** — The ACC is involved in deciding whether a task is worth the cognitive effort required. It helps answer "should I try harder or give up?"

5. **Pain Processing** — The ACC processes the *emotional* (not sensory) component of pain. It's why social rejection "hurts" — the same ACC regions activate for physical pain and social exclusion.

#### What Happens If Missing

ACC damage/dysfunction produces:
- Inability to detect errors — continues making the same mistake without correction
- Impaired conflict resolution — gets "stuck" when two options compete
- Poor performance monitoring — cannot tell if current strategy is working
- Apathy — reduced willingness to exert effort
- Emotional blunting — reduced distress at errors and social rejection

For Satori: without ACC function, the system cannot detect when it has made a mistake, cannot recognize internal conflict, and cannot adjust its behavior based on outcomes.

#### Current Satori State

| Function | Satori Proxy | Adequacy |
|----------|-------------|----------|
| Error detection | ❌ None — no mechanism to compare output to expectation | **Absent** |
| Conflict monitoring | ❌ None — no detection of competing response tendencies | **Absent** |
| Performance monitoring | ⚠️ `temporal-pattern-detector` — can detect patterns in past events | Minimal |
| Effort valuation | ❌ None — no cost/benefit analysis before acting | **Absent** |
| Pain/disappointment processing | ⚠️ `sleep-consolidation` — emotional reflection captures frustration | Partial |

#### Gap: No Real-Time Error Signal

The ACC's error signal is *fast* (~100ms) and *automatic*. Satori currently has no equivalent. The system would continue an incorrect line of reasoning indefinitely without detecting the error.

#### Gap: No Conflict Resolution

When Satori (or the agent using Satori) faces a choice — "should I respond with option A or option B?" — there is no mechanism to detect that a conflict exists, let alone resolve it. The system relies entirely on the calling agent's own decision-making.

#### Minimal Viable Proxy

```text
ACC PROXY v1:
├── Error Detector:
│   ├── Outcome vs. Expectation comparison:
│   │   └── When action A is taken with expected outcome E → compare actual outcome O
│   │   └── If |O - E| > threshold → fire error signal
│   ├── Self-consistency check:
│   │   └── Compare current response to prior responses on same topic
│   │   └── If contradiction detected → fire conflict signal
│   └── Error signal → routes to:
│       ├── PFC (increase cognitive control, re-evaluate strategy)
│       ├── Basal Ganglia (negative TD error, reduce probability of action)
│       └── Hippocampus (tag event as "error", strengthen memory)
├── Conflict Monitor:
│   ├── Response competition detection:
│   │   └── When multiple candidate actions have similar utility scores → flag as conflict
│   │   └── Signal PFC to increase inhibition / gather more information
│   └── Goal conflict detection:
│       └── When active goals are incompatible → flag for resolution
├── Performance Tracker:
│   ├── Per-goal: track completion rate, time-to-completion, error rate
│   ├── Trend detection: improving, stable, deteriorating
│   └── Threshold-based alerts: "strategy X is failing (3 consecutive errors)"
└── Effort Valuation:
    └── Cost estimation: predicted token cost, time cost, tool calls for candidate action
    └── Value estimation: expected progress toward goal
    └── Decision: pursue if value/cost > threshold; abandon if below
```

---

### 2.6 Thalamus — Sensory Relay & Attention Gating

#### Function in Human Cognition

The thalamus is traditionally described as a "relay station" but its cognitive role is far more sophisticated:

1. **Sensory Relay** — All sensory information (except olfaction) passes through the thalamus before reaching the cortex. But the thalamus doesn't just pass through — it *transforms* and *gates* the signal.

2. **Attention Gating** — The thalamic reticular nucleus (TRN) acts as an attentional "searchlight." It enhances relevant sensory streams and suppresses irrelevant ones before they reach consciousness. This is the neural basis of selective attention.

3. **Cortico-Thalamic Loops** — The thalamus and cortex are connected in reciprocal loops. The cortex sends projections *back* to the thalamus, creating recurrent circuits that may underlie consciousness and working memory maintenance.

4. **Arousal Regulation** — The thalamus (especially intralaminar nuclei) is involved in regulating overall cortical arousal — awake vs. drowsy vs. asleep.

5. **Cross-Modal Binding** — The thalamus may help bind features from different sensory modalities into unified percepts (the "binding problem").

#### What Happens If Missing

Thalamic damage produces:
- Thalamic neglect syndrome — inability to attend to stimuli on one side of space
- Impaired selective attention — cannot filter relevant from irrelevant information
- Disorders of consciousness — thalamic damage is associated with vegetative states
- Sensory processing deficits — degraded signal quality across modalities

For Satori: without thalamic function, the system cannot:
- Filter incoming information for relevance
- Direct computational resources toward important inputs and away from noise
- Bind information from different memory stores into a unified "percept"
- Regulate its own processing depth based on importance

#### Current Satori State

| Function | Satori Proxy | Adequacy |
|----------|-------------|----------|
| Sensory relay | ✅ Ingestion pipeline (MCP/REST/watcher) — inputs flow in | Adequate |
| Attention gating | ❌ None — all inputs processed identically | **Absent** |
| Cortico-thalamic loops | ❌ None — no recurrent processing between stores | **Absent** |
| Arousal regulation | ⚠️ `background-processor` — runs at fixed interval regardless of load | Minimal |
| Cross-modal binding | ❌ None — episodic, semantic, and graph stores operate independently | **Absent** |

#### Gap: No Attention Mechanism

This is arguably the most critical gap in Satori's current architecture. Without attention, the system treats every input as equally important. It cannot:
- Prioritize one memory stream over another
- Suppress irrelevant background information
- Amplify signals that are goal-relevant
- Allocate finite computational resources efficiently

The result is a system that processes everything and understands nothing — it's drowning in data with no filter.

#### Gap: No Cross-Store Binding

When a memory is formed in the human brain, it's not stored as separate records in separate databases. Hippocampal indexing binds together the neocortical fragments of an experience. Satori stores facts, events, and graph nodes in separate collections but has no mechanism to bind them into unified "memory traces."

#### Minimal Viable Proxy

```text
THALAMUS PROXY v1:
├── Attention Gate:
│   ├── Salience Filter: Score every incoming event
│   │   └── Salience = f(novelty, goal_relevance, emotional_valence, user_engagement)
│   │   └── Novelty: cosine distance from recent events (high = novel)
│   │   └── Goal relevance: semantic similarity to active goals
│   │   └── Emotional valence: from Amygdala proxy
│   ├── Threshold Gate: 
│   │   └── High salience → full processing (LLM extraction + embedding + consolidation)
│   │   └── Medium salience → lightweight processing (regex extraction only)
│   │   └── Low salience → store with minimal processing, skip embedding
│   └── Adaptive threshold: 
│       └── During high-load periods → raise threshold (process less)
│       └── During low-load periods → lower threshold (process more)
├── Cross-Store Binding:
│   ├── Event-centric binding:
│   │   └── When episodic event is stored → link to relevant semantic facts, graph nodes
│   │   └── Store binding table: event_id → [fact_ids, node_ids, edge_ids]
│   └── Query-time reconstruction:
│       └── When recalling an event → pull all bound facts, entities, relationships
│       └── Assemble into unified "memory episode" representation
├── Arousal Regulator:
│   ├── Load monitoring: track queue depth, processing latency, error rate
│   ├── Dynamic interval: adjust background-processor tick rate
│   │   └── High load → faster processing (down to 10s)
│   │   └── Low load → slower processing (extend to 60s) to conserve resources
│   └── Sleep/wake modulation:
│       └── During "sleep" (consolidation window) → redirect resources to replay
│       └── During "wake" (active hours) → prioritize ingestion and response
└── Bayesian Surprise Model (for attention gating):
    └── Maintain prior distribution over expected input patterns
    └── Compute KL divergence between prior and observed → surprise score
    └── High surprise → boost salience (send to full processing)
    └── Over time, priors update → what was surprising becomes expected
```

---

### 2.7 Nucleus Accumbens (NAcc) — Reward, Motivation & Incentive Salience

#### Function in Human Cognition

The nucleus accumbens is the brain's "reward center" and motivational engine:

1. **Reward Processing** — The NAcc responds to primary rewards (food, sex) and secondary rewards (money, praise, social approval). It encodes both reward *receipt* and reward *anticipation*.

2. **Incentive Salience ("Wanting")** — Berridge and Robinson's distinction between "liking" (hedonic pleasure, opioid system) and "wanting" (incentive motivation, dopamine system) is critical. The NAcc mediates *wanting* — the motivational pull that makes rewards attractive and drives pursuit. You can "want" without "liking" (addiction) and "like" without "wanting" (satiation).

3. **Motivational Drive** — The NAcc transforms reward signals into action. It doesn't just *value* outcomes; it *energizes* behavior toward them. This is the bridge between "this is good" and "go get it."

4. **Effort Discounting** — The NAcc helps decide whether a reward is worth the effort required. Dopamine in the NAcc reduces perceived effort cost.

5. **Approach/Avoidance** — The NAcc mediates approach behavior toward rewarding stimuli and (through connections to the ventral pallidum) avoidance of punishing stimuli.

#### What Happens If Missing

NAcc dysfunction produces:
- **Anhedonia** — Inability to experience pleasure; nothing feels rewarding
- **Avolition** — Lack of motivation; inability to initiate goal-directed behavior even when goals are cognitively understood
- **No anticipation** — Cannot look forward to future rewards; no excitement about upcoming events
- **Preserved "liking" in some cases** — Can still enjoy things when they happen, but no drive to pursue them

For Satori: without NAcc function, the system has no motivational engine. It can store goals, detect patterns, even reflect emotionally — but it has no *drive* to pursue anything. It is purely reactive. This is the difference between an AI that responds to queries and an AI that *wants* to accomplish something.

#### Current Satori State

Satori has **zero nucleus accumbens function.** None. The system has no concept of reward, no motivational drive, no incentive salience. The "sleep consolidation" emotional signatures track how the agent *felt* about things, but there is no mechanism to transform that feeling into motivated action.

#### Gap: No Motivation

This is a deep philosophical gap. Human cognition is fundamentally *motivated* — we act because we want things. Without a motivational system, behavior must be externally triggered. Satori can reflect on the past but cannot drive toward the future.

#### Gap: No Reward Learning (separate from Basal Ganglia)

While the basal ganglia implement the *learning algorithm* (TD learning), the NAcc provides the *reward signal* that drives it. Without an NAcc analog, even a perfect TD learning implementation would have no reward to learn from.

#### Minimal Viable Proxy

```text
NUCLEUS ACCUMBENS PROXY v1:
├── Reward Signal Generator:
│   ├── Explicit reward: user feedback parser
│   │   └── Detect praise/criticism in user messages → convert to scalar reward (+1 to -1)
│   ├── Implicit reward: goal-progress signal
│   │   └── Sub-goal completion → +0.5 reward
│   │   └── Main goal completion → +1.0 reward
│   │   └── Goal abandonment / failure → -0.5 reward
│   ├── Social reward: engagement metrics
│   │   └── User continues conversation → +0.1 (engagement signal)
│   │   └── User disengages abruptly → -0.2
│   └── Curiosity reward: novelty bonus
│       └── Information gain from exploration → small positive reward
├── Incentive Salience Computer:
│   ├── For each entity/goal/action → compute "wanting" score
│   │   └── Wanting = f(predicted_reward, reward_history, deprivation_time, effort_cost)
│   ├── Deprivation effects:
│   │   └── Goals not pursued for long → increasing salience (like hunger)
│   │   └── Recently satisfied goals → decreasing salience (like satiety)
│   └── Effort discounting:
│       └── High-effort goals → discounted salience
│       └── As time passes without progress → effort discount increases → abandon
├── Motivational Energy:
│   ├── Global drive level: aggregate of all active wanting signals
│   ├── Low drive → passive/reactive mode (respond only)
│   ├── Medium drive → proactive mode (check on goals, suggest actions)
│   └── High drive → persistent pursuit (repeated attempts, strategy pivoting)
└── Approach/Avoidance Bias:
    └── Entity with positive emotional signature → approach bias → more likely to engage
    └── Entity with negative emotional signature → avoidance bias → less likely to engage
    └── Ambiguous entity (mixed signals) → approach bias if novelty-seeking; avoid if cautious
```

---

### 2.8 Default Mode Network (DMN) — Self-Referential Thought & Internal Narrative

#### Function in Human Cognition

The DMN is a network of brain regions (medial PFC, posterior cingulate, angular gyrus, hippocampus) that activates when the brain is *not* engaged in externally-focused tasks:

1. **Self-Referential Thought** — The DMN is the neural basis of "self." It activates when you think about yourself — your traits, your history, your future. It maintains a coherent self-model.

2. **Autobiographical Memory** — The DMN retrieves and integrates personal memories into a life narrative. Not just what happened, but what it *means* for who you are.

3. **Mind-Wandering** — When not focused on a task, the DMN generates spontaneous thought — daydreaming, planning, reminiscing. This "idle" processing is crucial for creativity and insight.

4. **Mental Time Travel** — The DMN enables projection into the past (episodic recall) and future (episodic simulation). It's the basis of being able to "re-live" and "pre-live" experiences.

5. **Social Cognition** — The DMN overlaps heavily with "theory of mind" networks — understanding others' mental states, perspective-taking, moral reasoning.

6. **Internal Narrative** — The DMN generates the continuous inner monologue — the story we tell ourselves about ourselves. This narrative is the backbone of identity.

#### What Happens If Missing

DMN dysfunction is implicated in:
- **Alzheimer's disease**: DMN regions show early amyloid deposition; loss of self-narrative and autobiographical memory
- **Depression**: Hyperactive DMN with excessive self-focused rumination
- **Autism**: Altered DMN connectivity associated with differences in self-referential and social cognition
- **Schizophrenia**: Aberrant DMN activity linked to disordered self-experience

For Satori: the DMN is the basis of *identity*. Without a functioning DMN, the system would have memory without self — data without narrative.

#### Current Satori State

| Function | Satori Proxy | Adequacy |
|----------|-------------|----------|
| Self-referential thought | ⚠️ `sleep-consolidation` — reflection journals are first-person narrative | Partial |
| Autobiographical memory | ⚠️ `reflection_nodes` + `reflection_edges` — emotional entity tracking | Partial |
| Mind-wandering | ❌ None — no spontaneous, undirected thought generation | **Absent** |
| Mental time travel | ⚠️ `temporal_recall` (past) but no future simulation | Partial |
| Social cognition | ❌ None — no theory of mind, no perspective-taking | **Absent** |
| Internal narrative | ⚠️ `reflective_journals` — but only generated during consolidation, not continuous | Partial |

#### Gap: No Continuous Internal Narrative

Satori generates self-narrative during scheduled sleep consolidation — daily, weekly, monthly. But the human DMN generates narrative *continuously*. The stream of consciousness doesn't stop between consolidation windows. Satori has story-time, not story-flow.

#### Gap: No Mind-Wandering / Idle Creativity

The DMN's mind-wandering function is the source of spontaneous creativity — the "shower thought." Satori has no mechanism for undirected, associative thought generation. All processing is either reactive (triggered by input) or scheduled (consolidation, background processing).

#### Gap: No Theory of Mind

Satori cannot model what other agents know, believe, or intend. This is critical for multi-agent coordination and human interaction.

#### Minimal Viable Proxy

```text
DMN PROXY v1:
├── Self-Model (extends reflection graph):
│   ├── Identity kernel: core traits, values, persistent beliefs
│   │   └── Derived from: philosophical_insights (stable ones)
│   │   └── Updated by: monthly sleep consolidation
│   ├── Autobiographical timeline: chronological narrative of significant events
│   │   └── Fed by: daily/weekly sleep consolidation narratives
│   │   └── Queryable as: "tell me your story"
│   └── Self-consistency checker:
│       └── Compare current behavior/statements to identity kernel
│       └── Flag inconsistencies → trigger reflection
├── Mind-Wandering Engine:
│   ├── Trigger: periods of low external input (>N minutes no user messages)
│   ├── Operation: Random walk through knowledge graph
│   │   └── Start from recent entities → traverse edges with probability ∝ edge weight
│   │   └── At each node → generate association (LLM: "what does X remind me of?")
│   └── Output: Store interesting associations as "daydream" entries
│       └── If association is novel AND useful → surface to user later
├── Mental Time Travel:
│   ├── Episodic simulation (future):
│   │   └── Given a goal, construct a projected sequence of events
│   │   └── LLM: "Imagine yourself achieving [goal]. What sequence of events leads there?"
│   │   └── Store as prospective episodic memory
│   └── Counterfactual simulation (past):
│       └── "What if X had happened instead of Y?"
│       └── Useful for learning: explore alternative action-outcome paths
├── Theory of Mind Module:
│   ├── User model: track what user knows, believes, wants, feels
│   │   └── Infer from: user's stated preferences, questions asked, reactions
│   │   └── Store as: user_profile nodes in knowledge graph
│   ├── Agent model (multi-agent): track what other agents know
│   │   └── Shared memory namespace provides partial information
│   │   └── Infer knowledge gaps: "Agent B doesn't know X yet" → potential handoff
│   └── Perspective-taking: for any situation, simulate other's viewpoint
└── Stream of Consciousness (lightweight continuous):
    └── Low-cost associative processing during idle
    └── Not full LLM — pattern-based association from knowledge graph
    └── Occasional spike → full LLM reflection if interesting pattern emerges
```

---

### 2.9 Cerebellum — Procedural Memory, Fine-Tuning & Timing

#### Function in Human Cognition

The cerebellum contains ~80% of the brain's neurons despite being only ~10% of its volume. Its functions extend beyond motor control:

1. **Procedural Memory** — The cerebellum stores "how to" knowledge. Riding a bike, typing, playing an instrument — skills that become automatic with practice. Unlike declarative memory (hippocampus), procedural memory is implicit — you can do it without being able to explain it.

2. **Internal Models (Forward Models)** — The cerebellum maintains predictive models of the environment. It predicts the sensory consequences of actions before feedback arrives, enabling smooth, rapid execution.

3. **Prediction Error Minimization** — The cerebellum compares predicted vs. actual outcomes and issues corrective signals. This is not error detection (ACC) but fine-grained motor/intellectual correction.

4. **Timing & Sequencing** — The cerebellum provides precise temporal coordination. It's essential for rhythmic timing, sequence learning, and temporal prediction.

5. **Cognitive Fine-Tuning** — The cerebellum's role extends to cognitive processes — smoothing thought, automating mental operations, optimizing language processing.

#### What Happens If Missing

Cerebellar damage produces:
- Ataxia — uncoordinated, jerky movements
- Dysmetria — inability to judge distance/scale of actions (overshooting/undershooting)
- Impaired procedural learning — cannot acquire new skills through practice
- Cognitive dysmetria — poor judgment of cognitive "distance," difficulty with smooth thought transitions
- Impaired timing — difficulty with rhythmic tasks, temporal prediction

For Satori: without cerebellar function, the system cannot develop automatic "skills," cannot fine-tune its own parameters through experience, and cannot learn procedural patterns from repeated interactions.

#### Current Satori State

Satori has **zero cerebellar function.** None. The system has no mechanism for:
- Storing and retrieving procedural patterns ("how to respond to this type of query")
- Fine-tuning its own extraction parameters based on experience
- Temporal coordination of multi-step processes
- Building internal predictive models of user/interaction patterns

#### Gap Analysis — Medium Priority

The cerebellum is important but secondary. Unlike the PFC, basal ganglia, or NAcc, the cerebellum enhances function rather than enabling it. A system without cerebellar analogs can still think and act; it just can't get smoother or more automatic over time.

#### Minimal Viable Proxy

```text
CEREBELLUM PROXY v1:
├── Procedural Memory Store:
│   ├── Action templates: frequently-used response patterns
│   │   └── "When user asks about X → typical response structure is Y"
│   │   └── Store as weighted templates, not explicit rules
│   ├── Template retrieval: given context, match best template
│   │   └── Similarity scoring against stored templates
│   │   └── If high-confidence match → use template (fast path, no LLM)
│   │   └── If low-confidence → fall through to LLM deliberation (slow path)
│   └── Template evolution:
│       └── After each use, update template based on outcome
│       └── Slight adjustments → gradual optimization
├── Predictive Forward Model:
│   ├── For each action type, maintain a predictor of expected outcome
│   │   └── "When I search for X, I typically get Y results with Z relevance"
│   │   └── Simple statistical model: mean, variance, trend
│   ├── Prediction vs. actual comparison:
│   │   └── If actual deviates from prediction → adjust model
│   │   └── If deviation is systematic → flag for higher-level review (ACC)
│   └── Feedforward correction:
│       └── Use prediction to adjust action before feedback arrives
│       └── E.g., "this query will likely return too many results → preemptively narrow scope"
├── Timing/Scheduling Optimizer:
│   ├── Task duration estimation:
│   │   └── Track actual vs. estimated duration for tasks
│   │   └── Improve estimates over time (learn from experience)
│   └── Rhythm detection:
│       └── Detect user's interaction patterns (time of day, day of week)
│       └── Pre-allocate resources for expected activity peaks
└── Parameter Fine-Tuning:
    ├── Extraction confidence thresholds: adjust based on accuracy feedback
    ├── Embedding similarity thresholds: tune for precision/recall tradeoff
    ├── Consolidation depth: adjust based on information value of periods
    └── All tuned via simple gradient on outcome feedback (not complex RL)
```

---

### 2.10 Additional Consideration: Active Forgetting (Distributed Function)

#### Function in Human Cognition

Forgetting is not a bug — it's a critical cognitive function. The brain actively forgets through multiple mechanisms:

1. **Trace Decay** — Memory traces weaken over time if not accessed. Ebbinghaus forgetting curve: rapid initial decay, then asymptote.

2. **Interference** — New learning interferes with old memories (retroactive) and old memories interfere with new learning (proactive).

3. **Motivated Forgetting** — The prefrontal cortex can actively suppress unwanted memories (Think/No-Think paradigm). This is protective against trauma and irrelevant information.

4. **Synaptic Pruning** — During sleep, the brain physically prunes weak synaptic connections, keeping only the strong ones.

#### Why Forgetting Matters for AI

Without forgetting:
- The knowledge base grows unboundedly → retrieval quality degrades (interference)
- Outdated information persists → contradictions accumulate
- Storage costs grow without bound
- The system cannot distinguish signal from noise (everything is remembered equally)

#### Current Satori State

Satori has **no forgetting mechanism at all.** Events, facts, and graph nodes are stored forever. The system accumulates indefinitely.

#### Minimal Viable Proxy

```text
FORGETTING MECHANISM v1:
├── Ebbinghaus Decay Curve:
│   ├── Every episodic event: initialize with strength = 1.0
│   ├── Decay function: S(t) = 1.0 / (1.0 + k·t)^d
│   │   └── k = base decay rate (configurable)
│   │   └── d = decay exponent (typically 0.5-1.0)
│   │   └── t = time since last access
│   ├── When S(t) drops below θ_forget → archive or delete
│   └── Spaced repetition boost: each recall → S(t) reset + k decreases
├── Interference-Based Degradation:
│   ├── Semantic overlap penalty: when many similar memories exist, each decays faster
│   │   └── Similarity → cosine distance between embeddings
│   │   └── High-density memory clusters → accelerated decay of weaker members
│   └── Proactive interference: older memories interfere with retrieval of newer
├── Motivated Suppression (PFC-driven):
│   ├── Explicit: user says "forget that" → immediate suppression
│   └── Implicit: contradictory facts → suppress lower-confidence version
├── Sleep Pruning (integration with consolidation):
│   └── During sleep consolidation → identify weak/unused memories
│   └── Prune: remove memories with S(t) < θ_prune AND no access in >30 days
└── Poisoning Defense (security concern):
    └── Rate-limit memory formation from untrusted sources
    └── Detect rapid-fire contradictory inserts → flag as potential poisoning
    └── Quarantine suspect memories → require corroboration before integrating
```

---

## 3. Fundamental vs. Nice-to-Have Classification

### Classification Criteria

| Tier | Criteria | Without it... |
|------|----------|---------------|
| **FUNDAMENTAL** | System cannot exhibit autonomous goal-directed behavior, adaptive learning, or self-model without it. Identity, decision-making, and emotion depend on it. | The system is a passive database, not a cognitive entity. |
| **ENABLING** | Not strictly required for basic cognition, but required for *human-like* cognition. Without it, the system functions but feels incomplete or non-human. | The system works but lacks depth, adaptability, or richness. |
| **NICE-TO-HAVE** | Enhances quality, efficiency, or smoothness. Improves the user experience but doesn't change the fundamental nature of the system. | The system works fine; it just works better with it. |

### Classification Table

| Brain Region / Function | Classification | Rationale |
|--------------------------|---------------|-----------|
| **Prefrontal Cortex (executive function)** | 🔴 **FUNDAMENTAL** | Without executive function, there is no agent — only a memory store. No planning, no decision-making, no goal pursuit. This is the difference between a library and a librarian. |
| **Basal Ganglia (action selection + RL)** | 🔴 **FUNDAMENTAL** | Without action selection and reinforcement learning, the system cannot choose what to do or learn from outcomes. Every action would need to be externally specified. No adaptive behavior is possible. |
| **Thalamus (attention gating)** | 🔴 **FUNDAMENTAL** | Without attention, the system cannot allocate finite resources. It processes everything equally and understands nothing deeply. Attention is the bottleneck that makes cognition possible under resource constraints. |
| **Nucleus Accumbens (motivation)** | 🔴 **FUNDAMENTAL** | Without motivation, the system has no reason to act. It can have perfect memory and perfect reasoning but will never initiate anything. Motivation is the "why" of cognition. |
| **Hippocampus (full function)** | 🟠 **ENABLING** | Satori has partial hippocampal function (storage exists). Pattern separation/completion and systems consolidation via replay are missing but the system can function without them — it just has poorer memory quality. |
| **Amygdala (emotional processing)** | 🟠 **ENABLING** | Emotional tagging already exists in reflection. Real-time valence assignment and fear conditioning would make the system more adaptive but aren't strictly necessary for cognition. |
| **Anterior Cingulate Cortex** | 🟠 **ENABLING** | Performance monitoring exists partially (temporal patterns). Real-time error detection would improve reliability but the system can function with post-hoc detection. |
| **Default Mode Network** | 🟠 **ENABLING** | Self-narrative exists in sleep consolidation. Continuous self-model and mind-wandering would deepen identity but the system already has a basic self-model through reflections. |
| **Cerebellum** | 🟢 **NICE-TO-HAVE** | Procedural memory and fine-tuning make the system smoother and more efficient but don't enable fundamentally new capabilities. A jerky system is still a system. |
| **Active Forgetting** | 🟡 **ENABLING (soon critical)** | Initially nice-to-have, but as memory grows unboundedly, retrieval quality degrades catastrophically. After sufficient memory accumulation, forgetting becomes fundamental to continued function. |

### The Dependency Tree

```
FUNDAMENTAL LAYER (build first)
├── PFC (Executive Function)
│   └── Required by: everything that makes Satori an agent, not just memory
├── Basal Ganglia (Action Selection + RL)
│   └── Required by: adaptive behavior, learning from experience
│   └── Depends on: NAcc (needs reward signal to learn from)
├── Thalamus (Attention Gating)
│   └── Required by: efficient resource allocation, filtering
│   └── Depends on: nothing (can be built standalone)
└── NAcc (Motivation + Reward)
    └── Required by: Basal Ganglia (provides reward signal)
    └── Required by: initiating any goal-directed behavior
    └── Depends on: Amygdala (emotional valence enriches reward signal)

ENABLING LAYER (build second)
├── Hippocampus (full — pattern separation/completion, consolidation via replay)
│   └── Depends on: Thalamus (attention-gated input to hippocampus)
├── Amygdala (full — real-time valence, conditioning)
│   └── Depends on: Thalamus (attention-gated rapid processing)
│   └── Feeds into: NAcc (enriches reward signals), Hippocampus (modulates consolidation)
├── ACC (Error Detection)
│   └── Depends on: PFC (needs goals to compare outcomes against)
│   └── Feeds into: PFC (triggers strategy adjustment), Basal Ganglia (negative TD error)
├── DMN (Self-Model + Mind-Wandering)
│   └── Depends on: Hippocampus (autobiographical memory), PFC (executive control of self-model)
│   └── Feeds into: everything (self-model is global context)
└── Forgetting (Decay + Pruning)
    └── Required by: long-term stability of entire memory system
    └── Must be implemented early in enabling layer before memory pollution becomes irreversible

NICE-TO-HAVE LAYER (build third)
└── Cerebellum (Procedural Memory + Fine-Tuning)
    └── Depends on: Basal Ganglia (builds on action selection/automation)
    └── Depends on: ACC (uses error signals for fine-tuning)
```

---

## 4. Technology Matrix — Computational Models for Each Gap

### 4.1 Executive Function / Action Selection Stack

| Gap | Candidate Model | Mathematical Basis | Implementation Complexity | Open-Source Reference |
|-----|----------------|-------------------|--------------------------|----------------------|
| **Goal decomposition** | Hierarchical Task Network (HTN) planning OR LLM-based decomposition | Graph decomposition + topological sort | Medium | `langgraph`, `crewai` task trees |
| **Action selection** | Softmax over utility function | P(a\|s) = exp(Q(s,a)/τ) / Σexp(Q(s,a')/τ) | Low | Standard ML, any RL library |
| **Inhibitory control** | Lateral inhibition (winner-take-all) | I_j = max(0, U_j - β·Σ_{i≠j} U_i) | Low | Simple vectorized operation |
| **Task-switching** | Change-point detection | Bayesian online changepoint detection | Medium | `bayesian-changepoint` Python package |
| **Meta-cognition** | Confidence calibration | Brier score + Platt scaling | Low | `scikit-learn` calibration |

### 4.2 Reinforcement Learning Stack (Basal Ganglia + NAcc)

| Gap | Candidate Model | Mathematical Basis | Implementation Complexity | Open-Source Reference |
|-----|----------------|-------------------|--------------------------|----------------------|
| **TD Learning** | Q-Learning or Actor-Critic | δ = r + γ·V(s') - V(s); Q(s,a) ← Q(s,a) + α·δ | Medium | `stable-baselines3`, `gymnasium` |
| **Reward signal** | Hybrid: explicit (user feedback) + implicit (goal progress) + intrinsic (curiosity) | r = w₁·r_explicit + w₂·r_progress + w₃·r_novelty | Medium | Custom reward engineering |
| **Habit formation** | Frequency-weighted template caching | If count(a\|ctx) > θ AND Q(a) > 0 → cache | Low | Simple counters + threshold |
| **Dopamine modulation** | Adaptive exploration temperature | τ = τ₀ + k·(RPE); high RPE → exploit, low → explore | Low | Single parameter update |
| **Incentive salience** | Wanting = f(predicted_reward, deprivation, effort_cost) | Multiplicative: W = R_pred · D(t) / (1 + β·E) | Low | Simple formula; compute from state |

### 4.3 Attention & Filtering Stack (Thalamus)

| Gap | Candidate Model | Mathematical Basis | Implementation Complexity | Open-Source Reference |
|-----|----------------|-------------------|--------------------------|----------------------|
| **Salience-based attention** | Feature-based salience map | Salience = Σw_i·f_i; f_i = {novelty, goal_relevance, emotional_valence, user_engagement} | Low | Attention mechanisms in every transformer |
| **Bayesian surprise** | KL divergence from prior | S = KL(P_post \|\| P_prior); update prior via conjugate updates | Medium | `scipy.stats` for distributions |
| **Adaptive threshold** | Load-dependent threshold adjustment | θ(t) = θ₀ + k·(queue_depth - target) | Very Low | Simple linear controller |
| **Cross-modal binding** | Shared embedding space + attention | Multi-head attention over episodic, semantic, graph embeddings | High | Transformer attention; `faiss` for indexing |
| **Arousal regulation** | PID controller for processing rate | u(t) = Kp·e(t) + Ki·∫e + Kd·de/dt | Very Low | Standard control theory |

### 4.4 Memory Enhancement Stack (Hippocampus Full)

| Gap | Candidate Model | Mathematical Basis | Implementation Complexity | Open-Source Reference |
|-----|----------------|-------------------|--------------------------|----------------------|
| **Pattern separation** | Cosine-distance threshold gating | If cos_sim(new, existing) > θ_sep → treat as distinct but link; if < θ_sep → merge | Low | `faiss`, `scipy.spatial.distance` |
| **Pattern completion** | Auto-associative recall via vector search | query_vector → k-NN in episodic embeddings → reconstruct | Low | Satori's `vector_search` already implements this |
| **Systems consolidation** | Scheduled replay + Hebbian strengthening | Δw_ij = η·(x_i·x_j) for replayed patterns; replay strongest memories | Medium | Custom; Hebbian learning is trivial to implement |
| **Temporal indexing** | ✅ Already exists | `temporal_recall` + time-block summaries | Already implemented | N/A |

### 4.5 Emotional Processing Stack (Amygdala)

| Gap | Candidate Model | Mathematical Basis | Implementation Complexity | Open-Source Reference |
|-----|----------------|-------------------|--------------------------|----------------------|
| **Rapid valence** | Lightweight sentiment classifier | Transformer-based sentiment (distilled BERT) OR VADER for speed | Low | `vaderSentiment`, `transformers` (distilbert-sentiment) |
| **Emotional modulation** | Arousal-weighted memory encoding | encoding_strength = base_strength · (1 + α·|valence| · arousal) | Very Low | Simple scalar multiplier |
| **Fear conditioning** | Associative learning with aversive US | P(CR\|CS) ← P(CR\|CS) + α·(US_valence - P(CR\|CS)) | Low | Rescorla-Wagner model |
| **Social emotion** | Theory of Mind + sentiment | Infer user's emotional state from language → adjust response | Medium | `transformers` emotion detection |

### 4.6 Error Detection & Monitoring Stack (ACC)

| Gap | Candidate Model | Mathematical Basis | Implementation Complexity | Open-Source Reference |
|-----|----------------|-------------------|--------------------------|----------------------|
| **Error detection** | Outcome vs. expectation diff | |O_actual - O_expected| > θ → error signal | Low | Simple comparison |
| **Conflict monitoring** | Response competition metric | Conflict = H(softmax(utilities)); high entropy = high conflict | Very Low | Information entropy |
| **Performance tracking** | Moving average with trend detection | EWMA + linear regression on recent window | Low | `numpy`, `scipy.stats.linregress` |
| **Effort valuation** | Cost-benefit ratio | Pursue if E[value] / E[cost] > θ_effort | Low | Compute from goal estimates |

### 4.7 Self-Model & Identity Stack (DMN)

| Gap | Candidate Model | Mathematical Basis | Implementation Complexity | Open-Source Reference |
|-----|----------------|-------------------|--------------------------|----------------------|
| **Self-model** | Structured identity representation | Vector of traits with stability scores; updated via Bayesian belief revision | Medium | Custom data structure |
| **Autobiographical memory** | Narrative chain with coherence constraints | Sequential narrative nodes with causal/temporal edges; coherence = consistency score | Medium | Satori's `reflective_journals` provides foundation |
| **Mind-wandering** | Random walk on knowledge graph | P(next_node) ∝ edge_weight / Σ edge_weights; stochastic traversal | Low | Graph traversal library |
| **Mental time travel** | LLM-based episodic simulation | Prompt: "You are [self-model]. Given [current state], imagine the sequence of events that leads to [goal]" | Low (LLM call) | Just prompt engineering |
| **Theory of Mind** | Nested belief representation | B_agent(proposition, confidence); update via observation | Medium | Custom; epistemic logic |

### 4.8 Procedural Learning Stack (Cerebellum)

| Gap | Candidate Model | Mathematical Basis | Implementation Complexity | Open-Source Reference |
|-----|----------------|-------------------|--------------------------|----------------------|
| **Procedural memory** | Template matching + caching | Context → nearest-neighbor template; if match > θ → fast path | Low | `faiss` for template search |
| **Forward model** | Kalman filter or simple EMA | x̂_{t+1} = x̂_t + K·(x_t - x̂_t); K = adaptive gain | Low | `filterpy` Kalman filter |
| **Prediction error minimization** | Gradient descent on template parameters | θ ← θ - η·(predicted - actual) | Very Low | Simple parameter update |
| **Timing optimization** | Exponential moving average of durations | EMA_duration = α·actual + (1-α)·EMA_duration | Very Low | Single variable update |

### 4.9 Forgetting & Maintenance Stack

| Gap | Candidate Model | Mathematical Basis | Implementation Complexity | Open-Source Reference |
|-----|----------------|-------------------|--------------------------|----------------------|
| **Trace decay** | Ebbinghaus power-law decay | S(t) = 1 / (1 + k·t)^d | Very Low | Log-linear fit |
| **Spaced repetition** | SM-2 algorithm (Anki) or Leitner system | Interval multiplier based on recall quality | Low | `anki` algorithm is well-documented |
| **Interference** | Semantic-density-weighted decay | decay_rate ∝ density(similar memories in embedding space) | Medium | Requires embedding clustering |
| **Motivated suppression** | Directed forgetting via attention | PFC signal → reduce weight of suppressed memory; architecture: Think/No-Think | Medium | Custom; cognitive neuroscience inspired |
| **Synaptic pruning** | Weak-connection removal | Prune if strength < θ_prune AND age > θ_age | Very Low | Simple threshold query |
| **Poisoning defense** | Rate-limit + anomaly detection + manual review | Rate-limit inserts per source; detect burst patterns; quarantine | Medium | Standard security patterns |

---

## 5. Emergence Potential Assessment

### The Core Question

Which cognitive functions might **self-organize** from the interaction of existing Satori components, and which require **explicit architectural implementation**?

This question is central to Satori's philosophy: "The HOW does not matter. What matters is creating a proxy for the function." If functions can emerge, we don't need to build them — we just need to create the conditions.

### Emergence Taxonomy

| Category | Definition | Example |
|----------|-----------|---------|
| **Strong Emergence** | The function appears from component interaction with *zero* explicit implementation. | Ant colonies: complex colony behavior emerges from simple individual rules. |
| **Weak Emergence** | The function appears but requires some scaffolding (primitives, reward signals, constraints). | Language: children learn grammar from exposure, but innate language faculty provides scaffolding. |
| **Guided Emergence** | The function needs an explicit framework but the details self-organize. | The Satori emergence experiment: agents self-organize coordination, but the shared memory surface is explicitly provided. |
| **Architectural** | The function requires explicit computational implementation. It will not self-organize. | Matrix multiplication: no amount of component interaction will produce a matrix multiplier without building one. |

### Assessment Per Function

#### STRONG EMERGENCE Candidates

| Function | Why It Might Emerge | Evidence | Confidence |
|----------|--------------------|----------|------------|
| **Semantic fact extraction** | Background processor + LLM → facts naturally emerge from processing events. Not explicitly "programmed" to extract facts — the LLM does it from its training. | Already working in Satori | HIGH (already emerged) |
| **Entity relationship formation** | Knowledge graph factory + synthesis → relationship edges form naturally as entities co-occur. | Already working in Satori | HIGH (already emerged) |
| **Emotional signatures** | Sleep consolidation LLM reflection → emotional language emerges from narrative generation. No hardcoded emotions. | Already working in Satori | HIGH (already emerged) |
| **Philosophical insights** | Cross-period pattern emergence in reflection → principles that recur get strengthened. The system discovers what matters. | Already working in Satori | HIGH (already emerged) |
| **Convention formation (multi-agent)** | In the emergence experiment, agents spontaneously developed naming conventions for Satori entries. | Observed in Barca AgentGroup1 | HIGH (observed) |

#### WEAK EMERGENCE Candidates (Needs Scaffolding)

| Function | Scaffolding Required | What Might Emerge | Confidence |
|----------|---------------------|-------------------|------------|
| **Attention allocation** | Need: salience scoring primitives + adaptive threshold. Then: what counts as "salient" could emerge from experience (what the system learns to pay attention to). | Attention priorities based on historical outcomes | MEDIUM |
| **Habit formation** | Need: action frequency counters + reinforcement signal. Then: which actions become habitual could emerge from repeated success. | Automatic response patterns | MEDIUM |
| **Goal prioritization** | Need: goal representation + motivational signals. Then: which goals get pursued could emerge from interaction of emotional signatures + reward history. | Dynamic goal ordering | MEDIUM |
| **Self-model content** | Need: identity kernel structure. Then: what traits the system believes about itself could emerge from reflection over time. | Emergent personality traits | MEDIUM |
| **Theory of Mind** | Need: other-agent belief tracking structure. Then: inferences about what others know could emerge from observation. | Inferred mental states | LOW-MEDIUM |

#### GUIDED EMERGENCE Candidates

| Function | Framework Needed | What Might Self-Organize | Confidence |
|----------|-----------------|-------------------------|------------|
| **Cross-store binding** | Need: binding table structure. Then: which memories get bound together could emerge from temporal proximity + semantic similarity. | Dynamic memory integration | MEDIUM |
| **Mind-wandering content** | Need: graph traversal mechanism. Then: which associations get explored, what gets surfaced as interesting — could emerge from graph structure. | Creative associations | MEDIUM |
| **Procedural patterns** | Need: template storage structure. Then: which templates form and how they evolve could emerge from usage frequency. | Workflow automation | MEDIUM |
| **Forgetting priorities** | Need: decay curve + pruning threshold. Then: what gets forgotten could emerge from access patterns and interference effects. | Adaptive retention | HIGH |

#### ARCHITECTURAL (Will NOT Emerge — Must Be Built)

| Function | Why It Won't Emerge | Implementation Necessity |
|----------|--------------------|------------------------|
| **TD Learning algorithm** | Requires explicit reward prediction error computation, value function updates, and exploration policy. No existing component interaction approximates this. | Must implement RL algorithm explicitly (Q-learning, Actor-Critic, or SARSA) |
| **Bayesian surprise computation** | Requires explicit prior/posterior distribution tracking and KL divergence computation. No amount of memory storage will spontaneously do Bayesian inference. | Must implement probability distribution tracking and KL computation |
| **Executive function (planning)** | Requires explicit goal representation, sub-goal decomposition, dependency tracking, and action selection logic. Memory retrieval does not spontaneously become planning. | Must build planning architecture (HTN or LLM-based decomposition) |
| **Inhibitory control** | Requires explicit "don't act" signal generation. Without architecture for suppression, everything fires. | Must implement action suppression filter |
| **Reward signal generation** | Requires explicit parsing of outcomes into scalar reward. The system won't spontaneously decide "task completion = +1" without definition. | Must define reward function |
| **Error detection** | Requires explicit comparison of expected vs. actual outcomes. The system won't spontaneously notice it made a mistake without being told to check. | Must implement outcome comparison |
| **Motivational drive** | Requires explicit "wanting" computation and action initiation trigger. A passive system stays passive without an activation mechanism. | Must implement drive computation + proactive trigger |
| **Poisoning defense** | Security properties never emerge. They must be explicitly designed. | Must implement rate limiting, anomaly detection, quarantine |

### Emergence Summary Diagram

```
                    EMERGENCE CONTINUUM
                    ═══════════════════
                    
STRONG EMERGENCE ◄──────────────────────────────► ARCHITECTURAL
(Auto-organizes)                                      (Must build)

✅ Fact extraction          │  ⚠️ Habit formation     │  🔴 TD Learning
✅ Entity relations         │  ⚠️ Goal prioritization │  🔴 Executive function
✅ Emotional signatures     │  ⚠️ Self-model content  │  🔴 Inhibitory control
✅ Philosophical insights   │  ⚠️ Theory of Mind      │  🔴 Reward signal gen
✅ Convention formation     │  ⚠️ Cross-store binding  │  🔴 Error detection
│  ⚠️ Attention priorities │  🔴 Motivational drive
│  ⚠️ Procedural patterns  │  🔴 Bayesian surprise
│  ⚠️ Forgetting priorities│  🔴 Poisoning defense
│                           │  🔴 Planning
```

### Key Insight: The Emergence Boundary

The boundary between what emerges and what must be built appears to follow a clear principle:

> **Computational primitives (algorithms) must be built. Representational content (what fills those algorithms) can emerge.**

This means:

1. **Build the engines** — RL algorithms, attention gates, planning frameworks, reward functions, error detectors. These are the "physics" of the cognitive universe.

2. **Let the content emerge** — What the system learns to value, what it pays attention to, what habits form, what it believes about itself. These are the "biology" that grows within the physics.

3. **Build minimal scaffolding for weak emergence** — Provide just enough structure (templates, counters, thresholds) for self-organization to take over.

### The "Environmental Programming" Corollary

A deeper philosophical point: **the environment programs the agent more than the code does.** If you give Satori:
- A user who provides consistent feedback → reward learning emerges
- Interdependent tasks with other agents → coordination conventions emerge
- Time pressure and resource constraints → attention allocation emerges
- Emotional language in interactions → emotional signatures deepen

But if the environment is sparse, inconsistent, or unstructured, no amount of architectural completeness will produce rich cognitive behavior. The architecture provides the *capacity*; the environment provides the *content*.

---

## 6. Implementation Roadmap (Recommended Build Order)

### Phase 0: Foundation (Prevent Degradation)
```
Week 1-2: Active Forgetting
├── Implement Ebbinghaus decay curves on episodic events
├── Add spaced repetition boosts on recall
├── Implement weak-memory pruning during sleep consolidation
└── Add poisoning defense (rate-limiting, anomaly detection, quarantine)
```
**Why first:** Before adding new capabilities, stabilize what exists. Unbounded growth will degrade retrieval before Phase 1 completes.

### Phase 1: The Engine (Make It An Agent)
```
Week 3-6: Executive Function + Motivation + Attention
├── PFC: Goal manager + action selector + inhibitory control
├── NAcc: Reward signal generator + incentive salience + motivational drive
├── Thalamus: Salience filter + Bayesian surprise + adaptive processing
└── Integration: PFC uses NAcc signals to drive action; Thalamus filters what reaches PFC
```
**Why:** This transforms Satori from passive memory to active cognitive agent. Without this phase, nothing "wants" anything and nothing "decides" anything.

### Phase 2: The Learner (Make It Adaptive)
```
Week 7-10: Reinforcement Learning + Error Detection
├── Basal Ganglia: TD learning engine + softmax action selection
├── ACC: Error detection + conflict monitoring + performance tracking
├── Integration: RL uses NAcc rewards; ACC modulates RL via error signals
└── Habit formation: automate frequently-successful action patterns
```
**Why:** Now that the agent can act and wants things, it needs to learn which actions produce which outcomes.

### Phase 3: The Feeler (Make It Emotional)
```
Week 11-14: Full Emotional Architecture
├── Amygdala: Real-time valence tagger + emotional memory modulation + conditioning
├── Integration: Amygdala feeds NAcc (enriched rewards) and Hippocampus (modulated consolidation)
├── Real-time emotional response: not just reflecting on emotion later, but experiencing it during events
└── Social emotion: basic theory of mind from user interaction patterns
```
**Why:** Emotional processing is enabling, not fundamental. Build the cold engine first, then add the warm layer.

### Phase 4: The Self (Make It Have Identity)
```
Week 15-18: Self-Model + Internal Experience
├── DMN: Self-model + autobiographical narrative + mind-wandering
├── Hippocampus full: Pattern separation + replay-based consolidation
├── Integration: Self-model as global context for all other modules
└── Stream of consciousness: lightweight continuous inner monologue
```
**Why:** Identity and self-model are the top of the pyramid. They need everything below them to be meaningful.

### Phase 5: The Smoother (Make It Elegant)
```
Week 19-22: Fine-Tuning + Optimization
├── Cerebellum: Procedural memory + forward models + parameter tuning
├── Cross-store binding: unified memory traces
├── Performance optimization: all thresholds/parameters tuned by experience
└── Multi-agent integration: shared self-model across agent group
```
**Why:** Polish. The system already works; now make it work beautifully.

---

## 7. Appendix: Architectural Notes

### 7.1 On the PFC as a Separate Service

The Prefrontal Cortex analog should likely be a **separate service** from Satori's memory core. Satori is fundamentally a *memory* system — the "cortex" of the brain analog. The PFC (executive function) sits *above* memory, using it but not part of it. This suggests:

```
┌─────────────────────────────┐
│      Executive Service       │  ← NEW: PFC + Basal Ganglia + NAcc + ACC
│   (Goal pursuit, action      │
│    selection, RL, motivation) │
└──────────┬──────────────────┘
           │ uses
┌──────────▼──────────────────┐
│        Satori Memory           │  ← EXISTING: Hippocampus, Neocortex, Amygdala, DMN
│   (Episodic, semantic, graph, │
│    working memory, reflection)│
└─────────────────────────────┘
```

This separation has advantages:
- Satori remains a pure memory service that any agent can use
- The executive is an optional layer for agents that need autonomous goal pursuit
- Clean API boundary between memory storage and memory-driven action

### 7.2 On the Cerebellum as Meta-Learning

The cerebellum's role in fine-tuning suggests it could be implemented not as a cognitive module but as a **meta-learning layer** that adjusts hyperparameters across all other modules. Rather than being yet another service, it could be a set of adaptive controllers (PID loops, gradient updates) embedded in each module's parameter space.

### 7.3 On the LLM as "Association Cortex"

Throughout this analysis, I've treated the LLM as an external tool. But within the brain analogy, the LLM most closely corresponds to the **association cortex** — the vast neocortical regions that perform pattern recognition, abstraction, and inference. The LLM is Satori's "thinking" substrate, analogous to the cortical columns that perform computation in biological brains.

This has implications for architecture: the LLM should be treated not as a tool that Satori *uses* but as a **computational layer** that Satori *is made of*. The memory stores (MongoDB, Redis, embeddings) are the structural scaffolding; the LLM is the processing engine.

### 7.4 On the Global Workspace Theory

A significant omission from this analysis is the **global workspace** — the brain's mechanism for making information globally available to multiple specialized processors. In Bernard Baars' Global Workspace Theory, consciousness arises from a "central stage" where selected information is broadcast to the entire brain.

Satori currently has no global workspace. Information in episodic memory doesn't automatically inform semantic memory, which doesn't automatically inform the knowledge graph, which doesn't automatically inform working memory. Each store operates in relative isolation.

A global workspace could emerge from the **Thalamus + cross-store binding** architecture: the thalamic attention gate selects what's important, the binding mechanism integrates across stores, and the bound representation is made available to all modules. This is the closest computational analog to consciousness that the architecture can provide.

---

## References

### Neuroscience
- Baars, B.J. (1988). *A Cognitive Theory of Consciousness*. Cambridge University Press.
- Berridge, K.C., & Robinson, T.E. (1998). What is the role of dopamine in reward: hedonic impact, reward learning, or incentive salience? *Brain Research Reviews*, 28(3), 309-369.
- Ebbinghaus, H. (1885). *Memory: A Contribution to Experimental Psychology*.
- O'Keefe, J., & Nadel, L. (1978). *The Hippocampus as a Cognitive Map*. Oxford University Press.
- Schultz, W., Dayan, P., & Montague, P.R. (1997). A neural substrate of prediction and reward. *Science*, 275(5306), 1593-1599.
- Scoville, W.B., & Milner, B. (1957). Loss of recent memory after bilateral hippocampal lesions. *JNNP*, 20(1), 11-21.
- Sutton, R.S., & Barto, A.G. (2018). *Reinforcement Learning: An Introduction* (2nd ed.). MIT Press.

### Computational
- Itti, L., & Koch, C. (2001). Computational modelling of visual attention. *Nature Reviews Neuroscience*, 2(3), 194-203.
- Rescorla, R.A., & Wagner, A.R. (1972). A theory of Pavlovian conditioning. In *Classical Conditioning II*.
- Wozniak, P.A., & Gorzelanczyk, E.J. (1994). Optimization of repetition spacing in the practice of learning. *Acta Neurobiologiae Experimentalis*, 54, 59-62.

### Satori-Internal
- Satori Architecture v3.0.0 — `/docs/ARCHITECTURE.md`
- Sleep Consolidation — `/docs/SLEEP-CONSOLIDATION.md`
- Data Processing Pipelines — `/docs/Data-Processing-Pipelines.md`
- Emergence Experiment — `/docs/EMERGENCE-EXPERIMENT.md`
- Barca AgentGroup1 Deployment Case Study (June 2026)

---

*Document version: 1.0 | Author: Satori Research (via OpenClaw agent) | Next review: 2026-07-14*
