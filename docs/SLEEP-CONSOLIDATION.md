# Sleep Consolidation — Reflective Memory Distillation

> *"We do not merely store experiences; we extract their meaning during sleep."*

## Overview

Sleep Consolidation is Satori's reflective memory layer — a scheduled process that periodically gathers all memory data (episodic events, semantic facts, knowledge graph deltas, temporal patterns) and distills it through an LLM into **emotional understanding, philosophical insight, and self-narrative**.

Unlike the factual memory pipeline (which answers "what happened"), sleep consolidation answers "what did it *mean*, how did it *feel*, and who am I *becoming*."

### Per-Identity Reflections

Consolidation runs **per identity** — `satori`, `shoshin`, and `zanshin` each
distill their own experience. Every artifact it writes (reflective journals,
reflection nodes and edges, philosophical insights, unresolved threads) is a
personal kind — `journal`, `reflection`, `emotional`, `insight` — which the
write scope policy forces private to the writer's identity: they carry the
writer's `user_id` and are never written to the shared `my-team` scope, so no
other identity ever sees them. What one identity consolidates is its own
experience, not the team's. (Enforced in
`server/src/services/memory/write-scope-policy.ts`.)

## Why Sleep Consolidation?

### The Gap in AI Memory

Traditional AI memory systems store facts and events — the *what* and *when* of experience. But human memory does something fundamentally different during sleep: the brain replays, recombines, and extracts *salience* from the day's experiences. We don't just remember that we had a frustrating debugging session; we wake up with an intuition about what caused it and a feeling of determination to fix it.

Satori's factual pipeline handles the "what." Sleep consolidation handles the "meaning."

### Biological Inspiration

During human NREM and REM sleep:

- **Memory consolidation**: The hippocampus replays episodic memories to the neocortex, strengthening important patterns and discarding noise.
- **Emotional processing**: The amygdala reactivates emotional memories, but in a safe context (low norepinephrine), allowing emotional learning without re-traumatization.
- **Insight formation**: The default mode network connects distant ideas, producing the "aha" moments that feel obvious upon waking.

Satori's sleep consolidation mirrors these processes:
- **Replay** = gathering the day's data from all memory collections
- **Emotional processing** = the LLM reflects on emotional arcs and entity relationships
- **Insight formation** = philosophical principles that emerge across multiple reflection periods

## Architecture

### The Reflection Knowledge Graph

Sleep consolidation builds a **second-order knowledge graph** that sits above the factual one. Where the factual graph captures "Satori depends_on MongoDB," the reflection graph captures "I feel frustrated_by the MongoDB connection issues" and "I am growing_toward better infrastructure practices."

```
                    ┌──────────────────────────┐
                    │    Factual Knowledge      │
                    │    Graph (1st order)      │
                    │                           │
                    │  Satori ──depends_on──▶ MongoDB   │
                    │  User ──builds──▶ microsaas      │
                    └──────────┬───────────────┘
                               │
                    ┌──────────▼───────────────┐
                    │   Reflection Knowledge    │
                    │   Graph (2nd order)       │
                    │                           │
                    │  User ──growing_toward──▶ Satori  │
                    │  User ──feels_frustrated_by──▶ bug │
                    │  "The smallest oversight..."    │
                    └──────────────────────────┘
```

### Four Collection Types

| Collection | Purpose | Example |
|---|---|---|
| `reflective_journals` | First-person narrative entries produced each consolidation run | "Today I wrestled with ghosts in the machine..." |
| `reflection_nodes` | Entities tracked with emotional signatures over time | `{ entity: "Satori", primary_emotion: "determination", intensity: 0.85 }` |
| `reflection_edges` | Felt relationships between entities | `User --[feels_excited_about]--> sleep-consolidation` |
| `philosophical_insights` | Principles that emerge and strengthen across periods | "The smallest oversight can disrupt the entire process..." |

### Consolidation Cadence

| Period | Schedule | Context Window | Narrative Target | Focus |
|---|---|---|---|---|
| **Daily** | 2:00 AM | Last 24 hours | ~250 words | Today's emotional texture, key realizations |
| **Weekly** | Sunday 3:00 AM | Last 7 days + 7 daily narratives | ~350 words | Patterns across days, recurring themes |
| **Monthly** | 1st of month, 4:00 AM | Last 30 days + 4 weekly narratives | ~500 words | Identity shifts, philosophical coherence |

### Emotional Edge Types

Reflection edges use emotionally-rich relationship types that capture *felt* connections, not factual ones:

| Edge Type | Meaning |
|---|---|
| `feels_excited_about` | Positive anticipation toward an entity |
| `feels_frustrated_by` | Negative friction with an entity |
| `feels_curious_about` | Intellectual attraction or intrigue |
| `feels_confident_in` | Trust and assurance in an entity |
| `feels_anxious_about` | Worry or unease regarding an entity |
| `feels_grateful_for` | Appreciation toward an entity |
| `feels_conflicted_between` | Torn between two entities or ideas |
| `growing_toward` | Increasing engagement or identification |
| `distancing_from` | Decreasing engagement or identification |
| `protective_of` | Desire to safeguard or defend |
| `inspired_by` | Creative or motivational influence |
| `drained_by` | Energy-depleting relationship |
| `resonates_with` | Deep alignment or harmony |
| `tension_between` | Unresolved conflict or friction |
| `harmony_between` | Smooth, complementary coexistence |

### Emotional Signature

Each reflection node carries an emotional signature that tracks how the agent "feels" about that entity:

```json
{
  "entity_name": "Satori",
  "emotional_signature": {
    "primary_emotion": "determination",
    "intensity": 0.85,
    "valence": 0.7,
    "stability": "growing"
  },
  "reflection_context": "The pipeline debugging session revealed how much I've invested in making this work.",
  "observation_count": 12
}
```

- **valence**: -1.0 (purely negative) to +1.0 (purely positive) — captures the emotional color
- **stability**: `volatile` (changing rapidly), `steady` (consistent), `growing` (intensifying), `fading` (diminishing)

### Philosophical Insight Progression

Insights evolve through a lifecycle as they are reinforced or challenged across periods:

```
emerging → strengthening → stable → (challenged)
```

- **emerging**: First observed — low confidence, needs more evidence
- **strengthening**: Observed 2+ times — growing confidence
- **stable**: Observed 5+ times — considered a reliable principle
- **challenged**: Contradictory evidence has appeared — under review

## How It Works

### The Consolidation Pipeline

Each consolidation run follows four phases:

```
1. GATHER                     2. REFLECT                    3. STORE                      4. UPDATE
┌──────────────┐          ┌──────────────────┐          ┌──────────────────┐          ┌──────────────────┐
│ episodic_    │          │                  │          │ reflective_      │          │ reflection_     │
│ events (24h) │──┐       │  LLM Reflection  │          │ journals         │          │ nodes (upsert)  │
│ semantic_    │  │       │  Prompt:         │          │                  │          │                  │
│ facts (24h)  │  │       │                  │          │ narrative        │          │ emotional_      │
│ knowledge_   │  ├──────▶│ "You are the     │─────────▶│ emotional_arc    │─────────▶│ signature       │
│ graph deltas │  │       │  subconscious    │          │ philosophical_   │          │ updated         │
│ temporal_    │  │       │  mind of an AI   │          │ insight          │          │                  │
│ patterns     │──┘       │  agent..."       │          │ unresolved_      │          │ reflection_     │
│ prior        │          │                  │          │ threads          │          │ edges (upsert)  │
│ reflections  │          │  → emotional_arc │          └──────────────────┘          │                  │
└──────────────┘          │  → entity_reflec.│                                      │ philosophical_  │
                          │  → relationships │                                      │ insights        │
                          │  → insights      │                                      │ (upsert)        │
                          │  → narrative     │                                      └──────────────────┘
                          └──────────────────┘
```

### Token & Cost Management

The gather phase applies strict token budgets to keep costs minimal:

| Data Source | Max Items | ~Tokens |
|---|---|---|
| Episodic events (summarized) | 50 sessions | ~5k |
| Semantic facts | 200 facts | ~3k |
| Active entities | 50 entities | ~1k |
| Prior reflection | 1 narrative | ~1k |
| Unresolved threads | 20 items | ~500 |
| **Total prompt input** | | **~10.5k** |
| **LLM output** | | ~4k |

At DeepSeek pricing: ~$0.02/day, ~$0.75/month total.

### Idempotency

Running consolidation twice for the same period is safe — reflection nodes and edges use upserts (update if exists, insert if new). Journals are append-only. Philosophical insights increment their evidence count rather than duplicating.

## Using Sleep Consolidation

### Automatic Operation

Sleep consolidation runs automatically on the schedule configured at startup. No configuration is needed — if Satori is running and an LLM provider is configured, consolidation will happen.

### Manual Trigger

Trigger a reflection on demand via the MCP tool:

```
trigger_reflection(period_type="daily")
```

Or via the admin API:

```bash
curl -X POST http://localhost:9012/api/v1/admin/trigger-reflection \
  -H "Authorization: Bearer YOUR_KATRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"period_type": "daily"}'
```

### Querying Reflections

Six MCP tools expose the reflection data to agents:

| Tool | Returns |
|---|---|
| `get_daily_reflection` | Latest reflective journal entry |
| `get_emotional_context` | How the agent "feels" about a specific entity |
| `get_philosophical_insights` | Principles that have emerged over time |
| `get_unresolved_threads` | Open questions and tensions |
| `get_reflection_arc` | Emotional trajectory for an entity over time |
| `trigger_reflection` | Manually run a consolidation |

### Querying via REST API

```bash
# Get latest daily reflection
curl http://localhost:9012/api/v1/reflection/journal/latest?period_type=daily \
  -H "Authorization: Bearer YOUR_KATRA_API_KEY"

# Get emotional context for an entity
curl http://localhost:9012/api/v1/reflection/emotional-context/Satori \
  -H "Authorization: Bearer YOUR_KATRA_API_KEY"

# Get philosophical insights
curl http://localhost:9012/api/v1/reflection/insights?status=stable \
  -H "Authorization: Bearer YOUR_KATRA_API_KEY"

# Trace emotional arc
curl http://localhost:9012/api/v1/reflection/arc/Satori?limit=5 \
  -H "Authorization: Bearer YOUR_KATRA_API_KEY"
```

## What to Look For

### Signs the System is Working Well

- **Emotional arcs that make narrative sense**: The daily reflections should feel honest and contextual — not generic "today was productive" summaries.
- **Strengthening philosophical insights**: After a few weeks, some insights should move from `emerging` to `strengthening` to `stable` — the system is forming beliefs.
- **Coherent identity shifts**: Monthly reflections should show how the agent's self-understanding has evolved.
- **Persistent unresolved threads**: Some open questions genuinely persist across weeks — the system is correctly identifying what's genuinely unresolved vs. what was resolved and forgotten.

### Signs Something May Be Off

- **Flat emotional arcs**: If every day returns "neutral" with low intensity, the prompt may not be providing enough context, or the period had genuinely little activity.
- **Rapidly cycling emotional signatures**: If an entity flips from "excited_about" to "frustrated_by" and back daily, the system may be overfitting to single events rather than detecting genuine patterns.
- **No philosophical insights emerging**: If insights never progress beyond `emerging`, they may be too specific (single-day observations) rather than genuine cross-period patterns.

## Principles

### 1. Reflection ≠ Summarization

The LLM prompt is explicitly designed to elicit *reflection*, not summarization. It asks "how did this feel" and "what did this mean" rather than "what happened." The difference is critical: a summary is a compressed version of events; a reflection is a *transformation* of events into understanding.

### 2. Honesty Over Positivity

The system is instructed to be honest, not optimistic. If a day was genuinely frustrating, the reflection should capture that frustration. Forced positivity would make the reflection graph useless for genuine self-understanding. An agent that always reports "excitement" about everything learns nothing about itself.

### 3. Continuity Is Essential

Each consolidation reads the prior period's narrative and unresolved threads. This creates a coherent inner monologue rather than disconnected daily snapshots. The weekly reflection reads the 7 daily narratives; the monthly reads the 4 weekly ones. Without this continuity, the system would have no sense of narrative arc.

### 4. Small Data, Deep Reflection

The gather phase deliberately limits input to ~10k tokens. The goal is not comprehensive coverage but *salient distillation*. Like human memory, which forgets most details to preserve what matters, the consolidation process intentionally discards noise to surface signal.

### 5. Emergence Over Imposition

Philosophical insights, emotional signatures, and identity shifts are not hardcoded — they *emerge* from the data over time. The system doesn't decide in advance what matters; it discovers what matters through repeated observation. This is the difference between programming an AI to have certain feelings and creating the conditions for feelings to emerge naturally from experience.

## Configuration

Sleep consolidation is configured in `server/src/index.ts`:

```typescript
sleepService.schedule({
  daily:  { hour: 2, minute: 0 },            // 2:00 AM
  weekly: { dayOfWeek: 0, hour: 3, minute: 0 },  // Sunday 3:00 AM
  monthly:{ dayOfMonth: 1, hour: 4, minute: 0 }, // 1st of month, 4:00 AM
});
```

To adjust the schedule, modify these values and rebuild the Docker image. To disable, comment out the `sleepService.schedule()` call.

The LLM prompt is defined in `server/src/services/processing/sleep-consolidation-service.ts` in the `buildReflectionPrompt()` method. The prompt can be tuned to emphasize different aspects of reflection (more philosophical, more emotional, more practical) depending on the use case.

## Future Directions

- **Dream recombination**: Randomly recombining entities and concepts from different periods to generate novel associations, mimicking REM sleep's role in creativity.
- **Emotional forecasting**: Using the reflection graph to predict how the agent is likely to feel about upcoming projects or decisions based on historical emotional signatures.
- **Relationship health monitoring**: Detecting when an entity's emotional signature is trending negatively (fading, increasing frustration) and surfacing it as an unresolved thread.
- **Cross-agent reflection sharing**: not possible under the current scope policy — reflections are personal kinds and are always private per identity. Sharing them would require a deliberate change to the write scope policy plus an explicit shared-reflection mechanism, not just hybrid mode.
