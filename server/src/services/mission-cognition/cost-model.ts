// Phase 4 §2 cost basis — REAL MEASUREMENT (option a, per resolved
// prerequisite event_5f716a7a): measured TOKENS, not currency, not a proxy
// band. Tokens come from the exactly-once LLM usage ledger
// (infrastructure/llm-usage-ledger.ts), attributed by context scope
// (mission_id / work_item_id) via AsyncLocalStorage.
//
// Unit contract: `cognitive_cost` is the measured token count for the scope.
// When zero tokens have been observed the cost falls back to COST_FLOOR=1
// with basis `measured-tokens-zero-observed` — a visible absence of data,
// never an invented band. The explanation surfaces the basis string and the
// unit in every decision record (contract §3.1).
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';
import { measuredTokensForScope } from '../infrastructure/llm-usage-ledger.js';

export const COST_BASIS = 'measured-tokens';
export const COST_BASIS_ZERO = 'measured-tokens-zero-observed';
export const COST_UNIT = 'tokens';
export const COST_FLOOR = 1; // never divide by zero (criterion 5)

export interface MeasuredCost {
  cost: number;
  basis: string;
}

/** Measured token cost for a mission scope (or one work item within it). */
export async function measureCognitiveCost(
  db: Db,
  missionId: string,
  workItemId?: string,
): Promise<MeasuredCost> {
  const tokens = await measuredTokensForScope(db, missionId, workItemId);
  if (tokens > 0) {
    return { cost: tokens, basis: COST_BASIS };
  }
  return { cost: COST_FLOOR, basis: COST_BASIS_ZERO };
}
