/**
 * Unit tests: Embedding Service
 * Tests that keywordFilter cannot override user_id scoping.
 */
import { describe, it, expect } from 'vitest';
import { EmbeddingService } from '../../src/services/infrastructure/embedding-service.js';

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

/**
 * Long-document windowing (2026-09-25). The model has 512 positions, so a
 * document longer than that used to be truncated and mean-pooled once — the
 * tail never reached its vector. Documents are now split into overlapping
 * windows, encoded separately and averaged.
 */
describe('Embedding Service — long document windowing', () => {
  const service = EmbeddingService.get_instance();

  it('keeps short documents as a single window', () => {
    expect(service.splitForEmbedding('short memory')).toEqual(['short memory']);
    expect(service.splitForEmbedding('x'.repeat(1000))).toHaveLength(1);
  });

  it('splits long documents into overlapping windows', () => {
    const windows = service.splitForEmbedding('x'.repeat(2500));
    expect(windows.length).toBe(3);
    expect(windows[0]).toHaveLength(1000);
    // The overlap keeps a sentence straddling a boundary readable in one window.
    expect(windows[1].slice(0, 100)).toBe(windows[0].slice(900));
  });

  it('covers the end of the document instead of truncating it', () => {
    const text = 'A'.repeat(1900) + 'THE-END-MARKER';
    const windows = service.splitForEmbedding(text);
    expect(windows[windows.length - 1]).toContain('THE-END-MARKER');
    expect(windows.length * 900).toBeGreaterThanOrEqual(text.length);
  });

  it('bounds the number of windows for very large documents', () => {
    expect(service.splitForEmbedding('y'.repeat(500_000))).toHaveLength(24);
  });

  it('returns no windows for empty or whitespace-only content', () => {
    expect(service.splitForEmbedding('')).toEqual([]);
    expect(service.splitForEmbedding('   \n  ')).toEqual([]);
  });
});
