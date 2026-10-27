/**
 * ITER-2 — per-identity personality configuration service.
 * Contract: CONTRACT-iter2-per-identity-personality.md
 *
 * Proves, against the in-memory fake:
 *
 *   1. the flag (`PER_IDENTITY_PERSONALITY`, default off) fails closed and
 *      switches resolution between "legacy → default" and
 *      "identity → legacy → default" — with the identity record not even read
 *      while the flag is off;
 *   2. resolution is READ-ONLY: no document is created, changed or deleted by
 *      a read in any flag state (document snapshots + write spies);
 *   3. `update()` validation is IDENTICAL to the pre-iteration PUT sanitiser,
 *      extracted from `git show 48ba7e6:` and evaluated here (not transcribed);
 *   4. writes: version starts at 1 and increments, `origin` is server-owned,
 *      flag-off writes target the legacy global record, and an untrusted
 *      caller can never write another identity's record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

import {
  AGENT_MESSAGE_WEIGHT,
  ALL_SOURCES,
  PROFILES,
} from '../../src/services/integration/personality-profiles.js';
import {
  PersonalityAccessError,
  PersonalityWriteConflictError,
  effectivePersonalityConfig,
  perIdentityPersonalityEnabled,
  personalityConfigKey,
  resolvePersonalityConfig,
  sanitizePersonalityPatch,
  snapshotPersonalityConfig,
  updatePersonalityConfig,
} from '../../src/services/integration/personality-config-service.js';
import { FakeDb } from '../helpers/fake-mongo.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const FAKE_DB = new FakeDb();
const settings = () => FAKE_DB.collection('system_settings');

/** A caller acting for itself, untrusted. */
const untrusted = (userId: string): CallerIdentity => ({ user_id: userId, trusted: false });
/** A trusted caller (loopback / admin key). */
const TRUSTED: CallerIdentity = { user_id: 'operator', trusted: true };

const LEGACY_KEY = 'personality_config';
const LEGACY_DOC = {
  key: LEGACY_KEY,
  personality: 'scholar',
  source_weights: { vector_search: 7 },
  scoring: { relevance_multiplier: 3 },
  max_context_tokens: 8000,
  updated_at: '2026-09-01T00:00:00.000Z',
};
const IDENTITY_A_KEY = personalityConfigKey('agent-a');
const IDENTITY_A_DOC = {
  key: IDENTITY_A_KEY,
  personality: 'dreamer',
  source_weights: { working_memory: 2 },
  scoring: {},
  max_context_tokens: 4000,
  origin: 'identity',
  version: 4,
  updated_at: '2026-09-10T10:00:00.000Z',
};

const VALID_PATCH = {
  personality: 'analyst',
  source_weights: { vector_search: 6 },
  scoring: { relevance_multiplier: 2.5 },
  max_context_tokens: 6000,
};

beforeEach(() => {
  FAKE_DB.reset();
  delete process.env.PER_IDENTITY_PERSONALITY;
});

afterEach(() => {
  FAKE_DB.reset();
  delete process.env.PER_IDENTITY_PERSONALITY;
});

// ── Flag ──────────────────────────────────────────────────────────────────

describe('PER_IDENTITY_PERSONALITY flag (fail closed)', () => {
  it('is off when unset, and off for any value that is not 1/true/yes', () => {
    for (const value of ['', ' ', '0', 'false', 'no', 'off', 'on', 'enabled', '2', 'truthy', 'y']) {
      process.env.PER_IDENTITY_PERSONALITY = value;
      expect(perIdentityPersonalityEnabled(), `value=${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('is on for 1/true/yes, case-insensitive and whitespace-tolerant', () => {
    for (const value of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', '  yes  ', '\ttrue\n']) {
      process.env.PER_IDENTITY_PERSONALITY = value;
      expect(perIdentityPersonalityEnabled(), `value=${JSON.stringify(value)}`).toBe(true);
    }
  });

  it('is off when the variable is deleted (the default)', () => {
    delete process.env.PER_IDENTITY_PERSONALITY;
    expect(perIdentityPersonalityEnabled()).toBe(false);
  });
});

// ── Resolution order ─────────────────────────────────────────────────────

describe('resolvePersonalityConfig — read order per flag state', () => {
  it('flag OFF: reads the legacy record and ignores the identity record entirely', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC), structuredClone(IDENTITY_A_DOC));

    const resolved = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-a');

    expect(resolved.origin).toBe('legacy');
    expect(resolved.profile).toBe('scholar');
    expect(resolved.source_weights).toEqual({ vector_search: 7 });
    expect(resolved.max_context_tokens).toBe(8000);
    expect(resolved.updated_at).toBe('2026-09-01T00:00:00.000Z');
    expect(resolved.user_id).toBe('agent-a');
    expect(resolved.version).toBe(0);

    // The identity record is not even read: one findOne, on the legacy key.
    const findSpy = vi.spyOn(settings(), 'findOne');
    await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-a');
    expect(findSpy.mock.calls.map(([filter]) => (filter as any).key)).toEqual([LEGACY_KEY]);
  });

  it('flag OFF: falls back to the defaults when no legacy record exists', async () => {
    settings().docs.push(structuredClone(IDENTITY_A_DOC));

    const resolved = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-a');

    // The identity record must NOT be consulted with the flag off.
    expect(resolved.origin).toBe('default');
    expect(resolved.profile).toBe('balanced');
    expect(resolved.source_weights).toEqual({});
    expect(resolved.scoring).toEqual({});
    expect(resolved.max_context_tokens).toBeNull();
    expect(resolved.updated_at).toBeNull();
  });

  it('flag ON: identity record wins over the legacy record', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    settings().docs.push(structuredClone(LEGACY_DOC), structuredClone(IDENTITY_A_DOC));

    const resolved = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-a');

    expect(resolved.origin).toBe('identity');
    expect(resolved.profile).toBe('dreamer');
    expect(resolved.source_weights).toEqual({ working_memory: 2 });
    expect(resolved.max_context_tokens).toBe(4000);
    expect(resolved.version).toBe(4);
    expect(resolved.updated_at).toBe('2026-09-10T10:00:00.000Z');
  });

  it('flag ON: an identity with no record falls back to legacy, then to defaults — never to another identity', async () => {
    process.env.PER_IDENTITY_PERSONALITY = 'true';
    settings().docs.push(structuredClone(LEGACY_DOC), structuredClone(IDENTITY_A_DOC));

    const legacy = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-b');
    expect(legacy.origin).toBe('legacy');
    expect(legacy.profile).toBe('scholar');
    expect(legacy.source_weights).toEqual({ vector_search: 7 });

    settings().docs = settings().docs.filter((d) => d.key !== LEGACY_KEY);
    const fallback = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-b');
    expect(fallback.origin).toBe('default');
    expect(fallback.profile).toBe('balanced');
    expect(fallback.source_weights).toEqual({});
    // agent-a's record is never inherited by agent-b.
    expect(fallback.profile).not.toBe(IDENTITY_A_DOC.personality);
  });

  it('reports version 0 for a stored version that is absent, non-finite or not a number', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    const storedValues: Array<[string, unknown]> = [
      ['absent', undefined],
      ['null', null],
      ['a string', '4'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ];

    for (const [label, stored] of storedValues) {
      const doc: Record<string, unknown> = {
        key: IDENTITY_A_KEY,
        personality: 'dreamer',
        source_weights: {},
        scoring: {},
        origin: 'identity',
      };
      if (stored !== undefined) doc.version = stored;
      settings().docs = [doc];

      const resolved = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-a');

      expect(resolved.version, `stored version = ${label}`).toBe(0);
      // A record present with an unusable version is still an identity record.
      expect(resolved.origin).toBe('identity');
      expect(resolved.profile).toBe('dreamer');
    }
  });

  it('flag ON: two identities resolve their own records independently', async () => {
    process.env.PER_IDENTITY_PERSONALITY = 'yes';
    settings().docs.push(
      structuredClone(IDENTITY_A_DOC),
      { key: personalityConfigKey('agent-b'), personality: 'sentinel', source_weights: {}, scoring: {}, origin: 'identity', version: 1, updated_at: '2026-09-11T00:00:00.000Z' },
    );

    const a = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-a');
    const b = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-b');

    expect([a.profile, a.origin, a.version]).toEqual(['dreamer', 'identity', 4]);
    expect([b.profile, b.origin, b.version]).toEqual(['sentinel', 'identity', 1]);
  });
});

// ── Read-only resolution ─────────────────────────────────────────────────

describe('resolution is read-only', () => {
  it.each([
    ['flag off, empty store', undefined, 'agent-a'],
    ['flag off, seeded', undefined, 'agent-a'],
    ['flag on, empty store', '1', 'agent-a'],
    ['flag on, seeded', '1', 'agent-a'],
    ['flag on, other identity', '1', 'agent-c'],
  ])('%s — resolve writes nothing', async (_name, flag, userId) => {
    if (flag) process.env.PER_IDENTITY_PERSONALITY = flag;
    else delete process.env.PER_IDENTITY_PERSONALITY;
    settings().docs.push(structuredClone(LEGACY_DOC), structuredClone(IDENTITY_A_DOC));

    const before = structuredClone(settings().docs);
    const updateSpy = vi.spyOn(settings(), 'updateOne');
    const insertSpy = vi.spyOn(settings(), 'insertOne');
    const deleteSpy = vi.spyOn(settings(), 'deleteMany');

    await resolvePersonalityConfig(FAKE_DB.asDb(), userId);

    expect(settings().docs).toEqual(before);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('snapshot is the same resolution, frozen, and writes nothing', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    settings().docs.push(structuredClone(IDENTITY_A_DOC));
    const before = structuredClone(settings().docs);

    const snapshot = await snapshotPersonalityConfig(FAKE_DB.asDb(), 'agent-a');
    const resolved = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-a');

    expect(snapshot).toEqual(resolved);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.source_weights)).toBe(true);
    expect(settings().docs).toEqual(before);
    // The returned copy is immutable and detached from the store.
    expect(() => { (snapshot as any).profile = 'mutated'; }).toThrow(TypeError);
    expect(() => { (snapshot.source_weights as any).vector_search = 0; }).toThrow(TypeError);
    expect(settings().docs[0].personality).toBe('dreamer');
  });
});

// ── Effective configuration ──────────────────────────────────────────────

describe('effectivePersonalityConfig', () => {
  it('merges profile defaults with the stored overrides and pins agent_message', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    settings().docs.push(structuredClone(IDENTITY_A_DOC));
    const resolved = await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-a');

    const effective = effectivePersonalityConfig(resolved);

    expect(effective.profile).toBe('dreamer');
    expect(effective.source_weights.working_memory).toBe(2); // override
    expect(effective.source_weights.missions).toBe(PROFILES.dreamer.weights.missions); // profile default
    expect(effective.source_weights.agent_message).toBe(AGENT_MESSAGE_WEIGHT);
    expect(effective.max_context_tokens).toBe(4000);
  });

  it('re-pins agent_message even if a stored record tries to weaken it', () => {
    const effective = effectivePersonalityConfig({
      user_id: 'agent-a',
      profile: 'balanced',
      source_weights: { agent_message: 0.5 },
      scoring: {},
      max_context_tokens: null,
      version: 1,
      origin: 'identity',
      updated_at: null,
    });
    expect(effective.source_weights.agent_message).toBe(AGENT_MESSAGE_WEIGHT);
  });

  it("falls back to the profile's recommended budget when the record stores none", () => {
    const effective = effectivePersonalityConfig({
      user_id: 'agent-a',
      profile: 'scholar',
      source_weights: {},
      scoring: {},
      max_context_tokens: null,
      version: 0,
      origin: 'legacy',
      updated_at: null,
    });
    expect(effective.max_context_tokens).toBe(5000); // scholar's recommended budget
  });
});

// ── Writes ───────────────────────────────────────────────────────────────

describe('updatePersonalityConfig', () => {
  it('flag ON: creates the identity record with version 1 and origin identity', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    const db = FAKE_DB.asDb();

    const resolved = await updatePersonalityConfig(db, 'agent-a', VALID_PATCH, untrusted('agent-a'));

    const doc = settings().docs.find((d) => d.key === IDENTITY_A_KEY);
    expect(doc).toBeTruthy();
    expect(doc!.personality).toBe('analyst');
    expect(doc!.source_weights).toEqual({ vector_search: 6 });
    expect(doc!.max_context_tokens).toBe(6000);
    expect(doc!.origin).toBe('identity');
    expect(doc!.version).toBe(1);

    expect(resolved.origin).toBe('identity');
    expect(resolved.version).toBe(1);
    expect(resolved.profile).toBe('analyst');
    expect(typeof resolved.updated_at).toBe('string');
    expect(() => new Date(resolved.updated_at!).toISOString()).not.toThrow();
    // The legacy record was not touched: nothing was written for it.
    expect(settings().docs.some((d) => d.key === LEGACY_KEY)).toBe(false);
  });

  it('flag ON: increments the version on every write', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    const db = FAKE_DB.asDb();

    await updatePersonalityConfig(db, 'agent-a', VALID_PATCH, untrusted('agent-a'));
    const second = await updatePersonalityConfig(db, 'agent-a', VALID_PATCH, untrusted('agent-a'));
    const third = await updatePersonalityConfig(db, 'agent-a', VALID_PATCH, untrusted('agent-a'));

    expect([second.version, third.version]).toEqual([2, 3]);
    expect(settings().docs.find((d) => d.key === IDENTITY_A_KEY)!.version).toBe(3);
  });

  it('flag ON: continues the version of an existing record', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    settings().docs.push(structuredClone(IDENTITY_A_DOC));

    const resolved = await updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', VALID_PATCH, untrusted('agent-a'));

    expect(resolved.version).toBe(5);
    expect(settings().docs.find((d) => d.key === IDENTITY_A_KEY)!.version).toBe(5);
  });

  it('flag OFF: upserts the legacy global record and creates no identity document', async () => {
    const db = FAKE_DB.asDb();

    const resolved = await updatePersonalityConfig(db, 'agent-a', VALID_PATCH, untrusted('agent-a'));

    expect(settings().docs.map((d) => d.key)).toEqual([LEGACY_KEY]);
    const doc = settings().docs[0];
    expect(doc.personality).toBe('analyst');
    expect(doc.source_weights).toEqual({ vector_search: 6 });
    expect(doc.max_context_tokens).toBe(6000);
    // Today's record carries no version/origin fields — unchanged.
    expect(doc.version).toBeUndefined();
    expect(doc.origin).toBeUndefined();

    expect(resolved.origin).toBe('legacy');
    expect(resolved.version).toBe(0);
    expect(resolved.profile).toBe('analyst');
  });

  it('flag OFF: updates an existing legacy record in place', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));

    await updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', VALID_PATCH, untrusted('agent-a'));

    expect(settings().docs).toHaveLength(1);
    expect(settings().docs[0].personality).toBe('analyst');
    expect(settings().docs[0].source_weights).toEqual({ vector_search: 6 });
  });

  it('flag OFF: writes exactly the pre-iteration document shape (no new fields, Date timestamp)', async () => {
    await updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', VALID_PATCH, untrusted('agent-a'));

    const doc = settings().docs[0];
    expect(Object.keys(doc).sort()).toEqual(
      ['key', 'max_context_tokens', 'personality', 'scoring', 'source_weights', 'updated_at'],
    );
    expect(doc.updated_at).toBeInstanceOf(Date);
  });

  it('flag OFF: an unusable budget leaves the legacy document without the field', async () => {
    await updatePersonalityConfig(
      FAKE_DB.asDb(),
      'agent-a',
      { personality: 'balanced', source_weights: {}, scoring: {} },
      untrusted('agent-a'),
    );

    expect(Object.keys(settings().docs[0]).sort()).toEqual(
      ['key', 'personality', 'scoring', 'source_weights', 'updated_at'],
    );
  });

  it('flag OFF: an omitted budget leaves the stored budget untouched', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));

    await updatePersonalityConfig(
      FAKE_DB.asDb(),
      'agent-a',
      { personality: 'analyst', source_weights: {}, scoring: {} },
      untrusted('agent-a'),
    );

    expect(settings().docs[0].max_context_tokens).toBe(8000);
  });

  it('ignores caller-supplied origin/version (server-owned fields)', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    const patch = { ...VALID_PATCH, origin: 'legacy', version: 99 } as any;

    await updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', patch, untrusted('agent-a'));

    const doc = settings().docs.find((d) => d.key === IDENTITY_A_KEY)!;
    expect(doc.origin).toBe('identity');
    expect(doc.version).toBe(1);
  });

  it('refuses a cross-identity write by an untrusted caller and writes nothing anywhere', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    settings().docs.push(structuredClone(IDENTITY_A_DOC));
    const before = structuredClone(settings().docs);

    await expect(
      updatePersonalityConfig(FAKE_DB.asDb(), 'agent-b', VALID_PATCH, untrusted('agent-a')),
    ).rejects.toBeInstanceOf(PersonalityAccessError);

    expect(settings().docs).toEqual(before);
    expect(settings().docs.some((d) => d.key === personalityConfigKey('agent-b'))).toBe(false);
    // agent-a's own record is untouched too.
    expect(settings().docs[0]).toEqual(IDENTITY_A_DOC);
  });

  it('refuses a cross-identity write with the flag off as well', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));
    const before = structuredClone(settings().docs);

    await expect(
      updatePersonalityConfig(FAKE_DB.asDb(), 'agent-b', VALID_PATCH, untrusted('agent-a')),
    ).rejects.toBeInstanceOf(PersonalityAccessError);

    expect(settings().docs).toEqual(before);
  });

  it('allows a trusted caller to write for a named identity (admin path)', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';

    const resolved = await updatePersonalityConfig(FAKE_DB.asDb(), 'agent-b', VALID_PATCH, TRUSTED);

    expect(resolved.user_id).toBe('agent-b');
    expect(settings().docs.find((d) => d.key === personalityConfigKey('agent-b'))!.personality).toBe('analyst');
    // Nothing is ever created for another identity.
    expect(settings().docs.some((d) => d.key === personalityConfigKey('operator'))).toBe(false);
  });

  it('flag ON: a write by A changes only A', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    settings().docs.push(structuredClone(IDENTITY_A_DOC));
    const bBefore = { key: personalityConfigKey('agent-b'), personality: 'sentinel', source_weights: {}, scoring: {}, origin: 'identity', version: 2, updated_at: '2026-09-11T00:00:00.000Z' };
    settings().docs.push(structuredClone(bBefore));

    await updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', VALID_PATCH, untrusted('agent-a'));

    expect(settings().docs.find((d) => d.key === personalityConfigKey('agent-b'))).toEqual(bBefore);
    expect(settings().docs.find((d) => d.key === IDENTITY_A_KEY)!.personality).toBe('analyst');
  });
});

// ── Concurrent writes (version increments are never lost) ───────────────

const PATCH_ANALYST = {
  personality: 'analyst',
  source_weights: { vector_search: 6 },
  scoring: {},
  max_context_tokens: 6000,
};
const PATCH_SENTINEL = {
  personality: 'sentinel',
  source_weights: { missions: 9 },
  scoring: {},
  max_context_tokens: 7000,
};

/**
 * Give `findOne` real-driver semantics (a fresh document per read). The fake
 * hands out live references, which would let two racing writers observe each
 * other's writes — making the fake *more* forgiving than MongoDB and hiding
 * exactly the lost-update bug these tests exist to catch.
 */
function snapshotReads(): void {
  const realFindOne = settings().findOne.bind(settings());
  vi.spyOn(settings(), 'findOne').mockImplementation(
    async (filter: Record<string, any>, opts?: any) => {
      const doc = await realFindOne(filter, opts);
      return doc ? structuredClone(doc) : null;
    },
  );
}

describe('updatePersonalityConfig — concurrent writes keep every increment', () => {
  beforeEach(() => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
  });

  it('two interleaved updates on an existing record land as sequential increments', async () => {
    settings().docs.push(structuredClone(IDENTITY_A_DOC)); // version 4
    snapshotReads();

    const [first, second] = await Promise.all([
      updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', PATCH_ANALYST, untrusted('agent-a')),
      updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', PATCH_SENTINEL, untrusted('agent-a')),
    ]);

    // Both writes are counted: the loser of the race retried against the
    // version it had not seen, instead of overwriting it (the pre-fix code
    // reported 5 twice and stored 5).
    expect([first.version, second.version]).toEqual([5, 6]);

    const stored = settings().docs.find((d) => d.key === IDENTITY_A_KEY)!;
    expect(stored.version).toBe(6);
    expect(first.profile).toBe('analyst');
    // The record holds the last writer's payload — not a blend, and not the
    // payload of the writer that reported the lower version.
    expect(stored.personality).toBe(second.profile);
    expect(stored.source_weights).toEqual(PATCH_SENTINEL.source_weights);
    // One record for the identity, and the legacy record stays untouched.
    expect(settings().docs.filter((d) => d.key === IDENTITY_A_KEY)).toHaveLength(1);
    expect(settings().docs.some((d) => d.key === LEGACY_KEY)).toBe(false);
  });

  it('two concurrent creates (no record yet) land as version 1 then 2', async () => {
    snapshotReads();

    const [first, second] = await Promise.all([
      updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', PATCH_ANALYST, untrusted('agent-a')),
      updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', PATCH_SENTINEL, untrusted('agent-a')),
    ]);

    expect([first.version, second.version]).toEqual([1, 2]);

    const stored = settings().docs.filter((d) => d.key === IDENTITY_A_KEY);
    expect(stored).toHaveLength(1);
    expect(stored[0].version).toBe(2);
    expect(stored[0].origin).toBe('identity');
    expect(stored[0].personality).toBe(second.profile);
  });

  it('a competing write between our read and our write costs a retry, never an overwrite', async () => {
    settings().docs.push(structuredClone(IDENTITY_A_DOC)); // version 4
    const realUpdateOne = settings().updateOne.bind(settings());
    let injected = false;
    vi.spyOn(settings(), 'updateOne').mockImplementation(async (filter: any, update: any, opts?: any) => {
      if (!injected) {
        injected = true;
        // A competing writer lands between our read and our first guarded
        // write: the stored record moves to version 5.
        const doc = settings().docs.find((d) => d.key === IDENTITY_A_KEY)!;
        doc.version = doc.version + 1;
        doc.personality = 'sentinel';
      }
      return realUpdateOne(filter, update, opts);
    });

    const resolved = await updatePersonalityConfig(
      FAKE_DB.asDb(),
      'agent-a',
      PATCH_ANALYST,
      untrusted('agent-a'),
    );

    // Our write is version 6 — the competing increment (5) survives, so the
    // reported version is the one that is actually stored.
    expect(resolved.version).toBe(6);
    expect(resolved.profile).toBe('analyst');
    const stored = settings().docs.find((d) => d.key === IDENTITY_A_KEY)!;
    expect(stored.version).toBe(6);
    expect(stored.personality).toBe('analyst');
  });

  it('still version-bumps a record that carries no version field', async () => {
    // A hand-written / pre-versioned identity record must not become
    // permanently unwritable: the guard falls back to "no version yet".
    settings().docs.push({ key: IDENTITY_A_KEY, personality: 'dreamer', source_weights: {}, scoring: {} });

    const resolved = await updatePersonalityConfig(
      FAKE_DB.asDb(),
      'agent-a',
      PATCH_ANALYST,
      untrusted('agent-a'),
    );

    expect(resolved.version).toBe(1);
    expect(settings().docs.find((d) => d.key === IDENTITY_A_KEY)!.version).toBe(1);
  });

  it('gives up loudly instead of reporting a version that was never stored', async () => {
    settings().docs.push(structuredClone(IDENTITY_A_DOC));
    const before = structuredClone(settings().docs);
    // Every guarded attempt misses (a pathological amount of contention).
    vi.spyOn(settings(), 'updateOne').mockImplementation(async () => ({
      acknowledged: true,
      matchedCount: 0,
    }));

    await expect(
      updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', PATCH_ANALYST, untrusted('agent-a')),
    ).rejects.toBeInstanceOf(PersonalityWriteConflictError);

    expect(settings().docs).toEqual(before);
  });
});

// ── Guarded create, repairable versions, per-attempt timestamps ──────────

/** A write that actually landed, with the version it stored. */
interface LandedWrite {
  version: unknown;
  personality: unknown;
}

/**
 * Record every write that lands: an insert (the collection grew) or a filter
 * that matched. A miss — including the unique `key` index refusing a duplicate
 * insert — did not land and is not recorded. Two landed writes at one version,
 * or a landed write that moved the version by anything but one, is exactly the
 * silent payload loss these tests exist to catch.
 *
 * `onFirstUpsert` runs once, just before the first upsert-insert attempt: the
 * hook that lets a test land a competing writer between our read and our write.
 */
function trackLandedWrites(onFirstUpsert?: () => void): LandedWrite[] {
  const landed: LandedWrite[] = [];
  let notified = false;
  const realUpdateOne = settings().updateOne.bind(settings());
  vi.spyOn(settings(), 'updateOne').mockImplementation(async (filter: any, update: any, opts?: any) => {
    if (opts?.upsert && !notified) {
      notified = true;
      onFirstUpsert?.();
    }
    const before = settings().docs.length;
    const result = await realUpdateOne(filter, update, opts);
    if (settings().docs.length > before || (result.matchedCount ?? 0) > 0) {
      landed.push({ version: update?.$set?.version, personality: update?.$set?.personality });
    }
    return result;
  });
  return landed;
}

describe('updatePersonalityConfig — guarded create and repairable versions', () => {
  beforeEach(() => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
  });

  it('two concurrent creates keep both increments and never discard a payload', async () => {
    snapshotReads();
    const landed = trackLandedWrites();

    const [first, second] = await Promise.all([
      updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', PATCH_ANALYST, untrusted('agent-a')),
      updatePersonalityConfig(FAKE_DB.asDb(), 'agent-a', PATCH_SENTINEL, untrusted('agent-a')),
    ]);

    // Exactly two writes landed, at versions 1 and 2: the loser of the create
    // race re-read the winner's record and bumped it, instead of writing
    // version 1 over it. (Pre-fix: landed [1, 1, 2] — the first payload was
    // replaced without any increment.)
    const landedVersions = landed.map((w) => w.version);
    expect(landedVersions, `landed writes: ${JSON.stringify(landed)}`).toEqual([1, 2]);
    expect(landed).toHaveLength(2);

    expect([first.version, second.version].sort((a, b) => a - b)).toEqual([1, 2]);
    const stored = settings().docs.filter((d) => d.key === IDENTITY_A_KEY);
    expect(stored).toHaveLength(1);
    // version = the number of successful writes.
    expect(stored[0].version).toBe(2);
    expect(stored[0].origin).toBe('identity');
    // The record holds the payload of the write that bumped it last — nothing
    // was blended, and no payload was dropped without an increment.
    const bumped = first.version === 2 ? first : second;
    expect(stored[0].personality).toBe(bumped.profile);
    expect(stored[0].source_weights).toEqual(bumped.source_weights);
  });

  it('a record another writer creates mid-flight is never overwritten without an increment', async () => {
    snapshotReads();
    const competitor = {
      key: IDENTITY_A_KEY,
      personality: 'sentinel',
      source_weights: { missions: 9 },
      scoring: {},
      origin: 'identity',
      version: 7,
      updated_at: '2026-09-12T00:00:00.000Z',
    };
    const landed = trackLandedWrites(() => {
      settings().docs.push(structuredClone(competitor));
    });

    const resolved = await updatePersonalityConfig(
      FAKE_DB.asDb(),
      'agent-a',
      PATCH_ANALYST,
      untrusted('agent-a'),
    );

    // Our write landed on top of the competing record: 7 → 8, so its seven
    // increments survive. (Pre-fix the create branch's unguarded upsert matched
    // that record and stored version 1 with our payload — the competitor's
    // payload and its whole version history were discarded without an
    // increment, which is the loss this guard exists to prevent.)
    expect(resolved.version).toBe(8);
    const stored = settings().docs.filter((d) => d.key === IDENTITY_A_KEY);
    expect(stored).toHaveLength(1);
    expect(stored[0].version).toBe(8);
    expect(stored[0].personality).toBe('analyst');
    expect(stored[0].source_weights).toEqual(PATCH_ANALYST.source_weights);
    // One landed write, at the version it stored — nothing was written twice.
    expect(landed.map((w) => w.version)).toEqual([8]);
  });

  it.each([
    ['a string version', '4'],
    ['a null version', null],
  ])('a record whose stored version is %s is writable and re-versioned', async (_label, storedVersion) => {
    settings().docs.push({
      key: IDENTITY_A_KEY,
      personality: 'dreamer',
      source_weights: { working_memory: 2 },
      scoring: {},
      origin: 'identity',
      version: storedVersion,
      updated_at: '2026-09-10T10:00:00.000Z',
    });

    // No usable version is reported…
    expect((await resolvePersonalityConfig(FAKE_DB.asDb(), 'agent-a')).version).toBe(0);

    // …and the record is still writable: the guard pins the RAW value it read.
    // (Pre-fix the guard asked for the ABSENCE of the field, which a record
    // that has one never satisfies, so every attempt missed and the write
    // ended in a 409 — permanently unwritable.)
    const resolved = await updatePersonalityConfig(
      FAKE_DB.asDb(),
      'agent-a',
      PATCH_ANALYST,
      untrusted('agent-a'),
    );

    expect(resolved.version).toBe(1);
    const doc = settings().docs.find((d) => d.key === IDENTITY_A_KEY)!;
    expect(doc.version).toBe(1);
    expect(doc.personality).toBe('analyst');
  });

  it('a raw-version record stays writable after a concurrent change to it', async () => {
    settings().docs.push({
      key: IDENTITY_A_KEY,
      personality: 'dreamer',
      source_weights: {},
      scoring: {},
      origin: 'identity',
      version: '4',
      updated_at: '2026-09-10T10:00:00.000Z',
    });
    const realUpdateOne = settings().updateOne.bind(settings());
    let competing = false;
    vi.spyOn(settings(), 'updateOne').mockImplementation(async (filter: any, update: any, opts?: any) => {
      if (!competing) {
        competing = true;
        // Someone else moves the raw value while our first attempt is in
        // flight, and that attempt matches nothing.
        settings().docs.find((d) => d.key === IDENTITY_A_KEY)!.version = '5';
        return { acknowledged: true, matchedCount: 0 };
      }
      return realUpdateOne(filter, update, opts);
    });

    const resolved = await updatePersonalityConfig(
      FAKE_DB.asDb(),
      'agent-a',
      PATCH_ANALYST,
      untrusted('agent-a'),
    );

    // The retry pinned the raw value it re-read ('5') and landed. A guard on
    // the absence of the field could never match a record that has one, so the
    // write would have exhausted its attempts and reported a conflict.
    expect(resolved.version).toBe(1);
    const doc = settings().docs.find((d) => d.key === IDENTITY_A_KEY)!;
    expect(doc.version).toBe(1);
    expect(doc.personality).toBe('analyst');
  });

  it('stamps the timestamp of the attempt that landed, not the one the request started with', async () => {
    settings().docs.push(structuredClone(IDENTITY_A_DOC)); // version 4
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-25T10:00:00.000Z'));
      const realUpdateOne = settings().updateOne.bind(settings());
      let competing = false;
      vi.spyOn(settings(), 'updateOne').mockImplementation(async (filter: any, update: any, opts?: any) => {
        if (!competing) {
          competing = true;
          // The first guarded attempt loses the race (a competitor bumps the
          // record 4 → 5) and five minutes pass before the retry lands.
          const doc = settings().docs.find((d) => d.key === IDENTITY_A_KEY)!;
          doc.version += 1;
          vi.setSystemTime(new Date('2026-09-25T10:05:00.000Z'));
          return { acknowledged: true, matchedCount: 0 };
        }
        return realUpdateOne(filter, update, opts);
      });

      const resolved = await updatePersonalityConfig(
        FAKE_DB.asDb(),
        'agent-a',
        PATCH_ANALYST,
        untrusted('agent-a'),
      );

      expect(resolved.version).toBe(6);
      // The record says when it was actually written, not when the request
      // began. (Pre-fix the timestamp was captured before the loop, so a
      // retried write claimed a time five minutes in the past.)
      expect(resolved.updated_at).toBe('2026-09-25T10:05:00.000Z');
      const stored = settings().docs.find((d) => d.key === IDENTITY_A_KEY)!;
      expect(stored.updated_at).toBeInstanceOf(Date);
      expect((stored.updated_at as Date).toISOString()).toBe('2026-09-25T10:05:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Validation parity with the pre-iteration sanitiser ───────────────────
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PRE_CHANGE_COMMIT = '48ba7e6';
const PRE_CHANGE_FILE = 'server/src/routes/admin-routes.ts';

/** The old route's sanitising block, extracted from git and compiled. */
function extractPreviousSanitizer(): (body: unknown) => any {
  const src = execFileSync('git', ['show', `${PRE_CHANGE_COMMIT}:${PRE_CHANGE_FILE}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const start = src.indexOf('const { personality, source_weights, scoring, max_context_tokens } = body;');
  const end = src.indexOf('const db = get_database();', start);
  if (start < 0 || end < start) throw new Error('pre-change sanitiser block not found in git');

  const block = src.slice(start, end);
  for (const marker of ['cleanWeights', 'cleanScoring', 'const budget']) {
    if (!block.includes(marker)) throw new Error(`pre-change sanitiser is missing ${marker}`);
  }

  // The block is TypeScript (`: Record<string, number>` annotations); compile
  // it instead of transcribing it, so the comparison is against git's code.
  const js = transformSync(block, { loader: 'ts' }).code;
  const factory = new Function(
    'PROFILES',
    'ALL_SOURCES',
    'c',
    `return function (body) {\n${js}\nreturn { personality, source_weights: cleanWeights, scoring: cleanScoring, max_context_tokens: budget }; };`,
  );
  return factory(PROFILES, ALL_SOURCES, {
    json: (payload: any, status: number) => ({ rejected: payload?.error, status }),
  });
}

type Outcome =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string };

function previousOutcome(sanitize: (body: unknown) => any, body: unknown): Outcome | 'threw' {
  try {
    const out = sanitize(body);
    if (out && out.rejected !== undefined) return { ok: false, error: out.rejected };
    return {
      ok: true,
      patch: {
        personality: out.personality,
        source_weights: out.source_weights,
        scoring: out.scoring,
        max_context_tokens: out.max_context_tokens,
      },
    };
  } catch {
    return 'threw';
  }
}

function currentOutcome(body: unknown): Outcome | 'threw' {
  try {
    const res = sanitizePersonalityPatch(body);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      patch: {
        personality: res.patch.personality,
        source_weights: res.patch.source_weights,
        scoring: res.patch.scoring,
        max_context_tokens: res.patch.max_context_tokens,
      },
    };
  } catch {
    return 'threw';
  }
}

const VALIDATION_CASES: Array<[string, unknown]> = [
  ['missing profile', {}],
  ['blank profile', { personality: '' }],
  ['non-string profile', { personality: 42 }],
  ['null profile', { personality: null }],
  ['unknown profile', { personality: 'does-not-exist' }],
  ['unknown profile (wrong case)', { personality: 'Balanced' }],
  ['valid profile, no overrides', { personality: 'balanced' }],
  ['valid profile with empty overrides', { personality: 'legacy', source_weights: {}, scoring: {} }],
  [
    'unknown source dropped',
    { personality: 'balanced', source_weights: { not_a_source: 5, missions: 3 } },
  ],
  [
    'agent_message override skipped',
    { personality: 'balanced', source_weights: { agent_message: 0, missions: 4 } },
  ],
  [
    'weights clamped to 0..10',
    { personality: 'balanced', source_weights: { missions: 999, vector_search: -12 } },
  ],
  [
    'non-numeric weights dropped, numeric strings kept',
    { personality: 'balanced', source_weights: { missions: 'not-a-number', vector_search: '7.5', working_memory: null } },
  ],
  [
    'non-object weight map ignored',
    { personality: 'balanced', source_weights: 'nope' },
  ],
  [
    'unknown scoring keys dropped',
    { personality: 'balanced', scoring: { unknown_scoring_key: 1, relevance_multiplier: 3 } },
  ],
  [
    'scoring values pass through',
    { personality: 'balanced', scoring: { relevance_multiplier: 5, recency_half_life_days: 30, budget_floors: { working_memory: 900 }, max_single_source_pct: 0.9, vector_fetch_limit: 25, vector_sample: false, min_fetch_weight: 0.1 } },
  ],
  ['non-object scoring ignored', { personality: 'balanced', scoring: 42 }],
  ['budget below the floor is clamped', { personality: 'balanced', max_context_tokens: 100 }],
  ['budget above the ceiling is clamped', { personality: 'balanced', max_context_tokens: 999999 }],
  ['usable budget is kept', { personality: 'scholar', max_context_tokens: 12345 }],
  ['numeric-string budget is kept', { personality: 'scholar', max_context_tokens: '7500' }],
  ['unusable budget is dropped', { personality: 'balanced', max_context_tokens: 'lots' }],
  ['null body', null],
  ['string body', 'not-an-object'],
];

describe('sanitizePersonalityPatch — parity with the pre-iteration PUT sanitiser', () => {
  it('extracts the sanitiser from 48ba7e6 (the block exists and compiles)', () => {
    const sanitize = extractPreviousSanitizer();
    const out = sanitize({ personality: 'balanced', source_weights: { missions: 3 } });
    expect(out.personality).toBe('balanced');
    expect(out.source_weights).toEqual({ missions: 3 });
  });

  it.each(VALIDATION_CASES)('%s', (_name, body) => {
    const previous = extractPreviousSanitizer();
    const oldResult = previousOutcome(previous, body);
    const newResult = currentOutcome(body);
    expect(newResult).toEqual(oldResult);
  });

  it('keeps the exact legacy error strings', () => {
    const missing = sanitizePersonalityPatch({});
    expect(missing).toEqual({ ok: false, error: 'personality (profile name) is required' });

    const unknown = sanitizePersonalityPatch({ personality: 'nope' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toBe(`Unknown personality 'nope'. Valid: ${Object.keys(PROFILES).join(', ')}`);
    }
  });

  it('accepts the accepted cases with the documented values', () => {
    const clamped = sanitizePersonalityPatch({
      personality: 'balanced',
      source_weights: { missions: 999, vector_search: -12, agent_message: 0, bogus: 1 },
      scoring: { relevance_multiplier: 4, bogus: 1 },
      max_context_tokens: 100,
    });
    expect(clamped).toEqual({
      ok: true,
      patch: {
        personality: 'balanced',
        source_weights: { missions: 10, vector_search: 0 },
        scoring: { relevance_multiplier: 4 },
        max_context_tokens: 500,
      },
    });
  });

  it('drops an unusable budget so the stored one survives', () => {
    const noBudget = sanitizePersonalityPatch({ personality: 'balanced', max_context_tokens: 'lots' });
    expect(noBudget.ok).toBe(true);
    if (noBudget.ok) expect('max_context_tokens' in noBudget.patch).toBe(false);
  });
});
