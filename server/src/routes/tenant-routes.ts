/**
 * Tenant Routes — Admin API for multi-tenant management
 *
 * All endpoints require the KATRA_API_KEY (admin key).
 * In multi-tenant mode, these are under /api/v1/tenants.
 */

import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import {
  createTenant,
  getTenant,
  listTenants,
  updateTenant,
  regenerateApiKey,
  deleteTenant,
} from '../services/tenant-service.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function create_tenant_routes(): Hono {
  const app = new Hono();

  // Defense-in-depth: always require KATRA_API_KEY regardless of parent
  // middleware state. Tenant management endpoints are admin-only.
  app.use('*', async (c, next) => {
    const apiKey = process.env.KATRA_API_KEY;
    const header = c.req.header('Authorization') ?? '';
    const presented = /^Bearer\s+(.+)$/i.exec(header)?.[1];

    if (!apiKey || !presented || !safeEqual(presented, apiKey)) {
      console.warn(`Tenant admin auth rejected: ${c.req.method} ${c.req.path}`);
      return c.json({ error: 'Unauthorized', message: 'Admin API key required' }, 401);
    }
    return next();
  });

  /**
   * POST /api/v1/tenants — Create a new tenant
   * Body: { name, email, plan? }
   */
  app.post('/', async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.email) {
      return c.json({ success: false, error: 'name and email are required' }, 400);
    }

    try {
      const result = await createTenant({
        name: body.name,
        email: body.email,
        plan: body.plan,
      });

      return c.json({
        success: true,
        tenant: result.tenant,
        api_key: result.api_key,
        message: 'Save the API key — it will not be shown again.',
      }, 201);
    } catch (e: any) {
      if (e.code === 11000) {
        return c.json({ success: false, error: 'Email already registered' }, 409);
      }
      return c.json({ success: false, error: e.message }, 500);
    }
  });

  /**
   * GET /api/v1/tenants — List tenants
   * Query: limit, offset, active, plan
   */
  app.get('/', async (c) => {
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');
    const active = c.req.query('active') === 'true' ? true : c.req.query('active') === 'false' ? false : undefined;
    const plan = c.req.query('plan');

    const { tenants, total } = await listTenants({ limit, offset, active, plan });

    return c.json({
      success: true,
      tenants: tenants.map(t => ({
        ...t,
        api_key_hash: undefined,  // Never expose hash
      })),
      total,
      limit,
      offset,
    });
  });

  /**
   * GET /api/v1/tenants/:id — Get tenant by ID
   */
  app.get('/:id', async (c) => {
    const tenant = await getTenant(c.req.param('id'));
    if (!tenant) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }
    const { api_key_hash, ...safe } = tenant as any;
    return c.json({ success: true, tenant: safe });
  });

  /**
   * PATCH /api/v1/tenants/:id — Update tenant
   * Body: { name?, plan?, active?, settings? }
   */
  app.patch('/:id', async (c) => {
    const body = await c.req.json();
    const tenant = await updateTenant(c.req.param('id'), {
      name: body.name,
      plan: body.plan,
      active: body.active,
      settings: body.settings,
    });

    if (!tenant) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }
    const { api_key_hash, ...safe } = tenant as any;
    return c.json({ success: true, tenant: safe });
  });

  /**
   * POST /api/v1/tenants/:id/regenerate-key — Regenerate API key
   */
  app.post('/:id/regenerate-key', async (c) => {
    const result = await regenerateApiKey(c.req.param('id'));
    if (!result) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }
    return c.json({
      success: true,
      api_key: result.api_key,
      message: 'Save the new API key — it will not be shown again.',
    });
  });

  /**
   * DELETE /api/v1/tenants/:id — Delete tenant and its database
   * Query: confirm=true required
   */
  app.delete('/:id', async (c) => {
    if (c.req.query('confirm') !== 'true') {
      return c.json({ success: false, error: 'Add ?confirm=true to confirm deletion' }, 400);
    }

    const deleted = await deleteTenant(c.req.param('id'));
    if (!deleted) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }
    return c.json({ success: true, message: 'Tenant and its database have been deleted' });
  });

  return app;
}
