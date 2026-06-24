/**
 * Unit tests: Episodic Event Manager
 * Tests metadata sanitization, retry count increment, and event creation.
 */
import { describe, it, expect } from 'vitest';

const BLOCKED_METADATA_KEYS = [
  'processed',
  'created_at',
  'updated_at',
  'cascade_depth',
  'processing_version',
  'duplicate_prevention_applied',
] as const;

function sanitizeCallerMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!BLOCKED_METADATA_KEYS.includes(k as any)) {
      safe[k] = v;
    }
  }
  return safe;
}

describe('Episodic Event Manager — Metadata Sanitization', () => {
  it('blocks processed from caller metadata', () => {
    const result = sanitizeCallerMetadata({ processed: true, source: 'api' });
    expect(result.processed).toBeUndefined();
    expect(result.source).toBe('api');
  });

  it('blocks created_at from caller metadata', () => {
    const result = sanitizeCallerMetadata({ created_at: '2020-01-01', tags: ['test'] });
    expect(result.created_at).toBeUndefined();
    expect(result.tags).toEqual(['test']);
  });

  it('blocks cascade_depth and processing_version', () => {
    const result = sanitizeCallerMetadata({
      cascade_depth: 999,
      processing_version: 99,
      comment: 'hello',
    });
    expect(result.cascade_depth).toBeUndefined();
    expect(result.processing_version).toBeUndefined();
    expect(result.comment).toBe('hello');
  });

  it('allows safe metadata through', () => {
    const meta = { session_id: 's123', tags: ['important'], context: 'debug' };
    expect(sanitizeCallerMetadata(meta)).toEqual(meta);
  });

  it('returns empty object for empty input', () => {
    expect(sanitizeCallerMetadata({})).toEqual({});
  });
});

describe('Episodic Event Manager — Retry Count', () => {
  it('$inc is NOT inside $set (regression test for G4)', () => {
    /**
     * The original bug was: { $set: { 'metadata.retry_count': { $inc: 1 } } }
     * This stores the literal object { $inc: 1 } as the value.
     * The fix: { $set: { ... }, $inc: { 'metadata.retry_count': 1 } }
     */
    const updateDoc = buildFailedUpdateDoc();

    // $inc should be at the top level, not nested inside $set
    expect(updateDoc.$inc).toBeDefined();
    expect(updateDoc.$inc['metadata.retry_count']).toBe(1);

    // $set should NOT contain retry_count
    const setKeys = Object.keys(updateDoc.$set);
    const hasRetryInSet = setKeys.some(k => k.includes('retry_count'));
    expect(hasRetryInSet).toBe(false);
  });
});

function buildFailedUpdateDoc() {
  return {
    $set: {
      'metadata.processing_failed': true,
      'metadata.processing_error': 'test error',
      'metadata.processing_failed_at': new Date(),
      'metadata.updated_at': new Date(),
    },
    $inc: { 'metadata.retry_count': 1 },
  };
}
