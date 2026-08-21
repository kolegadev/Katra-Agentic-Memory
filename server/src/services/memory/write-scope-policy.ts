/**
 * Write Scope Policy — F2 (identity separation)
 *
 * Personal memories (sleep consolidations, reflections, journals, emotional
 * state, philosophical insights) are ALWAYS private to the writer's user_id:
 * they never carry a shared_id. Every other memory write defaults to the
 * shared scope ('my-team') while still being stamped with the writer's
 * user_id, unless the caller explicitly opts out with `private: true`.
 *
 * - resolveWriteScope(): decides { user_id, shared_id } for a write.
 * - stripSharedId(): forced-private helper for personal-collection writers.
 * - ensureMemoryScopePrivateVisibleIds(): boot-time ensure that pins
 *   system_settings.memory_scope.hybrid_visible_user_ids to [] — idempotent,
 *   only when the key already exists, and it never touches other settings.
 */

import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';

/** Memory kinds that are ALWAYS private — shared_id must never be set. */
export const PERSONAL_KINDS: readonly string[] = [
  'journal',
  'reflection',
  'emotional',
  'insight',
];

/** Default shared scope for every non-personal write. */
export const DEFAULT_SHARED_ID = 'my-team';

export interface WriteScopeRequest {
  /** user_id the caller asked to write under (honored for trusted callers only). */
  user_id?: string;
  /** Explicit opt-out: store with no shared_id at all. */
  private?: boolean;
  /** Explicit shared scope override (ignored for personal kinds / private). */
  shared_id?: string;
}

export interface WriteScopeResult {
  /** user_id the write must be attributed to. */
  user_id: string;
  /** shared_id to store on the doc, or null when the write stays private. */
  shared_id: string | null;
}

/**
 * Resolve the scope for a memory write.
 *
 * - user_id: trusted callers (loopback / admin key) may name a user;
 *   untrusted callers are always pinned to their own identity — the same
 *   IDOR boundary as F1's resolveUserId.
 * - personal kinds (`PERSONAL_KINDS`) always return shared_id: null, even
 *   when the caller requests a shared scope.
 * - everything else defaults to `shared_id: 'my-team'` (still carrying the
 *   writer's user_id) unless `requested.private === true`.
 */
export function resolveWriteScope(args: {
  caller: CallerIdentity;
  kind: string;
  requested?: WriteScopeRequest;
}): WriteScopeResult {
  const { caller, kind, requested } = args;

  const requestedUserId =
    typeof requested?.user_id === 'string' && requested.user_id.trim().length > 0
      ? requested.user_id.trim()
      : undefined;
  const user_id = caller.trusted && requestedUserId ? requestedUserId : caller.user_id;

  const personal = PERSONAL_KINDS.includes(kind);
  const optedOut = requested?.private === true;

  let shared_id: string | null = null;
  if (!personal && !optedOut) {
    const requestedSharedId =
      typeof requested?.shared_id === 'string' && requested.shared_id.trim().length > 0
        ? requested.shared_id.trim()
        : undefined;
    shared_id = requestedSharedId || DEFAULT_SHARED_ID;
  }

  return { user_id, shared_id };
}

/**
 * Force a document private: returns the doc with `shared_id` removed so it
 * can never be written to a personal collection.
 */
export function stripSharedId<T extends object>(doc: T): T {
  if ('shared_id' in doc) {
    const { shared_id: _shared_id, ...rest } = doc as Record<string, unknown>;
    return rest as unknown as T;
  }
  return doc;
}

/**
 * Boot-time ensure (idempotent): when `system_settings.memory_scope`
 * already exists, pin `hybrid_visible_user_ids` to [] — hybrid reads stay
 * caller-private + my-team only, with no other visible users. Does NOT
 * create the key and does NOT modify any other field of the settings doc.
 */
export async function ensureMemoryScopePrivateVisibleIds(): Promise<void> {
  try {
    const db = get_database();
    await db.collection('system_settings').updateOne(
      { key: 'memory_scope' },
      { $set: { hybrid_visible_user_ids: [] } },
    );
  } catch {
    // DB unavailable at boot — nothing to ensure. The memory scope service
    // already degrades to safe defaults when the DB is unreachable.
  }
}
