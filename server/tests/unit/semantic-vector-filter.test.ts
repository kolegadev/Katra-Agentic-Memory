/**
 * buildSemanticVectorFilter — regression pin for the cross-identity
 * semantic-search leak (Zanshin verification report 2026-08-21).
 *
 * The vector pass of search_memories used to scan semantic_facts from ALL
 * users ({ embedding: { $exists: true } } only), leaking private memories
 * across identities in hybrid mode. The scope filter must always ride along.
 */
import { describe, expect, it } from 'vitest';
import { buildSemanticVectorFilter } from '../../src/mcp-server.js';

describe('buildSemanticVectorFilter', () => {
  it('carries the caller scope filter alongside the embedding requirement', () => {
    const base = { user_id: 'shoshin' };
    const f = buildSemanticVectorFilter(base, false);
    expect(f).toEqual({
      user_id: 'shoshin',
      embedding: { $exists: true },
      status: { $ne: 'retracted' },
    });
  });

  it('hybrid scope ($or) survives into the vector filter', () => {
    const base = {
      $or: [{ user_id: 'zanshin' }, { shared_id: 'my-team' }],
    };
    const f = buildSemanticVectorFilter(base, true);
    expect(f.$or).toEqual(base.$or);
    expect(f.embedding).toEqual({ $exists: true });
    expect(f.status).toBeUndefined(); // include_retracted
  });

  it('never drops the embedding requirement', () => {
    const f = buildSemanticVectorFilter({}, false);
    expect(f.embedding).toEqual({ $exists: true });
  });
});
