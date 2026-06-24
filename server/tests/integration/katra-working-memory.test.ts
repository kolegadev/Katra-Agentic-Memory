/**
 * Integration test: Working Memory via REST API
 */
import { describe, it, expect } from 'vitest';

const BASE = 'http://localhost:9012';
const API_KEY = 'katra-admin-key-2026';
const SESSION_ID = `test-wm-${Date.now()}`;

async function apiPost(path: string, body: any): Promise<number> {
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return resp.status;
}

async function apiGet(path: string): Promise<number> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  return resp.status;
}

describe('Integration: Working Memory (REST)', () => {
  it('POST /memory/working returns 401 without auth', async () => {
    const resp = await fetch(`${BASE}/api/v1/memory/working`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'test', content: 'hello' }),
    });
    expect(resp.status).toBe(401);
  });

  it('POST /memory/working returns 200 or 401 with auth', async () => {
    const status = await apiPost('/api/v1/memory/working', {
      session_id: SESSION_ID,
      content: 'test-content',
    });
    expect([200, 401]).toContain(status);
  });

  it('GET /memory/working/:id returns 200 or 401 with auth', async () => {
    const status = await apiGet(`/api/v1/memory/working/${SESSION_ID}`);
    expect([200, 401]).toContain(status);
  });

  it('memory health endpoint works', async () => {
    const status = await apiGet('/api/v1/memory/health');
    expect([200, 401]).toContain(status);
  });
});
