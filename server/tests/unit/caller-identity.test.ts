/**
 * Unit tests: Caller Identity (AsyncLocalStorage)
 *
 * F1 — caller-bound identities: runWithCaller/getCaller propagation and the
 * safe default.
 */
import { describe, it, expect } from 'vitest';
import { runWithCaller, getCaller, SAFE_DEFAULT_CALLER, type CallerIdentity } from '../../src/utils/caller-identity.js';
import { DEFAULT_USER_ID } from '../../src/services/memory/memory-scope-service.js';

describe('Caller Identity (AsyncLocalStorage)', () => {
  it('getCaller returns the safe default outside any context', () => {
    const caller = getCaller();
    expect(caller).toEqual({ user_id: DEFAULT_USER_ID, trusted: false });
  });

  it('getCaller never throws outside any context', () => {
    expect(() => getCaller()).not.toThrow();
  });

  it('SAFE_DEFAULT_CALLER matches the documented fallback shape', () => {
    expect(SAFE_DEFAULT_CALLER).toEqual({ user_id: DEFAULT_USER_ID, trusted: false });
  });

  it('runWithCaller makes the identity visible to sync code inside', () => {
    const identity: CallerIdentity = { user_id: 'shoshin', trusted: false };
    const seen = runWithCaller(identity, () => getCaller());
    expect(seen).toEqual(identity);
  });

  it('runWithCaller propagates the identity across awaits', async () => {
    const identity: CallerIdentity = { user_id: 'zanshin', trusted: false };
    const seen = await runWithCaller(identity, async () => {
      await Promise.resolve();
      await new Promise(r => setTimeout(r, 5));
      return getCaller();
    });
    expect(seen).toEqual(identity);
  });

  it('nested runWithCaller scopes restore the outer identity afterwards', async () => {
    const outer: CallerIdentity = { user_id: 'satori', trusted: true };
    const inner: CallerIdentity = { user_id: 'shoshin', trusted: false };

    await runWithCaller(outer, async () => {
      expect(getCaller()).toEqual(outer);
      const nested = runWithCaller(inner, () => getCaller());
      expect(nested).toEqual(inner);
      // outer restored after the nested scope returns
      expect(getCaller()).toEqual(outer);
    });
    // default restored after runWithCaller returns
    expect(getCaller()).toEqual({ user_id: DEFAULT_USER_ID, trusted: false });
  });

  it('does not leak identity between sibling scopes', async () => {
    const a: CallerIdentity = { user_id: 'a-user', trusted: false };
    const b: CallerIdentity = { user_id: 'b-user', trusted: true };
    await runWithCaller(a, async () => {
      await Promise.resolve();
      expect(getCaller()).toEqual(a);
    });
    await runWithCaller(b, async () => {
      await Promise.resolve();
      expect(getCaller()).toEqual(b);
    });
  });
});
