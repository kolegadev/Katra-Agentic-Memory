# CONTRACT: Close the RL Loop — Wire recordOutcome to Real Events

## Goal
Wire `DecisionActionService.recordOutcome()` to real Katra processing events so Q-values are learned from extraction outcomes, policies emerge, and the drift-diffusion gate activates with meaningful evidence.

## Boundaries
- MODIFY: `background-processor.ts` — add outcome observation after extraction
- MODIFY: `decision-action-service.ts` — minor (already has recordOutcome)
- DO NOT TOUCH: extraction pipeline logic, dispatch service, sleep consolidation
- DO NOT TOUCH: Q-table internals, softmax math, drift-diffusion constants

## Success Criteria
1. After each successful extraction in `processEvent()`, `recordOutcome()` is called with:
   - stateKey: `"extraction:{event_type}"` — contextualizes the action
   - actionId: `"full_extraction"` 
   - expected: 0.5 (baseline expectation of useful extraction)
   - actual: computed from extraction quality (entity count, relationship count)
2. After each lightweight system event in `processSystemEvent()`, `recordOutcome()` is called with:
   - stateKey: `"triage:{event_type}"`
   - actionId: `"lightweight_triage"`
   - expected: 1.0 (expect success)
   - actual: 1.0 (always succeeds)
3. After sleep consolidation valence shifts, `recordOutcome()` is called:
   - stateKey: `"reflection:{entity_name}"`
   - actionId: `"engage_{entity_name}"`
   - expected: prior valence
   - actual: new valence
4. Background processor imports and calls `DecisionActionService` without circular dependency issues
5. Existing extraction/triage behavior unchanged — outcome recording is fire-and-forget (errors logged, never thrown)

## Interfaces
```typescript
// Called from background-processor.ts after extraction
DecisionActionService.get_instance().recordOutcome(
  `extraction:${eventType}`,
  'full_extraction',
  0.5,
  qualityScore  // 0-1 based on entities/relationships extracted
);

// Called from background-processor.ts after triage
DecisionActionService.get_instance().recordOutcome(
  `triage:${eventType}`,  
  'lightweight_triage',
  1.0,
  1.0
);
```

## Quality Score Computation
```
qualityScore = clamp(
  (entityCount * 0.3 + relationshipCount * 0.3 + factCount * 0.4) / 10,
  0, 1
)
```
Yields 0 for empty extractions, ~0.5 for average, 1.0 for rich extractions.

## Expected Behavior
- RL system starts accumulating outcomes → Q-values diverge from zero
- `getErrorReport()` shows non-zero accuracy after ~50 outcomes
- Subsequent `selectAction()` calls produce differentiated probabilities
- No change to existing processing throughput
