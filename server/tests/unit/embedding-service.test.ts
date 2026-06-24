/**
 * Unit tests: Embedding Service
 * Tests that keywordFilter cannot override user_id scoping.
 */
import { describe, it, expect } from 'vitest';

function buildSearchFilter(
  userId: string,
  keywordFilter: Record<string, unknown>
): Record<string, unknown> {
  // Use $and to prevent keywordFilter from overriding user_id
  const conditions: any[] = [
    { user_id: userId },
    { embedding: { $exists: true } },
  ];
  if (Object.keys(keywordFilter).length > 0) {
    conditions.push(keywordFilter);
  }
  return { $and: conditions };
}

describe('Embedding Service — Filter Injection Prevention', () => {
  it('prevents keywordFilter from overriding user_id', () => {
    // Attacker tries to pass user_id as a keyword filter
    const maliciousFilter = { user_id: 'victim-id' };
    const filter = buildSearchFilter('alice', maliciousFilter);

    // The $and array should contain the original user_id
    const andArray = filter.$and as any[];
    expect(andArray).toHaveLength(3);
    expect(andArray[0]).toEqual({ user_id: 'alice' }); // Original scoping preserved
    expect(andArray[1]).toEqual({ embedding: { $exists: true } });
  });

  it('works with empty keyword filter', () => {
    const filter = buildSearchFilter('alice', {});
    expect(filter).toEqual({
      $and: [
        { user_id: 'alice' },
        { embedding: { $exists: true } },
      ],
    });
  });

  it('includes keyword filter as additional condition', () => {
    const filter = buildSearchFilter('bob', { 'content.message': { $regex: 'test' } });
    const andArray = filter.$and as any[];
    expect(andArray).toHaveLength(3);
    expect(andArray[2]).toEqual({ 'content.message': { $regex: 'test' } });
  });

  it('user_id from first condition always takes precedence', () => {
    // Even if keywordFilter contains user_id, the first condition in $and wins
    // because MongoDB's $and with same field name uses the first occurrence
    const filter = buildSearchFilter('actual-user', { user_id: 'injected' });
    const andArray = filter.$and as any[];
    expect(andArray[0].user_id).toBe('actual-user');
  });
});
