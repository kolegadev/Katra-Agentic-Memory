/**
 * Unit tests: reflection routes resolve the CALLER's user_id (F2)
 *
 * Each machine must see only its OWN journals/reflections: the reflection
 * routes derive the user_id from getCaller() (resolved per request from the
 * presented key) instead of the process-wide DEFAULT_USER_ID.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  journalFilters: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: (name: string) => ({
      find: (filter: Record<string, unknown>) => {
        if (name === 'reflective_journals') state.journalFilters.push(filter);
        return {
          sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
        };
      },
      findOne: async () => null,
      updateOne: async () => ({ acknowledged: true }),
    }),
  }),
  is_database_connected: () => true,
}));

// Rate limiter fails open when Redis is unavailable.
vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { Hono } from 'hono';
import { createCallerAuthMiddleware } from '../../src/middleware/caller-auth.js';
import { create_reflection_routes } from '../../src/routes/reflection-routes.js';
import {
  clearClientKeyIdentities,
  ensureApiKeys,
  hashApiKey,
  registerClientKeyIdentity,
} from '../../src/utils/api-key-manager.js';

const SHOSHIN_KEY = 'katra-shoshin-reflection-test-key';
const ADMIN_KEY = 'katra-admin-reflection-test-key';
const envNames = ['MCP_API_KEY', 'ADMIN_API_KEY', 'KATRA_API_KEY', 'BACKUP_MCP_KEYS'];

const app = new Hono();
app.use('/api/*', createCallerAuthMiddleware());
app.route('/api/v1/reflection', create_reflection_routes());

async function getJournal(key: string | undefined) {
  const headers: Record<string, string> = {};
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return app.request('http://localhost/api/v1/reflection/journal?limit=5', { headers });
}

describe('Reflection routes — caller-resolved user_id (F2)', () => {
  beforeEach(() => {
    state.journalFilters = [];
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
    registerClientKeyIdentity(hashApiKey(SHOSHIN_KEY), 'shoshin');
  });

  afterEach(() => {
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
  });

  it('reads journals for the caller resolved from the presented key (shoshin)', async () => {
    const res = await getJournal(SHOSHIN_KEY);
    expect(res.status).toBe(200);
    expect(state.journalFilters).toHaveLength(1);
    expect(state.journalFilters[0]).toEqual({ user_id: 'shoshin' });
  });

  it('reads journals for the trusted admin caller (satori)', async () => {
    process.env.KATRA_API_KEY = ADMIN_KEY;
    await ensureApiKeys();

    const res = await getJournal(ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(state.journalFilters).toHaveLength(1);
    expect(state.journalFilters[0]).toEqual({ user_id: 'satori' });
  });

  it('rejects requests that resolve to no caller', async () => {
    const res = await getJournal('katra-unknown-reflection-key');
    expect(res.status).toBe(401);
    expect(state.journalFilters).toHaveLength(0);
  });
});
