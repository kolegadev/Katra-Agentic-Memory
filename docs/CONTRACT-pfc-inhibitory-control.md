# CONTRACT: PFC Inhibitory Control — Pre-Action Goal Check

## Goal
Add a pre-action filter to `DecisionActionService.selectAction()` that suppresses actions conflicting with active goals. This is the "don't do that, stay focused" function of the PFC.

## From Research (brain-function-gap-map.md §2.3)
"Inhibitory Control: Action filter — before acting, check against active goals. Response suppression — flag actions that match known-bad patterns. Impulse delay — insert deliberation step before high-stakes actions."

## Boundaries
- MODIFY: `decision-action-service.ts` — add `inhibitAction()` check in `selectAction()`
- MODIFY: `goal-manager.ts` — expose `getActiveGoalTerms()`
- DO NOT TOUCH: Q-table, softmax, drift-diffusion, outcome recording

## Success Criteria
1. When `selectAction()` is called with a `MotivationContext` that includes `activeGoalTerms`, actions irrelevant to those terms get probability penalty
2. Penalty is proportional to irrelevance: actions matching 0 goal terms → -50% probability, matching 1+ → no penalty
3. If ALL actions are irrelevant, penalty is skipped (don't block everything)
4. `GoalManager.getActiveGoalTerms(userId)` returns keyword set from all active goal titles
5. Inhibition is logged as `inhibited: true` in the `DecisionResult`

## Implementation
```
inhibitAction(actionId, activeGoalTerms):
  if no goal terms → skip (no inhibition)
  relevance = count of goal terms found in actionId
  if relevance === 0 → penalty = 0.5 (50% probability reduction)
  else → penalty = 1.0 (no reduction)
  
  // Don't inhibit if ALL actions would be penalized
  if all actions have relevance === 0 → skip inhibition
```

## Expected Behavior
- Without active goals: no inhibition (backward compatible)
- With active goal "Implement PFC inhibitory control": actions matching implementation terms get priority, unrelated actions suppressed
- Drift-diffusion boundary widens slightly when inhibition is active (more deliberate)
