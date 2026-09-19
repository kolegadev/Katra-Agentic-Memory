// Phase 4 §2 cost basis — DOCUMENTED PROXY (decision recorded, not invented).
//
// Decision: option (b). Real per-call cost capture would require threading
// token/cost attribution through llm-service.ts — outside this contract's
// file set and not permitted by the Phase 4 boundaries. Instead the scheduler
// uses a coarse, deterministic cost band derived from the work item's mode
// and declared budget (when present), with the basis stated in EVERY
// explanation output and persisted decision record.
//
// Bands are relative cost units, not dollars: they rank cognitive work,
// they do not bill it. The explanation surfaces `cost_basis:
// "proxy-band-mode-relative"` so a human always knows what a score is made of.
// Part of the no-publish branch feat/cognitive-control-local.
import type { BatonMode } from '../../types/cognitive-control.js';

export const COST_BASIS = 'proxy-band-mode-relative';
export const COST_FLOOR = 1; // never divide by zero (criterion 5)

const MODE_BANDS: Record<BatonMode, number> = {
  // Relative units: cheap bounded cognition first, expensive synthesis last.
  execute: 2,
  monitor: 1,
  verify: 3,
  challenge: 4,
  explore: 6,
  synthesize: 8,
};

/** Deterministic, always-positive cost estimate for a cognitive work item. */
export function estimateCognitiveCost(mode: BatonMode, declaredBudget?: { max_cost?: number; max_hours?: number }): number {
  let band = MODE_BANDS[mode] ?? COST_FLOOR;
  if (declaredBudget?.max_hours !== undefined) {
    // A declared hour budget signals larger expected effort.
    band += Math.min(declaredBudget.max_hours, 24);
  }
  return Math.max(COST_FLOOR, band);
}
