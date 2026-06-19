/**
 * Episodic Event Manager
 * 
 * Handles creation, deduplication, and management of episodic events
 * with enhanced content-based hashing, cascade detection, and distributed locking
 * to prevent duplicate storage and temporal reference loops.
 */

import { createHash } from 'crypto';
import { get_database } from '../database/connection.js';
import { get_redis_client } from '../database/redis-connection.js';
import { llmService } from './llm-service.js';
import type { Db, Collection } from 'mongodb';

/**
 * Cascade Detection Circuit Breaker
 * Prevents temporal reference loops and cascading event creation
 */
class CascadeDetector {
  private recentProcessing: Map<string, Set<string>> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up old entries every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 300000);
  }

  /**
   * Detect and prevent cascade processing
   */
  detectAndPrevent(session_id: string, content_hash: string): boolean {
    const recentKey = `${session_id}:${Math.floor(Date.now() / 60000)}`;
    const processedHashes = this.recentProcessing.get(recentKey) || new Set();
    
    if (processedHashes.has(content_hash)) {
      console.warn(`🛑 Cascade detected - blocking duplicate processing for session ${session_id}`);
      return true; // Block processing
    }
    
    processedHashes.add(content_hash);
    this.recentProcessing.set(recentKey, processedHashes);
    return false;
  }

  /**
   * Clean up old entries to prevent memory leaks
   */
  private cleanup(): void {
    const currentMinute = Math.floor(Date.now() / 60000);
    const cutoffMinute = currentMinute - 10; // Keep last 10 minutes
    
    for (const [key, _] of this.recentProcessing) {
      const keyMinute = parseInt(key.split(':').pop() || '0');
      if (keyMinute < cutoffMinute) {
        this.recentProcessing.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

/**
 * Redis-based Distributed Lock Manager
 * Uses SET NX EX for atomic lock acquisition and safe release.
 */
class RedisLockManager {
  private processorId: string;

  constructor() {
    this.processorId = process.env.HOSTNAME || `${process.pid}`;
  }

  /**
   * Acquire a distributed lock via Redis SET NX EX
   */
  async acquireLock(lockKey: string, ttlSeconds: number = 300): Promise<boolean> {
    const client = await get_redis_client();
    if (!client) {
      console.warn('⚠️ Redis unavailable, cannot acquire distributed lock');
      return false;
    }
    try {
      const result = await client.set(lockKey, this.processorId, { NX: true, EX: ttlSeconds });
      return result === 'OK';
    } catch (error) {
      console.error('❌ Redis lock acquisition failed:', error);
      return false;
    }
  }

  /**
   * Release a distributed lock safely (only if we own it)
   */
  async releaseLock(lockKey: string): Promise<void> {
    const client = await get_redis_client();
    if (!client) return;
    try {
      const current = await client.get(lockKey);
      if (current === this.processorId) {
        await client.del(lockKey);
      }
    } catch (error) {
      console.error('❌ Redis lock release failed:', error);
    }
  }

  destroy(): void {
    // No persistent timers or resources to clean up
  }
}

export interface EpisodicEventData {
  user_id: string;
  shared_id?: string;
  session_id: string;
  event_type: string;
  content: {
    role?: 'user' | 'assistant';
    message: string;
    context?: string;
    [key: string]: any;
  };
  timestamp?: Date;
  metadata?: {
    source?: string;
    processed?: boolean;
    [key: string]: any;
  };
}

export interface StoredEpisodicEvent extends EpisodicEventData {
  _id?: any;
  id: string;
  content_hash: string;
  idempotency_key: string;
  timestamp: Date;
  metadata: {
    processed: boolean;
    created_at: Date;
    updated_at: Date;
    source: string;
    access_count: number;
    cascade_depth: number;
    processing_version: number;
    duplicate_prevention_applied: string[];
    [key: string]: any;
  };
  processing_lineage?: {
    parent_event_id?: string;
    derived_from_events: string[];
    triggered_by?: string;
  };
}

export interface EventCreationResult {
  event: StoredEpisodicEvent;
  was_duplicate: boolean;
  duplicate_of?: string;
  action_taken: 'created' | 'updated_metadata' | 'no_change' | 'cascade_blocked';
}

export class EpisodicEventManager {
  private db: Db;
  private collection: Collection;
  private processingDebounceTimer: NodeJS.Timeout | null = null;
  private pendingProcessingEventIds: Set<string> = new Set();
  private cascadeDetector: CascadeDetector;
  private lockManager: RedisLockManager;

  constructor() {
    this.db = get_database();
    this.collection = this.db.collection('episodic_events');
    this.cascadeDetector = new CascadeDetector();
    this.lockManager = new RedisLockManager();
  }

  /**
   * Cleanup resources when shutting down
   */
  destroy(): void {
    this.cascadeDetector.destroy();
    this.lockManager.destroy();
    if (this.processingDebounceTimer) {
      clearTimeout(this.processingDebounceTimer);
    }
  }

  /**
   * Create or update an episodic event with enhanced deduplication and cascade detection
   */
  async createEvent(eventData: EpisodicEventData): Promise<EventCreationResult> {
    // Generate content hash and idempotency key
    const contentHash = this.generateContentHash(eventData);
    const idempotencyKey = this.generateIdempotencyKey(eventData, contentHash);
    
    // Apply cascade detection circuit breaker
    const cascadeBlocked = this.cascadeDetector.detectAndPrevent(eventData.session_id, contentHash);
    if (cascadeBlocked) {
      // Return the existing event without creating a new one
      const existingDocument = await this.collection.findOne({
        content_hash: contentHash
      });
      const existingEvent = existingDocument as unknown as StoredEpisodicEvent | null;
      
      if (existingEvent) {
        return {
          event: existingEvent,
          was_duplicate: true,
          duplicate_of: existingEvent.id,
          action_taken: 'cascade_blocked'
        };
      }
    }
    
    // Check for existing event with same content hash
    const existingDocument = await this.collection.findOne({
      content_hash: contentHash
    });
    const existingEvent = existingDocument as unknown as StoredEpisodicEvent | null;

    if (existingEvent) {
      // Update metadata if needed
      const updatedMetadata = {
        ...existingEvent.metadata,
        ...eventData.metadata,
        updated_at: new Date(),
        access_count: (existingEvent.metadata.access_count || 0) + 1,
        duplicate_prevention_applied: [
          ...(existingEvent.metadata.duplicate_prevention_applied || []),
          'content_hash_match'
        ]
      };

      await this.collection.updateOne(
        { _id: existingEvent._id },
        { 
          $set: { 
            metadata: updatedMetadata 
          } 
        }
      );

      return {
        event: {
          ...existingEvent,
          metadata: updatedMetadata
        },
        was_duplicate: true,
        duplicate_of: existingEvent.id,
        action_taken: 'updated_metadata'
      };
    }

    // Create new event with enhanced metadata
    const newEvent: StoredEpisodicEvent = {
      id: `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      user_id: eventData.user_id,
      shared_id: eventData.shared_id,
      session_id: eventData.session_id,
      event_type: eventData.event_type,
      content: eventData.content,
      content_hash: contentHash,
      idempotency_key: idempotencyKey,
      timestamp: eventData.timestamp || new Date(),
      metadata: {
        processed: false,
        created_at: new Date(),
        updated_at: new Date(),
        source: eventData.metadata?.source || 'unknown',
        access_count: 1,
        cascade_depth: 0,
        processing_version: 1,
        duplicate_prevention_applied: ['enhanced_content_hash', 'cascade_detection'],
        ...eventData.metadata
      },
      processing_lineage: {
        derived_from_events: [],
        ...eventData.metadata?.processing_lineage
      }
    };

    // Insert with retry logic for race conditions
    const insertResult = await this.insertWithRetry(newEvent, 3);
    
    // Trigger event-driven processing for new events
    if (insertResult.id) {
      this.triggerEventDrivenProcessing(insertResult.id);
    }
    
    return {
      event: insertResult,
      was_duplicate: false,
      action_taken: 'created'
    };
  }

  /**
   * Generate deterministic hash from event content for deduplication
   * Enhanced with second-level precision and session_id inclusion
   */
  private generateContentHash(eventData: EpisodicEventData): string {
    // Create normalized content for hashing with enhanced precision
    const normalizedContent = {
      user_id: eventData.user_id,
      session_id: eventData.session_id, // Include session_id in hash for better isolation
      event_type: eventData.event_type,
      message: eventData.content.message?.trim(),
      role: eventData.content.role,
      context: eventData.content.context,
      // Use second-level precision instead of minute-level to reduce collisions
      timestamp_second: eventData.timestamp ? 
        Math.floor(eventData.timestamp.getTime() / 1000) :
        Math.floor(Date.now() / 1000)
    };

    // Generate SHA-256 hash
    return createHash('sha256')
      .update(JSON.stringify(normalizedContent))
      .digest('hex');
  }

  /**
   * Generate idempotency key for processing deduplication
   */
  private generateIdempotencyKey(eventData: EpisodicEventData, contentHash: string): string {
    const processingVersion = 1; // Increment when processing logic changes
    return createHash('sha256')
      .update(`${eventData.session_id}:${eventData.event_type}:${contentHash}:${processingVersion}`)
      .digest('hex');
  }

  /**
   * Insert event with enhanced retry logic and distributed locking
   */
  private async insertWithRetry(event: StoredEpisodicEvent, maxAttempts: number): Promise<StoredEpisodicEvent> {
    const lockKey = `event_insert:${event.session_id}:${event.content_hash}`;
    
    // Acquire distributed lock for this content hash
    const lockAcquired = await this.lockManager.acquireLock(lockKey, 60); // 1 minute lock
    if (!lockAcquired) {
      console.log(`⏳ Another process is creating event with same content hash, checking for result...`);
      
      // Wait a bit and check if the event was created by the other process
      await new Promise(resolve => setTimeout(resolve, 1000));
      const existingDocument = await this.collection.findOne({
        content_hash: event.content_hash
      });
      const existingEvent = existingDocument as unknown as StoredEpisodicEvent | null;
      
      if (existingEvent) {
        console.log(`✅ Found event created by another process: ${existingEvent.id}`);
        return existingEvent;
      }
    }

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await this.collection.insertOne(event);
          console.log(`📝 Created episodic event: ${event.id} with enhanced deduplication`);
          return event;

        } catch (error: any) {
          // Handle duplicate key error (race condition)
          if (error.code === 11000) {
            console.log(`⚠️ Duplicate key conflict for event ${event.id}, checking for existing event...`);
            
            // Check if duplicate was created by another process
            const existingDocument = await this.collection.findOne({
              content_hash: event.content_hash
            });
            const existingEvent = existingDocument as unknown as StoredEpisodicEvent | null;

            if (existingEvent) {
              console.log(`✅ Found existing event ${existingEvent.id}, using that instead`);
              return existingEvent;
            }
            
            // If no existing event found and we have attempts left, generate new ID
            if (attempt < maxAttempts) {
              event.id = `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
              console.log(`🔄 Retrying with new ID: ${event.id} (attempt ${attempt})`);
            } else {
              throw new Error(`Duplicate key error persists after ${maxAttempts} attempts`);
            }
            
          } else {
            throw error;
          }
        }
      }

      throw new Error(`Failed to insert event after ${maxAttempts} attempts`);
      
    } finally {
      // Always release the lock
      await this.lockManager.releaseLock(lockKey);
    }
  }

  /**
   * Get unprocessed events for background processing
   */
  async getUnprocessedEvents(limit: number = 50): Promise<StoredEpisodicEvent[]> {
    const documents = await this.collection.find({
      'metadata.processed': false
    })
    .sort({ timestamp: 1 })
    .limit(limit)
    .toArray();
    
    return documents as unknown as StoredEpisodicEvent[];
  }

  /**
   * Mark event as processed
   */
  async markEventProcessed(eventId: string, processingResults?: any): Promise<void> {
    const updateData: any = {
      'metadata.processed': true,
      'metadata.processed_at': new Date(),
      'metadata.updated_at': new Date()
    };

    if (processingResults) {
      updateData['metadata.processing_results'] = processingResults;
    }

    await this.collection.updateOne(
      { id: eventId },
      { $set: updateData }
    );

    console.log(`✅ Marked event ${eventId} as processed`);
  }

  /**
   * Mark event processing as failed
   */
  async markEventProcessingFailed(eventId: string, error: string): Promise<void> {
    await this.collection.updateOne(
      { id: eventId },
      { 
        $set: {
          'metadata.processing_failed': true,
          'metadata.processing_error': error,
          'metadata.processing_failed_at': new Date(),
          'metadata.updated_at': new Date(),
          'metadata.retry_count': { $inc: 1 }
        }
      }
    );

    console.log(`❌ Marked event ${eventId} processing as failed: ${error}`);
  }

  /**
   * Get events for a specific session
   */
  async getSessionEvents(sessionId: string, limit: number = 10): Promise<StoredEpisodicEvent[]> {
    const documents = await this.collection.find({
      session_id: sessionId
    })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
    
    return documents as unknown as StoredEpisodicEvent[];
  }

  /**
   * Get events for a specific user
   */
  async getUserEvents(userId: string, limit: number = 20): Promise<StoredEpisodicEvent[]> {
    const documents = await this.collection.find({
      user_id: userId
    })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
    
    return documents as unknown as StoredEpisodicEvent[];
  }

  /**
   * Search events by content (text search if available, regex fallback)
   */
  async searchEvents(
    userId: string, 
    query: string, 
    options: {
      limit?: number;
      event_type?: string | string[];
      role?: 'user' | 'assistant';
    } = {}
  ): Promise<StoredEpisodicEvent[]> {
    const { limit = 10, event_type, role } = options;

    // Build match criteria
    const matchCriteria: any = {
      user_id: userId
    };

    if (event_type) {
      if (Array.isArray(event_type)) {
        matchCriteria.event_type = { $in: event_type };
      } else {
        matchCriteria.event_type = event_type;
      }
    }

    if (role) {
      matchCriteria['content.role'] = role;
    }

    try {
      // Try text search first
      const textSearchDocuments = await this.collection.find({
        ...matchCriteria,
        $text: { $search: query }
      })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .toArray();

      const textSearchResults = textSearchDocuments as unknown as StoredEpisodicEvent[];

      if (textSearchResults.length > 0) {
        console.log(`📝 Text search found ${textSearchResults.length} events`);
        return textSearchResults;
      }
    } catch (textSearchError) {
      console.log('📝 Text search not available, using semantic ranking');
    }

    // Semantic ranking fallback (no regex)
    const candidateDocuments = await this.collection
      .find(matchCriteria)
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();

    if (candidateDocuments.length === 0) {
      return [];
    }

    if (!llmService.isServiceAvailable()) {
      return candidateDocuments.slice(0, limit) as unknown as StoredEpisodicEvent[];
    }

    const ranked = await llmService.rankByRelevance(
      query,
      candidateDocuments.map(doc => ({
        id: doc._id?.toString?.() || doc.id || '',
        text: doc.content?.message || doc.content || JSON.stringify(doc)
      }))
    );

    const results = ranked
      .filter(r => r.score > 0.3)
      .slice(0, limit)
      .map(r => candidateDocuments.find(doc => (doc._id?.toString?.() || doc.id || '') === r.id))
      .filter(Boolean) as unknown as StoredEpisodicEvent[];

    console.log(`📝 Semantic ranking found ${results.length} events`);
    return results;
  }

  /**
   * Get events within a specific time range
   * Phase 1: Temporal Recall — foundational date-range query
   */
  async getEventsInTimeRange(
    userId: string,
    from: Date,
    to: Date,
    options: {
      limit?: number;
      event_type?: string | string[];
      role?: 'user' | 'assistant';
    } = {}
  ): Promise<StoredEpisodicEvent[]> {
    const { limit = 50, event_type, role } = options;

    const matchCriteria: any = {
      user_id: userId,
      timestamp: { $gte: from, $lte: to }
    };

    if (event_type) {
      if (Array.isArray(event_type)) {
        matchCriteria.event_type = { $in: event_type };
      } else {
        matchCriteria.event_type = event_type;
      }
    }

    if (role) {
      matchCriteria['content.role'] = role;
    }

    const documents = await this.collection
      .find(matchCriteria)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    console.log(`📅 Time-range query: ${from.toISOString()} → ${to.toISOString()} — ${documents.length} events`);
    return documents as unknown as StoredEpisodicEvent[];
  }

  /**
   * Get event statistics for monitoring
   */
  async getEventStats(): Promise<{
    total_events: number;
    unprocessed_events: number;
    processing_failed_events: number;
    events_by_type: Record<string, number>;
    events_by_user: Record<string, number>;
    recent_activity: {
      last_hour: number;
      last_day: number;
      last_week: number;
    };
  }> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalEvents,
      unprocessedEvents,
      failedEvents,
      eventsByType,
      eventsByUser,
      recentHour,
      recentDay,
      recentWeek
    ] = await Promise.all([
      this.collection.countDocuments(),
      this.collection.countDocuments({ 'metadata.processed': false }),
      this.collection.countDocuments({ 'metadata.processing_failed': true }),
      this.collection.aggregate([
        { $group: { _id: '$event_type', count: { $sum: 1 } } }
      ]).toArray(),
      this.collection.aggregate([
        { $group: { _id: '$user_id', count: { $sum: 1 } } }
      ]).toArray(),
      this.collection.countDocuments({ timestamp: { $gte: oneHourAgo } }),
      this.collection.countDocuments({ timestamp: { $gte: oneDayAgo } }),
      this.collection.countDocuments({ timestamp: { $gte: oneWeekAgo } })
    ]);

    // Convert aggregation results to objects
    const typeStats: Record<string, number> = {};
    eventsByType.forEach((item: any) => {
      typeStats[item._id] = item.count;
    });

    const userStats: Record<string, number> = {};
    eventsByUser.forEach((item: any) => {
      userStats[item._id] = item.count;
    });

    return {
      total_events: totalEvents,
      unprocessed_events: unprocessedEvents,
      processing_failed_events: failedEvents,
      events_by_type: typeStats,
      events_by_user: userStats,
      recent_activity: {
        last_hour: recentHour,
        last_day: recentDay,
        last_week: recentWeek
      }
    };
  }

  /**
   * Trigger event-driven processing for new events with debouncing
   */
  private triggerEventDrivenProcessing(eventId: string): void {
    // Add event to pending processing set
    this.pendingProcessingEventIds.add(eventId);
    
    // Clear existing timer if any
    if (this.processingDebounceTimer) {
      clearTimeout(this.processingDebounceTimer);
    }
    
    // Set debounced timer for processing (5 second delay to batch nearby events)
    this.processingDebounceTimer = setTimeout(async () => {
      try {
        const eventIdsToProcess = Array.from(this.pendingProcessingEventIds);
        this.pendingProcessingEventIds.clear();
        
        console.log(`🚀 Event-driven processing triggered for ${eventIdsToProcess.length} new events`);
        
        // Import and trigger background processor
        const { backgroundProcessor } = await import('./background-processor.js');
        backgroundProcessor.processUnprocessedEvents();
        
      } catch (error) {
        console.error('❌ Event-driven processing trigger failed:', error);
      } finally {
        this.processingDebounceTimer = null;
      }
    }, 5000); // 5-second debounce window
  }

  /**
   * Cleanup old processed events (retention policy)
   */
  async cleanupOldEvents(retentionDays: number = 90): Promise<{
    deleted_count: number;
    cutoff_date: Date;
  }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const deleteResult = await this.collection.deleteMany({
      timestamp: { $lt: cutoffDate },
      'metadata.processed': true,
      'metadata.processing_failed': { $ne: true }
    });

    console.log(`🧹 Cleaned up ${deleteResult.deletedCount} old events (older than ${retentionDays} days)`);

    return {
      deleted_count: deleteResult.deletedCount || 0,
      cutoff_date: cutoffDate
    };
  }

  /**
   * Identify and cleanup existing duplicate events
   * Recommendation 4: Safe cleanup of existing duplicates
   */
  async identifyAndCleanupDuplicates(dryRun: boolean = true): Promise<{
    duplicates_found: number;
    duplicates_removed: number;
    sessions_affected: string[];
    cleanup_summary: Array<{
      content_hash: string;
      session_id: string;
      duplicate_count: number;
      kept_event_id: string;
      removed_event_ids: string[];
      time_span_ms: number;
    }>;
  }> {
    console.log(`🔍 ${dryRun ? 'Analyzing' : 'Cleaning up'} duplicate episodic events...`);

    // Find sessions with high duplication ratios
    const duplicateGroups = await this.collection.aggregate([
      {
        $group: {
          _id: {
            session_id: "$session_id",
            content_hash: "$content_hash"
          },
          count: { $sum: 1 },
          events: { 
            $push: {
              id: "$id",
              timestamp: "$timestamp",
              metadata: "$metadata"
            }
          }
        }
      },
      {
        $match: { count: { $gt: 1 } }
      },
      {
        $project: {
          session_id: "$_id.session_id",
          content_hash: "$_id.content_hash",
          duplicate_count: "$count", 
          events: "$events"
        }
      }
    ]).toArray();

    console.log(`📊 Found ${duplicateGroups.length} groups of duplicate events`);

    const results = {
      duplicates_found: 0,
      duplicates_removed: 0,
      sessions_affected: new Set<string>(),
      cleanup_summary: [] as any[]
    };

    for (const group of duplicateGroups) {
      const events = group.events.sort((a: any, b: any) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // Keep the earliest event (first in sorted order)
      const eventToKeep = events[0];
      const eventsToRemove = events.slice(1);

      const timeSpan = new Date(events[events.length - 1].timestamp).getTime() - 
                      new Date(events[0].timestamp).getTime();

      results.duplicates_found += group.duplicate_count - 1;
      results.sessions_affected.add(group.session_id);

      const summary = {
        content_hash: group.content_hash,
        session_id: group.session_id,
        duplicate_count: group.duplicate_count,
        kept_event_id: eventToKeep.id,
        removed_event_ids: eventsToRemove.map((e: any) => e.id),
        time_span_ms: timeSpan
      };

      results.cleanup_summary.push(summary);

      if (!dryRun) {
        // Remove duplicate events
        const removeResult = await this.collection.deleteMany({
          id: { $in: summary.removed_event_ids }
        });

        results.duplicates_removed += removeResult.deletedCount || 0;
        
        console.log(`🧹 Removed ${removeResult.deletedCount} duplicates for content_hash ${group.content_hash.substring(0, 8)}...`);
      } else {
        console.log(`📋 Would remove ${eventsToRemove.length} duplicates for content_hash ${group.content_hash.substring(0, 8)}...`);
      }
    }

    const finalResults = {
      ...results,
      sessions_affected: Array.from(results.sessions_affected)
    };

    console.log(`✅ ${dryRun ? 'Analysis' : 'Cleanup'} completed: ${finalResults.duplicates_found} duplicates found, ${finalResults.duplicates_removed} removed`);
    console.log(`📈 Sessions affected: ${finalResults.sessions_affected.length}`);

    return finalResults;
  }

  /**
   * Get duplication statistics for monitoring
   */
  async getDuplicationStats(): Promise<{
    total_events: number;
    unique_content_hashes: number;
    duplication_ratio: number;
    sessions_with_duplicates: number;
    cascade_detected_events: number;
    top_duplicate_sessions: Array<{
      session_id: string;
      total_events: number;
      unique_events: number;
      duplication_ratio: number;
    }>;
  }> {
    const [totalStats, contentHashStats, cascadeStats, sessionStats] = await Promise.all([
      // Total events
      this.collection.countDocuments(),
      
      // Unique content hashes
      this.collection.distinct('content_hash').then(hashes => hashes.length),
      
      // Events with cascade detection applied
      this.collection.countDocuments({
        'metadata.duplicate_prevention_applied': 'cascade_detection'
      }),
      
      // Session-level duplication stats
      this.collection.aggregate([
        {
          $group: {
            _id: '$session_id',
            total_events: { $sum: 1 },
            unique_content_hashes: { $addToSet: '$content_hash' }
          }
        },
        {
          $project: {
            session_id: '$_id',
            total_events: '$total_events',
            unique_events: { $size: '$unique_content_hashes' },
            duplication_ratio: {
              $divide: [
                { $subtract: ['$total_events', { $size: '$unique_content_hashes' }] },
                '$total_events'
              ]
            }
          }
        },
        {
          $match: {
            duplication_ratio: { $gt: 0 }
          }
        },
        {
          $sort: { duplication_ratio: -1 }
        },
        {
          $limit: 10
        }
      ]).toArray()
    ]);

    const duplicationRatio = totalStats > 0 ? (totalStats - contentHashStats) / totalStats : 0;
    const sessionsWithDuplicates = sessionStats.length;

    // Type cast the session stats to the expected format
    const typedSessionStats = sessionStats.map((stat: any) => ({
      session_id: stat.session_id,
      total_events: stat.total_events,
      unique_events: stat.unique_events,
      duplication_ratio: stat.duplication_ratio
    }));

    return {
      total_events: totalStats,
      unique_content_hashes: contentHashStats,
      duplication_ratio: duplicationRatio,
      sessions_with_duplicates: sessionsWithDuplicates,
      cascade_detected_events: cascadeStats,
      top_duplicate_sessions: typedSessionStats
    };
  }
}

// Export singleton instance
let episodicEventManager: EpisodicEventManager | null = null;

export function getEpisodicEventManager(): EpisodicEventManager {
  if (!episodicEventManager) {
    episodicEventManager = new EpisodicEventManager();
  }
  return episodicEventManager;
}