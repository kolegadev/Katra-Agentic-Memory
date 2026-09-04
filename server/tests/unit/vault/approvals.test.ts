/**
 * Unit tests: Katra Vault per-service approvals (F6) — contract success
 * criteria 1–11.
 *
 * Store + REST criteria run against real MongoDB via tests/helpers/db.ts with
 * unique `test_`-prefixed collections (test_approvals_f6 /
 * test_vault_audit_f6), wiped in beforeEach, cleaned up in afterAll; skipped
 * when no MongoDB is reachable (same convention as the F2/F3 vault suites).
 * Callers are simulated with runWithCaller(...) for route tests, and passed
 * directly to store methods (the store validates caller objects itself).
 *
 * MCP wiring is asserted against the mcp-server.ts source (3 exact tool
 * names, zod schemas, exported handlers, dispatch cases — same pattern as
 * the F3 suite); the operator gate is exercised by calling the exported
 * handlers under runWithCaller (no DB required — the 'operator only' throw
 * must happen BEFORE any store work). The MCP connected flow runs against
 * the real Mongo resolved by the store's defaults with an `f6mcp-` reserved
 * prefix and full sweep in beforeAll/afterAll, mirroring the F3 MCP suite.
 *
 * Dashboard wiring + escaping discipline (criterion 9) are asserted at the
 * source level against dashboard/index.html (the same F4 vaultEsc /
 * vaultJsId helpers the Verifier re-checks adversarially).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
import type { VaultStore } from '../../../src/services/vault/store.js';
import {
  handleVaultApproveService,
  handleVaultRevokeApproval,
  handleVaultListApprovals,
} from '../../../src/mcp-server.js';
import {
  close_connection,
  connect_to_mongodb,
  get_database,
  is_database_connected,
} from '../../../src/database/connection.js';

const MONGO_URI =
  process.env.MONGODB_URI ||
  'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin';

// Probe connectivity (incl. auth) up front; skip DB-dependent tests when
// unavailable, so the unit run stays green without a MongoDB.
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

const MCP_SERVER_SOURCE = readFileSync(
  new URL('../../../src/mcp-server.ts', import.meta.url),
  'utf8',
).toString();
const STORE_SOURCE = readFileSync(
  new URL('../../../src/services/vault/store.ts', import.meta.url),
  'utf8',
).toString();
const ROUTES_SOURCE = readFileSync(
  new URL('../../../src/routes/vault-routes.ts', import.meta.url),
  'utf8',
).toString();
const DASHBOARD_SOURCE = readFileSync(
  new URL('../../../../dashboard/index.html', import.meta.url),
  'utf8',
).toString();

const DAY_MS = 24 * 60 * 60 * 1000;
const APPROVAL_KEYS = new Set([
  'identity',
  'service',
  'granted_by',
  'granted_at',
  'expires_at',
  'revoked_at',
  'status',
]);
const AUDIT_KEYS = new Set([
  'at',
  'actor',
  'action',
  'secret_id',
  'service',
  'outcome',
  'error',
]);

// ── Source-level wiring (criterion 8 + 9, no DB) ─────────────────────────

describe('vault approvals — source wiring (F6)', () => {
  it('criterion 8: registers the three approval tools with zod schemas', () => {
    for (const [name, schema] of [
      ['vault_approve_service', 'VaultApproveServiceInput'],
      ['vault_revoke_approval', 'VaultRevokeApprovalInput'],
      ['vault_list_approvals', 'VaultListApprovalsInput'],
    ] as Array<[string, string]>) {
      expect(MCP_SERVER_SOURCE).toContain(`name: '${name}'`);
      expect(MCP_SERVER_SOURCE).toContain(
        `inputSchema: zodToJsonSchema(${schema}) as Record<string, unknown>`,
      );
    }
  });

  it('criterion 8: exports the three approval handler functions', () => {
    for (const h of [
      'handleVaultApproveService',
      'handleVaultRevokeApproval',
      'handleVaultListApprovals',
    ]) {
      expect(MCP_SERVER_SOURCE).toMatch(
        new RegExp(`export async function ${h}\\(args: unknown\\): Promise<TextContent\\[\\]>`),
      );
    }
  });

  it('criterion 8: dispatches the three approval tool names in the CallTool switch', () => {
    for (const [name, handler] of [
      ['vault_approve_service', 'handleVaultApproveService'],
      ['vault_revoke_approval', 'handleVaultRevokeApproval'],
      ['vault_list_approvals', 'handleVaultListApprovals'],
    ] as Array<[string, string]>) {
      expect(MCP_SERVER_SOURCE).toContain(
        `case '${name}': result = await ${handler}(args); break;`,
      );
    }
  });

  it('criterion 8: operator gate text sits before parsing/store work in the approve/revoke handlers', () => {
    // The untrusted rejection must occur before any store interaction —
    // asserted structurally: the throw line precedes the .parse(args) call
    // and no lazyVaultStore() call precedes it in the same function body.
    for (const fn of ['handleVaultApproveService', 'handleVaultRevokeApproval']) {
      const start = MCP_SERVER_SOURCE.indexOf(`export async function ${fn}(`);
      const end = MCP_SERVER_SOURCE.indexOf('\n}\n', start);
      const body = MCP_SERVER_SOURCE.slice(start, end);
      const gateIdx = body.indexOf(`if (!caller.trusted) throw new Error('operator only')`);
      const parseIdx = body.indexOf('Input.parse(args)');
      const storeIdx = body.indexOf('lazyVaultStore()');
      expect(gateIdx).toBeGreaterThan(-1);
      expect(parseIdx).toBeGreaterThan(gateIdx);
      expect(storeIdx).toBeGreaterThan(gateIdx);
    }
  });

  it('criterion 7: vault-routes.ts registers the three approval endpoints', () => {
    expect(ROUTES_SOURCE).toContain(`router.post('/approvals', async (c) => {`);
    expect(ROUTES_SOURCE).toContain(`router.delete('/approvals', async (c) => {`);
    expect(ROUTES_SOURCE).toContain(`router.get('/approvals', async (c) => {`);
  });

  it('factory option approvalsCollection defaults to vault_approvals (store source)', () => {
    expect(STORE_SOURCE).toContain(`approvalsCollection?: string; // default 'vault_approvals' (F6)`);
    expect(STORE_SOURCE).toContain(`const APPROVALS_COLLECTION = 'vault_approvals';`);
  });

  it('criterion 9: dashboard wires the approvals panel to the endpoints with F4-grade escaping', () => {
    // Endpoint wiring: one fetch per verb against /vault/approvals.
    expect(DASHBOARD_SOURCE).toContain(
      "const r = await fetch(`${API}/vault/approvals`, { headers: authHeaders() });",
    );
    expect(DASHBOARD_SOURCE).toContain(
      "const r = await fetch(`${API}/vault/approvals`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });",
    );
    expect(DASHBOARD_SOURCE).toContain(
      "const r = await fetch(`${API}/vault/approvals?${q}`, { method: 'DELETE', headers: authHeaders() });",
    );
    // Table + form element ids exist once.
    expect(DASHBOARD_SOURCE).toContain('id="vault-approvals"');
    expect(DASHBOARD_SOURCE).toContain('id="va-identity"');
    expect(DASHBOARD_SOURCE).toContain('id="va-service"');
    expect(DASHBOARD_SOURCE).toContain('id="va-ttl"');
    // Revoke buttons use the F4 vaultJsId helper for BOTH args (single-quote
    // attribute context: ' is escaped as \u0027 inside vaultJsId).
    expect(DASHBOARD_SOURCE).toContain(
      `onclick='approvalRevoke(\${vaultJsId(a.identity)},\${vaultJsId(a.service)})'`,
    );
    // Identity/service/granted_by cells go through vaultEsc; dates through
    // vaultFmt; status is own-property-whitelisted before use.
    const rowSrc = DASHBOARD_SOURCE.slice(
      DASHBOARD_SOURCE.indexOf('function approvalRow('),
      DASHBOARD_SOURCE.indexOf('\n}\n', DASHBOARD_SOURCE.indexOf('function approvalRow(')),
    );
    expect(rowSrc).toContain('vaultEsc(a && a.identity)');
    expect(rowSrc).toContain('vaultEsc(a && a.service)');
    expect(rowSrc).toContain('vaultEsc(a && a.granted_by)');
    expect(rowSrc).toContain('vaultFmt(a && a.granted_at)');
    expect(rowSrc).toContain('vaultFmt(a && a.expires_at)');
    expect(rowSrc).toContain('hasOwnProperty.call(VAULT_APPROVAL_STATUSES, a.status)');
    expect(rowSrc).not.toContain('innerHTML');
  });
});

// ── MCP handlers: operator gate (no DB needed) ───────────────────────────

describe('vault approval MCP handlers — operator gate (criterion 8)', () => {
  const LILLY: CallerIdentity = { user_id: 'lilly', trusted: false };

  it('vault_approve_service rejects untrusted callers with \'operator only\' before any store work', async () => {
    await expect(
      runWithCaller(LILLY, () =>
        handleVaultApproveService({ identity: 'lilly', service: 'agentmail', ttlDays: 30 }),
      ),
    ).rejects.toThrow('operator only');
  });

  it('vault_revoke_approval rejects untrusted callers with \'operator only\' before any store work', async () => {
    await expect(
      runWithCaller(LILLY, () =>
        handleVaultRevokeApproval({ identity: 'lilly', service: 'agentmail' }),
      ),
    ).rejects.toThrow('operator only');
  });

  it('vault_list_approvals is caller-scoped and needs no operator flag (no DB → disconnected warning)', async () => {
    expect(is_database_connected()).toBe(false); // no DB work at import time
    const content = await runWithCaller(LILLY, () => handleVaultListApprovals({}));
    expect(content[0].text).toBe('⚠️ MongoDB disconnected.');
  });
});

// ── Store + REST (real Mongo) ────────────────────────────────────────────

describe.skipIf(!mongoAvailable)('vault approvals (F6) — store + REST contract criteria', () => {
  const APPROVALS = testCollection('approvals_f6');
  const AUDIT = testCollection('vault_audit_f6');

  let db: Db;
  let store: VaultStore;
  let app: Hono;
  const LILLY: CallerIdentity = { user_id: 'lilly', trusted: false };
  const SHOSHIN: CallerIdentity = { user_id: 'shoshin', trusted: false };
  const SATORI: CallerIdentity = { user_id: 'satori', trusted: true };
  const DAY_30 = 30 * DAY_MS;

  const approvalsCol = () => db.collection(APPROVALS);
  const auditCol = () => db.collection(AUDIT);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    db = await getTestDB();
    store = createVaultStore({
      db,
      secretsCollection: testCollection('secrets_f6'),
      auditCollection: AUDIT,
      approvalsCollection: APPROVALS,
    });
    app = new Hono();
    app.route(
      '/api/v1/vault',
      create_vault_routes({
        store: createVaultStore({
          db,
          secretsCollection: testCollection('secrets_f6'),
          auditCollection: AUDIT,
          approvalsCollection: APPROVALS,
        }),
      }),
    );
  });

  beforeEach(async () => {
    await cleanupTestData('approvals_f6');
    await cleanupTestData('vault_audit_f6');
  });

  afterAll(async () => {
    await cleanupTestData('approvals_f6');
    await cleanupTestData('vault_audit_f6');
    await closeTestDB();
  });

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
      app.request(`http://localhost/api/v1/vault${path}`, init),
    );
  }

  async function approvalDocs(): Promise<Array<Record<string, any>>> {
    return (await approvalsCol()
      .find({}, { projection: { _id: 0 } })
      .sort({ identity: 1, service: 1 })
      .toArray()) as unknown as Array<Record<string, any>>;
  }

  async function auditRows(): Promise<Array<Record<string, any>>> {
    return (await auditCol()
      .find({}, { projection: { _id: 0 } })
      .sort({ at: 1 })
      .toArray()) as unknown as Array<Record<string, any>>;
  }

  // 1 ── untrusted grant/revoke → denied result + denied audit; no row ────
  it('criterion 1: untrusted grant/revoke → {granted:false}/{revoked:false} + denied audit row, no approval row created/updated', async () => {
    // Grant attempt with nothing pre-existing: no row appears.
    const deny = await store.grantApproval({
      caller: LILLY,
      identity: 'lilly',
      service: 'agentmail',
    });
    expect(deny).toEqual({ granted: false, approval: null });
    expect(await approvalDocs()).toEqual([]);

    // An operator row exists; untrusted re-grant + revoke must not touch it.
    await store.grantApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' });
    const before = await approvalDocs();
    expect(before).toHaveLength(1);

    const denyGrant = await store.grantApproval({
      caller: SHOSHIN,
      identity: 'lilly',
      service: 'agentmail',
    });
    expect(denyGrant).toEqual({ granted: false, approval: null });
    const denyRevoke = await store.revokeApproval({
      caller: SHOSHIN,
      identity: 'lilly',
      service: 'agentmail',
    });
    expect(denyRevoke).toEqual({ revoked: false });

    const after = await approvalDocs();
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before[0]); // untouched: same expires_at, still active-shaped

    // Each attempt wrote exactly one audit row: 1 ok (operator grant) + 3
    // denied (untrusted grant ×2 + untrusted revoke ×1).
    const rows = await auditRows();
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.outcome === 'ok')).toHaveLength(1);
    const denied = rows.filter((r) => r.outcome === 'denied');
    expect(denied).toHaveLength(3);
    for (const row of denied) {
      expect(row.secret_id).toBeNull();
      expect(['approval_grant', 'approval_revoke']).toContain(row.action);
    }
    const grantDenies = denied.filter((r) => r.action === 'approval_grant');
    expect(grantDenies.map((r) => r.actor).sort()).toEqual(['lilly', 'shoshin']);
    expect(denied.filter((r) => r.action === 'approval_revoke')[0].actor).toBe('shoshin');
  });

  // 2 ── operator grant: active row, +30d expiry, audit ok ────────────────
  it('criterion 2: operator grant → active row with expires_at = granted_at + 30d (±60s); audit approval_grant ok', async () => {
    const res = await store.grantApproval({
      caller: SATORI,
      identity: 'lilly',
      service: 'agentmail',
    });
    expect(res.granted).toBe(true);
    const a = res.approval!;
    expect(a.identity).toBe('lilly');
    expect(a.service).toBe('agentmail');
    expect(a.granted_by).toBe('satori');
    expect(a.revoked_at).toBeNull();
    expect(a.status).toBe('active');

    const drift = Math.abs(Date.parse(a.expires_at) - Date.parse(a.granted_at) - DAY_30);
    expect(drift).toBeLessThan(60 * 1000); // exactly now + 30 days (±1 min)

    const docs = await approvalDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0].revoked_at).toBeNull();
    // Raw row is value-free by construction — exactly the six model fields.
    expect(Object.keys(docs[0]).sort()).toEqual(
      [
        'expires_at',
        'granted_at',
        'granted_by',
        'identity',
        'revoked_at',
        'service',
      ].sort(),
    );

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: 'satori',
      action: 'approval_grant',
      secret_id: null,
      service: 'agentmail',
      outcome: 'ok',
    });

    // ttlDays override is honored.
    const short = await store.grantApproval({
      caller: SATORI,
      identity: 'shoshin',
      service: 'gcloud',
      ttlDays: 7,
    });
    const driftShort = Math.abs(
      Date.parse(short.approval!.expires_at) - Date.parse(short.approval!.granted_at) -
        7 * DAY_MS,
    );
    expect(driftShort).toBeLessThan(60 * 1000);
  });

  // 3 ── idempotent re-grant: one row, extended expires_at ────────────────
  it('criterion 3: re-granting an active (identity, service) extends expires_at on the same single row', async () => {
    const first = await store.grantApproval({
      caller: SATORI,
      identity: 'lilly',
      service: 'agentmail',
    });
    await sleep(5);
    const second = await store.grantApproval({
      caller: SATORI,
      identity: 'lilly',
      service: 'agentmail',
    });
    expect(second.granted).toBe(true);

    const docs = await approvalDocs();
    expect(docs).toHaveLength(1); // no duplicate row
    expect(docs[0].revoked_at).toBeNull();

    // expires_at extended from now (second > first, still ~30d out).
    expect(second.approval!.expires_at > first.approval!.expires_at).toBe(true);
    const drift = Math.abs(Date.parse(second.approval!.expires_at) - (Date.now() + DAY_30));
    expect(drift).toBeLessThan(60 * 1000);
    // Only TWO audit rows total (one per grant op — re-grant is not a dup insert).
    expect(await auditRows()).toHaveLength(2);
  });

  // 4 ── hasActiveApproval: expiry / revoke / wildcard ────────────────────
  it('criterion 4: hasActiveApproval true within expiry; false after expiry (injected past expires_at); false when revoked; wildcard * true for any service', async () => {
    await store.grantApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' });
    expect(await store.hasActiveApproval('lilly', 'agentmail')).toBe(true);

    // Expiry: inject a past expires_at directly (contract-approved test hook).
    await approvalsCol().updateOne(
      { identity: 'lilly', service: 'agentmail' },
      { $set: { expires_at: new Date(Date.now() - DAY_MS).toISOString() } },
    );
    expect(await store.hasActiveApproval('lilly', 'agentmail')).toBe(false);
    const listed = await store.listApprovals(SATORI);
    expect(listed.find((x) => x.service === 'agentmail')!.status).toBe('expired');

    // Revoke kills an active grant.
    await store.grantApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' });
    await store.revokeApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' });
    expect(await store.hasActiveApproval('lilly', 'agentmail')).toBe(false);

    // Wildcard '*' grants any service.
    await store.grantApproval({ caller: SATORI, identity: 'lilly', service: '*' });
    expect(await store.hasActiveApproval('lilly', 'gcloud')).toBe(true);
    expect(await store.hasActiveApproval('lilly', 'agentmail')).toBe(true);
    expect(await store.hasActiveApproval('shoshin', 'gcloud')).toBe(false); // unrelated id
  });

  // 5 ── revoke sets revoked_at + re-grant after revoke ───────────────────
  it('criterion 5: revoke → status revoked with revoked_at; re-grant after revoke works; double revoke → {revoked:false}', async () => {
    await store.grantApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' });
    const rev = await store.revokeApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' });
    expect(rev).toEqual({ revoked: true });

    const docs = await approvalDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0].revoked_at).not.toBeNull();
    const listed = await store.listApprovals(SATORI);
    expect(listed[0].status).toBe('revoked');
    expect(await store.hasActiveApproval('lilly', 'agentmail')).toBe(false);

    // Revoking an already-revoked row → false (+ one denied audit row).
    expect(
      await store.revokeApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' }),
    ).toEqual({ revoked: false });

    // Re-grant after revoke: single row revived with revoked_at null.
    const regrant = await store.grantApproval({
      caller: SATORI,
      identity: 'lilly',
      service: 'agentmail',
    });
    expect(regrant.granted).toBe(true);
    expect(regrant.approval!.revoked_at).toBeNull();
    expect(regrant.approval!.status).toBe('active');
    const after = await approvalDocs();
    expect(after).toHaveLength(1);
    expect(after[0].revoked_at).toBeNull();
    expect(await store.hasActiveApproval('lilly', 'agentmail')).toBe(true);
  });

  // 6 ── listApprovals caller-scoped ──────────────────────────────────────
  it('criterion 6: listApprovals is caller-scoped — untrusted sees own identity rows only; trusted sees all', async () => {
    await store.grantApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' });
    await store.grantApproval({ caller: SATORI, identity: 'lilly', service: '*' });
    await store.grantApproval({ caller: SATORI, identity: 'shoshin', service: 'gcloud' });

    const lillyRows = await store.listApprovals(LILLY);
    expect(lillyRows).toHaveLength(2);
    for (const row of lillyRows) expect(row.identity).toBe('lilly');
    expect(new Set(lillyRows.map((r) => r.service))).toEqual(new Set(['agentmail', '*']));
    // Response rows carry exactly the ServiceApproval key set.
    for (const row of lillyRows) {
      expect(Object.keys(row).sort()).toEqual([...APPROVAL_KEYS].sort());
    }

    expect(await store.listApprovals(SHOSHIN)).toHaveLength(1);
    expect((await store.listApprovals(SATORI))).toHaveLength(3); // operator: all
  });

  // 10 ── audit rows for approval actions: value-free, whitelist keys ─────
  it('criterion 10: approval audit rows are value-free and use only the F2 whitelist keys', async () => {
    await store.grantApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' });
    await store.grantApproval({ caller: LILLY, identity: 'lilly', service: 'agentmail' }); // denied
    await store.revokeApproval({ caller: SATORI, identity: 'lilly', service: 'agentmail' });
    await store.revokeApproval({ caller: SHOSHIN, identity: 'shoshin', service: 'gcloud' }); // denied

    const rows = await auditRows();
    expect(rows).toHaveLength(4);
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual([
      'approval_grant',
      'approval_grant',
      'approval_revoke',
      'approval_revoke',
    ]);
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        expect(AUDIT_KEYS.has(key)).toBe(true);
      }
      expect(Date.parse(row.at)).not.toBeNaN();
      expect(row.secret_id).toBeNull();
      expect(['ok', 'denied'].includes(row.outcome)).toBe(true);
      // No value/envelope material anywhere in the row.
      const json = JSON.stringify(row);
      expect(json).not.toContain('envelope');
      expect(json).not.toContain('ciphertext');
      expect(json).not.toContain('dek_wrapped');
    }
    // One 'ok' per successful op, one 'denied' per refused attempt.
    expect(rows.filter((r) => r.outcome === 'ok')).toHaveLength(2);
    expect(rows.filter((r) => r.outcome === 'denied')).toHaveLength(2);
    expect(rows.filter((r) => r.service === 'agentmail')).toHaveLength(3);
    expect(rows.filter((r) => r.service === 'gcloud')).toHaveLength(1);
  });

  // ── REST (criterion 7): 403 untrusted, 201/200 shapes, GET scoped ─────
  it('criterion 7a: untrusted POST/DELETE /approvals → 403; operator POST → 201 {granted, approval}', async () => {
    const denied = await req(LILLY, 'POST', '/approvals', {
      identity: 'lilly',
      service: 'agentmail',
    });
    expect(denied.status).toBe(403);
    expect(await approvalDocs()).toEqual([]);

    const ok = await req(SATORI, 'POST', '/approvals', {
      identity: 'lilly',
      service: 'agentmail',
      ttlDays: 30,
    });
    expect(ok.status).toBe(201);
    const body: any = await ok.json();
    expect(body.granted).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['approval', 'granted']);
    expect(Object.keys(body.approval).sort()).toEqual([...APPROVAL_KEYS].sort());
    expect(body.approval.identity).toBe('lilly');
    expect(body.approval.service).toBe('agentmail');
    expect(body.approval.status).toBe('active');

    const delDenied = await req(
      LILLY,
      'DELETE',
      '/approvals?identity=lilly&service=agentmail',
    );
    expect(delDenied.status).toBe(403);
    expect((await approvalDocs())[0].revoked_at).toBeNull(); // untouched

    // Untrusted write attempts left 'denied' audit rows behind (store-level
    // behavior visible through the REST surface too).
    const audit = await auditRows();
    expect(audit.filter((r) => r.outcome === 'denied')).toHaveLength(2);
    expect(audit.filter((r) => r.outcome === 'ok')).toHaveLength(1);
  });

  it('criterion 7b: operator DELETE → 200 {revoked:true}; GET caller-scoped', async () => {
    await req(SATORI, 'POST', '/approvals', { identity: 'lilly', service: 'agentmail' });
    await req(SATORI, 'POST', '/approvals', { identity: 'shoshin', service: 'gcloud' });

    // GET is caller-scoped: lilly (untrusted) sees only her own rows.
    const lillyList: any[] = await (await req(LILLY, 'GET', '/approvals')).json();
    expect(lillyList).toHaveLength(1);
    expect(lillyList[0].identity).toBe('lilly');
    // Trusted GET sees all rows.
    const all: any[] = await (await req(SATORI, 'GET', '/approvals')).json();
    expect(all).toHaveLength(2);

    const del = await req(SATORI, 'DELETE', '/approvals?identity=lilly&service=agentmail');
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ revoked: true });

    // Revoking a non-existent grant → 403 (no active grant).
    const ghost = await req(SATORI, 'DELETE', '/approvals?identity=ghost&service=agentmail');
    expect(ghost.status).toBe(403);

    // lilly still sees her (now revoked) row with status 'revoked'.
    const afterList: any[] = await (await req(LILLY, 'GET', '/approvals')).json();
    expect(afterList[0].status).toBe('revoked');
  });

  it('criterion 7c: bad approval input → 400 with static errors', async () => {
    expect((await req(SATORI, 'POST', '/approvals', {})).status).toBe(400);
    expect((await req(SATORI, 'POST', '/approvals', { identity: 'lilly' })).status).toBe(400);
    expect((await req(SATORI, 'POST', '/approvals', { identity: 1, service: 'a' })).status).toBe(400);
    expect(
      (await req(SATORI, 'POST', '/approvals', { identity: 'lilly', service: 'a', ttlDays: 0 }))
        .status,
    ).toBe(400);
    expect((await req(SATORI, 'POST', '/approvals', 'not-an-object')).status).toBe(400);
    expect(
      (await req(SATORI, 'DELETE', '/approvals?identity=lilly')).status,
    ).toBe(400);
    expect(
      (await req(SATORI, 'DELETE', '/approvals?service=agentmail')).status,
    ).toBe(400);
  });

  it('validation: identity with "/" and empty identity/service are refused with static vault errors', async () => {
    await expect(
      store.grantApproval({ caller: SATORI, identity: 'a/b', service: 'agentmail' }),
    ).rejects.toThrow('vault:');
    await expect(
      store.grantApproval({ caller: SATORI, identity: '', service: 'agentmail' }),
    ).rejects.toThrow('vault:');
    await expect(
      store.grantApproval({ caller: SATORI, identity: 'lilly', service: '' }),
    ).rejects.toThrow('vault:');
    await expect(
      store.grantApproval({ caller: SATORI, identity: 'lilly', service: 'a', ttlDays: -1 }),
    ).rejects.toThrow('vault:');
    expect(await approvalDocs()).toEqual([]);
    // Refused invalid inputs write no audit rows either.
    expect(await auditRows()).toEqual([]);
  });
});

// ── MCP connected flow (real Mongo, default collections, f6mcp- prefix) ──

describe.skipIf(!mongoAvailable)('vault approval MCP handlers — connected flow (criterion 8)', () => {
  const LILLY: CallerIdentity = { user_id: 'lilly', trusted: false };
  const SATORI: CallerIdentity = { user_id: 'satori', trusted: true };

  const runId = randomBytes(4).toString('hex');
  const runPrefix = `f6mcp-${runId}`;
  const identity = (tag: string) => `${runPrefix}-${tag}`;
  const service = (tag: string) => `${runPrefix}-${tag}`;

  function as<T>(caller: CallerIdentity, fn: () => Promise<T>): Promise<T> {
    return runWithCaller(caller, fn);
  }

  function textOf(content: Array<{ type: string; text: string }>): string {
    return content[0].text;
  }

  beforeAll(async () => {
    if (!process.env.MONGODB_URI) process.env.MONGODB_URI = MONGO_URI;
    await connect_to_mongodb();
    // Sweep stale rows from earlier runs of this suite.
    const db = get_database();
    await db
      .collection('vault_approvals')
      .deleteMany({ identity: { $regex: '^f6mcp-' } });
    await db
      .collection('vault_audit')
      .deleteMany({ action: { $in: ['approval_grant', 'approval_revoke'] }, service: { $regex: '^f6mcp-' } });
  }, 120000); // connect_to_mongodb runs index initialization (slow first time)

  afterAll(async () => {
    try {
      const db = get_database();
      await db
        .collection('vault_approvals')
        .deleteMany({ identity: { $regex: '^f6mcp-' } });
      await db
        .collection('vault_audit')
        .deleteMany({ action: { $in: ['approval_grant', 'approval_revoke'] }, service: { $regex: '^f6mcp-' } });
    } finally {
      await close_connection();
    }
  });

  it('vault_approve_service grants for a trusted caller; vault_list_approvals is caller-scoped', async () => {
    const id = identity('lilly');
    const svc = service('agentmail');
    // The untrusted caller IS the granted identity — list scoping must show
    // exactly their own row.
    const GRANTEE: CallerIdentity = { user_id: id, trusted: false };
    const content = await as(SATORI, () =>
      handleVaultApproveService({ identity: id, service: svc, ttlDays: 30 }),
    );
    const body = JSON.parse(textOf(content)) as { granted: boolean; approval: any };
    expect(body.granted).toBe(true);
    expect(body.approval).toMatchObject({
      identity: id,
      service: svc,
      granted_by: 'satori',
      status: 'active',
    });
    expect(body.approval.revoked_at).toBeNull();

    // Untrusted caller lists only their own identity rows.
    const lillyList = JSON.parse(textOf(await as(GRANTEE, () => handleVaultListApprovals({}))));
    const mine = (lillyList as any[]).filter((x) => x.service === svc);
    expect(mine).toHaveLength(1);
    expect(mine[0].identity).toBe(id);

    // Revoke + confirm.
    const rev = JSON.parse(
      textOf(
        await as(SATORI, () =>
          handleVaultRevokeApproval({ identity: id, service: svc }),
        ),
      ),
    );
    expect(rev).toEqual({ revoked: true });
    const afterList = JSON.parse(textOf(await as(SATORI, () => handleVaultListApprovals({}))));
    const row = (afterList as any[]).find((x) => x.service === svc);
    expect(row.status).toBe('revoked');
  });

  it('vault_approve_service for an untrusted caller throws \'operator only\' and stores nothing', async () => {
    const id = identity('nope');
    const svc = service('denied');
    await expect(
      as(LILLY, () => handleVaultApproveService({ identity: id, service: svc })),
    ).rejects.toThrow('operator only');
    const db = get_database();
    const rows = await db
      .collection('vault_approvals')
      .countDocuments({ identity: id, service: svc });
    expect(rows).toBe(0);
  });
});
