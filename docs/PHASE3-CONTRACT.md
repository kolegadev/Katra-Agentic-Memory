# Phase 3 Contract — Decision/Action Architecture

**Date:** 2026-06-30
**Source:** MASTER-SYNTHESIS.md §3.5 + §6 Phase 3
**Depends on:** Phase 2 (MotivationalEngine for reward signal)

## Goal

From wanting to doing. Implement TD-learning, drift-diffusion evidence accumulation, softmax action selection, and ACC error monitoring. Katra can select actions, learn from outcomes, and modulate exploration.

## Boundaries

- MUST NOT change existing write paths or MCP tool signatures
- New code in `server/src/services/processing/decision-action-service.ts`
- MCP tools additive only
- No DB required for Q-table (in-memory Map with optional persistence)

## Success Criteria

1. **TD-Learning:** `δ = r + γ·V(s') - Q(s,a)`, `Q(s,a) ← Q(s,a) + α·δ`. Default α=0.1, γ=0.9. Q-table in-memory Map<string, Map<string, number>>
2. **Drift-diffusion gate:** `dx = μ·dt + σ·dW`. Evidence accumulates to boundary_separation=1.0. When threshold crossed → decide. Reaction time estimated from evidence strength.
3. **Softmax selection:** `P(a|s) = exp(Q(s,a)/τ) / Σ exp(Q(s,a')/τ)`. Temperature τ modulates exploration/exploitation. Low τ → exploit, high τ → explore.
4. **Error monitor (ACC):** `recordOutcome(stateKey, actionId, expected, actual)`. Tracks prediction accuracy, conflict count (>0.3 error), surprise rate, average TD error.
5. **Reward from valence:** `reward = (current_valence - previous_valence) + γ·expected_future - expected`. Connects to MotivationalEngine's emotional signatures.
6. **MCP tools:** `get_error_report` (accuracy, avg TD error, surprise rate, conflicts), `get_action_policy` (takes state_key, returns Q-values + selection probabilities)
7. **Unit tests** for TD-learning, softmax, drift-diffusion, error monitoring
8. **All existing tests pass** — no regressions

## Interfaces

```
DecisionActionService (singleton):
  computeTDError(stateKey, actionId, reward, nextStateKey): TDError
  computeRewardFromValence(previousValence, currentValence, expectedValence, expectedFutureValence): number
  selectAction(stateKey, availableActions[], tau?): DecisionResult
  recordOutcome(stateKey, actionId, expectedValue, actualOutcome): void
  getErrorReport(): ErrorReport
  getPolicy(stateKey): PolicyEntry[]
  getQValue(stateKey, actionId): number
  getMaxQValue(stateKey): number
```

## Key Formulas

```
TD error: δ = r + 0.9 * max(Q(s',*)) - Q(s,a)
Q update: Q(s,a) += 0.1 * δ
Softmax: P(a|s) = exp((Q(s,a) - maxQ)/τ) / Σ exp((Q(s,a') - maxQ)/τ)
Drift-diffusion: evidence += Q(s,a) + N(0, 0.1), decide when evidence > 1.0
```

## Modules Involved

- `server/src/services/processing/decision-action-service.ts` — NEW
- `server/src/mcp-server.ts` — import, add 2 MCP tools
- `server/tests/unit/decision-action-service.test.ts` — NEW
