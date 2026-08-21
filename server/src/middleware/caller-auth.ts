/**
 * REST caller-auth middleware (F1 — caller-bound identities)
 *
 * Resolves the REST caller with the same resolveCallerIdentity() used by the
 * MCP server, then runs the request within that caller identity so route
 * handlers can attribute writes via getCaller().
 *
 * Auth semantics (single-tenant, the default):
 * - loopback            → trusted satori (no key needed)
 * - admin key (KATRA)   → trusted satori
 * - client_keys-mapped  → untrusted identity
 * - legacy env key      → satori untrusted
 * - valid but unmapped  → 401 (rejected loudly)
 * - open-access mode    → no key configured at all: requests proceed with the
 *                         safe default caller ({ DEFAULT_USER_ID, trusted: false })
 */

import type { Context, Next } from 'hono';
import type { IncomingMessage } from 'node:http';

import {
  resolveCallerIdentity,
  validateKatraKey,
  isKatraAuthConfigured,
} from '../utils/api-key-manager.js';
import { getCaller, runWithCaller, type CallerIdentity } from '../utils/caller-identity.js';
import { isMultiTenant, runWithTenant } from '../database/tenant-context.js';
import { resolveTenant } from '../services/integration/tenant-service.js';

/** Paths exempt from API-key auth (health checks, read-only dashboard data). */
const AUTH_SKIP_PATHS = new Set([
  '/api/v1/health',
  '/api/v1/admin/dashboard-stats',
  '/api/v1/admin/memory-search',
  '/api/v1/admin/pubsub/presence',
  '/api/v1/admin/pubsub/topics',
  '/api/v1/admin/pubsub/muted',
  '/api/v1/admin/personality',
  '/api/v1/admin/personality/profiles',
  '/api/v1/admin/identity',
]);

/**
 * Resolve the caller identity for a Hono request, reusing the raw Node
 * request when available (loopback socket detection); falls back to
 * Hono-normalized headers/url (e.g. in fetch()-style tests).
 */
export function resolveCallerFromHono(c: Context): Promise<CallerIdentity | null> {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  if (incoming) {
    return resolveCallerIdentity({
      socket: incoming.socket,
      headers: incoming.headers,
      url: incoming.url,
    });
  }
  return resolveCallerIdentity({
    remoteAddress: undefined,
    headers: {
      'x-mcp-auth': c.req.header('x-mcp-auth'),
      authorization: c.req.header('authorization'),
    },
    url: c.req.url,
  });
}

/** Run the rest of the request inside the resolved caller identity. */
function runWithCallerOrDefault<T>(caller: CallerIdentity | null, fn: () => T): T {
  return runWithCaller(caller ?? getCaller(), fn);
}

/**
 * Hono middleware for `/api/*`: resolve the caller, enforce auth, and run the
 * request within runWithCaller so downstream handlers see the caller.
 */
export function createCallerAuthMiddleware(): (c: Context, next: Next) => Promise<Response | void> {
  return async (c, next) => {
    const caller = await resolveCallerFromHono(c);
    const proceed = () => runWithCallerOrDefault(caller, () => next());

    // Skip auth for health checks / read-only dashboard data (identity is
    // still resolved and set for these paths).
    if (AUTH_SKIP_PATHS.has(c.req.path)) {
      return proceed();
    }

    // Multi-tenant mode: resolve API key to tenant (existing behavior).
    if (isMultiTenant()) {
      const auth = c.req.header('Authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) {
        return c.json({ error: 'Unauthorized', message: 'API key required' }, 401);
      }

      // Admin key gets full access (including tenant management).
      if (validateKatraKey(token)) {
        return proceed();
      }

      // Resolve tenant
      const tenant = await resolveTenant(token);
      if (!tenant) {
        return c.json({ error: 'Unauthorized', message: 'Invalid API key' }, 401);
      }

      // Set tenant context for downstream handlers
      return runWithTenant(
        { tenant_id: tenant.tenant_id, database_name: tenant.database_name, plan: tenant.plan },
        () => proceed(),
      );
    }

    // Single-tenant mode (default).
    // A resolved caller (loopback, admin key, mapped client key, legacy env
    // key) is sufficient.
    if (caller) {
      return proceed();
    }

    // Open access when no key is configured (local dev).
    if (!isKatraAuthConfigured()) {
      return proceed();
    }

    return c.json({ error: 'Unauthorized', message: 'Invalid or missing API key' }, 401);
  };
}
