import { Hono } from 'hono';
import { get_database } from '../database/connection.js';
import { getEpisodicEventManager } from '../services/episodic-event-manager.js';
import { get_redis_client } from '../database/redis-connection.js';
import { llmService } from '../services/llm-service.js';
import { backgroundProcessor } from '../services/background-processor.js';
import { IndexManager } from '../database/index-management.js';
import { get_error_message, get_error_stack } from '../utils/error-utils.js';

export const create_admin_routes = (): Hono => {
  const router = new Hono();

  /**
   * Clear all data from MongoDB and Redis
   * WARNING: This will permanently delete ALL data
   */
  router.post('/clear-all', async (c) => {
    try {
      console.log('🗑️ Starting database clear operation...');
      
      const results = {
        mongodb: { cleared: false as boolean, collections: 0 as number, documents: 0 as number, error: null as string | null },
        redis: { cleared: false as boolean, keys: 0 as number, error: null as string | null },
        timestamp: new Date().toISOString()
      };

      // Clear MongoDB collections - target known collections directly
      try {
        const db = get_database();
        
        // List of known collection names used by the application
        const knownCollections = [
          'episodic_events',
          'semantic_facts', 
          'knowledge_nodes',
          'knowledge_relationships',
          'conversations',
          'messages',
          'users',
          'sessions',
          'working_memory',
          'memory_contexts',
          'chat_sessions',
          'user_profiles'
        ];
        
        let totalDocuments = 0;
        let clearedCollections = 0;
        
        for (const collectionName of knownCollections) {
          try {
            const coll = db.collection(collectionName);
            
            // Count documents before deletion
            const docCount = await coll.countDocuments();
            
            if (docCount > 0) {
              // Use deleteMany instead of drop to avoid permission issues
              const deleteResult = await coll.deleteMany({});
              totalDocuments += deleteResult.deletedCount || docCount;
              clearedCollections++;
              console.log(`✅ Cleared MongoDB collection: ${collectionName} (${deleteResult.deletedCount || docCount} documents)`);
            } else {
              console.log(`✅ MongoDB collection ${collectionName} was already empty`);
            }
          } catch (collError: any) {
            // If collection doesn't exist or we can't access it, that's fine
            console.log(`ℹ️ Skipped MongoDB collection ${collectionName}: ${collError.message}`);
          }
        }
        
        results.mongodb.cleared = true;
        results.mongodb.collections = clearedCollections;
        results.mongodb.documents = totalDocuments;
        
        console.log(`✅ MongoDB cleared: ${clearedCollections} collections, ${totalDocuments} documents`);
      } catch (mongodb_error: any) {
        console.error('❌ MongoDB clear error:', mongodb_error);
        results.mongodb.error = mongodb_error.message;
      }

      // Clear Redis keys
      try {
        const redis_client = await get_redis_client();
        
        if (redis_client) {
          // Get all keys first (for counting)
          const keys = await redis_client.keys('*');
          const keyCount = keys.length;
          
          if (keyCount > 0) {
            // Use FLUSHDB to clear the current database
            await redis_client.flushDb();
            results.redis.cleared = true;
            results.redis.keys = keyCount;
            console.log(`✅ Redis cleared: ${keyCount} keys`);
          } else {
            results.redis.cleared = true;
            results.redis.keys = 0;
            console.log('✅ Redis was already empty');
          }
        } else {
          console.warn('⚠️ Redis client not available - skipping Redis clear');
          results.redis.error = 'Redis client not available';
        }
      } catch (redis_error: any) {
        console.error('❌ Redis clear error:', redis_error);
        results.redis.error = redis_error.message;
      }

      // Determine overall success
      const success = results.mongodb.cleared || results.redis.cleared;
      const status = success ? 200 : 500;

      console.log('🗑️ Database clear operation completed:', results);

      return c.json({
        success,
        message: success ? 'Database clear operation completed' : 'Database clear operation failed',
        results
      }, status);

    } catch (error: any) {
      console.error('❌ Database clear operation failed:', error);
      return c.json({
        success: false,
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString()
      }, 500);
    }
  });

  /**
   * Get database statistics (useful for confirming clear operation)
   */
  router.get('/database-stats', async (c) => {
    try {
      const stats = {
        mongodb: { collections: 0 as number, total_documents: 0 as number, collection_details: [] as Array<{ name: string; documents: number }>, error: null as string | null },
        redis: { total_keys: 0 as number, memory_usage: null as number | null, error: null as string | null },
        timestamp: new Date().toISOString()
      };

      // Get MongoDB stats - check known collections directly
      try {
        const db = get_database();
        
        // List of known collection names used by the application
        const knownCollections = [
          'episodic_events',
          'semantic_facts', 
          'knowledge_nodes',
          'knowledge_relationships',
          'conversations',
          'messages',
          'users',
          'sessions',
          'working_memory',
          'memory_contexts',
          'chat_sessions',
          'user_profiles'
        ];
        
        let totalDocs = 0;
        const collectionDetails = [];
        let existingCollections = 0;
        
        for (const collectionName of knownCollections) {
          try {
            const coll = db.collection(collectionName);
            const docCount = await coll.countDocuments();
            
            if (docCount > 0) {
              totalDocs += docCount;
              collectionDetails.push({
                name: collectionName,
                documents: docCount
              });
              existingCollections++;
            }
          } catch (collError: any) {
            // Collection doesn't exist or can't access - that's fine, skip it
            console.log(`ℹ️ Skipped collection ${collectionName} in stats: ${collError.message}`);
          }
        }
        
        stats.mongodb.collections = existingCollections;
        stats.mongodb.total_documents = totalDocs;
        stats.mongodb.collection_details = collectionDetails;
      } catch (mongodb_error: any) {
        console.error('❌ MongoDB stats error:', mongodb_error);
        stats.mongodb.error = mongodb_error.message;
      }

      // Get Redis stats
      try {
        const redis_client = await get_redis_client();
        
        if (redis_client) {
          const keys = await redis_client.keys('*');
          stats.redis.total_keys = keys.length;
          
          // Try to get memory usage info
          try {
            const info = await redis_client.info('memory');
            const memoryMatch = info.match(/used_memory:(\d+)/);
            if (memoryMatch) {
              stats.redis.memory_usage = parseInt(memoryMatch[1]);
            }
          } catch (info_error) {
            // Memory info not critical, continue without it
          }
        } else {
          stats.redis.error = 'Redis client not available';
        }
      } catch (redis_error: any) {
        console.error('❌ Redis stats error:', redis_error);
        stats.redis.error = redis_error.message;
      }

      return c.json({
        success: true,
        stats
      });

    } catch (error) {
      console.error('❌ Database stats operation failed:', error);
      return c.json({
        success: false,
        error: get_error_message(error)
      }, 500);
    }
  });

  /**
   * Test LLM service connection and configuration
   */
  router.post('/test-llm', async (c) => {
    try {
      console.log('🧪 Testing LLM service...');
      
      // Get service status
      const serviceStatus = llmService.getServiceStatus();
      console.log('🧪 LLM Service Status:', serviceStatus);
      
      // Test the actual service
      const testResult = await llmService.testService();
      console.log('🧪 LLM Test Result:', testResult);
      
      return c.json({
        success: testResult.success,
        service_status: serviceStatus,
        test_result: testResult,
        environment_check: {
          api_key_present: !!process.env.MOONSHOT_API_KEY,
          api_key_prefix: process.env.MOONSHOT_API_KEY ? process.env.MOONSHOT_API_KEY.substring(0, 8) + '...' : 'none'
        }
      });
      
    } catch (error) {
      console.error('❌ LLM test failed:', error);
      return c.json({
        success: false,
        error: get_error_message(error),
        stack: get_error_stack(error)
      }, 500);
    }
  });

  /**
   * Test semantic fact storage - for debugging the storage issue
   */
  router.post('/test-semantic-fact', async (c) => {
    try {
      const db = get_database();
      
      // Test inserting a simple semantic fact directly
      const testFact = {
        user_id: 'test-user',
        content: 'Test fact: This is a debugging test',
        source: 'test',
        confidence: 0.9,
        metadata: {
          test: true,
          timestamp: new Date().toISOString()
        },
        created_at: new Date()
      };
      
      console.log('🧪 Testing semantic fact insertion...');
      console.log('🧪 Database name:', db.databaseName);
      console.log('🧪 Test fact:', JSON.stringify(testFact, null, 2));
      
      // Test 1: Direct MongoDB insertion
      const directResult = await db.collection('semantic_facts').insertOne(testFact);
      console.log('🧪 Direct insert result:', {
        acknowledged: directResult.acknowledged,
        insertedId: directResult.insertedId?.toString()
      });
      
      // Test 2: Verify the document exists
      const findResult = await db.collection('semantic_facts').findOne({
        _id: directResult.insertedId
      });
      console.log('🧪 Can find inserted document?', !!findResult);
      
      // Test 3: Count total documents
      const totalCount = await db.collection('semantic_facts').countDocuments();
      console.log('🧪 Total documents in semantic_facts:', totalCount);
      
      // Test 4: List some recent documents
      const recentDocs = await db.collection('semantic_facts')
        .find({})
        .sort({ created_at: -1 })
        .limit(3)
        .toArray();
      console.log('🧪 Recent documents:', recentDocs.length);
      
      return c.json({
        success: true,
        test_results: {
          direct_insert: {
            acknowledged: directResult.acknowledged,
            inserted_id: directResult.insertedId?.toString()
          },
          document_found: !!findResult,
          total_count: totalCount,
          recent_docs_count: recentDocs.length,
          database_name: db.databaseName
        },
        message: 'Semantic fact test completed'
      });
      
    } catch (error) {
      console.error('❌ Semantic fact test failed:', error);
      return c.json({
        success: false,
        error: get_error_message(error),
        stack: get_error_stack(error)
      }, 500);
    }
  });

  /**
   * Debug database collections - check what exists
   */
  router.get('/debug-collections', async (c) => {
    try {
      const db = get_database();
      
      // Get all collections
      const collections = await db.listCollections().toArray();
      
      const collectionDetails = await Promise.all(
        collections.map(async (coll) => {
          try {
            const count = await db.collection(coll.name).countDocuments();
            return {
              name: coll.name,
              documents: count
            };
          } catch (error: any) {
            return {
              name: coll.name,
              documents: 0,
              error: error.message
            };
          }
        })
      );
      
      return c.json({
        success: true,
        database_name: db.databaseName,
        collections: collectionDetails,
        total_collections: collections.length
      });
      
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 500);
    }
  });

  /**
   * Force background processing for debugging
   */
  router.post('/background/force-process', async (c) => {
    try {
      console.log('🔄 Force processing all unprocessed events...');
      
      const result = await backgroundProcessor.forceProcessAll();
      
      console.log('✅ Force processing completed:', result);
      
      return c.json({
        success: true,
        result: result,
        message: `Processed ${result.processed} events, ${result.failed} failed`
      });
      
    } catch (error: any) {
      console.error('❌ Force processing failed:', error);
      return c.json({
        success: false,
        error: error.message,
        stack: error.stack
      }, 500);
    }
  });

  /**
   * Get background processor status
   */
  router.get('/background/status', async (c) => {
    try {
      const stats = await backgroundProcessor.getProcessingStats();
      
      return c.json({
        success: true,
        stats: stats
      });
      
    } catch (error: any) {
      return c.json({
        success: false,
        error: error.message
      }, 500);
    }
  });

  /**
   * Test extraction pipeline on a simple message
   */
  router.post('/test-extraction', async (c) => {
    try {
      const body = await c.req.json();
      const { message = "I love driving my 1961 Jaguar E-Type" } = body;
      
      console.log('🧪 Testing extraction pipeline with message:', message);
      
      // Import extraction service
      const { extraction_service } = await import('../services/extraction-service.js');
      
      // Test extraction with proper context
      const extractionContext = {
        session_id: 'test-session',
        user_id: 'test-user',
        timestamp: new Date(),
        extraction_focus: 'test_extraction'
      };
      
      const extractionResult = await extraction_service.extractStructuredData(
        message,
        extractionContext
      );
      
      console.log('🧪 Extraction result:', extractionResult);
      
      return c.json({
        success: true,
        input: message,
        extraction_result: extractionResult,
        semantic_facts_count: extractionResult?.semantic_facts?.length || 0
      });
      
    } catch (error: any) {
      console.error('❌ Extraction test failed:', error);
      return c.json({
        success: false,
        error: error.message,
        stack: error.stack
      }, 500);
    }
  });

  // Episodic Events Duplication Management Endpoints

  /**
   * Get episodic events duplication statistics
   * GET /api/admin/episodic-events/duplication-stats
   */
  router.get('/episodic-events/duplication-stats', async (c) => {
    try {
      const episodicManager = getEpisodicEventManager();
      const duplicationStats = await episodicManager.getDuplicationStats();

      return c.json({
        success: true,
        data: duplicationStats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error getting duplication stats:', error);
      return c.json({ success: false, error: get_error_message(error) }, 500);
    }
  });

  /**
   * Analyze episodic events duplicates (dry run)
   * GET /api/admin/episodic-events/analyze-duplicates
   */
  router.get('/episodic-events/analyze-duplicates', async (c) => {
    try {
      const episodicManager = getEpisodicEventManager();

      console.log('🔍 Analyzing episodic events duplicates...');
      const analysisResults = await episodicManager.identifyAndCleanupDuplicates(true); // Dry run

      return c.json({
        success: true,
        data: {
          analysis: analysisResults,
          message: 'Dry run analysis completed - no data was modified'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error analyzing duplicates:', error);
      return c.json({ success: false, error: get_error_message(error) }, 500);
    }
  });

  /**
   * Execute episodic events duplicate cleanup
   * POST /api/admin/episodic-events/cleanup-duplicates
   */
  router.post('/episodic-events/cleanup-duplicates', async (c) => {
    try {
      const body = await c.req.json();
      const { confirm } = body;

      if (!confirm) {
        return c.json({
          success: false,
          error: 'Cleanup requires explicit confirmation. Set confirm: true in request body.'
        }, 400);
      }

      const episodicManager = getEpisodicEventManager();

      console.log('🧹 Executing episodic events duplicate cleanup...');
      const cleanupResults = await episodicManager.identifyAndCleanupDuplicates(false); // Execute cleanup

      return c.json({
        success: true,
        data: {
          cleanup: cleanupResults,
          message: 'Duplicate cleanup completed successfully'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error executing cleanup:', error);
      return c.json({ success: false, error: get_error_message(error) }, 500);
    }
  });

  /**
   * Get episodic event manager statistics
   * GET /api/admin/episodic-events/stats
   */
  router.get('/episodic-events/stats', async (c) => {
    try {
      const episodicManager = getEpisodicEventManager();
      const eventStats = await episodicManager.getEventStats();

      return c.json({
        success: true,
        data: eventStats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error getting event stats:', error);
      return c.json({ success: false, error: get_error_message(error) }, 500);
    }
  });

  // Background processor control endpoints
  router.post('/enable-background-processor', async (c) => {
    try {
      backgroundProcessor.start(300000);
      return c.json({
        success: true,
        message: 'Background processor fallback enabled (primary processing is event-driven)',
        interval: '5 minutes',
        note: 'Event-driven processing handles immediate processing on user/system events'
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/disable-background-processor', async (c) => {
    try {
      backgroundProcessor.stop();
      return c.json({
        success: true,
        message: 'Background processor disabled'
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/process-unprocessed-events', async (c) => {
    try {
      const results = await backgroundProcessor.forceProcessAll();
      return c.json({
        success: true,
        message: 'Forced processing completed',
        results: results
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.get('/background-processor-status', async (c) => {
    try {
      const stats = await backgroundProcessor.getProcessingStats();
      return c.json({
        success: true,
        stats: stats
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.get('/event-stats', async (c) => {
    try {
      const eventManager = getEpisodicEventManager();
      const stats = await eventManager.getEventStats();
      return c.json({
        success: true,
        stats: stats
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/rebuild-indexes', async (c) => {
    try {
      const db = get_database();
      const indexManager = new IndexManager(db);
      const result = await indexManager.cleanupAndRecreateIndexes();
      return c.json({
        success: true,
        message: 'Index rebuild completed',
        result: result
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.get('/index-stats', async (c) => {
    try {
      const db = get_database();
      const indexManager = new IndexManager(db);
      const stats = await indexManager.getIndexStats();
      return c.json({
        success: true,
        stats: stats
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/cleanup-unhelpful-responses', async (c) => {
    try {
      const db = get_database();
      
      const unhelpfulPatterns = [
        'What specific aspects would you like to explore',
        'I\'d be happy to discuss this with you',
        'tell me more about what you',
        'Could you tell me more',
        'provide more details',
        'anything specific about this you\'d like to explore further'
      ];
      
      const escapedPatterns = unhelpfulPatterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const regexPattern = new RegExp(escapedPatterns.join('|'), 'i');
      
      const unhelpfulResponses = await db.collection('episodic_events').find({
        'content.role': 'assistant',
        'content.message': regexPattern
      }).toArray();
      
      console.log(`Found ${unhelpfulResponses.length} unhelpful assistant responses`);
      
      const deleteResult = await db.collection('episodic_events').deleteMany({
        'content.role': 'assistant',
        'content.message': regexPattern
      });
      
      return c.json({
        success: true,
        message: 'Cleaned up unhelpful responses',
        found: unhelpfulResponses.length,
        deleted: deleteResult.deletedCount,
        patterns_used: unhelpfulPatterns
      });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  router.post('/test-conversation', async (c) => {
    return c.json({
      success: false,
      error: 'Conversation service not available in Katra. Use the MCP tools or REST API for memory operations.'
    }, 501);
  });

  return router;
};