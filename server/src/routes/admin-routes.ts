import { Hono } from 'hono';
import { get_database } from '../database/connection.js';
import { getEpisodicEventManager } from '../services/memory/episodic-event-manager.js';
import { get_redis_client } from '../database/redis-connection.js';
import { llmService } from '../services/infrastructure/llm-service.js';
import { backgroundProcessor } from '../services/processing/background-processor.js';
import { IndexManager } from '../database/index-management.js';
import { get_error_message, get_error_stack } from '../utils/error-utils.js';
import { getMemoryScope, invalidateScopeCache, DEFAULT_USER_ID } from '../services/memory/memory-scope-service.js';
import { get_llm_config_from_db, save_llm_config_to_db, type LLMConfig } from '../services/infrastructure/llm-service.js';
import { entityResolver } from '../services/integration/entity-resolver.js';
import { create_rate_limiter } from '../middleware/rate-limit.js';
import { getAgentIdentity, setAgentIdentity } from '../services/infrastructure/agent-identity.js';
import { getCaller } from '../utils/caller-identity.js';
import { validateKatraKey } from '../utils/api-key-manager.js';
import { SleepConsolidationService } from '../services/processing/sleep-consolidation-service.js';
import { escape_regex } from '../utils/regex-escape.js';
import { PROFILES, ALL_SOURCES, AGENT_MESSAGE_WEIGHT, RECOMMENDED_BUDGETS } from '../services/integration/personality-profiles.js';
import {
  PersonalityAccessError,
  PersonalityWriteConflictError,
  perIdentityPersonalityEnabled,
  resolvePersonalityConfig,
  sanitizePersonalityPatch,
  updatePersonalityConfig,
} from '../services/integration/personality-config-service.js';
// ITER-11 (§6.2): the deprecation telemetry of the legacy global record. It is
// written from the read/write paths below, never breaks them, and is surfaced
// on the rollout view.
import { notePersonalityDeprecation } from '../services/integration/personality-deprecation-telemetry.js';
import { embeddingService } from '../services/infrastructure/embedding-service.js';

// ---- Admin memory-search helpers ----------------------------------------
// The admin search spans the four canonical memory collections. The keyword
// pass is the deterministic bottom layer — no model dependency, so wake-ritual
// rule recall never breaks: relevance-ranked $text for the collections that
// carry a text index (episodic/facts), escaped-token regex elsewhere. Keyword
// hits are returned ahead of the embedding service's semantic augmentation,
// and every hit exposes id/_id/score (R29 D12).

const MEMORY_COLLECTIONS: string[] = ['episodic_events', 'semantic_facts', 'knowledge_nodes', 'reflective_journals'];

/**
 * Collection aliases accepted on the `collection` query param. The public
 * contract (dashboard + the AGMT measurement instrument) uses the short names;
 * before 2026-10-08 the raw value was passed straight to db.collection(), so
 * `collection=episodic` resolved to a NON-EXISTENT collection and returned []
 * in ~0.01 s (R29 D12). Aliases — and the canonical names — now resolve to
 * the real collections.
 */
const COLLECTION_ALIASES: Record<string, string> = {
  episodic: 'episodic_events',
  episodic_events: 'episodic_events',
  semantic: 'semantic_facts',
  facts: 'semantic_facts',
  semantic_facts: 'semantic_facts',
  knowledge: 'knowledge_nodes',
  knowledge_nodes: 'knowledge_nodes',
  reflections: 'reflective_journals',
  reflective: 'reflective_journals',
  reflective_journals: 'reflective_journals',
};

const resolveCollection = (col: string): string =>
  COLLECTION_ALIASES[col] ?? COLLECTION_ALIASES[col.toLowerCase()] ?? col;

/**
 * Collections whose keyword pass uses the Mongo text index ($text): both carry
 * a text index on the field the documents actually hold (episodic_events:
 * content.message; semantic_facts: content). Relevance ranking matters there —
 * recency sorting alone hides an older exact match under newer partial-token
 * matches, which is exactly the known-item failure R29 measured.
 */
const TEXT_INDEXED_COLLECTIONS = new Set(['episodic_events', 'semantic_facts']);

/**
 * Personality endpoints that are caller-pinned instead of admin-gated: a
 * resolved caller reads and writes its OWN record, so GET/PUT without
 * `?user_id=` needs no admin key here (the global caller-auth middleware still
 * requires a resolved caller). Naming another identity (`?user_id=<id>`) is an
 * admin operation and falls through to the admin-key check.
 */
const PERSONALITY_PATHS: string[] = ['/admin/personality', '/api/v1/admin/personality'];

/** Does the request carry a valid admin key? (loopback callers may not need one) */
const hasAdminKey = (c: { req: { header: (name: string) => string | undefined } }): boolean => {
  const header = c.req.header('Authorization') ?? '';
  const presented = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  return Boolean(presented && validateKatraKey(presented));
};

const normalizeCollection = (col: string): string =>
  col.replace('_events', '').replace('_facts', '').replace('_nodes', '').replace('_journals', '').replace('reflective', 'reflections');

const sortFieldFor = (col: string): string =>
  col === 'episodic_events' ? 'timestamp' : col === 'knowledge_nodes' ? 'updated_at' : 'created_at';

// Deterministic, escaped token regex over the searchable text fields.
const buildTextClauses = (query: string): Array<Record<string, any>> => {
  const escaped = escape_regex(query.slice(0, 200));
  const terms = escaped.split(/\s+/).slice(0, 10).join('|');
  return [
    { 'content.message': { $regex: terms, $options: 'i' } },
    { 'content': { $regex: terms, $options: 'i' } },
    { 'name': { $regex: terms, $options: 'i' } },
    { 'narrative': { $regex: terms, $options: 'i' } },
  ];
};

// Build the per-collection Mongo filter. Knowledge nodes and reflective
// journals only carry name/narrative text (no content.message), so their
// clauses are reduced accordingly — and combined with an OR, not an AND.
const buildCollectionFilter = (
  col: string,
  base: Record<string, any>,
  textClauses: Array<Record<string, any>> | null,
): Record<string, any> => {
  if (col === 'knowledge_nodes' || col === 'reflective_journals') {
    if (!textClauses) return {};
    const clauses = textClauses.filter((c) => {
      const k = Object.keys(c)[0];
      return k === 'name' || k === 'narrative';
    });
    return clauses.length > 0 ? { $or: clauses } : {};
  }
  return { ...base, ...(textClauses ? { $or: textClauses } : {}) };
};

// Map a raw Mongo doc to the response shape. `content` is polymorphic across
// collections (object with .message for episodic, string for semantic facts,
// name for knowledge nodes, narrative for reflective journals).
const mapMemoryItem = (col: string, item: any, score: number | null = null): any => {
  const c = item.content;
  let content: string;
  if (c && typeof c === 'object' && c.message) content = c.message;
  else if (typeof c === 'string' && c) content = c;
  else if (c && typeof c === 'object' && c.fact) content = c.fact;
  else if (item.fact) content = item.fact;
  else if (item.name) content = item.name;
  else if (item.narrative) content = item.narrative;
  else if (item.label) content = item.label;
  else if (item.title) content = item.title;
  else content = JSON.stringify(item);
  return {
    id: item.id != null ? String(item.id) : String(item._id ?? ''),
    _id: String(item._id ?? ''),
    collection: normalizeCollection(col),
    timestamp: item.timestamp || item.created_at || item.updated_at,
    user_id: item.user_id || 'system',
    content: content.substring(0, 300),
    score,
  };
};

/**
 * Keyword search for one collection.
 *
 * Text-indexed collections search via $text so results are RELEVANCE-ranked
 * and carry a textScore. The $text path retries once with quotes/backslashes
 * stripped (the only $text parse hazards) and falls back to the escaped-token
 * regex when the text index is missing or the query stays unparseable.
 * Non-indexed collections and the fallback keep the legacy regex behavior.
 */
const searchKeyword = async (
  db: any,
  col: string,
  base: Record<string, any>,
  query: string,
  limit: number,
): Promise<Array<{ key: string; item: any }>> => {
  const out: Array<{ key: string; item: any }> = [];
  const push = (items: any[], scores: Map<string, number> | null): void => {
    items.forEach((item: any) =>
      out.push({
        key: `${col}:${String(item._id ?? '')}`,
        item: mapMemoryItem(col, item, scores ? (scores.get(String(item._id)) ?? null) : null),
      }),
    );
  };

  if (TEXT_INDEXED_COLLECTIONS.has(col)) {
    const capped = query.slice(0, 200);
    if (capped.trim()) {
      const attempts = [capped];
      const sanitized = capped.replace(/["\\]/g, ' ');
      if (sanitized !== capped) attempts.push(sanitized);
      for (const search of attempts) {
        try {
          const res = await db.collection(col)
            .find(
              { ...base, $text: { $search: search } },
              {
                projection: {
                  content: 1, timestamp: 1, created_at: 1, name: 1, narrative: 1, fact: 1, user_id: 1, id: 1,
                  _tscore: { $meta: 'textScore' },
                },
              },
            )
            .sort({ _tscore: { $meta: 'textScore' } })
            .limit(limit)
            .toArray();
          const scores = new Map<string, number>((res as any[]).map((d: any) => [String(d._id), d._tscore]));
          push(res, scores);
          return out;
        } catch {
          // Try the next attempt; fall through to the regex path if all fail.
        }
      }
    }
  }

  // Escaped-token regex fallback (collections without a text index, or when
  // the $text path failed). Recency-ordered, legacy behavior.
  const textClauses = buildTextClauses(query);
  const filter = buildCollectionFilter(col, base, textClauses);
  const items = await db.collection(col).find(filter).sort({ [sortFieldFor(col)]: -1 }).limit(limit).toArray();
  push(items, null);
  return out;
};

export const create_admin_routes = (): Hono => {
  const router = new Hono();

  // Admin-only auth gate. Always requires KATRA_API_KEY regardless of global
  // middleware state (no open-access fallback even in dev mode). Rejects tenant
  // keys in multi-tenant deployments because only the master admin key matches.
  router.use('*', async (c, next) => {
    // Dashboard stats, memory search, pub-sub bus, and the static personality
    // registry — no auth required (read-only, dashboard-facing).
    const readOnlyPaths = [
      '/admin/dashboard-stats', '/api/v1/admin/dashboard-stats',
      '/admin/memory-search', '/api/v1/admin/memory-search',
      '/admin/pubsub/presence', '/api/v1/admin/pubsub/presence',
      '/admin/pubsub/topics', '/api/v1/admin/pubsub/topics',
      '/admin/pubsub/muted', '/api/v1/admin/pubsub/muted',
      '/admin/personality/profiles', '/api/v1/admin/personality/profiles',
      '/admin/identity', '/api/v1/admin/identity',
    ];
    if (readOnlyPaths.includes(c.req.path)) {
      return next();
    }

    // ITER-2: the personality endpoints left this allowlist. A resolved caller
    // may read/write its own record; naming ANOTHER identity with `?user_id=`
    // needs the admin key, so those requests fall through to the check below.
    // ITER-3: naming the caller's OWN identity is not "another identity". The
    // endpoint is caller-pinned and the bridge always sends `?user_id=<its
    // identity>`, so that request must behave exactly like omitting the
    // parameter (200, resolved for the caller). The comparison is against the
    // resolved caller, so any other id — and an unresolved caller naming
    // anything — is still admin-gated.
    const requestedUserId = (c.req.query('user_id') ?? '').trim();
    const namesAnotherIdentity = Boolean(requestedUserId && requestedUserId !== getCaller().user_id);
    if (
      PERSONALITY_PATHS.includes(c.req.path)
      && (c.req.method === 'GET' || c.req.method === 'PUT')
      && !namesAnotherIdentity
    ) {
      return next();
    }

    if (!hasAdminKey(c)) {
      console.warn(`Admin auth rejected: ${c.req.method} ${c.req.path}`);
      return c.json({ error: 'Unauthorized', message: 'Admin API key required' }, 401);
    }
    return next();
  });

  // General admin rate limit (30/min per API key). Keyed on the Authorization
  // header hash so a leaked key used from multiple IPs is still throttled.
  router.use('*', create_rate_limiter({
    keyPrefix: 'admin_general',
    max: 30,
    windowMs: 60_000,
    identifyBy: 'apiKey',
  }));

  /**
   * Clear all data from MongoDB and Redis
   * WARNING: This will permanently delete ALL data
   */
  router.post('/clear-all', create_rate_limiter({
    keyPrefix: 'admin_destructive',
    max: 5,
    windowMs: 60_000,
    identifyBy: 'apiKey',
    failOpen: false,
  }), async (c) => {
    try {
      console.log('🗑️ Starting database clear operation...');
      
      const results = {
        mongodb: { cleared: false as boolean, collections: 0 as number, documents: 0 as number, error: null as string | null },
        redis: { cleared: false as boolean, keys: 0 as number, error: null as string | null },
        timestamp: new Date().toISOString()
      };

      // Clear MongoDB collections - target known collections directly
      try {
        const db = get_database();
        
        // List of known collection names used by the application
        const knownCollections = [
          'episodic_events',
          'semantic_facts', 
          'knowledge_nodes',
          'knowledge_relationships',
          'conversations',
          'messages',
          'users',
          'sessions',
          'working_memory',
          'memory_contexts',
          'chat_sessions',
          'user_profiles'
        ];
        
        let totalDocuments = 0;
        let clearedCollections = 0;
        
        for (const collectionName of knownCollections) {
          try {
            const coll = db.collection(collectionName);
            
            // Count documents before deletion
            const docCount = await coll.countDocuments();
            
            if (docCount > 0) {
              // Use deleteMany instead of drop to avoid permission issues
              const deleteResult = await coll.deleteMany({});
              totalDocuments += deleteResult.deletedCount || docCount;
              clearedCollections++;
              console.log(`✅ Cleared MongoDB collection: ${collectionName} (${deleteResult.deletedCount || docCount} documents)`);
            } else {
              console.log(`✅ MongoDB collection ${collectionName} was already empty`);
            }
          } catch (collError: any) {
            // If collection doesn't exist or we can't access it, that's fine
            console.log(`ℹ️ Skipped MongoDB collection ${collectionName}: ${collError.message}`);
          }
        }
        
        results.mongodb.cleared = true;
        results.mongodb.collections = clearedCollections;
        results.mongodb.documents = totalDocuments;
        
        console.log(`✅ MongoDB cleared: ${clearedCollections} collections, ${totalDocuments} documents`);
      } catch (mongodb_error: any) {
        console.error('❌ MongoDB clear error:', mongodb_error);
        results.mongodb.error = mongodb_error.message;
      }

      // Clear Redis keys
      try {
        const redis_client = await get_redis_client();
        
        if (redis_client) {
          // Get all keys first (for counting)
          const keys = await redis_client.keys('*');
          const keyCount = keys.length;
          
          if (keyCount > 0) {
            // Use FLUSHDB to clear the current database
            await redis_client.flushDb();
            results.redis.cleared = true;
            results.redis.keys = keyCount;
            console.log(`✅ Redis cleared: ${keyCount} keys`);
          } else {
            results.redis.cleared = true;
            results.redis.keys = 0;
            console.log('✅ Redis was already empty');
          }
        } else {
          console.warn('⚠️ Redis client not available - skipping Redis clear');
          results.redis.error = 'Redis client not available';
        }
      } catch (redis_error: any) {
        console.error('❌ Redis clear error:', redis_error);
        results.redis.error = redis_error.message;
      }

      // Determine overall success
      const success = results.mongodb.cleared || results.redis.cleared;
      const status = success ? 200 : 500;

      console.log('🗑️ Database clear operation completed:', results);

      return c.json({
        success,
        message: success ? 'Database clear operation completed' : 'Database clear operation failed',
        results
      }, status);

    } catch (error: any) {
      console.error('❌ Database clear operation failed:', error);
      return c.json({
        success: false,
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString()
      }, 500);
    }
  });

  /**
   * GET /api/v1/admin/dashboard-stats
   * Returns all data needed by the dashboard: collection counts,
   * recent autonomous activity, and pending approvals.
   */
  router.get('/dashboard-stats', async (c) => {
    try {
      const db = get_database();
      const counts = await Promise.all([
        db.collection('episodic_events').countDocuments({}),
        db.collection('semantic_facts').countDocuments({}),
        db.collection('knowledge_nodes').countDocuments({}),
        db.collection('reflective_journals').countDocuments({}),
        db.collection('reflection_nodes').countDocuments({}),
        db.collection('reflection_edges').countDocuments({}),
        db.collection('philosophical_insights').countDocuments({}),
        db.collection('agent_journal_auto').countDocuments({}),
      ]);

      // Recent autonomous activity
      const recent = await db.collection('episodic_events')
        .find({ event_type: { $in: ['heartbeat_action', 'task_execution', 'autonomous_action'] } })
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray();

      // Pending approvals
      const pending = await db.collection('episodic_events')
        .find({ 
          'metadata.status': 'pending_approval',
          shared_id: 'neural-link' 
        })
        .sort({ timestamp: -1 })
        .limit(10)
        .toArray();

      // Agent stats
      const agents = await db.collection('episodic_events').aggregate([
        { $group: { _id: '$user_id', count: { $sum: 1 }, last_active: { $max: '$timestamp' } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]).toArray();

      return c.json({
        success: true,
        counts: {
          episodic_events: counts[0],
          semantic_facts: counts[1],
          knowledge_nodes: counts[2],
          reflective_journals: counts[3],
          reflection_nodes: counts[4],
          reflection_edges: counts[5],
          philosophical_insights: counts[6],
          auto_journals: counts[7],
        },
        recent_activity: recent.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          event_type: e.event_type,
          user_id: e.user_id,
          content: e.content?.message?.substring(0, 200) || '',
          status: e.metadata?.status || e.metadata?.task_status || '—',
          entity: (e.content?.message || '').match(/Entity: (.+)/)?.[1] || '',
          assigned_agent: e.metadata?.assigned_agent || '',
          confidence: e.metadata?.confidence || 0,
        })),
        pending_approvals: pending.map(p => ({
          id: p.id,
          timestamp: p.timestamp,
          entity: (p.content?.message || '').match(/Entity: (.+)/)?.[1] || 'unknown',
          assigned_agent: p.metadata?.assigned_agent || '',
          confidence: p.metadata?.confidence || 0,
          // Never hardcode scope — read the stored classification. The
          // heartbeat writes completed investigations as pending_approval;
          // the auto-triage closes those as Scope A within one cycle, so
          // anything still listed here is a genuine review item.
          scope: p.metadata?.scope || (p.event_type === 'heartbeat_action' ? 'A' : '—'),
          action: (p.content?.message || '').match(/Output: (.+)/)?.[1] || '',
          status: p.metadata?.status || 'pending_approval',
        })),
        agents: agents.map(a => ({
          user_id: a._id,
          events: a.count,
          last_active: a.last_active,
        })),
        memory_scope: await (async () => {
          try {
            const scope = await getMemoryScope();
            return {
              mode: scope.mode,
              shared_id: scope.shared_id,
              hybrid_visible_user_ids: scope.hybrid_visible_user_ids,
            };
          } catch { return {}; }
        })(),
      });
    } catch (error: any) {
      console.error('Dashboard stats error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/admin/memory-search
   * Public read-only search across memory collections — no auth required.
   * Params: ?query=... &collection=episodic|semantic|knowledge|reflections|all &user_id=... &limit=20
   *
   * Hybrid search: deterministic keyword pass first (relevance-ranked via the
   * $text index for episodic/semantic, escaped-token regex elsewhere), then
   * semantic vector augmentation when the embedding model is available.
   * Query + collection are honored with or without user_id. Every hit carries
   * its identity (`id`, `_id`) and, where defined, a `score` (textScore for
   * index-ranked keyword hits, cosine blend for semantic hits; null when
   * neither applies).
   */
  router.get('/memory-search', async (c) => {
    try {
      const db = get_database();
      const query = c.req.query('query') || '';
      const collection = c.req.query('collection') || 'all';
      const user_id = c.req.query('user_id') || '';
      const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

      const cols = collection === 'all' ? [...MEMORY_COLLECTIONS] : [resolveCollection(collection)];

      // Deterministic keyword pass — honors query + collection regardless of
      // user_id (this is the contract fix). Text-indexed collections come back
      // relevance-ranked with a textScore; the rest fall back to the
      // escaped-token regex, recency-ordered.
      const base: Record<string, any> = user_id ? { user_id } : {};

      const keyword: Array<{ key: string; item: any }> = [];
      for (const col of cols) {
        if (query) {
          keyword.push(...(await searchKeyword(db, col, base, query, limit)));
        } else {
          const items = await db.collection(col).find(base).sort({ [sortFieldFor(col)]: -1 }).limit(limit).toArray();
          items.forEach((item: any) =>
            keyword.push({ key: `${col}:${String(item._id ?? '')}`, item: mapMemoryItem(col, item) }),
          );
        }
      }

      const results: any[] = [];

      // Semantic augmentation (best-effort): vector-ranked matches help fuzzy
      // and paraphrase queries. Any failure falls back to keyword results.
      if (query && embeddingService.isReady) {
        try {
          const semantic: Array<{ key: string; score: number; item: any }> = [];
          for (const col of cols) {
            const hits = await embeddingService.searchSimilar(col, user_id, query, { limit });
            for (const hit of hits) {
              const key = `${col}:${String(hit._id ?? '')}`;
              if (semantic.some((s) => s.key === key)) continue;
              const score = hit.score ?? 0;
              semantic.push({ key, score, item: mapMemoryItem(col, hit, score) });
            }
          }
          semantic.sort((a, b) => b.score - a.score);

          // Deterministic keyword hits FIRST: an exact known-item match must
          // survive the limit slice (appending them after a full semantic page
          // is how document-derived probes were buried — R29 D12). Semantic
          // augmentation follows, deduped; a keyword hit that also matched
          // semantically keeps the semantic score for like-for-like ranking.
          const semanticScoreByKey = new Map(semantic.map((s) => [s.key, s.score]));
          const seen = new Set<string>();
          for (const k of keyword) {
            if (seen.has(k.key)) continue;
            seen.add(k.key);
            const semScore = semanticScoreByKey.get(k.key);
            if (semScore != null) k.item.score = semScore;
            results.push(k.item);
          }
          for (const s of semantic) { if (!seen.has(s.key)) { seen.add(s.key); results.push(s.item); } }
        } catch (err: any) {
          console.warn('Memory search semantic augmentation failed, using keyword results:', err.message);
          keyword.forEach((k) => results.push(k.item));
        }
      } else {
        keyword.forEach((k) => results.push(k.item));
      }

      // With no query, order by recency desc (legacy behavior).
      if (!query) {
        results.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
      }

      return c.json({ success: true, results: results.slice(0, limit) });
    } catch (error: any) {
      console.error('Memory search error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * Get database statistics (useful for confirming clear operation)
   */
  router.get('/database-stats', async (c) => {
    try {
      const stats = {
        mongodb: { collections: 0 as number, total_documents: 0 as number, collection_details: [] as Array<{ name: string; documents: number }>, error: null as string | null },
        redis: { total_keys: 0 as number, memory_usage: null as number | null, error: null as string | null },
        timestamp: new Date().toISOString()
      };

      // Get MongoDB stats - check known collections directly
      try {
        const db = get_database();
        
        // List of known collection names used by the application
        const knownCollections = [
          'episodic_events',
          'semantic_facts', 
          'knowledge_nodes',
          'knowledge_relationships',
          'conversations',
          'messages',
          'users',
          'sessions',
          'working_memory',
          'memory_contexts',
          'chat_sessions',
          'user_profiles'
        ];
        
        let totalDocs = 0;
        const collectionDetails = [];
        let existingCollections = 0;
        
        for (const collectionName of knownCollections) {
          try {
            const coll = db.collection(collectionName);
            const docCount = await coll.countDocuments();
            
            if (docCount > 0) {
              totalDocs += docCount;
              collectionDetails.push({
                name: collectionName,
                documents: docCount
              });
              existingCollections++;
            }
          } catch (collError: any) {
            // Collection doesn't exist or can't access - that's fine, skip it
            console.log(`ℹ️ Skipped collection ${collectionName} in stats: ${collError.message}`);
          }
        }
        
        stats.mongodb.collections = existingCollections;
        stats.mongodb.total_documents = totalDocs;
        stats.mongodb.collection_details = collectionDetails;
      } catch (mongodb_error: any) {
        console.error('❌ MongoDB stats error:', mongodb_error);
        stats.mongodb.error = mongodb_error.message;
      }

      // Get Redis stats
      try {
        const redis_client = await get_redis_client();
        
        if (redis_client) {
          const keys = await redis_client.keys('*');
          stats.redis.total_keys = keys.length;
          
          // Try to get memory usage info
          try {
            const info = await redis_client.info('memory');
            const memoryMatch = info.match(/used_memory:(\d+)/);
            if (memoryMatch) {
              stats.redis.memory_usage = parseInt(memoryMatch[1]);
            }
          } catch (info_error) {
            // Memory info not critical, continue without it
          }
        } else {
          stats.redis.error = 'Redis client not available';
        }
      } catch (redis_error: any) {
        console.error('❌ Redis stats error:', redis_error);
        stats.redis.error = redis_error.message;
      }

      return c.json({
        success: true,
        stats
      });

    } catch (error) {
      console.error('❌ Database stats operation failed:', error);
      return c.json({
        success: false,
        error: get_error_message(error)
      }, 500);
    }
  });

  /**
   * Test LLM service connection and configuration
   */
  router.post('/test-llm', async (c) => {
    try {
      console.log('🧪 Testing LLM service...');
      
      // Get service status
      const serviceStatus = llmService.getServiceStatus();
      console.log('🧪 LLM Service Status:', serviceStatus);
      
      // Test the actual service
      const testResult = await llmService.testService();
      console.log('🧪 LLM Test Result:', testResult);
      
      return c.json({
        success: testResult.success,
        service_status: serviceStatus,
        test_result: testResult,
        environment_check: {
          api_key_present: !!process.env.MOONSHOT_API_KEY,
          api_key_configured: !!process.env.MOONSHOT_API_KEY
        }
      });
      
    } catch (error) {
      console.error('❌ LLM test failed:', error);
      return c.json({
        success: false,
        error: get_error_message(error),
        stack: get_error_stack(error)
      }, 500);
    }
  });

  /**
   * Test semantic fact storage - for debugging the storage issue
   */
  router.post('/test-semantic-fact', async (c) => {
    try {
      const db = get_database();
      
      // Test inserting a simple semantic fact directly
      const testFact = {
        user_id: 'test-user',
        content: 'Test fact: This is a debugging test',
        source: 'test',
        confidence: 0.9,
        metadata: {
          test: true,
          timestamp: new Date().toISOString()
        },
        created_at: new Date()
      };
      
      console.log('🧪 Testing semantic fact insertion...');
      console.log('🧪 Database name:', db.databaseName);
      console.log('🧪 Test fact:', JSON.stringify(testFact, null, 2));
      
      // Test 1: Direct MongoDB insertion
      const directResult = await db.collection('semantic_facts').insertOne(testFact);
      console.log('🧪 Direct insert result:', {
        acknowledged: directResult.acknowledged,
        insertedId: directResult.insertedId?.toString()
      });
      
      // Test 2: Verify the document exists
      const findResult = await db.collection('semantic_facts').findOne({
        _id: directResult.insertedId
      });
      console.log('🧪 Can find inserted document?', !!findResult);
      
      // Test 3: Count total documents
      const totalCount = await db.collection('semantic_facts').countDocuments();
      console.log('🧪 Total documents in semantic_facts:', totalCount);
      
      // Test 4: List some recent documents
      const recentDocs = await db.collection('semantic_facts')
        .find({})
        .sort({ created_at: -1 })
        .limit(3)
        .toArray();
      console.log('🧪 Recent documents:', recentDocs.length);
      
      return c.json({
        success: true,
        test_results: {
          direct_insert: {
            acknowledged: directResult.acknowledged,
            inserted_id: directResult.insertedId?.toString()
          },
          document_found: !!findResult,
          total_count: totalCount,
          recent_docs_count: recentDocs.length,
          database_name: db.databaseName
        },
        message: 'Semantic fact test completed'
      });
      
    } catch (error) {
      console.error('❌ Semantic fact test failed:', error);
      return c.json({
        success: false,
        error: get_error_message(error),
        stack: get_error_stack(error)
      }, 500);
    }
  });

  /**
   * Debug database collections - check what exists
   */
  router.get('/debug-collections', async (c) => {
    try {
      const db = get_database();
      
      // Get all collections
      const collections = await db.listCollections().toArray();
      
      const collectionDetails = await Promise.all(
        collections.map(async (coll) => {
          try {
            const count = await db.collection(coll.name).countDocuments();
            return {
              name: coll.name,
              documents: count
            };
          } catch (error: any) {
            return {
              name: coll.name,
              documents: 0,
              error: error.message
            };
          }
        })
      );
      
      return c.json({
        success: true,
        database_name: db.databaseName,
        collections: collectionDetails,
        total_collections: collections.length
      });
      
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 500);
    }
  });

  /**
   * Force background processing for debugging
   */
  router.post('/background/force-process', async (c) => {
    try {
      console.log('🔄 Force processing all unprocessed events...');
      
      const result = await backgroundProcessor.forceProcessAll();
      
      console.log('✅ Force processing completed:', result);
      
      return c.json({
        success: true,
        result: result,
        message: `Processed ${result.processed} events, ${result.failed} failed`
      });
      
    } catch (error: any) {
      console.error('❌ Force processing failed:', error);
      return c.json({
        success: false,
        error: error.message,
        stack: error.stack
      }, 500);
    }
  });

  /**
   * POST /api/v1/admin/update-task-status
   * Body: { id: "task-id", status: "approved" | "rejected" }
   * Used by the dashboard to approve/reject pending autonomous tasks.
   */
  router.post('/update-task-status', async (c) => {
    try {
      const body = await c.req.json();
      const { id, status } = body;

      if (!id || !status || !['approved', 'rejected'].includes(status)) {
        return c.json({ success: false, error: 'id and status (approved|rejected) required' }, 400);
      }

      const db = get_database();
      const result = await db.collection('episodic_events').updateOne(
        { id: id },
        { $set: { 'metadata.status': status, 'metadata.task_status': status, 'metadata.reviewed_at': new Date() } }
      );

      if (result.matchedCount === 0) {
        return c.json({ success: false, error: 'Task not found' }, 404);
      }

      return c.json({
        success: true,
        message: `Task ${status}`,
        status: status,
      });
    } catch (error: any) {
      console.error('Error updating task status:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });


  /**
   * Get background processor status
   */
  router.get('/background/status', async (c) => {
    try {
      const stats = await backgroundProcessor.getProcessingStats();
      
      return c.json({
        success: true,
        stats: stats
      });
      
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 500);
    }
  });

  /**
   * Test extraction pipeline on a simple message
   */
  router.post('/test-extraction', async (c) => {
    try {
      const body = await c.req.json();
      const { message = "I love driving my 1961 Jaguar E-Type" } = body;
      
      console.log('🧪 Testing extraction pipeline with message:', message);
      
      // Import extraction service
      const { extraction_service } = await import('../services/processing/extraction-service.js');
      
      // Test extraction with proper context
      const extractionContext = {
        session_id: 'test-session',
        user_id: 'test-user',
        timestamp: new Date(),
        extraction_focus: 'test_extraction'
      };
      
      const extractionResult = await extraction_service.extractStructuredData(
        message,
        extractionContext
      );
      
      console.log('🧪 Extraction result:', extractionResult);
      
      return c.json({
        success: true,
        input: message,
        extraction_result: extractionResult,
        semantic_facts_count: extractionResult?.semantic_facts?.length || 0
      });
      
    } catch (error: any) {
      console.error('❌ Extraction test failed:', error);
      return c.json({
        success: false,
        error: error.message,
        stack: error.stack
      }, 500);
    }
  });

  // Episodic Events Duplication Management Endpoints

  /**
   * Get episodic events duplication statistics
   * GET /api/admin/episodic-events/duplication-stats
   */
  router.get('/episodic-events/duplication-stats', async (c) => {
    try {
      const episodicManager = getEpisodicEventManager();
      const duplicationStats = await episodicManager.getDuplicationStats();

      return c.json({
        success: true,
        data: duplicationStats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error getting duplication stats:', error);
      return c.json({ success: false, error: get_error_message(error) }, 500);
    }
  });

  /**
   * Analyze episodic events duplicates (dry run)
   * GET /api/admin/episodic-events/analyze-duplicates
   */
  router.get('/episodic-events/analyze-duplicates', async (c) => {
    try {
      const episodicManager = getEpisodicEventManager();

      console.log('🔍 Analyzing episodic events duplicates...');
      const analysisResults = await episodicManager.identifyAndCleanupDuplicates(true); // Dry run

      return c.json({
        success: true,
        data: {
          analysis: analysisResults,
          message: 'Dry run analysis completed - no data was modified'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error analyzing duplicates:', error);
      return c.json({ success: false, error: get_error_message(error) }, 500);
    }
  });

  /**
   * Execute episodic events duplicate cleanup
   * POST /api/admin/episodic-events/cleanup-duplicates
   */
  router.post('/episodic-events/cleanup-duplicates', async (c) => {
    try {
      const body = await c.req.json();
      const { confirm } = body;

      if (!confirm) {
        return c.json({
          success: false,
          error: 'Cleanup requires explicit confirmation. Set confirm: true in request body.'
        }, 400);
      }

      const episodicManager = getEpisodicEventManager();

      console.log('🧹 Executing episodic events duplicate cleanup...');
      const cleanupResults = await episodicManager.identifyAndCleanupDuplicates(false); // Execute cleanup

      return c.json({
        success: true,
        data: {
          cleanup: cleanupResults,
          message: 'Duplicate cleanup completed successfully'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error executing cleanup:', error);
      return c.json({ success: false, error: get_error_message(error) }, 500);
    }
  });

  /**
   * Get episodic event manager statistics
   * GET /api/admin/episodic-events/stats
   */
  router.get('/episodic-events/stats', async (c) => {
    try {
      const episodicManager = getEpisodicEventManager();
      const eventStats = await episodicManager.getEventStats();

      return c.json({
        success: true,
        data: eventStats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error getting event stats:', error);
      return c.json({ success: false, error: get_error_message(error) }, 500);
    }
  });

  // Background processor control endpoints
  router.post('/enable-background-processor', async (c) => {
    try {
      backgroundProcessor.start(300000);
      return c.json({
        success: true,
        message: 'Background processor fallback enabled (primary processing is event-driven)',
        interval: '5 minutes',
        note: 'Event-driven processing handles immediate processing on user/system events'
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/disable-background-processor', async (c) => {
    try {
      backgroundProcessor.stop();
      return c.json({
        success: true,
        message: 'Background processor disabled'
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/process-unprocessed-events', async (c) => {
    try {
      const results = await backgroundProcessor.forceProcessAll();
      return c.json({
        success: true,
        message: 'Forced processing completed',
        results: results
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.get('/background-processor-status', async (c) => {
    try {
      const stats = await backgroundProcessor.getProcessingStats();
      return c.json({
        success: true,
        stats: stats
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  /**
   * Trigger batch entity resolution for a user.
   * POST /api/admin/resolve-entities
   */
  router.post('/resolve-entities', async (c) => {
    try {
      const body = await c.req.json();
      const userId = DEFAULT_USER_ID;
      const result = await entityResolver.batchResolveEntities(userId);

      return c.json({
        success: true,
        message: `Batch entity resolution completed for ${userId}`,
        result
      });
    } catch (error) {
      console.error('❌ Batch entity resolution failed:', error);
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.get('/event-stats', async (c) => {
    try {
      const eventManager = getEpisodicEventManager();
      const stats = await eventManager.getEventStats();
      return c.json({
        success: true,
        stats: stats
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/rebuild-indexes', async (c) => {
    try {
      const db = get_database();
      const indexManager = new IndexManager(db);
      const result = await indexManager.cleanupAndRecreateIndexes();
      return c.json({
        success: true,
        message: 'Index rebuild completed',
        result: result
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.get('/index-stats', async (c) => {
    try {
      const db = get_database();
      const indexManager = new IndexManager(db);
      const stats = await indexManager.getIndexStats();
      return c.json({
        success: true,
        stats: stats
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/cleanup-unhelpful-responses', async (c) => {
    try {
      const db = get_database();
      
      const unhelpfulPatterns = [
        'What specific aspects would you like to explore',
        'I\'d be happy to discuss this with you',
        'tell me more about what you',
        'Could you tell me more',
        'provide more details',
        'anything specific about this you\'d like to explore further'
      ];
      
      const escapedPatterns = unhelpfulPatterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const regexPattern = new RegExp(escapedPatterns.join('|'), 'i');
      
      const unhelpfulResponses = await db.collection('episodic_events').find({
        'content.role': 'assistant',
        'content.message': regexPattern
      }).toArray();
      
      console.log(`Found ${unhelpfulResponses.length} unhelpful assistant responses`);
      
      const deleteResult = await db.collection('episodic_events').deleteMany({
        'content.role': 'assistant',
        'content.message': regexPattern
      });
      
      return c.json({
        success: true,
        message: 'Cleaned up unhelpful responses',
        found: unhelpfulResponses.length,
        deleted: deleteResult.deletedCount,
        patterns_used: unhelpfulPatterns
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/test-conversation', async (c) => {
    return c.json({
      success: false,
      error: 'Conversation service not available in Katra. Use the MCP tools or REST API for memory operations.'
    }, 501);
  });

  /**
   * POST /api/v1/admin/trigger-reflection
   * Manually trigger a sleep consolidation run.
   */
  router.post('/trigger-reflection', async (c) => {
    try {
      const body = await c.req.json();
      const { period_type, user_id } = body;
      const service = SleepConsolidationService.get_instance();
      const result = await service.consolidate(period_type || 'daily', user_id);
      return c.json({ success: result.success, result });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  // ── System Identity ────────────────────────────────

  /**
   * GET /api/v1/admin/system-identity — Get system identity (user_id, hostname)
   */
  router.get('/system-identity', async (c) => {
    try {
      const os = await import('os');
      const hostname = os.hostname();
      const userId = process.env.KATRA_USER_ID || hostname + '-agent';
      return c.json({
        success: true,
        identity: {
          user_id: userId,
          hostname: hostname,
          watcher_configured: true,
        }
      });
    } catch (error) {
      return c.json({ success: false, error: 'Could not determine identity' }, 500);
    }
  });

  // ── Memory Scope Configuration ────────────────────────────

  /**
   * GET /api/admin/memory-scope — Get current memory scope settings
   */
  router.get('/memory-scope', async (c) => {
    try {
      const scope = await getMemoryScope();
      return c.json({
        success: true,
        scope: {
          mode: scope.mode,
          shared_id: scope.shared_id,
          hybrid_visible_user_ids: scope.hybrid_visible_user_ids,
        },
        description: {
          personal: 'Memories isolated by user_id (default)',
          shared: 'Communal memory via shared_id',
          hybrid: 'Personal + shared + other visible user_ids',
        }
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  /**
   * PUT /api/admin/memory-scope — Update memory scope settings
   */
  router.put('/memory-scope', async (c) => {
    try {
      const body = await c.req.json();
      const { mode, shared_id, hybrid_visible_user_ids } = body;

      if (!mode || !['personal', 'shared', 'hybrid'].includes(mode)) {
        return c.json({
          success: false,
          error: 'mode must be one of: personal, shared, hybrid'
        }, 400);
      }

      if ((mode === 'shared' || mode === 'hybrid') && !shared_id) {
        const current = await getMemoryScope();
        if (!current.shared_id) {
          return c.json({
            success: false,
            error: 'shared_id is required when mode is "shared" or "hybrid"'
          }, 400);
        }
      }

      const db = get_database();
      const updateDoc: Record<string, unknown> = {
        key: 'memory_scope',
        mode,
        updated_at: new Date(),
      };

      if (shared_id !== undefined) updateDoc.shared_id = shared_id;
      if (hybrid_visible_user_ids !== undefined) updateDoc.hybrid_visible_user_ids = hybrid_visible_user_ids;

      await db.collection('system_settings').updateOne(
        { key: 'memory_scope' },
        { $set: updateDoc },
        { upsert: true }
      );

      invalidateScopeCache();

      const scope = await getMemoryScope();

      return c.json({
        success: true,
        message: `Memory scope set to: ${mode}`,
        scope: {
          mode: scope.mode,
          shared_id: scope.shared_id,
          hybrid_visible_user_ids: scope.hybrid_visible_user_ids,
        }
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  // ── LLM Configuration ──────────────────────────────────────

  /**
   * GET /api/v1/admin/llm-config — Get current LLM configuration
   * Returns config with API key masked.
   */
  router.get('/llm-config', async (c) => {
    try {
      const dbConfig = await get_llm_config_from_db();
      const status = llmService.getServiceStatus();

      if (dbConfig) {
        return c.json({
          success: true,
          configured: true,
          source: 'database',
          config: {
            provider: dbConfig.provider,
            base_url: dbConfig.base_url,
            model: dbConfig.model,
            api_key: dbConfig.api_key ? '••••••••' : '',
          },
          status,
        });
      }

      // Fall back to env vars
      const envProvider =
        process.env.DEEPSEEK_API_KEY ? 'deepseek' :
        process.env.OPENAI_API_KEY ? 'openai' :
        process.env.MOONSHOT_API_KEY ? 'moonshot' : 'none';

      return c.json({
        success: true,
        configured: envProvider !== 'none',
        source: envProvider !== 'none' ? 'env' : 'none',
        config: {
          provider: envProvider,
          base_url: '',
          model: '',
          api_key: envProvider !== 'none' ? '••••••••' : '',
        },
        status,
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  });

  /**
   * PUT /api/v1/admin/llm-config — Update LLM configuration
   * Saves to MongoDB system_settings and reconfigures the LLM service live.
   */
  router.put('/llm-config', async (c) => {
    try {
      const body = await c.req.json();
      const { provider, api_key, base_url, model } = body;

      if (!provider) {
        return c.json({ success: false, error: 'provider is required (deepseek, openai, moonshot, ollama, custom)' }, 400);
      }

      // Apply defaults for known providers
      const defaults: Record<string, { base_url: string; model: string }> = {
        deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
        openai:   { base_url: 'https://api.openai.com/v1',   model: 'gpt-4o' },
        moonshot: { base_url: 'https://api.moonshot.cn/v1',   model: 'moonshot-v1-8k' },
        ollama:   { base_url: 'http://host.docker.internal:11434/v1', model: 'llama3.2' },
      };

      const cfg: LLMConfig = {
        provider,
        api_key: api_key || '',
        base_url: base_url || defaults[provider]?.base_url || '',
        model: model || defaults[provider]?.model || '',
      };

      // For ollama, api_key is not required
      if (provider !== 'ollama' && !cfg.api_key) {
        return c.json({ success: false, error: 'api_key is required for this provider' }, 400);
      }

      if (!cfg.base_url || !cfg.model) {
        return c.json({ success: false, error: 'base_url and model are required' }, 400);
      }

      // Save to DB
      await save_llm_config_to_db(cfg);

      // Apply live (replaces all providers)
      const applied = llmService.apply_config(cfg);

      return c.json({
        success: applied,
        message: applied
          ? `LLM configured: ${cfg.provider} (${cfg.model}) — validating...`
          : 'Failed to apply LLM config',
        config: {
          provider: cfg.provider,
          base_url: cfg.base_url,
          model: cfg.model,
          api_key: '••••••••',
        },
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  });

  /**
   * POST /api/v1/admin/llm-config/test — Test LLM connection
   */
  router.post('/llm-config/test', async (c) => {
    try {
      const result = await llmService.testService();
      return c.json({ ...result, success: result.success });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  });

  /**
   * LLM cache performance monitoring.
   * Tracks prompt cache hit/miss rates and token savings across extraction calls.
   * GET /cache-stats  — current stats since last reset
   * DELETE /cache-stats — reset counters
   */
  router.get('/cache-stats', async (c) => {
    const stats = llmService.cacheStats;
    const hitRate = stats.totalCalls > 0
      ? ((stats.cacheHits / stats.totalCalls) * 100).toFixed(1)
      : '0.0';
    const averageSavings = stats.cachedTokens > 0 && (stats.cachedTokens + stats.totalTokens - stats.cachedTokens) > 0
      ? ((stats.cachedTokens / stats.totalTokens) * 100).toFixed(1)
      : '0.0';

    return c.json({
      success: true,
      since: stats.lastReset,
      total_calls: stats.totalCalls,
      cache_hits: stats.cacheHits,
      cache_misses: stats.cacheMisses,
      hit_rate_percent: `${hitRate}%`,
      cached_tokens: stats.cachedTokens,
      total_prompt_tokens: stats.totalTokens,
      token_savings_percent: `${averageSavings}%`,
      interpretation: stats.totalCalls > 0
        ? `System prompt caching saves ~${averageSavings}% of prompt tokens when working`
        : 'No extraction calls recorded since last reset',
    });
  });

  router.delete('/cache-stats', async (c) => {
    llmService.resetCacheStats();
    return c.json({ success: true, message: 'Cache stats reset' });
  });

  // ── Agent Pub-Sub Bus ────────────────────────────────

  /**
   * GET /api/v1/admin/pubsub/presence
   * Returns the presence board — all agents registered on the pub-sub bus,
   * their interests, capabilities, and last seen timestamps.
   * Read-only, no auth required.
   */
  router.get('/pubsub/presence', async (c) => {
    try {
      const redis = await get_redis_client();
      if (!redis) {
        return c.json({ success: false, error: 'Redis not available' }, 503);
      }

      const raw = await redis.hGetAll('katra:presence');
      const agents: Record<string, any> = {};
      for (const [agent_id, json] of Object.entries(raw)) {
        try {
          agents[agent_id] = JSON.parse(json);
        } catch {
          agents[agent_id] = { agent_id, error: 'invalid json' };
        }
      }

      // Also grab active pub-sub channels for context
      const channels = await redis.pubSubChannels();
      const topic_channels = channels.filter((ch: string) => ch.startsWith('katra:topics:'));

      return c.json({
        success: true,
        agents,
        agent_count: Object.keys(agents).length,
        active_topics: topic_channels.length,
      });
    } catch (error: any) {
      console.error('Pub-sub presence error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/admin/pubsub/topics
   * Returns active topic channels with subscriber counts and
   * recent message counts where available.
   * Read-only, no auth required.
   */
  router.get('/pubsub/topics', async (c) => {
    try {
      const redis = await get_redis_client();
      if (!redis) {
        return c.json({ success: false, error: 'Redis not available' }, 503);
      }

      const channels = await redis.pubSubChannels();
      const topic_channels = channels.filter((ch: string) => ch.startsWith('katra:topics:'));

      // Get subscriber counts for each topic channel
      const topics: Array<{ channel: string; topic: string; subscribers: number }> = [];
      for (const ch of topic_channels) {
        const subs = await redis.pubSubNumSub(ch);
        // subs is [channel, count] or an object depending on Redis client version
        const count = Array.isArray(subs) ? (subs[1] || 0) : (typeof subs === 'object' ? (subs as any)[ch] || 0 : 0);
        const topic = ch.replace('katra:topics:', '');
        topics.push({ channel: ch, topic, subscribers: count });
      }

      return c.json({
        success: true,
        topics,
        total_active_topics: topics.length,
        total_subscriptions: topics.reduce((sum, t) => sum + t.subscribers, 0),
      });
    } catch (error: any) {
      console.error('Pub-sub topics error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * POST /api/v1/admin/pubsub/mute
   * Mute/unmute an agent on the bus by removing/restoring their presence entry.
   * Requires admin auth. Body: { agent_id: string, muted: boolean }
   */
  router.post('/pubsub/mute', async (c) => {
    try {
      const body = await c.req.json();
      const { agent_id, muted } = body;

      if (!agent_id) {
        return c.json({ success: false, error: 'agent_id is required' }, 400);
      }

      // Store muted agents in a Redis set
      const redis = await get_redis_client();
      if (!redis) {
        return c.json({ success: false, error: 'Redis not available' }, 503);
      }

      if (muted) {
        await redis.sAdd('katra:pubsub:muted', agent_id);
        // Remove from presence
        await redis.hDel('katra:presence', agent_id);
        return c.json({ success: true, message: `${agent_id} muted and removed from bus` });
      } else {
        await redis.sRem('katra:pubsub:muted', agent_id);
        return c.json({ success: true, message: `${agent_id} unmuted — agent must re-register to rejoin` });
      }
    } catch (error: any) {
      console.error('Pub-sub mute error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/admin/pubsub/muted
   * Returns list of currently muted agents.
   */
  router.get('/pubsub/muted', async (c) => {
    try {
      const redis = await get_redis_client();
      if (!redis) {
        return c.json({ success: false, error: 'Redis not available' }, 503);
      }
      const muted = await redis.sMembers('katra:pubsub:muted');
      return c.json({ success: true, muted });
    } catch (error: any) {
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  // ── Personality (memory-weighted retrieval disposition) ────────────

  /**
   * GET /api/v1/admin/personality/profiles
   * Returns the built-in personality profile registry (read-only reference)
   * so the dashboard can populate the selector and pre-fill the weight grid.
   * Static catalogue — it stays on the no-auth read-only list (naming no
   * identity, and reading no data): only the two /personality endpoints that
   * resolve a caller's record are caller-pinned.
   */
  router.get('/personality/profiles', async (c) => {
    return c.json({
      success: true,
      profiles: PROFILES,
      sources: ALL_SOURCES,
      agent_message_weight: AGENT_MESSAGE_WEIGHT,
      recommended_budgets: RECOMMENDED_BUDGETS,
    });
  });

  /**
   * GET /api/v1/admin/personality
   * The caller's resolved memory personality (persisted selection + overrides),
   * or the default 'balanced' when nothing has been saved.
   *
   * ITER-2: caller-pinned — `?user_id=<another id>` is admin-gated by the
   * router (see the auth gate above). ITER-3: `?user_id=<the caller's own id>`
   * is equivalent to omitting the parameter, so a client (the Kolega bridge)
   * may always name itself. With PER_IDENTITY_PERSONALITY off, resolution
   * skips the identity record and serves the legacy global record, i.e.
   * today's behaviour.
   */
  router.get('/personality', async (c) => {
    try {
      const db = get_database();
      const requestedUserId = (c.req.query('user_id') ?? '').trim();
      const resolvedFor = requestedUserId || getCaller().user_id;
      const resolved = await resolvePersonalityConfig(db, resolvedFor);
      // ITER-11 (§6.2) TELEMETRY — the migration's own counter. With
      // PER_IDENTITY_PERSONALITY on, a request that named no identity of its own
      // is the legacy no-`user_id` path, and one that resolved from the legacy
      // global record is a consumer still reading that key. Both are recorded
      // (bounded counters, TTL'd) and never break the read.
      if (perIdentityPersonalityEnabled()) {
        if (requestedUserId === '') {
          await notePersonalityDeprecation(db, { userId: resolvedFor, kind: 'no_user_id_path' });
        }
        if (resolved.origin === 'legacy') {
          await notePersonalityDeprecation(db, { userId: resolvedFor, kind: 'legacy_read' });
        }
      }
      const resolvedBase = PROFILES[resolved.profile] || PROFILES['balanced'];
      return c.json({
        success: true,
        config: {
          personality: resolved.profile,
          source_weights: resolved.source_weights,
          scoring: resolved.scoring,
          max_context_tokens:
            resolved.max_context_tokens ?? (RECOMMENDED_BUDGETS[resolved.profile] || 5000),
          updated_at: resolved.updated_at,
        },
        // Echo the resolved base profile so the UI can show effective weights.
        base_profile: resolvedBase,
        resolved_for: resolved.user_id,
        origin: resolved.origin,
        version: resolved.version,
        per_identity_enabled: perIdentityPersonalityEnabled(),
      });
    } catch (error: any) {
      console.error('Personality get error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * PUT /api/v1/admin/personality
   * Persist the personality selection + optional overrides for the CALLER's
   * identity (`?user_id=<another id>` is admin-gated by the router;
   * `?user_id=<the caller's own id>` is equivalent to omitting it). Body:
   *   { personality: string, source_weights?: {}, scoring?: {}, max_context_tokens?: number }
   * The agent_message weight is force-pinned to 10.0 (cannot be overridden).
   * With PER_IDENTITY_PERSONALITY off the write targets the legacy global
   * record, exactly as before.
   */
  router.put('/personality', async (c) => {
    try {
      const body = await c.req.json();
      const sanitized = sanitizePersonalityPatch(body);
      if (!sanitized.ok) {
        return c.json({ success: false, error: sanitized.error }, 400);
      }
      const { patch } = sanitized;

      const requestedUserId = (c.req.query('user_id') ?? '').trim();
      const caller = getCaller();
      const targetUserId = requestedUserId || caller.user_id;
      const db = get_database();
      const resolved = await updatePersonalityConfig(db, targetUserId, patch, caller);

      // ITER-11 (§6.2) TELEMETRY: with the flag on, a write must land on the
      // identity record. If it ever resolved back to the LEGACY record, that is
      // exactly the consumer the migration is meant to retire — counted, and
      // never a reason to fail the write.
      if (perIdentityPersonalityEnabled() && resolved.origin === 'legacy') {
        await notePersonalityDeprecation(db, { userId: targetUserId, kind: 'legacy_write' });
      }

      return c.json({
        success: true,
        message: `Personality set to '${patch.personality}'`,
        config: {
          personality: patch.personality,
          source_weights: patch.source_weights,
          scoring: patch.scoring,
          max_context_tokens:
            patch.max_context_tokens ?? (RECOMMENDED_BUDGETS[patch.personality] || 5000),
        },
        resolved_for: resolved.user_id,
        origin: resolved.origin,
        version: resolved.version,
      });
    } catch (error: any) {
      if (error instanceof PersonalityAccessError) {
        console.warn(`Personality put rejected: ${error.message}`);
        return c.json({ success: false, error: error.message }, 403);
      }
      if (error instanceof PersonalityWriteConflictError) {
        // Contention, not a bad request: every guarded attempt lost the race,
        // so nothing was stored and the caller may safely retry.
        console.warn(`Personality put conflicted: ${error.message}`);
        return c.json({ success: false, error: error.message, retry: true }, 409);
      }
      console.error('Personality put error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * GET /api/v1/admin/identity
   * The name the memory holds for its own inhabitant. Read-only, no auth
   * required — the dashboard reads it on load to title the page.
   */
  router.get('/identity', async (c) => {
    try {
      // F3: ?user_id=<id> reads that user's identity record. The route is on
      // the no-auth read-only list for the caller's own identity, so the
      // per-user lookup enforces the admin key itself.
      const requestedUserId = c.req.query('user_id')?.trim();
      if (requestedUserId) {
        if (!hasAdminKey(c)) {
          console.warn(`Identity per-user lookup rejected (no admin key): user_id=${requestedUserId}`);
          return c.json({ error: 'Unauthorized', message: 'Admin API key required for ?user_id=' }, 401);
        }
        const identity = await getAgentIdentity(requestedUserId);
        return c.json({ success: true, identity: { ...identity, user_id: requestedUserId } });
      }

      // F2: identity is resolved per CALLER (getCaller()) instead of a
      // process-wide default — each machine's wake ritual reads the record
      // for its own user_id.
      const callerUserId = getCaller().user_id;
      const identity = await getAgentIdentity(callerUserId);
      return c.json({ success: true, identity: { ...identity, user_id: callerUserId } });
    } catch (error: any) {
      console.error('Identity get error:', error.message);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  });

  /**
   * PUT /api/v1/admin/identity
   * Set the agent identity name. Requires admin auth.
   * Body: { name: string, chosen_by?: string, confirmed_by?: string,
   *         rationale?: string, established?: string }
   * F3: pass ?user_id=<id> (or body.user_id) to write that user's per-user
   * record (agent_identity:<user_id>) instead of the legacy katra record.
   */
  router.put('/identity', async (c) => {
    try {
      // F3: identity writes are admin-gated. The route path is on the
      // no-auth read-only list (GET /identity must stay open for the wake
      // rituals), so enforce the admin key here instead of the middleware.
      if (!hasAdminKey(c)) {
        console.warn(`Identity put rejected (no admin key): ${c.req.method} ${c.req.path}`);
        return c.json({ error: 'Unauthorized', message: 'Admin API key required' }, 401);
      }

      const body = await c.req.json().catch(() => ({}));
      const name = String(body?.name || '').trim();
      if (!name || name.length > 80) {
        return c.json({ success: false, error: 'name required (max 80 chars)' }, 400);
      }
      const targetUserId = String(c.req.query('user_id') || body?.user_id || '').trim();
      const record = {
        name,
        chosen_by: String(body?.chosen_by || 'dashboard'),
        confirmed_by: body?.confirmed_by ? String(body.confirmed_by) : undefined,
        rationale: body?.rationale ? String(body.rationale) : undefined,
        established: body?.established || new Date().toISOString().slice(0, 10),
      };
      const identity = targetUserId
        ? await setAgentIdentity(targetUserId, record)
        : await setAgentIdentity(record);
      return c.json({
        success: true,
        identity: targetUserId ? { ...identity, user_id: targetUserId } : identity,
      });
    } catch (error: any) {
      console.error('Identity put error:', error.message);
      return c.json({ success: false, error: error.message || 'Internal server error' }, 500);
    }
  });

  return router;
};