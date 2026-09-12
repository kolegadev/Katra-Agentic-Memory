/**
 * Unit tests: Katra Vault store layer (F2) — contract success criteria 1–12.
 *
 * Real MongoDB via tests/helpers/db.ts: unique `test_`-prefixed collections
 * (test_secrets_f2 / test_vault_audit_f2), wiped in beforeEach, cleaned up in
 * afterAll. The suite is skipped when no MongoDB is reachable (same
 * convention as the code-graph suites) — run with MONGODB_URI set to
 * exercise it fully.
 *
 * Crypto assertions re-use F1's public API only (sealSecret is exercised
 * through the store; openSecret verifies stored envelopes round-trip).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import {
  cleanupTestData,
  closeTestDB,
  getTestDB,
  testCollection,
} from '../../helpers/db.js';
import { createVaultStore } from '../../../src/services/vault/store.js';
import type { VaultStore } from '../../../src/services/vault/store.js';
import { generateMasterKey, openSecret } from '../../../src/services/vault/crypto.js';
import type { CallerIdentity } from '../../../src/utils/caller-identity.js';
import type { VaultEnvelope } from '../../../src/services/vault/crypto.js';

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

describe.skipIf(!mongoAvailable)('Vault store (F2) — contract criteria', () => {
  const SECRETS = testCollection('secrets_f2');
  const AUDIT = testCollection('vault_audit_f2');
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
  const VALUE = 'sk-live-4f9c2b7a1e8d3c5f6a0b9d8e7c6f5a4b3c2d1e0f';
  const AGENT_C: CallerIdentity = { user_id: 'agent-c', trusted: false };
  const AGENT_A: CallerIdentity = { user_id: 'agent-a', trusted: false };
  const TRUSTED: CallerIdentity = { user_id: 'katra', trusted: true };

  const secretsCol = (): ReturnType<Db['collection']> => db.collection(SECRETS);
  const auditCol = (): ReturnType<Db['collection']> => db.collection(AUDIT);

  beforeAll(async () => {
    db = await getTestDB();
    store = createVaultStore({
      db,
      secretsCollection: SECRETS,
      auditCollection: AUDIT,
      masterKeyHex: MK,
    });
  });

  beforeEach(async () => {
    await cleanupTestData('secrets_f2');
    await cleanupTestData('vault_audit_f2');
  });

  afterAll(async () => {
    await cleanupTestData('secrets_f2');
    await cleanupTestData('vault_audit_f2');
    await closeTestDB();
  });

  async function rawSecret(secretId: string): Promise<Record<string, any> | null> {
    return (await secretsCol().findOne({ secret_id: secretId })) as Record<string, any> | null;
  }

  async function auditRows(): Promise<Array<Record<string, any>>> {
    return (await auditCol()
      .find({}, { projection: { _id: 0 } })
      .sort({ at: 1, secret_id: 1 })
      .toArray()) as unknown as Array<Record<string, any>>;
  }

  // 1 ── private put: owner sees meta; another untrusted caller sees [] ────
  it('criterion 1: private put is listed for the owner and invisible to another untrusted caller', async () => {
    const res = await store.putSecret({
      caller: AGENT_C,
      name: 'agentmail-api-key',
      value: VALUE,
      service: 'agentmail',
    });
    expect(res).toEqual({ secret_id: 'agent-c/agentmail-api-key', created: true });

    const agentCList = await store.listSecrets(AGENT_C);
    expect(agentCList.map((s) => s.secret_id)).toEqual(['agent-c/agentmail-api-key']);
    expect(agentCList[0]!.service).toBe('agentmail');
    expect(await store.listSecrets(AGENT_A)).toEqual([]);
  });

  // 2 ── team put: owner + another user both see meta; shared_id only ─────
  it('criterion 2: team put is visible to owner and another user, owner is shared_id only', async () => {
    const res = await store.putSecret({
      caller: AGENT_C,
      name: 'slack-token',
      value: 'xoxb-team-token',
      scope: 'team',
      kind: 'token',
    });
    expect(res.secret_id).toBe('team:my-team/slack-token');

    for (const caller of [AGENT_C, AGENT_A]) {
      const list = await store.listSecrets(caller);
      expect(list.map((s) => s.secret_id)).toEqual(['team:my-team/slack-token']);
      expect(list[0]!.kind).toBe('token');
    }

    const raw = await rawSecret('team:my-team/slack-token');
    expect(raw!.owner).toEqual({ shared_id: 'my-team' }); // user_id absent
    expect(raw!.owner.user_id).toBeUndefined();
    expect(raw!.meta.created_by).toBe('agent-c');
  });

  // 3 ── IDOR: untrusted callers are always pinned to their own identity ──
  it('criterion 3: untrusted caller cannot write into another identity partition (owner.user_id === caller.user_id)', async () => {
    // agent-a puts first under the same name; agent-c then puts the same name.
    await store.putSecret({ caller: AGENT_A, name: 'gh-token', value: 'agent-a-token' });
    const agentCRes = await store.putSecret({
      caller: AGENT_C,
      name: 'gh-token',
      value: 'agent-c-token',
      aclReaders: ['agent-a'], // untrusted grant is ignored — no cross-user spreading
    });
    expect(agentCRes).toEqual({ secret_id: 'agent-c/gh-token', created: true });

    // Pinned to the caller identity in the DB, both rows intact:
    const agentCRow = await rawSecret('agent-c/gh-token');
    expect(agentCRow!.owner.user_id).toBe(AGENT_C.user_id);
    expect(agentCRow!.acl.readers).toEqual([]);
    const agentARow = await rawSecret('agent-a/gh-token');
    expect(agentARow!.owner.user_id).toBe(AGENT_A.user_id);
    expect(agentARow!.meta.created_by).toBe('agent-a');

    // No cross-partition visibility:
    expect((await store.listSecrets(AGENT_C)).map((s) => s.secret_id)).toEqual(['agent-c/gh-token']);
    expect((await store.listSecrets(AGENT_A)).map((s) => s.secret_id)).toEqual([
      'agent-a/gh-token',
    ]);
  });

  // 4 ── getSecretMeta: exact key set, no envelope / value fields ─────────
  it('criterion 4: getSecretMeta returns exactly SecretMeta keys — no envelope, no value', async () => {
    await store.putSecret({ caller: AGENT_C, name: 'mail', value: VALUE });
    const meta = await store.getSecretMeta(AGENT_C, 'agent-c/mail');
    expect(meta).not.toBeNull();
    const keys = Object.keys(meta!).sort();
    expect(keys).toEqual(
      [
        'secret_id',
        'name',
        'owner',
        'acl',
        'service',
        'kind',
        'meta',
        'flags',
      ].sort(),
    );
    const json = JSON.stringify(meta);
    for (const forbidden of ['envelope', 'ciphertext', 'dek_wrapped', VALUE]) {
      expect(json).not.toContain(forbidden);
    }
    // Unknown / invisible ids are null, not an error:
    expect(await store.getSecretMeta(AGENT_C, 'agent-c/nope')).toBeNull();
    expect(await store.getSecretMeta(AGENT_A, 'agent-c/mail')).toBeNull();
  });

  // 5 ── stored envelope round-trips via F1 openSecret ────────────────────
  it('criterion 5: stored envelope decrypts to the original value with F1 openSecret', async () => {
    await store.putSecret({ caller: AGENT_C, name: 'mail', value: VALUE });
    await store.putSecret({
      caller: AGENT_C,
      name: 'team-creds',
      value: 'team-value',
      scope: 'team',
    });
    const privateRow = (await rawSecret('agent-c/mail')) as unknown as {
      envelope: VaultEnvelope;
    };
    const teamRow = (await rawSecret('team:my-team/team-creds')) as unknown as {
      envelope: VaultEnvelope;
    };
    expect(openSecret(privateRow.envelope, 'user:agent-c', MK)).toBe(VALUE);
    expect(openSecret(teamRow.envelope, 'shared:my-team', MK)).toBe('team-value');
  });

  // 6 ── duplicate put: created:false, value replaced with a fresh seal ───
  it('criterion 6: duplicate put overwrites with created:false and a fresh ciphertext', async () => {
    const first = await store.putSecret({ caller: AGENT_C, name: 'mail', value: 'v1' });
    expect(first).toEqual({ secret_id: 'agent-c/mail', created: true });
    const before = await rawSecret('agent-c/mail');

    const dup = await store.putSecret({
      caller: AGENT_C,
      name: 'mail',
      value: 'v2-new-value',
      service: 'agentmail',
    });
    expect(dup).toEqual({ secret_id: 'agent-c/mail', created: false });

    const after = await rawSecret('agent-c/mail');
    expect(after!.envelope.ciphertext).not.toBe(before!.envelope.ciphertext);
    expect(after!.envelope.dek_wrapped).not.toBe(before!.envelope.dek_wrapped);
    expect(openSecret(after!.envelope, 'user:agent-c', MK)).toBe('v2-new-value');
    // meta.created_* preserved across the overwrite:
    expect(after!.meta.created_by).toBe(before!.meta.created_by);
    expect(after!.meta.created_at).toBe(before!.meta.created_at);
    expect(after!.meta.updated_at).not.toBe(before!.meta.updated_at);
    expect(after!.service).toBe('agentmail');
  });

  // 7 ── RBAC delete ───────────────────────────────────────────────────────
  it('criterion 7: non-owner untrusted delete is refused; owner delete removes the row', async () => {
    await store.putSecret({ caller: AGENT_C, name: 'mail', value: VALUE });

    expect(await store.deleteSecret(AGENT_A, 'agent-c/mail')).toEqual({ deleted: false });
    expect(await rawSecret('agent-c/mail')).not.toBeNull();

    expect(await store.deleteSecret(AGENT_C, 'agent-c/mail')).toEqual({ deleted: true });
    expect(await rawSecret('agent-c/mail')).toBeNull();
  });

  // 8 ── rotate ────────────────────────────────────────────────────────────
  it('criterion 8: owner rotate re-seals (fresh ciphertext + wrapped DEK) with the same plaintext, sets rotation_due_at', async () => {
    await store.putSecret({ caller: AGENT_C, name: 'mail', value: VALUE });
    const before = await rawSecret('agent-c/mail');

    expect(await store.rotateSecret(AGENT_C, 'agent-c/mail')).toEqual({ rotated: true });

    const after = await rawSecret('agent-c/mail');
    expect(after!.envelope.ciphertext).not.toBe(before!.envelope.ciphertext);
    expect(after!.envelope.dek_wrapped).not.toBe(before!.envelope.dek_wrapped);
    expect(after!.envelope.iv).not.toBe(before!.envelope.iv);
    expect(openSecret(after!.envelope, 'user:agent-c', MK)).toBe(VALUE);

    const due = Date.parse(after!.meta.rotation_due_at as string);
    expect(Number.isNaN(due)).toBe(false);
    const drift = Math.abs(due - (Date.now() + 30 * 24 * 60 * 60 * 1000));
    expect(drift).toBeLessThan(60 * 1000); // now + 30 days (±1 min)

    // Non-owner untrusted rotate is refused and leaves the envelope untouched:
    const beforeDeny = await rawSecret('agent-c/mail');
    expect(await store.rotateSecret(AGENT_A, 'agent-c/mail')).toEqual({ rotated: false });
    const afterDeny = await rawSecret('agent-c/mail');
    expect(afterDeny!.envelope.ciphertext).toBe(beforeDeny!.envelope.ciphertext);
    expect(afterDeny!.envelope.dek_wrapped).toBe(beforeDeny!.envelope.dek_wrapped);
  });

  // 9 ── value-free audit trail ────────────────────────────────────────────
  it('criterion 9: put/delete/rotate/open each write exactly one vault_audit row with only allowed keys', async () => {
    await store.putSecret({ caller: AGENT_C, name: 'mail', value: VALUE, service: 'agentmail' });
    await store.rotateSecret(AGENT_C, 'agent-c/mail');
    await store.openSecretValue(AGENT_C, 'agent-c/mail');
    await store.deleteSecret(AGENT_C, 'agent-c/mail');

    const rows = await auditRows();
    const byAction = new Map(rows.map((r) => [r.action, r]));
    expect(rows.length).toBe(4);
    for (const action of ['put', 'rotate', 'open', 'delete']) {
      expect(byAction.has(action)).toBe(true);
      const row = byAction.get(action)!;
      // Exactly one row per action:
      expect(rows.filter((r) => r.action === action).length).toBe(1);
      // Keys ⊆ {at, actor, action, secret_id, service, outcome, error}:
      for (const key of Object.keys(row)) {
        expect(AUDIT_KEYS.has(key)).toBe(true);
      }
      expect(row.at).toEqual(expect.any(String));
      expect(Date.parse(row.at as string)).not.toBeNaN();
      expect(row.actor).toBe('agent-c');
      expect(row.secret_id).toBe('agent-c/mail');
      expect(row.service).toBe('agentmail');
      expect(row.outcome).toBe('ok');
      // Value-free: never the value, plaintext, or envelope fields:
      const json = JSON.stringify(row);
      expect(json).not.toContain(VALUE);
      for (const forbidden of ['ciphertext', 'dek_wrapped', 'iv', 'tag', 'envelope']) {
        expect(json).not.toContain(forbidden);
      }
    }
  });

  // 10 ── acl.readers (trusted grant) ─────────────────────────────────────
  it('criterion 10: trusted-granted acl reader sees, may open, and may NOT delete', async () => {
    const res = await store.putSecret({
      caller: TRUSTED,
      name: 'shared-mailbox',
      value: VALUE,
      aclReaders: ['agent-a'],
    });
    expect(res.secret_id).toBe('katra/shared-mailbox');

    // Reader sees it in list:
    const agentAList = await store.listSecrets(AGENT_A);
    expect(agentAList.map((s) => s.secret_id)).toEqual(['katra/shared-mailbox']);
    // Reader may open; last_used_at is set:
    expect(await store.openSecretValue(AGENT_A, 'katra/shared-mailbox')).toBe(VALUE);
    const raw = await rawSecret('katra/shared-mailbox');
    expect(typeof raw!.meta.last_used_at).toBe('string');
    // Reader may NOT delete:
    expect(await store.deleteSecret(AGENT_A, 'katra/shared-mailbox')).toEqual({
      deleted: false,
    });
    expect(await rawSecret('katra/shared-mailbox')).not.toBeNull();
    // Owner (trusted) can delete:
    expect(await store.deleteSecret(TRUSTED, 'katra/shared-mailbox')).toEqual({
      deleted: true,
    });
  });

  // 10b ── team member may OPEN team secrets (use path; F7 approval gates use)
  it('criterion 10b: any team member opens a team-scoped secret (shared_id owner)', async () => {
    await store.putSecret({
      caller: TRUSTED,
      name: 'team-pat',
      value: 'team-pat-value',
      scope: 'team',
    });
    // agent-c (untrusted, not the creator, not an acl reader) is a team member:
    expect(await store.openSecretValue(AGENT_C, 'team:my-team/team-pat')).toBe(
      'team-pat-value',
    );
    const raw = await rawSecret('team:my-team/team-pat');
    expect(typeof raw!.meta.last_used_at).toBe('string');
    // team members may still not delete team secrets (shared-owner rows):
    expect(await store.deleteSecret(AGENT_C, 'team:my-team/team-pat')).toEqual({
      deleted: false,
    });
    expect(await store.deleteSecret(TRUSTED, 'team:my-team/team-pat')).toEqual({
      deleted: true,
    });
  });

  // 11 ── master key missing ───────────────────────────────────────────────
  it('criterion 11: without a master key, put throws and list/get/delete still work', async () => {
    const saved = process.env.KATRA_VAULT_MASTER_KEY;
    delete process.env.KATRA_VAULT_MASTER_KEY;
    try {
      // Seed a row with the keyed store first, then use a keyless store:
      await store.putSecret({ caller: AGENT_C, name: 'mail', value: VALUE });
      const keyless = createVaultStore({
        db,
        secretsCollection: SECRETS,
        auditCollection: AUDIT,
      });
      await expect(
        keyless.putSecret({ caller: AGENT_C, name: 'other', value: 'x' }),
      ).rejects.toThrow('vault: master key not configured');
      await expect(
        keyless.openSecretValue(AGENT_C, 'agent-c/mail'),
      ).rejects.toThrow('vault: master key not configured');

      // List/get/delete work without a key:
      const list = await keyless.listSecrets(AGENT_C);
      expect(list.map((s) => s.secret_id)).toEqual(['agent-c/mail']);
      const meta = await keyless.getSecretMeta(AGENT_C, 'agent-c/mail');
      expect(meta!.name).toBe('mail');
      expect(await keyless.deleteSecret(AGENT_C, 'agent-c/mail')).toEqual({ deleted: true });
      expect(await rawSecret('agent-c/mail')).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.KATRA_VAULT_MASTER_KEY;
      else process.env.KATRA_VAULT_MASTER_KEY = saved;
    }
  });

  // 12 ── test_-prefixed collections + cleanup ─────────────────────────────
  it('criterion 12: uses test_-prefixed collections (asserted by the suite setup)', async () => {
    expect(SECRETS.startsWith('test_')).toBe(true);
    expect(AUDIT.startsWith('test_')).toBe(true);
    // Sanity: rows land in the test collections only.
    await store.putSecret({ caller: AGENT_C, name: 'mail', value: VALUE });
    expect(await rawSecret('agent-c/mail')).not.toBeNull();
    expect(
      await db.collection('secrets').countDocuments({ secret_id: 'agent-c/mail' }),
    ).toBe(0);
    await cleanupTestData('secrets_f2'); // beforeEach would wipe on next test anyway
  });

  // ── extra guard: RBAC on openSecretValue for non-members ───────────────
  it('RBAC guard: an untrusted non-member may not open another identity\'s private secret', async () => {
    await store.putSecret({ caller: AGENT_C, name: 'mail', value: VALUE });
    await expect(store.openSecretValue(AGENT_A, 'agent-c/mail')).rejects.toThrow(/vault/);
    const raw = await rawSecret('agent-c/mail');
    expect(raw!.meta.last_used_at).toBeNull();
    expect((await store.listSecrets(AGENT_A)).length).toBe(0);
  });
});
