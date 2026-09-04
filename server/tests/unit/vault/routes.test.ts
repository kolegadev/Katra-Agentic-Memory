/**
 * Unit tests: Katra Vault REST routes (F3) — contract success criteria 1–7, 10, 11.
 *
 * Real MongoDB via tests/helpers/db.ts: unique `test_`-prefixed collections
 * (test_secrets_f3 / test_vault_audit_f3), wiped in beforeEach, cleaned up in
 * afterAll. Skipped when no MongoDB is reachable (same skipIf convention as
 * the F2 vault suite). Callers are simulated with runWithCaller(...) around
 * each app.request — no HTTP listener or API-key registry needed, because the
 * route handlers read the caller exclusively from getCaller() (the identity
 * the caller-auth middleware would have installed in production).
 *
 * The store is injected through create_vault_routes({ store }) so tests can
 * use test_-prefixed collections; production index.ts mounts the factory with
 * defaults (criterion 11 asserted against the source below).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import {
  cleanupTestData,
  closeTestDB,
  getTestDB,
  testCollection,
} from '../../helpers/db.js';
import { runWithCaller } from '../../../src/utils/caller-identity.js';
import type { CallerIdentity } from '../../../src/utils/caller-identity.js';
import { create_vault_routes } from '../../../src/routes/vault-routes.js';
import { createVaultStore } from '../../../src/services/vault/store.js';
import { generateMasterKey } from '../../../src/services/vault/crypto.js';

const MONGO_URI =
  process.env.MONGODB_URI ||
  'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin';

// Probe connectivity (incl. auth) up front; skip the suite when unavailable.
let mongoAvailable = false;
try {
  const probe = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 2000,
    connectTimeoutMS: 2000,
  });
  await probe.connect();
  await probe.close();
  mongoAvailable = true;
} catch {
  mongoAvailable = false;
}

// ── Source-level guard: criterion 11 ─────────────────────────────
const INDEX_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../src/index.ts'),
  'utf8',
);
const CALLER_AUTH_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../src/middleware/caller-auth.ts'),
  'utf8',
);

describe('vault routes — index.ts mounting + auth (criterion 11)', () => {
  it('imports and mounts exactly one vault route', () => {
    expect(INDEX_SOURCE).toContain(
      "import { create_vault_routes } from './routes/vault-routes.js';",
    );
    const mounts = INDEX_SOURCE.match(/app\.route\('\/api\/v1\/vault', create_vault_routes\(\)\);/g);
    expect(mounts).toHaveLength(1);
  });

  it('mounts the vault route AFTER the caller-auth middleware (vault requires auth)', () => {
    const middlewareIdx = INDEX_SOURCE.indexOf(
      "app.use('/api/*', createCallerAuthMiddleware());",
    );
    const vaultIdx = INDEX_SOURCE.indexOf("app.route('/api/v1/vault', create_vault_routes());");
    expect(middlewareIdx).toBeGreaterThan(-1);
    expect(vaultIdx).toBeGreaterThan(middlewareIdx);
  });

  it('does NOT add vault paths to AUTH_SKIP_PATHS', () => {
    const start = CALLER_AUTH_SOURCE.indexOf('const AUTH_SKIP_PATHS');
    const end = CALLER_AUTH_SOURCE.indexOf(']);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const skipBlock = CALLER_AUTH_SOURCE.slice(start, end);
    expect(skipBlock.toLowerCase()).not.toContain('vault');
  });
});

// ── Route behaviour (real Mongo) ─────────────────────────────────
describe.skipIf(!mongoAvailable)('vault REST routes (F3) — contract criteria', () => {
  const SECRETS = testCollection('secrets_f3');
  const AUDIT = testCollection('vault_audit_f3');
  const SECRET_META_KEYS = new Set([
    'secret_id',
    'name',
    'owner',
    'acl',
    'service',
    'kind',
    'meta',
    'flags',
  ]);
  const AUDIT_KEYS = new Set(['at', 'actor', 'action', 'secret_id', 'service', 'outcome', 'error']);

  let db: Db;
  const MK = generateMasterKey();
  const VALUE = 'sk-f3-live-9c4e2b7a1f8d3c5e6a0b9d8e7c6f5a4b3c2d1e0f';
  const LILLY: CallerIdentity = { user_id: 'lilly', trusted: false };
  const SHOSHIN: CallerIdentity = { user_id: 'shoshin', trusted: false };
  const SATORI: CallerIdentity = { user_id: 'satori', trusted: true };

  let app: Hono;
  let noKeyApp: Hono;
  let savedMasterKeyEnv: string | undefined;

  beforeAll(async () => {
    db = await getTestDB();
    app = new Hono();
    app.route(
      '/api/v1/vault',
      create_vault_routes({
        store: createVaultStore({
          db,
          secretsCollection: SECRETS,
          auditCollection: AUDIT,
          masterKeyHex: MK,
        }),
      }),
    );
    // Master-key-less store for the 503 path; ensure the env fallback is off
    // (the store resolves KATRA_VAULT_MASTER_KEY per operation when no key is
    // passed explicitly).
    savedMasterKeyEnv = process.env.KATRA_VAULT_MASTER_KEY;
    delete process.env.KATRA_VAULT_MASTER_KEY;
    noKeyApp = new Hono();
    noKeyApp.route(
      '/api/v1/vault',
      create_vault_routes({
        store: createVaultStore({ db, secretsCollection: SECRETS, auditCollection: AUDIT }),
      }),
    );
  });

  beforeEach(async () => {
    await cleanupTestData('secrets_f3');
    await cleanupTestData('vault_audit_f3');
  });

  afterAll(async () => {
    if (savedMasterKeyEnv === undefined) delete process.env.KATRA_VAULT_MASTER_KEY;
    else process.env.KATRA_VAULT_MASTER_KEY = savedMasterKeyEnv;
    await cleanupTestData('secrets_f3');
    await cleanupTestData('vault_audit_f3');
    await closeTestDB();
  });

  async function req(
    target: Hono,
    caller: CallerIdentity,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return runWithCaller(caller, () =>
      target.request(`http://localhost/api/v1/vault${path}`, init),
    );
  }

  async function rawSecret(secretId: string): Promise<Record<string, any> | null> {
    return (await db.collection(SECRETS).findOne({ secret_id: secretId })) as Record<string, any> | null;
  }

  async function auditCount(): Promise<number> {
    return db.collection(AUDIT).countDocuments({});
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 1 ── untrusted private put: 201, owner pinned to caller ────────
  it('criterion 1: untrusted POST private secret → 201 and stored owner == caller', async () => {
    const res = await req(app, LILLY, 'POST', '/secrets', {
      name: 'agentmail-api-key',
      value: VALUE,
      service: 'agentmail',
    });
    expect(res.status).toBe(201);
    const text = await res.clone().text();
    const body: any = JSON.parse(text);
    expect(body).toEqual({ secret_id: 'lilly/agentmail-api-key', created: true });
    // Never echo the value anywhere in the response.
    expect(text).not.toContain(VALUE);

    const raw = await rawSecret('lilly/agentmail-api-key');
    expect(raw).not.toBeNull();
    expect(raw!.owner.user_id).toBe('lilly');
    expect(raw!.envelope).toBeDefined();
    expect(raw!.meta.created_by).toBe('lilly');
  });

  // 2 ── untrusted ownerUserId override is IGNORED ────────────────
  it('criterion 2: untrusted POST with ownerUserId → ignored, owner stays caller', async () => {
    // shoshin (untrusted) tries to create a secret owned by lilly — the
    // override must be ignored and the secret pinned to shoshin.
    const res = await req(app, SHOSHIN, 'POST', '/secrets', {
      name: 'gh-token',
      value: 'shoshin-token-value-1',
      ownerUserId: 'lilly',
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.secret_id).toBe('shoshin/gh-token');
    const raw = await rawSecret('shoshin/gh-token');
    expect(raw).not.toBeNull();
    expect(raw!.owner.user_id).toBe('shoshin');
    // and nothing was created under lilly's partition
    expect(await rawSecret('lilly/gh-token')).toBeNull();
  });

  // 3 ── trusted ownerUserId override is honored ──────────────────
  it('criterion 3: trusted POST with ownerUserId lilly → stored under lilly', async () => {
    const res = await req(app, SATORI, 'POST', '/secrets', {
      name: 'trusted-puts-for-lilly',
      value: 'value-sealed-for-lilly',
      ownerUserId: 'lilly',
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.secret_id).toBe('lilly/trusted-puts-for-lilly');
    const raw = await rawSecret('lilly/trusted-puts-for-lilly');
    expect(raw).not.toBeNull();
    expect(raw!.owner.user_id).toBe('lilly');
    expect(raw!.meta.created_by).toBe('satori'); // creator is still the caller
    // Lilly can see it; shoshin cannot.
    const shoshinList: any[] = await (await req(app, SHOSHIN, 'GET', '/secrets')).json();
    expect(shoshinList.map((s) => s.secret_id)).not.toContain('lilly/trusted-puts-for-lilly');
  });

  // 4 ── list scoping: private per-caller, team shared ────────────
  it('criterion 4: caller B cannot see caller A private; both see team secrets', async () => {
    await req(app, LILLY, 'POST', '/secrets', { name: 'lilly-only', value: 'v1' });
    await req(app, LILLY, 'POST', '/secrets', {
      name: 'team-token',
      value: 'v2',
      scope: 'team',
    });
    await req(app, SHOSHIN, 'POST', '/secrets', { name: 'shoshin-only', value: 'v3' });

    const lillyList: any[] = await (await req(app, LILLY, 'GET', '/secrets')).json();
    const lillyIds = lillyList.map((s) => s.secret_id);
    expect(lillyIds).toContain('lilly/lilly-only');
    expect(lillyIds).toContain('team:my-team/team-token');
    expect(lillyIds).not.toContain('shoshin/shoshin-only');

    const shoshinList: any[] = await (await req(app, SHOSHIN, 'GET', '/secrets')).json();
    const shoshinIds = shoshinList.map((s) => s.secret_id);
    expect(shoshinIds).toContain('shoshin/shoshin-only');
    expect(shoshinIds).toContain('team:my-team/team-token');
    expect(shoshinIds).not.toContain('lilly/lilly-only');

    // Team rows carry only shared_id, never a user_id.
    const team = shoshinList.find((s) => s.secret_id === 'team:my-team/team-token');
    expect(team!.owner).toEqual({ shared_id: 'my-team' });
  });

  // 5 ── GET meta: SecretMeta key set only; no envelope/value ─────
  it('criterion 5: GET secret response is SecretMeta only — no envelope/ciphertext/value', async () => {
    await req(app, LILLY, 'POST', '/secrets', {
      name: 'meta-check',
      value: VALUE,
      service: 'agentmail',
      kind: 'api_key',
    });
    const res = await req(app, LILLY, 'GET', `/secrets/${encodeURIComponent('lilly/meta-check')}`);
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    const body: any = JSON.parse(text);
    for (const key of Object.keys(body)) {
      expect(SECRET_META_KEYS.has(key)).toBe(true);
    }
    expect(text).not.toContain(VALUE);
    expect(text.toLowerCase()).not.toContain('envelope');
    expect(text.toLowerCase()).not.toContain('ciphertext');
    expect(text.toLowerCase()).not.toContain('dek');
    expect(text).toContain('"secret_id":"lilly/meta-check"');
  });

  // 6 ── delete/rotate RBAC: 403 non-owner + unchanged; owner 200 ─
  it('criterion 6: non-owner untrusted DELETE/rotate → 403, row unchanged; owner → 200', async () => {
    await req(app, LILLY, 'POST', '/secrets', {
      name: 'team-shared',
      value: 'shared-value',
      scope: 'team',
    });
    await req(app, LILLY, 'POST', '/secrets', { name: 'own-private', value: 'mine' });

    // shoshin can SEE the team secret (shared scope) but does not own it.
    const teamId = 'team:my-team/team-shared';
    const del = await req(app, SHOSHIN, 'DELETE', `/secrets/${encodeURIComponent(teamId)}`);
    expect(del.status).toBe(403);
    expect(await rawSecret(teamId)).not.toBeNull();

    const rot = await req(
      app,
      SHOSHIN,
      'POST',
      `/secrets/${encodeURIComponent(teamId)}/rotate`,
    );
    expect(rot.status).toBe(403);
    expect(await rawSecret(teamId)).not.toBeNull();

    // Owner: delete + rotate succeed.
    const ownerRot = await req(
      app,
      LILLY,
      'POST',
      `/secrets/${encodeURIComponent('lilly/own-private')}/rotate`,
    );
    expect(ownerRot.status).toBe(200);
    expect(await ownerRot.json()).toEqual({ rotated: true });

    const ownerDel = await req(
      app,
      LILLY,
      'DELETE',
      `/secrets/${encodeURIComponent('lilly/own-private')}`,
    );
    expect(ownerDel.status).toBe(200);
    expect(await ownerDel.json()).toEqual({ deleted: true });
    expect(await rawSecret('lilly/own-private')).toBeNull();
  });

  // 7 ── audit: untrusted own actor only; trusted sees all ────────
  it('criterion 7: REST audit is actor-scoped for untrusted and unrestricted for trusted', async () => {
    const put1 = await req(app, LILLY, 'POST', '/secrets', { name: 'aud-a', value: 'va' });
    const put1Body: any = await put1.json();
    const put2 = await req(app, SHOSHIN, 'POST', '/secrets', { name: 'aud-b', value: 'vb' });
    const put2Body: any = await put2.json();
    await sleep(20);
    await req(app, SATORI, 'POST', '/secrets', { name: 'aud-c', value: 'vc' });

    const lillyRows: any[] = await (await req(app, LILLY, 'GET', '/audit')).json();
    expect(lillyRows.length).toBeGreaterThan(0);
    for (const row of lillyRows) {
      expect(row.actor).toBe('lilly');
      for (const key of Object.keys(row)) expect(AUDIT_KEYS.has(key)).toBe(true);
    }
    expect(lillyRows.map((r) => r.secret_id)).toContain(put1Body.secret_id);
    expect(lillyRows.map((r) => r.secret_id)).not.toContain(put2Body.secret_id);

    // secret_id filter narrows trusted view.
    const satoriRows: any[] = await (
      await req(app, SATORI, 'GET', `/audit?secret_id=${encodeURIComponent(put2Body.secret_id)}`)
    ).json();
    expect(satoriRows.length).toBeGreaterThan(0);
    for (const row of satoriRows) expect(row.secret_id).toBe(put2Body.secret_id);
    expect(satoriRows.map((r) => r.actor)).toContain('shoshin');
  });

  it('REST audit is newest-first', async () => {
    const first = await req(app, LILLY, 'POST', '/secrets', { name: 'order-1', value: 'x1' });
    const firstId: any = (await first.json()).secret_id;
    await sleep(25);
    const second = await req(app, LILLY, 'POST', '/secrets', { name: 'order-2', value: 'x2' });
    const secondId: any = (await second.json()).secret_id;

    const rows: any[] = await (await req(app, LILLY, 'GET', '/audit')).json();
    expect(rows.length).toBe(2);
    expect(rows[0].secret_id).toBe(secondId);
    expect(rows[1].secret_id).toBe(firstId);
    expect(new Date(rows[0].at).getTime()).toBeGreaterThanOrEqual(
      new Date(rows[1].at).getTime(),
    );
  });

  it('REST audit defaults to limit 100 and honors an explicit limit', async () => {
    for (let i = 0; i < 105; i++) {
      await req(app, LILLY, 'POST', '/secrets', { name: `bulk-${i}`, value: `b${i}` });
    }
    const all: any[] = await (await req(app, LILLY, 'GET', '/audit')).json();
    expect(all).toHaveLength(100); // newest-first default cap
    const fifty: any[] = await (await req(app, LILLY, 'GET', '/audit?limit=50')).json();
    expect(fifty).toHaveLength(50);
  });

  // 10 ── master key missing: put → 503, list still 200 ───────────
  it('criterion 10: POST without master key → 503 with the exact phrase; GET list still 200', async () => {
    const res = await req(noKeyApp, LILLY, 'POST', '/secrets', {
      name: 'no-key-secret',
      value: 'secret-value-no-key',
    });
    expect(res.status).toBe(503);
    const bodyText = await res.clone().text();
    expect(bodyText).toContain('vault: master key not configured');
    expect(bodyText).not.toContain('secret-value-no-key');

    const list = await req(noKeyApp, LILLY, 'GET', '/secrets');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
  });

  // ── 400/404 shapes ─────────────────────────────────────────────
  it('returns 400 for bad input and 404 for unknown ids', async () => {
    expect((await req(app, LILLY, 'POST', '/secrets', {})).status).toBe(400);
    expect((await req(app, LILLY, 'POST', '/secrets', { name: 'x' })).status).toBe(400);
    expect(
      (await req(app, LILLY, 'POST', '/secrets', { name: 'x', value: 'v', scope: 'public' }))
        .status,
    ).toBe(400);
    expect(
      (await req(app, LILLY, 'POST', '/secrets', { name: 'x', value: 'v', kind: 'bogus' }))
        .status,
    ).toBe(400);
    expect((await req(app, LILLY, 'GET', `/secrets/${encodeURIComponent('lilly/ghost')}`)).status).toBe(404);
    expect((await req(app, LILLY, 'DELETE', `/secrets/${encodeURIComponent('lilly/ghost')}`)).status).toBe(404);
    expect(
      (await req(app, LILLY, 'POST', `/secrets/${encodeURIComponent('lilly/ghost')}/rotate`))
        .status,
    ).toBe(404);
    expect((await req(app, LILLY, 'GET', '/audit?limit=abc')).status).toBe(400);
    expect((await req(app, LILLY, 'GET', '/audit?limit=0')).status).toBe(400);
    expect((await req(app, LILLY, 'GET', '/audit?limit=1001')).status).toBe(400);
  });

  it('error bodies never echo the submitted value', async () => {
    const secretValue = 'ultra-secret-never-echo-9f2a';
    const res = await req(app, LILLY, 'POST', '/secrets', { value: secretValue }); // no name
    expect(res.status).toBe(400);
    const text = await res.clone().text();
    expect(text).not.toContain(secretValue);

    const auditDenied = await req(app, LILLY, 'POST', '/secrets', {
      name: 'mine-for-echo-check',
      value: secretValue,
    });
    expect(auditDenied.status).toBe(201);
    expect(await auditCount()).toBeGreaterThan(0);
    // Audit rows are value-free by construction.
    const auditDoc = await db
      .collection(AUDIT)
      .findOne({ secret_id: 'lilly/mine-for-echo-check' });
    expect(JSON.stringify(auditDoc)).not.toContain(secretValue);
  });
});
