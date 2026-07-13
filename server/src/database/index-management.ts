/**
 * MongoDB Index Management
 * 
 * Handles safe creation and cleanup of MongoDB indexes to prevent conflicts
 * and ensure proper database initialization.
 */

import { Db, Collection } from 'mongodb';

export interface IndexDefinition {
  keys: Record<string, any>;
  options: {
    name: string;
    unique?: boolean;
    sparse?: boolean;
    background?: boolean;
    expireAfterSeconds?: number;
  };
}

export interface CollectionIndexes {
  [collectionName: string]: IndexDefinition[];
}

// Define all required indexes for the memory system
export const MEMORY_SYSTEM_INDEXES: CollectionIndexes = {
  episodic_events: [
    {
      keys: { timestamp: -1 },
      options: { name: 'timestamp_desc', background: true }
    },
    {
      keys: { user_id: 1, timestamp: -1 },
      options: { name: 'user_timestamp', background: true }
    },
    {
      keys: { user_id: 1, session_id: 1, timestamp: -1 },
      options: { name: 'user_session_timestamp', background: true }
    },
    {
      keys: { shared_id: 1, timestamp: -1 },
      options: { name: 'shared_timestamp', sparse: true, background: true }
    },
    {
      keys: { content_hash: 1 },
      options: { name: 'content_hash', unique: false, sparse: true, background: true }
    },
    {
      keys: { 'metadata.processed': 1, timestamp: 1 },
      options: { name: 'processing_status', background: true }
    },
    // Text search index for content
    {
      keys: { 'content.message': 'text' },
      options: { name: 'content_text_search', background: true }
    }
  ],
  
  knowledge_nodes: [
    {
      keys: { type: 1, name: 1 },
      options: { name: 'type_name', background: true }
    },
    {
      keys: { user_id: 1, type: 1 },
      options: { name: 'user_type', background: true }
    },
    {
      keys: { session_id: 1, user_id: 1 },
      options: { name: 'session_user', background: true }
    },
    {
      keys: { updated_at: -1 },
      options: { name: 'updated_desc', background: true }
    },
    // Text search for entity names and descriptions
    {
      keys: { 'properties.name': 'text', 'properties.description': 'text' },
      options: { name: 'entity_text_search', background: true }
    }
  ],
  
  knowledge_relationships: [
    {
      keys: { from_id: 1, to_id: 1, relationship_type: 1 },
      options: { name: 'from_to_type', unique: true, background: true, sparse: true }
    },
    {
      keys: { user_id: 1, relationship_type: 1 },
      options: { name: 'user_type', background: true }
    },
    {
      keys: { session_id: 1 },
      options: { name: 'session_relationships', background: true }
    }
  ],
  
  semantic_facts: [
    {
      keys: { user_id: 1, fact_type: 1 },
      options: { name: 'user_fact_type', background: true }
    },
    {
      keys: { shared_id: 1, fact_type: 1 },
      options: { name: 'shared_fact_type', sparse: true, background: true }
    },
    {
      keys: { session_id: 1, user_id: 1 },
      options: { name: 'session_user', background: true }
    },
    {
      keys: { updated_at: -1 },
      options: { name: 'updated_desc', background: true }
    },
    // Text search for fact content
    {
      keys: { content: 'text' },
      options: { name: 'content_text_search', background: true }
    }
  ],
  
  memory_nodes: [
    {
      keys: { label: 1 },
      options: { name: 'label_unique', unique: true, background: true }
    },
    {
      keys: { type: 1 },
      options: { name: 'type_index', background: true }
    },
    {
      keys: { updated_at: -1 },
      options: { name: 'updated_desc', background: true }
    },
    {
      keys: { user_id: 1, updated_at: -1 },
      options: { name: 'user_updated_desc', background: true }
    }
  ],

  memory_missions: [
    {
      keys: { user_id: 1, status: 1 },
      options: { name: 'user_status_index', background: true }
    },
    {
      keys: { shared_id: 1, status: 1 },
      options: { name: 'shared_status_index', sparse: true, background: true }
    },
    {
      keys: { updated_at: -1 },
      options: { name: 'mission_updated_desc', background: true }
    }
  ],

  memory_edges: [
    {
      keys: { source: 1, target: 1, relationship: 1 },
      options: { name: 'source_target_rel', background: true }
    },
    {
      keys: { target: 1 },
      options: { name: 'target_index', background: true }
    },
    {
      keys: { weight: -1 },
      options: { name: 'weight_desc', background: true }
    },
    {
      keys: { confidence: 1 },
      options: { name: 'confidence_index', background: true }
    },
    {
      keys: { user_id: 1, weight: -1 },
      options: { name: 'user_weight_desc', background: true }
    }
  ],

  working_memory_sessions: [
    {
      keys: { user_id: 1, session_id: 1 },
      options: { name: 'user_session', unique: true, background: true }
    },
    {
      keys: { last_active: -1 },
      options: { name: 'last_active_desc', background: true }
    },
    // TTL index for session cleanup
    {
      keys: { last_active: 1 },
      options: {
        name: 'session_ttl',
        expireAfterSeconds: 86400, // 24 hours
        background: true
      }
    }
  ],

  asset_metadata: [
    {
      keys: { userId: 1 },
      options: { name: 'user_id', background: true }
    },
    {
      keys: { createdAt: -1 },
      options: { name: 'created_desc', background: true }
    },
    // Text search for file names and descriptions
    {
      keys: { fileName: 'text', description: 'text' },
      options: { name: 'asset_text_search', background: true }
    }
  ],

  heartbeat_journal: [
    {
      keys: { user_id: 1, timestamp: -1 },
      options: { name: 'user_timestamp', background: true }
    }
  ],

  // System settings collection for memory scope and other runtime config
  system_settings: [
    {
      keys: { key: 1 },
      options: { name: 'key_unique', unique: true, background: true }
    }
  ],

  // ── Sleep Consolidation / Reflection Collections ──────────────

  reflective_journals: [
    {
      keys: { user_id: 1, period_type: 1, period_start: -1 },
      options: { name: 'user_period_start', background: true }
    },
    {
      keys: { user_id: 1, created_at: -1 },
      options: { name: 'user_created', background: true }
    }
  ],

  reflection_nodes: [
    {
      keys: { user_id: 1, entity_name: 1 },
      options: { name: 'user_entity_unique', unique: true, background: true }
    },
    {
      keys: { user_id: 1, 'emotional_signature.primary_emotion': 1 },
      options: { name: 'user_emotion', background: true }
    }
  ],

  reflection_edges: [
    {
      keys: { user_id: 1, source_entity: 1, target_entity: 1, edge_type: 1 },
      options: { name: 'user_edge_unique', background: true }
    },
    {
      keys: { user_id: 1, source_journal_id: 1 },
      options: { name: 'user_journal', background: true }
    }
  ],

  philosophical_insights: [
    {
      keys: { user_id: 1, domain: 1 },
      options: { name: 'user_domain', background: true }
    },
    {
      keys: { user_id: 1, status: 1 },
      options: { name: 'user_status', background: true }
    }
  ]
};

export class IndexManager {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Clean up all existing indexes except _id_ and recreate them safely
   */
  async cleanupAndRecreateIndexes(): Promise<{
    cleaned_collections: string[];
    created_indexes: Record<string, string[]>;
    errors: Array<{ collection: string; index?: string; error: string }>;
  }> {
    const result = {
      cleaned_collections: [] as string[],
      created_indexes: {} as Record<string, string[]>,
      errors: [] as Array<{ collection: string; index?: string; error: string }>
    };

    console.log('🧹 Starting index cleanup and recreation...');

    for (const [collectionName, indexDefinitions] of Object.entries(MEMORY_SYSTEM_INDEXES)) {
      try {
        const collection = this.db.collection(collectionName);
        
        // Clean existing indexes
        await this.cleanCollectionIndexes(collection, collectionName);
        result.cleaned_collections.push(collectionName);
        
        // Create new indexes
        const createdIndexes = await this.createCollectionIndexes(
          collection,
          collectionName,
          indexDefinitions
        );
        result.created_indexes[collectionName] = createdIndexes;

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        result.errors.push({
          collection: collectionName,
          error: errorMsg
        });
        console.error(`❌ Failed to process indexes for ${collectionName}:`, error);
      }
    }

    console.log(`✅ Index management completed: ${result.cleaned_collections.length} collections processed`);
    return result;
  }

  /**
   * Clean all indexes except _id_ from a collection
   */
  private async cleanCollectionIndexes(collection: Collection, collectionName: string): Promise<void> {
    try {
      const existingIndexes = await collection.indexes();
      
      for (const index of existingIndexes) {
        if (index.name !== '_id_') {
          try {
            await collection.dropIndex(index.name!);
            console.log(`🗑️ Dropped index ${index.name} from ${collectionName}`);
          } catch (dropError) {
            // Ignore "index not found" errors
            if (!(dropError instanceof Error && dropError.message.includes('index not found'))) {
              console.warn(`⚠️ Failed to drop index ${index.name} from ${collectionName}:`, dropError);
            }
          }
        }
      }
    } catch (error) {
      // Collection might not exist yet, which is fine
      if (!(error instanceof Error && error.message.includes('ns not found'))) {
        throw error;
      }
    }
  }

  /**
   * Create indexes for a collection with error handling
   */
  private async createCollectionIndexes(
    collection: Collection,
    collectionName: string,
    indexDefinitions: IndexDefinition[]
  ): Promise<string[]> {
    const createdIndexes: string[] = [];

    for (const indexDef of indexDefinitions) {
      try {
        await collection.createIndex(indexDef.keys, indexDef.options);
        createdIndexes.push(indexDef.options.name);
        console.log(`✅ Created index ${indexDef.options.name} on ${collectionName}`);
        
        // Small delay to prevent overwhelming MongoDB
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (createError) {
        const errorMsg = createError instanceof Error ? createError.message : 'Unknown error';
        
        // Log but continue with other indexes
        console.error(`❌ Failed to create index ${indexDef.options.name} on ${collectionName}:`, errorMsg);
        
        // Don't throw - we want to continue creating other indexes
      }
    }

    return createdIndexes;
  }

  /**
   * Check if all required indexes exist
   */
  async validateIndexes(): Promise<{
    valid: boolean;
    missing_indexes: Array<{ collection: string; index: string }>;
    extra_indexes: Array<{ collection: string; index: string }>;
  }> {
    const result = {
      valid: true,
      missing_indexes: [] as Array<{ collection: string; index: string }>,
      extra_indexes: [] as Array<{ collection: string; index: string }>
    };

    for (const [collectionName, expectedIndexes] of Object.entries(MEMORY_SYSTEM_INDEXES)) {
      try {
        const collection = this.db.collection(collectionName);
        const existingIndexes = await collection.indexes();
        const existingIndexNames = existingIndexes.map(idx => idx.name).filter(name => name !== '_id_');
        const expectedIndexNames = expectedIndexes.map(idx => idx.options.name);

        // Find missing indexes
        for (const expectedName of expectedIndexNames) {
          if (!existingIndexNames.includes(expectedName)) {
            result.missing_indexes.push({ collection: collectionName, index: expectedName });
            result.valid = false;
          }
        }

        // Find extra indexes (optional check)
        for (const existingName of existingIndexNames) {
          if (existingName && !expectedIndexNames.includes(existingName)) {
            result.extra_indexes.push({ collection: collectionName, index: existingName });
          }
        }

      } catch (error) {
        // Collection might not exist, which means all indexes are missing
        const expectedIndexNames = MEMORY_SYSTEM_INDEXES[collectionName].map(idx => idx.options.name);
        for (const indexName of expectedIndexNames) {
          result.missing_indexes.push({ collection: collectionName, index: indexName });
        }
        result.valid = false;
      }
    }

    return result;
  }

  /**
   * Get index statistics for monitoring
   */
  async getIndexStats(): Promise<Record<string, any>> {
    const stats: Record<string, any> = {};

    for (const collectionName of Object.keys(MEMORY_SYSTEM_INDEXES)) {
      try {
        const collection = this.db.collection(collectionName);
        const indexes = await collection.indexes();
        const document_count = await collection.countDocuments();

        stats[collectionName] = {
          document_count: document_count,
          index_count: indexes.length,
          indexes: indexes.map(idx => ({
            name: idx.name,
            keys: idx.key,
            unique: idx.unique || false,
            sparse: idx.sparse || false
          }))
        };

      } catch (error) {
        stats[collectionName] = {
          error: error instanceof Error ? error.message : 'Unknown error',
          document_count: 0,
          index_count: 0,
          indexes: []
        };
      }
    }

    return stats;
  }
}

/**
 * Initialize indexes with proper error handling and cleanup
 */
export async function initializeMemorySystemIndexes(db: Db): Promise<void> {
  console.log('🗃️ Initializing memory system indexes...');
  
  const indexManager = new IndexManager(db);
  
  try {
    // First validate what we have
    const validation = await indexManager.validateIndexes();
    
    if (validation.valid) {
      console.log('✅ All indexes are present and valid');
      return;
    }

    console.log(`⚠️ Found ${validation.missing_indexes.length} missing indexes, ${validation.extra_indexes.length} extra indexes`);
    
    // Clean up and recreate all indexes
    const result = await indexManager.cleanupAndRecreateIndexes();
    
    if (result.errors.length > 0) {
      console.warn(`⚠️ Index creation completed with ${result.errors.length} errors:`, result.errors);
    } else {
      console.log('✅ All indexes created successfully');
    }
    
    // Final validation
    const finalValidation = await indexManager.validateIndexes();
    if (finalValidation.valid) {
      console.log('✅ Index initialization completed successfully');
    } else {
      console.warn(`⚠️ Index initialization completed with ${finalValidation.missing_indexes.length} missing indexes`);
    }

  } catch (error) {
    console.error('❌ Index initialization failed:', error);
    // Don't throw - let the system continue without optimal indexes
  }
}