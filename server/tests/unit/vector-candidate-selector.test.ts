/**
 * Unit tests: vector candidate selection (2026-09-25 pool fix).
 *
 * Regression guard for the bug where vector_search scored a fixed
 * `find(filter).limit(50)` slice in storage order: every query re-ranked the
 * same old documents and recent memories could never be returned.
 */
import { describe, it, expect } from 'vitest';
import {
  selectVectorCandidates,
  type CandidateCollection,
} from '../../src/services/memory/vector-candidate-selector.js';

interface FakeDoc {
  _id: string;
  content: string;
  created_at?: string;
}

/** Minimal Mongo-like collection recording how it was queried. */
function fakeCollection(recentDocs: FakeDoc[], textHits: FakeDoc[] = [], opts: { textThrows?: boolean } = {}) {
  const calls: { filter: Record<string, unknown>; sorted?: Record<string, 1 | -1>; limit?: number }[] = [];
  const collection: CandidateCollection = {
    find(filter: Record<string, unknown>) {
      const call: { filter: Record<string, unknown>; sorted?: Record<string, 1 | -1>; limit?: number } = { filter };
      calls.push(call);
      const isText = '$text' in filter;
      return {
        sort(spec: Record<string, 1 | -1>) {
          call.sorted = spec;
          return {
            limit(n: number) {
              call.limit = n;
              return { toArray: async () => recentDocs.slice(0, n) };
            },
          };
        },
        limit(n: number) {
          call.limit = n;
          return {
            toArray: async () => {
              if (opts.textThrows && isText) throw new Error('no text index');
              return isText ? textHits.slice(0, n) : recentDocs.slice(0, n);
            },
          };
        },
      };
    },
  };
  return { collection, calls };
}

const SCOPE = { $or: [{ user_id: 'lilly' }, { shared_id: 'my-team' }] };

describe('selectVectorCandidates', () => {
  it('always requests documents newest-first, never storage order', async () => {
    const { collection, calls } = fakeCollection([{ _id: 'a', content: 'x' }]);
    await selectVectorCandidates(collection, SCOPE, 'anything');
    expect(calls[0].sorted).toEqual({ created_at: -1 });
    expect(calls[0].filter.embedding).toEqual({ $exists: true });
  });

  it('unions the recent tier with the query-matched tier, de-duplicated', async () => {
    const { collection } = fakeCollection(
      [
        { _id: 'recent-1', content: 'today' },
        { _id: 'shared', content: 'both tiers' },
      ],
      [
        { _id: 'shared', content: 'both tiers' },
        { _id: 'old-but-matching', content: 'from July' },
      ],
    );
    const picked = await selectVectorCandidates(collection, SCOPE, 'wake ritual');
    expect(picked.map(d => d._id)).toEqual(['recent-1', 'shared', 'old-but-matching']);
  });

  it('keeps the recent tier when the text search is unusable', async () => {
    const { collection } = fakeCollection(
      [{ _id: 'recent-1', content: 'today' }],
      [{ _id: 'never', content: 'unreachable' }],
      { textThrows: true },
    );
    const picked = await selectVectorCandidates(collection, SCOPE, 'wake ritual');
    expect(picked.map(d => d._id)).toEqual(['recent-1']);
  });

  it('honours env-tunable pool sizes', async () => {
    const { collection, calls } = fakeCollection([
      { _id: 'a', content: '1' },
      { _id: 'b', content: '2' },
    ]);
    await selectVectorCandidates(collection, SCOPE, 'q', {
      env: (name) => (name === 'KATRA_VECTOR_POOL_RECENT' ? '1' : '0'),
    });
    expect(calls[0].limit).toBe(1);
    expect(calls).toHaveLength(1); // lexical tier disabled → no second query
    const picked = await selectVectorCandidates(
      { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) } as unknown as CandidateCollection,
      SCOPE,
      'q',
      { env: () => 'not-a-number' },
    );
    expect(picked).toEqual([]);
  });

  it('skips the lexical query for an empty search string', async () => {
    const { collection, calls } = fakeCollection([{ _id: 'a', content: '1' }]);
    await selectVectorCandidates(collection, SCOPE, '   ');
    expect(calls).toHaveLength(1);
  });
});
