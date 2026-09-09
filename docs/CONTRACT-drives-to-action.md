# CONTRACT: Wire Motivational Drives to Action Selection

## Goal
Bridge `MotivationalEngine` (Phase 2) to `DecisionActionService` (Phase 3) so that homeostatic drive deficits and incentive salience (wanting) modulate what actions Katra selects, with what urgency, and how much it explores vs exploits.

## Boundaries
- MODIFY: `decision-action-service.ts` — `selectAction()` method
- MODIFY: `motivational-engine.ts` — expose `getDriveDeficits()` and `getDominantDrive()`
- DO NOT TOUCH: drive depletion/replenishment logic, Q-table internals, softmax math
- DO NOT TOUCH: background-processor.ts, salience-service.ts, sleep-consolidation

## Success Criteria
1. `selectAction()` accepts an optional `MotivationContext` parameter: `{ entityName?: string, userId?: string }`
2. Drive deficits modulate the temperature parameter τ in softmax:
   - High deficit in dominant drive → τ increases (more exploration)
   - All drives near target → τ stays at baseline (more exploitation)
3. Incentive salience (wanting) for the target entity biases softmax probabilities:
   - High wanting for entity → entity-relevant actions get probability boost
   - High divergence (wanting ≠ liking) → urgency boost (higher boundary in drift-diffusion params)
4. Existing callers of `selectAction()` (if any) continue to work unchanged (optional parameter)
5. `MotivationalEngine` exposes:
   - `getDriveDeficits(): Record<DriveName, number>` — 1.0 means fully depleted, 0.0 means satiated
   - `getDominantDrive(): DriveName` — already exists, verify it works
   - `computeIncentiveSalience()` — already exists, verify it's callable from DecisionActionService

## Interfaces
```typescript
// New: MotivationContext passed to selectAction
interface MotivationContext {
  entityName?: string;
  userId?: string;
}

// New: exposed from MotivationalEngine
interface DriveDeficits {
  coherence: number;   // 0-1, 1 = fully depleted
  novelty: number;
  connection: number;
  growth: number;
}

// Modified: selectAction signature
selectAction(
  stateKey: string,
  actionIds: string[],
  context?: MotivationContext
): DecisionResult;
```

## Expected Behavior
With no motivation context: behavior identical to current (backward compatible).
With motivation context: exploration temperature and action probabilities shift based on current drive state.
