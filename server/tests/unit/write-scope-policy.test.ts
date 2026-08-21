/**
 * Unit tests: Write Scope Policy (F2)
 *
 * Personal kinds (journal / reflection / emotional / insight) are ALWAYS
 * private; every other write defaults to shared_id 'my-team' while keeping
 * the writer's user_id, unless the caller sets `private: true`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PERSONAL_KINDS,
  DEFAULT_SHARED_ID,
  resolveWriteScope,
  stripSharedId,
  ensureMemoryScopePrivateVisibleIds,
} from '../../src/services/memory/write-scope-policy.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

// ── DB mock (only used by ensureMemoryScopePrivateVisibleIds) ──────────────
const state = vi.hoisted(() => ({
  updates: [] as Array<{ filter: Record<string, unknown>; update: Record<string, unknown>; upsert?: boolean }>,
  throwOnUpdate: false,
}));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: () => ({
      updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>, opts?: { upsert?: boolean }) => {
        if (state.throwOnUpdate) throw new Error('db down');
        state.updates.push({ filter, update, upsert: opts?.upsert });
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      },
    }),
  }),
}));

const SHOSHIN: CallerIdentity = { user_id: 'shoshin', trusted: false };
const TRUSTED_SATORI: CallerIdentity = { user_id: 'satori', trusted: true };

describe('resolveWriteScope — personal kinds are forced private', () => {
  it('exposes the contract personal kinds list', () => {
    expect(PERSONAL_KINDS).toEqual(['journal', 'reflection', 'emotional', 'insight']);
  });

  it.each(PERSONAL_KINDS)('%s → shared_id null even when shared is requested', (kind) => {
    const result = resolveWriteScope({
      caller: SHOSHIN,
      kind,
      requested: { shared_id: 'my-team', private: false },
    });
    expect(result.user_id).toBe('shoshin');
    expect(result.shared_id).toBeNull();
  });

  it.each(PERSONAL_KINDS)('%s → shared_id null with no request at all', (kind) => {
    const result = resolveWriteScope({ caller: SHOSHIN, kind });
    expect(result.shared_id).toBeNull();
  });

  it('personal kinds ignore an explicit requested shared_id', () => {
    const result = resolveWriteScope({
      caller: SHOSHIN,
      kind: 'journal',
      requested: { shared_id: 'team-x' },
    });
    expect(result.shared_id).toBeNull();
  });
});

describe('resolveWriteScope — default shared for everything else', () => {
  it.each(['fact', 'preference', 'event', 'general'])(
    '%s defaults to shared_id %s',
    (kind) => {
      const result = resolveWriteScope({ caller: SHOSHIN, kind });
      expect(result.shared_id).toBe(DEFAULT_SHARED_ID);
      expect(result.shared_id).toBe('my-team');
    },
  );

  it('still stamps the writer user_id when shared', () => {
    const result = resolveWriteScope({ caller: SHOSHIN, kind: 'event' });
    expect(result.user_id).toBe('shoshin');
    expect(result.shared_id).toBe('my-team');
  });

  it('honors an explicit requested shared_id', () => {
    const result = resolveWriteScope({
      caller: SHOSHIN,
      kind: 'event',
      requested: { shared_id: 'team-x' },
    });
    expect(result.shared_id).toBe('team-x');
  });

  it('private: true opts out of the shared default', () => {
    const result = resolveWriteScope({
      caller: SHOSHIN,
      kind: 'event',
      requested: { private: true },
    });
    expect(result.shared_id).toBeNull();
  });

  it('private: true wins over an explicit shared_id', () => {
    const result = resolveWriteScope({
      caller: SHOSHIN,
      kind: 'fact',
      requested: { private: true, shared_id: 'team-x' },
    });
    expect(result.shared_id).toBeNull();
  });

  it('only a strict boolean true opts out', () => {
    expect(
      resolveWriteScope({ caller: SHOSHIN, kind: 'fact', requested: { private: false } }).shared_id,
    ).toBe('my-team');
    expect(
      resolveWriteScope({ caller: SHOSHIN, kind: 'fact', requested: { private: undefined } }).shared_id,
    ).toBe('my-team');
  });
});

describe('resolveWriteScope — user attribution', () => {
  it('untrusted callers are always pinned to their own user_id', () => {
    const result = resolveWriteScope({
      caller: SHOSHIN,
      kind: 'event',
      requested: { user_id: 'zanshin' },
    });
    expect(result.user_id).toBe('shoshin');
  });

  it('trusted callers may name a user_id', () => {
    const result = resolveWriteScope({
      caller: TRUSTED_SATORI,
      kind: 'event',
      requested: { user_id: 'zanshin' },
    });
    expect(result.user_id).toBe('zanshin');
  });

  it('trusted callers fall back to their own user_id', () => {
    const result = resolveWriteScope({ caller: TRUSTED_SATORI, kind: 'event', requested: {} });
    expect(result.user_id).toBe('satori');
  });

  it('blank user_id is ignored even for trusted callers', () => {
    const result = resolveWriteScope({
      caller: TRUSTED_SATORI,
      kind: 'event',
      requested: { user_id: '   ' },
    });
    expect(result.user_id).toBe('satori');
  });
});

describe('stripSharedId', () => {
  it('removes shared_id and keeps every other field', () => {
    const doc = { user_id: 'shoshin', entry: 'x', shared_id: 'my-team' };
    const stripped = stripSharedId(doc);
    expect(stripped).toEqual({ user_id: 'shoshin', entry: 'x' });
    expect('shared_id' in stripped).toBe(false);
  });

  it('returns the same document untouched when no shared_id is present', () => {
    const doc = { user_id: 'shoshin', entry: 'x' };
    expect(stripSharedId(doc)).toBe(doc);
  });
});

describe('ensureMemoryScopePrivateVisibleIds (boot ensure)', () => {
  beforeEach(() => {
    state.updates = [];
    state.throwOnUpdate = false;
  });

  it('updates only the existing memory_scope key (no upsert)', async () => {
    await ensureMemoryScopePrivateVisibleIds();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].filter).toEqual({ key: 'memory_scope' });
    expect(state.updates[0].upsert).toBeUndefined();
  });

  it('pins hybrid_visible_user_ids to [] and touches nothing else', async () => {
    await ensureMemoryScopePrivateVisibleIds();
    const { update } = state.updates[0];
    expect(update).toEqual({ $set: { hybrid_visible_user_ids: [] } });
    expect(Object.keys(update.$set)).toEqual(['hybrid_visible_user_ids']);
  });

  it('does not throw when the database is unavailable', async () => {
    state.throwOnUpdate = true;
    await expect(ensureMemoryScopePrivateVisibleIds()).resolves.toBeUndefined();
    expect(state.updates).toHaveLength(0);
  });
});
