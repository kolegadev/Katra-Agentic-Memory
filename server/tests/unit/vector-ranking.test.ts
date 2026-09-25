/**
 * Unit tests: shared vector ranking (2026-09-25).
 *
 * Guards the two behaviours every search path now shares:
 *   * chunk-aware similarity — the best window of a long document competes
 *     with its pooled vector (a tail match used to be diluted to nothing);
 *   * similarity-first recency — age discounts a match but cannot manufacture
 *     one from an irrelevant document.
 */
import { describe, it, expect } from 'vitest';
import {
  bestCosine,
  blendedScore,
  timeDecay,
  RECENCY_FLOOR,
  MIN_VECTOR_COSINE,
} from '../../src/services/memory/vector-ranking.js';
import { EmbeddingService } from '../../src/services/infrastructure/embedding-service.js';

/** Unit vector of dimension `dim` with 1.0 at `axis`. */
function basis(dim: number, axis: number): number[] {
  return Array.from({ length: dim }, (_, i) => (i === axis ? 1 : 0));
}

describe('timeDecay', () => {
  it('is 1 today, ~0.5 at a week, and 0 when undated', () => {
    expect(timeDecay(new Date())).toBeCloseTo(1, 2);
    expect(timeDecay(new Date(Date.now() - 7 * 86400_000))).toBeCloseTo(0.5, 1);
    expect(timeDecay(null)).toBe(0);
    expect(timeDecay(undefined)).toBe(0);
    expect(timeDecay('not a date')).toBe(0);
  });

  it('matches the embedding service decay (no drift between the two)', () => {
    const service = EmbeddingService.get_instance();
    const ts = new Date(Date.now() - 3 * 86400_000);
    expect(timeDecay(ts)).toBeCloseTo(service.timeDecayScore(ts), 6);
  });
});

describe('blendedScore', () => {
  const now = new Date();

  it('keeps a floor of the similarity for old documents', () => {
    const old = new Date(Date.now() - 400 * 86400_000);
    expect(blendedScore(0.5, old)).toBeCloseTo(0.5 * RECENCY_FLOOR, 5);
  });

  it('does not let a recency term outrank a genuinely matching old document', () => {
    const recent = new Date();
    const old = new Date(Date.now() - 200 * 86400_000);
    const irrelevantButRecent = blendedScore(0.1, recent); // weak match, fresh
    const matchingButOld = blendedScore(0.221, old); // the tail sentence case
    expect(matchingButOld).toBeGreaterThan(irrelevantButRecent);
  });

  it('still prefers the fresher of two equally relevant documents', () => {
    const fresh = blendedScore(0.5, new Date());
    const stale = blendedScore(0.5, new Date(Date.now() - 60 * 86400_000));
    expect(fresh).toBeGreaterThan(stale);
  });

  it('gives undated documents no recency credit instead of NaN', () => {
    expect(blendedScore(0.5, null)).toBeCloseTo(0.5 * RECENCY_FLOOR, 5);
    expect(Number.isNaN(blendedScore(0.5, undefined))).toBe(false);
  });
});

describe('bestCosine', () => {
  const dim = 8;
  const query = basis(dim, 0);

  it('uses the pooled vector when there are no windows', () => {
    expect(bestCosine(query, basis(dim, 0), undefined, dim)).toBeCloseTo(1, 6);
  });

  it('lets the best window win over a diluted pooled vector', () => {
    // Pooled vector points away from the query (mean of 11 windows); one
    // window points straight at it — exactly the long-document case.
    const pooled = basis(dim, 1);
    const windows = [basis(dim, 1), basis(dim, 0), basis(dim, 1)];
    expect(bestCosine(query, pooled, windows, dim)).toBeCloseTo(1, 6);
  });

  it('ignores windows of the wrong dimension instead of throwing', () => {
    const windows = [[0, 1], basis(dim, 0)];
    expect(() => bestCosine(query, undefined, windows as number[][], dim)).not.toThrow();
    expect(bestCosine(query, undefined, windows as number[][], dim)).toBeCloseTo(1, 6);
  });

  it('returns 0 for a document with no usable vector at all', () => {
    expect(bestCosine(query, undefined, null, dim)).toBe(0);
    expect(bestCosine(query, [], [], dim)).toBe(0);
  });

  it('exposes the noise floor the search paths apply to raw cosine', () => {
    expect(MIN_VECTOR_COSINE).toBeGreaterThan(0);
    expect(MIN_VECTOR_COSINE).toBeLessThan(1);
  });
});
