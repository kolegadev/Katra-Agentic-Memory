// Phase 5 trigger precision + cost telemetry (criteria 20-21, doc 04 exit
// criterion 3). Every fired trigger records its outcome — useful_information
// / mere_variance / unnecessary_cost — with TOKEN COST MEASURED from the
// Phase 4 usage ledger (never estimated). Precision is computable from the
// stored records: fires, useful, performative, cost per useful trigger.
// Consumes llm-usage-ledger.ts (the authorised boundary — consumption only).
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import {
  runWithUsageOrigin,
  usageSnapshot,
  usageDeltaSince,
  measuredTokensForScope,
} from '../infrastructure/llm-usage-ledger.js';
import type { FiredTrigger, TriggerEvaluationRecord, TriggerOutcome } from '../../types/cognitive-control.js';

export interface TriggerPrecisionReport {
  fires: number;
  useful: number;
  performative: number;
  unnecessary: number;
  total_tokens: number;
  cost_per_useful_trigger: number;
  by_trigger: Record<string, { fires: number; useful: number; performative: number; tokens: number }>;
}

export async function recordTriggerOutcome(
  db: Db,
  fired: FiredTrigger,
  outcome: TriggerOutcome,
  note?: string,
  evaluationStart?: ReturnType<typeof usageSnapshot>,
): Promise<TriggerEvaluationRecord> {
  // Measured cost: tokens settled between the evaluation-start snapshot and
  // now (snapshot delta semantics — open is CURRENT, never a difference;
  // cross-run yields self, never negative). Without a start snapshot the
  // recorded cost is 0 — an honest absence, never an estimate.
  const before = evaluationStart ?? usageSnapshot();
  const delta = usageDeltaSince(before);
  const record: TriggerEvaluationRecord = {
    evaluation_id: randomUUID(),
    mission_id: fired.mission_id,
    trigger: fired.trigger,
    entry_id: fired.entry_id,
    fired_at: new Date().toISOString(),
    outcome,
    token_cost: delta.input_tokens + delta.output_tokens + delta.reasoning_output_tokens,
    note,
  };
  await db.collection(COLLECTIONS.triggerEvaluations).insertOne(record);
  return record;
}

export async function getTriggerReport(db: Db, missionId: string): Promise<TriggerPrecisionReport> {
  const rows = await db
    .collection(COLLECTIONS.triggerEvaluations)
    .find({ mission_id: missionId }, { projection: { _id: 0 } })
    .toArray() as unknown as TriggerEvaluationRecord[];

  const by_trigger: TriggerPrecisionReport['by_trigger'] = {};
  let useful = 0;
  let performative = 0;
  let unnecessary = 0;
  let totalTokens = 0;
  for (const r of rows) {
    const t = (by_trigger[r.trigger] ??= { fires: 0, useful: 0, performative: 0, tokens: 0 });
    t.fires += 1;
    t.tokens += r.token_cost;
    totalTokens += r.token_cost;
    if (r.outcome === 'useful_information') { useful += 1; t.useful += 1; }
    else if (r.outcome === 'mere_variance') { performative += 1; t.performative += 1; }
    else unnecessary += 1;
  }

  return {
    fires: rows.length,
    useful,
    performative,
    unnecessary,
    total_tokens: totalTokens,
    cost_per_useful_trigger: useful > 0 ? totalTokens / useful : 0,
    by_trigger,
  };
}

/** Measured mission-scope tokens (Phase 4 ledger) — for explanations. */
export async function measuredMissionTokens(db: Db, missionId: string): Promise<number> {
  return measuredTokensForScope(db, missionId);
}
