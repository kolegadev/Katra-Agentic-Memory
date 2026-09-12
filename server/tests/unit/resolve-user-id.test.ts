/**
 * Unit tests: resolveUserId (F1 — trusted vs untrusted callers)
 *
 * Trusted callers (loopback / admin key) may supply user_id in tool inputs;
 * untrusted callers are ALWAYS bound to their own user_id (input ignored —
 * the IDOR boundary is unchanged).
 */
import { describe, it, expect } from 'vitest';
import { resolveUserId } from '../../src/mcp-server.js';
import { runWithCaller, type CallerIdentity } from '../../src/utils/caller-identity.js';
import { DEFAULT_USER_ID } from '../../src/services/memory/memory-scope-service.js';

describe('resolveUserId — trusted caller', () => {
  const trusted: CallerIdentity = { user_id: 'katra', trusted: true };

  it('honors a provided user_id', () => {
    expect(runWithCaller(trusted, () => resolveUserId('agent-a'))).toBe('agent-a');
  });

  it('falls back to the caller id when no input is provided', () => {
    expect(runWithCaller(trusted, () => resolveUserId(undefined))).toBe('katra');
    expect(runWithCaller(trusted, () => resolveUserId(''))).toBe('katra');
    expect(runWithCaller(trusted, () => resolveUserId('   '))).toBe('katra');
  });

  it('ignores non-string input', () => {
    expect(runWithCaller(trusted, () => resolveUserId(42))).toBe('katra');
    expect(runWithCaller(trusted, () => resolveUserId({ user_id: 'agent-b' }))).toBe('katra');
  });
});

describe('resolveUserId — untrusted caller', () => {
  const untrusted: CallerIdentity = { user_id: 'agent-a', trusted: false };

  it('ALWAYS returns the caller id, ignoring supplied input (IDOR boundary)', () => {
    expect(runWithCaller(untrusted, () => resolveUserId('katra'))).toBe('agent-a');
    expect(runWithCaller(untrusted, () => resolveUserId('agent-b'))).toBe('agent-a');
    expect(runWithCaller(untrusted, () => resolveUserId('agent-a'))).toBe('agent-a');
  });

  it('returns the caller id when no input is provided', () => {
    expect(runWithCaller(untrusted, () => resolveUserId(undefined))).toBe('agent-a');
    expect(runWithCaller(untrusted, () => resolveUserId(''))).toBe('agent-a');
  });
});

describe('resolveUserId — no caller context (safe default)', () => {
  it('falls back to DEFAULT_USER_ID and ignores the input', () => {
    expect(resolveUserId('someone-else')).toBe(DEFAULT_USER_ID);
    expect(resolveUserId(undefined)).toBe(DEFAULT_USER_ID);
  });
});
