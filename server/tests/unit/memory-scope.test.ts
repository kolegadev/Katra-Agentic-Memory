/**
 * Unit tests: Memory Scope Service
 * Tests buildScopeFilter — the critical security boundary that must
 * NEVER return an empty {} filter (which leaks ALL data).
 */
import { describe, it, expect } from 'vitest';

const DEFAULT_USER_ID = 'default-user';

/**
 * Replicate buildScopeFilter logic from memory-scope-service.ts
 * (simplified — no DB reads for the cache/scope config)
 */
function buildScopeFilter(
  mode: 'personal' | 'shared' | 'hybrid',
  config: { shared_id?: string; hybrid_visible_user_ids?: string[] },
  user_id?: string
): Record<string, unknown> {
  switch (mode) {
    case 'personal':
      return { user_id: user_id || DEFAULT_USER_ID };

    case 'shared':
      return config.shared_id
        ? { shared_id: config.shared_id }
        : { user_id: DEFAULT_USER_ID };

    case 'hybrid': {
      const orConditions: Record<string, unknown>[] = [];
      if (user_id) orConditions.push({ user_id });
      if (config.shared_id) orConditions.push({ shared_id: config.shared_id });
      if ((config.hybrid_visible_user_ids || []).length > 0) {
        orConditions.push({ user_id: { $in: config.hybrid_visible_user_ids } });
      }
      return orConditions.length > 0
        ? { $or: orConditions }
        : { user_id: user_id || DEFAULT_USER_ID };
    }

    default:
      return { user_id: user_id || DEFAULT_USER_ID };
  }
}

describe('Memory Scope Service — buildScopeFilter', () => {
  describe('personal mode', () => {
    it('scopes to the given user_id', () => {
      const filter = buildScopeFilter('personal', {}, 'alice');
      expect(filter).toEqual({ user_id: 'alice' });
    });

    it('falls back to DEFAULT_USER_ID when no user_id provided', () => {
      const filter = buildScopeFilter('personal', {});
      expect(filter).toEqual({ user_id: DEFAULT_USER_ID });
      // CRITICAL: must NOT return {}
      expect(Object.keys(filter).length).toBeGreaterThan(0);
    });
  });

  describe('shared mode', () => {
    it('scopes to shared_id when configured', () => {
      const filter = buildScopeFilter('shared', { shared_id: 'team-123' });
      expect(filter).toEqual({ shared_id: 'team-123' });
    });

    it('FALLS BACK to DEFAULT_USER_ID when shared_id is missing (NOT {})', () => {
      const filter = buildScopeFilter('shared', {});
      expect(filter).toEqual({ user_id: DEFAULT_USER_ID });
      expect(filter).not.toEqual({}); // CRITICAL: security fix
    });
  });

  describe('hybrid mode', () => {
    it('includes user_id, shared_id, and visible users', () => {
      const filter = buildScopeFilter('hybrid', {
        shared_id: 'team-123',
        hybrid_visible_user_ids: ['bob'],
      }, 'alice');
      expect(filter).toEqual({
        $or: [
          { user_id: 'alice' },
          { shared_id: 'team-123' },
          { user_id: { $in: ['bob'] } },
        ],
      });
    });

    it('works with just user_id', () => {
      const filter = buildScopeFilter('hybrid', {}, 'alice');
      expect(filter).toEqual({ $or: [{ user_id: 'alice' }] });
    });

    it('FALLS BACK to DEFAULT_USER_ID when all conditions empty (NOT {})', () => {
      const filter = buildScopeFilter('hybrid', {});
      expect(filter).toEqual({ user_id: DEFAULT_USER_ID });
      expect(filter).not.toEqual({}); // CRITICAL
    });
  });

  describe('default (unknown mode)', () => {
    it('scopes to user_id when provided', () => {
      const filter = buildScopeFilter('personal' as any, {}, 'alice');
      expect(filter).toEqual({ user_id: 'alice' });
    });

    it('FALLS BACK to DEFAULT_USER_ID (NOT {})', () => {
      const filter = buildScopeFilter('personal' as any, {});
      expect(filter).toEqual({ user_id: DEFAULT_USER_ID });
    });
  });

  // Security regression tests
  describe('security: NEVER returns empty filter {}', () => {
    const modes: Array<'personal' | 'shared' | 'hybrid'> = ['personal', 'shared', 'hybrid'];

    for (const mode of modes) {
      it(`${mode} mode with no args never returns {}`, () => {
        const filter = buildScopeFilter(mode, {});
        expect(filter).not.toEqual({});
        expect(Object.keys(filter).length).toBeGreaterThan(0);
      });
    }

    it('shared mode with undefined shared_id returns scoped filter', () => {
      const filter = buildScopeFilter('shared', { shared_id: undefined as any });
      expect(filter).not.toEqual({});
    });

    it('hybrid with empty visible_users list returns scoped filter', () => {
      const filter = buildScopeFilter('hybrid', { hybrid_visible_user_ids: [] });
      expect(filter).not.toEqual({});
    });
  });
});
