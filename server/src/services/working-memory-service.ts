/**
 * Working Memory Service - High-Performance Redis Implementation
 * 
 * Optimized for <5ms access times with intelligent fallback to MongoDB.
 * Implements full memory management, session context, and performance monitoring.
 */

import { get_redis_client, is_redis_healthy } from '../database/redis-connection.js';
import { get_database } from '../database/connection.js';
import { v4 as uuidv4 } from 'uuid';

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
     * Store item in working memory with intelligent routing
     */
    async store(
        session_id: string,
        content: any,
        metadata: Partial<WorkingMemoryItem['metadata']> = {},
        tags?: string[]
    ): Promise<string> {
        const start_time = performance.now();
        const item_id = uuidv4();
        const now = new Date();
        
        // Calculate content size
        const content_json = JSON.stringify(content);
        const size_bytes = Buffer.byteLength(content_json, 'utf8');
        
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
                await this.add_memory_to_session(session_id, item_id);
                
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
        await this.add_memory_to_session(session_id, item_id);
        
        this.track_response_time(start_time);
        console.log(`✅ Stored working memory item ${item_id} in MongoDB (${size_bytes} bytes)`);
        return item_id;
    }

    /**
     * Retrieve item from working memory with performance optimization
     */
    async retrieve(item_id: string, update_access_count: boolean = true): Promise<WorkingMemoryItem | null> {
        const start_time = performance.now();
        
        try {
            // Try Redis first
            const redis = await get_redis_client();
            if (redis) {
                const redis_key = `${this.REDIS_PREFIX}${item_id}`;
                const result = await redis.get(redis_key);
                
                if (result) {
                    const memory_item = JSON.parse(result) as WorkingMemoryItem;
                    
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
        const memory_item = await db.collection('working_memory').findOne({ id: item_id });
        
        if (memory_item && update_access_count) {
            await db.collection('working_memory').updateOne(
                { id: item_id },
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
        session_id: string, 
        user_id?: string,
        initial_context?: Partial<SessionContext>
    ): Promise<boolean> {
        const start_time = performance.now();
        
        const session_context: SessionContext = {
            session_id,
            user_id,
            created_at: new Date(),
            last_activity: new Date(),
            variables: {},
            conversation_history: [],
            memory_keys: [],
            topic_tags: [],
            ...initial_context
        };

        try {
            const redis = await get_redis_client();
            if (redis) {
                const session_key = `${this.SESSION_PREFIX}${session_id}`;
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
                { session_id }, 
                session_context, 
                { upsert: true }
            );
        
        this.track_response_time(start_time);
        return result.upsertedCount > 0 || result.modifiedCount > 0;
    }

    /**
     * Get session context with full conversation history
     */
    async get_session_context(session_id: string): Promise<SessionContext | null> {
        const start_time = performance.now();
        
        try {
            const redis = await get_redis_client();
            if (redis) {
                const session_key = `${this.SESSION_PREFIX}${session_id}`;
                const result = await redis.get(session_key);
                
                if (result) {
                    this.cache_hits++;
                    this.redis_ops++;
                    this.track_response_time(start_time);
                    return JSON.parse(result) as SessionContext;
                }
            }
        } catch (error) {
            console.error('❌ Redis session retrieve failed:', error);
            this.mongodb_fallbacks++;
        }

        // Fallback to MongoDB
        this.cache_misses++;
        const db = get_database();
        const session_context = await db.collection('working_memory_sessions')
            .findOne({ session_id });
        
        this.track_response_time(start_time);
        return session_context as unknown as SessionContext | null;
    }

    /**
     * Add conversation message to session context
     */
    async add_conversation_message(
        session_id: string,
        role: 'user' | 'assistant',
        content: string,
        memory_refs?: string[]
    ): Promise<boolean> {
        const session_context = await this.get_session_context(session_id);
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

        return await this.update_session_context(session_id, session_context);
    }

    /**
     * Get session memory items with filtering and sorting
     */
    async get_session_memory(
        session_id: string, 
        limit: number = 50,
        priority_filter?: number
    ): Promise<WorkingMemoryItem[]> {
        const session_context = await this.get_session_context(session_id);
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
    async warm_cache(session_id: string, preload_memory: boolean = true): Promise<void> {
        console.log(`🔥 Warming cache for session ${session_id}`);
        const start_time = performance.now();
        
        // Preload session context
        await this.get_session_context(session_id);
        
        if (preload_memory) {
            // Preload recent memory items
            const memory_items = await this.get_session_memory(session_id, 20, 6); // High priority items
            console.log(`🔥 Preloaded ${memory_items.length} memory items for session ${session_id}`);
        }
        
        const duration = performance.now() - start_time;
        console.log(`✅ Cache warmed for session ${session_id} in ${duration.toFixed(2)}ms`);
    }

    /**
     * Delete memory item from all storage
     */
    async delete(item_id: string): Promise<boolean> {
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
        
        // Delete from MongoDB
        const db = get_database();
        const result = await db.collection('working_memory').deleteOne({ id: item_id });
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
    private async add_memory_to_session(session_id: string, memory_id: string): Promise<void> {
        let session_context = await this.get_session_context(session_id);
        if (!session_context) {
            // Auto-create session context so stored items are retrievable via get_session_memory.
            // Without this, the memory item is stored but orphaned — its key never lands in any
            // session's memory_keys list, so get_session_memory always returns [].
            session_context = {
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
        
        await this.update_session_context(session_id, session_context);
    }
    
    private async update_session_context(session_id: string, context: SessionContext): Promise<boolean> {
        try {
            const redis = await get_redis_client();
            if (redis) {
                const session_key = `${this.SESSION_PREFIX}${session_id}`;
                await redis.setEx(session_key, this.DEFAULT_TTL, JSON.stringify(context));
                return true;
            }
        } catch (error) {
            console.error('❌ Redis session update failed:', error);
        }
        
        // Fallback to MongoDB
        const db = get_database();
        const result = await db.collection('working_memory_sessions')
            .replaceOne({ session_id }, context, { upsert: true });
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
}

// Export singleton instance
export const working_memory_service = new WorkingMemoryService();