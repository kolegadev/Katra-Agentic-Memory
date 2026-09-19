// Phase 5 decision invalidation + scoped suspension (criteria 15-17).
// Invalidation propagates through State Deltas ONLY — never by direct
// mutation of mission state. Suspension scopes to affected work items, never
// the whole mission. The prior plan and the reason are preserved for audit.
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import { StateDeltaService } from './state-delta-service.js';
import { traceAssumptionDependencies } from './dependency-traversal.js';

export interface InvalidationResult {
  delta_id: string;
  dependent_entry_ids: string[];
  suspended_work_items: number;
  plan_preserved: { entry_id: string; prior_plan_statement: string };
}

export async function invalidateDecision(
  db: Db,
  missionId: string,
  decisionEntryId: string,
  actorId: string,
  reason: string,
): Promise<InvalidationResult> {
  // 1. Transitive dependents of the invalidated decision (criteria 5-7).
  const trace = await traceAssumptionDependencies(db, missionId, decisionEntryId);

  // 2. Preserve the prior plan + reason (criterion 17) as a ledger entry,
  //    and mark the decision invalidated via supersession by the new entry.
  const deltas = new StateDeltaService(db);
  const now = new Date().toISOString();
  const planEntry = {
    schema_version: '1.0',
    mission_id: missionId,
    entry_type: 'contradiction' as const,
    statement: `Decision ${decisionEntryId} invalidated: ${reason.slice(0, 400)}. Dependent entries affected: ${trace.dependents.join(', ') || 'none'}.`,
    status: 'active' as const,
    author_id: actorId,
    confidence: 1,
    depends_on: [decisionEntryId],
    created_at: now,
    updated_at: now,
  };

  // 3. Propagate via State Delta (criterion 15): DECISION_INVALIDATED.
  const delta = await deltas.submitDelta({
    schema_version: '1.0',
    idempotency_key: `invalidate-${decisionEntryId}-${now.slice(0, 16)}`,
    mission_id: missionId,
    base_mission_version: (await currentVersion(db, missionId)) ?? 1,
    author_id: actorId,
    delta_type: 'DECISION_INVALIDATED',
    operations: [{ op: 'replace', path: `/ledger_refs/${decisionEntryId}`, value: 'invalidated' }],
    ledger_entries: [planEntry],
    rationale: reason.slice(0, 300),
    confidence: 1,
  }, { actorId: actorId });

  if (delta.status !== 'accepted') {
    throw new Error(`invalidation delta not accepted (${delta.status}) — nothing was mutated directly`);
  }

  // 4. Scoped suspension (criterion 16): only work items whose description
  //    references a dependent entry get blocked — never the whole mission.
  const dependentSet = new Set([decisionEntryId, ...trace.dependents]);
  const workItems = await db
    .collection(COLLECTIONS.cognitiveWorkItems)
    .find({ mission_id: missionId, status: { $in: ['queued', 'allocated', 'in_progress'] } }, { projection: { _id: 0, work_item_id: 1, description: 1 } })
    .toArray() as unknown as Array<{ work_item_id: string; description: string }>;
  let suspended = 0;
  for (const w of workItems) {
    const affected = [...dependentSet].some(id => w.description.includes(id));
    if (!affected) continue;
    await db.collection(COLLECTIONS.cognitiveWorkItems).updateOne(
      { work_item_id: w.work_item_id },
      { $set: { status: 'blocked', updated_at: now, suspension_reason: reason.slice(0, 200) } } as any,
    );
    suspended += 1;
  }

  return {
    delta_id: delta.delta_id,
    dependent_entry_ids: trace.dependents,
    suspended_work_items: suspended,
    plan_preserved: {
      entry_id: (delta.ledger_entries?.[0] as any)?.entry_id ?? '',
      prior_plan_statement: planEntry.statement.slice(0, 120),
    },
  };
}

async function currentVersion(db: Db, missionId: string): Promise<number | null> {
  const state = await db
    .collection(COLLECTIONS.missionStates)
    .findOne({ mission_id: missionId }, { projection: { _id: 0, version: 1 } });
  return (state as any)?.version ?? null;
}
