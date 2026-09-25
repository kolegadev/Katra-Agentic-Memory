/**
 * Candidate selection for vector search (2026-09-25).
 *
 * vector_search used to build its candidate pool as
 * `find({...scope, embedding: {$exists: true}}).limit(50)` with NO sort, so
 * MongoDB returned storage order and the tool scored the same ~50 documents
 * for every query. Measured live on 2026-09-25: the 50 candidates came from a
 * four-day window (2026-07-15 → 07-19) out of 45,441 embedded facts in scope,
 * 0 of them newer than seven days — so no query could ever surface recent
 * work, and unrelated queries returned near-identical results.
 *
 * The pool is now the union of two tiers:
 *   * RECENT  — the newest documents in scope (keeps the search current), and
 *   * LEXICAL — documents matching the query text (keeps it topical).
 * The union is ranked afterwards by cosine similarity + recency, exactly as
 * before, so the fix changes what is *considered*, not how it is scored.
 * Sizes are bounded and env-tunable; the recency tier alone is a valid pool
 * when no text index is available.
 */

export interface CandidateQuery {
  sort(spec: Record<string, 1 | -1>): { limit(n: number): { toArray(): Promise<any[]> } };
  limit(n: number): { toArray(): Promise<any[]> };
}

export interface CandidateCollection {
  find(filter: Record<string, unknown>): CandidateQuery;
}

export interface CandidateOptions {
  recentLimit?: number;
  lexicalLimit?: number;
  /** Override for tests; defaults to process.env.KATRA_VECTOR_POOL_RECENT || 1500 */
  env?: (name: string) => string | undefined;
}

const DEFAULT_RECENT = 1500;
const DEFAULT_LEXICAL = 500;

function envInt(env: (name: string) => string | undefined, name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export async function selectVectorCandidates(
  collection: CandidateCollection,
  filter: Record<string, unknown>,
  query: string,
  options: CandidateOptions = {},
): Promise<any[]> {
  const env = options.env ?? ((name: string) => process.env[name]);
  const recentLimit = options.recentLimit ?? envInt(env, 'KATRA_VECTOR_POOL_RECENT', DEFAULT_RECENT);
  const lexicalLimit = options.lexicalLimit ?? envInt(env, 'KATRA_VECTOR_POOL_LEXICAL', DEFAULT_LEXICAL);

  const base = { ...filter, embedding: { $exists: true } };
  const byId = new Map<string, any>();

  const recent = await collection.find(base).sort({ created_at: -1 }).limit(recentLimit).toArray();
  for (const doc of recent) byId.set(String(doc._id), doc);

  if (lexicalLimit > 0 && query.trim()) {
    try {
      const lexical = await collection
        .find({ ...base, $text: { $search: query } })
        .limit(lexicalLimit)
        .toArray();
      for (const doc of lexical) byId.set(String(doc._id), doc);
    } catch {
      // No usable text index (or an unparseable search string): the recency
      // tier is still a correct pool, just without the topical tier.
    }
  }

  return [...byId.values()];
}
