/**
 * Reflection Routes — REST API for sleep consolidation reflections
 *
 * F2 (identity separation): every read is resolved to the CALLER's user_id
 * (getCaller()) instead of the process-wide DEFAULT_USER_ID, so each machine
 * sees only its own journals, reflections, insights, and unresolved threads.
 */

import { Hono } from 'hono';
import { ReflectionStore } from '../services/infrastructure/reflection-store.js';
import { SleepConsolidationService } from '../services/processing/sleep-consolidation-service.js';
import { validateKatraKey } from '../utils/api-key-manager.js';
import { getCaller, runWithCaller } from '../utils/caller-identity.js';
import { resolveCallerFromHono } from '../middleware/caller-auth.js';
import { create_rate_limiter } from '../middleware/rate-limit.js';

export const create_reflection_routes = (): Hono => {
  const router = new Hono();
  const store = ReflectionStore.get_instance();

  // Auth middleware + rate limiting
  router.use('*', create_rate_limiter({ keyPrefix: 'reflection', max: 60, windowMs: 60_000 }));
  router.use('*', async (c, next) => {
    const authHeader = c.req.header('Authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const queryToken = c.req.query('token') ?? undefined;
    const tokenToValidate = token || queryToken || '';
    if (validateKatraKey(tokenToValidate)) {
      return next();
    }
    // F2: also accept callers whose identity was resolved by the app-level
    // middleware (loopback → trusted; client_keys-mapped keys; legacy env
    // keys) so each machine can read its own journals with its own key.
    const caller = await resolveCallerFromHono(c);
    if (caller) {
      return runWithCaller(caller, () => next());
    }
    return c.json({ error: 'Unauthorized', message: 'API key required' }, 401);
  });

  /**
   * GET /api/v1/reflection/journal
   */
  router.get('/journal', async (c) => {
    try {
      const userId = getCaller().user_id;
      const periodType = c.req.query('period_type');
      const limit = Math.min(parseInt(c.req.query('limit') || '10'), 100);
      const from = c.req.query('from') ? new Date(c.req.query('from')!) : undefined;
      const to = c.req.query('to') ? new Date(c.req.query('to')!) : undefined;

      const journals = await store.getJournals(userId, { periodType, limit, from, to });
      return c.json({ success: true, count: journals.length, journals });
    } catch (error: any) {
      console.error('Error retrieving journals:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/reflection/journal/latest
   * Get the most recent journal entry.
   */
  router.get('/journal/latest', async (c) => {
    try {
      const userId = getCaller().user_id;
      const periodType = c.req.query('period_type') || 'daily';
      const journal = await store.getLatestJournal(userId, periodType);
      return c.json({ success: true, journal });
    } catch (error: any) {
      console.error('Reflection route error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/reflection/emotional-context/:entity
   * Get emotional/reflective context for an entity.
   */
  router.get('/emotional-context/:entity', async (c) => {
    try {
      const entityName = c.req.param('entity');
      const userId = getCaller().user_id;
      const context = await store.getEmotionalContext(userId, entityName);
      return c.json({ success: true, ...context });
    } catch (error: any) {
      console.error('Reflection route error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/reflection/insights
   * Query philosophical insights.
   */
  router.get('/insights', async (c) => {
    try {
      const userId = getCaller().user_id;
      const domain = c.req.query('domain');
      const status = c.req.query('status');
      const limit = Math.min(parseInt(c.req.query('limit') || '10'), 100);

      const insights = await store.getInsights(userId, { domain, status, limit });
      return c.json({ success: true, count: insights.length, insights });
    } catch (error: any) {
      console.error('Reflection route error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/reflection/unresolved
   * Get currently unresolved threads.
   */
  router.get('/unresolved', async (c) => {
    try {
      const userId = getCaller().user_id;
      const threads = await store.getUnresolvedThreads(userId);
      return c.json({ success: true, count: threads.length, threads });
    } catch (error: any) {
      console.error('Reflection route error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/reflection/arc/:entity
   * Trace emotional trajectory for an entity over time.
   */
  router.get('/arc/:entity', async (c) => {
    try {
      const entityName = c.req.param('entity');
      const userId = getCaller().user_id;
      const limit = Math.min(parseInt(c.req.query('limit') || '10'), 100);

      const arc = await store.getReflectionArc(userId, entityName, limit);
      return c.json({ success: true, entity: entityName, points: arc.length, arc });
    } catch (error: any) {
      console.error('Reflection route error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/reflection/nodes
   * Get all reflection nodes (entities with emotional signatures).
   */
  router.get('/nodes', async (c) => {
    try {
      const userId = getCaller().user_id;
      const nodes = await store.getAllReflectionNodes(userId);
      return c.json({ success: true, count: nodes.length, nodes });
    } catch (error: any) {
      console.error('Reflection route error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  return router;
};
