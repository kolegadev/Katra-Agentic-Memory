/**
 * Unit tests: in-process semantic candidate index (2026-09-25).
 *
 * The index is a candidate SOURCE: it must rank approximately, respect scope
 * keys, degrade to "no candidates" while cold, and never grow without bound.
 */
import { describe, it, expect } from 'vitest';
import {
  quantise,
  quantisedDot,
  VectorIndexService,
  MAX_INDEXES,
  type QuantisedEntry,
} from '../../src/services/memory/vector-index-service.js';

const dim = 384;

function unit(axis: number): number[] {
  return Array.from({ length: dim }, (_, i) => (i === axis ? 1 : 0));
}

function mix(a: number, b: number, weight: number): number[] {
  const v = new Array(dim).fill(0);
  v[a] = Math.sqrt(1 - weight * weight);
  v[b] = weight;
  return v;
}

describe('quantisation', () => {
  it('round-trips a unit vector closely enough for candidate selection', () => {
    const vector = unit(7);
    const q = quantise(vector);
    expect(q.length).toBe(dim);
    expect(quantisedDot(q, q)).toBeCloseTo(1, 2);
  });

  it('keeps relative order: closer vectors score higher', () => {
    const query = quantise(unit(0));
    const near = quantise(mix(0, 1, 0.1));
    const far = quantise(mix(0, 1, 0.9));
    expect(quantisedDot(query, near)).toBeGreaterThan(quantisedDot(query, far));
  });

  it('clamps out-of-range components instead of overflowing int8', () => {
    const q = quantise([2, -2, 0.5]);
    expect(Array.from(q)).toEqual([127, -127, 64]);
  });
});

describe('scan', () => {
  const service = VectorIndexService.get_instance();

  it('returns the k closest documents, best first', () => {
    const entries: QuantisedEntry[] = [
      { id: 'exact', vec: quantise(unit(0)) },
      { id: 'near', vec: quantise(mix(0, 1, 0.1)) },
      { id: 'far', vec: quantise(unit(50)) },
    ];
    const hits = service.scan(entries, quantise(unit(0)), 2);
    expect(hits.map(h => h.id)).toEqual(['exact', 'near']);
    expect(hits[0].cosine).toBeGreaterThan(hits[1].cosine);
  });

  it('skips entries of the wrong dimension', () => {
    const entries: QuantisedEntry[] = [
      { id: 'bad', vec: new Int8Array(8) },
      { id: 'good', vec: quantise(unit(0)) },
    ];
    expect(service.scan(entries, quantise(unit(0)), 5).map(h => h.id)).toEqual(['good']);
  });
});

describe('index lifecycle', () => {
  it('answers nothing while cold, and starts a build instead', async () => {
    const service = new VectorIndexService();
    let queried = false;
    const fakeDb = {
      collection: () => ({
        find: () => {
          queried = true;
          return {
            sort: () => ({
              limit: () => ({
                async *[Symbol.asyncIterator]() {
                  /* empty corpus */
                },
              }),
            }),
          };
        },
      }),
    };
    const hits = await service.search(fakeDb as any, { user_id: 'x' }, unit(0), 5);
    expect(hits).toEqual([]);
    expect(queried).toBe(true); // build kicked off, caller keeps its other tiers
  });

  it('evicts the least recently used scope beyond the cap', async () => {
    const service = new VectorIndexService();
    const corpus = [{ _id: 'a', embedding: unit(0) }];
    const fakeDb = {
      collection: () => ({
        find: () => ({
          sort: () => ({
            limit: () => ({
              async *[Symbol.asyncIterator]() {
                for (const doc of corpus) yield doc;
              },
            }),
          }),
        }),
      }),
    };
    // Build more scopes than the cap allows.
    for (let i = 0; i <= MAX_INDEXES; i++) {
      await service.search(fakeDb as any, { user_id: `u${i}` }, unit(0), 5);
      await new Promise(r => setTimeout(r, 5)); // let the async build land
    }
    expect(service.resident.length).toBeLessThanOrEqual(MAX_INDEXES);
  });
});
