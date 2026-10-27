// Phase 6: the ONE deliberate bridge between the existing allocator
// (autonomous-executive.ts) and the cognitive scheduler. Fail-closed by
// construction: any error anywhere in this path yields `null`/`false`, i.e.
// the pre-activation behaviour.
//
// Direction is allocator -> scheduler only. No mission-cognition module ever
// imports the allocator (criterion 12 static boundary, still enforced).
// Part of the no-publish branch feat/cognitive-control-local.
import { get_database } from '../../database/connection.js';
import {
  getSchedulerInfluence,
  recordAllocationCounterfactual,
  type SchedulerInfluence,
} from './activation-service.js';

export interface InfluenceQuery {
  localUserId: string;
  candidates: string[];
  /** What the existing allocator's own scoring chose — the counterfactual baseline. */
  existingChoice: string;
}

/**
 * Ask whether the scheduler may influence this allocation. `null` in every
 * disallowed case: mode below allocate_internal, kill switch, no opt-in,
 * hard bound reached, no applicable decision, or any storage error.
 */
export async function maybeGetSchedulerInfluence(opts: InfluenceQuery): Promise<SchedulerInfluence | null> {
  const db = get_database();
  if (!db) return null;
  try {
    return await getSchedulerInfluence(db, {
      localUserId: opts.localUserId,
      candidates: opts.candidates,
    });
  } catch (err) {
    console.warn('   ⚠️ scheduler influence query failed (fail closed):', (err as Error).message);
    return null;
  }
}

/**
 * Persist the counterfactual BEFORE the influenced choice takes effect.
 * Returns false on failure — callers MUST then keep the existing allocator's
 * choice (an uninstrumented influence is forbidden, §4.12).
 */
export async function persistAllocationCounterfactual(opts: {
  missionId: string;
  decisionId: string;
  cycleId: string;
  workItemId: string;
  chosenAgentId: string;
  existingAllocatorAgentId: string;
  reason: string;
}): Promise<boolean> {
  const db = get_database();
  if (!db) return false;
  try {
    await recordAllocationCounterfactual(db, opts);
    return true;
  } catch (err) {
    console.warn('   ⚠️ counterfactual recording failed (influence NOT applied):', (err as Error).message);
    return false;
  }
}
