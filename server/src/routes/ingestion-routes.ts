import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { extraction_service, ExtractionContext, ExtractionResult } from '../services/extraction-service.js';
import { dispatch_service, DispatchContext } from '../services/dispatch-service.js';
import { getSessionIngestionService } from '../services/session-ingestion-service.js';
import { create_rate_limiter } from '../middleware/rate-limit.js';

export const create_ingestion_routes = (): Hono => {
  const router = new Hono();

  // Broad DoS backstop for all ingestion endpoints (120/min per IP).
  // Per-endpoint limits below are the binding constraints for expensive ops.
  router.use('*', create_rate_limiter({ keyPrefix: 'ingest_general', max: 120, windowMs: 60_000 }));

  // Add timeout middleware specifically for ingestion routes
  router.use('*', async (c, next) => {
    const timeout = setTimeout(() => {
      if (!c.finalized) {
        console.warn(`Ingestion timeout: ${c.req.method} ${c.req.path}`);
        return c.json({ 
          success: false,
          error: 'Ingestion timeout', 
          message: 'Ingestion took longer than 45 seconds to complete',
          timeout: 45000 
        }, 504);
      }
    }, 45000); // 45 seconds for ingestion operations

    try {
      await next();
    } finally {
      clearTimeout(timeout);
    }
  });

  // Main ingestion endpoint - the core of Phase 3
  router.post('/ingest', create_rate_limiter({ keyPrefix: 'ingest', max: 10, windowMs: 60_000 }), async (c) => {
    const startTime = Date.now();
    try {
      const body = await c.req.json();
      
      // Validate required fields
      if (!body.input_text || typeof body.input_text !== 'string') {
        return c.json({
          success: false,
          error: 'input_text is required and must be a string'
        }, 400);
      }

      if (!body.session_id || typeof body.session_id !== 'string') {
        return c.json({
          success: false,
          error: 'session_id is required and must be a string'
        }, 400);
      }

      if (!body.user_id || typeof body.user_id !== 'string') {
        return c.json({
          success: false,
          error: 'user_id is required and must be a string'
        }, 400);
      }

      // Build extraction context
      const extraction_context: ExtractionContext = {
        session_id: body.session_id,
        user_id: body.user_id,
        shared_id: body.shared_id,
        timestamp: new Date(),
        conversation_history: body.conversation_history || [],
        current_entities: body.current_entities || [],
        extraction_focus: body.extraction_focus
      };

      console.log(`🔄 Starting ingestion (${Date.now() - startTime}ms): session ${body.session_id}, user ${body.user_id}${body.shared_id ? ', shared ' + body.shared_id : ''}`);
      console.log(`📄 Input text length: ${body.input_text.length} characters`);

      // Phase 1: Extract structured data from input with timeout protection
      const extraction_start = Date.now();
      let extraction_result: ExtractionResult;
      
      try {
        console.log(`⚗️ Starting extraction (${Date.now() - startTime}ms)`);
        
        // Add timeout wrapper for extraction
        extraction_result = await Promise.race([
          extraction_service.extractStructuredData(body.input_text, extraction_context),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Extraction timeout after 30 seconds')), 30000)
          )
        ]);
        
        const extraction_time = Date.now() - extraction_start;
        console.log(`✅ Extraction completed (${Date.now() - startTime}ms): ${extraction_result.entities.length} entities, ${extraction_result.relationships.length} relationships, ${extraction_result.events.length} events, ${extraction_result.semantic_facts.length} facts`);
        console.log(`⏱️ Extraction took ${extraction_time}ms`);
        
        if (extraction_time > 15000) {
          console.warn(`⚠️ Slow extraction detected: ${extraction_time}ms`);
        }
        
      } catch (extractionError) {
        console.error(`❌ Extraction failed (${Date.now() - startTime}ms):`, extractionError);
        
        // Return partial success with error details
        return c.json({
          success: false,
          error: 'Extraction phase failed',
          details: extractionError instanceof Error ? extractionError.message : 'Unknown extraction error',
          phase: 'extraction',
          processing_time: Date.now() - startTime,
          suggestion: 'Try with shorter input text or check if LLM service is available'
        }, 500);
      }

      // Validate extraction result
      let validation: { valid: boolean; errors: string[]; warnings: string[] } = { valid: true, errors: [], warnings: [] };
      try {
        console.log(`🔍 Validating extraction (${Date.now() - startTime}ms)`);
        validation = await extraction_service.validateExtraction(extraction_result);
        
        if (!validation.valid) {
          console.warn('⚠️ Extraction validation failed:', validation.errors);
          return c.json({
            success: false,
            error: 'Extraction validation failed',
            validation_errors: validation.errors,
            validation_warnings: validation.warnings,
            processing_time: Date.now() - startTime
          }, 400);
        }
        
        if (validation.warnings && validation.warnings.length > 0) {
          console.warn('⚠️ Extraction validation warnings:', validation.warnings);
        }
        
      } catch (validationError) {
        console.error(`❌ Validation failed (${Date.now() - startTime}ms):`, validationError);
        validation = { valid: true, errors: [], warnings: ['Validation service failed, proceeding anyway'] };
      }

      // Phase 2: Dispatch to memory stores
      const dispatch_context: DispatchContext = {
        ...extraction_context,
        batch_size: body.batch_size || 10,
        parallel_operations: body.parallel_operations !== false, // Default to true
        rollback_on_error: body.rollback_on_error === true,
        upsert_mode: body.upsert_mode !== false // Default to true
      };

      const dispatch_start = Date.now();
      const dispatch_result = await dispatch_service.dispatchToMemory(
        extraction_result,
        dispatch_context
      );
      const dispatch_time = Date.now() - dispatch_start;

      console.log(`Dispatch completed: ${dispatch_result.operations_completed} operations completed, ${dispatch_result.operations_failed} failed`);
      console.log(`Dispatch took ${dispatch_time}ms`);
      
      if (dispatch_time > 3000) {
        console.warn(`⚠️ Slow dispatch detected: ${dispatch_time}ms`);
      }
      
      const total_time = Date.now() - startTime;
      console.log(`Total ingestion time: ${total_time}ms`);
      
      if (total_time > 10000) {
        console.warn(`⚠️ Very slow ingestion detected: ${total_time}ms`);
      }

      // Build comprehensive response
      const response = {
        success: dispatch_result.success,
        ingestion_id: uuidv4(),
        processing_summary: {
          input_length: body.input_text.length,
          extraction_method: extraction_result.processing_metadata.extraction_method,
          llm_used: extraction_result.processing_metadata.llm_used,
          extraction_time: extraction_result.processing_metadata.extraction_time,
          dispatch_time: dispatch_result.processing_time,
          total_time: extraction_result.processing_metadata.extraction_time + dispatch_result.processing_time
        },
        extraction_results: {
          entities_extracted: extraction_result.entities.length,
          relationships_extracted: extraction_result.relationships.length,
          events_extracted: extraction_result.events.length,
          semantic_facts_extracted: extraction_result.semantic_facts.length
        },
        dispatch_results: {
          entities_stored: dispatch_result.results.entities_stored,
          relationships_stored: dispatch_result.results.relationships_stored,
          events_stored: dispatch_result.results.events_stored,
          semantic_facts_stored: dispatch_result.results.semantic_facts_stored,
          operations_completed: dispatch_result.operations_completed,
          operations_failed: dispatch_result.operations_failed
        },
        validation: {
          valid: validation.valid,
          warnings: validation.warnings
        },
        errors: dispatch_result.errors || [],
        warnings: dispatch_result.warnings || []
      };

      // Log summary
      console.log(`Ingestion ${response.ingestion_id} completed:`, {
        success: response.success,
        extraction_method: response.processing_summary.extraction_method,
        total_time: response.processing_summary.total_time,
        items_stored: dispatch_result.results.entities_stored + dispatch_result.results.relationships_stored + dispatch_result.results.events_stored + dispatch_result.results.semantic_facts_stored
      });

      return c.json(response);

    } catch (error) {
      console.error('Ingestion pipeline error:', error);
      return c.json({
        success: false,
        error: 'Internal server error during ingestion',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  // Batch ingestion endpoint
  router.post('/ingest/batch', create_rate_limiter({ keyPrefix: 'ingest_batch', max: 5, windowMs: 60_000 }), async (c) => {
    try {
      const body = await c.req.json();
      
      if (!Array.isArray(body.inputs)) {
        return c.json({
          success: false,
          error: 'inputs must be an array of ingestion requests'
        }, 400);
      }

      const batch_id = uuidv4();
      const results = [];
      const batch_start_time = Date.now();

      console.log(`Starting batch ingestion ${batch_id} with ${body.inputs.length} items`);

      for (let i = 0; i < body.inputs.length; i++) {
        const input = body.inputs[i];
        
        try {
          // Validate individual input
          if (!input.input_text || !input.session_id || !input.user_id) {
            results.push({
              index: i,
              success: false,
              error: 'Missing required fields: input_text, session_id, user_id'
            });
            continue;
          }

          // Build contexts
          const extraction_context: ExtractionContext = {
            session_id: input.session_id,
            user_id: input.user_id,
            shared_id: input.shared_id,
            timestamp: new Date(),
            conversation_history: input.conversation_history || [],
            current_entities: input.current_entities || [],
            extraction_focus: input.extraction_focus
          };

          // Extract and dispatch
          const extraction_result = await extraction_service.extractStructuredData(
            input.input_text,
            extraction_context
          );

          const dispatch_context: DispatchContext = {
            ...extraction_context,
            batch_size: input.batch_size || 5, // Smaller batches for batch processing
            parallel_operations: input.parallel_operations !== false,
            rollback_on_error: input.rollback_on_error === true,
            upsert_mode: input.upsert_mode !== false
          };

          const dispatch_result = await dispatch_service.dispatchToMemory(
            extraction_result,
            dispatch_context
          );

          results.push({
            index: i,
            success: dispatch_result.success,
            ingestion_id: uuidv4(),
            items_processed: extraction_result.entities.length + extraction_result.relationships.length + extraction_result.events.length + extraction_result.semantic_facts.length,
            items_stored: dispatch_result.results.entities_stored + dispatch_result.results.relationships_stored + dispatch_result.results.events_stored + dispatch_result.results.semantic_facts_stored,
            processing_time: extraction_result.processing_metadata.extraction_time + dispatch_result.processing_time,
            errors: dispatch_result.errors
          });

        } catch (error) {
          results.push({
            index: i,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      const successful_items = results.filter(r => r.success).length;
      const failed_items = results.length - successful_items;
      const total_processing_time = Date.now() - batch_start_time;

      console.log(`Batch ingestion ${batch_id} completed: ${successful_items} successful, ${failed_items} failed, ${total_processing_time}ms total`);

      return c.json({
        success: failed_items === 0,
        batch_id,
        summary: {
          total_items: body.inputs.length,
          successful_items,
          failed_items,
          processing_time: total_processing_time
        },
        results
      });

    } catch (error) {
      console.error('Batch ingestion error:', error);
      return c.json({
        success: false,
        error: 'Internal server error during batch ingestion',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  // Ingestion validation endpoint
  router.post('/validate', create_rate_limiter({ keyPrefix: 'ingest_validate', max: 20, windowMs: 60_000 }), async (c) => {
    try {
      const body = await c.req.json();
      
      if (!body.input_text || typeof body.input_text !== 'string') {
        return c.json({
          success: false,
          error: 'input_text is required and must be a string'
        }, 400);
      }

      // Mock context for validation
      const mock_context: ExtractionContext = {
        session_id: 'validation-session',
        user_id: 'validation-user',
        timestamp: new Date()
      };

      // Run extraction only (no dispatch)
      const extraction_result = await extraction_service.extractStructuredData(
        body.input_text,
        mock_context
      );

      // Validate extraction
      const validation = await extraction_service.validateExtraction(extraction_result);

      return c.json({
        success: true,
        extraction_preview: {
          entities_count: extraction_result.entities.length,
          relationships_count: extraction_result.relationships.length,
          events_count: extraction_result.events.length,
          semantic_facts_count: extraction_result.semantic_facts.length,
          extraction_method: extraction_result.processing_metadata.extraction_method,
          processing_time: extraction_result.processing_metadata.extraction_time
        },
        validation: {
          valid: validation.valid,
          errors: validation.errors,
          warnings: validation.warnings
        },
        sample_data: {
          entities: extraction_result.entities.slice(0, 3),
          relationships: extraction_result.relationships.slice(0, 3),
          events: extraction_result.events.slice(0, 2),
          semantic_facts: extraction_result.semantic_facts.slice(0, 3)
        }
      });

    } catch (error) {
      console.error('Ingestion validation error:', error);
      return c.json({
        success: false,
        error: 'Internal server error during validation',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  // Get ingestion statistics
  router.get('/stats', async (c) => {
    try {
      const dispatch_stats = await dispatch_service.getDispatchStats();
      
      return c.json({
        success: true,
        statistics: {
          ...dispatch_stats,
          ingestion_pipeline_version: '3.0',
          features: [
            'llm_extraction',
            'rule_based_fallback',
            'parallel_dispatch',
            'batch_processing',
            'validation',
            'error_handling'
          ]
        }
      });

    } catch (error) {
      console.error('Stats retrieval error:', error);
      return c.json({
        success: false,
        error: 'Failed to retrieve ingestion statistics',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  // Health check for ingestion pipeline
  router.get('/health', async (c) => {
    try {
      // Test extraction service
      const test_extraction = await extraction_service.extractStructuredData(
        'Test input for health check',
        {
          session_id: 'health-check',
          user_id: 'system',
          timestamp: new Date()
        }
      );

      const health_status = {
        success: true,
        pipeline_status: 'healthy',
        components: {
          extraction_service: test_extraction ? 'operational' : 'degraded',
          dispatch_service: 'operational',
          validation_service: 'operational'
        },
        last_check: new Date().toISOString(),
        version: '3.0'
      };

      return c.json(health_status);

    } catch (error) {
      console.error('Ingestion health check failed:', error);
      return c.json({
        success: false,
        pipeline_status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
        last_check: new Date().toISOString()
      }, 500);
    }
  });

  // ── Session Session Ingestion ────────────────────────────────

  // Trigger Session session log ingestion
  router.post('/sessions/ingest', create_rate_limiter({ keyPrefix: 'ingest_sessions', max: 20, windowMs: 60_000 }), async (c) => {
    try {
      const service = getSessionIngestionService();
      const result = await service.ingestNewSessions();
      return c.json({
        success: true,
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Session ingestion failed:', error);
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  });

  // Get Session ingestion status
  router.get('/sessions/status', async (c) => {
    try {
      const service = getSessionIngestionService();
      const status = service.getStatus();
      return c.json({ success: true, status });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  });

  // Reset ingestion state (for re-ingestion)
  router.post('/sessions/reset', create_rate_limiter({ keyPrefix: 'ingest_sessions_reset', max: 20, windowMs: 60_000 }), async (c) => {
    try {
      const service = getSessionIngestionService();
      service.resetState();
      return c.json({ success: true, message: 'Ingestion state reset' });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 500);
    }
  });

  return router;
};