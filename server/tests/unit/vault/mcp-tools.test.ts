/**
 * Unit tests: Katra Vault MCP tools (F3) — contract success criteria 8, 9.
 *
 * Wiring is asserted against the mcp-server.ts source (6 exact tool names,
 * zod schemas, exported handlers, dispatch cases — same pattern as the
 * code-graph MCP tool suite). Direct-handler tests simulate callers with
 * runWithCaller() from utils/caller-identity.js (the transport wraps every
 * tool invocation the same way, so getCaller() inside the handler is the
 * caller simulated here).
 *
 * The connected flow runs against the real MongoDB resolved by the vault
 * store's defaults (collection names 'secrets' / 'vault_audit' on the katra
 * database), mirroring the code-graph tool suite: secret names carry the
 * reserved 'f3mcp-' prefix and every row created is deleted in afterAll (and
 * swept in beforeAll) so no production data is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import {
  handleVaultPutSecret,
  handleVaultListSecrets,
  handleVaultGetSecret,
  handleVaultDeleteSecret,
  handleVaultRotateSecret,
  handleVaultAudit,
} from '../../../src/mcp-server.js';
import {
  close_connection,
  connect_to_mongodb,
  get_database,
  is_database_connected,
} from '../../../src/database/connection.js';
import { runWithCaller } from '../../../src/utils/caller-identity.js';
import type { CallerIdentity } from '../../../src/utils/caller-identity.js';
import { generateMasterKey } from '../../../src/services/vault/crypto.js';

const MONGO_URI =
  process.env.MONGODB_URI ||
  'mongodb://admin:katra-local-dev@localhost:27017/katra?authSource=admin';

// Probe connectivity (incl. auth) up front; skip DB-dependent tests when
// unavailable, so the unit run stays green without a MongoDB.
let mongoAvailable = false;
try {
  const probe = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  await probe.connect();
  await probe.close();
  mongoAvailable = true;
} catch {
  mongoAvailable = false;
}

const MCP_SERVER_SOURCE = await readFileSync(
  new URL('../../../src/mcp-server.ts', import.meta.url),
  'utf8',
).toString();

// ── Wiring tests (structural, against the source text) ────────────

describe('mcp-server wiring for the vault tools (F3)', () => {
  const REGISTERED: Array<[string, string]> = [
    ['vault_put_secret', 'VaultPutSecretInput'],
    ['vault_list_secrets', 'VaultListSecretsInput'],
    ['vault_get_secret', 'VaultGetSecretInput'],
    ['vault_delete_secret', 'VaultDeleteSecretInput'],
    ['vault_rotate_secret', 'VaultRotateSecretInput'],
    ['vault_audit', 'VaultAuditInput'],
  ];

  it('registers exactly the six vault tools with zod schemas', () => {
    for (const [name, schema] of REGISTERED) {
      expect(MCP_SERVER_SOURCE).toContain(`name: '${name}'`);
      expect(MCP_SERVER_SOURCE).toContain(
        `inputSchema: zodToJsonSchema(${schema}) as Record<string, unknown>`,
      );
    }
  });

  it('exports the six handler functions', () => {
    const handlers = [
      'handleVaultPutSecret',
      'handleVaultListSecrets',
      'handleVaultGetSecret',
      'handleVaultDeleteSecret',
      'handleVaultRotateSecret',
      'handleVaultAudit',
    ];
    for (const h of handlers) {
      expect(MCP_SERVER_SOURCE).toMatch(
        new RegExp(`export async function ${h}\\(args: unknown\\): Promise<TextContent\\[\\]>`),
      );
    }
  });

  it('dispatches the six tool names in the CallTool switch', () => {
    for (const [name, handler] of [
      ['vault_put_secret', 'handleVaultPutSecret'],
      ['vault_list_secrets', 'handleVaultListSecrets'],
      ['vault_get_secret', 'handleVaultGetSecret'],
      ['vault_delete_secret', 'handleVaultDeleteSecret'],
      ['vault_rotate_secret', 'handleVaultRotateSecret'],
      ['vault_audit', 'handleVaultAudit'],
    ] as Array<[string, string]>) {
      expect(MCP_SERVER_SOURCE).toContain(
        `case '${name}': result = await ${handler}(args); break;`,
      );
    }
  });

  it('does not connect to MongoDB at module import time', () => {
    expect(is_database_connected()).toBe(false);
  });
});

// ── Direct handler tests: disconnected guard + operator gate ─────

describe('vault MCP handlers — disconnected guard + operator gate', () => {
  const AGENT_C: CallerIdentity = { user_id: 'agent-c', trusted: false };
  const KATRA: CallerIdentity = { user_id: 'katra', trusted: true };

  it('vault_put_secret rejects untrusted callers with \'operator only\' (criterion 9)', async () => {
    await expect(
      runWithCaller(AGENT_C, () =>
        handleVaultPutSecret({ name: 'x', value: 'never-stored' }),
      ),
    ).rejects.toThrow('operator only');
  });

  it('store-touching handlers return a disconnected warning without a DB', async () => {
    const put = await runWithCaller(KATRA, () =>
      handleVaultPutSecret({ name: 'x', value: 'v' }),
    );
    expect(put[0].text).toBe('⚠️ MongoDB disconnected.');

    const list = await runWithCaller(AGENT_C, () => handleVaultListSecrets({}));
    expect(list[0].text).toBe('⚠️ MongoDB disconnected.');

    const get = await runWithCaller(AGENT_C, () =>
      handleVaultGetSecret({ secret_id: 'agent-c/x' }),
    );
    expect(get[0].text).toBe('⚠️ MongoDB disconnected.');

    const del = await runWithCaller(AGENT_C, () =>
      handleVaultDeleteSecret({ secret_id: 'agent-c/x' }),
    );
    expect(del[0].text).toBe('⚠️ MongoDB disconnected.');

    const rot = await runWithCaller(AGENT_C, () =>
      handleVaultRotateSecret({ secret_id: 'agent-c/x' }),
    );
    expect(rot[0].text).toBe('⚠️ MongoDB disconnected.');

    const audit = await runWithCaller(AGENT_C, () => handleVaultAudit({}));
    expect(audit[0].text).toBe('⚠️ MongoDB disconnected.');
  });
});

// ── Direct handler tests: connected flow (MongoDB required) ──────

describe.skipIf(!mongoAvailable)('vault MCP handlers — connected flow (criterion 8)', () => {
  const AGENT_C: CallerIdentity = { user_id: 'agent-c', trusted: false };
  const AGENT_A: CallerIdentity = { user_id: 'agent-a', trusted: false };
  const KATRA: CallerIdentity = { user_id: 'katra', trusted: true };
  const AUDIT_KEYS = new Set([
    'at',
    'actor',
    'action',
    'secret_id',
    'service',
    'outcome',
    'error',
  ]);

  const MK = generateMasterKey();
  const SECRET_VALUE = 'f3mcp-plaintext-4f9c2b7a1e8d3c5f6a0b';
  const createdIds: string[] = [];
  let savedKeyEnv: string | undefined;

  const runId = randomBytes(4).toString('hex');
  const name = (tag: string) => `f3mcp-${tag}-${runId}`;

  function as<T>(caller: CallerIdentity, fn: () => Promise<T>): Promise<T> {
    return runWithCaller(caller, fn);
  }

  function textOf(content: Array<{ type: string; text: string }>): string {
    return content[0].text;
  }

  beforeAll(async () => {
    if (!process.env.MONGODB_URI) process.env.MONGODB_URI = MONGO_URI;
    await connect_to_mongodb();
    savedKeyEnv = process.env.KATRA_VAULT_MASTER_KEY;
    process.env.KATRA_VAULT_MASTER_KEY = MK;
    // Sweep any stale rows from earlier runs of this suite.
    const db = get_database();
    await db
      .collection('secrets')
      .deleteMany({ secret_id: { $regex: 'f3mcp-' } });
    await db
      .collection('vault_audit')
      .deleteMany({ secret_id: { $regex: 'f3mcp-' } });
  }, 120000); // connect_to_mongodb runs index initialization (slow first time)

  afterAll(async () => {
    try {
      const db = get_database();
      if (createdIds.length > 0) {
        await db
          .collection('secrets')
          .deleteMany({ secret_id: { $in: createdIds } });
        await db
          .collection('vault_audit')
          .deleteMany({ secret_id: { $in: createdIds } });
      }
    } finally {
      if (savedKeyEnv === undefined) delete process.env.KATRA_VAULT_MASTER_KEY;
      else process.env.KATRA_VAULT_MASTER_KEY = savedKeyEnv;
      await close_connection();
    }
  });

  async function rawDoc(secretId: string): Promise<Record<string, any> | null> {
    return (await get_database()
      .collection('secrets')
      .findOne({ secret_id: secretId })) as Record<string, any> | null;
  }

  it('vault_put_secret stores for a trusted caller and returns {secret_id, created}', async () => {
    const n = name('put');
    const content = await as(KATRA, () =>
      handleVaultPutSecret({ name: n, value: SECRET_VALUE, service: 'agentmail' }),
    );
    const body = JSON.parse(textOf(content)) as { secret_id: string; created: boolean };
    expect(body).toEqual({ secret_id: `katra/${n}`, created: true });
    expect(textOf(content)).not.toContain(SECRET_VALUE);
    createdIds.push(body.secret_id);

    const doc = await rawDoc(body.secret_id);
    expect(doc).not.toBeNull();
    expect(doc!.owner.user_id).toBe('katra');
    expect(doc!.envelope).toBeDefined();
  });

  it('vault_put_secret honors ownerUserId for trusted callers only (no row for untrusted)', async () => {
    const n = name('putfor');
    const content = await as(KATRA, () =>
      handleVaultPutSecret({ name: n, value: 'agent-c-bound', ownerUserId: 'agent-c' }),
    );
    const body = JSON.parse(textOf(content)) as { secret_id: string };
    expect(body.secret_id).toBe(`agent-c/${n}`);
    createdIds.push(body.secret_id);
    const doc = await rawDoc(body.secret_id);
    expect(doc!.owner.user_id).toBe('agent-c');

    // Untrusted attempt is refused outright — nothing stored.
    const n2 = name('nope');
    await expect(
      as(AGENT_A, () =>
        handleVaultPutSecret({ name: n2, value: 'should-not-store', ownerUserId: 'agent-c' }),
      ),
    ).rejects.toThrow('operator only');
    expect(await rawDoc(`agent-c/${n2}`)).toBeNull();
    expect(await rawDoc(`agent-a/${n2}`)).toBeNull();
  });

  it('vault_get_secret returns the redacted view with length but never the plaintext', async () => {
    const n = name('get');
    const putContent = await as(KATRA, () =>
      handleVaultPutSecret({
        name: n,
        value: SECRET_VALUE,
        service: 'agentmail',
        ownerUserId: 'agent-c',
      }),
    );
    const secretId = (JSON.parse(textOf(putContent)) as { secret_id: string }).secret_id;
    createdIds.push(secretId);

    const content = await as(AGENT_C, () => handleVaultGetSecret({ secret_id: secretId }));
    const text = textOf(content);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.secret_id).toBe(secretId);
    expect(body.name).toBe(n);
    expect(body.scope).toBe('private');
    expect(body.service).toBe('agentmail');
    expect(body.length).toBe(SECRET_VALUE.length);
    expect(body.last_used_at).not.toBeNull();
    expect(body.status).toBe('active');
    expect(body.value).toBe('<redacted>');
    // Hard redaction: the plaintext and any envelope material never appear.
    expect(text).toContain('"value":"<redacted>"');
    expect(text).not.toContain(SECRET_VALUE);
    expect(text.toLowerCase()).not.toContain('ciphertext');
    expect(text.toLowerCase()).not.toContain('dek_wrapped');
  });

  it('vault_get_secret errors 404-equivalently for secrets the caller cannot see', async () => {
    const n = name('hidden');
    const putContent = await as(KATRA, () =>
      handleVaultPutSecret({ name: n, value: 'hidden-value', ownerUserId: 'agent-c' }),
    );
    const secretId = (JSON.parse(textOf(putContent)) as { secret_id: string }).secret_id;
    createdIds.push(secretId);
    await expect(as(AGENT_A, () => handleVaultGetSecret({ secret_id: secretId }))).rejects.toThrow(
      'secret not found',
    );
  });

  it('vault_list_secrets is caller-scoped: own + team, never another private', async () => {
    const agentCN = name('privl');
    const agentCPut = await as(KATRA, () =>
      handleVaultPutSecret({ name: agentCN, value: 'pl', ownerUserId: 'agent-c' }),
    );
    const agentCId = (JSON.parse(textOf(agentCPut)) as { secret_id: string }).secret_id;
    createdIds.push(agentCId);

    const agentAN = name('privs');
    const agentAPut = await as(KATRA, () =>
      handleVaultPutSecret({ name: agentAN, value: 'ps', ownerUserId: 'agent-a' }),
    );
    const agentAId = (JSON.parse(textOf(agentAPut)) as { secret_id: string }).secret_id;
    createdIds.push(agentAId);

    const teamN = name('team');
    const teamPut = await as(KATRA, () =>
      handleVaultPutSecret({ name: teamN, value: 'pt', scope: 'team' }),
    );
    const teamId = (JSON.parse(textOf(teamPut)) as { secret_id: string }).secret_id;
    createdIds.push(teamId);

    const agentCList = JSON.parse(
      textOf(await as(AGENT_C, () => handleVaultListSecrets({}))),
    ) as Array<{ secret_id: string }>;
    const agentCIds = agentCList.map((s) => s.secret_id);
    expect(agentCIds).toContain(agentCId);
    expect(agentCIds).toContain(teamId);
    expect(agentCIds).not.toContain(agentAId);

    const agentAList = JSON.parse(
      textOf(await as(AGENT_A, () => handleVaultListSecrets({}))),
    ) as Array<{ secret_id: string }>;
    const agentAIds = agentAList.map((s) => s.secret_id);
    expect(agentAIds).toContain(agentAId);
    expect(agentAIds).toContain(teamId);
    expect(agentAIds).not.toContain(agentCId);
  });

  it('vault_delete_secret / vault_rotate_secret enforce ownership; owner succeeds', async () => {
    const n = name('owner');
    const putContent = await as(KATRA, () =>
      handleVaultPutSecret({ name: n, value: 'own-me', ownerUserId: 'agent-c' }),
    );
    const secretId = (JSON.parse(textOf(putContent)) as { secret_id: string }).secret_id;
    createdIds.push(secretId);

    // Non-owner untrusted: denied, row unchanged.
    const rotDenied = await as(AGENT_A, () =>
      handleVaultRotateSecret({ secret_id: secretId }),
    );
    expect(JSON.parse(textOf(rotDenied))).toEqual({ rotated: false });
    const delDenied = await as(AGENT_A, () =>
      handleVaultDeleteSecret({ secret_id: secretId }),
    );
    expect(JSON.parse(textOf(delDenied))).toEqual({ deleted: false });
    expect(await rawDoc(secretId)).not.toBeNull();

    // Owner: rotate succeeds.
    const rot = await as(AGENT_C, () => handleVaultRotateSecret({ secret_id: secretId }));
    expect(JSON.parse(textOf(rot))).toEqual({ rotated: true });
    const doc = await rawDoc(secretId);
    expect(doc!.meta.rotation_due_at).not.toBeNull();

    // Owner: delete succeeds.
    const del = await as(AGENT_C, () => handleVaultDeleteSecret({ secret_id: secretId }));
    expect(JSON.parse(textOf(del))).toEqual({ deleted: true });
    expect(await rawDoc(secretId)).toBeNull();
  });

  it('vault_audit is actor-scoped for untrusted callers and value-free', async () => {
    const n = name('aud');
    const putContent = await as(KATRA, () =>
      handleVaultPutSecret({ name: n, value: SECRET_VALUE, ownerUserId: 'agent-c' }),
    );
    const secretId = (JSON.parse(textOf(putContent)) as { secret_id: string }).secret_id;
    createdIds.push(secretId);

    // agent-c opens her own secret → audit 'open' row with actor agent-c.
    await as(AGENT_C, () => handleVaultGetSecret({ secret_id: secretId }));
    // agent-a attempts a rotate → denied row with actor agent-a.
    await as(AGENT_A, () => handleVaultRotateSecret({ secret_id: secretId }));

    const agentCAudit = JSON.parse(
      textOf(await as(AGENT_C, () => handleVaultAudit({ secret_id: secretId }))),
    ) as Array<Record<string, any>>;
    expect(agentCAudit.length).toBeGreaterThan(0);
    for (const row of agentCAudit) {
      expect(row.actor).toBe('agent-c');
      expect(row.secret_id).toBe(secretId);
      for (const key of Object.keys(row)) expect(AUDIT_KEYS.has(key)).toBe(true);
    }
    const agentCActions = agentCAudit.map((r) => r.action);
    expect(agentCActions).toContain('open');
    expect(agentCActions).not.toContain('put'); // put rows are katra's

    const agentAAudit = JSON.parse(
      textOf(await as(AGENT_A, () => handleVaultAudit({ secret_id: secretId }))),
    ) as Array<Record<string, any>>;
    expect(agentAAudit.length).toBeGreaterThan(0);
    for (const row of agentAAudit) {
      expect(row.actor).toBe('agent-a');
      expect(row.outcome).toBe('denied');
    }

    const trustedAudit = JSON.parse(
      textOf(await as(KATRA, () => handleVaultAudit({ secret_id: secretId }))),
    ) as Array<Record<string, any>>;
    const trustedActors = new Set(trustedAudit.map((r) => r.actor));
    expect(trustedActors.has('agent-c')).toBe(true);
    expect(trustedActors.has('agent-a')).toBe(true);
    expect(trustedActors.has('katra')).toBe(true);

    const allText = JSON.stringify(trustedAudit);
    expect(allText).not.toContain(SECRET_VALUE);
    expect(allText.toLowerCase()).not.toContain('ciphertext');
  });

  it('vault_rotate_secret surfaces the master-key error without a key', async () => {
    const n = name('nokey');
    const putContent = await as(KATRA, () =>
      handleVaultPutSecret({ name: n, value: 'keyed-value', ownerUserId: 'agent-c' }),
    );
    const secretId = (JSON.parse(textOf(putContent)) as { secret_id: string }).secret_id;
    createdIds.push(secretId);

    delete process.env.KATRA_VAULT_MASTER_KEY;
    try {
      await expect(
        as(AGENT_C, () => handleVaultRotateSecret({ secret_id: secretId })),
      ).rejects.toThrow('vault: master key not configured');
    } finally {
      process.env.KATRA_VAULT_MASTER_KEY = MK;
    }
    expect(await rawDoc(secretId)).not.toBeNull();
  });
});
