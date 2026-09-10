/**
 * Unit tests: admin /memory-search hybrid contract
 *
 * Regression: the no-user_id path used to return recent events and ignore
 * query/collection entirely. These tests lock in that query+collection filtering
 * works with or without user_id, a bogus query returns 0 results, the legacy
 * no-query recency fallback is preserved, and semantic vector matches are merged
 * ahead of keyword results when the embedding model is ready.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures + a minimal Mongo-filter matcher, hoisted so the vi.mock factories
// (which are hoisted above this code) can reference them.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const FIXTURES: Record<string, any[]> = {
    episodic_events: [
      { _id: 'e1', user_id: 'katra', timestamp: new Date('2026-09-10T10:00:00Z'), content: { message: 'OPERATING RULE: TEAM COLLABORATION stored.' } },
      { _id: 'e2', user_id: 'agent-c', timestamp: new Date('2026-09-09T10:00:00Z'), content: { message: 'just a hello' } },
    ],
    semantic_facts: [
      { _id: 's1', user_id: 'agent-a', created_at: new Date('2026-09-09T12:00:00Z'), content: 'OPERATING RULE (operator): TEAM COLLABORATION' },
      { _id: 's2', user_id: 'agent-c', created_at: new Date('2026-09-08T12:00:00Z'), content: 'wifi fix for the office network' },
    ],
    knowledge_nodes: [
      { _id: 'k1', user_id: 'system', updated_at: new Date('2026-09-09T09:00:00Z'), name: 'OPERATING RULE' },
      { _id: 'k2', user_id: 'system', updated_at: new Date('2026-09-08T09:00:00Z'), name: 'Google Search Console' },
    ],
    reflective_journals: [
      { _id: 'r1', user_id: 'katra', created_at: new Date('2026-09-09T08:00:00Z'), narrative: 'A bridge becomes real through small steps' },
      { _id: 'r2', user_id: 'agent-b', created_at: new Date('2026-09-08T08:00:00Z'), narrative: 'keep the desktop tidy' },
    ],
  };

  const regexMatch = (value: any, cond: any): boolean => {
    if (value == null || typeof value !== 'string') return false;
    const re = cond && cond.$regex;
    if (!re) return false;
    try {
      return new RegExp(re, cond.$options || '').test(value);
    } catch {
      return false;
    }
  };

  const matchesFilter = (doc: any, filter: any): boolean => {
    if (!filter || Object.keys(filter).length === 0) return true;
    if (filter.$and) return filter.$and.every((f: any) => matchesFilter(doc, f));
    if (filter.$or) return filter.$or.some((f: any) => matchesFilter(doc, f));
    for (const [k, v] of Object.entries(filter)) {
      const parts = k.split('.');
      let val: any = doc;
      for (const p of parts) val = val == null ? undefined : val[p];
      if (k === 'user_id') {
        if (doc.user_id !== v) return false;
      } else if (v && typeof v === 'object' && '$regex' in (v as any)) {
        if (!regexMatch(val, v)) return false;
      } else if (val !== v) {
        return false;
      }
    }
    return true;
  };

  const chain = (items: any[]) => ({
    sort: () => chain(items),
    limit: () => chain(items),
    project: () => chain(items),
    toArray: async () => items,
  });

  return {
    FIXTURES,
    matchesFilter,
    chain,
    embedding: {
      isReady: false,
      searchSimilar: vi.fn(async (): Promise<any[]> => []),
    },
  };
});

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: (name: string) => ({
      find: (filter: any) => {
        const docs = (h.FIXTURES[name] || []).filter((d: any) => h.matchesFilter(d, filter));
        return h.chain(docs);
      },
    }),
  }),
  is_database_connected: () => true,
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

vi.mock('../../src/services/infrastructure/embedding-service.js', () => ({
  embeddingService: {
    get isReady() { return h.embedding.isReady; },
    searchSimilar: h.embedding.searchSimilar,
  },
}));

// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import { create_admin_routes } from '../../src/routes/admin-routes.js';

const app = new Hono();
app.route('/api/v1/admin', create_admin_routes());

async function search(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return app.request(`/api/v1/admin/memory-search?${qs}`);
}

describe('admin /memory-search — query+collection honored without user_id', () => {
  beforeEach(() => {
    h.embedding.isReady = false;
    h.embedding.searchSimilar.mockReset();
    h.embedding.searchSimilar.mockResolvedValue([]);
  });

  it('bogus query (no user_id) returns 0 results instead of recent facts', async () => {
    const res = await search({ query: 'zzzqqqnonexistent' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.results).toEqual([]);
  });

  it('query-only (no user_id) filters to matching docs across collections', async () => {
    const res = await search({ query: 'OPERATING RULE' });
    const body = await res.json();
    const contents: string[] = body.results.map((r: any) => r.content);
    expect(contents.some((c) => c.includes('OPERATING RULE') || c.includes('TEAM COLLABORATION'))).toBe(true);
    expect(contents.some((c) => c.includes('wifi fix'))).toBe(false);
  });

  it('collection param is honored without user_id', async () => {
    const res = await search({ query: 'OPERATING', collection: 'semantic_facts' });
    const body = await res.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((r: any) => r.collection === 'semantic')).toBe(true);
  });

  it('legacy no-query recency fallback returns recent docs across collections', async () => {
    const res = await search({});
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('user_id path still scopes results', async () => {
    const res = await search({ user_id: 'agent-c', query: 'hello' });
    const body = await res.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((r: any) => r.user_id === 'agent-c')).toBe(true);
  });
});

describe('admin /memory-search — hybrid semantic augmentation', () => {
  beforeEach(() => {
    h.embedding.searchSimilar.mockReset();
  });

  it('merges semantic matches ahead of keyword results when the model is ready', async () => {
    h.embedding.isReady = true;
    h.embedding.searchSimilar.mockImplementation(async (col: string) => {
      if (col === 'semantic_facts') {
        return [{ _id: 's-sem', user_id: 'agent-a', created_at: new Date('2026-09-01T00:00:00Z'), content: 'teamwork makes the dream work', score: 0.95 }];
      }
      return [];
    });

    const res = await search({ query: 'collaboration rules' });
    const body = await res.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].content).toBe('teamwork makes the dream work');
  });

  it('falls back to keyword-only when the embedding model is unavailable', async () => {
    h.embedding.isReady = false;
    const res = await search({ query: 'OPERATING RULE' });
    const body = await res.json();
    expect(h.embedding.searchSimilar).not.toHaveBeenCalled();
    expect(body.results.length).toBeGreaterThan(0);
  });
});
