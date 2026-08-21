/**
 * Caller Identity — AsyncLocalStorage propagation
 *
 * F1 (identity separation): the server resolves WHO is calling from the
 * presented API key (or loopback), not from a process-wide default. The
 * resolved identity is propagated through the async call chain with
 * AsyncLocalStorage so any service or tool handler can attribute work to
 * the caller's user_id via getCaller().
 *
 * - runWithCaller(identity, fn): run fn with the given caller identity set.
 * - getCaller(): current caller, never throws — falls back to a safe default
 *   ({ user_id: DEFAULT_USER_ID, trusted: false }) when no identity is set.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_USER_ID } from '../services/memory/memory-scope-service.js';

export interface CallerIdentity {
  /** The user_id all writes from this caller are attributed to. */
  user_id: string;
  /** Loopback and the admin key are trusted; key-mapped clients are not. */
  trusted: boolean;
}

/** Safe default caller when no identity has been resolved (never trust it). */
export const SAFE_DEFAULT_CALLER: CallerIdentity = Object.freeze({
  user_id: DEFAULT_USER_ID,
  trusted: false,
});

const callerStorage = new AsyncLocalStorage<CallerIdentity>();

/**
 * Run `fn` within the given caller identity. The identity is visible to
 * getCaller() inside `fn` and inside anything awaited from it.
 */
export function runWithCaller<T>(identity: CallerIdentity, fn: () => T): T {
  return callerStorage.run(identity, fn);
}

/**
 * Get the caller identity for the current async context.
 * Never throws: falls back to { user_id: DEFAULT_USER_ID, trusted: false }.
 */
export function getCaller(): CallerIdentity {
  return callerStorage.getStore() ?? SAFE_DEFAULT_CALLER;
}
