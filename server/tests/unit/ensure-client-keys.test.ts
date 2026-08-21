/**
 * Unit tests: ensureClientKeys (F1 — client_keys provisioning)
 *
 * Provisions satori (legacy key hash) + shoshin/zanshin (freshly generated)
 * into system_settings.client_keys. Asserts: idempotency, hashes-only in the
 * database, plaintext printed exactly once, and that the stored hashes feed
 * resolveCallerIdentity end to end.
 *
 * Uses a dedicated throwaway MongoDB database on the local dev mongod so the
 * production data is never touched; the settings document lives in a
 * test-prefixed collection and the database is dropped in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

import {
  ensureClientKeys,
  hashApiKey,
  getClientKeyIdentityCount,
  clearClientKeyIdentities,
  resolveCallerIdentity,
} from '../../src/utils/api-key-manager.js';
import { connect_to_mongodb, close_connection, get_database } from '../../src/database/connection.js';

const TEST_URI = process.env.KATRA_TEST_MONGO_URI || 'mongodb://localhost:27017/katra?authSource=admin';
const TEST_DB = 'katra_test_f1_client_keys';
const TEST_COLLECTION = 'test_system_settings';
const TEST_SETTINGS_KEY = 'test_client_keys_f1';
const LEGACY_MCP_KEY = 'katra-mcp-legacy-test-key';

// Captured during the FIRST ensureClientKeys call in beforeAll (generation).
const captured = {
  printedLines: [] as string[],
  plaintext: new Map<string, string>(), // user_id -> plaintext key
};

let mongoReady = false;

async function readStoredRecord() {
  const db = get_database();
  return db.collection(TEST_COLLECTION).findOne({ key: TEST_SETTINGS_KEY });
}

function storedRecords(doc: any): Array<{ key_hash: string; user_id: string; display_name: string; created_at: string }> {
  return doc!.value as Array<{ key_hash: string; user_id: string; display_name: string; created_at: string }>;
}

describe('ensureClientKeys', () => {
  beforeAll(async () => {
    process.env.MONGODB_URI = TEST_URI;
    process.env.DATABASE_NAME = TEST_DB;
    process.env.MCP_API_KEY = LEGACY_MCP_KEY;
    try {
      const db = await connect_to_mongodb();
      mongoReady = !!db;
    } catch {
      mongoReady = false;
    }
    if (!mongoReady) return;

    // First call: generates shoshin/zanshin and prints the plaintext once.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await ensureClientKeys({ collection: TEST_COLLECTION, settingsKey: TEST_SETTINGS_KEY });
      captured.printedLines = logSpy.mock.calls.map(call => call.map(String).join(' '));
    } finally {
      logSpy.mockRestore();
    }
    for (const line of captured.printedLines) {
      const match = line.match(/\b(katra-(shoshin|zanshin)-[0-9a-f]{64})\b/);
      if (match) captured.plaintext.set(match[2], match[1]);
    }
  });

  afterAll(async () => {
    clearClientKeyIdentities();
    try {
      await get_database().dropDatabase();
    } catch {
      /* already gone */
    }
    await close_connection();
    delete process.env.MONGODB_URI;
    delete process.env.DATABASE_NAME;
    delete process.env.MCP_API_KEY;
  });

  it('provisions satori (legacy hash), shoshin and zanshin entries', async (ctx) => {
    if (!mongoReady) return ctx.skip();
    const doc = await readStoredRecord();
    expect(doc).toBeTruthy();
    expect(doc!.key).toBe(TEST_SETTINGS_KEY);
    const records = storedRecords(doc);
    expect(records).toHaveLength(3);

    const byUser = new Map(records.map(r => [r.user_id, r]));
    expect(byUser.has('satori')).toBe(true);
    expect(byUser.has('shoshin')).toBe(true);
    expect(byUser.has('zanshin')).toBe(true);

    // satori maps to the legacy env key hash — no new key generated for satori.
    expect(byUser.get('satori')!.key_hash).toBe(hashApiKey(LEGACY_MCP_KEY));
    expect(byUser.get('satori')!.display_name).toBe('Satori');

    // All hashes are sha256 hex digests.
    for (const r of records) {
      expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof r.created_at).toBe('string');
    }
  });

  it('stores only hashes — never plaintext keys', async (ctx) => {
    if (!mongoReady) return ctx.skip();
    const doc = await readStoredRecord();
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain(LEGACY_MCP_KEY);
    expect(serialized).not.toContain('katra-shoshin-');
    expect(serialized).not.toContain('katra-zanshin-');
  });

  it('prints the freshly generated plaintext keys exactly once', async (ctx) => {
    if (!mongoReady) return ctx.skip();
    // The generation call (beforeAll) printed each key once.
    const shoshinPrints = captured.printedLines.filter(line => line.includes('katra-shoshin-'));
    const zanshinPrints = captured.printedLines.filter(line => line.includes('katra-zanshin-'));
    expect(shoshinPrints).toHaveLength(1);
    expect(zanshinPrints).toHaveLength(1);
    expect(captured.plaintext.has('shoshin')).toBe(true);
    expect(captured.plaintext.has('zanshin')).toBe(true);

    // The printed plaintext hashes to the stored hashes.
    const doc = await readStoredRecord();
    const byUser = new Map(storedRecords(doc).map(r => [r.user_id, r]));
    expect(byUser.get('shoshin')!.key_hash).toBe(hashApiKey(captured.plaintext.get('shoshin')!));
    expect(byUser.get('zanshin')!.key_hash).toBe(hashApiKey(captured.plaintext.get('zanshin')!));

    // A subsequent call must NOT re-print any keys.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let secondRun: string[] = [];
    try {
      await ensureClientKeys({ collection: TEST_COLLECTION, settingsKey: TEST_SETTINGS_KEY });
      secondRun = logSpy.mock.calls.map(call => call.map(String).join(' '));
    } finally {
      logSpy.mockRestore();
    }
    expect(secondRun.some(line => line.includes('katra-shoshin-'))).toBe(false);
    expect(secondRun.some(line => line.includes('katra-zanshin-'))).toBe(false);
  });

  it('is idempotent — repeated calls keep the same key hashes', async (ctx) => {
    if (!mongoReady) return ctx.skip();
    const first = await readStoredRecord();
    const firstHashes = storedRecords(first)
      .slice()
      .sort((a, b) => a.user_id.localeCompare(b.user_id))
      .map(r => ({ user_id: r.user_id, key_hash: r.key_hash }));

    await ensureClientKeys({ collection: TEST_COLLECTION, settingsKey: TEST_SETTINGS_KEY });
    await ensureClientKeys({ collection: TEST_COLLECTION, settingsKey: TEST_SETTINGS_KEY });

    const after = await readStoredRecord();
    const afterHashes = storedRecords(after)
      .slice()
      .sort((a, b) => a.user_id.localeCompare(b.user_id))
      .map(r => ({ user_id: r.user_id, key_hash: r.key_hash }));

    expect(afterHashes).toEqual(firstHashes);
    expect(storedRecords(after)).toHaveLength(3);
  });

  it('feeds resolveCallerIdentity end to end', async (ctx) => {
    if (!mongoReady) return ctx.skip();
    clearClientKeyIdentities();
    await ensureClientKeys({ collection: TEST_COLLECTION, settingsKey: TEST_SETTINGS_KEY });
    expect(getClientKeyIdentityCount()).toBe(3);

    // Present shoshin's printed plaintext key from a remote address.
    const identity = await resolveCallerIdentity({
      remoteAddress: '192.168.1.99',
      headers: { 'x-mcp-auth': captured.plaintext.get('shoshin')! },
      url: '/mcp',
    });
    expect(identity).toEqual({ user_id: 'shoshin', trusted: false });

    const zanshinIdentity = await resolveCallerIdentity({
      remoteAddress: '192.168.1.99',
      headers: { authorization: `Bearer ${captured.plaintext.get('zanshin')!}` },
      url: '/mcp',
    });
    expect(zanshinIdentity).toEqual({ user_id: 'zanshin', trusted: false });

    // The legacy env key resolves to satori untrusted.
    const legacyIdentity = await resolveCallerIdentity({
      remoteAddress: '192.168.1.99',
      headers: { authorization: `Bearer ${LEGACY_MCP_KEY}` },
      url: '/mcp',
    });
    expect(legacyIdentity).toEqual({ user_id: 'satori', trusted: false });
  });
});
