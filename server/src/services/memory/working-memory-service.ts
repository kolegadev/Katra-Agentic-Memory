/**
 * Working Memory Service - High-Performance Redis Implementation
 * 
 * Optimized for <5ms access times with intelligent fallback to MongoDB.
 * Implements full memory management, session context, and performance monitoring.
 */

import { get_redis_client, is_redis_healthy } from '../../database/redis-connection.js';
import { get_database } from '../../database/connection.js';
import { v4 as uuidv4 } from 'uuid';
import { DecisionActionService } from '../processing/decision-action-service.js';

export interface WorkingMemoryItem {
    id: string;
    session_id: string;
    user_id?: string;
    content: any;
    metadata: {
        created_at: Date;
        updated_at: Date;
        access_count: number;
        last_accessed: Date;
        ttl_seconds?: number;
        priority?: number; // 1-10, higher = more important
        content_type?: 'text' | 'json' | 'binary';
        size_bytes?: number;
    };
    tags?: string[];
}

export interface SessionContext {
    tenant_id: string; // Required isolation boundary — must come from authenticated principal
    session_id: string;
    user_id?: string;
    created_at: Date;
    last_activity: Date;
    variables: Record<string, any>;
    conversation_history: Array<{
        role: 'user' | 'assistant';
        content: string;
        timestamp: Date;
        memory_refs?: string[]; // References to related memory items
    }>;
    memory_keys: string[];
    context_summary?: string; // LLM-generated session summary
    topic_tags?: string[]; // Extracted topics for this session
}

export interface WorkingMemoryStats {
    redis_available: boolean;
    total_items: number;
    active_sessions: number;
    cache_hit_rate: number;
    average_access_time_ms: number;
    memory_usage_mb: number;
    performance_metrics: {
        redis_ops: number;
        mongodb_fallbacks: number;
        avg_response_time: number;
    };
}

/**
 * High-Performance Working Memory Service
 * Target: <5ms access time, 99.9% availability
 */
export class WorkingMemoryService {
    private readonly REDIS_PREFIX = 'wm:';
    private readonly SESSION_PREFIX = 'session:';
    private readonly STATS_PREFIX = 'stats:';
    private readonly DEFAULT_TTL = 3600; // 1 hour
    private readonly HIGH_PRIORITY_TTL = 7200; // 2 hours for important items
    private readonly MAX_CONTENT_SIZE = 1024 * 1024; // 1MB limit for Redis
    
    // Performance tracking
    private cache_hits = 0;
    private cache_misses = 0;
    private redis_ops = 0;
    private mongodb_fallbacks = 0;
    private response_times: number[] = [];

    /**
     * Validates that tenant_id is a non-empty string and does not contain the key
     * delimiter ':'. tenant_id MUST originate from the authenticated principal
     * (e.g. DEFAULT_USER_ID), never from request-body fields, which are
     * attacker-controlled.
     */
    private assertTenant(tenant_id: string): void {
        if (typeof tenant_id !== 'string' || tenant_id.trim().length === 0) {
            throw new Error('tenant_id is required and must be a non-empty string');
        }
        if (tenant_id.includes(':')) {
            throw new Error('tenant_id must not contain ":"');
        }
    }

    /**
     * Single source of truth for session storage keys. Centralising key
     * construction guarantees no code path can build an unscoped key.
     * Format: session:{tenant_id}:{session_id}
     */
    private sessionKey(tenant_id: string, session_id: string): string {
        this.assertTenant(tenant_id);
        if (typeof session_id !== 'string' || session_id.trim().length === 0) {
            throw new Error('session_id is required and must be a non-empty string');
        }
        if (session_id.includes(':')) {
            throw new Error('session_id must not contain ":"');
        }
        return `${this.SESSION_PREFIX}${tenant_id}:${session_id}`;
    }

    /**
     * Store item in working memory with intelligent routing
     */
    async store(
        tenant_id: string,
        session_id: string,
        content: any,
        metadata: Partial<WorkingMemoryItem['metadata']> = {},
        tags?: string[]
    ): Promise<string> {
        this.assertTenant(tenant_id);
        const start_time = performance.now();
        const item_id = uuidv4();
        const now = new Date();
        
        // Reject dangerous content to prevent prototype pollution and DoS
        if (content === null || content === undefined) {
          throw new Error('Content cannot be null or undefined');
        }
        if (typeof content === 'object' && !Array.isArray(content)) {
          const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
          for (const key of dangerousKeys) {
            if (Object.prototype.hasOwnProperty.call(content, key)) {
              throw new Error(`Rejected dangerous content key: ${key}`);
            }
          }
        }
        
        // Calculate content size — cap at 5MB
        const content_json = JSON.stringify(content);
        const size_bytes = Buffer.byteLength(content_json, 'utf8');
        if (size_bytes > 5 * 1024 * 1024) {
          throw new Error(`Content exceeds maximum size of 5MB (${(size_bytes / 1024 / 1024).toFixed(1)}MB)`);
        }
        
        const memory_item: WorkingMemoryItem = {
            id: item_id,
            session_id,
            content,
            metadata: {
                created_at: now,
                updated_at: now,
                access_count: 0,
                last_accessed: now,
                ttl_seconds: metadata.ttl_seconds || this.DEFAULT_TTL,
                priority: metadata.priority || 5,
                content_type: metadata.content_type || 'json',
                size_bytes,
                ...metadata
            },
            tags
        };

        try {
            // Use Redis for small, high-priority items
            const redis = await get_redis_client();
            if (redis && size_bytes < this.MAX_CONTENT_SIZE) {
                const redis_key = `${this.REDIS_PREFIX}${item_id}`;
                const ttl = memory_item.metadata.priority! > 7 
                    ? this.HIGH_PRIORITY_TTL 
                    : (memory_item.metadata.ttl_seconds || this.DEFAULT_TTL);
                
                await redis.setEx(redis_key, ttl, JSON.stringify(memory_item));
                
                // Also update session memory keys
                await this.add_memory_to_session(tenant_id, session_id, item_id);
                
                this.redis_ops++;
                this.track_response_time(start_time);
                console.log(`✅ Stored working memory item ${item_id} in Redis (${size_bytes} bytes, TTL: ${ttl}s)`);
                return item_id;
            }
        } catch (error) {
            console.error('❌ Redis store failed, falling back to MongoDB:', error);
            this.mongodb_fallbacks++;
        }

        // Fallback to MongoDB for large items or Redis failure
        const db = get_database();
        await db.collection('working_memory').insertOne(memory_item);
        await this.add_memory_to_session(tenant_id, session_id, item_id);
        
        this.track_response_time(start_time);
        console.log(`✅ Stored working memory item ${item_id} in MongoDB (${size_bytes} bytes)`);
        return item_id;
    }

    /**
     * Retrieve item from working memory with performance optimization
     */
    async retrieve(item_id: string, update_access_count: boolean = true, tenant_id?: string): Promise<WorkingMemoryItem | null> {
        const start_time = performance.now();
        
        try {
            // Try Redis first
            const redis = await get_redis_client();
            if (redis) {
                const redis_key = `${this.REDIS_PREFIX}${item_id}`;
                const result = await redis.get(redis_key);
                
                if (result) {
                    const memory_item = JSON.parse(result) as WorkingMemoryItem;
                    
                    // Tenant scope check — reject if tenant_id provided and doesn't match
                    if (tenant_id && memory_item.tenant_id && memory_item.tenant_id !== tenant_id) {
                        return null;
                    }
                    
                    // Update access metadata if requested
                    if (update_access_count) {
                        memory_item.metadata.access_count++;
                        memory_item.metadata.last_accessed = new Date();
                        await redis.setEx(redis_key, memory_item.metadata.ttl_seconds || this.DEFAULT_TTL, 
                                         JSON.stringify(memory_item));
                    }
                    
                    this.cache_hits++;
                    this.redis_ops++;
                    this.track_response_time(start_time);
                    return memory_item;
                }
            }
        } catch (error) {
            console.error('❌ Redis retrieve failed, falling back to MongoDB:', error);
            this.mongodb_fallbacks++;
        }

        // Fallback to MongoDB
        this.cache_misses++;
        const db = get_database();
        const mongoFilter: any = { id: item_id };
        if (tenant_id) mongoFilter.tenant_id = tenant_id;
        const memory_item = await db.collection('working_memory').findOne(mongoFilter);
        
        if (memory_item && update_access_count) {
            await db.collection('working_memory').updateOne(
                mongoFilter,
                { 
                    $inc: { 'metadata.access_count': 1 },
                    $set: { 'metadata.last_accessed': new Date() }
                }
            );
        }
        
        this.track_response_time(start_time);
        return memory_item as unknown as WorkingMemoryItem | null;
    }

    /**
     * Create or update session context with topic extraction
     */
    async store_session_context(
        tenant_id: string,
        session_id: string,
        user_id?: string,
        initial_context?: Partial<SessionContext>
    ): Promise<boolean> {
        this.assertTenant(tenant_id);
        const start_time = performance.now();
        
        const session_context: SessionContext = {
            session_id,
            tenant_id,
            user_id,
            created_at: new Date(),
            last_activity: new Date(),
            variables: {},
            conversation_history: [],
            memory_keys: [],
            topic_tags: [],
            ...initial_context,
            // Always override with authoritative values after spread
            tenant_id,
            session_id,
        };

        try {
            const redis = await get_redis_client();
            if (redis) {
                const session_key = this.sessionKey(tenant_id, session_id);
                await redis.setEx(session_key, this.DEFAULT_TTL, JSON.stringify(session_context));
                
                this.redis_ops++;
                this.track_response_time(start_time);
                console.log(`✅ Stored session context ${session_id} in Redis`);
                return true;
            }
        } catch (error) {
            console.error('❌ Redis session store failed:', error);
            this.mongodb_fallbacks++;
        }

        // Fallback to MongoDB
        const db = get_database();
        const result = await db.collection('working_memory_sessions')
            .replaceOne(
                { session_id, tenant_id }, 
                session_context, 
                { upsert: true }
            );
        
        this.track_response_time(start_time);
        return result.upsertedCount > 0 || result.modifiedCount > 0;
    }

    /**
     * Get session context with full conversation history.
     * Returns null if the session does not exist or belongs to a different tenant.
     */
    async get_session_context(tenant_id: string, session_id: string): Promise<SessionContext | null> {
        this.assertTenant(tenant_id);
        const start_time = performance.now();
        
        try {
            const redis = await get_redis_client();
            if (redis) {
                const session_key = this.sessionKey(tenant_id, session_id);
                const result = await redis.get(session_key);
                
                if (result) {
                    const ctx = JSON.parse(result) as SessionContext;
                    // Defense-in-depth: verify stored tenant matches requested tenant
                    if (ctx.tenant_id !== tenant_id) {
                        console.error(`❌ Tenant mismatch on cached session ${session_id} — denying`);
                        return null;
                    }
                    this.cache_hits++;
                    this.redis_ops++;
                    this.track_response_time(start_time);
                    return ctx;
                }
            }
        } catch (error) {
            console.error('❌ Redis session retrieve failed:', error);
            this.mongodb_fallbacks++;
        }

        // Fallback to MongoDB — filter MUST include tenant_id
        this.cache_misses++;
        const db = get_database();
        const session_context = await db.collection('working_memory_sessions')
            .findOne({ session_id, tenant_id });
        
        if (session_context && session_context.tenant_id !== tenant_id) {
            console.error(`❌ Tenant mismatch on stored session ${session_id} — denying`);
            this.track_response_time(start_time);
            return null;
        }
        
        this.track_response_time(start_time);
        return session_context as unknown as SessionContext | null;
    }

    /**
     * Add conversation message to session context
     */
    async add_conversation_message(
        tenant_id: string,
        session_id: string,
        role: 'user' | 'assistant',
        content: string,
        memory_refs?: string[]
    ): Promise<boolean> {
        const session_context = await this.get_session_context(tenant_id, session_id);
        if (!session_context) {
            console.error(`❌ Session context not found: ${session_id}`);
            return false;
        }

        const message = {
            role,
            content,
            timestamp: new Date(),
            memory_refs
        };

        session_context.conversation_history.push(message);
        session_context.last_activity = new Date();
        
        // Keep only last 50 messages to manage memory
        if (session_context.conversation_history.length > 50) {
            session_context.conversation_history = session_context.conversation_history.slice(-50);
        }

        return await this.update_session_context(tenant_id, session_id, session_context);
    }

    /**
     * Get session memory items with filtering and sorting
     */
    async get_session_memory(
        tenant_id: string,
        session_id: string, 
        limit: number = 50,
        priority_filter?: number
    ): Promise<WorkingMemoryItem[]> {
        const session_context = await this.get_session_context(tenant_id, session_id);
        if (!session_context?.memory_keys.length) {
            return [];
        }

        const memory_items: WorkingMemoryItem[] = [];
        
        // Retrieve items in parallel for better performance
        const retrieval_promises = session_context.memory_keys
            .slice(0, limit * 2) // Get extra items for filtering
            .map(key => this.retrieve(key, false));
        
        const results = await Promise.allSettled(retrieval_promises);
        
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                const item = result.value;
                
                // Apply priority filter if specified
                if (priority_filter && item.metadata.priority! < priority_filter) {
                    continue;
                }
                
                memory_items.push(item);
            }
        }

        // Sort by priority (desc) and recency (desc)
        return memory_items
            .sort((a, b) => {
                if (a.metadata.priority !== b.metadata.priority) {
                    return (b.metadata.priority || 5) - (a.metadata.priority || 5);
                }
                return new Date(b.metadata.last_accessed).getTime() - new Date(a.metadata.last_accessed).getTime();
            })
            .slice(0, limit);
    }

    /**
     * Warm cache by preloading session data
     */
    async warm_cache(tenant_id: string, session_id: string, preload_memory: boolean = true): Promise<void> {
        console.log(`🔥 Warming cache for session ${session_id}`);
        const start_time = performance.now();
        
        // Preload session context
        await this.get_session_context(tenant_id, session_id);
        
        if (preload_memory) {
            // Preload recent memory items
            const memory_items = await this.get_session_memory(tenant_id, session_id, 20, 6); // High priority items
            console.log(`🔥 Preloaded ${memory_items.length} memory items for session ${session_id}`);
        }
        
        const duration = performance.now() - start_time;
        console.log(`✅ Cache warmed for session ${session_id} in ${duration.toFixed(2)}ms`);
    }

    /**
     * Delete memory item from all storage
     */
    async delete(item_id: string, tenant_id?: string): Promise<boolean> {
        const start_time = performance.now();
        let deleted = false;
        
        try {
            // Delete from Redis
            const redis = await get_redis_client();
            if (redis) {
                const redis_key = `${this.REDIS_PREFIX}${item_id}`;
                const result = await redis.del(redis_key);
                if (result > 0) deleted = true;
                this.redis_ops++;
            }
        } catch (error) {
            console.error('❌ Redis delete failed:', error);
        }
        
        // Delete from MongoDB — scoped by tenant_id when provided
        const db = get_database();
        const mongoFilter: any = { id: item_id };
        if (tenant_id) mongoFilter.tenant_id = tenant_id;
        const result = await db.collection('working_memory').deleteOne(mongoFilter);
        if (result.deletedCount > 0) deleted = true;
        
        this.track_response_time(start_time);
        return deleted;
    }

    /**
     * Clean up expired items and optimize performance
     */
    async cleanup_expired(): Promise<{ deleted_count: number; freed_memory_mb: number }> {
        console.log('🧹 Starting working memory cleanup');
        let deleted_count = 0;
        let freed_memory_mb = 0;
        
        try {
            const redis = await get_redis_client();
            if (redis) {
                // Redis handles TTL automatically, just get stats
                const keys = await redis.keys(`${this.REDIS_PREFIX}*`);
                console.log(`ℹ️ Redis has ${keys.length} working memory items`);
            }
        } catch (error) {
            console.error('❌ Redis cleanup check failed:', error);
        }
        
        // Clean up expired MongoDB items
        const db = get_database();
        const expiry_cutoff = new Date(Date.now() - (this.DEFAULT_TTL * 1000));
        
        const expired_items = await db.collection('working_memory')
            .find({ 'metadata.created_at': { $lt: expiry_cutoff } })
            .toArray();
        
        for (const item of expired_items) {
            freed_memory_mb += (item.metadata?.size_bytes || 0) / (1024 * 1024);
        }
        
        const delete_result = await db.collection('working_memory')
            .deleteMany({ 'metadata.created_at': { $lt: expiry_cutoff } });
        
        deleted_count = delete_result.deletedCount || 0;
        
        console.log(`✅ Cleanup complete: ${deleted_count} items deleted, ${freed_memory_mb.toFixed(2)}MB freed`);
        return { deleted_count, freed_memory_mb };
    }

    /**
     * Get comprehensive performance statistics
     */
    async get_statistics(): Promise<WorkingMemoryStats> {
        const redis_available = await is_redis_healthy();
        let total_items = 0;
        let active_sessions = 0;
        let memory_usage_mb = 0;
        
        try {
            const redis = await get_redis_client();
            if (redis) {
                // Count Redis items
                const memory_keys = await redis.keys(`${this.REDIS_PREFIX}*`);
                const session_keys = await redis.keys(`${this.SESSION_PREFIX}*`);
                
                total_items += memory_keys.length;
                active_sessions = session_keys.length;
                
                // Estimate Redis memory usage
                const info = await redis.info('memory');
                const memory_match = info.match(/used_memory:(\d+)/);
                if (memory_match) {
                    memory_usage_mb = parseInt(memory_match[1]) / (1024 * 1024);
                }
            }
        } catch (error) {
            console.error('❌ Redis statistics failed:', error);
        }
        
        // Add MongoDB statistics
        const db = get_database();
        const mongodb_count = await db.collection('working_memory').countDocuments();
        const mongodb_sessions = await db.collection('working_memory_sessions').countDocuments();
        
        total_items += mongodb_count;
        active_sessions = Math.max(active_sessions, mongodb_sessions);
        
        // Calculate performance metrics
        const total_requests = this.cache_hits + this.cache_misses;
        const cache_hit_rate = total_requests > 0 ? this.cache_hits / total_requests : 0;
        const avg_response_time = this.response_times.length > 0 
            ? this.response_times.reduce((a, b) => a + b) / this.response_times.length 
            : 0;
        
        return {
            redis_available,
            total_items,
            active_sessions,
            cache_hit_rate,
            average_access_time_ms: avg_response_time,
            memory_usage_mb,
            performance_metrics: {
                redis_ops: this.redis_ops,
                mongodb_fallbacks: this.mongodb_fallbacks,
                avg_response_time
            }
        };
    }

    /**
     * Private helper methods
     */
    private async add_memory_to_session(tenant_id: string, session_id: string, memory_id: string): Promise<void> {
        let session_context = await this.get_session_context(tenant_id, session_id);
        if (!session_context) {
            // Auto-create session context so stored items are retrievable via get_session_memory.
            // Without this, the memory item is stored but orphaned — its key never lands in any
            // session's memory_keys list, so get_session_memory always returns [].
            session_context = {
                tenant_id,
                session_id,
                created_at: new Date(),
                last_activity: new Date(),
                variables: {},
                conversation_history: [],
                memory_keys: [],
                topic_tags: [],
            };
        }
        session_context.memory_keys.push(memory_id);
        session_context.last_activity = new Date();
        
        // Keep only last 100 memory keys to manage size
        if (session_context.memory_keys.length > 100) {
            session_context.memory_keys = session_context.memory_keys.slice(-100);
        }
        
        await this.update_session_context(tenant_id, session_id, session_context);
    }
    
    private async update_session_context(tenant_id: string, session_id: string, context: SessionContext): Promise<boolean> {
        // Always stamp authoritative tenant_id and session_id onto the persisted document
        const scoped_context: SessionContext = { ...context, tenant_id, session_id };

        try {
            const redis = await get_redis_client();
            if (redis) {
                const session_key = this.sessionKey(tenant_id, session_id);
                await redis.setEx(session_key, this.DEFAULT_TTL, JSON.stringify(scoped_context));
                return true;
            }
        } catch (error) {
            console.error('❌ Redis session update failed:', error);
        }
        
        // Fallback to MongoDB — filter and document both carry tenant_id
        const db = get_database();
        const result = await db.collection('working_memory_sessions')
            .replaceOne({ session_id, tenant_id }, scoped_context, { upsert: true });
        return result.upsertedCount > 0 || result.modifiedCount > 0;
    }
    
    private track_response_time(start_time: number): void {
        const duration = performance.now() - start_time;
        this.response_times.push(duration);
        
        // Keep only last 1000 measurements
        if (this.response_times.length > 1000) {
            this.response_times = this.response_times.slice(-1000);
        }
    }

    // ── Active Working Memory (PFC) ──────────────────────────────────
    private readonly ACTIVE_SET_PREFIX = 'active:';
    private readonly MAX_ACTIVE_ITEMS = 5;
    private readonly DECAY_RATE = 0.10;  // 10% per minute
    private readonly STRENGTH_FLOOR = 0.2;
    private readonly EVICTED_PREFIX = 'evicted:';
    private readonly REGRET_TTL = 3600;  // 1 hour to detect regret

    /**
     * Add an item to the active working memory set. Enforces capacity limit
     * by evicting the lowest-salience item when full.
     */
    async addToActiveSet(
        tenantId: string,
        sessionId: string,
        content: string,
        salience: number = 0.5,
        tags: string[] = []
    ): Promise<string> {
        const redis = await get_redis_client();
        const key = `${this.ACTIVE_SET_PREFIX}${tenantId}:${sessionId}`;
        const id = `active_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const now = Date.now();

        const item = {
            id,
            content,
            salience: Math.max(0, Math.min(1, salience)),
            strength: 1.0,
            addedAt: now,
            lastRehearsedAt: now,
            tags,
        };

        // Use sorted set: score = salience for eviction ordering
        await redis.zadd(key, item.salience, JSON.stringify(item));

        // ── Bottleneck: capacity 5 forces eviction choice ──────────
        // Each eviction is an RL decision: "which item do I sacrifice?"
        // Regret signal: if evicted item is later recalled, that was bad.
        const count = await redis.zcard(key);
        if (count > this.MAX_ACTIVE_ITEMS) {
            // Get all items to choose which to evict
            const allItems = await redis.zrange(key, 0, -1);
            const parsed: any[] = allItems.map((r: string) => JSON.parse(r));

            // Choose eviction target: lowest salience + strength combo
            // (RL learns which combinations are worth keeping over time)
            parsed.sort((a, b) =>
                (a.salience * a.strength) - (b.salience * b.strength)
            );

            const toRemove = count - this.MAX_ACTIVE_ITEMS;
            for (let i = 0; i < toRemove && i < parsed.length; i++) {
                const victim = parsed[i];
                // Record eviction in regret tracker
                await redis.setex(
                    `${this.EVICTED_PREFIX}${tenantId}:${victim.id}`,
                    this.REGRET_TTL,
                    JSON.stringify({ id: victim.id, content: victim.content, evictedAt: Date.now() })
                );
                // Record RL outcome: expected to be a good eviction
                try {
                    DecisionActionService.get_instance().recordOutcome(
                        `wm_eviction:${sessionId}`,
                        victim.id,
                        0.7,  // Expected: this was a reasonable eviction
                        0.5   // Actual: neutral until regret/confirmation
                    );
                } catch { /* non-critical */ }
            }

            // Remove lowest items
            await redis.zremrangebyrank(key, 0, toRemove - 1);
        }

        // Set TTL on the key
        await redis.expire(key, 3600);

        return id;
    }

    /**
     * Rehearse all active items: refresh strength to 1.0 and apply
     * decay to items NOT rehearsed since last call.
     */
    async rehearse(tenantId: string, sessionId: string): Promise<void> {
        const redis = await get_redis_client();
        const key = `${this.ACTIVE_SET_PREFIX}${tenantId}:${sessionId}`;
        const now = Date.now();

        const raw = await redis.zrange(key, 0, -1);
        if (raw.length === 0) return;

        const items: any[] = raw.map((r: string) => JSON.parse(r));
        const decayed: any[] = [];

        for (const item of items) {
            const minutesSinceRehearsal = (now - item.lastRehearsedAt) / 60000;
            const decay = this.DECAY_RATE * minutesSinceRehearsal;
            item.strength = Math.max(this.STRENGTH_FLOOR, item.strength - decay);
            item.lastRehearsedAt = now;
            decayed.push(item);
        }

        // Rebuild the sorted set with updated items (salience-weighted)
        await redis.del(key);
        for (const item of decayed) {
            if (item.strength > this.STRENGTH_FLOOR) {
                await redis.zadd(key, item.salience, JSON.stringify(item));
            }
        }
        await redis.expire(key, 3600);
    }

    /**
     * Filter active items by goal relevance. Items matching goal terms
     * retain full score; irrelevant items are down-weighted.
     */
    async filterByGoal(
        tenantId: string,
        sessionId: string,
        goalTerms: string[]
    ): Promise<any[]> {
        const redis = await get_redis_client();
        const key = `${this.ACTIVE_SET_PREFIX}${tenantId}:${sessionId}`;

        const raw = await redis.zrange(key, 0, -1);
        if (raw.length === 0) return [];

        const lowerTerms = goalTerms.map(t => t.toLowerCase());
        const items: any[] = raw.map((r: string) => JSON.parse(r));

        return items
            .filter(item => item.strength > this.STRENGTH_FLOOR)
            .map(item => {
                const contentLower = (item.content || '').toLowerCase();
                const tagMatch = (item.tags || []).some((t: string) =>
                    lowerTerms.some(g => t.toLowerCase().includes(g))
                );
                const contentMatch = lowerTerms.some(g => contentLower.includes(g));
                return {
                    ...item,
                    goalRelevance: tagMatch || contentMatch ? 1.0 : 0.3,
                };
            })
            .sort((a, b) => b.goalRelevance * b.salience - a.goalRelevance * a.salience);
    }

    /**
     * Get active items above decay threshold.
     */
    async getActiveItems(tenantId: string, sessionId: string): Promise<any[]> {
        const redis = await get_redis_client();
        const key = `${this.ACTIVE_SET_PREFIX}${tenantId}:${sessionId}`;

        const raw = await redis.zrevrange(key, 0, -1);
        if (raw.length === 0) return [];

        return raw
            .map((r: string) => JSON.parse(r))
            .filter((item: any) => item.strength > this.STRENGTH_FLOOR);
    }

    /**
     * Bottleneck → RL: Check if a requested item was recently evicted.
     * If so, that was a bad eviction — feed negative RL signal (regret).
     * Call this when an item that was evicted is later accessed.
     */
    async detectRegret(tenantId: string, itemId: string, sessionId: string): Promise<boolean> {
        const redis = await get_redis_client();
        const regretKey = `${this.EVICTED_PREFIX}${tenantId}:${itemId}`;
        const evicted = await redis.get(regretKey);

        if (evicted) {
            // Regret detected — the evicted item was needed again
            try {
                DecisionActionService.get_instance().recordOutcome(
                    `wm_eviction:${sessionId}`,
                    itemId,
                    0.7,   // Expected: good eviction
                    0.15   // Actual: regretted (item was needed)
                );
            } catch { /* non-critical */ }
            await redis.del(regretKey); // Clear after recording
            return true;
        }
        return false;
    }
}

// Export singleton instance
export const working_memory_service = new WorkingMemoryService();
