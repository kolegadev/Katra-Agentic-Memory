/**
 * MCP test helpers — call the MCP server via HTTP for integration tests.
 * Requires the Katra Docker stack to be running.
 */
import { createHash, randomBytes } from 'node:crypto';

const MCP_URL = process.env.KATRA_MCP_URL || 'http://localhost:3112/mcp';
const MCP_KEY = process.env.MCP_API_KEY || 'katra-mcp-key-2026';
const KATRA_KEY = process.env.KATRA_API_KEY || 'katra-admin-key-2026';

let _sessionId: string | null = null;
let _initialized = false;

export function getMcpKey(): string {
  return MCP_KEY;
}

export function getKatraKey(): string {
  return KATRA_KEY;
}

export async function initMCP(): Promise<string> {
  if (_initialized) return _sessionId!;

  const resp = await fetch(`${MCP_URL}?token=${MCP_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'X-MCP-Auth': MCP_KEY,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'katra-test-suite', version: '1.0.0' },
      },
    }),
  });

  const data = await resp.json();
  _sessionId = (resp.headers.get('mcp-session-id') || data?.result?.sessionId || 'test-session');
  _initialized = true;
  return _sessionId;
}

export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  useAdminKey = false
): Promise<{ result?: unknown; error?: unknown }> {
  const key = useAdminKey ? KATRA_KEY : MCP_KEY;
  const resp = await fetch(`${MCP_URL}?token=${key}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'X-MCP-Auth': key,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  if (!resp.ok) {
    return { error: `HTTP ${resp.status}` };
  }
  return resp.json();
}

export function extractText(result: unknown): string {
  const r = result as any;
  if (r?.result?.content?.[0]?.text) return r.result.content[0].text;
  if (r?.error) return `ERROR: ${JSON.stringify(r.error)}`;
  return JSON.stringify(r);
}

export function randomSessionId(): string {
  return `test-session-${randomBytes(4).toString('hex')}`;
}
