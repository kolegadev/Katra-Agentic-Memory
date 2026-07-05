# CONTRACT: Activate Drift-Diffusion Decision Gate

## Goal
Replace the single-step drift computation in `selectAction()` with a proper evidence accumulation process. Evidence accumulates across multiple cycles until it crosses the decision boundary — then (and only then) an action is selected.

## From Research (decision-motivation-action.md §1.4)
"dx = μ·dt + σ·dW. The process stops when x hits the upper boundary or lower boundary. Boundary separation = caution parameter modulated by drive state."

## Boundaries
- MODIFY: `decision-action-service.ts` — add evidence accumulator, modify selectAction()
- DO NOT TOUCH: softmax, Q-table, outcome recording, motivation bridge
- DO NOT TOUCH: other services

## Success Criteria
1. Evidence accumulates across calls: each `selectAction()` adds μ·dt + σ·dW to the accumulator
2. Decision only fires when |evidence| >= effectiveBoundary
3. Pre-decision state: returns `crossed: false` with current evidence level
4. Post-decision state: resets accumulator, returns selected action with crossed: true
5. Idle timeout: if evidence doesn't cross boundary within 10 cycles, force a decision
6. Backward compatible: return type unchanged, callers handle crossed:false gracefully

## Implementation
```
selectAction(stateKey, actions, context?):
  accumulator = this.evidenceAccumulators[stateKey] || 0
  
  // Compute drift rate from Q-values and wanting bias
  mu = selectedQ * (1 + wantingBias)
  
  // Accumulate: Wiener process step
  noise = DRIFT_SIGMA * gaussianRandom()
  accumulator += mu * 0.1 + noise   // dt = 0.1 per cycle
  accumulator = clamp(accumulator, -effectiveBoundary, effectiveBoundary)
  
  this.evidenceAccumulators[stateKey] = accumulator
  this.accumulatorCycles[stateKey] = (this.accumulatorCycles[stateKey] || 0) + 1
  
  // Check boundary crossing or timeout
  if |accumulator| >= effectiveBoundary OR cycles >= 10:
    // Decision! Reset accumulator, select action, return
    delete this.evidenceAccumulators[stateKey]
    delete this.accumulatorCycles[stateKey]
    return { crossed: true, selected_action, ... }
  else:
    // Defer — evidence still accumulating
    return { crossed: false, selected_action: null, evidence: accumulator, ... }
```
