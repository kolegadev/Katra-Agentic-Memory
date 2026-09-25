// In-memory Mongo fake for unit tests (equality filters, $set/$push/$unset,
// chainable cursor with sort/limit/skip, unique indexes on contract keys).
import type { Db } from 'mongodb';

export type Doc = Record<string, any>;

export const UNIQUE_INDEXES: Record<string, string[][]> = {
  // `system_settings` carries a unique index on `key` in every deployment
  // (IndexManager: name `key_unique`), so an upsert that cannot match but
  // whose insert would duplicate a key must fail with E11000 here too —
  // otherwise a racing create looks like two successful inserts instead of
  // the conflict the real collection reports.
  system_settings: [['key']],
  mission_states: [['mission_id']],
  mission_state_versions: [['mission_id', 'version']],
  epistemic_entries: [['entry_id']],
  state_deltas: [['delta_id'], ['idempotency_key']],
  cognitive_batons: [['baton_id']],
  mission_events: [['event_id']],
  activation_ledger: [['ledger_id']],
  mission_opt_ins: [['opt_in_id']],
  allocation_counterfactuals: [['counterfactual_id'], ['decision_id']],
  custodian_audit: [['audit_id']],
  // ITER-4: belief + procedural rows are identity-scoped, so the unique keys
  // lead with user_id. `createIndex` enforces the same key here (below), which
  // is what makes "the multi-insert collapse path updates instead of
  // duplicating" and "the unique index cannot be built over duplicates"
  // observable in a unit test.
  agent_beliefs: [['user_id', 'entity_name', 'proposition']],
  procedural_patterns: [['user_id', 'tool_name', 'input_shape']],
  // ITER-5: the private salience trace and its run ledger. `trace_id` is the
  // trace's row identity; `idempotency_key` is what makes one run per
  // {missionId, cycleId} enforceable — a duplicate claim has to fail here the
  // way the real deployment's unique index fails it.
  salience_traces: [['trace_id']],
  focused_consolidation_runs: [['idempotency_key']],
  // ITER-6: the imagination engine's seeds, lineages, archive cells and run
  // ledger. `seed_id`/`lineage_id` are DERIVED (content + PRNG seed + mission),
  // so re-running the same cycle with the same seed is expected to collide
  // here — which is what makes "an idempotent replay writes nothing new"
  // observable. A cell is unique per identity + mission + descriptor tuple,
  // so a second seed in one cell must UPDATE it (never insert a duplicate row).
  idea_seeds: [['seed_id']],
  idea_lineages: [['lineage_id']],
  idea_archive_cells: [['user_id', 'mission_id', 'cell_key']],
  imagination_runs: [['idempotency_key']],
  // ITER-7: the Creative Baton, its promotion audit, the cycle run ledger, the
  // per-mission cycle state and the candidate-outcome rows. The ones that carry
  // the concurrency contract are here for the same reason the seeds are:
  // `{user_id, mission_id, cycle_id}` is what makes "two concurrent callers of
  // ONE mission start exactly one cycle — and two missions that share a version
  // and an ordinal never share a cycle" enforceable (the compound key mirrors
  // the claim lookup in the cycle service; a `cycle_id`-only key would collide
  // across missions and serve the second one the first one's row),
  // `{user_id, mission_id}` is what makes one cycle-state row per mission
  // enforceable, and `{user_id, seed_id, outcome}` is what makes "repeating an
  // outcome is recorded once" enforceable.
  creative_batons: [['baton_id']],
  creative_baton_promotions: [['promotion_id']],
  imagination_cycle_states: [['user_id', 'mission_id']],
  imagination_cycles: [['user_id', 'mission_id', 'cycle_id']],
  idea_candidate_outcomes: [['user_id', 'seed_id', 'outcome']],
  // ITER-8: the cognitive team's mode assignments, inheritance envelopes and
  // portfolios (allocation / first pass / synthesis share one collection and are
  // discriminated by `kind`). Each key is the DERIVED id the service writes, so
  // "a re-run of the same grant, allocation or synthesis writes nothing new —
  // and a concurrent loser reads the winner's row" is observable here the way
  // the real deployment's unique index makes it observable.
  thinking_mode_assignments: [['assignment_id']],
  inheritance_envelopes: [['envelope_id']],
  cognitive_portfolios: [['portfolio_id']],
};

export interface FakeIndex {
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  sparse?: boolean;
}

export class FakeCollection {
  docs: Doc[] = [];
  /** Indexes created through `createIndex`; listed by `indexes()` below. */
  createdIndexes: FakeIndex[] = [];
  constructor(private readonly name: string) {}

  async createIndex(keys: any, opts?: any) {
    const key: Record<string, 1 | -1> = typeof keys === 'object' && keys !== null ? { ...keys } : { [String(keys)]: 1 };
    const name: string = opts?.name ?? `idx_${this.name}_${this.createdIndexes.length + 1}`;
    // A unique index cannot be built over documents that already violate it:
    // MongoDB fails the build (E11000) and leaves the collection unindexed.
    if (opts?.unique) this.assertUniqueOn(Object.keys(key), name);
    const record: FakeIndex = { name, key, unique: !!opts?.unique, sparse: !!opts?.sparse };
    const existing = this.createdIndexes.findIndex((index) => index.name === name);
    if (existing >= 0) this.createdIndexes[existing] = record;
    else this.createdIndexes.push(record);
    return name;
  }

  /** `collection.indexes()` — the listing the migration reads to stay idempotent. */
  async indexes(): Promise<FakeIndex[]> {
    return this.createdIndexes.map((index) => ({ ...index, key: { ...index.key } }));
  }

  /**
   * `collection.dropIndex(name)` — how the migration replaces a same-named index
   * that turned out not to enforce the unique key. Throws like the driver does
   * (`IndexNotFound`) when the name is unknown.
   */
  async dropIndex(name: string) {
    const before = this.createdIndexes.length;
    this.createdIndexes = this.createdIndexes.filter((index) => index.name !== name);
    if (this.createdIndexes.length === before) {
      throw new Error(`index not found with name [${name}]`);
    }
    return { acknowledged: true };
  }

  /** Throws when two documents collide on `fields` (null/undefined opt out). */
  private assertUniqueOn(fields: string[], indexName: string) {
    const seen = new Map<string, Doc>();
    for (const doc of this.docs) {
      if (fields.some((f) => doc[f] === undefined || doc[f] === null)) continue;
      const key = JSON.stringify(fields.map((f) => doc[f]));
      const clash = seen.get(key);
      if (clash) {
        throw new Error(
          `E11000 duplicate key on ${this.name} ${fields.join('+')}` +
            (indexName ? ` (index ${indexName})` : ''),
        );
      }
      seen.set(key, doc);
    }
  }

  private assertUnique(doc: Doc) {
    for (const fields of UNIQUE_INDEXES[this.name] ?? []) {
      if (fields.every(f => doc[f] === undefined || doc[f] === null)) continue;
      const clash = this.docs.find(existing =>
        fields.every(f => existing[f] !== undefined && existing[f] === doc[f]));
      if (clash) throw new Error(`E11000 duplicate key on ${this.name} ${fields.join('+')}`);
    }
  }
  async insertOne(doc: Doc) { this.assertUnique(doc); this.docs.push(structuredClone(doc)); return { acknowledged: true, insertedId: doc._id ?? 'x' }; }
  private matches(doc: Doc, filter: Record<string, any>): boolean {
    const at = (path: string): any => {
      let cur: any = doc;
      for (const part of path.split('.')) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
        cur = cur[part];
      }
      return cur;
    };
    return Object.entries(filter).every(([k, v]) => {
      const docVal = k.includes('.') ? at(k) : doc[k];
      // `undefined` does NOT mean "no constraint". The real driver is built
      // without `ignoreUndefined`, so it defaults to false and serializes
      // `undefined` to BSON null; `{ field: undefined }` therefore queries for
      // null-or-missing and matches nothing when the field is populated.
      //
      // This helper used to `return true` for undefined/null, with the comment
      // "mongo omits undefined keys". That was wrong, and it made the suite
      // blind to exactly the bug it should have caught: query_epistemic_ledger
      // passed `{ entry_type: undefined, status: undefined }` on every
      // unfiltered call, so the live tool returned "No ledger entries match."
      // against a populated ledger while this fake kept the test green.
      const needle = v === undefined ? null : v;
      if (needle === null) return docVal === null || docVal === undefined;
      if (typeof needle === 'object' && !Array.isArray(needle) && ('$lte' in needle || '$gte' in needle || '$lt' in needle || '$in' in needle || '$ne' in needle || '$exists' in needle)) {
        if ('$exists' in needle) return needle.$exists ? docVal !== undefined : docVal === undefined;
        if ('$ne' in needle) return docVal !== needle.$ne;
        if ('$in' in needle) return Array.isArray(needle.$in) && needle.$in.includes(docVal);
        if ('$lte' in needle && !(docVal <= needle.$lte)) return false;
        if ('$gte' in needle && !(docVal >= needle.$gte)) return false;
        if ('$lt' in needle && !(docVal < needle.$lt)) return false;
        return true;
      }
      return docVal === needle;
    });
  }
  private project(doc: Doc, projection?: Record<string, 0 | 1>): Doc {
    if (!projection) return doc;
    const out: Doc = {};
    const hasInclusion = Object.values(projection).includes(1);
    for (const [k, val] of Object.entries(doc)) {
      if (projection[k] === 0) continue;
      if (hasInclusion && projection[k] !== 1) continue;
      out[k] = val;
    }
    return out;
  }
  async findOne(filter: Record<string, any>, opts?: any): Promise<Doc | null> {
    let candidates = this.docs.filter(d => this.matches(d, filter));
    if (opts?.sort) {
      for (const [k, dir] of Object.entries(opts.sort as Record<string, 1 | -1>)) {
        candidates = [...candidates].sort((a, b) => {
          const av = a[k] ?? 0, bv = b[k] ?? 0;
          const cmp = typeof av === 'string' || typeof bv === 'string'
            ? String(av).localeCompare(String(bv))
            : av - bv;
          return dir === 1 ? cmp : -cmp;
        });
      }
    }
    if (opts?.skip) candidates = candidates.slice(opts.skip);
    const doc = candidates[0];
    return doc ? this.project(doc, opts?.projection) : null;
  }
  find(filter: Record<string, any>, opts?: any): any {
    let candidates = this.docs.filter(d => this.matches(d, filter));
    const sortDocs = (s: Record<string, 1 | -1>) => {
      for (const [k, dir] of Object.entries(s)) {
        candidates = [...candidates].sort((a, b) => {
          const av = a[k] ?? 0, bv = b[k] ?? 0;
          const cmp = typeof av === 'string' || typeof bv === 'string'
            ? String(av).localeCompare(String(bv))
            : av - bv;
          return dir === 1 ? cmp : -cmp;
        });
      }
      return cursor;
    };
    const cursor: any = {
      sort: sortDocs,
      limit: (n: number) => { candidates = candidates.slice(0, n); return cursor; },
      skip: (n: number) => { candidates = candidates.slice(n); return cursor; },
      toArray: async () => structuredClone(candidates.map(d => this.project(d, opts?.projection))),
    };
    if (opts?.sort) cursor.sort(opts.sort);
    if (opts?.skip) cursor.skip(opts.skip);
    if (opts?.limit) cursor.limit(opts.limit);
    return cursor;
  }
  async updateOne(filter: Record<string, any>, update: Record<string, any>, opts?: any) {
    let doc = this.docs.find(d => this.matches(d, filter));
    if (!doc && opts?.upsert) {
      doc = {};
      for (const [k, v] of Object.entries(filter)) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) continue; // operators do not become fields
        doc[k] = structuredClone(v);
      }
      Object.assign(doc, structuredClone(update.$set ?? {}));
      this.assertUnique(doc);
      this.docs.push(doc);
      return { acknowledged: true, matchedCount: 0, upsertedId: doc._id ?? 'x' };
    }
    if (!doc) return { acknowledged: true, matchedCount: 0 };
    for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = structuredClone(v);
    for (const [k, v] of Object.entries(update.$push ?? {})) (doc[k] ??= []).push(structuredClone(v));
    for (const [k, v] of Object.entries(update.$unset ?? {})) delete doc[k];
    return { acknowledged: true, matchedCount: 1 };
  }
  async updateMany(filter: Record<string, any>, update: Record<string, any>) {
    const hits = this.docs.filter(d => this.matches(d, filter));
    for (const doc of hits) {
      for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = structuredClone(v);
    }
    return { acknowledged: true, matchedCount: hits.length };
  }
  async deleteMany(filter: Record<string, any>) {
    const before = this.docs.length;
    this.docs = this.docs.filter(d => !this.matches(d, filter));
    return { acknowledged: true, deletedCount: before - this.docs.length };
  }
  async deleteOne(filter: Record<string, any>) {
    const index = this.docs.findIndex(d => this.matches(d, filter));
    if (index < 0) return { acknowledged: true, deletedCount: 0 };
    this.docs.splice(index, 1);
    return { acknowledged: true, deletedCount: 1 };
  }
  async countDocuments(filter: Record<string, any> = {}) {
    return this.docs.filter(d => this.matches(d, filter)).length;
  }
}

export class FakeDb {
  collections = new Map<string, FakeCollection>();
  collection(name: string): FakeCollection {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(name));
    return this.collections.get(name)!;
  }
  reset() { this.collections.clear(); }
  asDb(): Db { return this as unknown as Db; }
}
