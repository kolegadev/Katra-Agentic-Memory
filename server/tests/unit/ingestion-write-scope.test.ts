/**
 * Unit tests: REST episodic ingestion write scope (F2)
 *
 * Episodic inserts default to the shared scope ('my-team') while keeping the
 * writer's user_id; `private: true` opts out; an explicit shared_id is
 * honored. The database is mocked so we assert what WOULD be written.
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
  clearClientKeyIdentities,
  hashApiKey,
  registerClientKeyIdentity,
} from '../../src/utils/api-key-manager.js';

const SHOSHIN_KEY = 'katra-shoshin-write-scope-test-key';
const envNames = ['MCP_API_KEY', 'ADMIN_API_KEY', 'KATRA_API_KEY', 'BACKUP_MCP_KEYS'];

const app = new Hono();
app.use('/api/*', createCallerAuthMiddleware());
app.route('/api/v1/memory', create_memory_routes());

async function postEvent(key: string, body: Record<string, unknown>) {
  return app.request('http://localhost/api/v1/memory/episodic/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
}

const validEvent = (extra: Record<string, unknown> = {}) => ({
  session_id: 'sess-scope-1',
  event_type: 'user_message',
  content: 'hello from the write-scope test',
  ...extra,
});

describe('REST ingestion — write scope (F2)', () => {
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

  it('episodic insert defaults to shared_id my-team with the writer user_id', async () => {
    const res = await postEvent(SHOSHIN_KEY, validEvent());
    expect(res.status).toBe(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].doc.user_id).toBe('shoshin');
    expect(state.inserts[0].doc.shared_id).toBe('my-team');
  });

  it('private: true omits shared_id entirely', async () => {
    const res = await postEvent(SHOSHIN_KEY, validEvent({ private: true }));
    expect(res.status).toBe(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].doc).not.toHaveProperty('shared_id');
    expect(state.inserts[0].doc.user_id).toBe('shoshin');
  });

  it('an explicit shared_id is honored', async () => {
    const res = await postEvent(SHOSHIN_KEY, validEvent({ shared_id: 'team-x' }));
    expect(res.status).toBe(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].doc.shared_id).toBe('team-x');
  });

  it('untrusted callers are attributed to their own user_id even with default sharing', async () => {
    const res = await postEvent(SHOSHIN_KEY, validEvent({ user_id: 'shoshin' }));
    expect(res.status).toBe(201);
    expect(state.inserts[0].doc.user_id).toBe('shoshin');
    expect(state.inserts[0].doc.shared_id).toBe('my-team');
  });
});
