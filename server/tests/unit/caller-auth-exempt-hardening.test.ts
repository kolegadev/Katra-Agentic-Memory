/**
 * Unit tests: exempt-path hardening (RP-02) and key-carrier policy (RP-03)
 *
 * RP-02 — AUTH_SKIP_PATHS applies to read methods only. A mutating request on an
 *         exempt path (e.g. PUT /api/v1/admin/personality) must present a key;
 *         before this, the path-only check left the write handler open.
 * RP-03 — the admin key is refused when it arrives in the query string. URLs leak
 *         into access logs, proxies and Referer headers, so a trusted-identity key
 *         must travel in a header only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: () => ({
      findOne: async () => ({
        value: { name: 'Katra', chosen_by: 'the agent', established: '2026-08-19' },
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
import { clearClientKeyIdentities, ensureApiKeys } from '../../src/utils/api-key-manager.js';

const ADMIN_KEY = 'katra-admin-exempt-hardening-test-key';
const envNames = ['MCP_API_KEY', 'ADMIN_API_KEY', 'KATRA_API_KEY', 'BACKUP_MCP_KEYS'];

const app = new Hono();
app.use('/api/*', createCallerAuthMiddleware());
app.route('/api/v1/admin', create_admin_routes());

beforeEach(async () => {
  clearClientKeyIdentities();
  for (const name of envNames) delete process.env[name];
  // the validator reads env keys at boot; load them the same way the server does
  process.env.MCP_API_KEY = 'test-mcp-key';
  process.env.KATRA_API_KEY = ADMIN_KEY;
  await ensureApiKeys();
});

afterEach(() => {
  clearClientKeyIdentities();
  for (const name of envNames) delete process.env[name];
});

describe('exempt paths apply to read methods only (RP-02)', () => {
  it('GET on an exempt path needs no key', async () => {
    const res = await app.request('http://localhost/api/v1/admin/personality');
    expect(res.status).toBe(200);
  });

  it('HEAD on an exempt path needs no key', async () => {
    const res = await app.request('http://localhost/api/v1/admin/personality', { method: 'HEAD' });
    expect(res.status).not.toBe(401);
  });

  it('PUT on an exempt path is rejected without a key', async () => {
    const res = await app.request('http://localhost/api/v1/admin/personality', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personality: 'strategist' }),
    });
    expect(res.status).toBe(401);
  });

  it('PUT on an exempt path is not rejected for lack of auth when the admin key is sent', async () => {
    const res = await app.request('http://localhost/api/v1/admin/personality', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify({ personality: 'strategist' }),
    });
    expect(res.status).not.toBe(401);
  });
});

describe('admin key carrier policy (RP-03)', () => {
  it('accepts the admin key in the Authorization header', async () => {
    const res = await app.request('http://localhost/api/v1/admin/database-stats', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).not.toBe(401);
  });

  it('refuses the admin key presented in the query string', async () => {
    const res = await app.request(
      `http://localhost/api/v1/admin/database-stats?token=${encodeURIComponent(ADMIN_KEY)}`,
    );
    expect(res.status).toBe(401);
  });

  it('refuses an unmapped key in the query string too', async () => {
    const res = await app.request('http://localhost/api/v1/admin/database-stats?token=not-a-key');
    expect(res.status).toBe(401);
  });
});
