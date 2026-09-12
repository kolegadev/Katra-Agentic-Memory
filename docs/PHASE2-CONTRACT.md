# Phase 2 Contract — Motivational Engine + Full Poisoning Defense

**Date:** 2026-06-30
**Source:** MASTER-SYNTHESIS.md §3.2 + §3.4 + §6 Phase 2
**Status:** In Progress

## Goal

Give Katra reasons to care. Implement homeostatic drive system, incentive salience (wanting ≠ liking), source trust weighting, and full quarantine/corroboration pipeline. Protect memory integrity.

## Boundaries

- MUST NOT change existing write paths or MCP tool signatures
- MUST NOT hard-delete any memory
- New code in `server/src/services/processing/motivational-engine.ts`
- MCP tools additive only

## Success Criteria

1. **4 homeostatic drives:** coherence, novelty, connection, growth — each with target level, depletion rate, strength computation `1 - current/target`
2. **Tick-based depletion:** `current -= depletion_rate * hours_elapsed` per drive, with replenish/deplete API
3. **Incentive salience (wanting):** `Wanting = base + α*valence + β*trend + γ*novelty + δ*prediction_error + ε*goal_relevance` with α=0.25, β=0.15, γ=0.10, δ=0.20, ε=0.30
4. **Wanting ≠ Liking:** Architecturally decoupled. Liking is valence directly. Divergence tracked.
5. **Source trust weighting:** `+0.02` per corroboration, `-0.15` per contradiction, new sources at 0.5, capped [0,1]. Trust decay 1%/day. Persisted in `source_trust_records` collection.
6. **Quarantine management:** AnomalyDetectionService (from Phase 0) extended with `recordCorroboration()` and `rehabilitateMemory()`. Auto-rehab at 3 corroborations.
7. **MCP tools:** `get_drive_state`, `get_source_trust`
8. **Unit tests** for drive computation, wanting/liking, source trust

## Interfaces

```
MotivationalEngine (singleton):
  tick(now?: Date): DriveSnapshot
  replenishDrive(driveName, amount): void
  depleteDrive(driveName, amount): void
  getDriveState(): Record<DriveName, DriveState>
  getDominantDrive(): DriveName
  computeIncentiveSalience(params): IncentiveSalienceResult
  getSourceTrust(sourceId): SourceTrustRecord
  updateSourceTrust(sourceId, event): SourceTrustRecord
  applyTrustDecay(): void
```

## Key Formulas

```
Drive strength = max(0, 1 - current_level / target_level)
Depletion rates (per hour): coherence=0.005, novelty=0.01, connection=0.008, growth=0.003
Target levels: coherence=0.8, novelty=0.7, connection=0.6, growth=0.5
```

## Modules Involved

- `server/src/services/processing/motivational-engine.ts` — NEW
- `server/src/services/processing/anomaly-detection-service.ts` — MODIFY: add recordCorroboration, rehabilitateMemory
- `server/src/mcp-server.ts` — import, add 2 MCP tools
- `server/tests/unit/motivational-engine.test.ts` — NEW
