/**
 * Memory Scope Helpers — Katra edition
 *
 * Manages identity modes for the memory system:
 * - personal: isolated to user_id (default, backward-compatible)
 * - shared: communal memory via shared_id
 * - hybrid: personal first, then shared, then other visible user_ids
 */

import { get_database } from '../database/connection.js';
import { getTenantContext } from '../database/tenant-context.js';

/**
 * System-wide default user id. Used as the fallback for both store and search
 * when no user_id is supplied, so the two sides stay aligned. Reads from
 * SOLOMEM_USER_ID (set in .env) so deployments can configure it in one place.
 */
export const DEFAULT_USER_ID = process.env.SOLOMEM_USER_ID || 'mcp-user';

export interface MemoryScopeConfig {
  mode: 'personal' | 'shared' | 'hybrid';
  shared_id: string | null;
  hybrid_visible_user_ids: string[];
}

/** Cache for memory scope config keyed by tenant_id (short-lived to avoid hitting MongoDB on every search) */
const scopeCache = new Map<string, { config: MemoryScopeConfig; expires: number }>();
const SCOPE_CACHE_TTL_MS = 5000; // 5 second in-memory cache

/** Returns a stable cache key for the current execution context. */
function getScopeCacheKey(): string {
  return getTenantContext()?.tenant_id ?? '__default__';
}

/**
 * Get the current memory scope configuration from system_settings.
 * Uses a short-lived per-tenant cache to avoid hitting MongoDB on every search.
 */
export async function getMemoryScope(): Promise<MemoryScopeConfig> {
  const cacheKey = getScopeCacheKey();
  const cached = scopeCache.get(cacheKey);
  if (cached) {
    if (Date.now() < cached.expires) {
      return cached.config;
    }
    // Expired — evict immediately to prevent unbounded map growth
    scopeCache.delete(cacheKey);
  }

  try {
    const db = get_database();
    const doc = await db.collection('system_settings').findOne({ key: 'memory_scope' });
    const config: MemoryScopeConfig = {
      mode: doc?.mode || 'personal',
      shared_id: doc?.shared_id || null,
      hybrid_visible_user_ids: doc?.hybrid_visible_user_ids || [],
    };
    scopeCache.set(cacheKey, { config, expires: Date.now() + SCOPE_CACHE_TTL_MS });
    return config;
  } catch {
    // Default to personal if DB unavailable
    return { mode: 'personal', shared_id: null, hybrid_visible_user_ids: [] };
  }
}

/**
 * Build a MongoDB query filter based on the current memory scope mode.
 *
 * - personal: filter by user_id only (current behavior)
 * - shared: filter by shared_id only (all machines with same shared_id)
 * - hybrid: search user_id first, then shared_id, then other visible user_ids
 *
 * Returns a MongoDB filter object to be spread into queries.
 */
export async function buildScopeFilter(user_id?: string): Promise<Record<string, unknown>> {
  const scope = await getMemoryScope();

  switch (scope.mode) {
    case 'personal':
      // Filter by user_id. When none is supplied, fall back to the system
      // default user id rather than returning {} (which would leak every
      // user's memories). This keeps store and search defaults aligned.
      return { user_id: user_id || DEFAULT_USER_ID };

    case 'shared':
      // Communal: filter by shared_id only. Fall back to default user
      // scope if shared_id is not configured (prevents data leak).
      return scope.shared_id ? { shared_id: scope.shared_id } : { user_id: DEFAULT_USER_ID };

    case 'hybrid': {
      // Personal first, then shared, then other visible users
      const orConditions: Record<string, unknown>[] = [];
      if (user_id) orConditions.push({ user_id });
      if (scope.shared_id) orConditions.push({ shared_id: scope.shared_id });
      if (scope.hybrid_visible_user_ids.length > 0) {
        orConditions.push({ user_id: { $in: scope.hybrid_visible_user_ids } });
      }
      // If no conditions, fall back to default user scope (never return all records)
      return orConditions.length > 0 ? { $or: orConditions } : { user_id: user_id || DEFAULT_USER_ID };
    }

    default:
      return { user_id: user_id || DEFAULT_USER_ID };
  }
}

/**
 * Determine the shared_id to use when storing a memory.
 * In shared mode, always use the configured shared_id.
 * In hybrid mode, use the provided shared_id if given, otherwise the configured one.
 * In personal mode, shared_id is not set.
 */
export async function resolveSharedId(provided_shared_id?: string): Promise<string | null> {
  const scope = await getMemoryScope();

  switch (scope.mode) {
    case 'shared':
      return provided_shared_id || scope.shared_id;
    case 'hybrid':
      return provided_shared_id || scope.shared_id;
    case 'personal':
    default:
      return null;
  }
}

/**
 * Invalidate the scope cache (called after admin updates scope settings).
 * Clears only the current tenant's entry, or the entire cache if no tenant context is active.
 */
export function invalidateScopeCache(): void {
  const tenantId = getTenantContext()?.tenant_id;
  if (tenantId) {
    scopeCache.delete(tenantId);
  } else {
    scopeCache.clear();
  }
}
