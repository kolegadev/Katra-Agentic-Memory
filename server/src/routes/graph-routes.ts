/**
 * Knowledge Graph API Routes
 *
 * Lightweight endpoints for the frontend to interact with the
 * Knowledge Graph compaction pipeline.
 */

import { Hono } from 'hono';
import { getCompactionQueueService, getSemanticMemoryService, getMemorySynthesisService } from '../services/knowledge-graph-factory.js';
import { get_database } from '../database/connection.js';

export function create_knowledge_graph_routes(): Hono {
  const router = new Hono();

  /**
   * POST /activity — Register user activity (typing, interaction).
   * Resets the 4-second idle debounce timer for graph compaction.
   */
  router.post('/activity', async (c) => {
    try {
      const compactionQueue = getCompactionQueueService();
      compactionQueue.registerUserActivity();
      return c.json({ success: true });
    } catch (error) {
      console.error('❌ Activity registration failed:', error);
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to register activity'
      }, 500);
    }
  });

  /**
   * GET /stats — Return graph stats for monitoring / dashboard.
   */
  router.get('/stats', async (c) => {
    try {
      const sms = getSemanticMemoryService();
      const nodes = await sms.getAllNodes();
      const edges = await sms.getTopEdges(50);
      const compactionQueue = getCompactionQueueService();

      return c.json({
        success: true,
        data: {
          node_count: nodes.length,
          edge_count: edges.length,
          queue_depth: compactionQueue.getQueueDepth(),
          is_processing: compactionQueue.getIsProcessing(),
          recent_nodes: nodes.slice(0, 10),
          top_edges: edges.slice(0, 10),
        }
      });
    } catch (error) {
      console.error('❌ Graph stats failed:', error);
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get graph stats'
      }, 500);
    }
  });

  /**
   * GET /context — Get graph context for a query (for manual recall / debugging).
   */
  router.post('/context', async (c) => {
    try {
      const body = await c.req.json();
      const { query } = body;

      if (!query || typeof query !== 'string') {
        return c.json({ success: false, error: 'query is required' }, 400);
      }

      const synthesis = getMemorySynthesisService();
      const keywords = synthesis.extractKeywords(query);
      const context = await synthesis.getGraphContextAsString(keywords);

      return c.json({
        success: true,
        data: {
          keywords,
          context: context || '[No graph context found]',
          has_context: context.length > 0,
        }
      });
    } catch (error) {
      console.error('❌ Graph context failed:', error);
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get graph context'
      }, 500);
    }
  });

  /**
   * POST /explore — Deep multi-hop graph traversal.
   * Walks outward from seed keywords up to `depth` hops (default 2).
   * Returns the expanded subgraph formatted by hop depth.
   */
  router.post('/explore', async (c) => {
    try {
      const body = await c.req.json();
      const { query, depth = 2 } = body;

      if (!query || typeof query !== 'string') {
        return c.json({ success: false, error: 'query is required' }, 400);
      }

      const synthesis = getMemorySynthesisService();
      const keywords = synthesis.extractKeywords(query);
      const result = await synthesis.getDeepGraphContext(keywords, Math.min(depth, 4));

      return c.json({
        success: true,
        data: {
          keywords,
          depth,
          context: result.context || '[No connections found at this depth]',
          hop_summary: result.hop_summary,
          total_edges: result.total_edges,
          total_nodes: result.total_nodes,
        }
      });
    } catch (error) {
      console.error('❌ Deep graph exploration failed:', error);
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to explore graph'
      }, 500);
    }
  });

  /**
   * POST /build-from-facts — Backfill graph nodes/edges from existing semantic facts.
   * Extracts entities and relationships via LLM triplet extraction.
   */
  router.post('/build-from-facts', async (c) => {
    try {
      const db = get_database();
      const sms = getSemanticMemoryService();

      // Read all semantic facts
      const facts = await db.collection('semantic_facts')
        .find({})
        .sort({ created_at: -1, timestamp: -1 })
        .limit(100)
        .toArray();

      if (facts.length === 0) {
        return c.json({ success: false, error: 'No semantic facts found to process' });
      }

      const results = { processed: 0, skipped: 0, errors: 0, triplets_extracted: 0 };

      for (const fact of facts) {
        const content = fact.content || fact.description || fact.fact || '';
        if (!content || content.length < 20) {
          results.skipped++;
          continue;
        }

        try {
          const beforeNodes = await db.collection('memory_nodes').countDocuments();
          await sms.compactEpisodicToGraph(fact._id?.toString() || fact.id || 'backfill', content);
          const afterNodes = await db.collection('memory_nodes').countDocuments();
          results.triplets_extracted += Math.max(0, afterNodes - beforeNodes);
          results.processed++;
        } catch (err) {
          console.warn(`Graph extraction failed for fact ${fact._id}:`, err instanceof Error ? err.message : err);
          results.errors++;
        }
      }

      const nodes = await sms.getAllNodes();
      const edges = await sms.getTopEdges(100);

      return c.json({
        success: true,
        message: `Processed ${results.processed} facts, extracted ${results.triplets_extracted} new nodes`,
        results,
        graph: { node_count: nodes.length, edge_count: edges.length }
      });
    } catch (error) {
      console.error('❌ Graph backfill failed:', error);
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  return router;
}
