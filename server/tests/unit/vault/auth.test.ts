/**
 * Unit tests: Katra Vault TOTP auth service (F9) — contract success
 * criteria 5–13.
 *
 * Real MongoDB (tests/helpers + the server connection both target the same
 * katra database): unique `test_`-prefixed collections
 * (test_secrets_f9 / test_vault_audit_f9 / test_auth_sessions_f9), wiped in
 * beforeEach, cleaned in afterAll. Skipped when no MongoDB is reachable.
 *
 * All TOTP computations use a FIXED injected clock (BASE_T), so codes are
 * deterministic; the service's `now` is injected the same way.
 *
 * NOTE on RFC 6238 base32: the vector secret is ASCII
 * "12345678901234567890", whose true RFC 4648 base32 is
 * GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ (see totp.test.ts for the proof).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { createVaultStore } from '../../../src/services/vault/store.js';
import { generateMasterKey, openSecret } from '../../../src/services/vault/crypto.js';
import {
  createAuthService,
  getAuthPolicy,
  refreshAuthPolicyCache,
  DEFAULT_AUTH_POLICY,
} from '../../../src/services/vault/auth.js';
import { totpCode } from '../../../src/services/vault/totp.js';
import { VAULT_DENYLISTED_COLLECTIONS } from '../../../src/services/vault/denylist.js';
import { create_auth_routes } from '../../../src/routes/vault-routes.js';
import { runWithCaller } from '../../../src/utils/caller-identity.js';
import type { CallerIdentity } from '../../../src/utils/caller-identity.js';
import {
  close_connection,
  connect_to_mongodb,
  get_database,
  is_database_connected,
} from '../../../src/database/connection.js';
import {
  handleAuthEnrollTotp,
  handleAuthIssueSession,
  handleAuthRevokeSession,
  handleAuthSessionStatus,
} from '../../../src/mcp-server.js';

const MONGO_URI =
  process.env.MONGODB_URI ||
  'mongodb://admin:change-me@172.19.0.2:27017/katra?authSource=admin';

// Probe connectivity (incl. auth) up front; skip DB tests when unavailable.
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

// ── Wiring (criterion 12 + 13), no DB required ────────────────────────────

const INDEX_SOURCE = readFileSync(
  new URL('../../../src/index.ts', import.meta.url),
  'utf8',
).toString();
const CALLER_AUTH_SOURCE = readFileSync(
  new URL('../../../src/middleware/caller-auth.ts', import.meta.url),
  'utf8',
).toString();
const MCP_SERVER_SOURCE = readFileSync(
  new URL('../../../src/mcp-server.ts', import.meta.url),
  'utf8',
).toString();

describe('F9 wiring — index.ts / REST mount / MCP tools (criterion 12)', () => {
  it('imports create_auth_routes from vault-routes and mounts /api/v1/auth exactly once', () => {
    expect(INDEX_SOURCE).toContain(
      "import { create_auth_routes } from './routes/vault-routes.js';",
    );
    const mounts = INDEX_SOURCE.match(
      /app\.route\('\/api\/v1\/auth', create_auth_routes\(\)\);/g,
    );
    expect(mounts).toHaveLength(1);
  });

  it('mounts the auth router AFTER the caller-auth middleware (auth requires auth)', () => {
    const middlewareIdx = INDEX_SOURCE.indexOf(
      "app.use('/api/*', createCallerAuthMiddleware());",
    );
    const authIdx = INDEX_SOURCE.indexOf("app.route('/api/v1/auth', create_auth_routes());");
    expect(middlewareIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(middlewareIdx);
  });

  it('does NOT add /api/v1/auth paths to AUTH_SKIP_PATHS', () => {
    const start = CALLER_AUTH_SOURCE.indexOf('const AUTH_SKIP_PATHS');
    const end = CALLER_AUTH_SOURCE.indexOf(']);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const skipBlock = CALLER_AUTH_SOURCE.slice(start, end);
    expect(skipBlock.toLowerCase()).not.toContain('/api/v1/auth');
    expect(skipBlock.toLowerCase()).not.toContain("'auth'");
  });

  it('registers the four auth tools with their zod schemas in mcp-server.ts', () => {
    const registered: Array<[string, string]> = [
      ['auth_enroll_totp', 'AuthEnrollTotpInput'],
      ['auth_issue_session', 'AuthIssueSessionInput'],
      ['auth_revoke_session', 'AuthRevokeSessionInput'],
      ['auth_session_status', 'AuthSessionStatusInput'],
    ];
    for (const [name, schema] of registered) {
      expect(MCP_SERVER_SOURCE).toContain(`name: '${name}'`);
      expect(MCP_SERVER_SOURCE).toContain(
        `inputSchema: zodToJsonSchema(${schema}) as Record<string, unknown>`,
      );
    }
  });

  it('exports the four auth handler functions and dispatches them', () => {
    const handlers: Array<[string, string]> = [
      ['handleAuthEnrollTotp', 'auth_enroll_totp'],
      ['handleAuthIssueSession', 'auth_issue_session'],
      ['handleAuthRevokeSession', 'auth_revoke_session'],
      ['handleAuthSessionStatus', 'auth_session_status'],
    ];
    for (const [handler, toolName] of handlers) {
      expect(MCP_SERVER_SOURCE).toMatch(
        new RegExp(`export async function ${handler}\\(args: unknown\\): Promise<TextContent\\[\\]>`),
      );
      expect(MCP_SERVER_SOURCE).toContain(
        `case '${toolName}': result = await ${handler}(args); break;`,
      );
    }
  });

  it('does not connect to MongoDB at module import time', () => {
    expect(is_database_connected()).toBe(false);
  });
});

describe('F9 wiring — denylist coverage (criterion 13)', () => {
  it('covers every collection the auth feature uses (auth_sessions, auth_totp, secrets, vault_audit)', () => {
    for (const c of ['secrets', 'vault_audit', 'auth_sessions', 'auth_totp']) {
      expect(VAULT_DENYLISTED_COLLECTIONS).toContain(c);
    }
  });
});

// ── Direct MCP handler gates (no DB) ──────────────────────────────────────

describe('F9 MCP handlers — operator gate + disconnected guard', () => {
  const LILLY: CallerIdentity = { user_id: 'lilly', trusted: false };
  const SATORI: CallerIdentity = { user_id: 'satori', trusted: true };

  it('auth_enroll_totp rejects untrusted callers with \'operator only\'', async () => {
    await expect(
      runWithCaller(LILLY, () => handleAuthEnrollTotp({ identity: 'lilly' })),
    ).rejects.toThrow('operator only');
  });

  it('auth handlers return a disconnected warning without a DB', async () => {
    const enroll = await runWithCaller(SATORI, () =>
      handleAuthEnrollTotp({ identity: 'satori' }),
    );
    expect(enroll[0].text).toBe('⚠️ MongoDB disconnected.');

    const issue = await runWithCaller(LILLY, () =>
      handleAuthIssueSession({ identity: 'lilly', totp_code: '123456' }),
    );
    expect(issue[0].text).toBe('⚠️ MongoDB disconnected.');

    const revoke = await runWithCaller(LILLY, () => handleAuthRevokeSession({}));
    expect(revoke[0].text).toBe('⚠️ MongoDB disconnected.');

    const status = await runWithCaller(LILLY, () => handleAuthSessionStatus({}));
    expect(status[0].text).toBe('⚠️ MongoDB disconnected.');
  });
});

// ── Connected flows (real Mongo) ──────────────────────────────────────────

describe.skipIf(!mongoAvailable)('F9 auth service — contract criteria 5–11 + REST', () => {
  const SECRETS = 'test_secrets_f9';
  const AUDIT = 'test_vault_audit_f9';
  const SESSIONS = 'test_auth_sessions_f9';
  const AUDIT_KEYS = new Set(['at', 'actor', 'action', 'secret_id', 'service', 'outcome', 'error']);

  const OPERATOR: CallerIdentity = { user_id: 'satori', trusted: true };
  const LILLY: CallerIdentity = { user_id: 'lilly', trusted: false };
  const SHOSHIN: CallerIdentity = { user_id: 'shoshin', trusted: false };

  /** Fixed injected clock — every TOTP computation is deterministic. */
  const BASE_T = 1_800_000_000; // 2027-01-15T08:00:00Z — divisible by 30
  const clock = { ms: BASE_T * 1000 };
  const HOUR_MS = 3_600_000;

  let db: Db;
  let keyedStore: ReturnType<typeof createVaultStore>;
  let svc: ReturnType<typeof createAuthService>;
  let authApp: Hono;
  const MK = generateMasterKey();
  const runId = randomBytes(4).toString('hex');

  beforeAll(async () => {
    if (!process.env.MONGODB_URI) process.env.MONGODB_URI = MONGO_URI;
    await connect_to_mongodb();
    db = get_database();
    keyedStore = createVaultStore({
      db,
      secretsCollection: SECRETS,
      auditCollection: AUDIT,
      masterKeyHex: MK,
    });
    svc = createAuthService({
      store: keyedStore,
      db,
      sessionsCollection: SESSIONS,
      auditCollection: AUDIT,
      now: () => clock.ms,
    });
    authApp = new Hono();
    authApp.route(
      '/api/v1/auth',
      create_auth_routes({
        store: keyedStore,
        db,
        sessionsCollection: SESSIONS,
        auditCollection: AUDIT,
        now: () => clock.ms,
      }),
    );
    // Replay claim index (as production boot does via index-management.ts).
    await ensureReplayIndex();
  }, 120000);

  beforeEach(async () => {
    clock.ms = BASE_T * 1000;
    if (db) {
      await db.collection(SECRETS).deleteMany({});
      await db.collection(AUDIT).deleteMany({});
      await db.collection(SESSIONS).deleteMany({});
    }
  });

  afterAll(async () => {
    try {
      if (db) {
        await db.collection(SECRETS).deleteMany({});
        await db.collection(AUDIT).deleteMany({});
        await db.collection(SESSIONS).deleteMany({});
      }
    } finally {
      await close_connection();
    }
  });

  function secretOf(uri: string): string {
    return new URL(uri).searchParams.get('secret') ?? '';
  }

  const hashOf = (token: string): string =>
    createHash('sha256').update(token, 'utf8').digest('hex');

  async function enroll(caller: CallerIdentity, identity: string): Promise<string> {
    const res = await svc.enrollTotp({ caller, identity });
    expect(res.enrolled).toBe(true);
    expect(res.otpauth_uri).not.toBeNull();
    return res.otpauth_uri!;
  }

  async function rawSecret(secretId: string): Promise<Record<string, any> | null> {
    return (await db.collection(SECRETS).findOne({ secret_id: secretId })) as Record<
      string,
      any
    > | null;
  }

  async function auditRows(): Promise<Array<Record<string, any>>> {
    return (await db
      .collection(AUDIT)
      .find({}, { projection: { _id: 0 } })
      .sort({ at: 1, _id: 1 })
      .toArray()) as unknown as Array<Record<string, any>>;
  }

  async function sessionDoc(tokenHash: string): Promise<Record<string, any> | null> {
    return (await db
      .collection(SESSIONS)
      .findOne({ kind: 'session', token_hash: tokenHash })) as Record<string, any> | null;
  }

  /** Production boot creates the unique SPARSE (identity, last_counter)
   *  index on auth_sessions via index-management.ts; mirror that here on the
   *  test collection. createIndex is idempotent for an identical spec. */
  async function ensureReplayIndex(): Promise<void> {
    await db
      .collection(SESSIONS)
      .createIndex({ identity: 1, last_counter: 1 }, { unique: true, sparse: true });
  }

  async function req(
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
      authApp.request(`http://localhost/api/v1/auth${path}`, init),
    );
  }

  // 5 ── enrollment: encrypted, RBAC open round-trip, re-enroll invalidates ──
  it('criterion 5: operator enrolls lilly — envelope at rest, lilly opens it, re-enroll issues a NEW uri and the old code stops verifying', async () => {
    const uri1 = await enroll(OPERATOR, 'lilly');
    expect(uri1).toMatch(/^otpauth:\/\/totp\/Katra:lilly\?secret=[A-Z2-7]+&issuer=Katra&algorithm=SHA1&digits=6&period=30$/);
    const secret1 = secretOf(uri1);
    expect(secret1).toHaveLength(32);

    // At rest: an F1 envelope — never the plaintext base32.
    const raw = await rawSecret('lilly/auth-totp');
    expect(raw).not.toBeNull();
    expect(raw!.owner.user_id).toBe('lilly');
    expect(raw!.service).toBe('auth');
    expect(raw!.kind).toBe('totp_secret');
    expect(raw!.flags).toEqual({ rotatable: false, approval_required: false });
    expect(raw!.envelope).toBeDefined();
    expect(raw!.envelope.ciphertext).toBeDefined();
    expect(raw!.envelope.dek_wrapped).toBeDefined();
    expect(JSON.stringify(raw)).not.toContain(secret1);

    // The envelope opens to the exact secret (crypto round-trip via F1).
    expect(openSecret(raw!.envelope, 'user:lilly', MK)).toBe(secret1);

    // Lilly (owner, untrusted) recovers her own secret via openSecretValue.
    expect(await keyedStore.openSecretValue(LILLY, 'lilly/auth-totp')).toBe(secret1);

    // Re-enroll overwrites with a fresh secret + NEW uri.
    const uri2 = await enroll(OPERATOR, 'lilly');
    expect(uri2).not.toBe(uri1);
    const secret2 = secretOf(uri2);
    expect(secret2).not.toBe(secret1);
    expect(await keyedStore.openSecretValue(LILLY, 'lilly/auth-totp')).toBe(secret2);

    // The OLD code no longer verifies (no prior sessions → clean secret check).
    const oldCode = totpCode(secret1, { time: BASE_T });
    const oldTry = await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: oldCode,
    });
    expect(oldTry).toEqual({
      issued: false,
      token: null,
      expires_at: null,
      reason: 'invalid TOTP code',
    });
    // The NEW code works.
    const newTry = await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: totpCode(secret2, { time: BASE_T }),
    });
    expect(newTry.issued).toBe(true);
  });

  it('enrollTotp is operator-only for OTHER identities (denied result + denied audit row)', async () => {
    const res = await svc.enrollTotp({ caller: LILLY, identity: 'shoshin' });
    expect(res).toEqual({
      enrolled: false,
      identity: 'shoshin',
      otpauth_uri: null,
      secret_id: null,
      reason: 'operator only',
    });
    expect(await rawSecret('shoshin/auth-totp')).toBeNull();
    const rows = await auditRows();
    const enrollRows = rows.filter((r) => r.action === 'totp_enroll');
    expect(enrollRows).toHaveLength(1);
    expect(enrollRows[0]!.outcome).toBe('denied');
  });

  // 6 ── issueSession: shape, ttl from policy, wrong code denied + audited ──
  it('criterion 6: issueSession with a correct code returns token + expires_at = now + policy ttl; DB stores only the SHA-256 hash', async () => {
    const uri = await enroll(LILLY, 'lilly'); // self-enrollment (own partition)
    const secret = secretOf(uri);

    // Wrong code first: static reason + denied audit row.
    const wrong = await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: '000000',
    });
    expect(wrong).toEqual({
      issued: false,
      token: null,
      expires_at: null,
      reason: 'invalid TOTP code',
    });

    const issued = await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: totpCode(secret, { time: BASE_T }),
    });
    expect(issued.issued).toBe(true);
    expect(issued.token).not.toBeNull();
    expect(typeof issued.token).toBe('string');
    expect(issued.token!.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    // Interactive lilly → default 12 h TTL from the injected clock.
    expect(issued.expires_at).toBe(new Date(BASE_T * 1000 + 12 * HOUR_MS).toISOString());

    // DB: SHA-256 hash only — the raw token never appears anywhere.
    const doc = await sessionDoc(hashOf(issued.token!));
    expect(doc).not.toBeNull();
    expect(doc!.token_hash).toBe(hashOf(issued.token!));
    expect(doc!.token_hash).toHaveLength(64);
    expect(doc!.identity).toBe('lilly');
    expect(doc!.created_at).toBe(new Date(BASE_T * 1000).toISOString());
    expect(doc!.revoked_at).toBeNull();
    expect(JSON.stringify(doc)).not.toContain(issued.token);

    // One ok + one denied session_issue audit row, value-free.
    const rows = await auditRows();
    const issueRows = rows.filter((r) => r.action === 'session_issue');
    expect(issueRows).toHaveLength(2);
    const outcomes = new Set(issueRows.map((r) => r.outcome));
    expect(outcomes.has('ok')).toBe(true);
    expect(outcomes.has('denied')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(issued.token);
  });

  it('issueSession for an unenrolled identity → static \'not enrolled\' + denied audit', async () => {
    const res = await svc.issueSession({
      caller: SHOSHIN,
      identity: 'shoshin',
      totpCode: '123456',
    });
    expect(res).toEqual({
      issued: false,
      token: null,
      expires_at: null,
      reason: 'not enrolled',
    });
    const rows = await auditRows();
    expect(rows.filter((r) => r.action === 'session_issue')).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('denied');
  });

  // 7 ── validateSession: valid / expired / revoked ───────────────────────
  it('criterion 7: validateSession accepts a live token, rejects after expiry and after revocation', async () => {
    const uri = await enroll(LILLY, 'lilly');
    const issued = await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: totpCode(secretOf(uri), { time: BASE_T }),
    });
    expect(issued.issued).toBe(true);
    const token = issued.token!;

    const valid = await svc.validateSession(token);
    expect(valid).toEqual({ valid: true, identity: 'lilly' });

    // Expiry: advance the injected clock past the 12 h TTL.
    clock.ms = BASE_T * 1000 + 12 * HOUR_MS + 1000;
    const expired = await svc.validateSession(token);
    expect(expired).toEqual({ valid: false, identity: null, reason: 'session expired' });

    // Revoked: reset the clock and revoke, then validate again.
    clock.ms = BASE_T * 1000;
    expect(await svc.revokeSession({ caller: LILLY, tokenHashOrPrefix: hashOf(token) })).toEqual({
      revoked: 1,
    });
    const revoked = await svc.validateSession(token);
    expect(revoked).toEqual({ valid: false, identity: null, reason: 'session revoked' });

    // Unknown token.
    expect(await svc.validateSession('no-such-token')).toEqual({
      valid: false,
      identity: null,
      reason: 'session not found',
    });
  });

  // 8 ── replay on issue ──────────────────────────────────────────────────
  it('criterion 8: the same TOTP code cannot be used twice (per-identity replay guard)', async () => {
    const uri = await enroll(LILLY, 'lilly');
    const code = totpCode(secretOf(uri), { time: BASE_T });

    const first = await svc.issueSession({ caller: LILLY, identity: 'lilly', totpCode: code });
    expect(first.issued).toBe(true);
    // The session doc ITSELF is the replay claim: it carries the verified
    // counter, and the unique (identity, last_counter) index blocks re-claims.
    const firstDoc = await sessionDoc(hashOf(first.token!));
    expect(firstDoc!.last_counter).toBe(BASE_T / 30);

    const second = await svc.issueSession({ caller: LILLY, identity: 'lilly', totpCode: code });
    expect(second).toEqual({
      issued: false,
      token: null,
      expires_at: null,
      reason: 'invalid TOTP code',
    });
    // The denied replay minted nothing: still exactly one session row, and
    // no separate {kind:'counter'} doc was ever written.
    expect(await db.collection(SESSIONS).countDocuments({ kind: 'session' })).toBe(1);
    expect(await db.collection(SESSIONS).countDocuments({ kind: 'counter' })).toBe(0);

    // The NEXT step's code is accepted (a fresh counter is claimable).
    clock.ms = (BASE_T + 30) * 1000;
    const next = await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: totpCode(secretOf(uri), { time: BASE_T + 30 }),
    });
    expect(next.issued).toBe(true);
    const nextDoc = await sessionDoc(hashOf(next.token!));
    expect(nextDoc!.last_counter).toBe((BASE_T + 30) / 30);
    expect(await db.collection(SESSIONS).countDocuments({ kind: 'counter' })).toBe(0);
  });

  it('criterion 8 (concurrent): two simultaneous same-code issues mint exactly ONE session (atomic claim)', async () => {
    await ensureReplayIndex(); // index may be built lazily at boot — create it
    const uri = await enroll(LILLY, 'lilly');
    const code = totpCode(secretOf(uri), { time: BASE_T });

    const results = await Promise.all([
      svc.issueSession({ caller: LILLY, identity: 'lilly', totpCode: code }),
      svc.issueSession({ caller: LILLY, identity: 'lilly', totpCode: code }),
    ]);

    // Exactly one winner; the loser is a clean static denial (no session).
    const winners = results.filter((r) => r.issued === true);
    const losers = results.filter((r) => r.issued === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({
      issued: false,
      token: null,
      expires_at: null,
      reason: 'invalid TOTP code',
    });

    // Exactly one session row was minted, carrying the verified counter.
    const rows = (await db
      .collection(SESSIONS)
      .find({ kind: 'session' })
      .toArray()) as unknown as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_counter).toBe(BASE_T / 30);
    expect(await db.collection(SESSIONS).countDocuments({ kind: 'counter' })).toBe(0);
  });

  // 9 ── policy: defaults + system_settings overrides ─────────────────────
  it('criterion 9: getAuthPolicy defaults match the design table', () => {
    const interactive = { class: 'interactive', require_totp: false, session_ttl_hours: 12 };
    for (const id of ['shoshin', 'zanshin', 'lilly', 'satori-interactive-default']) {
      expect(getAuthPolicy(id)).toEqual(interactive);
    }
    expect(getAuthPolicy('satori')).toEqual({
      class: 'unattended',
      require_totp: false,
      session_ttl_hours: 720,
    });
    expect(getAuthPolicy('gas-law-watcher')).toEqual({
      class: 'unattended',
      require_totp: false,
      session_ttl_hours: 720,
    });
    for (const id of ['loopback', 'admin']) {
      expect(getAuthPolicy(id)).toEqual({
        class: 'trusted',
        require_totp: false,
        session_ttl_hours: 12,
      });
    }
    // Unknown identity → interactive default.
    expect(getAuthPolicy('someone-new')).toEqual(interactive);
    // DEFAULT_AUTH_POLICY itself mirrors the table keys.
    expect(DEFAULT_AUTH_POLICY['satori']!.class).toBe('unattended');
    expect(DEFAULT_AUTH_POLICY['lilly']!.session_ttl_hours).toBe(12);
  });

  it('criterion 9: system_settings.auth_policy overrides are honored (cached ≤60 s)', async () => {
    const target = `f9pol-${runId}`;
    const settings = db.collection('system_settings');
    const prior = await settings.findOne({ key: 'auth_policy' });
    try {
      await settings.updateOne(
        { key: 'auth_policy' },
        {
          $set: {
            overrides: {
              [target]: { class: 'unattended', require_totp: true, session_ttl_hours: 48 },
              lilly: { session_ttl_hours: 2 }, // partial override merges
            },
          },
        },
        { upsert: true },
      );
      await refreshAuthPolicyCache();
      expect(getAuthPolicy(target)).toEqual({
        class: 'unattended',
        require_totp: true,
        session_ttl_hours: 48,
      });
      // Partial override merges over the default entry.
      const lillyPol = getAuthPolicy('lilly');
      expect(lillyPol.session_ttl_hours).toBe(2);
      expect(lillyPol.class).toBe('interactive');
      expect(lillyPol.require_totp).toBe(false);
      // Unrelated identities are untouched.
      expect(getAuthPolicy('satori').class).toBe('unattended');
    } finally {
      if (prior === null) await settings.deleteOne({ key: 'auth_policy' });
      else await settings.replaceOne({ key: 'auth_policy' }, prior);
      await refreshAuthPolicyCache();
    }
  });

  // 10 ── revoke/list scoping ────────────────────────────────────────────
  it('criterion 10: caller revokes own sessions; operator revokes any (≥8-char prefix); list is caller-scoped', async () => {
    const uri = await enroll(LILLY, 'lilly');
    const secret = secretOf(uri);
    const a = await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: totpCode(secret, { time: BASE_T }),
    });
    clock.ms = (BASE_T + 30) * 1000; // next step → second session
    const b = await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: totpCode(secret, { time: BASE_T + 30 }),
    });
    const hashA = hashOf(a.token!);
    const hashB = hashOf(b.token!);

    // Another untrusted caller cannot revoke lilly's session by prefix.
    expect(
      await svc.revokeSession({ caller: SHOSHIN, tokenHashOrPrefix: hashA.slice(0, 12) }),
    ).toEqual({ revoked: 0 });

    // Too-short identifiers revoke nothing.
    expect(await svc.revokeSession({ caller: LILLY, tokenHashOrPrefix: 'ab' })).toEqual({
      revoked: 0,
    });

    // Lilly revokes her OWN session by an 8-char hash prefix.
    expect(
      await svc.revokeSession({ caller: LILLY, tokenHashOrPrefix: hashA.slice(0, 8) }),
    ).toEqual({ revoked: 1 });
    expect(await svc.validateSession(a.token!)).toEqual({
      valid: false,
      identity: null,
      reason: 'session revoked',
    });

    // Operator revokes any session by its exact hash.
    expect(await svc.revokeSession({ caller: OPERATOR, tokenHashOrPrefix: hashB })).toEqual({
      revoked: 1,
    });

    // List scoping: shoshin sees nothing; lilly sees her own (both revoked);
    // the operator sees all rows with the identity included.
    expect(await svc.listSessions(SHOSHIN)).toEqual([]);
    const lillyList = await svc.listSessions(LILLY);
    expect(lillyList).toHaveLength(2);
    for (const row of lillyList) {
      expect(Object.keys(row).sort()).toEqual(['created_at', 'expires_at', 'revoked_at']);
      expect(row.revoked_at).not.toBeNull();
    }
    const opList = await svc.listSessions(OPERATOR);
    expect(opList).toHaveLength(2);
    expect(opList.every((row) => row.identity === 'lilly')).toBe(true);
    for (const row of opList) {
      expect(Object.keys(row).sort()).toEqual([
        'created_at',
        'expires_at',
        'identity',
        'revoked_at',
      ]);
    }
  });

  // 11 ── audit: exactly one value-free row per attempt ───────────────────
  it('criterion 11: enroll/issue/revoke write exactly one vault_audit row each, whitelist keys only, value-free', async () => {
    const uri = await enroll(OPERATOR, 'lilly'); // 1 totp_enroll ok row
    const secret = secretOf(uri);
    const issued = await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: totpCode(secret, { time: BASE_T }),
    }); // 1 session_issue ok row
    await svc.issueSession({
      caller: LILLY,
      identity: 'lilly',
      totpCode: totpCode(secret, { time: BASE_T }),
    }); // replay → 1 session_issue denied row
    await svc.revokeSession({
      caller: LILLY,
      tokenHashOrPrefix: hashOf(issued.token!).slice(0, 12),
    }); // 1 session_revoke ok row
    await svc.revokeSession({ caller: LILLY, tokenHashOrPrefix: 'zz' }); // denied revoke

    const rows = await auditRows();
    // The store writes its own value-free put/open rows to the same audit
    // collection; the F9 contract rows are the three auth actions.
    const authRows = rows.filter((r) =>
      ['totp_enroll', 'session_issue', 'session_revoke'].includes(r.action),
    );
    expect(authRows.length).toBe(5);
    const counts: Record<string, number> = {};
    for (const row of authRows) counts[row.action] = (counts[row.action] ?? 0) + 1;
    expect(counts['totp_enroll']).toBe(1);
    expect(counts['session_issue']).toBe(2);
    expect(counts['session_revoke']).toBe(2);

    const json = JSON.stringify(authRows);
    for (const row of authRows) {
      for (const key of Object.keys(row)) {
        expect(AUDIT_KEYS.has(key)).toBe(true);
      }
      expect(row.service).toBe('auth');
      expect(Date.parse(row.at as string)).not.toBeNaN();
      if (row.action === 'totp_enroll') {
        expect(row.actor).toBe('satori');
        expect(row.secret_id).toBe('lilly/auth-totp');
        expect(row.outcome).toBe('ok');
      }
      if (row.action === 'session_revoke') {
        expect(row.secret_id).toBeNull();
      }
    }
    // Every row in the shared trail (incl. the store's put/open rows) is
    // whitelist-keyed; the enrollment really produced a put row and the
    // issues really opened the envelope.
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        expect(AUDIT_KEYS.has(key)).toBe(true);
      }
    }
    expect(rows.some((r) => r.action === 'put')).toBe(true);
    expect(rows.some((r) => r.action === 'open')).toBe(true);
    // Value-free: no secret, URI, token, hash or envelope material anywhere.
    expect(json).not.toContain(secret);
    expect(json).not.toContain('otpauth://');
    expect(json).not.toContain(issued.token);
    expect(json).not.toContain(hashOf(issued.token!));
    for (const forbidden of ['ciphertext', 'dek_wrapped', 'envelope', 'token_hash']) {
      expect(json).not.toContain(forbidden);
    }
  });

  // 12 ── REST behavior at /api/v1/auth (getCaller()) ────────────────────
  it('REST: POST /enroll-totp operator → 201 {enrolled, identity, otpauth_uri}; untrusted for another identity → 403', async () => {
    const res = await req(OPERATOR, 'POST', '/enroll-totp', { identity: 'lilly' });
    expect(res.status).toBe(201);
    const body: any = await res.clone().json();
    expect(body.enrolled).toBe(true);
    expect(body.identity).toBe('lilly');
    expect(body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/Katra:lilly\?secret=/);
    // Never echoed anywhere else.
    expect(JSON.stringify(await rawSecret('lilly/auth-totp'))).not.toContain(
      secretOf(body.otpauth_uri as string),
    );

    const denied = await req(LILLY, 'POST', '/enroll-totp', { identity: 'shoshin' });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe('operator only');

    // Self-enrollment by an untrusted caller is their own partition.
    const self = await req(SHOSHIN, 'POST', '/enroll-totp', { identity: 'shoshin' });
    expect(self.status).toBe(201);

    expect((await req(LILLY, 'POST', '/enroll-totp', {})).status).toBe(400);
  });

  it('REST: POST /session → 201 {issued, token, expires_at}; wrong code → 403', async () => {
    const enrollRes = await req(LILLY, 'POST', '/enroll-totp', { identity: 'lilly' });
    const uri: any = (await enrollRes.json()).otpauth_uri;
    const secret = secretOf(uri as string);

    const ok = await req(LILLY, 'POST', '/session', {
      identity: 'lilly',
      totp_code: totpCode(secret, { time: BASE_T }),
    });
    expect(ok.status).toBe(201);
    const body: any = await ok.clone().json();
    expect(body.issued).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(body.expires_at).toBe(new Date(BASE_T * 1000 + 12 * HOUR_MS).toISOString());
    // The raw token is never stored — hash only.
    const doc = await sessionDoc(hashOf(body.token as string));
    expect(doc).not.toBeNull();
    expect(JSON.stringify(doc)).not.toContain(body.token);

    const bad = await req(LILLY, 'POST', '/session', {
      identity: 'lilly',
      totp_code: '999999',
    });
    expect(bad.status).toBe(403);
    expect((await bad.json()).error).toBe('invalid TOTP code');

    expect((await req(LILLY, 'POST', '/session', { identity: 'lilly' })).status).toBe(400);
  });

  it('REST: DELETE /session + GET /sessions follow the caller-scoped contract', async () => {
    const enrollRes = await req(LILLY, 'POST', '/enroll-totp', { identity: 'lilly' });
    const secret = secretOf((await enrollRes.json()).otpauth_uri as string);
    const issueRes = await req(LILLY, 'POST', '/session', {
      identity: 'lilly',
      totp_code: totpCode(secret, { time: BASE_T }),
    });
    const token: any = (await issueRes.json()).token;
    const hash = hashOf(token as string);

    // shoshin cannot delete lilly's session (prefix matches nothing of hers).
    const foreign = await req(SHOSHIN, 'DELETE', '/session', {
      token_hash: hash.slice(0, 16),
    });
    expect(foreign.status).toBe(200);
    expect((await foreign.json()).revoked).toBe(0);

    const del = await req(LILLY, 'DELETE', '/session', { token_hash: hash });
    expect(del.status).toBe(200);
    expect((await del.json()).revoked).toBe(1);

    // An EMPTY (no JSON) DELETE body is not an error: revokes nothing.
    const emptyDel = await req(LILLY, 'DELETE', '/session');
    expect(emptyDel.status).toBe(200);
    expect((await emptyDel.json()).revoked).toBe(0);

    const list = await req(SHOSHIN, 'GET', '/sessions');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);

    const lillyList: any[] = await (await req(LILLY, 'GET', '/sessions')).json();
    expect(lillyList).toHaveLength(1);
    expect(lillyList[0].revoked_at).not.toBeNull();
    expect(lillyList[0].identity).toBeUndefined(); // caller-scoped: no identity key
  });

  it('REST: issuer parameter flows into the otpauth URI', async () => {
    const res = await req(OPERATOR, 'POST', '/enroll-totp', {
      identity: 'zanshin',
      issuer: 'Katra Lab',
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.otpauth_uri).toMatch(
      /^otpauth:\/\/totp\/Katra Lab:zanshin\?secret=[A-Z2-7]+&issuer=Katra Lab&algorithm=SHA1&digits=6&period=30$/,
    );
  });
});
