/**
 * Unit tests: Katra Vault capability layer (F7) — contract success criteria
 * 1–11, hard rules 1–8.
 *
 * Core behaviour runs against real MongoDB (tests/helpers conventions:
 * test_-prefixed secrets/approvals/audit collections for the injected store,
 * module-level connect like the F3 MCP suite; capability audit rows land in
 * the shared vault_audit collection with a runId-scoped secret_id and are
 * swept in beforeAll / deleted in afterAll — mirroring the f3mcp- sweep the
 * vault MCP suite already performs on that collection). fetchImpl /
 * resolveHost / now are injected per test; one success path additionally
 * runs against a REAL local mock upstream (node:http on 127.0.0.1) to prove
 * header injection + body pass-through over actual sockets. The SSRF guard
 * is exercised with a recording fake fetch (never a real connection).
 *
 * Skipped entirely when no MongoDB is reachable (repo convention); the
 * source-level wiring tests (criterion 10) never need a DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { Hono } from 'hono';
import {
  close_connection,
  connect_to_mongodb,
  get_database,
  is_database_connected,
} from '../../../src/database/connection.js';
import { runWithCaller } from '../../../src/utils/caller-identity.js';
import type { CallerIdentity } from '../../../src/utils/caller-identity.js';
import { createVaultStore } from '../../../src/services/vault/store.js';
import type { VaultStore } from '../../../src/services/vault/store.js';
import { generateMasterKey } from '../../../src/services/vault/crypto.js';
import { createCapability } from '../../../src/services/vault/capability.js';
import type { CapabilityResult } from '../../../src/services/vault/capability.js';
import { registerDriver, getDriver } from '../../../src/services/vault/drivers/index.js';
import { agentmailDriver } from '../../../src/services/vault/drivers/agentmail.js';
import { create_vault_routes } from '../../../src/routes/vault-routes.js';

const CANDIDATE_URIS = [
  process.env.MONGODB_URI,
  'mongodb://admin:change-me@172.19.0.2:27017/katra?authSource=admin',
  'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin',
].filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);

async function reachableMongoUri(): Promise<string | null> {
  for (const uri of CANDIDATE_URIS) {
    try {
      const probe = new MongoClient(uri, {
        serverSelectionTimeoutMS: 2000,
        connectTimeoutMS: 2000,
      });
      await probe.connect();
      await probe.close();
      return uri;
    } catch {
      /* try next */
    }
  }
  return null;
}

const MONGO_URI: string | null = await reachableMongoUri();
const mongoAvailable = MONGO_URI !== null;

const MCP_SERVER_SOURCE = readFileSync(
  new URL('../../../src/mcp-server.ts', import.meta.url),
  'utf8',
).toString();
const ROUTES_SOURCE = readFileSync(
  new URL('../../../src/routes/vault-routes.ts', import.meta.url),
  'utf8',
).toString();

// ── Criterion 10: MCP + REST wiring (source-level, no DB) ────────────────

describe('vault capability — MCP + REST wiring (criterion 10)', () => {
  it('does not connect to MongoDB at module import time', () => {
    expect(is_database_connected()).toBe(false);
  });

  it('mcp-server.ts registers vault_http with the zod schema', () => {
    expect(MCP_SERVER_SOURCE).toContain(`name: 'vault_http'`);
    expect(MCP_SERVER_SOURCE).toContain(
      `inputSchema: zodToJsonSchema(VaultHttpInput) as Record<string, unknown>`,
    );
    // Input contract: {secret_id, service, method, url, inject_header, body?}
    expect(MCP_SERVER_SOURCE).toMatch(/const VaultHttpInput = z\.object\(\{[\s\S]*secret_id: z\.string\(\)\.min\(1\)/);
    expect(MCP_SERVER_SOURCE).toMatch(/method: z\.enum\(\['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'\]\)/);
    expect(MCP_SERVER_SOURCE).toMatch(/inject_header: z\.string\(\)\.min\(1\)/);
    expect(MCP_SERVER_SOURCE).toMatch(/body: z\.string\(\)\.optional\(\)/);
  });

  it('mcp-server.ts exports handleVaultHttp and dispatches vault_http', () => {
    expect(MCP_SERVER_SOURCE).toMatch(
      /export async function handleVaultHttp\(args: unknown\): Promise<TextContent\[\]>/,
    );
    expect(MCP_SERVER_SOURCE).toContain(
      `case 'vault_http': result = await handleVaultHttp(args); break;`,
    );
  });

  it('vault-routes.ts adds POST /api/v1/vault/capability/http reading the caller from getCaller()', () => {
    expect(ROUTES_SOURCE).toContain(`router.post('/capability/http'`);
    const endpoint = ROUTES_SOURCE.slice(ROUTES_SOURCE.indexOf(`router.post('/capability/http'`));
    expect(endpoint).toContain('getCaller()');
    // The capability input is parsed from the request body (never echoed).
    expect(endpoint).toContain('capability.vaultHttp(input)');
    expect(endpoint).toContain('inject_header');
  });
});

// ── Driver registry + AgentMail driver (criterion 9, no DB) ──────────────

describe('vault drivers — registry + agentmail (criterion 9)', () => {
  const SECRET_VALUE = 'agentmail-driver-key-9f3c2d1e-0a4b-5c6d';
  const LILLY: CallerIdentity = { user_id: 'lilly', trusted: false };
  const secretId = 'lilly/agentmail-api-key';

  function fakeContext() {
    const calls: Array<Record<string, unknown>> = [];
    const vaultHttp = vi.fn(
      async (input: Record<string, unknown>): Promise<CapabilityResult> => {
        calls.push(input);
        return { status: 200, body: '{"ok":true,"count":2}' };
      },
    );
    return {
      ctx: { vaultHttp, caller: LILLY, secretId },
      calls,
    };
  }

  it('agentmail driver is registered on module import and getDriver returns it', () => {
    // agentmailDriver is intentionally referenced: the export binding also
    // proves the module (whose import runs registerDriver) was evaluated.
    expect(agentmailDriver.service).toBe('agentmail');
    expect(agentmailDriver.ops).toHaveProperty('inbox_list');
    expect(getDriver('agentmail')).toBeDefined();
    expect(getDriver('agentmail')!.service).toBe('agentmail');
    expect(getDriver('agentmail')!.ops).toHaveProperty('inbox_list');
    expect(getDriver('agentmail')!.ops).toHaveProperty('thread_list');
    expect(getDriver('agentmail')!.ops).toHaveProperty('thread_reply');
    expect(getDriver('agentmail')!.ops).toHaveProperty('inbox_create');
  });

  it('unknown service via getDriver returns undefined', () => {
    expect(getDriver('no-such-service')).toBeUndefined();
  });

  it('registerDriver/getDriver roundtrip for an arbitrary driver', () => {
    registerDriver({ service: 'f7-test-driver', ops: { ping: async () => 'pong' } });
    expect(getDriver('f7-test-driver')!.service).toBe('f7-test-driver');
    expect(getDriver('f7-test-driver')!.ops.ping).toBeTypeOf('function');
  });

  it('agentmail ops build the documented https://api.agentmail.to/v0 URLs + inject Authorization', async () => {
    const driver = getDriver('agentmail')!;
    const { ctx, calls } = fakeContext();

    await driver.ops.inbox_list(ctx);
    expect(calls[0]).toMatchObject({
      caller: LILLY,
      secretId,
      service: 'agentmail',
      method: 'GET',
      url: 'https://api.agentmail.to/v0/inboxes',
      injectHeader: 'Authorization',
    });
    expect('body' in (calls[0] as Record<string, unknown>)).toBe(false);

    await driver.ops.thread_list(ctx, 'inbox-42');
    expect(calls[1]).toMatchObject({
      method: 'GET',
      url: 'https://api.agentmail.to/v0/inboxes/inbox-42/threads',
    });

    await driver.ops.thread_reply(ctx, 'thread-7', 'hello world');
    expect(calls[2]).toMatchObject({
      method: 'POST',
      url: 'https://api.agentmail.to/v0/threads/thread-7/replies',
      body: JSON.stringify({ message: 'hello world' }),
    });

    await driver.ops.inbox_create(ctx, 'acme-orders');
    expect(calls[3]).toMatchObject({
      method: 'POST',
      url: 'https://api.agentmail.to/v0/inboxes',
      body: JSON.stringify({ name: 'acme-orders' }),
    });

    // The raw key never travels through the op signature or the context.
    const allSerialized = JSON.stringify(calls);
    expect(allSerialized).not.toContain(SECRET_VALUE);
  });

  it('agentmail ops return the parsed upstream body', async () => {
    const driver = getDriver('agentmail')!;
    const { ctx } = fakeContext();
    const out = await driver.ops.inbox_list(ctx);
    expect(out).toEqual({ ok: true, count: 2 });
  });
});

// ── Capability core (real Mongo; criteria 1–8, 11) ───────────────────────

describe.skipIf(!mongoAvailable)('vault capability core (F7) — contract criteria', () => {
  const SECRETS = 'test_secrets_f7';
  const AUDIT = 'test_vault_audit_f7';
  const APPROVALS = 'test_approvals_f7';
  const AUDIT_KEYS = new Set([
    'at',
    'actor',
    'action',
    'secret_id',
    'service',
    'outcome',
    'error',
  ]);

  let db: Db;
  let store: VaultStore;
  const MK = generateMasterKey();
  const runId = randomBytes(4).toString('hex');
  const SECRET_VALUE = 'sk-live-capability-7a1f2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c';
  const LILLY: CallerIdentity = { user_id: 'lilly', trusted: false };
  const SHOSHIN: CallerIdentity = { user_id: 'shoshin', trusted: false };
  const SATORI: CallerIdentity = { user_id: 'satori', trusted: true };
  const PUBLIC_IP = '93.184.216.34';

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Recording fetch spy: returns the canned response; asserts nothing. */
  function mockFetch(respond: (url: string, init: RequestInit) => Promise<Response>) {
    return vi.fn(async (url: unknown, init: unknown) =>
      respond(url as string, init as RequestInit),
    ) as unknown as typeof fetch;
  }

  const resolveTo = (ips: string | string[]): ((host: string) => Promise<string[]>) =>
    vi.fn(async () => (Array.isArray(ips) ? ips : [ips]));

  const OK_RESPONSE = async (): Promise<Response> =>
    new Response(JSON.stringify({ ok: true }), { status: 200 });

  function nameOf(tag: string): string {
    return `cap-${tag}-${runId}`;
  }

  async function auditRowsFor(secretId: string): Promise<Array<Record<string, unknown>>> {
    return (await db
      .collection('vault_audit')
      .find(
        { action: 'capability_use', secret_id: secretId },
        { projection: { _id: 0 } },
      )
      .sort({ at: 1 })
      .toArray()) as unknown as Array<Record<string, unknown>>;
  }

  /** Grant + private secret for `identity`, service-linked as requested. */
  async function grant(identity: string, service: string): Promise<void> {
    const res = await store.grantApproval({
      caller: SATORI,
      identity,
      service,
    });
    expect(res.granted).toBe(true);
  }

  async function putSecretFor(owner: string, tag: string): Promise<string> {
    const result = await store.putSecret({
      caller: SATORI,
      name: nameOf(tag),
      value: SECRET_VALUE,
      service: 'agentmail',
      ownerUserId: owner,
    });
    return result.secret_id;
  }

  async function assertNoSecretText(...json: Array<unknown>): Promise<void> {
    for (const value of json) {
      expect(JSON.stringify(value)).not.toContain(SECRET_VALUE);
    }
  }

  beforeAll(async () => {
    process.env.MONGODB_URI = MONGO_URI!;
    await connect_to_mongodb();
    db = get_database();
    store = createVaultStore({
      db,
      secretsCollection: SECRETS,
      auditCollection: AUDIT,
      approvalsCollection: APPROVALS,
      masterKeyHex: MK,
    });
    // Sweep stale capability rows left by an earlier crashed run.
    await db.collection('vault_audit').deleteMany({
      action: 'capability_use',
      secret_id: { $regex: runId },
    });
  }, 120000);

  beforeEach(async () => {
    await db.collection(SECRETS).deleteMany({});
    await db.collection(AUDIT).deleteMany({});
    await db.collection(APPROVALS).deleteMany({});
  });

  afterAll(async () => {
    try {
      await db.collection(SECRETS).deleteMany({});
      await db.collection(AUDIT).deleteMany({});
      await db.collection(APPROVALS).deleteMany({});
      await db.collection('vault_audit').deleteMany({
        action: 'capability_use',
        secret_id: { $regex: runId },
      });
    } finally {
      await close_connection();
    }
  });

  const inputFor = (secretId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    caller: LILLY,
    secretId,
    service: 'agentmail',
    method: 'POST',
    url: 'https://api.agentmail.to/v0/inboxes',
    injectHeader: 'X-Api-Key',
    body: '{"name":"acme"}',
    ...over,
  });

  // ── Criterion 1: approval gate FIRST ─────────────────────────────
  it('criterion 1: no active approval → blocked no active approval, fetch never called, audit denied', async () => {
    const secretId = await putSecretFor('lilly', 'noapproval');
    const fetchSpy = mockFetch(OK_RESPONSE);
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp(inputFor(secretId) as never);

    expect(result).toEqual({ status: 0, body: '', blocked: { reason: 'no active approval' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = await auditRowsFor(secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'capability_use',
      actor: 'lilly',
      service: 'agentmail',
      secret_id: secretId,
      outcome: 'denied',
    });
    expect(Object.keys(rows[0]).every((k) => AUDIT_KEYS.has(k))).toBe(true);
    expect('error' in rows[0]).toBe(false); // denied rows never carry error
    await assertNoSecretText(result, rows);
  });

  // ── Criterion 2: approval active → injected fetch once, audit ok ─
  it('criterion 2: approved call fetches once with method/url/body and the exact header value', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'approved');
    const fetchSpy = mockFetch(async (url, init) => {
      expect(url).toBe('https://api.agentmail.to/v0/inboxes');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['X-Api-Key']).toBe(SECRET_VALUE);
      expect(init.body).toBe('{"name":"acme"}');
      expect(init.redirect).toBe('manual');
      return new Response('{"ok":true,"created":true}', { status: 201 });
    });
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp(inputFor(secretId) as never);

    expect(result).toEqual({ status: 201, body: '{"ok":true,"created":true}' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = await auditRowsFor(secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'capability_use',
      actor: 'lilly',
      secret_id: secretId,
      service: 'agentmail',
      outcome: 'ok',
    });
    await assertNoSecretText(result, rows);
  });

  // ── Criterion 2b: injectScheme composes the header value ────────
  it('criterion 2b: injectScheme prefixes the header value; absent → raw secret', async () => {
    await grant('lilly', 'github');
    const secretId = await putSecretFor('lilly', 'scheme');
    let seen: string | undefined;
    const fetchSpy = mockFetch(async (url, init) => {
      seen = (init.headers as Record<string, string>)['Authorization'];
      return new Response('ok', { status: 200 });
    });
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });
    await cap.vaultHttp({ ...inputFor(secretId, { injectHeader: 'Authorization' }), service: 'github', injectScheme: 'Bearer' } as never);
    expect(seen).toBe(`Bearer ${SECRET_VALUE}`);
    await cap.vaultHttp({ ...inputFor(secretId, { injectHeader: 'Authorization' }), service: 'github' } as never);
    expect(seen).toBe(SECRET_VALUE);
  });

  // ── Criterion 3: secret redaction everywhere ────────────────────
  it('criterion 3: secret appears in no result, audit row JSON, or thrown error', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'redact');
    const fetchSpy = mockFetch(async () => {
      throw new Error(`network exploded with ${SECRET_VALUE}`); // hostile upstream error
    });
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp(inputFor(secretId) as never);

    expect(result.blocked?.reason).toBe('request failed');
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    const rows = await auditRowsFor(secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('error');
    expect(Object.keys(rows[0]).every((k) => AUDIT_KEYS.has(k))).toBe(true);
    // Audit error text is a static reason — never the hostile message.
    expect(JSON.stringify(rows[0])).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(rows[0])).not.toContain('network exploded');
    await assertNoSecretText(result, rows);
  });

  // ── Criterion 4: SSRF pre-flight ────────────────────────────────
  const SSRF_CASES: Array<[string, string, string]> = [
    ['http://public.example.com/x', 'scheme not allowed', PUBLIC_IP],
    ['https://127.0.0.1/x', 'private address', '127.0.0.1'],
    ['https://10.0.0.7/x', 'private address', '10.0.0.7'],
    ['https://172.16.0.1/x', 'private address', '172.16.0.1'],
    ['https://172.31.255.254/x', 'private address', '172.31.255.254'],
    ['https://192.168.1.10/x', 'private address', '192.168.1.10'],
    ['https://169.254.169.254/latest/meta-data', 'private address', '169.254.169.254'],
    ['https://0.1.2.3/x', 'private address', '0.1.2.3'],
    ['https://100.64.0.1/x', 'private address', '100.64.0.1'],
    ['https://[::1]/x', 'private address', '::1'],
    ['https://[fc00::1]/x', 'private address', 'fc00::1'],
    ['https://[fd12::1]/x', 'private address', 'fd12::1'],
    ['https://[fe80::1]/x', 'private address', 'fe80::1'],
    ['https://[::ffff:10.0.0.1]/x', 'private address', '::ffff:10.0.0.1'],
    ['https://[::ffff:127.0.0.1]/x', 'private address', '::ffff:127.0.0.1'],
    ['https://[::ffff:192.168.0.9]/x', 'private address', '::ffff:192.168.0.9'],
  ];
  it.each(SSRF_CASES.map((row, index): [string, string, string, number] => [...row, index]))(
    'criterion 4: SSRF blocked for %s → %s (no fetch)',
    async (url, reason, ip, index) => {
      await grant('lilly', 'agentmail');
      // A unique secret per case so "exactly one capability_use row per
      // attempt" is asserted in isolation (rows live in the shared
      // vault_audit collection and are only swept in afterAll).
      const secretId = await putSecretFor('lilly', `ssrf-${index}`);
      const fetchSpy = mockFetch(OK_RESPONSE);
      const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(ip) });

      const result = await cap.vaultHttp({
        ...(inputFor(secretId) as Record<string, unknown>),
        url,
      } as never);

      expect(result.blocked?.reason).toBe(reason);
      expect(fetchSpy).not.toHaveBeenCalled();
      const rows = await auditRowsFor(secretId);
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('denied');
      await assertNoSecretText(result, rows);
    },
  );

  it('criterion 4: non-443 port, userinfo URL, unresolvable host, and private-resolving public hostname all block without fetch', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'ssrf2');

    const cases: Array<[string, string, ((h: string) => Promise<string[]>) | 'dns-fail']> = [
      ['https://api.agentmail.to:8443/v0/inboxes', 'port not allowed', resolveTo(PUBLIC_IP)],
      ['https://user:pass@api.agentmail.to/v0/inboxes', 'userinfo not allowed', resolveTo(PUBLIC_IP)],
      ['https://api.agentmail.to/v0/inboxes', 'host not resolvable', 'dns-fail'],
    ];
    for (const [url, reason, resolver] of cases) {
      const fetchSpy = mockFetch(OK_RESPONSE);
      const resolveHost =
        resolver === 'dns-fail'
          ? vi.fn(async () => {
              throw new Error('ENOTFOUND');
            })
          : resolver;
      const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost });
      const result = await cap.vaultHttp({
        ...(inputFor(secretId) as Record<string, unknown>),
        url,
      } as never);
      expect(result.blocked?.reason).toBe(reason);
      expect(fetchSpy).not.toHaveBeenCalled();
    }

    // A public-looking hostname that resolves to a private IP must block
    // BEFORE the fetch is called (DNS rebinding shape).
    const fetchSpy = mockFetch(OK_RESPONSE);
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo('10.0.0.5') });
    const rebound = await cap.vaultHttp({
      ...(inputFor(secretId) as Record<string, unknown>),
      url: 'https://example.com/steal',
    } as never);
    expect(rebound.blocked?.reason).toBe('private address');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Same test-set's attempts all land on the same secret: each wrote
    // exactly one capability_use row (3 URL cases + 1 DNS-rebinding case).
    const rows = await auditRowsFor(secretId);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.outcome === 'denied')).toBe(true);
    await assertNoSecretText(rows);
  });

  // ── Criterion 5: no redirect following ──────────────────────────
  it('criterion 5: upstream 302 is returned as-is; fetch is called exactly once', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'redirect');
    const fetchSpy = mockFetch(async () =>
      new Response('', {
        status: 302,
        headers: { location: 'https://evil.example.com/phish' },
      }),
    );
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp({
      ...(inputFor(secretId) as Record<string, unknown>),
      method: 'GET',
      body: undefined,
    } as never);

    expect(result.status).toBe(302);
    expect(result.blocked).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The second hop was never issued.
    const rows = await auditRowsFor(secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('ok');
  });

  // ── Criterion 6: limits ─────────────────────────────────────────
  it('criterion 6: response body over 5 MB → blocked response too large', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'huge');
    const BIG = 5 * 1024 * 1024 + 1;
    const fetchSpy = mockFetch(async () => new Response('x'.repeat(BIG), { status: 200 }));
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp({
      ...(inputFor(secretId) as Record<string, unknown>),
      method: 'GET',
      body: undefined,
    } as never);

    expect(result.blocked?.reason).toBe('response too large');
    const rows = await auditRowsFor(secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('error');
    await assertNoSecretText(result, rows);
  }, 20000);

  it('criterion 6: response body at exactly 5 MB passes', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'boundary');
    const EXACT = 5 * 1024 * 1024;
    const fetchSpy = mockFetch(async () => new Response('y'.repeat(EXACT), { status: 200 }));
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp({
      ...(inputFor(secretId) as Record<string, unknown>),
      method: 'GET',
      body: undefined,
    } as never);

    expect(result.status).toBe(200);
    expect(result.body.length).toBe(EXACT);
    expect(result.blocked).toBeUndefined();
  }, 30000);

  it('criterion 6: upstream that never responds → blocked timeout once now() passes 30 s', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'slow');
    const neverResolves = vi.fn(async () => new Promise<Response>(() => {}));
    let clock = Date.now();
    const now = () => clock;
    const cap = createCapability({
      store,
      fetchImpl: neverResolves as unknown as typeof fetch,
      resolveHost: resolveTo(PUBLIC_IP),
      now,
    });

    const pending = cap.vaultHttp({
      ...(inputFor(secretId) as Record<string, unknown>),
      method: 'GET',
      body: undefined,
    } as never);
    // Let the deadline poller arm, then push the injected clock past 30 s.
    await sleep(20);
    clock += 31_000;

    const result = await pending;
    expect(result.blocked?.reason).toBe('timeout');
    expect(neverResolves).toHaveBeenCalledTimes(1);
    const rows = await auditRowsFor(secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('error');
    await assertNoSecretText(result, rows);
  }, 10000);

  it('criterion 6: method outside the whitelist → blocked method not allowed', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'method');
    const fetchSpy = mockFetch(OK_RESPONSE);
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp({
      ...(inputFor(secretId) as Record<string, unknown>),
      method: 'TRACE',
    } as never);

    expect(result.blocked?.reason).toBe('method not allowed');
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = await auditRowsFor(secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied');
  });

  // ── Criterion 7: RBAC via openSecretValue ───────────────────────
  it('criterion 7: another user\'s private secret → blocked secret not available (no fetch)', async () => {
    await grant('lilly', 'agentmail');
    const otherSecret = await putSecretFor('shoshin', 'notyours');
    const fetchSpy = mockFetch(OK_RESPONSE);
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp(inputFor(otherSecret) as never);

    expect(result.blocked?.reason).toBe('secret not available');
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = await auditRowsFor(otherSecret);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('denied');
    await assertNoSecretText(result, rows);
  });

  // ── Criterion 8: '*' wildcard approval ──────────────────────────
  it('criterion 8: a "*" wildcard approval gates the service call', async () => {
    await grant('lilly', '*');
    const secretId = await putSecretFor('lilly', 'wildcard');
    const fetchSpy = mockFetch(OK_RESPONSE);
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp(inputFor(secretId) as never);

    expect(result.status).toBe(200);
    expect(result.blocked).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = await auditRowsFor(secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('ok');
  });

  // ── Upstream non-2xx returned as-is (rule 8) + real local server ─
  it('upstream 5xx is returned as {status, body} (ok outcome, never followed/rewritten)', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'fivexx');
    const fetchSpy = mockFetch(async () => new Response('{"error":"upstream down"}', { status: 503 }));
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });

    const result = await cap.vaultHttp({
      ...(inputFor(secretId) as Record<string, unknown>),
      method: 'GET',
      body: undefined,
    } as never);

    expect(result).toEqual({ status: 503, body: '{"error":"upstream down"}' });
    const rows = await auditRowsFor(secretId);
    expect(rows[0].outcome).toBe('ok');
  });

  it('end-to-end against a REAL local mock upstream: header injection + body pass through sockets', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'live');
    const seen: Array<{ method: string; url: string; injectedHeader: string | null; body: string }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          injectedHeader: (req.headers['x-api-key'] as string | undefined) ?? null,
          body: raw,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echoed: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const capturedOutbound: Array<{ url: string; init: RequestInit }> = [];
      // The injected fetch performs the REAL HTTP call against the local
      // upstream, forwarding method/headers/body exactly as vaultHttp built
      // them (the SSRF guard is bypassed by injection on purpose here — it
      // is covered separately above with a recording fake).
      const fetchImpl = mockFetch(async (url, init) => {
        capturedOutbound.push({ url, init });
        return fetch(`http://127.0.0.1:${port}/upstream-echo`, {
          method: init.method,
          headers: init.headers as Record<string, string>,
          body: init.body as string | undefined,
          redirect: init.redirect,
        });
      });
      const cap = createCapability({ store, fetchImpl, resolveHost: resolveTo(PUBLIC_IP) });

      const result = await cap.vaultHttp({
        ...(inputFor(secretId) as Record<string, unknown>),
        url: 'https://api.agentmail.to/v0/inboxes',
      } as never);

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ echoed: true });
      expect(capturedOutbound[0].url).toBe('https://api.agentmail.to/v0/inboxes');
      expect(capturedOutbound[0].init.headers).toEqual({ 'X-Api-Key': SECRET_VALUE });
      expect(seen).toHaveLength(1);
      expect(seen[0].injectedHeader).toBe(SECRET_VALUE); // secret arrived over a real socket
      expect(seen[0].body).toBe('{"name":"acme"}');
      expect(seen[0].url).toBe('/upstream-echo');
      const rows = await auditRowsFor(secretId);
      expect(rows[0].outcome).toBe('ok');
      // The secret WAS observed on the wire (that is the capability's job) —
      // redaction guarantees cover the returned result and the audit trail.
      await assertNoSecretText(result, rows);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  // ── Criterion 10 (REST behaviour): caller from getCaller() ──────
  it('criterion 10: REST POST /capability/http resolves the caller from getCaller()', async () => {
    await grant('lilly', 'agentmail');
    const secretId = await putSecretFor('lilly', 'rest');
    const fetchSpy = mockFetch(async () => new Response('{"via":"rest"}', { status: 200 }));
    const cap = createCapability({ store, fetchImpl: fetchSpy, resolveHost: resolveTo(PUBLIC_IP) });
    const app = new Hono();
    app.route('/api/v1/vault', create_vault_routes({ store, capability: cap }));

    const response = await runWithCaller(LILLY, () =>
      app.request('http://localhost/api/v1/vault/capability/http', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secret_id: secretId,
          service: 'agentmail',
          method: 'GET',
          url: 'https://api.agentmail.to/v0/inboxes',
          inject_header: 'X-Api-Key',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as CapabilityResult;
    // Approval was granted to lilly and the secret is lilly's — this only
    // succeeds if the handler used getCaller() (lilly), not a fallback.
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = await auditRowsFor(secretId);
    const restRows = rows.filter((r) => r.actor === 'lilly');
    expect(restRows).toHaveLength(1);
    await assertNoSecretText(result, rows);
  });
});
