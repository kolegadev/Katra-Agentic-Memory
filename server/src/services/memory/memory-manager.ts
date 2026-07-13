/**
 * Central Memory Manager - Coordinates all memory operations
 * Clean version without duplicate functions
 */

import { get_database } from '../../database/connection.js';
import { ObjectId } from 'mongodb';
import { generateContentHash, generateIdempotencyKey, stableContentHash } from '../infrastructure/content-hash-utils.js';
import { MemoryDecayService } from '../processing/memory-decay-service.js';
import type { 
  EpisodicEvent, 
  KnowledgeNode, 
  KnowledgeRelationship, 
  WorkingMemorySession,
  SemanticFact,
  AssetMetadata,
  MemorySystemHealth 
} from '../../types/memory.js';

export class MemoryManager {
  private static instance: MemoryManager;
  private initialized = false;

  private constructor() {}

  static get_instance(): MemoryManager {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
    }
    return MemoryManager.instance;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const db = get_database();
      
      // Create collections and indexes - now enabled with safe conflict handling
      await this.setup_collections();
      
      this.initialized = true;
      console.log('✅ Memory Manager initialized successfully (indexes skipped)');
    } catch (error) {
      console.error('❌ Failed to initialize Memory Manager:', error);
      throw error;
    }
  }

  private async setup_collections(): Promise<void> {
    const db = get_database();

    // Helper function to safely create index
    const createIndexSafely = async (collection: string, index: any, options?: any) => {
      try {
        await db.collection(collection).createIndex(index, options);
      } catch (error: any) {
        if (error.codeName === 'IndexOptionsConflict' || error.code === 85) {
          console.log(`⚠️ Index already exists for ${collection}:`, JSON.stringify(index));
        } else {
          console.error(`❌ Failed to create index for ${collection}:`, error);
          throw error; // Re-throw if it's not a conflict
        }
      }
    };

    // Setup episodic_events collection with indexes
    await createIndexSafely('episodic_events', { user_id: 1 });
    await createIndexSafely('episodic_events', { session_id: 1 });
    await createIndexSafely('episodic_events', { timestamp: -1 });
    await createIndexSafely('episodic_events', { event_type: 1 });
    await createIndexSafely('episodic_events', { user_id: 1, timestamp: -1 });
    await createIndexSafely('episodic_events', { session_id: 1, timestamp: 1 });
    await createIndexSafely('episodic_events', { 'content.message': 'text' }, { background: true, name: 'episodic_text_index' });
    await createIndexSafely('episodic_events', { embedding: 1 }, { sparse: true });

    // Setup semantic_facts collection with indexes
    await createIndexSafely('semantic_facts', { user_id: 1 });
    await createIndexSafely('semantic_facts', { source: 1 });
    await createIndexSafely('semantic_facts', { confidence: -1 });
    await createIndexSafely('semantic_facts', { content: 'text' });
    await createIndexSafely('semantic_facts', { embedding: 1 }, { sparse: true });

    // Setup knowledge collections
    await createIndexSafely('knowledge_nodes', { user_id: 1 });
    await createIndexSafely('knowledge_nodes', { node_type: 1 });
    await createIndexSafely('knowledge_nodes', { 'content.name': 1 });

    await createIndexSafely('knowledge_relationships', { user_id: 1 });
    await createIndexSafely('knowledge_relationships', { relationship_type: 1 });
    await createIndexSafely('knowledge_relationships', { from_node_id: 1 });
    await createIndexSafely('knowledge_relationships', { to_node_id: 1 });

    // Setup working memory collections  
    await createIndexSafely('working_memory_sessions', { session_id: 1 });
    await createIndexSafely('working_memory_sessions', { user_id: 1 });
    await createIndexSafely('working_memory_sessions', { last_accessed: -1 });

    console.log('✅ Memory system collections and indexes setup completed');
  }

  // EPISODIC MEMORY METHODS
  async store_event(event: Omit<EpisodicEvent, 'id' | 'timestamp'>): Promise<string> {
    const db = get_database();
    
    const contentHash = generateContentHash({
      event_type: event.event_type,
      content: event.content,
      user_id: event.user_id,
      session_id: event.session_id,
    });

    const episodicEvent: EpisodicEvent = {
      ...event,
      id: this.generateId(),
      timestamp: new Date(),
      content_hash: contentHash,
      idempotency_key: generateIdempotencyKey(event, contentHash),
      metadata: {
        ...((event as any).metadata || {}),
        processed: false,
      },
    };

    const result = await db.collection('episodic_events').insertOne(episodicEvent);
    return result.insertedId.toString();
  }

  async get_event_by_id(event_id: string, user_id?: string): Promise<EpisodicEvent | null> {
    const db = get_database();
    const filter: any = { id: event_id };
    if (user_id) filter.user_id = user_id;
    const event = await db.collection('episodic_events')
      .findOne(filter);

    if (event) {
      const decayService = MemoryDecayService.get_instance();
      const accessCount = (event.metadata?.access_count || 0) + 1;
      const boost = decayService.boostOnRecall('episodic', event.metadata?.retrieval_strength || 0, accessCount - 1);

      await db.collection('episodic_events').updateOne(
        { id: event_id },
        {
          $set: {
            'metadata.retrieval_strength': boost.newStrength,
            'metadata.decay_exponent': boost.newDecayExponent,
            'metadata.last_accessed_at': new Date(),
            'metadata.access_count': accessCount,
          },
        }
      );
    }

    return event as any as EpisodicEvent | null;
  }

  async get_events_by_session(session_id: string, limit: number = 50, user_id?: string): Promise<EpisodicEvent[]> {
    const db = get_database();
    const filter: any = { session_id };
    if (user_id) filter.user_id = user_id;
    const events = await db.collection('episodic_events')
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    return events as any as EpisodicEvent[];
  }

  async get_session_events(session_id: string, limit: number = 50, user_id?: string): Promise<EpisodicEvent[]> {
    return this.get_events_by_session(session_id, limit, user_id);
  }

  async mark_event_processed(event_id: string, processing_metadata: any, user_id?: string): Promise<void> {
    const db = get_database();
    const filter: any = { id: event_id };
    if (user_id) filter.user_id = user_id;
    await db.collection('episodic_events').updateOne(
      filter,
      {
        $set: {
          'metadata.processed': true,
          'metadata.processing_metadata': processing_metadata,
          'metadata.processed_at': new Date()
        }
      }
    );
  }

  async mark_event_processing_failed(event_id: string, error_message: string): Promise<void> {
    const db = get_database();
    const MAX_RETRIES = 3;

    // Increment retry count and decide if this is a terminal failure.
    await db.collection('episodic_events').updateOne(
      { id: event_id },
      {
        $set: {
          'metadata.processing_failed': true,
          'metadata.processing_error': error_message,
          'metadata.processing_failed_at': new Date(),
        },
        $inc: { 'metadata.processing_attempts': 1 },
      }
    );

    // After MAX_RETRIES attempts, mark the event as processed so it stops
    // being fetched every cycle. This prevents infinite retry loops on
    // permanently broken events.
    const event = await db.collection('episodic_events').findOne({ id: event_id });
    const attempts = (event?.metadata?.processing_attempts as number) || 1;
    if (attempts >= MAX_RETRIES) {
      await db.collection('episodic_events').updateOne(
        { id: event_id },
        {
          $set: {
            'metadata.processed': true,
            'metadata.terminal_failure': true,
            'metadata.terminal_failure_at': new Date(),
          },
        }
      );
    }

    // Update the processing log from 'processing' to 'failed' so the event can
    // be retried (unless it has hit MAX_RETRIES and been marked processed).
    const idempotencyKey = event?.idempotency_key;
    if (idempotencyKey) {
      try {
        await db.collection('processing_log').updateOne(
          { idempotency_key: idempotencyKey },
          {
            $set: {
              status: 'failed',
              error: error_message,
              failed_at: new Date(),
              updated_at: new Date(),
            },
          }
        );
      } catch (logError) {
        console.warn('⚠️ Failed to update processing log to failed:', logError);
      }
    }
  }

  // WORKING MEMORY METHODS
  async get_session_state(session_id: string, user_id?: string): Promise<WorkingMemorySession | null> {
    const db = get_database();
    const filter: any = { session_id };
    if (user_id) filter.user_id = user_id;
    const result = await db.collection('working_memory_sessions').findOne(filter);
    return result as unknown as WorkingMemorySession | null;
  }

  // SEMANTIC MEMORY METHODS
  async add_semantic_fact(fact: SemanticFact): Promise<string> {
    try {
      const db = get_database();

      // Content-stable dedup: identical (user_id + content) upserts onto the
      // same document instead of creating duplicates on every extraction cycle.
      const userId = fact.user_id || 'unknown';
      const contentHash = stableContentHash(userId, fact.content);

      // Strip created_at from the spread — it's handled by $setOnInsert below.
      // Including it would conflict: $set sets created_at + $setOnInsert also
      // sets created_at → MongoServerError "would create a conflict".
      const { created_at: _ca, ...factFields } = fact as any;
      const factDocument = {
        ...factFields,
        user_id: userId,
        content_hash: contentHash,
        updated_at: new Date(),
      };

      const result = await db.collection('semantic_facts').findOneAndUpdate(
        { content_hash: contentHash },
        {
          $set: factDocument,
          $setOnInsert: { created_at: new Date() },
          $inc: { extraction_count: 1 },
        },
        { upsert: true, returnDocument: 'after' }
      );

      const fact_id = result?._id?.toString();
      if (!fact_id) {
        throw new Error('Semantic fact upsert returned no document id');
      }

      // BIDIRECTIONAL DATA LINEAGE: Add linkage if source event exists
      if (fact.metadata?.extraction_context?.source_event_id) {
        await this.add_derived_fact_to_event(
          fact.metadata.extraction_context.source_event_id,
          fact_id
        );
      }

      return fact_id;
    } catch (error) {
      console.error('❌ Failed to store semantic fact:', error);
      throw error;
    }
  }

  async search_semantic_facts(user_id: string, query: string, limit = 10): Promise<SemanticFact[]> {
    const db = get_database();
    const result = await db.collection('semantic_facts')
      .find({
        user_id,
        $text: { $search: query }
      })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .toArray();

    if (result.length > 0) {
      const decayService = MemoryDecayService.get_instance();
      const bulkOps = result.map((doc: any) => {
        const accessCount = (doc.access_count || 0) + 1;
        const boost = decayService.boostOnRecall('semantic', doc.retrieval_strength || 0, accessCount - 1);
        return {
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set: {
                retrieval_strength: boost.newStrength,
                decay_exponent: boost.newDecayExponent,
                last_accessed_at: new Date(),
                access_count: accessCount,
              },
            },
          },
        };
      });

      try {
        await db.collection('semantic_facts').bulkWrite(bulkOps, { ordered: false });
      } catch {
        // Individual failures are non-fatal — results still returned
      }
    }

    return result as any as SemanticFact[];
  }

  // BIDIRECTIONAL DATA LINEAGE IMPLEMENTATION

  /**
   * Add bidirectional linkage: Update episodic event with derived fact ID
   * This creates the link: episodic_event ←→ semantic_fact
   */
  private async add_derived_fact_to_event(event_id: string, fact_id: string): Promise<void> {
    try {
      const db = get_database();
      const result = await db.collection('episodic_events').updateOne(
        { id: event_id },
        { 
          $addToSet: { 
            'metadata.derived_facts': fact_id 
          },
          $set: {
            'metadata.has_derived_content': true,
            'metadata.last_processed': new Date()
          }
        }
      );
      
      if (result.modifiedCount > 0) {
        console.log(`✅ Added bidirectional linkage: event ${event_id} ←→ fact ${fact_id}`);
      } else {
        console.warn(`⚠️ Could not link fact ${fact_id} to event ${event_id} (event not found)`);
      }
    } catch (error) {
      console.error('❌ Failed to add bidirectional fact linkage:', error);
    }
  }

  /**
   * DATA LINEAGE QUERY: Trace semantic fact back to source conversation
   * Answers: "Where did this knowledge come from?"
   */
  async get_fact_lineage(fact_id: string): Promise<{
    fact: any;
    source_event: any;
    conversation_context: any[];
    session_info: {
      session_id: string;
      total_events_in_session: number;
      event_position_in_session: number;
    };
  } | null> {
    try {
      const db = get_database();
      const { ObjectId } = await import('mongodb');
      
      // Get the semantic fact
      const fact = await db.collection('semantic_facts').findOne({ 
        _id: new ObjectId(fact_id) 
      });
      
      if (!fact || !fact.metadata?.extraction_context?.source_event_id) {
        return null;
      }
      
      const source_event_id = fact.metadata.extraction_context.source_event_id;
      
      // Get the source episodic event
      const source_event = await db.collection('episodic_events').findOne({
        id: source_event_id
      });
      
      if (!source_event) {
        return null;
      }
      
      // Get conversation context (events from same session, around the source event)
      const session_id = source_event.session_id;
      const source_timestamp = source_event.timestamp;
      
      const conversation_context = await db.collection('episodic_events')
        .find({
          session_id: session_id,
          timestamp: { 
            $gte: new Date(source_timestamp.getTime() - 300000), // 5 min before
            $lte: new Date(source_timestamp.getTime() + 300000)  // 5 min after
          }
        })
        .sort({ timestamp: 1 })
        .toArray();
      
      // Get session statistics
      const total_session_events = await db.collection('episodic_events').countDocuments({
        session_id: session_id
      });
      
      const events_before = await db.collection('episodic_events').countDocuments({
        session_id: session_id,
        timestamp: { $lt: source_timestamp }
      });
      
      return {
        fact,
        source_event,
        conversation_context,
        session_info: {
          session_id,
          total_events_in_session: total_session_events,
          event_position_in_session: events_before + 1
        }
      };
      
    } catch (error) {
      console.error('❌ Failed to get fact lineage:', error);
      return null;
    }
  }

  /**
   * DATA LINEAGE QUERY: Get all semantic facts derived from a specific conversation
   * Answers: "What knowledge was extracted from this conversation?"
   */
  async get_event_derived_facts(event_id: string): Promise<{
    event: any;
    derived_facts: any[];
    processing_stats: {
      total_facts_derived: number;
      processing_date: Date | null;
      has_unprocessed_content: boolean;
    };
  } | null> {
    try {
      const db = get_database();
      
      // Get event with derived fact IDs
      const event = await db.collection('episodic_events').findOne({ id: event_id });
      if (!event) {
        return null;
      }
      
      const derived_fact_ids = event.metadata?.derived_facts || [];
      let derived_facts: any[] = [];
      
      if (derived_fact_ids.length > 0) {
        const { ObjectId } = await import('mongodb');
        const fact_object_ids = derived_fact_ids
          .map((id: string) => {
            try {
              return new ObjectId(id);
            } catch {
              return null;
            }
          })
          .filter((id: ObjectId | null): id is ObjectId => id !== null);
        
        derived_facts = await db.collection('semantic_facts')
          .find({ _id: { $in: fact_object_ids } })
          .toArray();
      }
      
      return {
        event,
        derived_facts,
        processing_stats: {
          total_facts_derived: derived_facts.length,
          processing_date: event.metadata?.last_processed || null,
          has_unprocessed_content: !event.metadata?.processed
        }
      };
      
    } catch (error) {
      console.error('❌ Failed to get event derived facts:', error);
      return null;
    }
  }

  /**
   * DATA LINEAGE QUERY: Get conversation provenance for multiple facts
   * Answers: "Which conversations contributed to this knowledge set?"
   */
  async get_facts_conversation_provenance(fact_ids: string[]): Promise<{
    sessions: Map<string, {
      session_id: string;
      fact_count: number;
      conversations: any[];
      earliest_contribution: Date;
      latest_contribution: Date;
    }>;
    total_conversations: number;
    total_sessions: number;
  }> {
    try {
      const db = get_database();
      const { ObjectId } = await import('mongodb');
      
      // Get all facts
      const fact_object_ids = fact_ids
        .map(id => {
          try {
            return new ObjectId(id);
          } catch {
            return null;
          }
        })
        .filter((id: ObjectId | null): id is ObjectId => id !== null);
      
      const facts = await db.collection('semantic_facts')
        .find({ _id: { $in: fact_object_ids } })
        .toArray();
      
      // Group facts by source event and session
      const session_map = new Map();
      
      for (const fact of facts) {
        const source_event_id = fact.metadata?.extraction_context?.source_event_id;
        if (!source_event_id) continue;
        
        // Get source event to find session
        const source_event = await db.collection('episodic_events').findOne({
          id: source_event_id
        });
        
        if (!source_event) continue;
        
        const session_id = source_event.session_id;
        
        if (!session_map.has(session_id)) {
          session_map.set(session_id, {
            session_id,
            fact_count: 0,
            conversations: [],
            earliest_contribution: source_event.timestamp,
            latest_contribution: source_event.timestamp
          });
        }
        
        const session_data = session_map.get(session_id);
        session_data.fact_count++;
        
        // Update timestamp bounds
        if (source_event.timestamp < session_data.earliest_contribution) {
          session_data.earliest_contribution = source_event.timestamp;
        }
        if (source_event.timestamp > session_data.latest_contribution) {
          session_data.latest_contribution = source_event.timestamp;
        }
        
        // Add conversation event (avoid duplicates)
        const existing_event = session_data.conversations.find((e: any) => e.id === source_event.id);
        if (!existing_event) {
          session_data.conversations.push(source_event);
        }
      }
      
      return {
        sessions: session_map,
        total_conversations: Array.from(session_map.values()).reduce((sum, session) => sum + session.conversations.length, 0),
        total_sessions: session_map.size
      };
      
    } catch (error) {
      console.error('❌ Failed to get facts conversation provenance:', error);
      return {
        sessions: new Map(),
        total_conversations: 0,
        total_sessions: 0
      };
    }
  }

  // UTILITY METHODS
  private generateId(): string {
    return Date.now().toString() + Math.random().toString(36).substring(2);
  }

  // ADDITIONAL COMPATIBILITY METHODS FOR ROUTES

  // Working Memory Session Management
  async set_session_state(session_id: string, user_id: string, state: any): Promise<void> {
    const db = get_database();
    const session: WorkingMemorySession = {
      session_id,
      user_id,
      state,
      last_accessed: new Date()
    };

    await db.collection('working_memory_sessions').replaceOne(
      { session_id },
      session,
      { upsert: true }
    );

    console.log(`✅ Session state set for session ${session_id}`);
  }

  async get_active_sessions(user_id?: string): Promise<WorkingMemorySession[]> {
    const db = get_database();
    const filter = user_id ? { user_id } : {};
    
    // Get sessions from last 24 hours
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const sessions = await db.collection('working_memory_sessions')
      .find({
        ...filter,
        last_accessed: { $gte: cutoff }
      })
      .sort({ last_accessed: -1 })
      .toArray();

    return sessions as any as WorkingMemorySession[];
  }

  // Asset Management
  async store_asset_metadata(metadata: AssetMetadata): Promise<void> {
    const db = get_database();
    await db.collection('asset_metadata').replaceOne(
      { id: metadata.id },
      { ...metadata, stored_at: new Date() },
      { upsert: true }
    );
    
    console.log(`✅ Asset metadata stored for ${metadata.id}`);
  }

  async get_asset_metadata(asset_id: string): Promise<AssetMetadata | null> {
    const db = get_database();
    const result = await db.collection('asset_metadata').findOne({ id: asset_id });
    return result as unknown as AssetMetadata | null;
  }

  async get_user_assets(user_id: string, limit: number = 50): Promise<AssetMetadata[]> {
    const db = get_database();
    const assets = await db.collection('asset_metadata')
      .find({ user_id })
      .sort({ stored_at: -1 })
      .limit(limit)
      .toArray();
    
    return assets as any as AssetMetadata[];
  }

  // User Events
  async get_user_events(user_id: string, limit: number = 100): Promise<EpisodicEvent[]> {
    const db = get_database();
    const events = await db.collection('episodic_events')
      .find({ user_id })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    
    return events as any as EpisodicEvent[];
  }

  // Background Processing Support
  async get_unprocessed_events(limit: number = 50): Promise<EpisodicEvent[]> {
    const db = get_database();
    const events = await db.collection('episodic_events')
      .find({ 
        'metadata.processed': { $ne: true },
        'metadata.terminal_failure': { $ne: true },
        // Must have id for processing — content_hash is computed on-the-fly if missing
        id: { $exists: true, $ne: null },
        user_id: { $exists: true, $ne: null },
        session_id: { $exists: true, $ne: null },
      })
      .sort({ timestamp: 1 })
      .limit(limit)
      .toArray();
    
    return events as any as EpisodicEvent[];
  }

  // Knowledge Graph Methods (Stub implementations)
  async upsert_node(node: KnowledgeNode): Promise<void> {
    console.log(`🔗 Upserting node ${node.id} (stub implementation)`);
    const db = get_database();
    await db.collection('knowledge_nodes').replaceOne(
      { id: node.id },
      node,
      { upsert: true }
    );
  }

  async get_node(node_id: string): Promise<KnowledgeNode | null> {
    console.log(`🔗 Getting node ${node_id} (stub implementation)`);
    const db = get_database();
    const result = await db.collection('knowledge_nodes').findOne({ id: node_id });
    return result as unknown as KnowledgeNode | null;
  }

  async add_relationship(relationship: KnowledgeRelationship): Promise<void> {
    const db = get_database();
    // Idempotent upsert keyed on the unique triple (from_id, to_id,
    // relationship_type). Re-observing the same edge updates properties and
    // bumps last_accessed_at instead of throwing a duplicate-key error — the
    // knowledge graph strengthens edges over time rather than rejecting them.
    const { from_id, to_id, relationship_type } = relationship;
    // Strip created_at from the $set payload so it doesn't conflict with the
    // $setOnInsert below (MongoDB rejects a field appearing in both).
    const { created_at: _ignore, ...rel_fields } = relationship as any;
    await db.collection('knowledge_relationships').updateOne(
      { from_id, to_id, relationship_type },
      {
        $set: {
          ...rel_fields,
          last_accessed_at: new Date(),
        },
        $setOnInsert: { created_at: new Date() },
        $inc: { access_count: 1 },
      },
      { upsert: true }
    );
  }

  async get_connected_nodes(node_id: string, max_depth: number = 2): Promise<any[]> {
    console.log(`🔗 Getting connected nodes for ${node_id}, depth ${max_depth} (stub implementation)`);
    return [];
  }

  // System Health and Statistics
  async get_system_health(): Promise<MemorySystemHealth> {
    try {
      const db = get_database();
      
      const [
        episodic_count,
        knowledge_node_count,
        relationship_count,
        session_count,
        asset_count
      ] = await Promise.all([
        db.collection('episodic_events').countDocuments(),
        db.collection('knowledge_nodes').countDocuments(),
        db.collection('knowledge_relationships').countDocuments(),
        db.collection('working_memory_sessions').countDocuments(),
        db.collection('asset_metadata').countDocuments()
      ]);

      return {
        episodic_memory: {
          status: 'healthy',
          mongodb_connected: true,
          total_events: episodic_count
        },
        knowledge_graph: {
          status: 'healthy',
          mongodb_connected: true,
          total_nodes: knowledge_node_count,
          total_relationships: relationship_count
        },
        working_memory: {
          status: 'healthy',
          redis_connected: true, // We'll assume Redis is connected for now
          active_sessions: session_count
        },
        asset_storage: {
          status: 'healthy',
          s3_connected: true, // We'll assume S3 is connected for now
          total_assets: asset_count
        }
      };
    } catch (error) {
      const error_status = 'unavailable';
      return {
        episodic_memory: {
          status: error_status,
          mongodb_connected: false,
          total_events: 0
        },
        knowledge_graph: {
          status: error_status,
          mongodb_connected: false,
          total_nodes: 0,
          total_relationships: 0
        },
        working_memory: {
          status: error_status,
          redis_connected: false,
          active_sessions: 0
        },
        asset_storage: {
          status: error_status,
          s3_connected: false,
          total_assets: 0
        }
      };
    }
  }

  async get_memory_statistics(): Promise<any> {
    const health = await this.get_system_health();
    return {
      ...health,
      uptime: process.uptime(),
      memory_usage: process.memoryUsage(),
      active_sessions: health.working_memory.active_sessions || 0
    };
  }

  // Maintenance
  async cleanup_expired_sessions(): Promise<number> {
    const db = get_database();
    
    // Remove sessions older than 7 days
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    const result = await db.collection('working_memory_sessions').deleteMany({
      last_accessed: { $lt: cutoff }
    });

    console.log(`🧹 Cleaned up ${result.deletedCount} expired sessions`);
    return result.deletedCount;
  }

  async get_health(): Promise<any> {
    return await this.get_system_health();
  }
}