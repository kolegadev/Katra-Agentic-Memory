// In-memory Mongo fake for unit tests (equality filters, $set/$push/$unset,
// chainable cursor with sort/limit/skip, unique indexes on contract keys).
import type { Db } from 'mongodb';

export type Doc = Record<string, any>;

export const UNIQUE_INDEXES: Record<string, string[][]> = {
  mission_states: [['mission_id']],
  mission_state_versions: [['mission_id', 'version']],
  epistemic_entries: [['entry_id']],
  state_deltas: [['delta_id'], ['idempotency_key']],
  cognitive_batons: [['baton_id']],
  mission_events: [['event_id']],
};

export class FakeCollection {
  docs: Doc[] = [];
  constructor(private readonly name: string) {}
  async createIndex(_keys: any, _opts?: any) { return `idx_${this.name}_${Math.random()}`; }
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
    return Object.entries(filter).every(([k, v]) => {
      if (v === undefined || v === null) return true; // mongo omits undefined keys
      if (typeof v === 'object' && !Array.isArray(v) && ('$lte' in v || '$gte' in v || '$lt' in v || '$in' in v || '$ne' in v)) {
        if ('$ne' in v) return doc[k] !== v.$ne;
        if ('$in' in v) return Array.isArray(v.$in) && v.$in.includes(doc[k]);
        if ('$lte' in v && !(doc[k] <= v.$lte)) return false;
        if ('$gte' in v && !(doc[k] >= v.$gte)) return false;
        if ('$lt' in v && !(doc[k] < v.$lt)) return false;
        return true;
      }
      return doc[k] === v;
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
        candidates = [...candidates].sort((a, b) => (dir === 1 ? (a[k] ?? 0) - (b[k] ?? 0) : (b[k] ?? 0) - (a[k] ?? 0)));
      }
    }
    if (opts?.skip) candidates = candidates.slice(opts.skip);
    const doc = candidates[0];
    return doc ? this.project(doc, opts?.projection) : null;
  }
  find(filter: Record<string, any>, opts?: any): any {
    let candidates = this.docs.filter(d => this.matches(d, filter));
    const cursor: any = {
      sort: (s: Record<string, 1 | -1>) => {
        for (const [k, dir] of Object.entries(s)) {
          candidates = [...candidates].sort((a, b) => (dir === 1 ? (a[k] ?? 0) - (b[k] ?? 0) : (b[k] ?? 0) - (a[k] ?? 0)));
        }
        return cursor;
      },
      limit: (n: number) => { candidates = candidates.slice(0, n); return cursor; },
      skip: (n: number) => { candidates = candidates.slice(n); return cursor; },
      toArray: async () => structuredClone(candidates.map(d => this.project(d, opts?.projection))),
    };
    if (opts?.sort) cursor.sort(opts.sort);
    if (opts?.skip) cursor.skip(opts.skip);
    if (opts?.limit) cursor.limit(opts.limit);
    return cursor;
  }
  async updateOne(filter: Record<string, any>, update: Record<string, any>) {
    const doc = this.docs.find(d => this.matches(d, filter));
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
