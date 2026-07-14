import { Hono } from 'hono';
import { llmService } from '../services/infrastructure/llm-service.js';
import { embeddingService } from '../services/infrastructure/embedding-service.js';
import { MemoryIntegrityService } from '../services/infrastructure/memory-integrity.js';
import { get_database } from '../database/connection.js';
import { is_database_connected } from '../database/connection.js';
import { is_redis_healthy } from '../database/redis-connection.js';

export const create_diagnostic_routes = (): Hono => {
  const router = new Hono();

  /**
   * Health check — no auth required
   */
  router.get('/health', async (c) => {
    const mongoOk = is_database_connected();
    const redisOk = await is_redis_healthy();
    const llmStatus = llmService.getServiceStatus();
    const integrityService = MemoryIntegrityService.get_instance();
    const integrityReport = await integrityService.getIntegrityReport();
    return c.json({
      status: mongoOk && redisOk ? 'ok' : 'degraded',
      services: {
        mongodb: mongoOk ? 'connected' : 'disconnected',
        redis: redisOk ? 'connected' : 'disconnected',
        llm: llmStatus.available ? llmStatus.provider : 'unavailable',
        embeddings: embeddingService.isReady ? 'available' : 'unavailable',
      },
      version: '1.0.0',
        memory_integrity: integrityReport,
    });
  });

  /**
   * Quick diagnostic endpoint to check what's causing ingestion timeouts
   */
  router.get('/ingestion-timeout', async (c) => {
    const startTime = Date.now();

    try {
      const diagnostics = {
        timestamp: new Date().toISOString(),
        tests: {} as Record<string, any>
      };

      // Test 1: Database connectivity
      console.log('🔍 Testing database connectivity...');
      const dbStart = Date.now();
      try {
        const db = get_database();
        await db.admin().ping();
        diagnostics.tests.database = {
          status: 'ok',
          time: Date.now() - dbStart
        };
      } catch (error) {
        diagnostics.tests.database = {
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
          time: Date.now() - dbStart
        };
      }

      // Test 2: LLM Service availability (status-only, no API call)
      console.log('🔍 Checking LLM service status...');
      const llmStart = Date.now();
      const llmStatus = llmService.getServiceStatus();
      
      if (llmStatus.available) {
        diagnostics.tests.llm_service = {
          status: 'ok',
          time: Date.now() - llmStart,
          details: llmStatus,
          note: 'Status check only (no LLM API call) — extraction tested via background processor',
        };
      } else {
        diagnostics.tests.llm_service = {
          status: 'unavailable',
          time: Date.now() - llmStart,
          details: llmStatus,
          issue: 'No API keys configured',
        };
      }

      // Test 3: Memory operations
      console.log('🔍 Testing memory operations...');
      const memoryStart = Date.now();
      try {
        const db = get_database();
        
        // Quick read test
        const testQuery = await db.collection('episodic_events').findOne({}, { sort: { timestamp: -1 } });
        
        diagnostics.tests.memory_operations = {
          status: 'ok',
          time: Date.now() - memoryStart,
          sample_record_found: !!testQuery
        };
      } catch (error) {
        diagnostics.tests.memory_operations = {
          status: 'error',
          time: Date.now() - memoryStart,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

      // Test 4: Network/DNS resolution
      console.log('🔍 Testing external connectivity...');
      const networkStart = Date.now();
      try {
        // Test if we can resolve external APIs
        const testUrls = [
          'https://api.moonshot.cn',
          'https://api.anthropic.com'
        ];
        
        const results = await Promise.allSettled(
          testUrls.map(url => 
            fetch(url, { 
              method: 'HEAD', 
              signal: AbortSignal.timeout(5000) 
            }).then(res => ({ url, status: res.status }))
          )
        );
        
        diagnostics.tests.external_connectivity = {
          status: 'ok',
          time: Date.now() - networkStart,
          results: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message })
        };
      } catch (error) {
        diagnostics.tests.external_connectivity = {
          status: 'error',
          time: Date.now() - networkStart,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }

      const totalTime = Date.now() - startTime;

      return c.json({
        success: true,
        total_diagnostic_time: totalTime,
        diagnostics,
        recommendations: generateRecommendations(diagnostics.tests)
      });

    } catch (error) {
      return c.json({
        success: false,
        error: 'Diagnostic failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        processing_time: Date.now() - startTime
      }, 500);
    }
  });

  /**
   * Test ingestion with different configurations
   */
  router.post('/test-ingestion', async (c) => {
    try {
      const body = await c.req.json();
      const testText = body.text || 'This is a test message for ingestion diagnostics.';

      const results = {
        timestamp: new Date().toISOString(),
        test_configurations: [] as any[]
      };

      // Test 1: Rule-based extraction only (fastest)
      const ruleBasedStart = Date.now();
      try {
        console.log('🧪 Testing rule-based extraction...');
        
        const response = await fetch('/api/ingestion/ingest/fast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input_text: testText,
            session_id: 'diagnostic-test',
            user_id: 'diagnostic-user'
          }),
          signal: AbortSignal.timeout(15000)
        });

        const data = await response.json();
        
        results.test_configurations.push({
          name: 'rule_based_fast',
          status: response.ok ? 'success' : 'failed',
          time: Date.now() - ruleBasedStart,
          data: data
        });
      } catch (error) {
        results.test_configurations.push({
          name: 'rule_based_fast',
          status: 'error',
          time: Date.now() - ruleBasedStart,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }

      // Test 2: LLM extraction (slower)
      const llmStart = Date.now();
      try {
        console.log('🧪 Testing LLM extraction...');
        
        const response = await fetch('/api/ingestion/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input_text: testText,
            session_id: 'diagnostic-test-llm',
            user_id: 'diagnostic-user',
            extraction_focus: 'llm' // Force LLM usage
          }),
          signal: AbortSignal.timeout(30000)
        });

        const data = await response.json();
        
        results.test_configurations.push({
          name: 'llm_extraction',
          status: response.ok ? 'success' : 'failed',
          time: Date.now() - llmStart,
          data: data
        });
      } catch (error) {
        results.test_configurations.push({
          name: 'llm_extraction',
          status: 'error',
          time: Date.now() - llmStart,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }

      return c.json({
        success: true,
        results,
        summary: {
          fastest_method: results.test_configurations.reduce((fastest, current) => 
            current.time < fastest.time ? current : fastest
          ),
          recommendations: results.test_configurations.map(config => ({
            method: config.name,
            recommended: config.status === 'success' && config.time < 15000,
            reason: config.status !== 'success' ? 'Failed' : 
                   config.time > 15000 ? 'Too slow' : 'Good performance'
          }))
        }
      });

    } catch (error) {
      return c.json({
        success: false,
        error: 'Test ingestion failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  return router;
};

function generateRecommendations(tests: Record<string, any>): string[] {
  const recommendations: string[] = [];

  if (tests.database?.status !== 'ok') {
    recommendations.push('Database connectivity issues detected. Check MongoDB connection.');
  }

  if (tests.llm_service?.status === 'unavailable') {
    recommendations.push('LLM service unavailable. Set MOONSHOT_API_KEY or ANTHROPIC_API_KEY environment variables.');
  } else if (tests.llm_service?.status === 'error') {
    recommendations.push('LLM service errors detected. Check API key validity and quota limits.');
  } else if (tests.llm_service?.time > 10000) {
    recommendations.push('LLM service is slow. Consider using fast ingestion endpoint (/ingest/fast).');
  }

  if (tests.memory_operations?.status !== 'ok') {
    recommendations.push('Memory operations failing. Check database permissions and indexes.');
  }

  if (tests.external_connectivity?.status !== 'ok') {
    recommendations.push('External connectivity issues. Check firewall and DNS settings.');
  }

  if (recommendations.length === 0) {
    recommendations.push('All systems appear healthy. Timeout may be due to large input text or high load.');
  }

  return recommendations;
}