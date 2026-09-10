/**
 * Unit tests: admin identity endpoint ?user_id= (F3)
 *
 * GET /api/v1/admin/identity?user_id=<id> returns that user's per-user
 * identity record and requires the admin key (the route itself stays on the
 * no-auth read-only list for the caller's own identity). PUT accepts
 * ?user_id= (or body.user_id) to write a per-user record — also admin-key
 * gated by the router middleware.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, any>());

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: () => ({
      findOne: async ({ key }: { key?: string } = {}) =>
        store.has(key!) ? { key, value: store.get(key!) } : null,
      updateOne: async ({ key }: { key?: string } = {}, update: any = {}) => {
        store.set(key!, (update.$set ?? {}).value);
        return { acknowledged: true, upsertedCount: 1 };
      },
      insertOne: async () => ({ acknowledged: true, insertedId: 'x' }),
      countDocuments: async () => 0,
      find: () => ({
        sort: () => ({ limit: () => ({ toArray: async () => [] }), toArray: async () => [] }),
        toArray: async () => [],
      }),
      aggregate: () => ({ toArray: async () => [] }),
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
import {
  ensureApiKeys,
  hashApiKey,
  registerClientKeyIdentity,
  clearClientKeyIdentities,
} from '../../src/utils/api-key-manager.js';

const ADMIN_KEY = 'katra-admin-f3-test-key';
const CLIENT_KEY = 'katra-agent-a-f3-test-key';
const envNames = ['MCP_API_KEY', 'ADMIN_API_KEY', 'KATRA_API_KEY', 'BACKUP_MCP_KEYS', 'BACKUP_KATRA_KEYS'];

const app = new Hono();
app.use('/api/*', createCallerAuthMiddleware());
app.route('/api/v1/admin', create_admin_routes());

function getIdentity(url: string, key?: string) {
  const headers: Record<string, string> = {};
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return app.request(url, { headers });
}

function putIdentity(url: string, body: Record<string, unknown>, key?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return app.request(url, { method: 'PUT', headers, body: JSON.stringify(body) });
}

describe('Admin identity endpoint — ?user_id= (F3)', () => {
  beforeEach(async () => {
    store.clear();
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
    process.env.MCP_API_KEY = 'katra-mcp-f3-test-key';
    process.env.KATRA_API_KEY = ADMIN_KEY;
    await ensureApiKeys();
    registerClientKeyIdentity(hashApiKey(CLIENT_KEY), 'agent-a');
    store.set('agent_identity', {
      name: 'Katra',
      chosen_by: 'the agent',
      established: '2026-08-19',
    });
    store.set('agent_identity:agent-a', {
      name: 'Agent-A',
      chosen_by: 'the agent',
      established: '2026-08-21',
    });
  });

  afterEach(() => {
    store.clear();
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
  });

  it('GET ?user_id= without a key → 401', async () => {
    const res = await getIdentity('http://localhost/api/v1/admin/identity?user_id=agent-a');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toContain('Admin API key required');
  });

  it('GET ?user_id= with a client key (not admin) → 401', async () => {
    const res = await getIdentity('http://localhost/api/v1/admin/identity?user_id=agent-a', CLIENT_KEY);
    expect(res.status).toBe(401);
  });

  it('GET ?user_id=agent-a with the admin key returns the Agent-A record', async () => {
    const res = await getIdentity('http://localhost/api/v1/admin/identity?user_id=agent-a', ADMIN_KEY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.identity.user_id).toBe('agent-a');
    expect(body.identity.name).toBe('Agent-A');
    expect(body.identity.established).toBe('2026-08-21');
  });

  it('GET ?user_id=agent-b with the admin key returns an unnamed default identity when the record is absent', async () => {
    const res = await getIdentity('http://localhost/api/v1/admin/identity?user_id=agent-b', ADMIN_KEY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity.user_id).toBe('agent-b');
    // F3: a missing per-user record must NEVER fall back to another agent's
    // identity (the legacy record is Katra's).
    expect(body.identity.name).toBe('agent-b');
    expect(body.identity.name).not.toBe('Katra');
    expect(body.identity.is_default).toBe(true);
    expect(body.identity.chosen_by).toBe('default (unnamed)');
  });

  it('GET ?user_id=agent-a with the admin key returns an unnamed default identity when the record is absent', async () => {
    store.delete('agent_identity:agent-a');
    const res = await getIdentity('http://localhost/api/v1/admin/identity?user_id=agent-a', ADMIN_KEY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity.user_id).toBe('agent-a');
    expect(body.identity.name).toBe('agent-a');
    expect(body.identity.name).not.toBe('Katra');
    expect(body.identity.is_default).toBe(true);
  });

  it('PUT ?user_id= without a key → 401 (router auth middleware)', async () => {
    const res = await putIdentity(
      'http://localhost/api/v1/admin/identity?user_id=agent-b',
      { name: 'Agent-B' },
    );
    expect(res.status).toBe(401);
  });

  it('PUT ?user_id=agent-b with the admin key writes agent_identity:agent-b', async () => {
    const res = await putIdentity(
      'http://localhost/api/v1/admin/identity?user_id=agent-b',
      { name: 'Agent-B', chosen_by: 'the agent', established: '2026-08-21' },
      ADMIN_KEY,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.identity.name).toBe('Agent-B');
    expect(body.identity.user_id).toBe('agent-b');
    expect(store.get('agent_identity:agent-b')?.name).toBe('Agent-B');
    // The legacy katra record is untouched.
    expect(store.get('agent_identity')?.name).toBe('Katra');
  });

  it('PUT without user_id keeps the legacy-record behavior (katra)', async () => {
    const res = await putIdentity(
      'http://localhost/api/v1/admin/identity',
      { name: 'Katra Renamed' },
      ADMIN_KEY,
    );
    expect(res.status).toBe(200);
    expect(store.get('agent_identity')?.name).toBe('Katra Renamed');
    expect(store.has('agent_identity:katra')).toBe(false);
  });
});
