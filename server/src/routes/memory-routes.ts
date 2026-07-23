/**
 * Memory System API Routes - Phase 1 Implementation
 * 
 * Comprehensive API endpoints for the advanced memory system with existing service integration.
 * This implementation provides a foundation that can be extended as advanced memory services come online.
 */

import { Hono } from 'hono';
import { working_memory_service } from '../services/memory/working-memory-service.js';
import { learning_feedback_service, AuthorizationError } from '../services/processing/learning-feedback-service.js';
import { database_optimization_service } from '../services/infrastructure/database-optimization-service.js';
import { get_database } from '../database/connection.js';
import { get_redis_client } from '../database/redis-connection.js';
import { escape_regex } from '../utils/regex-escape.js';
import { v4 as uuidv4 } from 'uuid';
import { generateContentHash, generateIdempotencyKey } from '../services/infrastructure/content-hash-utils.js';
import { buildScopeFilter, DEFAULT_USER_ID } from '../services/memory/memory-scope-service.js';
import { validateKatraKey } from '../utils/api-key-manager.js';

const DEBUG_ENDPOINTS_ENABLED = process.env.KATRA_ENABLE_DEBUG_ENDPOINTS === 'true';

function debugDisabledResponse() {
    return {
        success: false,
        error: 'Debug endpoints are disabled. Set KATRA_ENABLE_DEBUG_ENDPOINTS=true to enable.'
    };
}

export const create_memory_routes = (): Hono => {
    const router = new Hono();

    router.use('*', async (c, next) => {
        const authHeader = c.req.header('Authorization') ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        const queryToken = c.req.query('token') ?? '';
        const tokenToValidate = token || queryToken;
        if (!validateKatraKey(tokenToValidate)) {
            return c.json({ error: 'Unauthorized', message: 'API key required' }, 401);
        }
        return next();
    });

    // Health check endpoint
    router.get('/health', async (c) => {
        try {
            const db = get_database();
            
            // Check MongoDB connection
            let mongodb_connected = false;
            try {
                await db.admin().ping();
                mongodb_connected = true;
            } catch (error) {
                console.error('MongoDB health check failed:', error);
            }

            // Check if collections exist
            let collections_ready = false;
            try {
                const collections = await db.listCollections().toArray();
                const collectionNames = collections.map(c => c.name);
                collections_ready = collectionNames.includes('episodic_events') &&
                                  collectionNames.includes('semantic_facts');
            } catch (error) {
                console.error('Collections check failed:', error);
            }

            const memory_manager_status = mongodb_connected && collections_ready ? 'healthy' : 'error';

            let llm_status = { available: false, provider: 'none', model: 'none' };
            try {
                const { llmService } = await import('../services/llm-service.js');
                llm_status = llmService.getServiceStatus();
            } catch {
                // LLM service not importable
            }

            return c.json({
                success: true,
                data: {
                    mongodb_connected,
                    collections_ready,
                    memory_manager_status,
                    message: 'Advanced Memory System is operational',
                    timestamp: new Date().toISOString(),
                    version: '2.0.0 - Cognitive Architecture',
                    services: {
                        working_memory: 'active',
                        learning_feedback: 'active',
                        database_optimization: 'active',
                        episodic_memory: 'active',
                        semantic_memory: 'active',
                        synthesis_engine: 'active'
                    },
                    health: {
                        llm_service: llm_status
                    }
                }
            });
        } catch (error) {
            console.error('❌ Memory health check failed:', error);
            return c.json({
                success: false,
                mongodb_connected: false,
                collections_ready: false,
                memory_manager_status: 'error',
                error: 'Health check failed'
            }, 500);
        }
    });

    // ====== WORKING MEMORY ENDPOINTS ======

    /**
     * Add item to working memory
     * POST /api/memory/working
     */
    router.post('/working', async (c) => {
        try {
            const body = await c.req.json();
            const { session_id, content, content_type = 'general', priority = 'medium' } = body;

            if (!session_id || !content) {
                return c.json({
                    success: false,
                    error: 'Missing required fields: session_id, content'
                }, 400);
            }

            const ttl_seconds = priority === 'high' ? 7200 : priority === 'medium' ? 3600 : 1800;

            const item_id = await working_memory_service.store(
                DEFAULT_USER_ID,
                session_id,
                { content, content_type },
                { ttl_seconds }
            );

            return c.json({
                success: true,
                item_id,
                message: 'Item added to working memory',
                ttl_seconds
            }, 201);

        } catch (error) {
            console.error('❌ Working memory addition failed:', error);
            return c.json({
                success: false,
                error: 'Failed to add item to working memory'
            }, 500);
        }
    });

    /**
     * Get working memory for session
     * GET /api/memory/working/:session_id
     */
    router.get('/working/:session_id', async (c) => {
        try {
            const session_id = c.req.param('session_id');
            const limit = parseInt(c.req.query('limit') || '20');

            const items = await working_memory_service.get_session_memory(DEFAULT_USER_ID, session_id, limit);

            return c.json({
                success: true,
                items,
                count: items.length
            });

        } catch (error) {
            console.error('❌ Working memory retrieval failed:', error);
            return c.json({
                success: false,
                error: 'Failed to retrieve working memory'
            }, 500);
        }
    });

    /**
     * Clear working memory for session
     * DELETE /api/memory/working/:session_id
     */
    router.delete('/working/:session_id', async (c) => {
        try {
            const session_id = c.req.param('session_id');

            const session_items = await working_memory_service.get_session_memory(DEFAULT_USER_ID, session_id, 1000);
            let cleared_count = 0;
            for (const item of session_items) {
                const deleted = await working_memory_service.delete(item.id);
                if (deleted) cleared_count++;
            }

            return c.json({
                success: true,
                cleared_count,
                message: 'Working memory cleared'
            });

        } catch (error) {
            console.error('❌ Working memory clearing failed:', error);
            return c.json({
                success: false,
                error: 'Failed to clear working memory'
            }, 500);
        }
    });

    // ====== LEARNING FEEDBACK ENDPOINTS ======

    /**
     * Process interaction feedback for learning
     * POST /api/memory/feedback/interaction
     */
    router.post('/feedback/interaction', async (c) => {
        try {
            const body = await c.req.json();
            const { user_input, agent_response, context_data, user_feedback } = body;

            if (!user_input || !agent_response) {
                return c.json({
                    success: false,
                    error: 'Missing required fields: user_input, agent_response'
                }, 400);
            }

            // Create interaction outcome for learning system
            const interaction_outcome = {
                interaction_id: uuidv4(),
                user_id: context_data?.user_id || 'unknown',
                session_id: context_data?.session_id || 'unknown',
                input_query: user_input,
                response_content: agent_response,
                memory_context_used: {
                    episodic_count: context_data?.episodic_count || 0,
                    semantic_count: context_data?.semantic_count || 0,
                    relationship_count: context_data?.relationship_count || 0,
                    synthesis_confidence: context_data?.synthesis_confidence || 0.5
                },
                user_feedback: user_feedback ? {
                    satisfaction_score: user_feedback.rating || 3,
                    relevance_score: user_feedback.relevance || 3,
                    helpfulness_score: user_feedback.helpfulness || 3,
                    feedback_text: user_feedback.feedback_text,
                    feedback_type: user_feedback.type || 'neutral'
                } : undefined,
                outcome_metrics: {
                    response_time_ms: context_data?.response_time_ms || 1000,
                    follow_up_questions: 0,
                    task_completion: true,
                    context_accuracy: 0.7
                },
                timestamp: new Date(),
                processed_for_learning: false
            };

            const result = await learning_feedback_service.process_interaction_outcome(interaction_outcome);

            return c.json({
                success: true,
                interaction_id: interaction_outcome.interaction_id,
                learning_extracted: result.learning_extracted,
                quality_updates: result.quality_updates,
                patterns_identified: result.patterns_identified,
                consolidation_triggered: result.consolidation_triggered
            });

        } catch (error) {
            console.error('❌ Interaction feedback processing failed:', error);
            return c.json({
                success: false,
                error: 'Failed to process interaction feedback'
            }, 500);
        }
    });

    /**
     * Generate learning analytics for user
     * GET /api/memory/analytics/:user_id
     */
    router.get('/analytics/:user_id', async (c) => {
        try {
            const user_id = c.req.param('user_id');
            const days = parseInt(c.req.query('days') || '30');

            const analytics = await learning_feedback_service.get_learning_analytics(user_id, DEFAULT_USER_ID);

            return c.json({
                success: true,
                analytics
            });

        } catch (error) {
            if (error instanceof AuthorizationError) {
                return c.json({ success: false, error: 'Forbidden' }, 403);
            }
            console.error('❌ Learning analytics generation failed:', error);
            return c.json({
                success: false,
                error: 'Failed to generate learning analytics'
            }, 500);
        }
    });

    /**
     * Trigger memory consolidation
     * POST /api/memory/consolidate
     */
    router.post('/consolidate', async (c) => {
        try {
            const body = await c.req.json();
            const { user_id } = body;

            const result = await learning_feedback_service.consolidate_memories_from_patterns(user_id);

            return c.json({
                success: true,
                consolidation_result: result
            });

        } catch (error) {
            console.error('❌ Memory consolidation failed:', error);
            return c.json({
                success: false,
                error: 'Failed to consolidate memories'
            }, 500);
        }
    });

    // ====== DATABASE OPTIMIZATION ENDPOINTS ======

    /**
     * Get database performance stats
     * GET /api/memory/stats/database
     */
    router.get('/stats/database', async (c) => {
        try {
            const stats = await database_optimization_service.get_performance_statistics();

            return c.json({
                success: true,
                database_stats: stats
            });

        } catch (error) {
            console.error('❌ Database stats retrieval failed:', error);
            return c.json({
                success: false,
                error: 'Failed to retrieve database stats'
            }, 500);
        }
    });

    // ====== ADVANCED MEMORY SYSTEM ENDPOINTS ======

    /**
     * Store episodic event
     * POST /api/memory/episodic/events
     */
    router.post('/episodic/events', async (c) => {
        try {
            const body = await c.req.json();
            const { session_id, event_type, content, metadata } = body;
            const user_id = DEFAULT_USER_ID;

            if (!event_type || !content) {
                return c.json({
                    success: false,
                    error: 'Missing required fields: user_id, event_type, content'
                }, 400);
            }

            const db = get_database();
            const event_id = uuidv4();
            const contentHash = generateContentHash({
                event_type,
                content,
                user_id,
                session_id: session_id || uuidv4(),
            });

            const result = await db.collection('episodic_events').insertOne({
                id: event_id,
                user_id,
                session_id: session_id || uuidv4(),
                event_type,
                content,
                content_hash: contentHash,
                idempotency_key: generateIdempotencyKey({ event_type, user_id, session_id: session_id || uuidv4() }, contentHash),
                metadata: { ...(metadata || {}), processed: false },
                timestamp: new Date(),
            });

            console.log('📝 Stored episodic event');

            // Real-time inter-agent notification via Redis pub-sub
            const shared_id = body.shared_id || metadata?.shared_id;
            const tags = metadata?.tags || body.tags || [];
            if (shared_id && tags.some((t: string) => ['inter-agent', 'agent-communication'].includes(t))) {
                try {
                    const redis = await get_redis_client();
                    if (redis) {
                        const preview = typeof content === 'string' ? content.substring(0, 300) : JSON.stringify(content).substring(0, 300);
                        await redis.publish(`katra:events:${shared_id}`, JSON.stringify({
                            type: 'inter-agent-message',
                            event_id,
                            shared_id,
                            from_user_id: user_id,
                            tags,
                            content_preview: preview,
                            timestamp: new Date().toISOString(),
                        }));
                        console.log(`📡 Published to Redis channel katra:events:${shared_id}`);
                    }
                } catch (pubErr: any) {
                    console.warn('⚠️ Redis publish failed:', pubErr.message);
                }
            }

            return c.json({
                success: true,
                event_id,
                message: 'Episodic event stored successfully'
            }, 201);

        } catch (error) {
            console.error('❌ Episodic event storage failed:', error);
            return c.json({
                success: false,
                error: 'Failed to store episodic event'
            }, 500);
        }
    });

    /**
     * Search episodic events
     * POST /api/memory/episodic/search
     */
    router.post('/episodic/search', async (c) => {
        try {
            const body = await c.req.json();
            const { user_id, query, limit = 20 } = body;

            if (!user_id || !query) {
                return c.json({
                    success: false,
                    error: 'Missing required fields: user_id, query'
                }, 400);
            }

            const db = get_database();
            let results: any[] = [];

            // Primary: use MongoDB text index for relevance-ranked search
            try {
                results = await db.collection('episodic_events')
                    .find({
                        user_id,
                        $text: { $search: query }
                    })
                    .sort({ score: { $meta: 'textScore' } })
                    .limit(limit)
                    .toArray();
            } catch (textSearchError) {
                console.log('📝 Text search unavailable, falling back to regex');
            }

            // Fallback to regex if text search returns nothing or is unavailable
            if (results.length === 0) {
                const safeQuery = query.slice(0, 200);
                const escapedTerms = safeQuery.split(/\s+/).slice(0, 10).map(escape_regex);
                const query_regex = new RegExp(escapedTerms.join('|'), 'i');

                results = await db.collection('episodic_events')
                    .find({
                        user_id,
                        $or: [
                            { content: query_regex },
                            { 'content.message': query_regex },
                            { event_type: query_regex }
                        ]
                    })
                    .sort({ timestamp: -1 })
                    .limit(limit)
                    .toArray();
            }

            return c.json({
                success: true,
                results: results.map(r => ({
                    id: r.id,
                    event_type: r.event_type,
                    content: r.content,
                    timestamp: r.timestamp,
                    relevance_score: 0.7
                })),
                count: results.length
            });

        } catch (error) {
            console.error('❌ Episodic event search failed:', error);
            return c.json({
                success: false,
                error: 'Failed to search episodic events'
            }, 500);
        }
    });

    /**
     * Get episodic events within a time range
     * Phase 1: Temporal Recall — date-range query endpoint
     * GET /api/memory/episodic/events?user_id=...&from=2026-05-01&to=2026-05-15&limit=50&event_type=user_message
     */
    router.get('/episodic/events', async (c) => {
        try {
            const user_id = DEFAULT_USER_ID;
            const from_str = c.req.query('from');
            const to_str = c.req.query('to');
            const limit = parseInt(c.req.query('limit') || '50');
            const event_type = c.req.query('event_type');
            const role = c.req.query('role') as 'user' | 'assistant' | undefined;

            const from = from_str ? new Date(from_str) : new Date(Date.now() - 24 * 60 * 60 * 1000);
            const to = to_str ? new Date(to_str) : new Date();

            if (isNaN(from.getTime()) || isNaN(to.getTime())) {
                return c.json({
                    success: false,
                    error: 'Invalid date format for from or to. Use ISO 8601 (e.g. 2026-05-01 or 2026-05-01T00:00:00Z)'
                }, 400);
            }

            const db = get_database();
            const scopeFilter = await buildScopeFilter(user_id);
            const matchCriteria: any = {
                ...scopeFilter,
                timestamp: { $gte: from, $lte: to }
            };

            if (event_type) {
                matchCriteria.event_type = event_type;
            }

            if (role) {
                matchCriteria['content.role'] = role;
            }

            const results = await db.collection('episodic_events')
                .find(matchCriteria)
                .sort({ timestamp: -1 })
                .limit(limit)
                .toArray();

            console.log(`📅 Time-range query: ${from.toISOString()} → ${to.toISOString()} — ${results.length} events for ${user_id}`);

            return c.json({
                success: true,
                results: results.map(r => ({
                    id: r.id,
                    event_type: r.event_type,
                    content: r.content,
                    timestamp: r.timestamp,
                    session_id: r.session_id,
                    user_id: r.user_id
                })),
                count: results.length,
                query: {
                    from: from.toISOString(),
                    to: to.toISOString(),
                    user_id,
                    event_type: event_type || null,
                    role: role || null
                }
            });

        } catch (error) {
            console.error('❌ Episodic event time-range query failed:', error);
            return c.json({
                success: false,
                error: 'Failed to query episodic events by time range'
            }, 500);
        }
    });

    /**
     * Synthesize cognitive context
     * POST /api/memory/synthesize
     */
    router.post('/synthesize', async (c) => {
        try {
            const body = await c.req.json();
            const { user_id, session_id, query, context_type = 'conversational' } = body;

            if (!user_id || !session_id || !query) {
                return c.json({
                    success: false,
                    error: 'Missing required fields: user_id, session_id, query'
                }, 400);
            }

            const db = get_database();

            // Get recent episodic events
            const episodic_memories = await db.collection('episodic_events')
                .find({ user_id })
                .sort({ timestamp: -1 })
                .limit(10)
                .toArray();

            // Get semantic facts
            const semantic_facts = await db.collection('semantic_facts')
                .find({ user_id })
                .sort({ confidence: -1 })
                .limit(5)
                .toArray();

            // Get working memory
            const working_memory = await working_memory_service.get_session_memory(DEFAULT_USER_ID, session_id, 5);

            const enhanced_context = {
                original_query: query,
                synthesized_context: `Query: "${query}" with ${episodic_memories.length} episodic memories, ${semantic_facts.length} semantic facts, and ${working_memory.length} working memory items available.`,
                memory_integration: {
                    episodic_context: episodic_memories.length > 0 ? 
                        `Recent experiences include interactions about: ${episodic_memories.slice(0, 3).map(e => e.event_type).join(', ')}` :
                        'No recent episodic memories available',
                    semantic_context: semantic_facts.length > 0 ?
                        `Established knowledge includes: ${semantic_facts.slice(0, 2).map(f => f.content?.substring(0, 50) + '...').join('; ')}` :
                        'No semantic knowledge available',
                    relational_context: 'Knowledge relationships analysis pending',
                    temporal_context: 'Temporal pattern analysis pending'
                },
                cognitive_insights: {
                    key_themes: ['memory_system', 'cognitive_architecture'],
                    emotional_context: {
                        primary_emotion: 'neutral',
                        intensity: 0.5,
                        context_indicators: []
                    },
                    temporal_patterns: [],
                    entity_relationships: [],
                    knowledge_gaps: [],
                    synthesis_confidence: 0.6
                },
                context_templates: {
                    conversation_enhancer: `For conversational response about "${query}", drawing from available memory context.`,
                    analytical_framework: `For analytical response about "${query}", focusing on available data and patterns.`,
                    creative_catalyst: `For creative exploration of "${query}", building on existing knowledge.`
                },
                confidence_metrics: {
                    overall_confidence: 0.6,
                    memory_completeness: episodic_memories.length / 20,
                    insight_reliability: 0.5,
                    synthesis_coherence: 0.7
                }
            };

            return c.json({
                success: true,
                enhanced_context
            });

        } catch (error) {
            console.error('❌ Memory synthesis failed:', error);
            return c.json({
                success: false,
                error: 'Failed to synthesize memory context'
            }, 500);
        }
    });

    // ====== TIME-BLOCK MEMORY SUMMARIZATION (Phase 4) ======

    /**
     * Trigger time-block summarization for a user
     * POST /api/memory/summarize-time-blocks
     *
     * Body: { user_id, block_type?, lookback_days?, max_blocks?, dry_run? }
     */
    router.post('/summarize-time-blocks', async (c) => {
        try {
            const body = await c.req.json();
            const { user_id, block_type = 'week', lookback_days = 90, max_blocks = 20, dry_run = false } = body;

            if (!user_id) {
                return c.json({
                    success: false,
                    error: 'Missing required field: user_id'
                }, 400);
            }

            // Dynamic import to avoid circular deps
            const { timeBlockSummarizer } = await import('../services/processing/time-block-summarizer.js');
            const result = await timeBlockSummarizer.summarizeTimeBlocks({
                user_id,
                block_type,
                lookback_days,
                max_blocks,
                dry_run,
            });

            return c.json({
                success: true,
                data: result,
                message: dry_run
                    ? `Dry run: would generate ${result.summaries_generated} summaries across ${result.blocks_processed} blocks`
                    : `Generated ${result.summaries_generated} summaries across ${result.blocks_processed} blocks (${result.blocks_skipped} skipped)`,
            });

        } catch (error) {
            console.error('❌ Time-block summarization failed:', error);
            return c.json({
                success: false,
                error: 'Failed to summarize time blocks'
            }, 500);
        }
    });

    /**
     * Query existing time-block summaries
     * GET /api/memory/time-block-summaries?user_id=...&from=2026-05-01&to=2026-06-01&block_type=week&limit=20
     */
    router.get('/time-block-summaries', async (c) => {
        try {
            const user_id = DEFAULT_USER_ID;
            const from_str = c.req.query('from');
            const to_str = c.req.query('to');
            const block_type = c.req.query('block_type') as 'day' | 'week' | 'month' | undefined;
            const limit = parseInt(c.req.query('limit') || '20');

            if (!user_id) {
                return c.json({
                    success: false,
                    error: 'Missing required query parameter: user_id'
                }, 400);
            }

            const from = from_str ? new Date(from_str) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const to = to_str ? new Date(to_str) : new Date();

            if (isNaN(from.getTime()) || isNaN(to.getTime())) {
                return c.json({
                    success: false,
                    error: 'Invalid date format. Use ISO 8601.'
                }, 400);
            }

            const { timeBlockSummarizer } = await import('../services/processing/time-block-summarizer.js');
            const summaries = await timeBlockSummarizer.getTimeBlockSummaries(
                user_id, from, to, { block_type, limit }
            );

            return c.json({
                success: true,
                results: summaries.map(s => ({
                    block_type: s.block_type,
                    block_start: s.block_start,
                    block_end: s.block_end,
                    event_count: s.event_count,
                    summary: s.summary,
                    top_topics: s.top_topics,
                    generated_at: s.generated_at,
                })),
                count: summaries.length,
                query: { from: from.toISOString(), to: to.toISOString(), block_type: block_type || null },
            });

        } catch (error) {
            console.error('❌ Time-block summary query failed:', error);
            return c.json({
                success: false,
                error: 'Failed to query time-block summaries'
            }, 500);
        }
    });

    // ====== TEMPORAL PATTERN DETECTION (Phase 5) ======

    /**
     * Detect temporal patterns in user activity
     * POST /api/memory/detect-patterns
     *
     * Body: { user_id, lookback_weeks?, min_confidence?, dormant_threshold_days? }
     */
    router.post('/detect-patterns', async (c) => {
        try {
            const body = await c.req.json();
            const {
                user_id,
                lookback_weeks = 12,
                min_confidence = 0.5,
                dormant_threshold_days = 14,
                regression_lookback_days = 120,
            } = body;

            if (!user_id) {
                return c.json({
                    success: false,
                    error: 'Missing required field: user_id'
                }, 400);
            }

            const { temporalPatternDetector } = await import('../services/temporal-pattern-detector.js');
            const patterns = await temporalPatternDetector.detectPatterns({
                user_id,
                lookback_weeks,
                min_confidence,
                dormant_threshold_days,
                regression_lookback_days,
            });

            const summary = temporalPatternDetector.summarizePatterns(patterns);

            return c.json({
                success: true,
                data: {
                    patterns,
                    summary,
                },
            });

        } catch (error) {
            console.error('❌ Pattern detection failed:', error);
            return c.json({
                success: false,
                error: 'Failed to detect temporal patterns'
            }, 500);
        }
    });

    /**
     * Comprehensive memory system demonstration
     * POST /api/memory/demo/complete
     */
    router.post('/demo/complete', async (c) => {
        try {
            if (!DEBUG_ENDPOINTS_ENABLED) {
                return c.json(debugDisabledResponse(), 403);
            }

            const body = await c.req.json();
            const {
                user_id = DEFAULT_USER_ID,
                session_id = uuidv4(),
                message = 'Hello, I am interested in learning about machine learning algorithms'
            } = body;

            console.log('🚀 Starting advanced memory system demonstration...');

            // Step 1: Store episodic event
            const db = get_database();
            const event_id = uuidv4();
            const contentHash = generateContentHash({
                event_type: 'user_message',
                content: { message, intent: 'learning_inquiry' },
                user_id,
                session_id,
            });
            
            await db.collection('episodic_events').insertOne({
                id: event_id,
                user_id,
                session_id,
                event_type: 'user_message',
                content: { message, intent: 'learning_inquiry' },
                content_hash: contentHash,
                idempotency_key: generateIdempotencyKey({ event_type: 'user_message', user_id, session_id }, contentHash),
                metadata: { demo: true, processed: false },
                timestamp: new Date(),
            });

            // Step 2: Add to working memory
            const working_memory_id = await working_memory_service.store(
                DEFAULT_USER_ID,
                session_id,
                { user_message: message, context: 'demo_interaction' },
                { ttl_seconds: 3600 }
            );

            // Step 3: Create placeholder knowledge extraction
            const knowledge_extraction = {
                facts_extracted: 1,
                relationships_identified: 1,
                entities_found: ['machine learning', 'algorithms'],
                confidence: 0.8
            };

            // Step 4: Synthesize context (using placeholder)
            const synthesis_response = await fetch(`${c.req.url.replace('/demo/complete', '/synthesize')}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id,
                    session_id,
                    query: message,
                    context_type: 'analytical'
                })
            });

            const enhanced_context = synthesis_response.ok ? 
                await synthesis_response.json() : 
                { enhanced_context: null };

            // Step 5: Process feedback (simulated positive interaction)
            const feedback_response = await fetch(`${c.req.url.replace('/demo/complete', '/feedback/interaction')}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_input: message,
                    agent_response: 'Based on your interest in machine learning algorithms, I can help you explore various approaches...',
                    context_data: {
                        user_id,
                        session_id,
                        episodic_count: 1,
                        semantic_count: 0,
                        synthesis_confidence: 0.6
                    },
                    user_feedback: { 
                        rating: 5, 
                        relevance: 5,
                        type: 'positive'
                    }
                })
            });

            const feedback_result = feedback_response.ok ? 
                await feedback_response.json() : 
                { feedback_processed: false };

            // Step 6: Generate analytics
            const analytics = await learning_feedback_service.get_learning_analytics(user_id, DEFAULT_USER_ID);

            return c.json({
                success: true,
                demo_results: {
                    episodic_event_id: event_id,
                    knowledge_extraction,
                    working_memory_id,
                    enhanced_context: enhanced_context.enhanced_context,
                    feedback_result,
                    analytics
                },
                message: 'Advanced memory system demonstration completed successfully',
                note: 'This demonstration uses placeholder implementations for advanced services. Full cognitive architecture will be available once all components are integrated.',
                next_steps: [
                    'Complete episodic memory service implementation',
                    'Complete semantic memory service implementation', 
                    'Complete memory synthesis engine implementation',
                    'Integrate all services for full cognitive capabilities'
                ]
            });

        } catch (error) {
            console.error('❌ Memory system demo failed:', error);
            return c.json({
                success: false,
                error: 'Memory system demonstration failed',
                details: error instanceof Error ? error.message : 'Unknown error'
            }, 500);
        }
    });


    // ====== MEMORY STATS ENDPOINT (REQUIRED BY FRONTEND DASHBOARD) ======

    /**
     * Get memory statistics for dashboard
     * GET /api/memory/stats
     */
    router.get('/stats', async (c) => {
        try {
            const db = get_database();
            const user_id = DEFAULT_USER_ID;
            const scopeFilter = await buildScopeFilter(user_id);

            console.log('🔍 Memory stats endpoint called for user:', user_id);

            const collections = ['semantic_facts', 'episodic_events', 'knowledge_nodes', 'knowledge_relationships', 'working_memory_sessions'];
            const counts: any = {};

            for (const collection of collections) {
                try {
                    counts[collection] = await db.collection(collection).countDocuments(scopeFilter);
                } catch (collError: any) {
                    counts[collection] = 0;
                }
            }

            return c.json({
                success: true,
                user_id,
                total_events: counts.episodic_events,
                total_nodes: counts.knowledge_nodes,
                total_facts: counts.semantic_facts,
                total_relationships: counts.knowledge_relationships,
                total_sessions: counts.working_memory_sessions,
                total_assets: 0,
                collections_status: {
                    episodic_events: true,
                    knowledge_nodes: true,
                    semantic_facts: true,
                    knowledge_relationships: true,
                    working_memory: true
                },
                counts
            });
        } catch (error: any) {
            console.error('❌ Memory stats retrieval failed:', error);
            return c.json({
                success: false,
                error: 'Failed to get memory stats',
                debug: error.message
            }, 500);
        }
    });

    // ====== DATA REPAIR ENDPOINT ======

    /**
     * Repair user_id inconsistencies across collections
     * POST /api/memory/repair/user-ids
     */
    router.post('/repair/user-ids', async (c) => {
        try {
            const db = get_database();
            const body = await c.req.json();
            if (!DEBUG_ENDPOINTS_ENABLED) {
                return c.json(debugDisabledResponse(), 403);
            }

            const target_user_id = body.target_user_id;

            if (!target_user_id) {
                return c.json({
                    success: false,
                    error: 'Missing required field: target_user_id'
                }, 400);
            }

            console.log(`🔧 Starting user_id repair to standardize as: ${target_user_id}`);
            
            const repair_results = {
                timestamp: new Date().toISOString(),
                target_user_id,
                collections_updated: {} as any,
                summary: {} as any
            };
            
            const collections = ['semantic_facts', 'episodic_events', 'knowledge_nodes', 'knowledge_relationships', 'working_memory_sessions'];
            
            for (const collectionName of collections) {
                console.log(`🔧 Repairing collection: ${collectionName}`);
                
                try {
                    // Find documents with missing or null user_id only
                    const docs_without_user_id = await db.collection(collectionName).countDocuments({ user_id: { $exists: false } });
                    const docs_with_null_user_id = await db.collection(collectionName).countDocuments({ user_id: null });
                    
                    let updates_made = 0;
                    
                    // Update documents without user_id
                    if (docs_without_user_id > 0) {
                        const result1 = await db.collection(collectionName).updateMany(
                            { user_id: { $exists: false } },
                            { $set: { user_id: target_user_id } }
                        );
                        updates_made += result1.modifiedCount;
                        console.log(`  ✅ Added user_id to ${result1.modifiedCount} documents`);
                    }
                    
                    // Update documents with null user_id
                    if (docs_with_null_user_id > 0) {
                        const result2 = await db.collection(collectionName).updateMany(
                            { user_id: null },
                            { $set: { user_id: target_user_id } }
                        );
                        updates_made += result2.modifiedCount;
                        console.log(`  ✅ Fixed null user_id in ${result2.modifiedCount} documents`);
                    }
                    
                    repair_results.collections_updated[collectionName] = {
                        docs_without_user_id: docs_without_user_id,
                        docs_with_null_user_id: docs_with_null_user_id,
                        updates_made: updates_made
                    };
                    
                    console.log(`📊 ${collectionName}: ${updates_made} updates, final count: ${final_count}/${total_count}`);
                    
                } catch (error: any) {
                    console.error(`❌ Error repairing ${collectionName}:`, error);
                    repair_results.collections_updated[collectionName] = {
                        error: error.message
                    };
                }
            }
            
            // Calculate summary 
            const total_updates = Object.values(repair_results.collections_updated)
                .reduce((sum: number, coll: any) => {
                    if (typeof coll === 'object' && coll !== null && 'updates_made' in coll) {
                        const count = coll.updates_made;
                        return sum + (typeof count === 'number' ? count : 0);
                    }
                    return sum;
                }, 0);
                
            repair_results.summary = {
                total_updates_made: total_updates,
                collections_processed: collections.length,
                success: true // Repair attempt completed successfully
            };
            
            console.log(`🔧 Repair complete: ${total_updates} total updates made`);
            
            return c.json({
                success: true,
                repair_results,
                message: `Successfully repaired user_id inconsistencies. Made ${total_updates} updates across ${collections.length} collections.`
            });
            
        } catch (error: any) {
            console.error('❌ User ID repair failed:', error);
            return c.json({
                success: false,
                error: 'User ID repair failed',
                details: error.message
            }, 500);
        }
    });

    // ====== COLLECTION COUNTS DEBUG ENDPOINT ======

    /**
     * Debug collection counts discrepancy
     * GET /api/memory/debug/counts
     */
    router.get('/debug/counts', async (c) => {
        try {
            if (!DEBUG_ENDPOINTS_ENABLED) {
                return c.json(debugDisabledResponse(), 403);
            }

            const db = get_database();

            console.log('🐛 DEBUG: Collection counts discrepancy analysis started');
            
            const analysis = {
                timestamp: new Date().toISOString(),
                collections: {} as any,
                summary: {} as any
            };
            
            const collections = ['semantic_facts', 'episodic_events', 'knowledge_nodes', 'knowledge_relationships', 'working_memory_sessions'];
            
            for (const collectionName of collections) {
                console.log(`🔍 Analyzing collection: ${collectionName}`);
                
                try {
                    // Basic counts
                    const total_count = await db.collection(collectionName).countDocuments();
                    const demo_user_count = await db.collection(collectionName).countDocuments({ user_id: 'demo-user' });
                    
                    // User distribution
                    const user_distribution = await db.collection(collectionName)
                        .aggregate([
                            { $group: { _id: "$user_id", count: { $sum: 1 } } },
                            { $sort: { count: -1 } }
                        ])
                        .toArray();
                    
                    // Recent documents sample
                    const recent_docs = await db.collection(collectionName)
                        .find({}, { projection: { user_id: 1, timestamp: 1, created_at: 1, _id: 1 } })
                        .sort({ _id: -1 })
                        .limit(5)
                        .toArray();
                    
                    analysis.collections[collectionName] = {
                        total_count,
                        demo_user_count,
                        percentage_demo_user: total_count > 0 ? Math.round((demo_user_count / total_count) * 100) : 0,
                        user_distribution,
                        recent_sample: recent_docs.map(doc => ({
                            id: doc._id,
                            user_id: doc.user_id,
                            timestamp: doc.timestamp || doc.created_at || 'unknown'
                        }))
                    };
                    
                    console.log(`📊 ${collectionName}: Total=${total_count}, Demo-user=${demo_user_count} (${Math.round((demo_user_count / total_count) * 100)}%)`);
                    
                } catch (error: any) {
                    console.error(`❌ Error analyzing ${collectionName}:`, error);
                    analysis.collections[collectionName] = {
                        error: error.message
                    };
                }
            }
            
            // Summary statistics
            analysis.summary = {
                total_documents: Object.values(analysis.collections).reduce((sum: number, coll: any) => {
                    if (typeof coll === 'object' && coll !== null && 'total_count' in coll) {
                        const count = coll.total_count;
                        return sum + (typeof count === 'number' ? count : 0);
                    }
                    return sum;
                }, 0),
                demo_user_documents: Object.values(analysis.collections).reduce((sum: number, coll: any) => {
                    if (typeof coll === 'object' && coll !== null && 'demo_user_count' in coll) {
                        const count = coll.demo_user_count;
                        return sum + (typeof count === 'number' ? count : 0);
                    }
                    return sum;
                }, 0),
                collections_analyzed: collections.length,
                potential_issue: 'Check if UI is filtering by user_id or using different query parameters'
            };
            
            console.log('🔍 DEBUG: Analysis complete:', analysis.summary);
            
            return c.json({
                success: true,
                analysis,
                recommendations: [
                    'Check browser DevTools Network tab to see actual API calls',
                    'Verify if UI is adding ?user_id=demo-user query parameter',
                    'Check if MongoDB viewer/UI is using different filtering',
                    'Compare counts shown in screenshots vs API response'
                ]
            });
            
        } catch (error: any) {
            console.error('❌ Collection counts debug failed:', error);
            return c.json({
                success: false,
                error: 'Debug analysis failed',
                details: error.message
            }, 500);
        }
    });

    // ====== SYSTEM STATUS ENDPOINT ======

    /**
     * Get comprehensive memory system status
     * GET /api/memory/status
     */
    router.get('/status', async (c) => {
        try {
            const db = get_database();
            
            // Get collection counts
            const collections = {
                episodic_events: await db.collection('episodic_events').countDocuments(),
                semantic_facts: await db.collection('semantic_facts').countDocuments(),
                knowledge_relationships: await db.collection('knowledge_relationships').countDocuments(),
                interaction_outcomes: await db.collection('interaction_outcomes').countDocuments(),
                learning_patterns: await db.collection('learning_patterns').countDocuments(),
                memory_quality_scores: await db.collection('memory_quality_scores').countDocuments()
            };

            // Get working memory stats
            const working_memory_stats = await working_memory_service.get_statistics();

            // Get database optimization stats
            const db_stats = await database_optimization_service.get_performance_statistics();

            return c.json({
                success: true,
                timestamp: new Date().toISOString(),
                version: '2.0.0 - Cognitive Memory Architecture',
                system_status: {
                    overall_health: 'operational',
                    active_services: [
                        'working_memory',
                        'learning_feedback', 
                        'database_optimization'
                    ],
                    pending_services: [
                        'episodic_memory_service',
                        'semantic-memory-service',
                        'memory_synthesis_engine'
                    ]
                },
                data_overview: {
                    total_memories: Object.values(collections).reduce((sum, count) => sum + count, 0),
                    collection_counts: collections,
                    working_memory: working_memory_stats,
                    database_performance: db_stats
                },
                capabilities: {
                    available: [
                        'Working memory management',
                        'Learning feedback processing',
                        'Interaction outcome tracking',
                        'Memory quality scoring',
                        'Learning pattern identification',
                        'Basic memory consolidation',
                        'Database optimization'
                    ],
                    coming_soon: [
                        'Advanced episodic memory processing',
                        'Semantic knowledge extraction',
                        'Multi-modal memory synthesis',
                        'Cognitive context enhancement',
                        'Advanced learning analytics',
                        'Real-time memory consolidation'
                    ]
                }
            });

        } catch (error) {
            console.error('❌ System status check failed:', error);
            return c.json({
                success: false,
                error: 'Failed to get system status'
            }, 500);
        }
    });

    // ====== KNOWLEDGE GRAPH ENDPOINTS ======

    /**
     * Get knowledge graph data for visualization with session-based relationships
     * GET /api/memory/knowledge-graph
     */
    router.get('/knowledge-graph', async (c) => {
        try {
            const db = get_database();
            const user_id = DEFAULT_USER_ID;
            const limit = parseInt(c.req.query('limit') || '100');

            const effective_user_id = user_id || DEFAULT_USER_ID;
            const scopeFilter = await buildScopeFilter(effective_user_id);

            console.log('🔍 Fetching knowledge graph data for user:', effective_user_id);

            // Fetch scoped nodes and relationships
            const [nodes, relationships, episodic_events, working_memory_sessions] = await Promise.all([
                db.collection('knowledge_nodes').find(scopeFilter).limit(limit).toArray(),
                db.collection('knowledge_relationships').find(scopeFilter).limit(limit * 2).toArray(),
                db.collection('episodic_events').find(scopeFilter).limit(limit * 2).toArray(),
                db.collection('working_memory_sessions').find(scopeFilter).limit(limit).toArray()
            ]);

            // Create a map of session IDs and their associated data
            const sessionData = new Map<string, {
                session_id: string;
                node_ids: Set<string>;
                event_count: number;
                topic_tags: string[];
                created_at?: Date;
                last_activity?: Date;
            }>();

            // Process episodic events to find session associations
            for (const event of episodic_events) {
                if (event.session_id) {
                    if (!sessionData.has(event.session_id)) {
                        sessionData.set(event.session_id, {
                            session_id: event.session_id,
                            node_ids: new Set(),
                            event_count: 0,
                            topic_tags: [],
                            created_at: event.timestamp,
                            last_activity: event.timestamp
                        });
                    }
                    
                    const session = sessionData.get(event.session_id)!;
                    session.event_count++;
                    
                    // Update timestamps
                    if (event.timestamp) {
                        if (!session.created_at || event.timestamp < session.created_at) {
                            session.created_at = event.timestamp;
                        }
                        if (!session.last_activity || event.timestamp > session.last_activity) {
                            session.last_activity = event.timestamp;
                        }
                    }
                }
            }

            // Process working memory sessions to add more session context
            for (const session of working_memory_sessions) {
                if (session.session_id) {
                    if (!sessionData.has(session.session_id)) {
                        sessionData.set(session.session_id, {
                            session_id: session.session_id,
                            node_ids: new Set(),
                            event_count: 0,
                            topic_tags: session.topic_tags || [],
                            created_at: session.created_at,
                            last_activity: session.last_activity
                        });
                    } else {
                        const existing = sessionData.get(session.session_id)!;
                        if (session.topic_tags) {
                            existing.topic_tags.push(...session.topic_tags);
                        }
                        if (session.created_at && (!existing.created_at || session.created_at < existing.created_at)) {
                            existing.created_at = session.created_at;
                        }
                        if (session.last_activity && (!existing.last_activity || session.last_activity > existing.last_activity)) {
                            existing.last_activity = session.last_activity;
                        }
                    }
                }
            }

            // For nodes without session_id, try to infer from their creation time and relationship patterns
            // This is a heuristic approach to group nodes that might belong together
            const nodesWithSessions = nodes.filter(node => node.session_id);
            const nodesWithoutSessions = nodes.filter(node => !node.session_id);

            // Associate nodes with sessions where possible
            for (const node of nodesWithSessions) {
                if (node.session_id && sessionData.has(node.session_id)) {
                    sessionData.get(node.session_id)!.node_ids.add(node.id);
                }
            }

            // For nodes without explicit session_id, try to group them by timestamp proximity
            if (nodesWithoutSessions.length > 0) {
                // Group nodes by creation time (within 1 hour windows)
                const timeGroups = new Map<string, string[]>();
                const HOUR_MS = 60 * 60 * 1000;

                for (const node of nodesWithoutSessions) {
                    if (node.created_at) {
                        const timeKey = Math.floor(new Date(node.created_at).getTime() / HOUR_MS).toString();
                        if (!timeGroups.has(timeKey)) {
                            timeGroups.set(timeKey, []);
                        }
                        timeGroups.get(timeKey)!.push(node.id);
                    }
                }

                // Create synthetic sessions for time-based groups with multiple nodes
                let syntheticSessionCounter = 1;
                for (const [timeKey, nodeIds] of timeGroups) {
                    if (nodeIds.length >= 2) { // Only create session if there are multiple nodes
                        const syntheticSessionId = `inferred_session_${syntheticSessionCounter++}`;
                        
                        // Find the earliest timestamp for this group
                        const groupNodes = nodes.filter(n => nodeIds.includes(n.id));
                        const earliestTime = groupNodes
                            .map(n => n.created_at)
                            .filter(Boolean)
                            .sort()
                            [0];

                        sessionData.set(syntheticSessionId, {
                            session_id: syntheticSessionId,
                            node_ids: new Set(nodeIds),
                            event_count: 0,
                            topic_tags: [],
                            created_at: earliestTime ? new Date(earliestTime) : new Date(),
                            last_activity: earliestTime ? new Date(earliestTime) : new Date()
                        });
                    }
                }
            }

            console.log(`📊 Found ${sessionData.size} sessions with associated nodes`);

            // Extract and analyze topics across sessions
            const topicAnalysis = new Map<string, {
                topic: string;
                sessions: Set<string>;
                nodes: Set<string>;
                frequency: number;
                earliest_mention: Date;
                latest_mention: Date;
                related_keywords: Set<string>;
            }>();

            // Analyze topic tags from sessions
            for (const session of sessionData.values()) {
                for (const topic of session.topic_tags) {
                    if (!topicAnalysis.has(topic.toLowerCase())) {
                        topicAnalysis.set(topic.toLowerCase(), {
                            topic: topic,
                            sessions: new Set(),
                            nodes: new Set(),
                            frequency: 0,
                            earliest_mention: session.created_at || new Date(),
                            latest_mention: session.last_activity || new Date(),
                            related_keywords: new Set()
                        });
                    }
                    
                    const topicData = topicAnalysis.get(topic.toLowerCase())!;
                    topicData.sessions.add(session.session_id);
                    topicData.frequency++;
                    
                    // Update temporal bounds
                    if (session.created_at && session.created_at < topicData.earliest_mention) {
                        topicData.earliest_mention = session.created_at;
                    }
                    if (session.last_activity && session.last_activity > topicData.latest_mention) {
                        topicData.latest_mention = session.last_activity;
                    }
                    
                    // Associate nodes from this session with this topic
                    for (const nodeId of session.node_ids) {
                        topicData.nodes.add(nodeId);
                    }
                }
            }

            // Also analyze node properties and descriptions for topic extraction
            for (const node of nodes) {
                const nodeText = [
                    node.properties?.name,
                    node.properties?.description,
                    node.properties?.title,
                    node.properties?.category,
                    node.properties?.topic
                ].filter(Boolean).join(' ').toLowerCase();

                // Extract potential topics from node content
                const potentialTopics = [];
                
                // Look for existing topics mentioned in node content
                for (const [topicKey, topicData] of topicAnalysis) {
                    if (nodeText.includes(topicKey) || nodeText.includes(topicData.topic.toLowerCase())) {
                        topicData.nodes.add(node.id);
                        potentialTopics.push(topicKey);
                    }
                }

                // Extract new topics from node names/descriptions
                if (node.properties?.name) {
                    const name = node.properties.name.toLowerCase();
                    // Look for compound terms (2+ words) that might be topics
                    const words = name.split(/\s+/);
                    if (words.length >= 2 && words.length <= 4) {
                        const compoundTopic = words.join(' ');
                        if (!topicAnalysis.has(compoundTopic)) {
                            topicAnalysis.set(compoundTopic, {
                                topic: node.properties.name,
                                sessions: new Set(),
                                nodes: new Set([node.id]),
                                frequency: 1,
                                earliest_mention: node.created_at ? new Date(node.created_at) : new Date(),
                                latest_mention: node.updated_at ? new Date(node.updated_at) : new Date(),
                                related_keywords: new Set()
                            });
                        } else {
                            topicAnalysis.get(compoundTopic)!.nodes.add(node.id);
                        }
                    }
                }
            }

            // Create topic nodes for topics mentioned in multiple sessions or with multiple nodes
            const topicNodes = [];
            const crossSessionTopics = Array.from(topicAnalysis.values()).filter(topic => 
                topic.sessions.size > 1 || topic.nodes.size >= 2
            );

            for (const topicData of crossSessionTopics) {
                const timeSpan = topicData.latest_mention.getTime() - topicData.earliest_mention.getTime();
                const daySpan = Math.ceil(timeSpan / (1000 * 60 * 60 * 24));
                
                topicNodes.push({
                    id: `topic_${topicData.topic.toLowerCase().replace(/\s+/g, '_')}`,
                    type: 'topic',
                    name: topicData.topic,
                    description: `Topic discussed across ${topicData.sessions.size} sessions with ${topicData.nodes.size} related nodes. Active for ${daySpan} days.`,
                    properties: {
                        topic_name: topicData.topic,
                        session_count: topicData.sessions.size,
                        node_count: topicData.nodes.size,
                        frequency: topicData.frequency,
                        time_span_days: daySpan,
                        sessions: Array.from(topicData.sessions),
                        is_cross_session: topicData.sessions.size > 1
                    },
                    created_at: topicData.earliest_mention,
                    updated_at: topicData.latest_mention
                });
            }

            console.log(`📊 Found ${topicNodes.length} cross-session topics`);

            // Create session nodes for the visualization
            const sessionNodes = Array.from(sessionData.values()).map(session => ({
                id: `session_${session.session_id}`,
                type: 'session',
                name: session.session_id.startsWith('inferred_') 
                    ? `Inferred Session ${session.session_id.split('_').pop()}`
                    : `Session ${session.session_id.slice(-8)}`,
                description: `Session with ${session.node_ids.size} nodes, ${session.event_count} events. Topics: ${session.topic_tags.join(', ') || 'None'}`,
                properties: {
                    session_id: session.session_id,
                    node_count: session.node_ids.size,
                    event_count: session.event_count,
                    topic_tags: session.topic_tags,
                    is_inferred: session.session_id.startsWith('inferred_')
                },
                created_at: session.created_at,
                updated_at: session.last_activity
            }));

            // Create session-to-node relationships
            const sessionRelationships = [];
            for (const session of sessionData.values()) {
                for (const nodeId of session.node_ids) {
                    sessionRelationships.push({
                        source: `session_${session.session_id}`,
                        target: nodeId,
                        relationship_type: 'contains',
                        strength: 2, // Strong relationship
                        properties: {
                            session_id: session.session_id,
                            relationship_source: 'session_analysis'
                        },
                        created_at: session.created_at || new Date()
                    });
                }
            }

            // Create topic relationships
            const topicRelationships = [];
            
            for (const topicData of crossSessionTopics) {
                const topicId = `topic_${topicData.topic.toLowerCase().replace(/\s+/g, '_')}`;
                
                // Create relationships from topic to sessions
                for (const sessionId of topicData.sessions) {
                    topicRelationships.push({
                        source: topicId,
                        target: `session_${sessionId}`,
                        relationship_type: 'discussed_in',
                        strength: 3, // Very strong relationship
                        properties: {
                            topic_name: topicData.topic,
                            frequency: topicData.frequency,
                            relationship_source: 'topic_analysis',
                            is_cross_session: topicData.sessions.size > 1
                        },
                        created_at: topicData.earliest_mention
                    });
                }
                
                // Create relationships from topic to related nodes
                for (const nodeId of topicData.nodes) {
                    topicRelationships.push({
                        source: topicId,
                        target: nodeId,
                        relationship_type: 'relates_to',
                        strength: 2,
                        properties: {
                            topic_name: topicData.topic,
                            relationship_source: 'topic_analysis',
                            content_relevance: 'high'
                        },
                        created_at: topicData.earliest_mention
                    });
                }
            }

            // Create cross-session topic continuation relationships
            for (const topicData of crossSessionTopics) {
                if (topicData.sessions.size > 1) {
                    const sessionIds = Array.from(topicData.sessions);
                    
                    // Sort sessions by timestamp to create temporal continuation links
                    const sessionsWithTimes = sessionIds.map(sessionId => {
                        const session = sessionData.get(sessionId);
                        return {
                            sessionId,
                            timestamp: session?.created_at || new Date()
                        };
                    }).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                    
                    // Create "continues_topic" relationships between consecutive sessions
                    for (let i = 1; i < sessionsWithTimes.length; i++) {
                        const prevSession = sessionsWithTimes[i - 1];
                        const currentSession = sessionsWithTimes[i];
                        
                        topicRelationships.push({
                            source: `session_${prevSession.sessionId}`,
                            target: `session_${currentSession.sessionId}`,
                            relationship_type: 'continues_topic',
                            strength: 2,
                            properties: {
                                topic_name: topicData.topic,
                                relationship_source: 'topic_continuation_analysis',
                                time_gap_days: Math.ceil((currentSession.timestamp.getTime() - prevSession.timestamp.getTime()) / (1000 * 60 * 60 * 24))
                            },
                            created_at: currentSession.timestamp
                        });
                    }
                }
            }

            // Filter original relationships to only include ones with valid node connections
            const allNodeIds = new Set([
                ...nodes.map(node => node.id),
                ...sessionNodes.map(node => node.id),
                ...topicNodes.map(node => node.id)
            ]);
            
            const validRelationships = relationships.filter(rel => 
                allNodeIds.has(rel.from_id) && allNodeIds.has(rel.to_id)
            );

            console.log(`📊 Found ${nodes.length} original nodes, ${sessionNodes.length} session nodes, ${topicNodes.length} topic nodes, and ${validRelationships.length + sessionRelationships.length + topicRelationships.length} total relationships`);

            // Combine all nodes and relationships
            const allNodes = [
                ...nodes.map(node => ({
                    id: node.id,
                    type: node.type,
                    name: node.properties?.name || node.properties?.title || `${node.type}_${node.id.slice(-4)}`,
                    description: node.properties?.description,
                    properties: node.properties,
                    created_at: node.created_at,
                    updated_at: node.updated_at
                })),
                ...sessionNodes,
                ...topicNodes
            ];

            const allRelationships = [
                ...validRelationships.map(rel => ({
                    source: rel.from_id,
                    target: rel.to_id,
                    relationship_type: rel.relationship_type,
                    strength: rel.strength || 1,
                    properties: rel.properties,
                    created_at: rel.created_at
                })),
                ...sessionRelationships,
                ...topicRelationships
            ];

            const graphData = {
                nodes: allNodes,
                links: allRelationships
            };

            return c.json({
                success: true,
                graph_data: graphData,
                stats: {
                    total_nodes: allNodes.length,
                    original_nodes: nodes.length,
                    session_nodes: sessionNodes.length,
                    topic_nodes: topicNodes.length,
                    total_relationships: allRelationships.length,
                    original_relationships: validRelationships.length,
                    session_relationships: sessionRelationships.length,
                    topic_relationships: topicRelationships.length,
                    filtered_relationships: relationships.length - validRelationships.length,
                    sessions_found: sessionData.size,
                    cross_session_topics: topicNodes.length,
                    topic_analysis: {
                        total_topics_identified: topicAnalysis.size,
                        cross_session_topics: crossSessionTopics.length,
                        single_session_topics: topicAnalysis.size - crossSessionTopics.length
                    },
                    node_types: [...new Set(allNodes.map(n => n.type))],
                    relationship_types: [...new Set(allRelationships.map(r => r.relationship_type))]
                }
            });

        } catch (error) {
            console.error('❌ Knowledge graph fetch failed:', error);
            return c.json({
                success: false,
                error: 'Failed to fetch knowledge graph data',
                details: error instanceof Error ? error.message : 'Unknown error'
            }, 500);
        }
    });

    // ====== DEBUG TEST ENDPOINT ======
    
    /**
     * Test endpoint to verify direct MongoDB access
     * GET /api/memory/debug-nodes
     */
    router.get('/debug-nodes', async (c) => {
        try {
            if (!DEBUG_ENDPOINTS_ENABLED) {
                return c.json(debugDisabledResponse(), 403);
            }

            const db = get_database();

            console.log('🔍 DEBUG: Direct MongoDB test');
            
            // Get total count
            const totalCount = await db.collection('knowledge_nodes').countDocuments();
            console.log('🔍 DEBUG: Total nodes in collection:', totalCount);
            
            // Get first 3 nodes without any filters
            const nodes = await db.collection('knowledge_nodes')
                .find({})
                .limit(3)
                .toArray();
                
            console.log('🔍 DEBUG: First 3 nodes:', nodes.map(n => ({id: n.id, name: n.properties?.name, type: n.type})));
            
            return c.json({
                success: true,
                total_count: totalCount,
                sample_nodes: nodes.map(node => ({
                    id: node.id,
                    type: node.type,
                    name: node.properties?.name,
                    user_id: node.user_id
                }))
            });
            
        } catch (error) {
            console.error('❌ Debug test failed:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 500);
        }
    });

    /**
     * Debug endpoint to check relationship structure
     * GET /api/memory/debug-relationships
     */
    router.get('/debug-relationships', async (c) => {
        try {
            if (!DEBUG_ENDPOINTS_ENABLED) {
                return c.json(debugDisabledResponse(), 403);
            }

            const db = get_database();

            console.log('🔍 DEBUG: Relationships structure test');
            
            // Get total count
            const totalCount = await db.collection('knowledge_relationships').countDocuments();
            console.log('🔍 DEBUG: Total relationships in collection:', totalCount);
            
            // Get first 3 relationships without any filters
            const relationships = await db.collection('knowledge_relationships')
                .find({})
                .limit(3)
                .toArray();
                
            console.log('🔍 DEBUG: First 3 relationships:', relationships);
            
            return c.json({
                success: true,
                total_count: totalCount,
                sample_relationships: relationships.map(rel => ({
                    // Check all possible field names
                    id: rel.id || rel._id,
                    from_id: rel.from_id,
                    to_id: rel.to_id,
                    source_id: rel.source_id,
                    target_id: rel.target_id,
                    relationship_type: rel.relationship_type,
                    user_id: rel.user_id,
                    // Show all fields to debug structure
                    all_fields: Object.keys(rel)
                }))
            });
            
        } catch (error) {
            console.error('❌ Debug relationships test failed:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 500);
        }
    });

    /**
     * Create test session data for demonstration
     * POST /api/memory/create-test-session-data
     */
    router.post('/create-test-session-data', async (c) => {
        try {
            if (!DEBUG_ENDPOINTS_ENABLED) {
                return c.json(debugDisabledResponse(), 403);
            }

            const db = get_database();
            const body = await c.req.json();
            const user_id = DEFAULT_USER_ID;
            const session_id = body.session_id || `demo_session_${Date.now()}`;

            console.log('🚀 Creating test session data with session_id:', session_id);
            
            // Create test episodic events with session ID
            const events = [
                {
                    id: `event_${Date.now()}_1`,
                    user_id,
                    session_id,
                    event_type: 'user_question',
                    content: { message: 'What is machine learning?' },
                    timestamp: new Date(),
                    processed: false
                },
                {
                    id: `event_${Date.now()}_2`,
                    user_id,
                    session_id,
                    event_type: 'knowledge_extraction',
                    content: { topic: 'machine learning', entities: ['ML', 'algorithms'] },
                    timestamp: new Date(),
                    processed: false
                }
            ];
            
            // Create test knowledge nodes
            const nodes = [
                {
                    id: `node_${Date.now()}_1`,
                    type: 'concept',
                    user_id,
                    session_id,
                    properties: {
                        name: 'Machine Learning',
                        description: 'A field of artificial intelligence that uses algorithms to learn from data',
                        category: 'technology'
                    },
                    created_at: new Date(),
                    updated_at: new Date()
                },
                {
                    id: `node_${Date.now()}_2`,
                    type: 'algorithm',
                    user_id,
                    session_id,
                    properties: {
                        name: 'Neural Networks',
                        description: 'Computing systems inspired by biological neural networks',
                        complexity: 'high'
                    },
                    created_at: new Date(),
                    updated_at: new Date()
                }
            ];
            
            // Create test relationships
            const relationships = [
                {
                    from_id: nodes[0].id,
                    to_id: nodes[1].id,
                    relationship_type: 'uses',
                    strength: 0.8,
                    properties: {
                        context: 'Machine learning uses neural networks as one algorithm type'
                    },
                    created_at: new Date()
                }
            ];
            
            // Create working memory session
            const sessionContext = {
                session_id,
                user_id,
                created_at: new Date(),
                last_activity: new Date(),
                variables: {},
                conversation_history: [
                    {
                        role: 'user',
                        content: 'What is machine learning?',
                        timestamp: new Date()
                    },
                    {
                        role: 'assistant', 
                        content: 'Machine learning is a field of AI that enables computers to learn from data...',
                        timestamp: new Date()
                    }
                ],
                memory_keys: [],
                topic_tags: ['machine learning', 'AI', 'algorithms']
            };
            
            // Insert all test data
            await Promise.all([
                db.collection('episodic_events').insertMany(events),
                db.collection('knowledge_nodes').insertMany(nodes),
                db.collection('knowledge_relationships').insertMany(relationships),
                db.collection('working_memory_sessions').insertOne(sessionContext)
            ]);
            
            console.log('✅ Test session data created successfully');
            
            return c.json({
                success: true,
                session_id,
                created: {
                    events: events.length,
                    nodes: nodes.length,
                    relationships: relationships.length,
                    session_context: 1
                },
                message: 'Test session data created successfully. You can now see session-based relationships in the knowledge graph.'
            });
            
        } catch (error) {
            console.error('❌ Failed to create test session data:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 500);
        }
    });

    /**
     * GET /api/memory/semantic/facts?user_id=...&limit=50
     * List semantic facts (distilled knowledge) for a user
     */
    router.get('/semantic/facts', async (c) => {
        try {
            const user_id = c.req.query('user_id') || DEFAULT_USER_ID;
            const limit = parseInt(c.req.query('limit') || '50');
            const scopeFilter = await buildScopeFilter(user_id);

            const db = get_database();
            const results = await db.collection('semantic_facts')
                .find(scopeFilter)
                .sort({ created_at: -1, timestamp: -1, confidence: -1 })
                .limit(limit)
                .toArray();

            return c.json({
                success: true,
                results: results.map(r => ({
                    id: r._id || r.id,
                    event_type: 'semantic_fact',
                    content: r.content || r.description || r.fact || JSON.stringify(r),
                    timestamp: r.created_at || r.timestamp || new Date(),
                    session_id: r.session_id || '—',
                    user_id: r.user_id,
                    confidence: r.confidence,
                    domain: r.domain,
                    properties: r.properties
                })),
                count: results.length,
                query: { user_id, limit }
            });

        } catch (error) {
            console.error('Failed to list semantic facts:', error);
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }, 500);
        }
    });

    return router;
};