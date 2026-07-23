/**
 * Katra — Cognitive Memory as a Service for AI Agents
 *
 * Entry point: starts REST API server + MCP server.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

import { connect_to_mongodb, is_database_connected, get_pool_health, get_client } from './database/connection.js';
import { close_redis_connection, is_redis_healthy } from './database/redis-connection.js';
import { llmService } from './services/infrastructure/llm-service.js';
import { get_llm_config_from_db } from './services/infrastructure/llm-service.js';
import { embeddingService } from './services/infrastructure/embedding-service.js';
import { BackgroundProcessor } from './services/processing/background-processor.js';
import { SleepConsolidationService } from './services/processing/sleep-consolidation-service.js';
import { AutonomousExecutive } from './services/processing/autonomous-executive.js';

// Routes
import { create_memory_routes } from './routes/memory-routes.js';
import { create_recall_routes } from './routes/recall-routes.js';
import { create_knowledge_graph_routes } from './routes/graph-routes.js';
import { create_ingestion_routes } from './routes/ingestion-routes.js';
import { create_assets_routes } from './routes/asset-routes.js';
import { create_diagnostic_routes } from './routes/health-routes.js';
import { create_admin_routes } from './routes/admin-routes.js';
import { create_tenant_routes } from './routes/tenant-routes.js';
import { create_reflection_routes } from './routes/reflection-routes.js';

// MCP server
import { startMcpServer } from './mcp-server.js';
import { isMultiTenant, runWithTenant } from './database/tenant-context.js';
import { resolveTenant, initTenantSystem } from './services/integration/tenant-service.js';
import { ensureApiKeys, logGeneratedKeys, validateKatraKey, isKatraAuthConfigured } from './utils/api-key-manager.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '9002');
const MCP_PORT = parseInt(process.env.MCP_PORT || '3100');
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Katra — Cognitive Memory as a Service');
  console.log('═══════════════════════════════════════════');

  // Connect to MongoDB with retry (handles Pi5 cold-start race where
  // Mongo auth takes longer than docker-compose healthcheck allows)
  const maxRetries = 5;
  let mongoOk = false;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await connect_to_mongodb();
    if (is_database_connected()) { mongoOk = true; break; }
    if (attempt < maxRetries) {
      const delay = attempt * 2000;
      console.log(`  MongoDB not ready (attempt ${attempt}/${maxRetries}), retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  console.log(`  MongoDB: ${mongoOk ? '✅ connected' : '⚠️ offline mode'}`);

  // Ensure API keys are available (generate + persist if missing).
  // validateKatraKey() / validateMcpKey() are now the authoritative validators;
  // process.env is updated only when we have plaintext (env-var or fresh generation).
  const { mcpApiKey, katraApiKey, generated: keysGenerated } = await ensureApiKeys();
  if (mcpApiKey) process.env.MCP_API_KEY = mcpApiKey;
  if (katraApiKey) process.env.KATRA_API_KEY = katraApiKey;
  if (keysGenerated) {
    logGeneratedKeys(mcpApiKey, katraApiKey);
  }

  // Initialize Redis (non-blocking — services degrade gracefully)
  console.log(`  Redis: connecting...`);

  // Initialize LLM service (non-blocking — validates providers async)
  console.log(`  LLM: ${llmService.isServiceAvailable() ? '✅ available' : '⏳ initializing...'}`);

  // Check DB for LLM config (overrides env vars if present)
  const dbLLMConfig = await get_llm_config_from_db();
  if (dbLLMConfig) {
    console.log('  LLM: config found in database, applying...');
    llmService.apply_config(dbLLMConfig);
  }

  // Pre-warm embedding service (lazy load the ONNX model)
  // Must happen before REST API starts so health check shows correct status
  try {
    const vec = await embeddingService.encode('Embedding model warmup — initializing vector search');
    if (vec && embeddingService.isReady) {
      console.log('  Embeddings: ✅ available');
    } else {
      console.log('  Embeddings: ⚠️ unavailable (model failed to load)');
    }
  } catch {
    console.log('  Embeddings: ⚠️ unavailable (keyword search only)');
  }

  // Start background processor (can be disabled via env var)
  const bgProcessor = BackgroundProcessor.get_instance();
  if (process.env.KATRA_DISABLE_BACKGROUND_PROCESSOR === 'true') {
    console.log('⏸️ Background processor disabled via KATRA_DISABLE_BACKGROUND_PROCESSOR=true');
  } else {
    // Restore ACC state from database before starting processing
    try {
      const { DecisionActionService } = await import('./services/processing/decision-action-service.js');
      await DecisionActionService.get_instance().restoreFromDB();
    } catch { /* non-critical */ }
    bgProcessor.start(30000); // 30 second interval
  }

  // Start sleep consolidation service
  const sleepService = SleepConsolidationService.get_instance();
  sleepService.schedule({
    daily:  { hour: 2, minute: 0 },            // 2:00 AM daily
    weekly: { dayOfWeek: 0, hour: 3, minute: 0 },  // Sunday 3:00 AM
    monthly:{ dayOfMonth: 1, hour: 4, minute: 0 }, // 1st of month 4:00 AM
  });

  // Start autonomous executive loop (self-initiated decision-action)
  const executive = AutonomousExecutive.get_instance();
  executive.start();

  // ── REST API Server (Hono) ──
  const app = new Hono();

  // Middleware
  app.use('*', async (c, next) => {
    c.header('X-Powered-By', 'Katra');
    c.header('X-Version', '1.0.0');
    await next();
  });

  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  // Simple API key auth (skip for health endpoints)
  app.use('/api/*', async (c, next) => {
    // Skip auth for health checks, read-only dashboard/API data
    if (c.req.path === '/api/v1/health' ||
        c.req.path === '/api/v1/admin/dashboard-stats' ||
        c.req.path === '/api/v1/admin/memory-search' ||
        c.req.path === '/api/v1/admin/pubsub/presence' ||
        c.req.path === '/api/v1/admin/pubsub/topics' ||
        c.req.path === '/api/v1/admin/pubsub/muted' ||
        c.req.path === '/api/v1/admin/personality' ||
        c.req.path === '/api/v1/admin/personality/profiles') {
      return next();
    }

    // Multi-tenant mode: resolve API key to tenant
    if (isMultiTenant()) {
      const auth = c.req.header('Authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) {
        return c.json({ error: 'Unauthorized', message: 'API key required' }, 401);
      }

      // Admin key gets full access (including tenant management)
      if (validateKatraKey(token)) {
        return next();
      }

      // Resolve tenant
      const tenant = await resolveTenant(token);
      if (!tenant) {
        return c.json({ error: 'Unauthorized', message: 'Invalid API key' }, 401);
      }

      // Set tenant context for downstream handlers
      return runWithTenant(
        { tenant_id: tenant.tenant_id, database_name: tenant.database_name, plan: tenant.plan },
        () => next()
      );
    }

    // Single-tenant mode (default): open access when no key is configured.
    if (!isKatraAuthConfigured()) {
      return next();
    }

    const auth = c.req.header('Authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token && validateKatraKey(token)) {
      return next();
    }

    return c.json({ error: 'Unauthorized', message: 'Invalid or missing API key' }, 401);
  });

  // Mount routes
  app.route('/api/v1/memory', create_memory_routes());
  app.route('/api/v1', create_diagnostic_routes());
  app.route('/api/v1/ingestion', create_ingestion_routes());
  app.route('/api/v1/memory/recall', create_recall_routes());
  app.route('/api/v1/memory/enhance', create_knowledge_graph_routes());
  app.route('/api/v1/assets', create_assets_routes());
  app.route('/api/v1/admin', create_admin_routes());
  app.route('/api/v1/reflection', create_reflection_routes());

  // Tenant management (multi-tenant mode only)
  if (isMultiTenant()) {
    await initTenantSystem();
    app.route('/api/v1/tenants', create_tenant_routes());
    console.log('  🏢 Multi-tenant mode: ENABLED');
  }

  // Root
  app.get('/', (c) => c.json({
    name: 'Katra',
    version: '1.0.0',
    description: 'Cognitive Memory as a Service for AI Agents',
    docs: '/api/v1/health',
    mcp: `http://${HOST}:${MCP_PORT}/mcp`,
    dashboard: '/dashboard',
  }));

  // Serve dashboard (static HTML)
  const dashboardPath = path.resolve(process.cwd(), 'dashboard');
  if (fs.existsSync(dashboardPath)) {
    app.use('/dashboard/*', serveStatic({ root: dashboardPath, rewriteRequestPath: (p) => p.replace(/^\/dashboard/, '') || '/' }));
    app.get('/dashboard', (c) => c.redirect('/dashboard/'));
    console.log('  📊 Dashboard: http://' + HOST + ':' + PORT + '/dashboard');
  }

  // Start REST API server
  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`\n  🌐 REST API: http://${HOST}:${PORT}`);
    console.log(`  📡 MCP:      http://${HOST}:${MCP_PORT}/mcp`);
    console.log(`  📚 Docs:     http://${HOST}:${PORT}/api/v1/health`);
    console.log('\n  Ready for agent connections.\n');
  });

  // Start MCP server (in-process, separate HTTP server)
  startMcpServer(MCP_PORT, HOST);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    bgProcessor.stop();
    sleepService.stop();
    executive.stop();
    await close_redis_connection();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('❌ Fatal error during startup:', err);
  process.exit(1);
});
