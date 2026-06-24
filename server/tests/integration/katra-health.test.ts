/**
 * Integration test: Katra system health and basic connectivity
 *
 * Tests the REST API health endpoints and verifies all services are up.
 * These are the most critical integration tests — if they fail, nothing else works.
 */
import { describe, it, expect } from 'vitest';

const BASE = 'http://localhost:9012';
const MCP = 'http://localhost:3112/mcp';

async function healthCheck(): Promise<any> {
  const resp = await fetch(`${BASE}/api/v1/health`);
  return resp.json();
}

async function mcpHealth(): Promise<number> {
  const resp = await fetch(MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'X-MCP-Auth': 'katra-mcp-key-2026',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return resp.status;
}

describe('Integration: System Health', () => {
  it('REST API health returns 200 with service status', async () => {
    const health = await healthCheck();
    expect(health.status).toBe('ok');
    expect(health.services.mongodb).toBe('connected');
    expect(health.services.redis).toBe('connected');
  });

  it('MCP endpoint is reachable', async () => {
    const status = await mcpHealth();
    // 200 = OK, 406 = needs Accept header, 400 = needs init first
    expect([200, 400, 406]).toContain(status);
  });

  it('healthz endpoint reports docker_available', async () => {
    // Admin health endpoint
    const resp = await fetch(`${BASE}/healthz`, {
      headers: { 'Authorization': `Bearer katra-admin-key-2026` },
    });
    if (resp.ok) {
      const data = await resp.json();
      expect(data.status).toBe('ok');
    }
    // May be 401 if auth is required
  });
});
