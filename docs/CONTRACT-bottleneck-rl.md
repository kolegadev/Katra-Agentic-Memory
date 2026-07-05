# CONTRACT: Bottleneck → RL Decision Points

## Goal
Every architectural bottleneck forces a choice. Wire each bottleneck's choice point through `selectAction()` so the RL loop learns which decisions produce better outcomes. This transforms constraints from static rules into learned policies.

## Bottleneck Decision Points

### 1. Goal Manager: Which subtask next? (THIS CONTRACT)
- Current: `getNextAction()` picks first unblocked task (topological)
- Bottleneck: only one task can be in_progress at a time
- Decision: `selectAction("goal:{goalId}", unblockedTasks, context)`
- Outcome: task completed → positive reward; task blocked → negative; task stalled → negative

### 2. Attention Gate: Full vs lightweight processing? (NEXT)
- Current: hardcoded `SYSTEM_EVENT_TYPES` set
- Bottleneck: LLM extraction is expensive, must be selective
- Decision: `selectAction("triage:{eventType}", ["full_extraction", "lightweight_triage"], context)`
- Outcome: extraction quality vs processing cost

### 3. Sleep Consolidation: Which entities to reflect on? (AFTER)
- Current: all entities in period
- Bottleneck: LLM token budget per consolidation
- Decision: `selectAction("reflect:{period}", entityNames, context)`
- Outcome: valence shift after reflection (did reflecting on X improve emotional state?)

### 4. Working Memory: Which items to evict? (AFTER)
- Current: lowest salience evicted
- Bottleneck: max 5 items
- Decision: `selectAction("wm:{sessionId}", activeItemIds, context)`
- Outcome: whether evicted item was later recalled (regret signal)

## This Contract: Goal Manager RL
- MODIFY: `goal-manager.ts` — `getNextAction()` uses RL when multiple unblocked tasks
- MODIFY: `decision-action-service.ts` — expose outcome type for goal tasks
- Success: Q-values for subtask selection diverge over time → policy emerges
