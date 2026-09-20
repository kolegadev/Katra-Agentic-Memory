// Epistemic Ledger service (Phase 1) — append-oriented, provenance-preserving
// claims/evidence/assumptions/… with immutable confidence history.
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import { SCHEMA_IDS, validateAgainst } from './schema-registry.js';
import { emitMissionEvent } from './event-rail.js';
import type {
  ConfidenceChange,
  EntryType,
  EntryStatus,
  LedgerEntry,
  LedgerEntryDraft,
} from '../../types/cognitive-control.js';

export class EpistemicLedgerService {
  constructor(private readonly db: Db) {}

  private collection() {
    return this.db.collection<LedgerEntry & { _id?: unknown }>(COLLECTIONS.epistemicEntries);
  }

  /** Append a new ledger entry. Never overwrites: supersession links, never edits. */
  async appendEntry(
    draft: LedgerEntryDraft,
    opts: { actorId?: string } = {},
  ): Promise<LedgerEntry> {
    const entryId = draft.entry_id ?? randomUUID();
    const now = new Date().toISOString();
    const entry: LedgerEntry = {
      ...draft,
      entry_id: entryId,
      author_id: opts.actorId ?? draft.author_id,
      created_at: draft.created_at ?? now,
      updated_at: draft.updated_at ?? now,
      confidence_history: [],
    };
    const check = validateAgainst(SCHEMA_IDS.epistemicEntry, entry);
    if (!check.valid) {
      throw new Error(`ledger entry invalid: ${check.errors.join('; ')}`);
    }
    await this.collection().insertOne(entry);
    await emitMissionEvent(this.db, {
      mission_id: entry.mission_id,
      event_type: 'ledger.entry.created',
      entry_id: entry.entry_id,
      summary: `${entry.entry_type}: ${entry.statement.slice(0, 120)}`,
    });
    return entry;
  }

  async getEntry(entryId: string): Promise<LedgerEntry | null> {
    return this.collection().findOne({ entry_id: entryId }, { projection: { _id: 0 } });
  }

  async listEntries(
    missionId: string,
    filter: { entry_type?: EntryType; status?: EntryStatus } = {},
    limit = 50,
  ): Promise<LedgerEntry[]> {
    // Drop keys whose value is undefined before building the query. The driver
    // here is constructed without `ignoreUndefined`, so it defaults to false and
    // serializes `undefined` to BSON null rather than omitting it. A filter of
    // `{ entry_type: undefined }` therefore becomes `{ entry_type: null }`, which
    // matches only documents whose entry_type is null or absent -- i.e. nothing.
    // Callers pass the optional fields straight through, so leaving this
    // unguarded makes listEntries(id) return [] against a populated collection.
    const present = Object.fromEntries(
      Object.entries(filter).filter(([, v]) => v !== undefined),
    );
    const query: Record<string, unknown> = { mission_id: missionId, ...present };
    return this.collection()
      .find(query, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
  }

  /** Confidence is history, never overwritten (invariant #8). */
  async updateConfidence(
    entryId: string,
    next: number,
    reason: string,
    actorId: string,
  ): Promise<LedgerEntry | null> {
    const entry = await this.getEntry(entryId);
    if (!entry) return null;
    if (next < 0 || next > 1) throw new Error('confidence out of range [0,1]');
    const change: ConfidenceChange = {
      prior: entry.confidence,
      next,
      reason,
      actor_id: actorId,
      at: new Date().toISOString(),
    };
    await this.collection().updateOne(
      { entry_id: entryId },
      {
        $set: { confidence: next, updated_at: change.at },
        $push: { confidence_history: change },
      },
    );
    return this.getEntry(entryId);
  }

  /** Supersession: the old entry keeps its content; the new one links `supersedes`. */
  async supersede(oldEntryId: string, newEntry: LedgerEntryDraft): Promise<LedgerEntry> {
    const old = await this.getEntry(oldEntryId);
    if (!old) throw new Error(`supersede target not found: ${oldEntryId}`);
    const created = await this.appendEntry({ ...newEntry, supersedes: oldEntryId });
    await this.collection().updateOne(
      { entry_id: oldEntryId },
      { $set: { status: 'superseded' as EntryStatus, updated_at: new Date().toISOString() } },
    );
    await emitMissionEvent(this.db, {
      mission_id: created.mission_id,
      event_type: 'ledger.entry.superseded',
      entry_id: created.entry_id,
      summary: `superseded ${oldEntryId} -> ${created.entry_id}`,
    });
    return created;
  }

  /** Traverse dependency edges (depends_on/evidence_for) with cycle detection. */
  async dependencyClosure(entryId: string, maxDepth = 6): Promise<{ entry_ids: string[]; cycle: boolean }> {
    const state = new Map<string, 'visiting' | 'done'>();
    const order: string[] = [];
    let cycle = false;
    const visit = async (id: string, depth: number): Promise<void> => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'visiting') { cycle = true; return; } // back-edge
      if (depth > maxDepth) { cycle = true; return; }
      state.set(id, 'visiting');
      order.push(id);
      const e = await this.getEntry(id);
      if (e) {
        for (const dep of [...(e.depends_on ?? []), ...(e.evidence_for ?? [])]) {
          await visit(dep, depth + 1);
        }
      }
      state.set(id, 'done');
    };
    await visit(entryId, 0);
    return { entry_ids: order, cycle };
  }
}
