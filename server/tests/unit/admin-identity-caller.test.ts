/**
 * Unit tests: admin identity endpoint resolves the CALLER's user_id (F2)
 *
 * The identity answer is per CALLER (getCaller()), not a process-wide
 * default — each machine's wake ritual reads the record for its own user_id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: () => ({
      findOne: async () => ({
        value: { name: 'Satori', chosen_by: 'the agent', established: '2026-08-19' },
      }),
      updateOne: async () => ({ acknowledged: true }),
      insertOne: async () => ({ acknowledged: true, insertedId: 'x' }),
    }),
  }),
  is_database_connected: () => true,
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { Hono } from 'hono';
import { createCallerAuthMiddleware } from '../../src/middleware/caller-auth.js';
import { create_admin_routes } from '../../src/routes/admin-routes.js';
import { DEFAULT_USER_ID } from '../../src/services/memory/memory-scope-service.js';
import {
  clearClientKeyIdentities,
  hashApiKey,
  registerClientKeyIdentity,
} from '../../src/utils/api-key-manager.js';

const SHOSHIN_KEY = 'katra-shoshin-identity-test-key';
const envNames = ['MCP_API_KEY', 'ADMIN_API_KEY', 'KATRA_API_KEY', 'BACKUP_MCP_KEYS'];

const app = new Hono();
app.use('/api/*', createCallerAuthMiddleware());
app.route('/api/v1/admin', create_admin_routes());

async function getIdentity(key: string | undefined) {
  const headers: Record<string, string> = {};
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return app.request('http://localhost/api/v1/admin/identity', { headers });
}

describe('Admin identity endpoint — caller-resolved user_id (F2)', () => {
  beforeEach(() => {
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
    registerClientKeyIdentity(hashApiKey(SHOSHIN_KEY), 'shoshin');
  });

  afterEach(() => {
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
  });

  it('returns the caller-resolved user_id for a mapped client key', async () => {
    const res = await getIdentity(SHOSHIN_KEY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.identity.user_id).toBe('shoshin');
    expect(body.identity.name).toBe('Satori');
  });

  it('falls back to the safe default caller when no identity is resolved', async () => {
    const res = await getIdentity(undefined);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity.user_id).toBe(DEFAULT_USER_ID);
  });
});
