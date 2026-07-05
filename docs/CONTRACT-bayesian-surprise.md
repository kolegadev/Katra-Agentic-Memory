# CONTRACT: Bayesian Surprise in SalienceService

## Goal
Add Bayesian surprise computation to `SalienceService.computeSalience()` — distinguishing between *rare but inconsequential* events and *belief-changing* events. When an event fundamentally shifts what Katra knows about an entity, it should spike in salience.

## Boundaries
- MODIFY: `salience-service.ts` — add `computeBayesianSurprise()` and integrate into `computeSalience()`
- DO NOT TOUCH: other salience signals (recency, emotion, goal, novelty, frequency, intensity)
- DO NOT TOUCH: meta-state logic, threshold computation, MCP handlers

## Success Criteria
1. `computeBayesianSurprise(entityName: string, priorBelief: number, newEvidence: number): number` returns KL divergence between prior and posterior
2. Integrated into `computeSalience()` as a seventh signal when entity context is available
3. Returns 0 when no entity context (backward compatible)
4. Surprise score feeds into the `alert` meta-state transition: sustained high surprise → shift toward alert mode

## From Research (attention-mechanisms.md §2.2.2)
"Bayesian surprise measures how much a new observation changes the agent's beliefs — KL divergence between prior and posterior. An event of 'it rained today' has high Shannon surprise but low Bayesian surprise; 'the server architecture is different' has high Bayesian surprise because it fundamentally updates the world model."

## Implementation
```
BayesianSurprise(entity) = D_KL( P(entity|prior) || P(entity|posterior) )

Where:
- prior = entity's existing confidence in the knowledge graph (from knowledge_nodes)
- posterior = prior updated with new evidence from the event
- KL divergence quantifies the "belief shift"

Simplified: surprise = |newConfidence - priorConfidence| / (priorConfidence + ε)
→ Large relative shifts in confidence = high Bayesian surprise
```

## Interface
```typescript
// New method on SalienceService
computeBayesianSurprise(entityName: string, newConfidence: number): number;

// Modified computeSalience signature (backward compatible addition)
computeSalience(params: SalienceParams & { entityName?: string; priorConfidence?: number }): SalienceResult;
```

## Expected Behavior
- Events mentioning entities with stable beliefs → low Bayesian surprise
- Events mentioning new entities → moderate surprise (learning)
- Events contradicting existing beliefs → high Bayesian surprise
- No entity context → surprise = 0 (no change)
