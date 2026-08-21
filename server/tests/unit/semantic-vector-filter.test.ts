/**
 * buildSemanticVectorFilter — regression pin for the cross-identity
 * semantic-search leak (Zanshin verification report 2026-08-21).
 *
 * The vector pass of search_memories used to scan semantic_facts from ALL
 * users ({ embedding: { $exists: true } } only), leaking private memories
 * across identities in hybrid mode. The scope filter must always ride along.
 */
import { describe, expect, it } from 'vitest';
import { buildSemanticVectorFilter, buildScopedTextQueries } from '../../src/mcp-server.js';

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

describe('buildScopedTextQueries — keyword-pass scope preservation', () => {
  const contentConditions = [{ content: { $regex: /leak/ } }];

  it('hybrid scope $or is nested under $and, never overwritten', () => {
    const colFilter = {
      $or: [{ user_id: 'zanshin' }, { shared_id: 'my-team' }],
    };
    const { regexQuery, textQuery } = buildScopedTextQueries(colFilter, contentConditions, 'leak');
    // The scope $or must survive UNCHANGED inside the $and array.
    expect(regexQuery.$and[0]).toEqual(colFilter);
    expect(regexQuery.$and[1].$or).toEqual(contentConditions);
    expect(textQuery.$and[0]).toEqual(colFilter);
    expect(textQuery.$and[1].$text).toEqual({ $search: 'leak' });
  });

  it('personal-mode filter (plain user_id) survives in both shapes', () => {
    const colFilter = { user_id: 'shoshin', status: { $ne: 'retracted' } };
    const { regexQuery, textQuery } = buildScopedTextQueries(colFilter, contentConditions, 'leak');
    expect(regexQuery.$and[0]).toEqual(colFilter);
    expect(textQuery.$and[0]).toEqual(colFilter);
  });
});
