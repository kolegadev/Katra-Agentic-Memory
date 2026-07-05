# CONTRACT: ACC → Thalamus Feedback Loop

## Goal
Close the adaptive attention loop: error/surprise signals from `DecisionActionService` (ACC) modulate `SalienceService` meta-weights (Thalamus). This replaces frozen startup weights with dynamic, experience-driven attention allocation.

## From Research (MASTER-SYNTHESIS §3.1)
"High arousal → narrow focus (exploit mode). Low arousal → broad exploration (curiosity mode). Negative emotional state → hypervigilance. Positive → open to novelty."

And (attention-mechanisms.md §5):
"arousal(t) = α·event_rate + β·surprise_rate + γ·goal_pressure - δ·idle_time"

## Boundaries
- MODIFY: `salience-service.ts` — add `adaptWeights()` method
- MODIFY: `decision-action-service.ts` — expose `getSurpriseRate()` and `getRecentAccuracy()`
- DO NOT TOUCH: computeSalience core math, meta-state transitions, MCP handlers
- DO NOT TOUCH: background processor

## Success Criteria
1. `SalienceService.adaptWeights()` called each background cycle, reads ACC state
2. High surprise rate (>0.3) → shift weights toward `exploration` profile (novelty up, goal down)
3. High accuracy (>0.7) and low surprise → shift toward `task_execution` (goal up, exploit)
4. Sustained idle (10+ cycles with no significant outcomes) → shift toward `idle` (balanced, low threshold)
5. Weight transitions are gradual (interpolated, not binary) — prevent oscillation
6. Base weights are preserved as anchor — adapted weights always interpolate toward them

## Implementation
```
adaptWeights():
  report = DecisionActionService.getErrorReport()
  
  surpriseBias = clamp(surpriseRate / 0.5, 0, 1)   // 0=no surprise, 1=high surprise
  accuracyBias = clamp(accuracy, 0, 1)               // 0=random, 1=perfect
  
  // Blend toward exploration when surprised, toward task_execution when accurate
  target = surpriseBias > 0.3 ? 'exploration' : accuracyBias > 0.7 ? 'task_execution' : current
  
  // Smooth interpolation (10% per cycle) to prevent oscillation
  for each weight:
    new = current * 0.9 + META_WEIGHTS[target][weight] * 0.1
```

## Interfaces
```typescript
// New on SalienceService
adaptWeights(): void;  // Called from background processor each cycle

// New on DecisionActionService  
getSurpriseRate(): number;    // Already computed in getErrorReport()
getRecentAccuracy(): number;  // Already computed in getErrorReport()
```
