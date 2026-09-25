// Phase 5 experiment registry (criteria 18-19): propose/list/resolve
// discriminating experiments; each records WHICH hypotheses it separates;
// a result contradicting accepted state opens a contradiction, never a
// silent overwrite. Persisted via the epistemic ledger (append-only).
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import { EpistemicLedgerService } from './epistemic-ledger-service.js';
import type { ExperimentRecord } from '../../types/cognitive-control.js';

export async function proposeExperiment(
  db: Db,
  missionId: string,
  authorId: string,
  statement: string,
  separatesHypotheses: string[],
): Promise<ExperimentRecord> {
  const ledger = new EpistemicLedgerService(db);
  const created = await ledger.appendEntry({
    schema_version: '1.0',
    mission_id: missionId,
    entry_type: 'experiment',
    statement,
    status: 'active',
    author_id: authorId,
    confidence: 0.5,
    depends_on: separatesHypotheses, // the hypotheses this experiment separates (criterion 18)
  });
  return { ...created, entry_type: 'experiment', depends_on: separatesHypotheses } as ExperimentRecord;
}

export async function listExperiments(db: Db, missionId: string): Promise<ExperimentRecord[]> {
  return db
    .collection(COLLECTIONS.epistemicEntries)
    .find({ mission_id: missionId, entry_type: 'experiment' }, { projection: { _id: 0 } })
    .toArray() as unknown as ExperimentRecord[];
}

export async function resolveExperiment(
  db: Db,
  missionId: string,
  experimentEntryId: string,
  actorId: string,
  outcome: { summary: string; supports_entry_id?: string; contradicts_entry_id?: string },
): Promise<ExperimentRecord> {
  const entry = await db
    .collection(COLLECTIONS.epistemicEntries)
    .findOne({ mission_id: missionId, entry_id: experimentEntryId, entry_type: 'experiment' }, { projection: { _id: 0 } });
  if (!entry) throw new Error(`experiment not found: ${experimentEntryId}`);

  const now = new Date().toISOString();
  // Record the result on the experiment (append-only update of the ledger entry).
  await db.collection(COLLECTIONS.epistemicEntries).updateOne(
    { entry_id: experimentEntryId },
    {
      $set: {
        status: 'accepted',
        result: { outcome: outcome.summary.slice(0, 400), supports_entry_id: outcome.supports_entry_id, contradicts_entry_id: outcome.contradicts_entry_id, created_at: now },
        updated_at: now,
      },
    } as any,
  );

  // Criterion 19: a result contradicting accepted state opens a contradiction.
  if (outcome.contradicts_entry_id) {
    const ledger = new EpistemicLedgerService(db);
    await ledger.appendEntry({
      schema_version: '1.0',
      mission_id: missionId,
      entry_id: randomUUID(),
      entry_type: 'contradiction',
      statement: `Experiment ${experimentEntryId} produced a result contradicting ${outcome.contradicts_entry_id}: ${outcome.summary.slice(0, 300)}`,
      status: 'active',
      author_id: actorId,
      confidence: 0.9,
      depends_on: [experimentEntryId, outcome.contradicts_entry_id],
    });
  }

  const updated = await db
    .collection(COLLECTIONS.epistemicEntries)
    .findOne({ entry_id: experimentEntryId }, { projection: { _id: 0 } });
  return updated as unknown as ExperimentRecord;
}
