/**
 * ITER-2 — per-identity personality REST surface.
 * Contract: CONTRACT-iter2-per-identity-personality.md
 *
 * Drives the real Hono router (admin router + caller-auth middleware) through
 * `app.request`, so both auth layers and the caller-pinning are exercised:
 *
 *   - the endpoints left the no-auth allowlists: no key → 401;
 *   - a mapped client key reads/writes only its OWN record, in both flag
 *     states, and never another identity's;
 *   - `?user_id=<other>` → 401 without the admin key (and nothing is written);
 *   - the admin key may read/write a named identity;
 *   - flag off = today: writes go to the legacy global record and no identity
 *     document is created; flag on = each identity independent (the Phase 1
 *     exit criterion), with `origin` reported as identity / legacy / default.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB.asDb(),
  is_database_connected: () => true,
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { Hono } from 'hono';

import { FakeDb } from '../helpers/fake-mongo.js';
import { createCallerAuthMiddleware } from '../../src/middleware/caller-auth.js';
import { create_admin_routes } from '../../src/routes/admin-routes.js';
import {
  clearClientKeyIdentities,
  ensureApiKeys,
  hashApiKey,
  registerClientKeyIdentity,
} from '../../src/utils/api-key-manager.js';

const FAKE_DB = new FakeDb();
const settings = () => FAKE_DB.collection('system_settings');
/** The personality records only — `ensureApiKeys()` also seeds generated_api_keys. */
const personalityDocs = () => settings().docs.filter((d) => String(d.key).startsWith('personality_config'));

const ADMIN_KEY = 'katra-admin-iter2-personality-key';
const AGENT_A_KEY = 'katra-agent-a-iter2-personality-key';
const AGENT_B_KEY = 'katra-agent-b-iter2-personality-key';

const LEGACY_KEY = 'personality_config';
const keyFor = (userId: string) => `personality_config:${userId}`;

const LEGACY_DOC = {
  key: LEGACY_KEY,
  personality: 'scholar',
  source_weights: { vector_search: 7 },
  scoring: { relevance_multiplier: 3 },
  max_context_tokens: 8000,
  updated_at: new Date('2026-09-01T00:00:00.000Z'),
};

const envNames = ['MCP_API_KEY', 'ADMIN_API_KEY', 'KATRA_API_KEY', 'BACKUP_MCP_KEYS', 'BACKUP_KATRA_KEYS'];

const app = new Hono();
app.use('/api/*', createCallerAuthMiddleware());
app.route('/api/v1/admin', create_admin_routes());

async function call(
  method: 'GET' | 'PUT',
  path: string,
  opts: { key?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.key) headers['Authorization'] = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(`http://localhost/api/v1/admin${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

const VALID_BODY = {
  personality: 'analyst',
  source_weights: { vector_search: 6 },
  scoring: { relevance_multiplier: 2.5 },
  max_context_tokens: 6000,
};

beforeEach(async () => {
  FAKE_DB.reset();
  clearClientKeyIdentities();
  for (const name of envNames) delete process.env[name];
  delete process.env.PER_IDENTITY_PERSONALITY;
  process.env.MCP_API_KEY = 'katra-mcp-iter2-personality-key';
  process.env.KATRA_API_KEY = ADMIN_KEY;
  await ensureApiKeys();
  registerClientKeyIdentity(hashApiKey(AGENT_A_KEY), 'agent-a');
  registerClientKeyIdentity(hashApiKey(AGENT_B_KEY), 'agent-b');
});

afterEach(() => {
  FAKE_DB.reset();
  clearClientKeyIdentities();
  for (const name of envNames) delete process.env[name];
  delete process.env.PER_IDENTITY_PERSONALITY;
});

describe('personality REST — authentication (left the no-auth allowlist)', () => {
  it('GET /personality without a key → 401', async () => {
    const res = await call('GET', '/personality');
    expect(res.status).toBe(401);
  });

  it('GET /personality?user_id= without a key → 401', async () => {
    const res = await call('GET', '/personality?user_id=agent-a');
    expect(res.status).toBe(401);
  });

  it('PUT /personality without a key → 401 and nothing is written', async () => {
    const res = await call('PUT', '/personality', { body: VALID_BODY });
    expect(res.status).toBe(401);
    expect(personalityDocs()).toHaveLength(0);
  });

  it('GET /personality/profiles stays public (static catalogue)', async () => {
    const res = await call('GET', '/personality/profiles');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body.profiles).length).toBeGreaterThan(0);
  });

  it('an unmapped key is rejected → 401', async () => {
    const res = await call('GET', '/personality', { key: 'katra-unknown-iter2-key' });
    expect(res.status).toBe(401);
  });
});

describe('personality REST — flag OFF keeps today’s global behaviour', () => {
  it('a mapped caller reads the legacy record and nothing is created', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));

    const res = await call('GET', '/personality', { key: AGENT_A_KEY });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.resolved_for).toBe('agent-a');
    expect(res.body.origin).toBe('legacy');
    expect(res.body.version).toBe(0);
    expect(res.body.per_identity_enabled).toBe(false);
    expect(res.body.config.personality).toBe('scholar');
    expect(res.body.config.source_weights).toEqual({ vector_search: 7 });
    expect(res.body.config.max_context_tokens).toBe(8000);
    expect(res.body.config.updated_at).toBe('2026-09-01T00:00:00.000Z');
    expect(personalityDocs()).toHaveLength(1);
  });

  it('no record anywhere → origin default with the balanced profile', async () => {
    const res = await call('GET', '/personality', { key: AGENT_A_KEY });

    expect(res.status).toBe(200);
    expect(res.body.origin).toBe('default');
    expect(res.body.version).toBe(0);
    expect(res.body.config.personality).toBe('balanced');
    expect(res.body.config.updated_at).toBeNull();
  });

  it('PUT writes the legacy global record and creates no identity document', async () => {
    const res = await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.resolved_for).toBe('agent-a');
    expect(res.body.origin).toBe('legacy');
    expect(res.body.version).toBe(0);

    expect(personalityDocs().map((d) => d.key)).toEqual([LEGACY_KEY]);
    expect(personalityDocs()[0].personality).toBe('analyst');
    expect(personalityDocs()[0].version).toBeUndefined();
    expect(settings().docs.some((d) => d.key === keyFor('agent-a'))).toBe(false);
  });

  it('two identities still share the one legacy record (flag off = today)', async () => {
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    const a = await call('GET', '/personality', { key: AGENT_A_KEY });
    const b = await call('GET', '/personality', { key: AGENT_B_KEY });

    expect(a.body.config.personality).toBe('analyst');
    expect(b.body.config.personality).toBe('analyst');
    expect([a.body.origin, b.body.origin]).toEqual(['legacy', 'legacy']);
  });

  it('a caller naming its own identity is served with the flag off too', async () => {
    // The bridge sends `?user_id=` unconditionally (ITER-3), so the allowance
    // must not depend on which record the flag resolves.
    settings().docs.push(structuredClone(LEGACY_DOC));

    const named = await call('GET', '/personality?user_id=agent-a', { key: AGENT_A_KEY });
    const omitted = await call('GET', '/personality', { key: AGENT_A_KEY });

    expect(named.status).toBe(200);
    expect(named.body).toEqual(omitted.body);
    expect(named.body.resolved_for).toBe('agent-a');
    expect(named.body.origin).toBe('legacy');
    expect(named.body.config.personality).toBe('scholar');
    expect(named.body.per_identity_enabled).toBe(false);

    // Nobody else's identity, same key.
    expect((await call('GET', '/personality?user_id=agent-b', { key: AGENT_A_KEY })).status).toBe(401);
  });

  it('flag OFF: the responses keep the pre-iteration shape and only add fields', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));

    const get = await call('GET', '/personality', { key: AGENT_A_KEY });
    expect(Object.keys(get.body).sort()).toEqual(
      ['base_profile', 'config', 'origin', 'per_identity_enabled', 'resolved_for', 'success', 'version'],
    );
    expect(Object.keys(get.body.config).sort()).toEqual(
      ['max_context_tokens', 'personality', 'scoring', 'source_weights', 'updated_at'],
    );

    const put = await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });
    expect(Object.keys(put.body).sort()).toEqual(
      ['config', 'message', 'origin', 'resolved_for', 'success', 'version'],
    );
    expect(Object.keys(put.body.config).sort()).toEqual(
      ['max_context_tokens', 'personality', 'scoring', 'source_weights'],
    );
    expect(put.body.message).toBe("Personality set to 'analyst'");
  });

  it('a legacy record with no stored budget falls back to the profile budget (parity with the old GET)', async () => {
    settings().docs.push({ key: LEGACY_KEY, personality: 'scholar', source_weights: {}, scoring: {} });

    const res = await call('GET', '/personality', { key: AGENT_A_KEY });

    expect(res.body.config.max_context_tokens).toBe(5000);
  });
});

describe('personality REST — flag ON gives each identity its own record', () => {
  beforeEach(() => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
  });

  it('two identities are independent end to end (Phase 1 exit criterion)', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));

    const writeA = await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });
    expect(writeA.status).toBe(200);
    expect(writeA.body.origin).toBe('identity');
    expect(writeA.body.version).toBe(1);
    expect(writeA.body.resolved_for).toBe('agent-a');

    const writeB = await call('PUT', '/personality', {
      key: AGENT_B_KEY,
      body: { personality: 'sentinel', source_weights: { missions: 8 } },
    });
    expect(writeB.status).toBe(200);
    expect(writeB.body.resolved_for).toBe('agent-b');

    const a = await call('GET', '/personality', { key: AGENT_A_KEY });
    const b = await call('GET', '/personality', { key: AGENT_B_KEY });

    expect(a.body.resolved_for).toBe('agent-a');
    expect(a.body.origin).toBe('identity');
    expect(a.body.config.personality).toBe('analyst');
    expect(a.body.config.source_weights).toEqual({ vector_search: 6 });

    expect(b.body.resolved_for).toBe('agent-b');
    expect(b.body.origin).toBe('identity');
    expect(b.body.config.personality).toBe('sentinel');
    expect(b.body.config.source_weights).toEqual({ missions: 8 });

    // Only the two identity records were created; the legacy record is intact.
    expect(settings().docs.find((d) => d.key === LEGACY_KEY)).toEqual(LEGACY_DOC);
    expect(settings().docs.filter((d) => d.key.startsWith('personality_config:')).map((d) => d.key).sort())
      .toEqual([keyFor('agent-a'), keyFor('agent-b')]);
  });

  it('an identity with no record resolves the legacy record, never the neighbour’s', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    const b = await call('GET', '/personality', { key: AGENT_B_KEY });

    expect(b.body.origin).toBe('legacy');
    expect(b.body.version).toBe(0);
    expect(b.body.config.personality).toBe('scholar');
    expect(b.body.config.source_weights).toEqual({ vector_search: 7 });
    expect(b.body.config.source_weights).not.toEqual({ vector_search: 6 });
    expect(settings().docs.some((d) => d.key === keyFor('agent-b'))).toBe(false);
  });

  it('removing an identity record falls back to legacy, then to defaults', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    expect((await call('GET', '/personality', { key: AGENT_A_KEY })).body.origin).toBe('identity');

    FAKE_DB.collection('system_settings').docs =
      settings().docs.filter((d) => d.key !== keyFor('agent-a'));
    const legacy = await call('GET', '/personality', { key: AGENT_A_KEY });
    expect(legacy.body.origin).toBe('legacy');
    expect(legacy.body.config.personality).toBe('scholar');

    FAKE_DB.collection('system_settings').docs = [];
    const defaults = await call('GET', '/personality', { key: AGENT_A_KEY });
    expect(defaults.body.origin).toBe('default');
    expect(defaults.body.config.personality).toBe('balanced');
  });

  it('a read never writes: GET on a populated store leaves it byte-identical', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });
    const before = structuredClone(settings().docs);

    await call('GET', '/personality', { key: AGENT_A_KEY });
    await call('GET', '/personality', { key: AGENT_B_KEY });

    expect(settings().docs).toEqual(before);
  });

  it('the version increments per write and remains server-owned', async () => {
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });
    const second = await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    expect(second.body.version).toBe(2);
    expect(settings().docs.find((d) => d.key === keyFor('agent-a'))!.version).toBe(2);
    expect(settings().docs.find((d) => d.key === keyFor('agent-a'))!.origin).toBe('identity');
  });

  it('a competing write between our read and our write costs a retry, not an overwrite', async () => {
    // The Hono pipeline serializes two parallel requests, so a genuine race is
    // injected deterministically: another writer bumps the record between this
    // PUT's read and its first guarded write. The route must still answer with
    // the version it actually stored (the competing increment survives) rather
    // than reporting — and storing — the stale one. (The unsynchronised
    // read/write race itself is proven in the service suite.)
    settings().docs.push({
      key: keyFor('agent-a'),
      personality: 'dreamer',
      source_weights: {},
      scoring: {},
      origin: 'identity',
      version: 4,
      updated_at: '2026-09-10T10:00:00.000Z',
    });
    const realUpdateOne = settings().updateOne.bind(settings());
    let injected = false;
    vi.spyOn(settings(), 'updateOne').mockImplementation(async (filter: any, update: any, opts?: any) => {
      if (!injected) {
        injected = true;
        const doc = settings().docs.find((d) => d.key === keyFor('agent-a'))!;
        doc.version = doc.version + 1; // 4 -> 5, by someone else
        doc.personality = 'sentinel';
      }
      return realUpdateOne(filter, update, opts);
    });

    const res = await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(6);
    const stored = settings().docs.find((d) => d.key === keyFor('agent-a'))!;
    expect(stored.version).toBe(6);
    expect(stored.personality).toBe('analyst');
  });

  it('an unwinnable race returns 409 with retry, never a version that was not stored', async () => {
    settings().docs.push(structuredClone(LEGACY_DOC));
    // Every guarded attempt misses — pathological contention.
    vi.spyOn(settings(), 'updateOne').mockImplementation(async () => ({
      acknowledged: true,
      matchedCount: 0,
    }));

    const res = await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.retry).toBe(true);
    expect(settings().docs.some((d) => d.key === keyFor('agent-a'))).toBe(false);
  });
});

describe('personality REST — caller pinning and ?user_id= (flag ON)', () => {
  beforeEach(() => {
    process.env.PER_IDENTITY_PERSONALITY = '1';
    settings().docs.push(structuredClone(LEGACY_DOC));
  });

  it('untrusted GET without ?user_id= returns only its own config', async () => {
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    const res = await call('GET', '/personality', { key: AGENT_B_KEY });

    expect(res.status).toBe(200);
    expect(res.body.resolved_for).toBe('agent-b');
    expect(JSON.stringify(res.body)).not.toContain('analyst');
  });

  it('untrusted GET ?user_id=<other> → 401 and no other identity’s data', async () => {
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    const res = await call('GET', '/personality?user_id=agent-a', { key: AGENT_B_KEY });

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('analyst');
    expect(JSON.stringify(res.body)).not.toContain('vector_search');
  });

  it('untrusted PUT ?user_id=<other> → 401 and no write anywhere', async () => {
    const before = structuredClone(settings().docs);
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });
    const afterA = structuredClone(settings().docs);

    const res = await call('PUT', '/personality?user_id=agent-a', { key: AGENT_B_KEY, body: { personality: 'dreamer' } });

    expect(res.status).toBe(401);
    // A's own record is exactly as it was — B's attempt changed nothing.
    expect(settings().docs).toEqual(afterA);
    expect(settings().docs).not.toEqual(before);
    expect(settings().docs.find((d) => d.key === keyFor('agent-a'))!.personality).toBe('analyst');
  });

  it('untrusted PUT of its own identity cannot name another one via the body', async () => {
    const res = await call('PUT', '/personality', {
      key: AGENT_B_KEY,
      body: { ...VALID_BODY, user_id: 'agent-a' },
    });

    expect(res.status).toBe(200);
    expect(res.body.resolved_for).toBe('agent-b');
    expect(settings().docs.some((d) => d.key === keyFor('agent-a'))).toBe(false);
    expect(settings().docs.find((d) => d.key === keyFor('agent-b'))!.personality).toBe('analyst');
  });

  it('the admin key can read another identity’s record', async () => {
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    const res = await call('GET', '/personality?user_id=agent-a', { key: ADMIN_KEY });

    expect(res.status).toBe(200);
    expect(res.body.resolved_for).toBe('agent-a');
    expect(res.body.config.personality).toBe('analyst');
  });

  it('the admin key can write another identity’s record', async () => {
    const res = await call('PUT', '/personality?user_id=agent-a', {
      key: ADMIN_KEY,
      body: { personality: 'sentinel' },
    });

    expect(res.status).toBe(200);
    expect(res.body.resolved_for).toBe('agent-a');
    expect(settings().docs.find((d) => d.key === keyFor('agent-a'))!.personality).toBe('sentinel');
    // No document is created for the admin's own identity.
    expect(settings().docs.filter((d) => d.key.startsWith('personality_config:')).length).toBe(1);
  });

  it('the admin key without ?user_id= acts for its own identity', async () => {
    const res = await call('PUT', '/personality', { key: ADMIN_KEY, body: VALID_BODY });
    const own = await call('GET', '/personality', { key: ADMIN_KEY });

    expect(res.status).toBe(200);
    expect(own.body.resolved_for).toBe(res.body.resolved_for);
    expect(own.body.origin).toBe('identity');
    expect(settings().docs.some((d) => d.key === keyFor(res.body.resolved_for))).toBe(true);
  });

  it('an empty ?user_id= is treated as the caller', async () => {
    const res = await call('GET', '/personality?user_id=', { key: AGENT_B_KEY });

    expect(res.status).toBe(200);
    expect(res.body.resolved_for).toBe('agent-b');
  });

  // ── ITER-3: naming your OWN identity is not naming another one ──────────
  // The Kolega bridge always sends `?user_id=<its identity>` (the endpoint is
  // caller-pinned), so that request must behave exactly like one that omits
  // the parameter — for every resolved caller, and only for its own id.

  it('untrusted GET ?user_id=<its own id> is identical to omitting the parameter', async () => {
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    const named = await call('GET', '/personality?user_id=agent-a', { key: AGENT_A_KEY });
    const omitted = await call('GET', '/personality', { key: AGENT_A_KEY });

    expect(named.status).toBe(200);
    expect(named.body).toEqual(omitted.body);
    expect(named.body.resolved_for).toBe('agent-a');
    expect(named.body.origin).toBe('identity');
    expect(named.body.config.personality).toBe('analyst');
  });

  it('untrusted PUT ?user_id=<its own id> writes its own record (the bridge’s request)', async () => {
    const res = await call('PUT', '/personality?user_id=agent-b', { key: AGENT_B_KEY, body: VALID_BODY });

    expect(res.status).toBe(200);
    expect(res.body.resolved_for).toBe('agent-b');
    expect(res.body.version).toBe(1);
    expect(settings().docs.find((d) => d.key === keyFor('agent-b'))!.personality).toBe('analyst');
    // Naming itself still never touches anybody else's record.
    expect(settings().docs.some((d) => d.key === keyFor('agent-a'))).toBe(false);
  });

  it('every caller may name itself, and only itself', async () => {
    for (const [key, own, other] of [
      [AGENT_A_KEY, 'agent-a', 'agent-b'],
      [AGENT_B_KEY, 'agent-b', 'agent-a'],
    ] as const) {
      const mine = await call('GET', `/personality?user_id=${own}`, { key });
      const theirs = await call('GET', `/personality?user_id=${other}`, { key });

      expect(mine.status, `${own} naming itself`).toBe(200);
      expect(mine.body.resolved_for).toBe(own);
      expect(theirs.status, `${own} naming ${other}`).toBe(401);
      expect(JSON.stringify(theirs.body)).not.toContain('analyst');
    }
  });

  it('an unnamed default is not "own id": ?user_id=katra is still admin-gated', async () => {
    const res = await call('GET', '/personality?user_id=katra', { key: AGENT_A_KEY });

    expect(res.status).toBe(401);
  });

  it('the gate and the handler agree on trimming the parameter', async () => {
    await call('PUT', '/personality', { key: AGENT_A_KEY, body: VALID_BODY });

    const padded = await call('GET', '/personality?user_id=%20agent-a%20', { key: AGENT_A_KEY });

    expect(padded.status).toBe(200);
    expect(padded.body.resolved_for).toBe('agent-a');
  });
});

describe('personality REST — docs and allowlists stay consistent', () => {
  const callerAuth = readFileSync(new URL('../../src/middleware/caller-auth.ts', import.meta.url), 'utf8');
  const adminRoutes = readFileSync(new URL('../../src/routes/admin-routes.ts', import.meta.url), 'utf8');
  const apiReference = readFileSync(new URL('../../../docs/API-REFERENCE.md', import.meta.url), 'utf8');
  const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const changelog = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');

  function block(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
    const end = source.indexOf(endMarker, start);
    expect(end, `${endMarker} not found`).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('the caller-auth allowlist keeps only the static catalogue public', () => {
    const skipPaths = block(callerAuth, 'const AUTH_SKIP_PATHS', ']);');
    expect(skipPaths).toContain("'/api/v1/admin/personality/profiles'");
    expect(skipPaths).not.toContain("'/api/v1/admin/personality',");
  });

  it('the admin read-only list does not carry the caller-pinned path', () => {
    const readOnlyPaths = block(adminRoutes, 'const readOnlyPaths = [', '];');
    expect(readOnlyPaths).toContain("'/api/v1/admin/personality/profiles'");
    expect(readOnlyPaths).not.toContain("'/admin/personality',");
    expect(readOnlyPaths).not.toContain("'/api/v1/admin/personality',");
  });

  it('API-REFERENCE lists the caller-pinned path as authenticated', () => {
    const noAuth = block(apiReference, '**No-auth endpoints**', '**Caller-pinned**');
    expect(noAuth).toContain('/api/v1/admin/personality/profiles');
    expect(noAuth).not.toContain('`/api/v1/admin/personality`');
    const callerPinned = block(apiReference, '**Caller-pinned**', '**Admin-gated**');
    expect(callerPinned).toContain('`GET`/`PUT /api/v1/admin/personality`');
    const adminGated = block(apiReference, '**Admin-gated**', '## Response Format');
    expect(adminGated).toContain('/api/v1/admin/personality?user_id=');
  });

  it('README and the MCP tool reference agree on one tool count', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const mcpTools = readFileSync(new URL('../../../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    // The number both documents state is the REGISTERED surface — measured from
    // the module (all flags off) by tests/unit/mcp-tool-surface-docs.test.ts —
    // not the number of `###` catalogue headings, because the catalogue does
    // not repeat an entry for every vault_*/auth_* tool. This test only checks
    // the two documents against each other; that suite checks them against
    // reality.
    const header = mcpTools.match(/exposes \*\*(\d+) tools\*\*/)?.[1];
    expect(header).toBeTruthy();

    const readmeCounts = readme.match(/\*\*\d+\*\* specialized tools|\(\d+ tools\)|\*\*\d+ MCP tools\*\*|all \d+ tools/g) ?? [];
    expect(readmeCounts).toHaveLength(4);
    for (const mention of readmeCounts) {
      expect(mention, `README tool count disagrees with the MCP tool reference (${header})`).toContain(String(header));
    }
    // The pre-fix numbers (66 catalogued, 67 claimed) must not come back.
    expect(readme).not.toMatch(/\b6[67] tools\b/);
    expect(mcpTools).not.toMatch(/exposes \*\*6[67] tools\*\*/);
  });

  it('.env.example and the CHANGELOG document the flag', () => {
    expect(envExample).toContain('PER_IDENTITY_PERSONALITY');
    expect(envExample).toContain('1, true or yes');
    expect(changelog).toContain('PER_IDENTITY_PERSONALITY');
    expect(changelog).toContain('`get_my_personality` MCP tool');
  });
});

describe('personality REST — validation parity through the route', () => {
  it('rejects an unknown profile with the legacy 400 body', async () => {
    const res = await call('PUT', '/personality', { key: AGENT_A_KEY, body: { personality: 'nope' } });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Unknown personality 'nope'");
    expect(personalityDocs()).toHaveLength(0);
  });

  it('rejects a missing profile with the legacy 400 body', async () => {
    const res = await call('PUT', '/personality', { key: AGENT_A_KEY, body: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('personality (profile name) is required');
  });

  it('a malformed JSON body keeps the pre-iteration 500 path', async () => {
    const res = await app.request('http://localhost/api/v1/admin/personality', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_A_KEY}` },
      body: '{not json',
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'Internal server error' });
    expect(personalityDocs()).toHaveLength(0);
  });

  it('clamps and filters overrides, keeping agent_message unpinnable-by-caller', async () => {
    process.env.PER_IDENTITY_PERSONALITY = '1';

    const res = await call('PUT', '/personality', {
      key: AGENT_A_KEY,
      body: {
        personality: 'balanced',
        source_weights: { missions: 999, vector_search: -4, agent_message: 0, not_a_source: 3 },
        scoring: { relevance_multiplier: 4, not_a_scoring_key: 3 },
        max_context_tokens: 50,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.config.source_weights).toEqual({ missions: 10, vector_search: 0 });
    expect(res.body.config.scoring).toEqual({ relevance_multiplier: 4 });
    expect(res.body.config.max_context_tokens).toBe(500);
    expect(settings().docs.find((d) => d.key === keyFor('agent-a'))!.source_weights).toEqual({ missions: 10, vector_search: 0 });
  });
});
