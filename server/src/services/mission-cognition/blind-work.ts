// Phase 5 blind independent work generation (criteria 8-11, decisive test A).
// A blind work item is a queued cognitive work item whose description/brief
// is constructed WITHOUT the incumbent conclusion, the incumbent rationale,
// or any private memory content — the worker must be unable to reconstruct
// the favoured answer from its inputs (doc 04 exit criterion 2).
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import type { CognitiveWorkItem, EntryType } from '../../types/cognitive-control.js';

const FORBIDDEN_ENTRY_TYPES: ReadonlySet<EntryType> = new Set(['decision', 'claim', 'hypothesis', 'assumption']);

export interface BlindBrief {
  question: string;                 // what the worker must answer — no incumbent material
  withheld_classes: string[];       // what was deliberately withheld (audit, not payload leak)
  references: string[];             // evidence entry ids the worker MAY see
}

/**
 * Build a blind brief for an uncertainty entry. Only the uncertainty itself
 * and its evidence references are visible; every incumbent entry type is
 * withheld and its content never enters the payload.
 */
export async function buildBlindBrief(db: Db, missionId: string, uncertaintyEntryId: string): Promise<BlindBrief> {
  const entry = await db
    .collection(COLLECTIONS.epistemicEntries)
    .findOne({ mission_id: missionId, entry_id: uncertaintyEntryId, entry_type: 'uncertainty' }, { projection: { _id: 0 } });
  if (!entry) throw new Error(`uncertainty entry not found: ${uncertaintyEntryId}`);

  const visible = (entry as any).evidence_for ?? [];
  const visibleEntries = await db
    .collection(COLLECTIONS.epistemicEntries)
    .find({ mission_id: missionId, entry_id: { $in: visible } }, { projection: { _id: 0, entry_id: 1, entry_type: 1, statement: 1 } })
    .toArray() as unknown as Array<{ entry_id: string; entry_type: EntryType; statement: string }>;

  const safe = visibleEntries.filter(e => !FORBIDDEN_ENTRY_TYPES.has(e.entry_type));
  return {
    question: `Independently resolve: ${(entry as any).statement}`,
    withheld_classes: [...FORBIDDEN_ENTRY_TYPES],
    references: safe.map(e => e.entry_id),
  };
}

export async function createBlindWorkItem(
  db: Db,
  missionId: string,
  uncertaintyEntryId: string,
  brief?: BlindBrief,
): Promise<CognitiveWorkItem> {
  const b = brief ?? (await buildBlindBrief(db, missionId, uncertaintyEntryId));
  const now = new Date().toISOString();
  const item: CognitiveWorkItem = {
    schema_version: '1.0',
    work_item_id: randomUUID(),
    mission_id: missionId,
    // The payload is ONLY the question + evidence refs. No incumbent content.
    description: `${b.question} (evidence refs: ${b.references.join(', ') || 'none provided'})`,
    mode: 'explore',
    status: 'queued',
    authority_class: 'B',
    trigger: 'active_uncertainty',
    features: {
      mission_impact: 1,
      uncertainty: 1,
      information_value: 1,
      dependency_centrality: 0,
      urgency: 1,
      cognitive_cost: 1,
      cost_basis: 'measured-tokens-zero-observed',
    },
    created_at: now,
    updated_at: now,
  };
  await db.collection(COLLECTIONS.cognitiveWorkItems).insertOne({
    ...item,
    independence_requirement: 'blind_parallel',
    withheld_classes: b.withheld_classes,
  } as any);
  return item;
}

/**
 * Privacy/contamination assertion used by tests and the tool path: the
 * serialized payload must not contain any forbidden string. Deterministic.
 */
export function assertBlindPayloadClean(payload: string, forbiddenStrings: string[]): void {
  for (const s of forbiddenStrings) {
    if (s && payload.includes(s)) {
      throw new Error(`blind payload leak: forbidden material present (${s.slice(0, 60)}…)`);
    }
  }
}
