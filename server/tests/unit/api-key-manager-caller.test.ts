/**
 * Unit tests: resolveCallerIdentity (F1 — caller-bound identities)
 *
 * Covers the four contract cases: loopback (trusted satori), key mapped in
 * client_keys (untrusted), legacy env keys (untrusted satori), and
 * valid-but-unmapped keys (null → rejected).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveCallerIdentity,
  extractPresentedKey,
  isLoopbackAddress,
  hashApiKey,
  registerClientKeyIdentity,
  clearClientKeyIdentities,
  ensureApiKeys,
  type CallerRequestParts,
} from '../../src/utils/api-key-manager.js';

const SHOSHIN_KEY = 'katra-shoshin-test-key-0001';
const ZANSHIN_KEY = 'katra-zanshin-test-key-0001';
const LEGACY_MCP_KEY = 'katra-mcp-legacy-test-key';
const LEGACY_BACKUP_KEY = 'katra-mcp-backup-test-key';
const ADMIN_KEY = 'katra-admin-test-key';

const envNames = ['MCP_API_KEY', 'ADMIN_API_KEY', 'KATRA_API_KEY', 'BACKUP_MCP_KEYS', 'BACKUP_KATRA_KEYS'];

function remoteReq(remoteAddress: string, headers: Record<string, string>, url = '/mcp'): CallerRequestParts {
  return { remoteAddress, headers, url };
}

describe('isLoopbackAddress', () => {
  it('recognizes IPv4, IPv6 and IPv4-mapped loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects LAN / remote / undefined addresses', () => {
    expect(isLoopbackAddress('192.168.1.50')).toBe(false);
    expect(isLoopbackAddress('172.17.0.1')).toBe(false);
    expect(isLoopbackAddress('::1.1')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe('extractPresentedKey', () => {
  it('extracts x-mcp-auth', () => {
    expect(extractPresentedKey({ 'x-mcp-auth': 'key-a' })).toBe('key-a');
  });

  it('extracts Authorization: Bearer', () => {
    expect(extractPresentedKey({ authorization: 'Bearer key-b' })).toBe('key-b');
  });

  it('extracts ?token= from the URL', () => {
    expect(extractPresentedKey({}, '/mcp?token=key-c')).toBe('key-c');
  });

  it('prefers x-mcp-auth over Bearer over ?token=', () => {
    expect(extractPresentedKey({ 'x-mcp-auth': 'first', authorization: 'Bearer second' }, '/mcp?token=third')).toBe('first');
    expect(extractPresentedKey({ authorization: 'Bearer second' }, '/mcp?token=third')).toBe('second');
  });

  it('handles array-valued headers', () => {
    expect(extractPresentedKey({ 'x-mcp-auth': ['arr-key'] })).toBe('arr-key');
  });

  it('returns undefined when nothing is presented', () => {
    expect(extractPresentedKey({})).toBeUndefined();
    expect(extractPresentedKey({ authorization: 'Basic dXNlcjpwYXNz' })).toBeUndefined();
    expect(extractPresentedKey({ 'x-mcp-auth': '   ' })).toBeUndefined();
    expect(extractPresentedKey({}, '/mcp')).toBeUndefined();
    expect(extractPresentedKey({}, 'not a url at all')).toBeUndefined();
  });
});

describe('resolveCallerIdentity', () => {
  beforeEach(() => {
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
  });

  afterEach(() => {
    clearClientKeyIdentities();
    for (const name of envNames) delete process.env[name];
  });

  it('loopback → { user_id: satori, trusted: true } (no key required)', async () => {
    const identity = await resolveCallerIdentity(remoteReq('127.0.0.1', {}));
    expect(identity).toEqual({ user_id: 'satori', trusted: true });
  });

  it('loopback wins even when a key is presented', async () => {
    const identity = await resolveCallerIdentity(remoteReq('::ffff:127.0.0.1', { 'x-mcp-auth': SHOSHIN_KEY }));
    expect(identity).toEqual({ user_id: 'satori', trusted: true });
  });

  it('key mapped in client_keys → { user_id, trusted: false } (Bearer)', async () => {
    registerClientKeyIdentity(hashApiKey(SHOSHIN_KEY), 'shoshin');
    const identity = await resolveCallerIdentity(remoteReq('192.168.1.50', { authorization: `Bearer ${SHOSHIN_KEY}` }));
    expect(identity).toEqual({ user_id: 'shoshin', trusted: false });
  });

  it('key mapped in client_keys via x-mcp-auth and ?token=', async () => {
    registerClientKeyIdentity(hashApiKey(ZANSHIN_KEY), 'zanshin');
    expect(await resolveCallerIdentity(remoteReq('192.168.1.50', { 'x-mcp-auth': ZANSHIN_KEY })))
      .toEqual({ user_id: 'zanshin', trusted: false });
    expect(await resolveCallerIdentity(remoteReq('192.168.1.50', {}, `/mcp?token=${ZANSHIN_KEY}`)))
      .toEqual({ user_id: 'zanshin', trusted: false });
  });

  it('legacy env keys (MCP_API_KEY) are REJECTED — no identity fallback (cutover policy)', async () => {
    process.env.MCP_API_KEY = LEGACY_MCP_KEY;
    const identity = await resolveCallerIdentity(remoteReq('192.168.1.50', { 'x-mcp-auth': LEGACY_MCP_KEY }));
    expect(identity).toBeNull();
  });

  it('legacy env keys (BACKUP_MCP_KEYS, comma-separated) are REJECTED — no identity fallback', async () => {
    process.env.BACKUP_MCP_KEYS = `${LEGACY_MCP_KEY}, ${LEGACY_BACKUP_KEY}`;
    const identity = await resolveCallerIdentity(remoteReq('192.168.1.50', { authorization: `Bearer ${LEGACY_BACKUP_KEY}` }));
    expect(identity).toBeNull();
  });

  it('admin key (KATRA_API_KEY) → { user_id: satori, trusted: true }', async () => {
    process.env.MCP_API_KEY = LEGACY_MCP_KEY;
    process.env.KATRA_API_KEY = ADMIN_KEY;
    await ensureApiKeys();
    const identity = await resolveCallerIdentity(remoteReq('192.168.1.50', { authorization: `Bearer ${ADMIN_KEY}` }));
    expect(identity).toEqual({ user_id: 'satori', trusted: true });
  });

  it('no key, non-loopback → null', async () => {
    const identity = await resolveCallerIdentity(remoteReq('192.168.1.50', {}));
    expect(identity).toBeNull();
  });

  it('unmapped unknown key → null (rejected)', async () => {
    const identity = await resolveCallerIdentity(remoteReq('192.168.1.50', { 'x-mcp-auth': 'katra-unknown-0000' }));
    expect(identity).toBeNull();
  });

  it('valid-but-unmapped key → null (loud rejection path)', async () => {
    // Make the server accept the key via the in-memory validators (as if it
    // were the persisted legacy hash), then remove the env plaintext so it is
    // no longer a "legacy env key" and not in client_keys either.
    process.env.MCP_API_KEY = LEGACY_MCP_KEY;
    process.env.KATRA_API_KEY = ADMIN_KEY;
    await ensureApiKeys();
    delete process.env.MCP_API_KEY;
    delete process.env.ADMIN_API_KEY;

    const { validateMcpKey } = await import('../../src/utils/api-key-manager.js');
    expect(validateMcpKey(LEGACY_MCP_KEY)).toBe(true); // still a *valid* key…

    const identity = await resolveCallerIdentity(remoteReq('192.168.1.50', { 'x-mcp-auth': LEGACY_MCP_KEY }));
    expect(identity).toBeNull(); // …but unmapped → rejected loudly
  });
});
