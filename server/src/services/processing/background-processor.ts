/**
 * Background Processor Service
 * 
 * Handles asynchronous processing of episodic events to extract and store
 * semantic information in derived memory types.
 * 
 * This implements the core workflow improvement:
 * episodic_events -> semantic parsing -> knowledge_nodes/relationships/semantic_facts
 */

import { MemoryManager } from '../memory/memory-manager.js';
import { extraction_service, ExtractionContext } from './extraction-service.js';
import { dispatch_service, DispatchContext } from './dispatch-service.js';
import { getEpisodicEventManager } from '../memory/episodic-event-manager.js';
import { TimeBlockSummarizer } from './time-block-summarizer.js';
import { ProspectiveMemoryService } from '../memory/prospective-memory-service.js';
import { embeddingService } from '../infrastructure/embedding-service.js';
import { entityResolver } from '../integration/entity-resolver.js';
import { stableContentHash } from '../infrastructure/content-hash-utils.js';
import { DecisionActionService } from './decision-action-service.js';
import { SalienceService } from './salience-service.js';

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
      const SYSTEM_EVENT_TYPES = new Set([
        'heartbeat_action',
        'task_execution',
        'autonomous_action',
        'system_update',
        'agent_bulletin',
      ]);

      let processedCount = 0;
      let triagedCount = 0;
      let failedCount = 0;

      // ── Pass 1: System Events (unlimited, triage everything) ──
      // System events are internal pulses — triage them at full speed
      // so they don't clog the pipeline. No bottleneck needed here.
      const systemEvents = await this.memoryManager.get_unprocessed_events(200);
      const sysEvents = systemEvents.filter((e: any) => SYSTEM_EVENT_TYPES.has(e.event_type));

      if (sysEvents.length > 0) {
        for (const event of sysEvents) {
          try {
            if (await this.isEventRecentlyProcessed(event)) continue;
            await this.processSystemEvent(event);
            triagedCount++;
          } catch (error) {
            console.error(`Failed to triage ${event.id}:`, (error as Error).message);
            await this.memoryManager.mark_event_processing_failed(
              event.id || (event as any)._id?.toString(),
              error instanceof Error ? error.message : 'Unknown error'
            );
            failedCount++;
          }
        }
      }

      // ── Pass 2: Conversation Events (tight bottleneck: 5) ──
      // Only 5 conversation events per cycle. This forces real
      // prioritization — the RL loop must choose which events
      // get the expensive LLM extraction.
      const CONVERSATION_BATCH_SIZE = 12;
      const allUnprocessed = await this.memoryManager.get_unprocessed_events(100);
      const convEvents = allUnprocessed
        .filter((e: any) => !SYSTEM_EVENT_TYPES.has(e.event_type))
        .slice(0, CONVERSATION_BATCH_SIZE);

      if (convEvents.length > 0) {
        for (const event of convEvents) {
          try {
            if (await this.isEventRecentlyProcessed(event)) continue;

            const emotionalTags = event.metadata?.emotional_tags || {};

            // Attention gate: salience-based override for boring events
            let useFullExtraction = true;
            if (emotionalTags.arousal < 0.15 && !emotionalTags.caution) {
              useFullExtraction = false;
              // Record demotion as RL decision
              try {
                DecisionActionService.get_instance().recordOutcome(
                  `triage_override:${event.event_type}`,
                  'demote_to_lightweight',
                  0.7,
                  0.5
                );
              } catch { /* non-critical */ }
            }

            if (useFullExtraction) {
              await this.processEvent(event);
              processedCount++;
            } else {
              await this.processSystemEvent(event);
              triagedCount++;
            }
          } catch (error) {
            console.error(`Failed to process ${event.id}:`, (error as Error).message);
            await this.memoryManager.mark_event_processing_failed(
              event.id || (event as any)._id?.toString(),
              error instanceof Error ? error.message : 'Unknown error'
            );
            failedCount++;
          }
        }
      }

      if (processedCount > 0 || triagedCount > 0 || failedCount > 0) {
        console.log(`✅ Background processing: ${processedCount} full (batch:${CONVERSATION_BATCH_SIZE}) + ${triagedCount} triaged, ${failedCount} failed`);
      }

      // Time-block summarization: run every 120 processing cycles (~60 min)
      if (this.processingCycleCount % 120 === 0) {
        try {
          const summarizer = new TimeBlockSummarizer();
          const uniqueUsers = [...new Set([...sysEvents, ...convEvents].map((e: any) => e.user_id).filter(Boolean))];
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

      // ── ACC → Thalamus feedback ─────────────────────────────────
      // Adapt salience weights based on error/surprise signals every cycle.
      // Smooth interpolation prevents oscillation. Non-critical.
      try {
        const { SalienceService } = await import('./salience-service.js');
        SalienceService.get_instance().adaptWeights();
        DecisionActionService.get_instance().persistOutcomes();
      } catch { /* non-critical */ }

      // Auto-journal distillation: distill aged-out conversation turns into
      // concise insights stored in agent_journal_auto. Runs every 60 cycles
      // (~30 min at 30s interval) to reduce LLM token consumption.
      // Turns are batched (10 per LLM call) and capped (10 turns per session per cycle).
      if (this.processingCycleCount % 60 === 0) {
        try {
          const { get_database: gdb } = await import('../../database/connection.js');
          const db2 = gdb();
          const prospective = new ProspectiveMemoryService(db2);

          // Get all sessions with recent conversation activity
          const recentSessions = await db2.collection('episodic_events')
            .aggregate([
              { $match: { event_type: { $in: ['conversation', 'user_message', 'assistant_response'] } } },
              { $group: { _id: { user_id: '$user_id', session_id: '$session_id' } } },
              { $limit: 20 },
            ]).toArray();

          let totalDistilled = 0;
          for (const s of recentSessions) {
            const uid = s._id.user_id as string;
            const sid = s._id.session_id as string;
            if (uid && sid) {
              const count = await prospective.distillAgedTurns(uid, sid);
              totalDistilled += count;
            }
          }

          if (totalDistilled > 0) {
            console.log(`📓 Auto-journal: ${totalDistilled} turns distilled across ${recentSessions.length} sessions`);
          }
        } catch (distillErr) {
          console.warn('⚠️ Auto-journal distillation failed:', distillErr);
        }
      }

      // Auto-expire missions paused > 24h (every 60 cycles ~30 min)
      if (this.processingCycleCount % 60 === 0) {
        try {
          const { get_database } = await import('../../database/connection.js');
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

    // Compute content_hash on the fly if missing (Python scripts write directly
    // to MongoDB without computing it). This prevents the entire backlog from
    // being permanently unprocessable.
    let contentHash = event.content_hash;
    if (!contentHash && content) {
      contentHash = stableContentHash(userId || 'unknown', content);
      // Persist the computed hash so future cycles don't recompute it
      try {
        const { get_database } = await import('../../database/connection.js');
        const db = get_database();
        await db.collection('episodic_events').updateOne(
          { id: eventId },
          { $set: { content_hash: contentHash } }
        );
      } catch { /* non-critical — hash will be recomputed next cycle */ }
    }

    const idempotencyKey = event.idempotency_key;

    if (!eventId || !sessionId || !userId || !contentHash) {
      throw new Error(`Event missing required fields: id=${!!eventId}, session=${!!sessionId}, user=${!!userId}, contentHash=${!!contentHash}`);
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
        const { get_database } = await import('../../database/connection.js');
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

    // Resolve extracted entities to canonical IDs to reduce duplication
    try {
      const resolvedCount = await this.resolveExtractedEntities(extractionResult, {
        userId,
        sessionId
      });
      if (resolvedCount.size > 0) {
        console.log(`🔗 Entity resolution mapped ${resolvedCount.size} extracted entities to canonical IDs`);
      }
    } catch (resolutionError) {
      console.warn('⚠️ Entity resolution step failed, proceeding with raw extracted IDs:', resolutionError);
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

    // ── RL Outcome Recording ──────────────────────────────────────
    // Feed extraction quality into the RL loop so Q-values are learned
    // from real processing outcomes. Fire-and-forget: never throw.
    try {
      const qualityScore = Math.min(1, (
        (extractionResult.entities.length * 0.3) +
        (extractionResult.relationships.length * 0.3) +
        (extractionResult.semantic_facts.length * 0.4)
      ) / 10);
      DecisionActionService.get_instance().recordOutcome(
        `extraction:${event.event_type || 'unknown'}`,
        'full_extraction',
        0.5,
        parseFloat(qualityScore.toFixed(4))
      );
    } catch (rlErr: any) {
      // Non-critical — RL loop failure must not break processing
    }

    // ── Salience Scoring ────────────────────────────────────────────────
    // Compute attention salience so the attention gate can prioritize
    // future retrieval. Fire-and-forget: never throw.
    try {
      const hoursSinceEvent = event.timestamp
        ? (Date.now() - new Date(event.timestamp).getTime()) / (1000 * 60 * 60)
        : 0;
      const extractionYield = extractionResult.entities.length +
        extractionResult.relationships.length +
        extractionResult.semantic_facts.length;
      SalienceService.get_instance().computeSalience({
        hoursSinceEvent,
        emotionalIntensity: event.metadata?.emotional_tags?.arousal ?? 0.5,
        goalRelevance: 0,
        novelty: extractionYield > 5 ? 0.8 : 0.4,
        frequencyRarity: 0.5,
        intensity: event.metadata?.emotional_tags?.valence ?? 0.5,
        confidence: extractionResult.semantic_facts.length > 0 ? 0.8 : 0.3,
      });
    } catch { /* non-critical */ }

    // Update processing log to completed status — store summary only (not raw data)
    if (idempotencyKey) {
      await this.updateProcessingLogEntry(idempotencyKey, 'completed', {
        processed_at: new Date(),
        extraction_summary: {
          entity_count: extractionResult?.entities?.length || 0,
          relationship_count: extractionResult?.relationships?.length || 0,
          event_count: extractionResult?.events?.length || 0,
          fact_count: extractionResult?.semantic_facts?.length || 0,
        },
        dispatch_summary: {
          operations_completed: dispatchResult.operations_completed,
          operations_failed: dispatchResult.operations_failed
        }
      });
    }
    } finally {
      // Always release the processing lock
      await lockManager.releaseLock(lockKey);
    }
  }

  /**
   * Lightweight processing for system events (heartbeat pulses, task executions,
   * autonomous actions, etc.). These are internal system signals that don't carry
   * user content — no LLM extraction needed. Just mark as processed so they
   * don't clog the attention gate for high-salience user events.
   */
  private async processSystemEvent(event: any): Promise<void> {
    const eventId = event.id || event._id?.toString();

    // Compute content_hash if missing (Python scripts bypass MCP)
    if (!event.content_hash && event.content) {
      const content = event.content?.message || JSON.stringify(event.content) || '';
      const contentHash = stableContentHash(event.user_id || 'system', content);
      try {
        const { get_database } = await import('../../database/connection.js');
        const db = get_database();
        await db.collection('episodic_events').updateOne(
          { id: eventId },
          { $set: { content_hash: contentHash } }
        );
      } catch { /* non-critical */ }
    }

    // Mark as processed with lightweight flag — no LLM extraction
    await this.memoryManager.mark_event_processed(eventId, {
      processed_at: new Date(),
      extraction_result: {
        entities_count: 0,
        relationships_count: 0,
        facts_count: 0,
        reason: 'system_event_triaged',
      },
    });

    // ── RL Outcome Recording (triage) ────────────────────────────
    try {
      DecisionActionService.get_instance().recordOutcome(
        `triage:${event.event_type || 'unknown'}`,
        'lightweight_triage',
        1.0,
        1.0
      );
    } catch { /* non-critical */ }
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
    // 1. Embed the source episodic event (use custom id field, not _id)
    const eventEmbedding = await embeddingService.encode(content, eventType);
    if (eventEmbedding) {
      await embeddingService.storeEmbedding('episodic_events', eventId, eventEmbedding, { id: eventId });
      console.log(`🧠 Embedded episodic event ${eventId.slice(-8)}`);
    }

    // 2. Find and embed newly created semantic facts for this event
    try {
      const { get_database } = await import('../../database/connection.js');
      const db = get_database();

      // 2a. Event-linked facts from extraction pipeline
      const linkedFacts = await db.collection('semantic_facts')
        .find({
          user_id: userId,
          'metadata.extraction_context.source_event_id': eventId,
          embedding: { $exists: false },
        })
        .limit(20)
        .toArray();

      // 2b. Any remaining un-embedded facts for this user
      //     Catches MCP-tool stored facts, time-block summaries, etc.
      const embeddedIds = linkedFacts.map((f: any) => f._id);
      const otherFacts = await db.collection('semantic_facts')
        .find({
          user_id: userId,
          embedding: { $exists: false },
          _id: { $nin: embeddedIds },
        })
        .limit(20)
        .toArray();

      const allFacts = [...linkedFacts, ...otherFacts];

      if (allFacts.length > 0) {
        const texts = allFacts.map((f: any) => ({
          text: f.content || '',
          eventType: 'semantic_fact',
        }));
        const embeddings = await embeddingService.encodeBatch(texts);

        for (let i = 0; i < allFacts.length; i++) {
          const vec = embeddings[i];
          if (vec) {
            await embeddingService.storeEmbedding('semantic_facts', allFacts[i]._id, vec);
          }
        }
        console.log(`🧠 Embedded ${embeddings.filter(Boolean).length}/${allFacts.length} semantic facts (${linkedFacts.length} linked, ${otherFacts.length} other)`);
      }
    } catch (e: any) {
      console.warn('⚠️ Failed to embed semantic facts:', e.message);
    }
  }

  /**
   * Resolve extracted entities to canonical IDs before dispatch.
   * Updates entity IDs and relationship references in-place.
   */
  private async resolveExtractedEntities(
    extractionResult: any,
    context: { userId: string; sessionId: string }
  ): Promise<Map<string, string>> {
    const idMapping = new Map<string, string>();

    if (!extractionResult.entities || extractionResult.entities.length === 0) {
      return idMapping;
    }

    // Resolve each extracted entity to its canonical form
    for (const entity of extractionResult.entities) {
      try {
        const resolved = await entityResolver.resolveEntity({
          userId: context.userId,
          sessionId: context.sessionId,
          entityText: entity.name,
          entityType: entity.type,
          confidence: entity.confidence,
          contextTerms: entity.properties?.context_terms || entity.properties?.keywords || [],
          preferredId: entity.id
        });

        idMapping.set(entity.id, resolved.canonicalId);

        if (resolved.canonicalId !== entity.id) {
          console.log(`🔗 Entity resolved: "${entity.name}" ${entity.id.slice(-8)} → ${resolved.canonicalId.slice(-8)}`);
        }
      } catch (error) {
        console.warn(`⚠️ Entity resolution failed for "${entity.name}", using original ID:`, error);
        idMapping.set(entity.id, entity.id);
      }
    }

    // Rewrite entity IDs to canonical IDs
    for (const entity of extractionResult.entities) {
      const canonicalId = idMapping.get(entity.id);
      if (canonicalId) {
        entity.id = canonicalId;
      }
    }

    // Rewrite relationship references
    if (extractionResult.relationships) {
      for (const rel of extractionResult.relationships) {
        const canonicalFrom = idMapping.get(rel.from_entity_id);
        const canonicalTo = idMapping.get(rel.to_entity_id);
        if (canonicalFrom) rel.from_entity_id = canonicalFrom;
        if (canonicalTo) rel.to_entity_id = canonicalTo;
      }
    }

    // Rewrite event entity references
    if (extractionResult.events) {
      for (const evt of extractionResult.events) {
        if (Array.isArray(evt.entities_involved)) {
          evt.entities_involved = evt.entities_involved.map((id: string) => idMapping.get(id) || id);
        }
      }
    }

    // Rewrite semantic fact source entity references
    if (extractionResult.semantic_facts) {
      for (const fact of extractionResult.semantic_facts) {
        if (fact.properties?.source_entity_id) {
          const canonical = idMapping.get(fact.properties.source_entity_id);
          if (canonical) fact.properties.source_entity_id = canonical;
        }
      }
    }

    return idMapping;
  }

  /**
   * Check if an event has been recently processed to avoid reprocessing
   */
  private async isEventRecentlyProcessed(event: any): Promise<boolean> {
    // Check both metadata.processed and top-level processed (legacy events)
    if (event.metadata?.processed === true || event.processed === true) {
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

    // Hard dedup: skip if content_hash already exists in processing_log as completed.
    // Also mark the event as processed so it stops being fetched every cycle.
    try {
      const { get_database } = await import('../../database/connection.js');
      const db = get_database();
      const contentHash = event.content_hash;
      if (contentHash) {
        const existingCompleted = await db.collection('processing_log').findOne({
          idempotency_key: { $regex: new RegExp(contentHash.slice(0, 16)) },
          status: 'completed',
        });
        if (existingCompleted) {
          console.log(`🔄 Hard dedup: content ${contentHash.slice(0,8)} already fully processed, marking event as processed`);
          // Fix the metadata so this event stops clogging the attention gate
          await this.memoryManager.mark_event_processed(
            event.id || event._id?.toString(),
            {
              processed_at: new Date(),
              extraction_result: {
                entities_count: 0,
                relationships_count: 0,
                facts_count: 0,
                reason: 'hard_dedup_backfill',
              },
            }
          ).catch(() => {});
          return true;
        }
      }
    } catch {
      // Non-critical — if dedup check fails, event will still go through normal processing
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
      const { get_database } = await import('../../database/connection.js');
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
      const { get_database } = await import('../../database/connection.js');
      const db = get_database();
      const processingLogCollection = db.collection('processing_log');
      
      await processingLogCollection.insertOne({
        idempotency_key: idempotencyKey,
        event_id: eventId,
        session_id: sessionId,
        status: 'processing',
        started_at: new Date(),
        processor_id: `proc-${process.pid}`
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
      const { get_database } = await import('../../database/connection.js');
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