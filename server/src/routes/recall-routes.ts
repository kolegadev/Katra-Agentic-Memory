import { Hono } from 'hono';
import { queryOrchestrationService } from '../services/query-orchestration-service.js';
import { contextSynthesisService } from '../services/context-synthesis-service.js';
import { escape_regex } from '../utils/regex-escape.js';
import { z } from 'zod';

// Request validation schemas
const RecallRequestSchema = z.object({
  informationNeed: z.string().min(1, 'Information need is required'),
  context: z.record(z.any()).optional(),
  template: z.string().optional(),
  maxTokens: z.number().positive().optional(),
  includeMetadata: z.boolean().optional(),
  relevanceThreshold: z.number().min(0).max(1).optional()
});

const SessionRecallSchema = z.object({
  timeRange: z.object({
    start: z.string().optional(),
    end: z.string().optional()
  }).optional(),
  eventTypes: z.array(z.string()).optional(),
  template: z.string().optional(),
  maxTokens: z.number().positive().optional()
});

const EntityRecallSchema = z.object({
  maxDepth: z.number().positive().max(5).optional(),
  relationshipTypes: z.array(z.string()).optional(),
  template: z.string().optional(),
  includeMetadata: z.boolean().optional()
});

const SearchRecallSchema = z.object({
  query: z.string().min(1, 'Search query is required'),
  searchTypes: z.array(z.enum(['episodic', 'semantic', 'knowledge_graph', 'asset'])).optional(),
  limit: z.number().positive().max(100).optional(),
  template: z.string().optional(),
  userId: z.string().optional(),
  user_id: z.string().optional()
});

const TimelineRecallSchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  eventTypes: z.array(z.string()).optional(),
  limit: z.number().positive().max(200).optional()
});

export const create_recall_routes = (): Hono => {
  const app = new Hono();

  /**
   * Enhanced recall endpoint specifically for "remember" queries
   * POST /api/memory/recall/remember
   */
  app.post('/remember', async (c) => {
    try {
      const body = await c.req.json();
      const { query, sessionId, userId = 'demo-user' } = body;
      
      if (!query || typeof query !== 'string') {
        return c.json({
          success: false,
          error: 'Query is required and must be a string'
        }, 400);
      }

      console.log(`🧠 Enhanced recall for "remember" query: ${query.substring(0, 50)}...`);

      // Step 1: Detect if this is a memory recall request
      const isMemoryQuery = detectMemoryIntent(query);
      const enhancedMode = isMemoryQuery;

      // Step 2: Build comprehensive query plan with enhanced parameters
      const context = {
        sessionId: sessionId || null,
        userId,
        isMemoryQuery: enhancedMode,
        queryType: 'comprehensive_recall'
      };

      const queryPlan = await queryOrchestrationService.buildQueryPlan(query, context);
      
      // Step 3: Execute with enhanced search parameters for memory queries
      let queryResults = await queryOrchestrationService.executeCoordinatedQueries(queryPlan);

      // Step 4: If it's a memory query, also search across all user's sessions
      let crossSessionCount = 0;
      if (enhancedMode && userId) {
        const crossSessionResults = await searchAcrossAllSessions(query, userId);
        crossSessionCount = crossSessionResults.crossSessionCount || 0;
        // Merge results (simplified)
        if (queryResults.aggregatedData) {
          queryResults.aggregatedData.episodic = [
            ...(queryResults.aggregatedData.episodic || []),
            ...(crossSessionResults.episodic || [])
          ];
          queryResults.aggregatedData.semantic = [
            ...(queryResults.aggregatedData.semantic || []),
            ...(crossSessionResults.semantic || [])
          ];
        }
      }

      // Step 5: Apply memory-specific filtering and ranking
      if (enhancedMode && queryResults.aggregatedData) {
        queryResults.aggregatedData = applyMemoryQueryFiltering(queryResults.aggregatedData, query);
      }

      // Step 6: Synthesize with memory-optimized template
      const template = enhancedMode ? 'knowledge' : 'default';
      const synthesizedContext = await contextSynthesisService.synthesizeContext(
        queryResults,
        template,
        { 
          maxTokens: 1000, 
          includeMetadata: true
        }
      );

      return c.json({
        success: true,
        data: {
          isMemoryQuery: enhancedMode,
          context: synthesizedContext,
          sources: {
            episodic: queryResults.aggregatedData?.episodic?.length || 0,
            semantic: queryResults.aggregatedData?.semantic?.length || 0,
            knowledge: queryResults.aggregatedData?.knowledge_graph?.length || 0,
            crossSession: crossSessionCount
          },
          performance: {
            totalExecutionTime: (queryResults.synthesis?.totalExecutionTime || 0) + (synthesizedContext.metadata?.synthesisTime || 0),
            relevanceScore: synthesizedContext.metadata?.relevanceScore || 0,
            confidenceScore: synthesizedContext.metadata?.confidenceScore || 0
          }
        }
      });

    } catch (error) {
      console.error('Enhanced memory recall failed:', error);
      return c.json({
        success: false,
        error: 'Failed to process memory recall request',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  /**
   * Main recall endpoint - orchestrates multi-modal memory retrieval
   * POST /api/memory/recall
   */
  app.post('/', async (c) => {
    try {
      const body = await c.req.json();
      const validation = RecallRequestSchema.safeParse(body);
      
      if (!validation.success) {
        return c.json({
          success: false,
          error: 'Validation failed',
          details: validation.error.errors
        }, 400);
      }

      const { informationNeed, context = {}, template = 'default', maxTokens, includeMetadata = true, relevanceThreshold } = validation.data;

      // Step 1: Build query plan
      const queryPlan = await queryOrchestrationService.buildQueryPlan(informationNeed, context);

      // Step 2: Execute coordinated queries
      let queryResults = await queryOrchestrationService.executeCoordinatedQueries(queryPlan);

      // Step 3: Apply relevance filtering if specified
      if (relevanceThreshold) {
        queryResults = contextSynthesisService.filterByRelevance(queryResults, relevanceThreshold);
      }

      // Step 4: Synthesize context
      let synthesizedContext = await contextSynthesisService.synthesizeContext(
        queryResults,
        template,
        { maxTokens, includeMetadata }
      );

      // Step 5: Apply compression if needed
      if (maxTokens && contextSynthesisService['estimateTokenCount'](synthesizedContext.content) > maxTokens) {
        synthesizedContext = contextSynthesisService.compressContext(synthesizedContext, maxTokens);
      }

      return c.json({
        success: true,
        data: {
          queryPlan: {
            id: queryPlan.id,
            priority: queryPlan.priority,
            estimatedCost: queryPlan.estimatedCost,
            queryCount: queryPlan.queries.length
          },
          context: synthesizedContext,
          performance: {
            totalExecutionTime: queryResults.synthesis.totalExecutionTime + synthesizedContext.metadata.synthesisTime,
            relevanceScore: synthesizedContext.metadata.relevanceScore,
            confidenceScore: synthesizedContext.metadata.confidenceScore,
            compressionRatio: synthesizedContext.metadata.compressionRatio
          }
        }
      });

    } catch (error) {
      console.error('Recall orchestration failed:', error);
      return c.json({
        success: false,
        error: 'Failed to process recall request',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  /**
   * Session-specific recall - retrieves context for a specific session
   * GET /api/memory/recall/session/:sessionId
   */
  app.get('/session/:sessionId', async (c) => {
    try {
      const sessionId = c.req.param('sessionId');
      const queryParams = c.req.query();
      
      const validation = SessionRecallSchema.safeParse({
        timeRange: queryParams.timeRange ? JSON.parse(queryParams.timeRange) : undefined,
        eventTypes: queryParams.eventTypes ? queryParams.eventTypes.split(',') : undefined,
        template: queryParams.template || 'session',
        maxTokens: queryParams.maxTokens ? parseInt(queryParams.maxTokens) : undefined
      });

      if (!validation.success) {
        return c.json({
          success: false,
          error: 'Invalid query parameters',
          details: validation.error.errors
        }, 400);
      }

      const { timeRange, eventTypes, template, maxTokens } = validation.data;

      // Build session-focused context
      const context = {
        sessionId,
        timeRange,
        eventTypes
      };

      const informationNeed = `Retrieve all context and history for session ${sessionId}`;

      // Use main recall orchestration
      const queryPlan = await queryOrchestrationService.buildQueryPlan(informationNeed, context);
      const queryResults = await queryOrchestrationService.executeCoordinatedQueries(queryPlan);
      
      let synthesizedContext = await contextSynthesisService.synthesizeContext(
        queryResults,
        template,
        { maxTokens, includeMetadata: true }
      );

      if (maxTokens) {
        synthesizedContext = contextSynthesisService.compressContext(synthesizedContext, maxTokens);
      }

      return c.json({
        success: true,
        data: {
          sessionId,
          context: synthesizedContext,
          performance: {
            totalExecutionTime: queryResults.synthesis.totalExecutionTime + synthesizedContext.metadata.synthesisTime,
            eventCount: queryResults.aggregatedData.episodic?.length || 0,
            entityCount: queryResults.aggregatedData.knowledge_graph?.length || 0
          }
        }
      });

    } catch (error) {
      console.error('Session recall failed:', error);
      return c.json({
        success: false,
        error: 'Failed to retrieve session context',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  /**
   * Entity-focused recall - retrieves relationships and context for a specific entity
   * GET /api/memory/recall/entity/:nodeId
   */
  app.get('/entity/:nodeId', async (c) => {
    try {
      const nodeId = c.req.param('nodeId');
      const queryParams = c.req.query();
      
      const validation = EntityRecallSchema.safeParse({
        maxDepth: queryParams.maxDepth ? parseInt(queryParams.maxDepth) : 2,
        relationshipTypes: queryParams.relationshipTypes ? queryParams.relationshipTypes.split(',') : undefined,
        template: queryParams.template || 'knowledge',
        includeMetadata: queryParams.includeMetadata !== 'false'
      });

      if (!validation.success) {
        return c.json({
          success: false,
          error: 'Invalid query parameters',
          details: validation.error.errors
        }, 400);
      }

      const { maxDepth, relationshipTypes, template, includeMetadata } = validation.data;

      // Build entity-focused context
      const context = {
        entityId: nodeId,
        maxDepth,
        relationshipTypes,
        entityType: 'any' // Could be enhanced to detect entity type
      };

      const informationNeed = `Retrieve relationships and context for entity ${nodeId}`;

      const queryPlan = await queryOrchestrationService.buildQueryPlan(informationNeed, context);
      const queryResults = await queryOrchestrationService.executeCoordinatedQueries(queryPlan);
      
      const synthesizedContext = await contextSynthesisService.synthesizeContext(
        queryResults,
        template,
        { includeMetadata }
      );

      return c.json({
        success: true,
        data: {
          entityId: nodeId,
          context: synthesizedContext,
          relationships: queryResults.aggregatedData.knowledge_graph || [],
          performance: {
            totalExecutionTime: queryResults.synthesis.totalExecutionTime + synthesizedContext.metadata.synthesisTime,
            relationshipCount: queryResults.aggregatedData.knowledge_graph?.length || 0
          }
        }
      });

    } catch (error) {
      console.error('Entity recall failed:', error);
      return c.json({
        success: false,
        error: 'Failed to retrieve entity context',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  /**
   * Semantic search across all memory systems
   * POST /api/memory/recall/search
   */
  app.post('/search', async (c) => {
    try {
      const body = await c.req.json();
      const validation = SearchRecallSchema.safeParse(body);
      
      if (!validation.success) {
        return c.json({
          success: false,
          error: 'Validation failed',
          details: validation.error.errors
        }, 400);
      }

      const { query, searchTypes = ['episodic', 'semantic', 'knowledge_graph', 'asset'], limit = 50, template = 'default', userId, user_id } = validation.data;

      // Build search-focused context (userId enables user-scoped semantic search)
      const context = {
        searchTypes,
        limit,
        searchMode: 'semantic',
        userId: userId || user_id
      };

      const informationNeed = `Search for: ${query}`;

      const queryPlan = await queryOrchestrationService.buildQueryPlan(informationNeed, context);
      
      // Filter query plan to only include requested search types
      queryPlan.queries = queryPlan.queries.filter(q => 
        searchTypes.includes(q.type as 'episodic' | 'semantic' | 'knowledge_graph' | 'asset')
      );
      
      const queryResults = await queryOrchestrationService.executeCoordinatedQueries(queryPlan);
      
      const synthesizedContext = await contextSynthesisService.synthesizeContext(
        queryResults,
        template,
        { includeMetadata: true }
      );

      return c.json({
        success: true,
        data: {
          query,
          searchTypes,
          context: synthesizedContext,
          rawResults: queryResults.aggregatedData,
          performance: {
            totalExecutionTime: queryResults.synthesis.totalExecutionTime + synthesizedContext.metadata.synthesisTime,
            totalMatches: Object.values(queryResults.aggregatedData).reduce((sum: number, arr: any[]) => sum + arr.length, 0)
          }
        }
      });

    } catch (error) {
      console.error('Search recall failed:', error);
      return c.json({
        success: false,
        error: 'Failed to execute search',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  /**
   * Timeline recall - retrieves chronological event history
   * GET /api/memory/recall/timeline
   */
  app.get('/timeline', async (c) => {
    try {
      const queryParams = c.req.query();
      
      const validation = TimelineRecallSchema.safeParse({
        userId: queryParams.userId,
        sessionId: queryParams.sessionId,
        startDate: queryParams.startDate,
        endDate: queryParams.endDate,
        eventTypes: queryParams.eventTypes ? queryParams.eventTypes.split(',') : undefined,
        limit: queryParams.limit ? parseInt(queryParams.limit) : 100
      });

      if (!validation.success) {
        return c.json({
          success: false,
          error: 'Invalid query parameters',
          details: validation.error.errors
        }, 400);
      }

      const { userId, sessionId, startDate, endDate, eventTypes, limit } = validation.data;

      // Build timeline-focused context
      const context = {
        userId,
        sessionId,
        timeRange: startDate && endDate ? {
          start: startDate,
          end: endDate
        } : undefined,
        eventTypes,
        limit
      };

      const informationNeed = 'Retrieve chronological timeline of events';

      const queryPlan = await queryOrchestrationService.buildQueryPlan(informationNeed, context);
      
      // Focus on episodic queries for timeline
      queryPlan.queries = queryPlan.queries.filter(q => q.type === 'episodic');
      
      const queryResults = await queryOrchestrationService.executeCoordinatedQueries(queryPlan);
      
      // Sort episodic events by timestamp
      const sortedEvents = (queryResults.aggregatedData.episodic || [])
        .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return c.json({
        success: true,
        data: {
          timeline: sortedEvents,
          filters: {
            userId,
            sessionId,
            startDate,
            endDate,
            eventTypes
          },
          performance: {
            totalExecutionTime: queryResults.synthesis.totalExecutionTime,
            eventCount: sortedEvents.length
          }
        }
      });

    } catch (error) {
      console.error('Timeline recall failed:', error);
      return c.json({
        success: false,
        error: 'Failed to retrieve timeline',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  /**
   * Available templates endpoint
   * GET /api/memory/recall/templates
   */
  app.get('/templates', async (c) => {
    try {
      // Access private templates through a public method
      const availableTemplates = [
        {
          name: 'default',
          description: 'Comprehensive context with all memory types',
          maxTokens: 2000,
          sections: ['Recent Context', 'Relevant Knowledge', 'Related Entities', 'Available Assets', 'Summary']
        },
        {
          name: 'session',
          description: 'Session-focused timeline and knowledge',
          maxTokens: 1500,
          sections: ['Session Timeline', 'Session Knowledge', 'Session Summary']
        },
        {
          name: 'knowledge',
          description: 'Knowledge and entity relationship focused',
          maxTokens: 2500,
          sections: ['Core Knowledge', 'Entity Relationships', 'Historical Context']
        }
      ];

      return c.json({
        success: true,
        data: {
          templates: availableTemplates,
          defaultTemplate: 'default'
        }
      });

    } catch (error) {
      console.error('Failed to retrieve templates:', error);
      return c.json({
        success: false,
        error: 'Failed to retrieve available templates',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  /**
   * Health check for recall system
   * GET /api/memory/recall/health
   */
  app.get('/health', async (c) => {
    try {
      // Test basic functionality
      const testPlan = await queryOrchestrationService.buildQueryPlan('health check', {});
      
      return c.json({
        success: true,
        data: {
          status: 'healthy',
          services: {
            queryOrchestration: 'operational',
            contextSynthesis: 'operational'
          },
          capabilities: {
            templates: 3,
            queryTypes: ['episodic', 'semantic', 'knowledge_graph', 'assets'],
            maxTokens: 2500
          }
        }
      });

    } catch (error) {
      console.error('Recall health check failed:', error);
      return c.json({
        success: false,
        error: 'Recall system health check failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  return app;
};

/**
 * Detect if a query is asking for memory recall
 */
function detectMemoryIntent(query: string): boolean {
  const memoryKeywords = [
    'remember', 'recall', 'what did we', 'what was the', 'do you remember',
    'can you recall', 'we discussed', 'we talked about', 'we decided',
    'what make', 'what model', 'which car', 'what vehicle', 'previously mentioned'
  ];
  
  const lowerQuery = query.toLowerCase();
  return memoryKeywords.some(keyword => lowerQuery.includes(keyword));
}

/**
 * Search across all user sessions for comprehensive recall
 */
async function searchAcrossAllSessions(query: string, userId: string): Promise<any> {
  const { MemoryManager } = await import('../services/memory-manager.js');
  const memoryManager = MemoryManager.get_instance();
  
  try {
    // Search user's episodic events across all sessions
    const userEvents = await memoryManager.get_user_events(userId, 200);
    
    // Filter events that might be relevant to the query
    const relevantEvents = userEvents.filter(event => {
      const content = event.content?.message || '';
      const queryTerms = extractQueryTerms(query);
      return queryTerms.some(term => content.toLowerCase().includes(term.toLowerCase()));
    });
    
    // Search semantic facts for the user
    const semanticFacts = await memoryManager.search_semantic_facts(userId, query, 20);
    
    return {
      episodic: relevantEvents,
      semantic: semanticFacts,
      crossSessionCount: relevantEvents.length
    };
    
  } catch (error) {
    console.error('Cross-session search failed:', error);
    return { episodic: [], semantic: [], crossSessionCount: 0 };
  }
}

/**
 * Extract key terms from query for search
 */
function extractQueryTerms(query: string): string[] {
  // Remove common words and extract meaningful terms
  const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'was', 'are', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may', 'might'];
  
  const terms = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(term => term.length > 2 && !stopWords.includes(term));
    
  return terms;
}

/**
 * Apply memory-specific filtering and ranking
 */
function applyMemoryQueryFiltering(queryResults: any, originalQuery: string): any {
  const queryTerms = extractQueryTerms(originalQuery);
  
  // Rank results by relevance to the specific query
  const rankByRelevance = (items: any[]) => {
    if (!Array.isArray(items)) return [];
    
    return items.map(item => {
      const content = JSON.stringify(item).toLowerCase();
      const relevanceScore = queryTerms.reduce((score, term) => {
        const safeTerm = escape_regex(term);
        const termCount = (content.match(new RegExp(safeTerm, 'g')) || []).length;
        return score + termCount;
      }, 0);
      
      return { ...item, relevanceScore };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);
  };
  
  return {
    episodic: rankByRelevance(queryResults.episodic || []),
    semantic: rankByRelevance(queryResults.semantic || []),
    knowledge_graph: rankByRelevance(queryResults.knowledge_graph || [])
  };
}