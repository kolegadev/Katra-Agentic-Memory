/**
 * Unit tests: REST ingestion caller enforcement (F1)
 *
 * Untrusted callers may only write body.user_id equal to their own user_id;
 * trusted callers (loopback / admin key) may write for any user. The database
 * is mocked so the test asserts what WOULD be written without needing a live
 * MongoDB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  inserts: [] as Array<{ collection: string; doc: Record<string, unknown> }>,
}));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: (name: string) => ({
      insertOne: async (doc: Record<string, unknown>) => {
        state.inserts.push({ collection: name, doc });
        return { acknowledged: true, insertedId: 'test-inserted-id' };
      },
      updateOne: async () => ({ acknowledged: true }),
      findOne: async () => null,
      deleteMany: async () => ({ deletedCount: 0 }),
    }),
  }),
  is_database_connected: () => true,
  connect_to_mongodb: async () => null,
  close_connection: async () => {},
}));

import { Hono } from 'hono';
import { createCallerAuthMiddleware } from '../../src/middleware/caller-auth.js';
import { create_memory_routes } from '../../src/routes/memory-routes.js';
import {
  ensureApiKeys,
  registerClientKeyIdentity,
  clearClientKeyIdentities,
  hashApiKey,
} from '../../src/utils/api-key-manager.js';

const SHOSHIN_KEY = 'katra-shoshin-enforcement-test-key';
const LEGACY_MCP_KEY = 'katra-mcp-legacy-enforcement-key';
const ADMIN_KEY = 'katra-admin-enforcement-test-key';

const envNames = ['MCP_API_KEY', 'ADMIN_API_KEY', 'KATRA_API_KEY', 'BACKUP_MCP_KEYS'];

const app = new Hono();
app.use('/api/*', createCallerAuthMiddleware());
app.route('/api/v1/memory', create_memory_routes());

async function postEvent(key: string | undefined, body: Record<string, unknown>) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return app.request('http://localhost/api/v1/memory/episodic/events', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const validEvent = (user_id?: string) => ({
  session_id: 'sess-1',
  event_type: 'user_message',
  content: 'hello from the enforcement test',
  ...(user_id ? { user_id } : {}),
});

describe('REST ingestion — caller enforcement', () => {
  beforeEach(() => {
    state.inserts = [];
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
    registerClientKeyIdentity(hashApiKey(SHOSHIN_KEY), 'shoshin');
  });

  afterEach(() => {
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
  });

  it('untrusted caller writing ANOTHER user_id is rejected with 403', async () => {
    const res = await postEvent(SHOSHIN_KEY, validEvent('zanshin'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(state.inserts).toHaveLength(0);
  });

  it('untrusted caller writing their OWN user_id is allowed and attributed', async () => {
    const res = await postEvent(SHOSHIN_KEY, validEvent('shoshin'));
    expect(res.status).toBe(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].collection).toBe('episodic_events');
    expect(state.inserts[0].doc.user_id).toBe('shoshin');
  });

  it('untrusted caller omitting user_id is attributed to their own', async () => {
    const res = await postEvent(SHOSHIN_KEY, validEvent());
    expect(res.status).toBe(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].doc.user_id).toBe('shoshin');
  });

  it('trusted caller (admin key) may write for any user_id', async () => {
    process.env.MCP_API_KEY = LEGACY_MCP_KEY;
    process.env.KATRA_API_KEY = ADMIN_KEY;
    await ensureApiKeys();

    const res = await postEvent(ADMIN_KEY, validEvent('zanshin'));
    expect(res.status).toBe(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].doc.user_id).toBe('zanshin');
  });

  it('legacy env key behaves as untrusted satori (backward compatibility)', async () => {
    process.env.MCP_API_KEY = LEGACY_MCP_KEY;

    // Writing another user's events → 403 (the key is NOT trusted).
    const forbidden = await postEvent(LEGACY_MCP_KEY, validEvent('zanshin'));
    expect(forbidden.status).toBe(403);
    expect(state.inserts).toHaveLength(0);

    // Writing satori's own events → allowed.
    const allowed = await postEvent(LEGACY_MCP_KEY, validEvent('satori'));
    expect(allowed.status).toBe(201);
    expect(state.inserts[0].doc.user_id).toBe('satori');
  });

  it('valid-but-unmapped keys are rejected with 401 at the app boundary', async () => {
    const res = await postEvent('katra-unmapped-random-key', validEvent('shoshin'));
    expect(res.status).toBe(401);
    expect(state.inserts).toHaveLength(0);
  });
});
