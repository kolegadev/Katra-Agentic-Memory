/**
 * Shared vector ranking for every search path (2026-09-25).
 *
 * Two things live here so `vector_search`, `search_memories` and the admin
 * `searchSimilar` cannot drift apart again:
 *
 * 1. CHUNK-AWARE SIMILARITY. A long document is stored as a pooled vector
 *    plus per-window vectors in `fact_windows`. Scoring takes the BEST of the
 *    pooled vector and the windows, so a match living in one window of a
 *    10,000-char document is no longer diluted to nothing by the other ten
 *    windows (measured: the document's own tail sentence scores 0.104 pooled
 *    vs 0.221 at the best window). Documents without windows behave exactly
 *    as before.
 *
 * 2. SIMILARITY-FIRST RECENCY. The old blend was `cosine*0.6 + decay*0.4`, an
 *    ADDITIVE term: a recent document with almost no relevance (cosine 0.10)
 *    scored 0.46 and beat an older document that genuinely matched (cosine
 *    0.221 → 0.133). Recency is now a MODIFIER on similarity, bounded below by
 *    `RECENCY_FLOOR`, so age can discount a match but never manufacture one:
 *
 *        score = cosine * (RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decay)
 *
 *    An undated document gets no recency credit (decay 0) rather than a NaN.
 */

/** Share of a document's similarity that age can never take away. */
export const RECENCY_FLOOR = 0.6;

/** Below this raw cosine a vector hit is noise, not a weak match. */
export const MIN_VECTOR_COSINE = 0.3;

const DECAY_HALF_LIFE_DAYS = 10; // parity with EmbeddingService.timeDecayScore

/** Recency in [0,1]: 1.0 today, 0.5 at ~7 days, 0.1 at ~30 days, 0 if undated. */
export function timeDecay(timestamp: Date | string | null | undefined): number {
  if (!timestamp) return 0;
  const ms = new Date(timestamp).getTime();
  if (!Number.isFinite(ms)) return 0;
  const days = (Date.now() - ms) / (1000 * 60 * 60 * 24);
  return Math.exp(-days / DECAY_HALF_LIFE_DAYS);
}

/**
 * Similarity-first score. `cosine` should be the best available similarity for
 * the document (see bestCosine).
 */
export function blendedScore(
  cosine: number,
  timestamp: Date | string | null | undefined,
  recencyFloor: number = RECENCY_FLOOR,
): number {
  return cosine * (recencyFloor + (1 - recencyFloor) * timeDecay(timestamp));
}

/** Windows for one document, as stored in `fact_windows.windows`. */
export type WindowVectors = number[][];

/**
 * Highest similarity between the query and any representation of the document:
 * its pooled vector, or any of its window vectors.
 */
export function bestCosine(
  queryVec: number[],
  embedding: number[] | undefined | null,
  windows?: WindowVectors | null,
  dimension = queryVec.length,
): number {
  let best = 0;
  const usable = (vec: unknown): vec is number[] =>
    Array.isArray(vec) && vec.length === dimension;

  if (usable(embedding)) {
    best = cosine(queryVec, embedding);
  }
  if (Array.isArray(windows)) {
    for (const windowVec of windows) {
      if (!usable(windowVec)) continue;
      const score = cosine(queryVec, windowVec);
      if (score > best) best = score;
    }
  }
  return best;
}

/** Local cosine so this module stays dependency-free (and testable). */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
