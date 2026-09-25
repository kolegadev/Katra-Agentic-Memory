/**
 * In-process semantic candidate index (2026-09-25).
 *
 * WHY THIS EXISTS. The candidate pool was recency + keyword. Both are blind to
 * a document that is neither recent nor a lexical match but IS the best
 * semantic match — measured live: a query built from a document's own tail
 * sentence could not retrieve that document at all, because it never entered
 * the pool. Scoring it correctly (see vector-ranking.ts) is useless if it is
 * never scored.
 *
 * HOW. A flat, quantised, in-process index over the caller's scope. The full
 * scoped corpus is scanned per query in plain JS — 45k documents x 384 dims is
 * ~17M int8 multiply-adds, tens of milliseconds, no database round trip — and
 * the top K ids are handed back as a third candidate tier. Everything is:
 *
 *   * QUANTISED to int8 (unit vectors scaled by 127): 384 bytes per document
 *     instead of ~3 KB of BSON doubles, so a 45k scope costs ~17 MB of RAM
 *     rather than 140 MB;
 *   * SCOPE-KEYED, so identities never see each other's candidates (the scope
 *     filter is the key, not a re-implementation of the scope rules);
 *   * LAZY + TTL'd: the first query for a scope starts an async build and
 *     returns nothing for that tier (recency + keyword still serve it), and
 *     the index refreshes in the background every TTL. A stale index is
 *     always usable — it is a candidate source, not the ranking;
 *   * CAPPED: at most MAX_INDEX_DOCS documents per scope and MAX_INDEXES
 *     scopes resident, so a huge corpus degrades coverage instead of memory.
 *
 * Approximate cosine is only used to pick candidates; the real scoring
 * (pooled + window vectors, similarity-first recency) happens afterwards on
 * the full documents.
 */

export interface QuantisedEntry {
  id: any;
  vec: Int8Array;
}

export interface SemanticHit {
  id: any;
  cosine: number;
}

/** Documents per scope. 60k x 384 B ≈ 23 MB. */
export const MAX_INDEX_DOCS = 60_000;
/** Scopes kept resident; the least recently used is dropped. */
export const MAX_INDEXES = 3;
/** Rebuild interval — a stale index still serves candidates. */
export const INDEX_TTL_MS = 10 * 60 * 1000;
const QUANT_SCALE = 127;

interface IndexState {
  entries: QuantisedEntry[];
  builtAt: number;
  usedAt: number;
}

/** Quantise a unit vector to int8. */
export function quantise(vector: number[]): Int8Array {
  const out = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const scaled = Math.round(vector[i] * QUANT_SCALE);
    out[i] = Math.max(-127, Math.min(127, scaled));
  }
  return out;
}

/** Cosine approximation between an int8 query and an int8 document. */
export function quantisedDot(query: Int8Array, doc: Int8Array): number {
  let dot = 0;
  for (let i = 0; i < query.length; i++) dot += query[i] * doc[i];
  return dot / (QUANT_SCALE * QUANT_SCALE);
}

export class VectorIndexService {
  private static instance: VectorIndexService;
  private indexes = new Map<string, IndexState>();
  private building = new Set<string>();

  static get_instance(): VectorIndexService {
    if (!VectorIndexService.instance) {
      VectorIndexService.instance = new VectorIndexService();
    }
    return VectorIndexService.instance;
  }

  /** Drop every index (after a large write or backfill). */
  invalidate(): void {
    this.indexes.clear();
  }

  /** Test/diagnostic view of what is resident. */
  get resident(): Array<{ key: string; documents: number; ageMs: number }> {
    const now = Date.now();
    return [...this.indexes.entries()].map(([key, state]) => ({
      key,
      documents: state.entries.length,
      ageMs: now - state.builtAt,
    }));
  }

  /**
   * Top-k approximate matches for the scope described by `filter`.
   * Returns [] while the index is cold or building — callers keep their other
   * candidate tiers in that case.
   */
  async search(
    db: any,
    filter: Record<string, unknown>,
    queryVec: number[],
    k: number,
  ): Promise<SemanticHit[]> {
    const key = this.keyOf(filter);
    const state = this.indexes.get(key);
    const stale = !state || Date.now() - state.builtAt > INDEX_TTL_MS;

    if (stale) {
      // Fire-and-forget refresh; a stale index still answers.
      void this.build(db, filter, key);
    }
    if (!state || state.entries.length === 0) return [];

    state.usedAt = Date.now();
    return this.scan(state.entries, quantise(queryVec), k);
  }

  /** Rank a document set by quantised dot product (pure — unit tested). */
  scan(entries: QuantisedEntry[], query: Int8Array, k: number): SemanticHit[] {
    const scored: SemanticHit[] = [];
    for (const entry of entries) {
      if (entry.vec.length !== query.length) continue;
      scored.push({ id: entry.id, cosine: quantisedDot(query, entry.vec) });
    }
    scored.sort((a, b) => b.cosine - a.cosine);
    return scored.slice(0, k);
  }

  private keyOf(filter: Record<string, unknown>): string {
    try {
      return JSON.stringify(filter);
    } catch {
      return 'scope';
    }
  }

  private async build(db: any, filter: Record<string, unknown>, key: string): Promise<void> {
    if (this.building.has(key)) return;
    this.building.add(key);
    try {
      const cursor = db
        .collection('semantic_facts')
        .find(
          { ...filter, embedding: { $exists: true } },
          { projection: { _id: 1, embedding: 1 } },
        )
        .sort({ created_at: -1 })
        .limit(MAX_INDEX_DOCS);

      const entries: QuantisedEntry[] = [];
      for await (const doc of cursor) {
        const embedding = doc.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) continue;
        entries.push({ id: doc._id, vec: quantise(embedding) });
      }

      this.indexes.set(key, { entries, builtAt: Date.now(), usedAt: Date.now() });
      this.evictIfNeeded();
      console.log(`🧭 Vector index built for scope (${entries.length} documents)`);
    } catch (error: any) {
      console.warn('⚠️ Vector index build failed:', error?.message || error);
    } finally {
      this.building.delete(key);
    }
  }

  private evictIfNeeded(): void {
    while (this.indexes.size > MAX_INDEXES) {
      let oldestKey: string | null = null;
      let oldestUsed = Infinity;
      for (const [key, state] of this.indexes) {
        if (state.usedAt < oldestUsed) {
          oldestUsed = state.usedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      this.indexes.delete(oldestKey);
    }
  }
}

export const vectorIndexService = VectorIndexService.get_instance();
