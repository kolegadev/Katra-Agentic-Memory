/**
 * Background Processor Service
 * 
 * Handles asynchronous processing of episodic events to extract and store
 * semantic information in derived memory types.
 * 
 * This implements the core workflow improvement:
 * episodic_events -> semantic parsing -> knowledge_nodes/relationships/semantic_facts
 */

import { MemoryManager } from './memory-manager.js';
import { extraction_service, ExtractionContext } from './extraction-service.js';
import { dispatch_service, DispatchContext } from './dispatch-service.js';
import { getEpisodicEventManager } from './episodic-event-manager.js';
import { TimeBlockSummarizer } from './time-block-summarizer.js';
import { ProspectiveMemoryService } from './prospective-memory-service.js';
import { embeddingService } from './embedding-service.js';

export class BackgroundProcessor {
  private static instance: BackgroundProcessor;
  private processing = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private memoryManager: MemoryManager;
  private lastNoEventsLogTime: number = 0;
  private processingCycleCount: number = 0;

  private constructor() {
    this.memoryManager = MemoryManager.get_instance();
  }

  static get_instance(): BackgroundProcessor {
    if (!BackgroundProcessor.instance) {
      BackgroundProcessor.instance = new BackgroundProcessor();
    }
    return BackgroundProcessor.instance;
  }

  /**
   * Start background processing of unprocessed events
   */
  start(intervalMs: number = 30000): void {
    if (this.processingInterval) {
      console.log('⚠️ Background processor already running');
      return;
    }

    console.log(`🔄 Starting background processor (interval: ${intervalMs}ms)`);
    
    // Run immediately, then at intervals
    this.processUnprocessedEvents();
    
    this.processingInterval = setInterval(() => {
      this.processUnprocessedEvents();
    }, intervalMs);
  }

  /**
   * Stop background processing
   */
  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
      console.log('⏹️ Background processor stopped');
    }
  }

  /**
   * Process all unprocessed events
   */
  async processUnprocessedEvents(): Promise<void> {
    if (this.processing) {
      console.log('⏳ Background processor already running, skipping cycle');
      return;
    }

    this.processing = true;

    try {
      const unprocessedEvents = await this.memoryManager.get_unprocessed_events(50);
      
      if (unprocessedEvents.length === 0) {
        // Only log occasionally to reduce noise
        const now = Date.now();
        if (!this.lastNoEventsLogTime || now - this.lastNoEventsLogTime > 300000) { // 5 minutes
          console.log('✅ No unprocessed events found');
          this.lastNoEventsLogTime = now;
        }
        return;
      }

      console.log(`🔄 Processing ${unprocessedEvents.length} unprocessed events`);

      let processedCount = 0;
      let failedCount = 0;

      for (const event of unprocessedEvents) {
        try {
          // Check if event is already being processed or was recently processed
          if (await this.isEventRecentlyProcessed(event)) {
            console.log(`⏭️ Event ${event.id} already recently processed, skipping`);
            continue;
          }

          await this.processEvent(event);
          processedCount++;
        } catch (error) {
          console.error(`❌ Failed to process event ${event.id}:`, error);
          await this.memoryManager.mark_event_processing_failed(
            event.id || (event as any)._id?.toString(),
            error instanceof Error ? error.message : 'Unknown error'
          );
          failedCount++;
        }
      }

      if (processedCount > 0 || failedCount > 0) {
        console.log(`✅ Background processing completed: ${processedCount} processed, ${failedCount} failed`);
      }

      // Time-block summarization: run every 30 processing cycles (~15 min)
      if (this.processingCycleCount % 30 === 0) {
        try {
          const summarizer = new TimeBlockSummarizer();
          const uniqueUsers = [...new Set(unprocessedEvents.map((e: any) => e.user_id).filter(Boolean))];
          for (const userId of uniqueUsers) {
            const result = await summarizer.summarizeTimeBlocks({
              user_id: userId,
              block_type: 'day',
              lookback_days: 7,
              max_blocks: 5,
            });
            if (result.summaries_created > 0) {
              console.log(`⏰ Time blocks summarized for ${userId}: ${result.summaries_created} created`);
            }
          }
        } catch (tsErr) {
          console.warn('⚠️ Time-block summarization failed:', tsErr);
        }
      }
      this.processingCycleCount = (this.processingCycleCount || 0) + 1;

      // Auto-expire missions paused > 24h (every 60 cycles ~30 min)
      if (this.processingCycleCount % 60 === 0) {
        try {
          const { get_database } = await import('../database/connection.js');
          const db = get_database();
          const prospective = new ProspectiveMemoryService(db);
          await prospective.autoExpireMissions();
        } catch (expErr) {
          console.warn('⚠️ Mission auto-expire failed:', expErr);
        }
      }

    } catch (error) {
      console.error('❌ Background processing cycle failed:', error);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single episodic event with distributed locking and idempotency
   */
  private async processEvent(event: any): Promise<void> {
    const eventId = event.id || event._id?.toString();
    const sessionId = event.session_id;
    const userId = event.user_id;
    const content = event.content?.message || JSON.stringify(event.content) || '';
    const contentHash = event.content_hash;
    const idempotencyKey = event.idempotency_key;

    if (!eventId || !sessionId || !userId || !contentHash) {
      throw new Error('Event missing required fields');
    }

    // Acquire processing lock using the episodic event manager's lock system
    const episodicManager = getEpisodicEventManager();
    const lockKey = `processing:${sessionId}:${contentHash}`;
    
    // Use the internal lock manager from episodic event manager
    const lockManager = (episodicManager as any).lockManager;
    const lockAcquired = await lockManager.acquireLock(lockKey, 300); // 5 minutes
    
    if (!lockAcquired) {
      console.log(`⏭️ Event ${eventId} already being processed by another instance, skipping`);
      return;
    }

    try {
      // Check if processing was completed by another process while we were waiting
      try {
        const { get_database } = await import('../database/connection.js');
        const db = get_database();
        const currentEvent = await db.collection('episodic_events').findOne({ id: eventId });
        if (currentEvent?.metadata?.processed === true) {
          console.log(`✅ Event ${eventId} was already processed by another instance`);
          return;
        }
      } catch (error) {
        console.warn('⚠️ Could not check current event status, proceeding with processing');
      }

      // Check idempotency - prevent reprocessing of same content
      if (idempotencyKey) {
        const existingProcessingLog = await this.checkIdempotency(idempotencyKey);
        if (existingProcessingLog) {
          console.log(`🔄 Event ${eventId} already processed (idempotency key: ${idempotencyKey.substring(0, 8)}...)`);
          return;
        }
        
        // Create processing log entry
        await this.createProcessingLogEntry(idempotencyKey, eventId, sessionId);
      }

      console.log(`🧠 Processing event ${eventId}: ${content.substring(0, 50)}...`);

    // Build extraction context with conversation history
    const recentEvents = await this.memoryManager.get_session_events(sessionId, 5);
    const conversationHistory = recentEvents
      .filter(e => e.content?.message && e.id !== eventId)
      .map(e => e.content.message)
      .slice(-3); // Last 3 messages for context

    const extractionContext: ExtractionContext = {
      session_id: sessionId,
      user_id: userId,
      timestamp: new Date(event.timestamp || Date.now()),
      conversation_history: conversationHistory,
      extraction_focus: 'comprehensive_extraction_with_specifics'
    };

    // Extract semantic information
    let extractionResult;
    try {
      console.log(`🔍 Starting extraction for event ${eventId}...`);
      extractionResult = await extraction_service.extractStructuredData(
        content,
        extractionContext
      );
      console.log(`✅ Extraction successful for event ${eventId}`);
      console.log(`📊 Extracted: ${extractionResult?.entities?.length || 0} entities, ${extractionResult?.relationships?.length || 0} relationships, ${extractionResult?.semantic_facts?.length || 0} facts`);
      
      if (!extractionResult) {
        throw new Error('Extraction service returned null/undefined result');
      }
    } catch (extractionError: any) {
      console.error(`❌ Extraction failed for event ${eventId}:`, {
        error: extractionError.message,
        content: content.substring(0, 200),
        stack: extractionError.stack?.split('\n').slice(0, 5)
      });
      throw extractionError;
    }

    // Only proceed if we extracted meaningful information
    if (extractionResult.entities.length === 0 && 
        extractionResult.relationships.length === 0 && 
        extractionResult.semantic_facts.length === 0) {
      console.log('⏭️ No meaningful semantic information extracted, marking as processed');
      await this.memoryManager.mark_event_processed(eventId, {
        processed_at: new Date(),
        extraction_result: {
          entities_count: 0,
          relationships_count: 0,
          facts_count: 0,
          reason: 'no_meaningful_information'
        }
      });
      return;
    }

    // Dispatch to memory stores with session tagging
    const dispatchContext: DispatchContext = {
      session_id: sessionId,
      user_id: userId,
      source_event_id: eventId,
      source_event_timestamp: new Date(event.timestamp || Date.now()),
      timestamp: new Date(event.timestamp || Date.now()),
      batch_id: `background-processing-${eventId}`,
      priority: 'low'
    };

    const dispatchResult = await dispatch_service.dispatchToMemory(
      extractionResult,
      dispatchContext
    );

    console.log(`✅ Dispatched: ${dispatchResult.operations_completed} operations completed`);

    // 🧠 Embed the source event and newly created semantic facts
    // Fire-and-forget: embedding is non-critical, don't block processing
    this.embedEventAndFacts(eventId, content, event.event_type, userId).catch((e) => {
      console.warn('⚠️ Background embedding failed (non-critical):', e.message);
    });

    // Mark event as processed
    await this.memoryManager.mark_event_processed(eventId, {
      processed_at: new Date(),
      extraction_result: {
        entities_count: extractionResult.entities.length,
        relationships_count: extractionResult.relationships.length,
        facts_count: extractionResult.semantic_facts.length,
        processing_time_ms: extractionResult.processing_metadata.extraction_time
      },
      dispatch_result: {
        operations_completed: dispatchResult.operations_completed,
        operations_failed: dispatchResult.operations_failed
      }
    });

    // Update processing log to completed status
    if (idempotencyKey) {
      await this.updateProcessingLogEntry(idempotencyKey, 'completed', {
        processed_at: new Date(),
        extraction_result: extractionResult,
        dispatch_result: dispatchResult
      });
    }

    } finally {
      // Always release the processing lock
      await lockManager.releaseLock(lockKey);
    }
  }

  /**
   * Embed the source episodic event and its derived semantic facts.
   * Fire-and-forget: runs async, logs on failure, never throws.
   */
  private async embedEventAndFacts(
    eventId: string,
    content: string,
    eventType: string,
    userId: string
  ): Promise<void> {
    // 1. Embed the source episodic event
    const eventEmbedding = await embeddingService.encode(content, eventType);
    if (eventEmbedding) {
      await embeddingService.storeEmbedding('episodic_events', { id: eventId }, eventEmbedding);
      console.log(`🧠 Embedded episodic event ${eventId.slice(-8)}`);
    }

    // 2. Find and embed newly created semantic facts for this event
    try {
      const { get_database } = await import('../database/connection.js');
      const db = get_database();
      const facts = await db.collection('semantic_facts')
        .find({
          user_id: userId,
          'metadata.extraction_context.source_event_id': eventId,
          embedding: { $exists: false },
        })
        .limit(20)
        .toArray();

      if (facts.length > 0) {
        const texts = facts.map((f: any) => ({
          text: f.content || '',
          eventType: 'semantic_fact',
        }));
        const embeddings = await embeddingService.encodeBatch(texts);

        for (let i = 0; i < facts.length; i++) {
          const vec = embeddings[i];
          if (vec) {
            await embeddingService.storeEmbedding('semantic_facts', facts[i]._id, vec);
          }
        }
        console.log(`🧠 Embedded ${embeddings.filter(Boolean).length}/${facts.length} semantic facts for event ${eventId.slice(-8)}`);
      }
    } catch (e: any) {
      console.warn('⚠️ Failed to embed semantic facts:', e.message);
    }
  }

  /**
   * Check if an event has been recently processed to avoid reprocessing
   */
  private async isEventRecentlyProcessed(event: any): Promise<boolean> {
    // Check if the event has processing metadata indicating it was already processed
    if (event.metadata?.processed === true) {
      return true;
    }

    // Check if the event has a processed_at timestamp within the last hour
    if (event.metadata?.processed_at) {
      const processedAt = new Date(event.metadata.processed_at);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (processedAt > oneHourAgo) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get processing statistics
   */
  async getProcessingStats(): Promise<{
    is_running: boolean;
    unprocessed_count: number;
    processing_active: boolean;
    last_run_time?: Date;
  }> {
    const unprocessedCount = (await this.memoryManager.get_unprocessed_events(1)).length > 0 ? 
      (await this.memoryManager.get_unprocessed_events(1000)).length : 0;

    return {
      is_running: this.processingInterval !== null,
      unprocessed_count: unprocessedCount,
      processing_active: this.processing,
      last_run_time: new Date()
    };
  }

  /**
   * Force process all unprocessed events immediately
   */
  async forceProcessAll(): Promise<{
    processed: number;
    failed: number;
    errors: string[];
  }> {
    const results = {
      processed: 0,
      failed: 0,
      errors: [] as string[]
    };

    try {
      // Get all unprocessed events
      const unprocessedEvents = await this.memoryManager.get_unprocessed_events(1000);
      
      console.log(`🔄 Force processing ${unprocessedEvents.length} events`);

      for (const event of unprocessedEvents) {
        try {
          await this.processEvent(event);
          results.processed++;
        } catch (error) {
          results.failed++;
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          results.errors.push(`Event ${event.id}: ${errorMsg}`);
          
          await this.memoryManager.mark_event_processing_failed(
            event.id || (event as any)._id?.toString(),
            errorMsg
          );
        }
      }

      console.log(`✅ Force processing completed: ${results.processed} processed, ${results.failed} failed`);

    } catch (error) {
      console.error('❌ Force processing failed:', error);
      results.errors.push(`Force processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return results;
  }

  /**
   * Check idempotency for processing operations
   */
  private async checkIdempotency(idempotencyKey: string): Promise<boolean> {
    try {
      const { get_database } = await import('../database/connection.js');
      const db = get_database();
      const processingLogCollection = db.collection('processing_log');
      
      const existingEntry = await processingLogCollection.findOne({
        idempotency_key: idempotencyKey,
        status: { $in: ['processing', 'completed'] }
      });

      return existingEntry !== null;
    } catch (error) {
      console.error('❌ Idempotency check failed:', error);
      return false; // Err on the side of processing if check fails
    }
  }

  /**
   * Create processing log entry for idempotency
   */
  private async createProcessingLogEntry(idempotencyKey: string, eventId: string, sessionId: string): Promise<void> {
    try {
      const { get_database } = await import('../database/connection.js');
      const db = get_database();
      const processingLogCollection = db.collection('processing_log');
      
      await processingLogCollection.insertOne({
        idempotency_key: idempotencyKey,
        event_id: eventId,
        session_id: sessionId,
        status: 'processing',
        started_at: new Date(),
        processor_id: process.env.HOSTNAME || `${process.pid}`
      });
    } catch (error) {
      // Don't fail processing if we can't create log entry, just warn
      console.warn('⚠️ Failed to create processing log entry:', error);
    }
  }

  /**
   * Update processing log entry status
   */
  private async updateProcessingLogEntry(idempotencyKey: string, status: string, results?: any): Promise<void> {
    try {
      const { get_database } = await import('../database/connection.js');
      const db = get_database();
      const processingLogCollection = db.collection('processing_log');
      
      const updateData: any = {
        status: status,
        updated_at: new Date()
      };

      if (status === 'completed' && results) {
        updateData.completed_at = new Date();
        updateData.processing_results = results;
      } else if (status === 'failed' && results) {
        updateData.failed_at = new Date();
        updateData.error = results;
      }

      await processingLogCollection.updateOne(
        { idempotency_key: idempotencyKey },
        { $set: updateData }
      );
    } catch (error) {
      console.warn('⚠️ Failed to update processing log entry:', error);
    }
  }
}

// Export singleton instance
export const backgroundProcessor = BackgroundProcessor.get_instance();