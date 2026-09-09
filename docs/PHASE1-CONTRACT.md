# Phase 1 Contract — The Attention Gate (Thalamus Proxy)

**Date:** 2026-06-30
**Source:** MASTER-SYNTHESIS.md §3.1 + §6 Phase 1
**Status:** In Progress

## Goal

Implement the 6-signal salience function that gates what reaches "consciousness" in Katra. Without this, every memory has equal retrieval weight. This is the thalamus — it enables cognition by deciding what reaches the cortex.

## Boundaries

- MUST NOT change existing memory write paths (append-only preserved)
- MUST NOT delete any existing code paths
- MUST NOT alter existing MCP tool signatures
- New code goes in `server/src/services/processing/salience-service.ts`
- MCP tools are additive only

## Success Criteria

1. **6-signal salience function:** `S = w1*Recency + w2*EmotionalIntensity + w3*GoalRelevance + w4*Novelty + w5*FrequencyRarity + w6*Intensity` — all normalised to [0,1]
2. **Dynamic weight modulation:** 5 meta-states (exploration, task_execution, reflection, alert, idle) each with different weight distributions per the research
3. **3-tier output:** High (>0.7) → full processing, Medium (0.35-0.7) → embedding only, Low (<0.35) → minimal storage + faster decay
4. **Bayesian surprise:** Compute KL-divergence proxy between entity emotional prior and new observation. `surprise = 0.6*|valence_shift| + 0.4*|intensity_shift|`
5. **Wire into handleStoreMemory:** After anomaly detection in mcp-server.ts episodic path, compute salience and store salience_score + salience_tier on the event document
6. **MCP tools:** `get_salience_state` (current meta-state, weights, threshold), `get_attention_report` (recent high/medium/low distribution, avg score, active goals)
7. **New unit tests** for salience computation, weight modulation, and tier thresholds
8. **All existing tests pass** — no regressions

## Interfaces

```
SalienceService:
  setMetaState(state: MetaState): void
  computeSalience(params: { memoryAgeHours, emotionalIntensity, memoryEmbedding?, topicFrequency, contentIntensity, noveltyScore, socialEngagementScore }): SalienceResult
  computeBayesianSurprise(priorValence, priorIntensity, newValence, newIntensity): number
  getProcessingDirective(tier: SalienceTier): { compute_embedding, trigger_consolidation, decay_multiplier, add_to_working_memory }
  getAttentionReport(): AttentionReport
```

## Key Formulas

```
Recency = 1 / (1 + 0.1 * hours_since_event)
GoalRelevance = max(cosine_sim(memory_embedding, goal_embedding)) across active goals
FrequencyRarity = 1 - topic_frequency

Meta-state weights (from research):
  exploration:    novelty=0.40, emotion=0.20, goal=0.15, recency=0.10
  task_execution: goal=0.50, recency=0.25, novelty=0.10, emotion=0.05
  reflection:     emotion=0.35, goal=0.20, recency=0.15, novelty=0.15
  alert:          emotion=0.30, novelty=0.25, recency=0.20, goal=0.20
  idle:           novelty=0.30, emotion=0.25, recency=0.15, frequency=0.15

Yerkes-Dodson threshold: θ_attention = 0.5 + 0.3*(arousal - 0.5)²
  Optimal arousal (0.5) → lowest threshold (0.5) → most permissive
  Low/high arousal → higher threshold → more selective
```

## Modules Involved

- `server/src/services/processing/salience-service.ts` — NEW
- `server/src/mcp-server.ts` — import, wire into storeMemory, add 2 MCP tools
- `server/tests/unit/salience-service.test.ts` — NEW
