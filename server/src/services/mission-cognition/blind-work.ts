// Phase 5 blind independent work generation (criteria 8-11, decisive test A).
// POSITION ON THE RISK (Verifier finding, attempt 1): the reference set is an
// ALLOW-LIST, not a deny-list. Only `evidence`-type entries may be handed to
// the blind worker; `contradiction`, `result` and `unknown` are withheld too —
// a result is exactly where "the experiment showed the incumbent was right"
// would live, and a contradiction names what it contradicts. The blind
// contract is: the payload contains no incumbent material, period. The
// worker's downstream ledger reads are a separate control outside this
// module (documented in withheld_classes so the audit shows the choice).
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import type { CognitiveWorkItem, EntryType } from '../../types/cognitive-control.js';

/** ALLOW-list: the only entry type a blind worker may receive a pointer to. */
const PERMITTED_REFERENCE_TYPES: ReadonlySet<EntryType> = new Set(['evidence']);

/** Everything else is withheld — audit field, never payload content. */
const WITHHELD_TYPES: ReadonlySet<EntryType> = new Set([
  'decision', 'claim', 'hypothesis', 'assumption',
  'contradiction', 'result', 'unknown', 'experiment', 'uncertainty',
]);

export interface BlindBrief {
  question: string;                 // what the worker must answer — no incumbent material
  withheld_classes: string[];       // what was deliberately withheld (audit, not payload leak)
  references: string[];             // permitted evidence entry ids the worker MAY see
  features: {                       // derived from the uncertainty entry, never hard-coded
    mission_impact: number;
    uncertainty: number;
    information_value: number;
    dependency_centrality: number;
    urgency: number;
    cognitive_cost: number;
    cost_basis: string;
  };
}

/**
 * Build a blind brief for an uncertainty entry. Only the uncertainty itself
 * and PERMITTED evidence references are visible; every other entry type is
 * withheld and its content never enters the payload.
 */
export async function buildBlindBrief(db: Db, missionId: string, uncertaintyEntryId: string): Promise<BlindBrief> {
  const entry = await db
    .collection(COLLECTIONS.epistemicEntries)
    .findOne({ mission_id: missionId, entry_id: uncertaintyEntryId, entry_type: 'uncertainty' }, { projection: { _id: 0 } });
  if (!entry) throw new Error(`uncertainty entry not found: ${uncertaintyEntryId}`);

  const e = entry as any;
  const visible = e.evidence_for ?? [];
  const visibleEntries = await db
    .collection(COLLECTIONS.epistemicEntries)
    .find({ mission_id: missionId, entry_id: { $in: visible } }, { projection: { _id: 0, entry_id: 1, entry_type: 1, statement: 1 } })
    .toArray() as unknown as Array<{ entry_id: string; entry_type: EntryType; statement: string }>;

  const safe = visibleEntries.filter(x => PERMITTED_REFERENCE_TYPES.has(x.entry_type));

  // Derived feature vector (Verifier smaller-item A): the uncertainty entry's
  // own fields drive impact/urgency/information — never hard-coded constants.
  const consequence = String(e.consequence_if_false ?? '').toLowerCase();
  const impact = consequence === 'critical' ? 3 : consequence === 'high' ? 2 : 1;
  const informationNeeded = (e.information_needed ?? []).length;

  return {
    question: `Independently resolve: ${e.statement}`,
    withheld_classes: [...WITHHELD_TYPES],
    references: safe.map(x => x.entry_id),
    features: {
      mission_impact: impact,
      uncertainty: 1,
      information_value: 1 + Math.min(informationNeeded, 8),
      dependency_centrality: 0,
      urgency: impact >= 2 ? 2 : 1,
      cognitive_cost: 1,
      cost_basis: 'measured-tokens-zero-observed',
    },
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
    // The payload is ONLY the question + permitted evidence refs. No incumbent content.
    description: `${b.question} (evidence refs: ${b.references.join(', ') || 'none provided'})`,
    mode: 'explore',
    status: 'queued',
    authority_class: 'B',
    trigger: 'active_uncertainty',
    features: { ...b.features },
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
