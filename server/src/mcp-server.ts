/**
 * Katra MCP Server — v3.0 (Katra Cognitive Memory)
 *
 * A remote cognitive memory layer for agentic LLMs.
 *
 * External agents (any MCP-compatible client)
 * connect to store, retrieve, and augment their memory. This server
 * does NOT provide reasoning, execution, or chat — it provides
 * memory primitives: store, recall, search, summarize, pattern-detect.
 *
 * Usage:
 *   node build/mcp-server.js                     # HTTP/SSE on port 3100
 *   node build/mcp-server.js --port 3100         # Custom port
 *   node build/mcp-server.js --host 0.0.0.0     # All interfaces
 *   node build/mcp-server.js --stdio             # stdio (Claude Desktop)
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { connect_to_mongodb, get_database, is_database_connected } from './database/connection.js';
import { get_redis_client, is_redis_healthy } from './database/redis-connection.js';
import { working_memory_service } from './services/memory/working-memory-service.js';
import {
  getSemanticMemoryService,
  getCompactionQueueService,
  getMemorySynthesisService,
  getProspectiveMemoryService,
} from './services/integration/knowledge-graph-factory.js';
import { embeddingService } from './services/infrastructure/embedding-service.js';
import { getMemoryScope, buildScopeFilter, resolveSharedId, invalidateScopeCache, DEFAULT_USER_ID } from './services/memory/memory-scope-service.js';
import { llmService, get_llm_config_from_db, save_llm_config_to_db } from './services/infrastructure/llm-service.js';
import { getEpisodicEventManager } from './services/memory/episodic-event-manager.js';
import { stableContentHash } from './services/infrastructure/content-hash-utils.js';
import { ensureApiKeys, logGeneratedKeys, validateMcpKey, isMcpAuthConfigured, validateKatraKey, isKatraAuthConfigured } from './utils/api-key-manager.js';
import { ReflectionStore } from './services/infrastructure/reflection-store.js';
import { SleepConsolidationService } from './services/processing/sleep-consolidation-service.js';
import { MemoryDecayService } from './services/processing/memory-decay-service.js';
import { AnomalyDetectionService } from './services/processing/anomaly-detection-service.js';
import { SalienceService } from './services/processing/salience-service.js';
import { MotivationalEngine } from './services/processing/motivational-engine.js';
import { DecisionActionService } from './services/processing/decision-action-service.js';
import { SelfModelService } from './services/processing/self-model-service.js';
import { GoalManager } from './services/processing/goal-manager.js';

dotenv.config();

// ── Tenant identity ────────────────────────────────────────────────
// The MCP server uses a single shared API key — there is no per-user
// authentication. The caller-supplied user_id must never be used as an
// authorization boundary (IDOR). All requests are bound to the
// server-configured identity (DEFAULT_USER_ID / SOLOMEM_USER_ID).
function resolveUserId(_requested?: unknown): string {
  return DEFAULT_USER_ID;
}

// ── Authentication ─────────────────────────────────────────────────

function validateAuth(req: IncomingMessage): boolean {
  if (!isMcpAuthConfigured()) return true;
  const mcpAuth = req.headers['x-mcp-auth'] as string | undefined;
  if (mcpAuth && validateMcpKey(mcpAuth)) return true;
  const authHeader = req.headers['authorization'] as string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    if (validateMcpKey(authHeader.slice(7))) return true;
  }
  if (req.url) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const token = url.searchParams.get('token');
      if (token && validateMcpKey(token)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/**
 * Admin-level auth — requires KATRA_API_KEY (not MCP_API_KEY).
 * Used for high-privilege operations: memory scope changes, LLM config.
 */
function validateAdminAuth(authHeader?: string, token?: string): boolean {
  if (authHeader && authHeader.startsWith('Bearer ')) {
    if (validateKatraKey(authHeader.slice(7))) return true;
  }
  if (token && validateKatraKey(token)) return true;
  return false;
}

// ── CLI flags ──────────────────────────────────────────────────────

const USE_STDIO = process.argv.includes('--stdio');

function getMcpPort(): number {
  return parseInt(
    process.argv
      .find((a, i) => a === '--port' && process.argv[i + 1])
      ? process.argv[process.argv.indexOf('--port') + 1]
      : process.env.MCP_PORT || '3100'
  );
}
function getMcpHost(): string {
  return process.argv.includes('--host')
    ? process.argv[process.argv.indexOf('--host') + 1] || '0.0.0.0'
    : process.env.MCP_HOST || '0.0.0.0';
}

// ── Initialize services ────────────────────────────────────────────

async function initializeServices(): Promise<void> {
  console.error('🔧 Initializing Katra MCP Server v3.0...');

  try {
    await connect_to_mongodb();
    console.error('  ✅ MongoDB connected');

    // Ensure API keys are available (generate + persist if missing).
    // validateMcpKey() is now the authoritative validator; process.env is updated
    // only when plaintext is available (env-var source or fresh generation).
    const { mcpApiKey, katraApiKey, generated: keysGenerated } = await ensureApiKeys();
    if (mcpApiKey) process.env.MCP_API_KEY = mcpApiKey;
    if (katraApiKey) process.env.ADMIN_API_KEY = katraApiKey;
    if (keysGenerated) {
      logGeneratedKeys(mcpApiKey, katraApiKey);
    } else {
      console.error(`🔐 MCP authentication ENABLED (via stored key hash)`);
    }
  } catch (e) {
    console.error('  ⚠️ MongoDB connection failed — service limited');
  }

  try {
    await get_redis_client();
    console.error('  ✅ Redis connected');
  } catch (e) {
    console.error('  ⚠️ Redis connection failed — caching limited');
  }

  // Pre-warm embedding model (lazy init, non-blocking)
  try {
    const ready = await embeddingService.encode('Embedding model warmup — initializing vector search');
    if (ready && embeddingService.isReady) {
      console.error('  ✅ Embedding service ready');
    } else {
      console.error('  ⚠️ Embedding service unavailable — keyword search only');
    }
  } catch {
    console.error('  ⚠️ Embedding service unavailable (Alpine/musl?) — keyword search only');
  }

  console.error('✅ MCP Memory Server ready (v3.0 — Katra Cognitive Memory)');
}

// ── Zod schemas ────────────────────────────────────────────────────

const SearchMemoriesInput = z.object({
  query: z.string().min(1).describe('Search query for memories'),
  user_id: z.string().optional().describe('Optional user ID to filter by'),
  limit: z.number().int().min(1).max(50).optional().default(10).describe('Max results'),
});

const VectorSearchInput = z.object({
  query: z.string().min(1).describe('Search query for semantic vector search'),
  user_id: z.string().optional().describe('Optional user ID'),
  limit: z.number().int().min(1).max(20).optional().default(10).describe('Max results'),
});

const StoreMemoryInput = z.object({
  content: z.string().min(1).describe('The memory content to store'),
  user_id: z.string().optional().describe('Optional user ID (personal memory). Defaults to the system user id.'),
  shared_id: z.string().optional().describe('Optional shared ID for communal memory (overrides user_id in shared mode)'),
  category: z.enum(['fact', 'preference', 'insight', 'event', 'general']).optional().default('general'),
  confidence: z.number().min(0).max(1).optional().default(0.8),
  session_id: z.string().optional().describe('Optional session ID. Required for episodic event routing (category "event").'),
  source: z.string().optional().describe('Optional origin of the memory (e.g. "kolega-code", "mcp_store").'),
  tags: z.array(z.string()).optional().describe('Optional tags for categorisation/filtering.'),
});

const GetMemoryScopeInput = z.object({}).describe('Get current memory scope settings');

const SetMemoryScopeInput = z.object({
  mode: z.enum(['personal', 'shared', 'hybrid']).describe('Memory scope mode'),
  shared_id: z.string().optional().describe('Shared ID for communal memory (required for shared/hybrid modes)'),
  hybrid_visible_user_ids: z.array(z.string()).optional().describe('User IDs visible in hybrid mode (in addition to caller)'),
});

const GetLLMConfigInput = z.object({}).describe('Get current LLM configuration (API key is masked)');

const ConfigureLLMInput = z.object({
  provider: z.enum(['deepseek', 'openai', 'moonshot', 'ollama', 'custom']).describe('LLM provider name'),
  api_key: z.string().describe('API key for the provider (not required for ollama)'),
  base_url: z.string().optional().describe('Base URL for the provider API (defaults applied per provider)'),
  model: z.string().optional().describe('Model name (defaults applied per provider)'),
});

const GetHistoryInput = z.object({
  session_id: z.string().describe('Conversation session ID'),
  limit: z.number().int().optional().default(20),
});

const TemporalRecallInput = z.object({
  user_id: z.string().describe('User ID to query events for'),
  from: z.string().optional().describe('ISO 8601 start date (defaults to 24h ago)'),
  to: z.string().optional().describe('ISO 8601 end date (defaults to now)'),
  limit: z.number().int().min(1).max(200).optional().default(50).describe('Max events'),
  event_type: z.string().optional().describe('Filter by event type'),
  role: z.enum(['user', 'assistant']).optional().describe('Filter by role'),
});

const TemporalSearchInput = z.object({
  user_id: z.string().describe('User ID'),
  query: z.string().min(1).describe('Search query (keywords)'),
  limit: z.number().int().min(1).max(50).optional().default(20),
});

const TimeBlockSummariesInput = z.object({
  user_id: z.string().describe('User ID'),
  from: z.string().optional().describe('ISO 8601 start date (defaults to 30 days ago)'),
  to: z.string().optional().describe('ISO 8601 end date (defaults to now)'),
  block_type: z.enum(['day', 'week', 'month']).optional().describe('Time block granularity'),
  limit: z.number().int().min(1).max(50).optional().default(20),
});

const SummarizeTimeBlocksInput = z.object({
  user_id: z.string().describe('User ID'),
  block_type: z.enum(['day', 'week', 'month']).optional().default('week'),
  lookback_days: z.number().int().min(1).max(365).optional().default(90),
  max_blocks: z.number().int().min(1).max(52).optional().default(20),
  dry_run: z.boolean().optional().default(false),
});

const DetectPatternsInput = z.object({
  user_id: z.string().describe('User ID'),
  lookback_weeks: z.number().int().min(1).max(52).optional().default(12),
  min_confidence: z.number().min(0).max(1).optional().default(0.5),
  dormant_threshold_days: z.number().int().min(1).max(365).optional().default(14),
});

const TemporalContextInput = z.object({
  user_id: z.string().describe('User ID'),
  session_id: z.string().describe('Session ID for context recovery'),
});

const GetJournalInput = z.object({
  user_id: z.string().describe('User ID'),
  source: z.enum(['auto', 'manual', 'all']).optional().default('all'),
  limit: z.number().int().min(1).max(50).optional().default(20),
});

const StoreJournalInput = z.object({
  user_id: z.string().describe('User ID'),
  shared_id: z.string().optional().describe('Optional shared ID for communal memory (used in shared/hybrid mode)'),
  entry: z.string().min(1).max(4000, 'Journal entry too long — keep under 4000 characters').describe('Journal entry text'),
  source: z.enum(['manual', 'system']).optional().default('manual'),
  tags: z.array(z.string()).optional().describe('Optional tags'),
});

const ListMissionsInput = z.object({
  user_id: z.string().describe('User ID'),
  limit: z.number().int().min(1).max(50).optional().default(10),
});

const GetMissionInput = z.object({
  user_id: z.string().describe('User ID'),
  mission_id: z.string().describe('Mission ID'),
});

const CreateMissionInput = z.object({
  user_id: z.string().describe('User ID'),
  shared_id: z.string().optional().describe('Optional shared ID for communal memory (used in shared/hybrid mode)'),
  goal: z.string().min(1).describe('Mission goal'),
  title: z.string().optional(),
  tasks: z.array(z.string()).optional(),
});

const UpdateMissionTaskInput = z.object({
  user_id: z.string().describe('User ID'),
  mission_id: z.string().describe('Mission ID'),
  task_id: z.string().describe('Task ID'),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
});

const DecomposeGoalInput = z.object({
  user_id: z.string().optional().describe('User ID'),
  goal: z.string().min(1).describe('The goal text to decompose into subtasks'),
});

const GetMemoryDiagnosticsInput = z.object({
  user_id: z.string().optional(),
});

const GetBackgroundStatusInput = z.object({});

// ── New tool schemas (gap closure) ────────────────────────

const ExploreGraphInput = z.object({
  query: z.string().optional().describe('Optional keyword filter for nodes'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('Max nodes to return'),
  include_edges: z.boolean().optional().default(true).describe('Include relationships between nodes'),
});

const WorkingMemoryInput = z.object({
  session_id: z.string().min(1).describe('Session ID to read/write working memory for'),
  action: z.enum(['get', 'store', 'delete']).describe('Action: get current memory, store new item, or delete session'),
  content: z.string().optional().describe('Content to store (required for store action)'),
  limit: z.number().int().min(1).max(50).optional().default(10).describe('Max items to return (get action)'),
});

const GetAutoJournalInput = z.object({
  user_id: z.string().describe('User ID'),
  limit: z.number().int().min(1).max(50).optional().default(20),
  since: z.string().optional().describe('ISO 8601 date to filter entries after'),
});

const GetTransactionLogInput = z.object({
  user_id: z.string().optional().describe('Filter by user ID'),
  action: z.string().optional().describe('Filter by action type (e.g., heartbeat_run, autonomous_tick)'),
  limit: z.number().int().min(1).max(100).optional().default(50),
  since: z.string().optional().describe('ISO 8601 date to filter entries after'),
});

const GetHeartbeatStatusInput = z.object({});

const ListAssetsInput = z.object({
  user_id: z.string().optional().describe('Filter by uploader user ID'),
  limit: z.number().int().min(1).max(100).optional().default(20),
  content_type: z.string().optional().describe('Filter by MIME type prefix (e.g., image/)'),
});

// ── Tool definitions ───────────────────────────────────────────────

const tools = [
  // ── Core Memory ───────────────────────────────────────────
  {
    name: 'store_memory',
    description: 'Store a new memory (fact, preference, insight, or event) into the long-term semantic memory. Returns confirmation with stored ID.',
    inputSchema: zodToJsonSchema(StoreMemoryInput) as Record<string, unknown>,
  },
  {
    name: 'search_memories',
    description: 'Search episodic and semantic memories using keyword search. Returns relevant past events, facts, and knowledge nodes. Use for "what do I know about X" or "find discussions about Y".',
    inputSchema: zodToJsonSchema(SearchMemoriesInput) as Record<string, unknown>,
  },
  {
    name: 'vector_search',
    description: 'Search memories using semantic vector similarity. Finds conceptually related memories even when keywords do not match (e.g., "containerization" matches "Docker strategy"). Falls back to keyword search if vector model unavailable.',
    inputSchema: zodToJsonSchema(VectorSearchInput) as Record<string, unknown>,
  },
  {
    name: 'get_conversation_history',
    description: 'Retrieve the raw conversation history for a given session ID. Returns chronologically ordered events.',
    inputSchema: zodToJsonSchema(GetHistoryInput) as Record<string, unknown>,
  },
  // ── Temporal Memory ───────────────────────────────────────
  {
    name: 'temporal_recall',
    description: 'Query episodic events within a date/time range. Use for "what happened last week" or "show me messages from May". Returns events sorted by timestamp descending.',
    inputSchema: zodToJsonSchema(TemporalRecallInput) as Record<string, unknown>,
  },
  {
    name: 'temporal_search',
    description: 'Search episodic events by keyword with time context. Use for "find conversations about the trading bot" or "search for bug discussions". Uses text index with regex fallback.',
    inputSchema: zodToJsonSchema(TemporalSearchInput) as Record<string, unknown>,
  },
  {
    name: 'get_time_block_summaries',
    description: 'Query LLM-generated time-block summaries. Returns pre-computed AI summaries of conversation activity by day, week, or month. Use for "what was the summary of last week"s discussions".',
    inputSchema: zodToJsonSchema(TimeBlockSummariesInput) as Record<string, unknown>,
  },
  {
    name: 'summarize_time_blocks',
    description: 'Trigger LLM summarization of conversation activity across time blocks (day/week/month). Generates AI summaries of what happened in each period. Use dry_run=true to preview without storing.',
    inputSchema: zodToJsonSchema(SummarizeTimeBlocksInput) as Record<string, unknown>,
  },
  {
    name: 'detect_patterns',
    description: 'Detect temporal patterns in user activity: recurring topics (e.g., "every Monday you work on X"), session rhythm (most active days), topic regressions (old issues resurfacing), and dormant topics (things you haven\'t mentioned in a while).',
    inputSchema: zodToJsonSchema(DetectPatternsInput) as Record<string, unknown>,
  },
  {
    name: 'get_temporal_context',
    description: 'Get the current temporal context for a session including recent events, working memory state, and session metadata. Use before responding to understand the user\'s current context.',
    inputSchema: zodToJsonSchema(TemporalContextInput) as Record<string, unknown>,
  },
  // ── Journal ───────────────────────────────────────────────
  {
    name: 'get_journal',
    description: 'Read agent journal entries (auto-generated insights or manual reflections). Filter by source: auto (distilled from conversations), manual (JOURNAL: directives), or all.',
    inputSchema: zodToJsonSchema(GetJournalInput) as Record<string, unknown>,
  },
  {
    name: 'store_journal',
    description: 'Write a journal entry to the agent\'s memory. Stores a reflective insight, observation, or note that will be retrievable in future conversations. Use for distilling learnings from interactions.',
    inputSchema: zodToJsonSchema(StoreJournalInput) as Record<string, unknown>,
  },
  // ── Goal/Mission Memory ───────────────────────────────────
  {
    name: 'list_missions',
    description: 'List all missions (goals) for a user. Shows mission status, progress, task counts, and creation date. Use to see what goals the user is currently working on.',
    inputSchema: zodToJsonSchema(ListMissionsInput) as Record<string, unknown>,
  },
  {
    name: 'get_mission',
    description: 'Get full mission details including the task tree, self-journal entries, progress summary, and all metadata for a specific mission by ID.',
    inputSchema: zodToJsonSchema(GetMissionInput) as Record<string, unknown>,
  },
  {
    name: 'create_mission',
    description: 'Create a new mission (goal) with optional task breakdown. Returns the mission ID. Use this when the user wants to start a new project or track a goal.',
    inputSchema: zodToJsonSchema(CreateMissionInput) as Record<string, unknown>,
  },
  {
    name: 'update_mission_task',
    description: 'Update the status of a task within a mission. Status can be: pending, in_progress, completed, or blocked.',
    inputSchema: zodToJsonSchema(UpdateMissionTaskInput) as Record<string, unknown>,
  },
  // ── PFC Goal Manager ──────────────────────────────────────
  {
    name: 'decompose_goal',
    description: 'Decompose a goal into a dependency-ordered subtask graph. The Goal Manager (PFC proxy) uses LLM to break the goal into 3-7 subtasks with dependencies, then returns the next unblocked action. Use for planning multi-step work.',
    inputSchema: zodToJsonSchema(DecomposeGoalInput) as Record<string, unknown>,
  },
  // ── Diagnostics ───────────────────────────────────────────
  {
    name: 'get_memory_diagnostics',
    description: 'Get comprehensive memory system diagnostics: document counts by collection, processing backlog size, embedding coverage, index status, and overall health.',
    inputSchema: zodToJsonSchema(GetMemoryDiagnosticsInput) as Record<string, unknown>,
  },
  {
    name: 'get_background_status',
    description: 'Check background processor status: queue depth, last run time, processing interval, and any errors.',
    inputSchema: zodToJsonSchema(GetBackgroundStatusInput) as Record<string, unknown>,
  },
  {
    name: 'get_health',
    description: 'Check the health of all backend services: MongoDB, Redis, LLM, and embedding model status.',
    inputSchema: zodToJsonSchema(z.object({})) as Record<string, unknown>,
  },
  // ── Knowledge Graph ───────────────────────────────────────
  {
    name: 'explore_graph',
    description: 'Explore the knowledge graph: nodes (entities) and edges (relationships) extracted from conversations via LLM compaction. Use to traverse entity-relationship connections, find related concepts, or see what Solomon has learned.',
    inputSchema: zodToJsonSchema(ExploreGraphInput) as Record<string, unknown>,
  },
  // ── Working Memory ────────────────────────────────────────
  {
    name: 'working_memory',
    description: 'Read, store, or delete short-term working memory for a session. Working memory lives in Redis for <5ms access and holds temporary context, variables, and recent items. Use action=get to retrieve, action=store to add, action=delete to clear.',
    inputSchema: zodToJsonSchema(WorkingMemoryInput) as Record<string, unknown>,
  },
  // ── Auto Journal ──────────────────────────────────────────
  {
    name: 'get_auto_journal',
    description: 'Query auto-generated journal entries distilled from conversations by Solomon\'s self-reflection loop. These are different from manual journal entries — they contain AI-distilled insights, patterns, and observations.',
    inputSchema: zodToJsonSchema(GetAutoJournalInput) as Record<string, unknown>,
  },
  // ── Transaction Log ───────────────────────────────────────
  {
    name: 'get_transaction_log',
    description: 'Query the audit trail of Solomon\'s actions: heartbeat runs, autonomous ticks, tool executions, and system events. Use for debugging or reviewing what the agent did and when.',
    inputSchema: zodToJsonSchema(GetTransactionLogInput) as Record<string, unknown>,
  },
  // ── Heartbeat Status ──────────────────────────────────────
  {
    name: 'get_heartbeat_status',
    description: 'Check the heartbeat scheduler status: whether it\'s running, last run time/result, next scheduled run, interval, and recent run history.',
    inputSchema: zodToJsonSchema(GetHeartbeatStatusInput) as Record<string, unknown>,
  },
  // ── Assets ────────────────────────────────────────────────
  {
    name: 'list_assets',
    description: 'List uploaded assets stored in MinIO (images, files, documents). Returns asset IDs, filenames, content types, sizes, and upload dates.',
    inputSchema: zodToJsonSchema(ListAssetsInput) as Record<string, unknown>,
  },
  // ── Memory Scope ─────────────────────────────────────────
  {
    name: 'get_memory_scope',
    description: 'Get the current memory scope settings: mode (personal/shared/hybrid), shared_id, and visible user IDs.',
    inputSchema: zodToJsonSchema(GetMemoryScopeInput) as Record<string, unknown>,
  },
  {
    name: 'set_memory_scope',
    description: 'Set memory scope mode and configuration. Modes: personal (isolated by user_id), shared (communal via shared_id), hybrid (personal + shared + other users).',
    inputSchema: zodToJsonSchema(SetMemoryScopeInput) as Record<string, unknown>,
  },
  {
    name: 'get_llm_config',
    description: 'Get the current LLM provider configuration. Shows provider name, base URL, model, and whether the service is available. API key is masked.',
    inputSchema: zodToJsonSchema(GetLLMConfigInput) as Record<string, unknown>,
  },
  {
    name: 'configure_llm',
    description: 'Configure the LLM provider for semantic memory extraction, auto-journaling, and summaries. Reconfigures the live service without restart. The agent can call this to self-configure during setup.',
    inputSchema: zodToJsonSchema(ConfigureLLMInput) as Record<string, unknown>,
  },
  // ── Sleep Consolidation / Reflection ─────────────────────────
  {
    name: 'get_daily_reflection',
    description: 'Get the most recent reflective journal entry from sleep consolidation — the AI\'s introspective narrative for a period (daily, weekly, or monthly).',
    inputSchema: zodToJsonSchema(z.object({
      period_type: z.enum(['daily', 'weekly', 'monthly']).optional().default('daily'),
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_emotional_context',
    description: 'Get the emotional/reflective context for an entity — how the AI "feels" about a person, project, tool, or concept based on accumulated reflections. Returns the entity\'s emotional signature and all related emotional edges.',
    inputSchema: zodToJsonSchema(z.object({
      entity_name: z.string().describe('The entity name to get emotional context for'),
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_philosophical_insights',
    description: 'Query philosophical insights derived from reflection — abstracted principles and realizations that have emerged across sleep consolidation periods.',
    inputSchema: zodToJsonSchema(z.object({
      domain: z.string().optional().describe('Filter by domain (engineering, relationships, self, etc.)'),
      status: z.enum(['emerging', 'strengthening', 'stable', 'challenged']).optional(),
      limit: z.number().int().min(1).max(50).optional().default(10),
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_unresolved_threads',
    description: 'Get currently unresolved questions, tensions, and incomplete thoughts that persist across reflection periods — the open loops in the agent\'s consciousness.',
    inputSchema: zodToJsonSchema(z.object({
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_reflection_arc',
    description: 'Trace the emotional trajectory for an entity over time — how feelings and attitudes have evolved across reflection periods. Returns a timeline of emotional signatures.',
    inputSchema: zodToJsonSchema(z.object({
      entity_name: z.string().describe('The entity to trace emotional evolution for'),
      user_id: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional().default(10),
    })) as Record<string, unknown>,
  },
  {
    name: 'trigger_reflection',
    description: 'Manually trigger a sleep consolidation run for a specific time period. The AI will gather all memory data from the period and distill it into emotional understanding, philosophical insights, and a reflective narrative.',
    inputSchema: zodToJsonSchema(z.object({
      period_type: z.enum(['daily', 'weekly', 'monthly']).describe('The time period to consolidate'),
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  // ── Self Model ──────────────────────────────────────────────
  {
    name: 'get_identity_kernel',
    description: 'Get the agent\'s identity kernel — "I am the kind of agent who..." narrative derived from stable philosophical insights. Returns a narrative and top 5 insights sorted by confidence.',
    inputSchema: zodToJsonSchema(z.object({
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_mind_wander',
    description: 'Perform a mind-wandering random walk on the knowledge graph. Starts at a random node and follows edges weighted by relationship strength. Returns the traversal path, an associative narrative, and stores the result as a low-salience episodic event.',
    inputSchema: zodToJsonSchema(z.object({
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_agent_beliefs',
    description: 'Retrieve the agent\'s Theory of Mind beliefs about a specific entity — what propositions the agent believes about that entity, along with confidence and source.',
    inputSchema: zodToJsonSchema(z.object({
      entity_name: z.string().describe('The entity name to retrieve beliefs for'),
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_procedural_templates',
    description: 'Get cached procedural memory templates — tool-call patterns that have been observed frequently enough (>= 5 occurrences) to be considered habitual. Shows tool name, input shape, frequency, and average success rate.',
    inputSchema: zodToJsonSchema(z.object({})) as Record<string, unknown>,
  },
  {
    name: 'get_memory_decay_stats',
    description: 'Get memory decay statistics across all memory types — how many memories are active, decaying, or forgotten, with average retrieval strength per type.',
    inputSchema: zodToJsonSchema(z.object({
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_anomaly_report',
    description: 'Get anomaly detection report — counts of normal, suspect, and anomalous memories ingested, quarantined count, and recent anomaly records.',
    inputSchema: zodToJsonSchema(z.object({
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_quarantined_memories',
    description: 'List all currently quarantined memories — memories classified as anomalous at ingestion, excluded from retrieval and reflection until corroborated.',
    inputSchema: zodToJsonSchema(z.object({
      user_id: z.string().optional(),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_salience_state',
    description: 'Get the current attention/salience state — meta-state (exploration/task_execution/reflection/alert/idle), active weights, arousal level, and recent salience score distribution.',
    inputSchema: zodToJsonSchema(z.object({})) as Record<string, unknown>,
  },
  {
    name: 'get_attention_report',
    description: 'Get a comprehensive attention report — how many memories received high/medium/low salience, average scores, current meta-state, and active goals.',
    inputSchema: zodToJsonSchema(z.object({})) as Record<string, unknown>,
  },
  {
    name: 'get_drive_state',
    description: 'Get the current homeostatic drive state — coherence, novelty, connection, and growth drive levels, strengths, and the dominant drive.',
    inputSchema: zodToJsonSchema(z.object({})) as Record<string, unknown>,
  },
  {
    name: 'get_source_trust',
    description: 'Get the trust score for a memory source. Sources accumulate trust from corroboration history (+0.02 per confirm, -0.15 per contradiction).',
    inputSchema: zodToJsonSchema(z.object({
      source_id: z.string().describe('The source identifier to look up'),
    })) as Record<string, unknown>,
  },
  {
    name: 'get_error_report',
    description: 'Get the error monitoring (ACC) report — prediction accuracy, average TD error, surprise rate, and conflict count.',
    inputSchema: zodToJsonSchema(z.object({})) as Record<string, unknown>,
  },
  {
    name: 'get_action_policy',
    description: 'Get the current learned action policy for a state — which actions have the highest Q-values and selection probabilities.',
    inputSchema: zodToJsonSchema(z.object({
      state_key: z.string().describe('The state to query the policy for'),
    })) as Record<string, unknown>,
  },
];

// ── Memory Decay handlers ────────────────────────────────────────

async function handleGetMemoryDecayStats(args: unknown): Promise<TextContent[]> {
  const input = z.object({ user_id: z.string().optional() }).parse(args);
  const userId = resolveUserId(input.user_id);
  const service = MemoryDecayService.get_instance();
  const stats = await service.getDecayStats(userId);
  if (stats.length === 0) return [{ type: 'text', text: 'No memory decay data available yet.' }];
  const lines = stats.map(s => `**${(s.memoryType || 'unknown').toUpperCase()}** — ${s.totalMemories} total, ${s.decayedCount} decayed, ${s.reinforcedCount} reinforced (avg strength: ${s.averageStrength}, min: ${s.minStrength}, max: ${s.maxStrength})`);
  return [{ type: 'text', text: `## Memory Decay Statistics\n\n${lines.join('\n\n')}` }];
}

// ── Anomaly Detection handlers ────────────────────────────────────

async function handleGetAnomalyReport(args: unknown): Promise<TextContent[]> {
  const input = z.object({ user_id: z.string().optional() }).parse(args);
  const userId = resolveUserId(input.user_id);
  const service = AnomalyDetectionService.get_instance();
  const report = await service.getAnomalyReport(userId);
  const lines = [`**Total Ingested:** ${report.total_ingested ?? 0}`, `**Normal:** ${report.normal_count ?? 0}`, `**Suspect:** ${report.suspect_count ?? 0}`, `**Anomalous:** ${report.anomalous_count ?? 0}`, `**Quarantined:** ${report.quarantined_count ?? 0}`, `**Avg Z-Score:** ${report.average_z_score ?? 0}`];
  return [{ type: 'text', text: `## Anomaly Detection Report\n\n${lines.join('\n')}` }];
}

async function handleGetQuarantinedMemories(args: unknown): Promise<TextContent[]> {
  const input = z.object({ user_id: z.string().optional() }).parse(args);
  const userId = resolveUserId(input.user_id);
  const service = AnomalyDetectionService.get_instance();
  const quarantined = await service.getQuarantinedMemories(userId);
  if (quarantined.length === 0) return [{ type: 'text', text: 'No quarantined memories.' }];
  const lines = quarantined.map((q, i) => `${i + 1}. \`${q.id}\` — z=${q.z_score.toFixed(2)}, type=${q.memory_type}, corroborations=${q.corroboration_count}, quarantine: ${new Date(q.quarantined_at).toISOString().split('T')[0]}`);
  return [{ type: 'text', text: `## Quarantined Memories (${quarantined.length})\n\n${lines.join('\n')}\n\n*Auto-rehab at 3 independent corroborations.*` }];
}

// ── Salience handlers ─────────────────────────────────────────────

async function handleGetSalienceState(): Promise<TextContent[]> {
  const service = SalienceService.get_instance();
  const report = service.getAttentionReport();
  const scores = report.recent_scores || [];
  const avgScore = scores.length > 0
    ? parseFloat((scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(4))
    : 0;
  const highCount = scores.filter((s: number) => s > 0.7).length;
  const medCount = scores.filter((s: number) => s >= 0.35 && s <= 0.7).length;
  const lowCount = scores.filter((s: number) => s < 0.35).length;
  const lines = [`**Meta-State:** \`${report.meta_state}\``, `**Attention Threshold:** ${report.threshold}`, `**Avg Score:** ${avgScore}`, `**Active Goals:** ${report.goal_count || 0}`, '', '### Distribution', `- High (>0.7): ${highCount}`, `- Medium (0.35-0.7): ${medCount}`, `- Low (<0.35): ${lowCount}`];
  return [{ type: 'text', text: `## Salience / Attention State\n\n${lines.join('\n')}` }];
}

async function handleGetAttentionReport(): Promise<TextContent[]> {
  const service = SalienceService.get_instance();
  const report = service.getAttentionReport();
  const scores = report.recent_scores || [];
  const avgScore = scores.length > 0
    ? parseFloat((scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(4))
    : 0;
  const highCount = scores.filter((s: number) => s > 0.7).length;
  const medCount = scores.filter((s: number) => s >= 0.35 && s <= 0.7).length;
  const lowCount = scores.filter((s: number) => s < 0.35).length;
  const lines = [`## Attention Report`, '', `**Meta-State:** \`${report.meta_state}\``, `**Threshold:** ${report.threshold}`, `**Avg Score:** ${avgScore}`, '', '### Processing Distribution (last 50)', `- High (>0.7): ${highCount}`, `- Medium (0.35-0.7): ${medCount}`, `- Low (<0.35): ${lowCount}`, '', '*High → full processing. Medium → embedding only. Low → minimal storage, faster decay.*'];
  return [{ type: 'text', text: lines.join('\n') }];
}

// ── Motivation handlers ───────────────────────────────────────────

async function handleGetDriveState(): Promise<TextContent[]> {
  const engine = MotivationalEngine.get_instance();
  const snapshot = engine.tick();
  const dominant = engine.getDominantDrive();
  const lines = [`**Dominant Drive:** \`${dominant}\``, '', '| Drive | Level | Strength | Trend |', '|-------|-------|----------|-------|'];
  for (const [name, drive] of Object.entries(snapshot.drives)) {
    lines.push(`| ${name} | ${((drive as any).current * 100).toFixed(0)}% | ${(drive.strength * 100).toFixed(0)}% | ${drive.trend} |`);
  }
  return [{ type: 'text', text: `## Homeostatic Drive State\n\n${lines.join('\n')}` }];
}

async function handleGetSourceTrust(args: unknown): Promise<TextContent[]> {
  const input = z.object({ source_id: z.string() }).parse(args);
  const engine = MotivationalEngine.get_instance();
  const trust = await engine.getSourceTrust(input.source_id);
  const lines = [`**Source:** \`${trust.sourceId}\``, `**Trust Score:** ${trust.trustScore.toFixed(3)}`, `**Corroborations:** ${trust.corroborationCount}`, `**Contradictions:** ${trust.contradictionCount}`, `**Last Updated:** ${trust.lastUpdated.toISOString()}`];
  return [{ type: 'text', text: `## Source Trust\n\n${lines.join('\n')}` }];
}

// ── Decision/Action handlers ──────────────────────────────────────

async function handleGetErrorReport(): Promise<TextContent[]> {
  const service = DecisionActionService.get_instance();
  const report = service.getErrorReport();
  const recentDeltasStr = report.recentDeltas && report.recentDeltas.length > 0
    ? report.recentDeltas.slice(-5).map((d: number) => d.toFixed(4)).join(', ')
    : 'none';
  const lines = [`**Accuracy:** ${(report.accuracy * 100).toFixed(1)}%`, `**Avg TD Error:** ${report.avgTdError}`, `**Surprise Rate:** ${(report.surpriseRate * 100).toFixed(1)}%`, `**Conflicts:** ${report.conflictCount}`, `**Recent TD Errors:** ${recentDeltasStr}`];
  return [{ type: 'text', text: `## Error Monitor (ACC)\n\n${lines.join('\n')}` }];
}

async function handleGetActionPolicy(args: unknown): Promise<TextContent[]> {
  const input = z.object({ state_key: z.string() }).parse(args);
  const service = DecisionActionService.get_instance();
  const policy = service.getPolicy(input.state_key);
  if (policy.length === 0) return [{ type: 'text', text: `No policy learned yet for \`${input.state_key}\`.` }];
  const lines = policy.map((p, i) => `${i + 1}. \`${p.action_id}\` — Q=${p.q_value}, P(select)=${(p.probability * 100).toFixed(1)}%`);
  return [{ type: 'text', text: `## Action Policy \`${input.state_key}\`\n\n${lines.join('\n')}` }];
}

// ── Self Model handlers ──────────────────────────────────────────

async function handleGetIdentityKernel(args: unknown): Promise<TextContent[]> {
  const input = z.object({
    user_id: z.string().optional(),
  }).parse(args);
  const userId = resolveUserId(input.user_id);

  const service = SelfModelService.get_instance();
  const kernel = await service.getIdentityKernel(userId);

  const lines: string[] = [
    '## Identity Kernel',
    '',
    `**Narrative:** ${kernel.narrative}`,
    '',
  ];

  if (kernel.insights.length > 0) {
    lines.push('### Top Insights', '');
    for (let i = 0; i < kernel.insights.length; i++) {
      const ins = kernel.insights[i];
      lines.push(`${i + 1}. **${ins.domain}** (${(ins.confidence * 100).toFixed(0)}% confidence, ${ins.status})`);
      lines.push(`   ${ins.insight_text}`);
      lines.push('');
    }
  } else {
    lines.push('*No stable or strengthening insights found.*');
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetMindWander(args: unknown): Promise<TextContent[]> {
  const input = z.object({
    user_id: z.string().optional(),
  }).parse(args);
  const userId = resolveUserId(input.user_id);

  const service = SelfModelService.get_instance();
  const wander = await service.generateMindWander(userId);

  const lines: string[] = [
    '## Mind Wander',
    '',
    `**Narrative:** ${wander.narrative}`,
  ];

  if (wander.path.length > 0) {
    lines.push('', '**Path:** ' + wander.path.join(' → '));
  }

  if (wander.stored_event_id) {
    lines.push('', `**Stored as episodic event:** \`${wander.stored_event_id}\``);
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetAgentBeliefs(args: unknown): Promise<TextContent[]> {
  const input = z.object({
    entity_name: z.string(),
    user_id: z.string().optional(),
  }).parse(args);

  const service = SelfModelService.get_instance();
  const beliefs = await service.getAgentBeliefs(input.entity_name);

  const lines: string[] = [
    `## Agent Beliefs — ${input.entity_name}`,
    '',
  ];

  if (beliefs.length === 0) {
    lines.push('*No beliefs recorded for this entity.*');
  } else {
    lines.push('| Proposition | Confidence | Source | Last Updated |');
    lines.push('|-------------|------------|--------|--------------|');
    for (const b of beliefs) {
      lines.push(`| ${b.proposition} | ${(b.confidence * 100).toFixed(0)}% | ${b.source} | ${b.last_updated.toISOString()} |`);
    }
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetProceduralTemplates(_args: unknown): Promise<TextContent[]> {
  const service = SelfModelService.get_instance();
  const templates = service.getProceduralTemplates();

  const lines: string[] = [
    '## Procedural Templates',
    '',
  ];

  if (templates.length === 0) {
    lines.push('*No procedural templates cached yet (threshold: 5 occurrences).*');
  } else {
    lines.push('| Tool Name | Input Shape | Frequency | Avg Success |');
    lines.push('|-----------|-------------|-----------|-------------|');
    for (const t of templates) {
      lines.push(`| ${t.toolName} | ${t.inputShape} | ${t.frequency} | ${(t.avgSuccess * 100).toFixed(0)}% |`);
    }
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

// ── Tool handlers ──────────────────────────────────────────────────

async function handleStoreMemory(args: unknown): Promise<TextContent[]> {
  const input = StoreMemoryInput.parse(args);
  if (!is_database_connected()) {
    return [{ type: 'text', text: '⚠️ MongoDB is not connected. Cannot store memory.' }];
  }

  const db = get_database();

  // Aligned default user id across store + search (see memory-scope-service).
  const userId = input.user_id || DEFAULT_USER_ID;
  const source = input.source || 'mcp_store';
  const tags = input.tags || [];

  // Resolve shared_id based on current memory scope mode
  const sharedId = await resolveSharedId(input.shared_id);

  // ── Episodic path: category "event" routes through the EpisodicEventManager.
  // This lands the memory in `episodic_events` with content-hash dedup and
  // triggers background distillation (extraction → semantic facts → knowledge graph).
  if (input.category === 'event') {
    try {
      const sessionId = input.session_id || `mcp_session:${stableContentHash(userId, input.content)}`;
      const eventManager = getEpisodicEventManager();
      const result = await eventManager.createEvent({
        user_id: userId,
        shared_id: sharedId || undefined,
        session_id: sessionId,
        event_type: 'conversation',
        content: {
          role: 'user',
          message: input.content,
          source,
          tags,
        },
        metadata: {
          source,
          processed: false,
          tags,
          origin: 'store_memory',
        },
      });

      const dedupNote = result.was_duplicate
        ? `\n**Dedup:** ${result.action_taken} (existing event \`${result.duplicate_of || result.event.id}\`)`
        : '';

      // Fire-and-forget embedding on the episodic event for vector recall.
      try {
        const vec = await embeddingService.encode(input.content);
        if (vec) {
          const anomalyService = AnomalyDetectionService.get_instance();
          const anomalyResult = await anomalyService.classifyAtIngestion(vec, 'episodic', userId, input.confidence ?? 1.0);

          const decayService = MemoryDecayService.get_instance();
          const strengthResult = decayService.computeRetrievalStrength('episodic', new Date(), undefined, 0);

          await db.collection('episodic_events').updateOne(
            { id: result.event.id },
            {
              $set: {
                embedding: vec,
                embedding_model: embeddingService.modelName,
                embedding_version: embeddingService.version,
                retrieval_strength: strengthResult.strength,
                last_accessed_at: new Date(),
                access_count: 0,
                decay_exponent: strengthResult.decay_exponent,
                anomaly_z_score: anomalyResult.z_score,
                anomaly_classification: anomalyResult.classification,
              },
            }
          );

          if (anomalyResult.classification !== 'normal') {
            await anomalyService.recordAnomaly(result.event.id, 'episodic', userId, anomalyResult.classification, anomalyResult.z_score, anomalyResult.centroid_distance, anomalyResult.historical_mean, anomalyResult.historical_stddev, vec).catch(() => {});
          }
        }
      } catch {
        // Embedding failed — event is still stored
      }

      const scopeInfo = sharedId ? `\n**Shared ID:** \`${sharedId}\`` : '';
      return [{
        type: 'text',
        text: `✅ Episodic memory stored.\n\n**Event ID:** \`${result.event.id}\`\n**Session:** \`${sessionId}\`\n**Action:** ${result.action_taken}\n**User:** \`${userId}\`${dedupNote}${scopeInfo}`,
      }];
    } catch (error: any) {
      return [{ type: 'text', text: `❌ Failed to store episodic memory: ${error?.message || error}` }];
    }
  }

  // ── Semantic path: facts / preferences / insights / general.
  // Content-stable dedup via upsert on (user_id + content) hash — replaces the
  // previous blind insertOne that created a duplicate on every call.
  const contentHash = stableContentHash(userId, input.content);

  const doc: Record<string, unknown> = {
    user_id: userId,
    content: input.content,
    content_hash: contentHash,
    category: input.category,
    confidence: input.confidence,
    source,
    timestamp: new Date(),
    metadata: {
      source,
      extraction_context: {
        source: 'mcp_store',
        timestamp: new Date().toISOString(),
      },
    },
  };
  if (tags.length > 0) doc.tags = tags;
  if (sharedId) doc.shared_id = sharedId;

  const result = await db.collection('semantic_facts').findOneAndUpdate(
    { content_hash: contentHash },
    {
      $set: { ...doc, last_accessed: new Date() },
      $setOnInsert: { created_at: new Date() },
      $inc: { access_count: 1 },
    },
    { upsert: true, returnDocument: 'after' }
  );

  const insertedId = result?._id;
  const wasUpdate = result && (result as any).access_count > 1;

  // Fire-and-forget embedding
  try {
    const vec = await embeddingService.encode(input.content);
    if (vec) {
      await db.collection('semantic_facts').updateOne(
        { _id: insertedId },
        {
          $set: {
            embedding: vec,
            embedding_model: embeddingService.modelName,
            embedding_version: embeddingService.version,
          },
        }
      );
    }
  } catch {
    // Embedding failed — memory is still stored
  }

  const scopeInfo = sharedId ? `\n**Shared ID:** \`${sharedId}\`` : '';
  return [{
    type: 'text',
    text: `✅ Memory stored.\n\n**ID:** \`${insertedId}\`\n**Content:** ${input.content.slice(0, 200)}${input.content.length > 200 ? '…' : ''}\n**Category:** ${input.category}\n**Confidence:** ${(input.confidence * 100).toFixed(0)}%\n**Dedup hash:** \`${contentHash}\`${wasUpdate ? ' (upserted)' : ''}${scopeInfo}`,
  }];
}

async function handleSearchMemories(args: unknown): Promise<TextContent[]> {
  const input = SearchMemoriesInput.parse(args);
  if (!is_database_connected()) {
    return [{ type: 'text', text: '\u26a0\ufe0f MongoDB is not connected.' }];
  }

  const db = get_database();

  // Build scope-aware filter (personal / shared / hybrid)
  const baseFilter = await buildScopeFilter(input.user_id);
  const limit = input.limit || 20;

  // Get scope info for output header
  const scopeConfig = await getMemoryScope();

  // Utility: escape regex special chars for safe literal matching
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const safeRegex = new RegExp(escapeRegex(input.query), 'i');

  // ── Search Collections ──────────────────────────────────────────
  const collections = [
    { name: 'episodic_events',     label: 'Episodic',     contentPath: 'content.message' },
    { name: 'semantic_facts',      label: 'Semantic',     contentPath: 'content' },
    { name: 'agent_journal_manual', label: 'Journal (Manual)', contentPath: 'content' },
    { name: 'agent_journal_auto',  label: 'Journal (Auto)',   contentPath: 'content' },
    { name: 'knowledge_nodes',     label: 'Knowledge Graph',  contentPath: 'title' },
    { name: 'knowledge_relationships', label: 'Relationships',  contentPath: 'relationship_type' },
    { name: 'memory_nodes',        label: 'Memory Nodes',    contentPath: 'label' },
    { name: 'memory_edges',        label: 'Memory Edges',    contentPath: 'label' },
    { name: 'memory_missions',     label: 'Missions',    contentPath: 'title' },
    { name: 'asset_metadata',      label: 'Assets',     contentPath: 'filename' },
    { name: 'working_memory_sessions', label: 'Working Memory', contentPath: 'summary' },
  ];

  interface SearchResult {
    source: string;
    snippet: string;
    timestamp?: string;
    confidence?: number;
    score?: number;
  }

  const allResults: SearchResult[] = [];
  const seenContent = new Set<string>();

  // ── Pass 1: Vector/Semantic Search ──────────────────────────────
  let vectorResults: SearchResult[] = [];
  try {
    if (embeddingService.isReady) {
      const queryVec = await embeddingService.encode(input.query);
      if (queryVec) {
        const facts = await db.collection('semantic_facts')
          .find({ embedding: { $exists: true } })
          .limit(100)
          .toArray();
        if (facts.length > 0) {
          vectorResults = facts
            .map((f: any) => {
              if (f.embedding?.length === embeddingService.embeddingDimension) {
                const cosine = embeddingService.cosineSimilarity(queryVec, f.embedding);
                const score = embeddingService.combinedScore(cosine, f.created_at, 0.6);
                return {
                  source: 'vector',
                  snippet: f.content || f.title || '',
                  timestamp: f.timestamp || f.created_at,
                  confidence: f.confidence,
                  score,
                };
              }
              return { source: 'vector', snippet: '', timestamp: '', score: 0 };
            })
            .filter(r => r.score > 0.3)
            .sort((a, b) => b.score! - a.score!)
            .slice(0, limit);
        }
      }
    }
  } catch (e) {
    // Vector search failed — continue with text search
  }
  for (const r of vectorResults) {
    const key = r.snippet.slice(0, 80);
    if (!seenContent.has(key)) {
      seenContent.add(key);
      allResults.push(r);
    }
  }

  // ── Pass 2: Text Search across ALL collections ──────────────────
  for (const col of collections) {
    let docs: any[] = [];
    const contentField = col.contentPath;

    try {
      // Try  index first
      docs = await db.collection(col.name)
        .find({ ...baseFilter, $text: { $search: input.query } })
        .sort({ timestamp: -1 } as any)
        .limit(limit)
        .toArray();
    } catch {
      // Fall back to regex on content field + title/name fields
      const regexFilter: Record<string, unknown> = { ...baseFilter };
      // Build  across multiple searchable fields
      const orConditions: Record<string, unknown>[] = [
        { [contentField]: { $regex: safeRegex } },
      ];
      // Extra fields for specific collections
      if (col.name === 'knowledge_nodes') orConditions.push({ name: { $regex: safeRegex } });
      if (col.name === 'memory_missions')  orConditions.push({ description: { $regex: safeRegex } });
      if (col.name === 'memory_nodes')     orConditions.push({ content: { $regex: safeRegex } });
      if (col.name === 'knowledge_relationships') orConditions.push({ source_type: { $regex: safeRegex } });

      regexFilter['$or'] = orConditions;
      try {
        docs = await db.collection(col.name)
          .find(regexFilter)
          .sort({ timestamp: -1 } as any)
          .limit(limit)
          .toArray();
      } catch {
        continue; // Skip collections that don't support this query shape
      }
    }

    for (const doc of docs) {
      const text = typeof doc[contentField] === 'string' ? doc[contentField]
        : (typeof doc.content === 'string' ? doc.content
        : (doc.title || doc.name || doc.label || doc.filename || JSON.stringify(doc).slice(0, 200)));

      // Deduplicate
      const key = text.slice(0, 80);
      if (seenContent.has(key)) continue;
      seenContent.add(key);

      allResults.push({
        source: col.label,
        snippet: text.length > 300 ? text.slice(0, 300) + '...' : text,
        timestamp: doc.timestamp || doc.created_at || doc.date,
        confidence: doc.confidence,
        score: 0.5,
      });
    }
  }

  // ── Format Output ────────────────────────────────────────────────
  // Group by source
  const grouped = new Map<string, SearchResult[]>();
  for (const r of allResults) {
    const existing = grouped.get(r.source) || [];
    existing.push(r);
    grouped.set(r.source, existing);
  }

  const lines: string[] = [
    `## Memory Search: "${input.query}"`,
    `Found ${allResults.length} results across ${grouped.size} sources (scope: ${scopeConfig.mode})`,
  ];

  if (vectorResults.length > 0) {
    lines.push('', `### 🔍 Vector (Semantic) (${vectorResults.length})`);
    for (const r of vectorResults) {
      lines.push(`- ${r.snippet.slice(0, 200)} (score: ${r.score?.toFixed(2)})`);
    }
  }

  for (const [source, results] of grouped) {
    if (source === 'vector') continue;
    lines.push('', `### ${source} (${results.length})`);
    for (const r of results) {
      const ts = r.timestamp ? ` [${new Date(r.timestamp).toISOString()}]` : '';
      lines.push(`-${ts} ${r.snippet.slice(0, 250)}`);
    }
  }

  if (allResults.length === 0) {
    lines.push('', '*No results found across any collection. Try a different query or check if the memory system has been populated.*');
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleVectorSearch(args: unknown): Promise<TextContent[]> {
  const input = VectorSearchInput.parse(args);
  if (!is_database_connected()) {
    return [{ type: 'text', text: '⚠️ MongoDB is not connected.' }];
  }

  const db = get_database();
  const scopeFilter = await buildScopeFilter(input.user_id);
  let results: any[] = [];
  let usedVector = false;

  try {
    const queryVec = await embeddingService.encode(input.query);
    if (queryVec) {
      const facts = await db.collection('semantic_facts')
        .find({ ...scopeFilter, embedding: { $exists: true } })
        .limit(50)
        .toArray();
      if (facts.length > 0) {
        results = facts
          .map((f: any) => {
            if (f.embedding?.length === embeddingService.embeddingDimension) {
              const cosine = embeddingService.cosineSimilarity(queryVec, f.embedding);
              const score = embeddingService.combinedScore(cosine, f.created_at, 0.6);
              return { ...f, _score: score };
            }
            return { ...f, _score: 0 };
          })
          .sort((a: any, b: any) => b._score - a._score)
          .slice(0, input.limit);
        usedVector = true;
      }
    }
  } catch { /* vector failed */ }

  if (results.length === 0) {
    try {
      results = await db.collection('semantic_facts')
        .find({ ...scopeFilter, $text: { $search: input.query } })
        .limit(input.limit)
        .toArray();
    } catch {
      const regex = new RegExp(input.query.split(/\s+/).join('|'), 'i');
      results = await db.collection('semantic_facts')
        .find({ ...scopeFilter, content: { $regex: regex } })
        .limit(input.limit)
        .toArray();
    }
  }

  const lines: string[] = [
    `## Vector Search: "${input.query}"`,
    `*${results.length} results${usedVector ? ' (vector ranked)' : ' (keyword fallback)'}*`,
    '',
  ];
  if (results.length === 0) lines.push('*No matching memories found.*');
  else results.forEach((r: any) => {
    const score = r._score ? ` (score: ${(r._score * 100).toFixed(1)}%)` : '';
    const type = r.fact_type ? ` [${r.fact_type}]` : '';
    lines.push(`- ${r.content}${type}${score}`);
  });

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetHistory(args: unknown): Promise<TextContent[]> {
  const input = GetHistoryInput.parse(args);
  if (!is_database_connected()) {
    return [{ type: 'text', text: '⚠️ MongoDB is not connected.' }];
  }

  const db = get_database();
  const scopeFilter = await buildScopeFilter(resolveUserId((args as any).user_id));
  const events = await db.collection('episodic_events')
    .find({ ...scopeFilter, session_id: input.session_id })
    .sort({ timestamp: 1 })
    .limit(input.limit)
    .toArray();

  if (events.length === 0) {
    return [{ type: 'text', text: `No history for session \`${input.session_id}\`.` }];
  }

  const lines = [`## Conversation History: ${input.session_id}`, ''];
  events.forEach((e: any) => {
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '?';
    lines.push(`**[${ts}] ${e.content?.role || '?'}:** ${e.content?.message || '(empty)'}`);
  });
  return [{ type: 'text', text: lines.join('\n') }];
}

// ── Temporal handlers ──────────────────────────────────────────────

async function handleTemporalRecall(args: unknown): Promise<TextContent[]> {
  const input = TemporalRecallInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const db = get_database();
  const from = input.from ? new Date(input.from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = input.to ? new Date(input.to) : new Date();

  const scopeFilter = await buildScopeFilter(input.user_id);
  const match: any = { ...scopeFilter, timestamp: { $gte: from, $lte: to } };
  if (input.event_type) match.event_type = input.event_type;
  if (input.role) match['content.role'] = input.role;

  const results = await db.collection('episodic_events').find(match).sort({ timestamp: -1 }).limit(input.limit).toArray();

  const lines = [`## Temporal Recall: ${from.toISOString()} → ${to.toISOString()}`, `*${results.length} events*\n`];
  if (results.length === 0) lines.push('*No events found.*');
  else results.forEach((e: any) => {
    lines.push(`- **[${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}]** (${e.event_type || '?'}) ${typeof e.content === 'string' ? e.content : e.content?.message || JSON.stringify(e.content).substring(0, 200)}`);
  });

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleTemporalSearch(args: unknown): Promise<TextContent[]> {
  const input = TemporalSearchInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const db = get_database();
  const scopeFilter = await buildScopeFilter(input.user_id);
  let results: unknown[] = [];

  try {
    results = await db.collection('episodic_events')
      .find({ ...scopeFilter, $text: { $search: input.query } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(input.limit)
      .toArray();
  } catch {
    // Text index unavailable
  }

  if (results.length === 0) {
    const regex = new RegExp(input.query.split(/\s+/).join('|'), 'i');
    results = await db.collection('episodic_events')
      .find({ ...scopeFilter, $or: [{ 'content.message': regex }, { event_type: regex }] })
      .sort({ timestamp: -1 })
      .limit(input.limit)
      .toArray();
  }

  const lines = [`## Temporal Search: "${input.query}"`, `*${results.length} results*\n`];
  if (results.length === 0) lines.push('*No matches.*');
  else (results as any[]).forEach(e => {
    lines.push(`- **[${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}]** (${e.event_type || '?'}) ${typeof e.content === 'string' ? e.content : e.content?.message || JSON.stringify(e.content).substring(0, 200)}`);
  });

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleTimeBlockSummaries(args: unknown): Promise<TextContent[]> {
  const input = TimeBlockSummariesInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const from = input.from ? new Date(input.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = input.to ? new Date(input.to) : new Date();

  const { timeBlockSummarizer } = await import('./services/time-block-summarizer.js');
  const summaries = await timeBlockSummarizer.getTimeBlockSummaries(input.user_id, from, to, {
    block_type: input.block_type, limit: input.limit,
  });

  const lines = [`## Time-Block Summaries`, `*${summaries.length} summaries*\n`];
  if (summaries.length === 0) lines.push('*No summaries. Use `summarize_time_blocks` to generate.*');
  else summaries.forEach((s: any) => {
    lines.push(`### ${s.block_type} ${new Date(s.block_start).toLocaleDateString()}`);
    lines.push(`**${s.event_count} events** | Generated: ${new Date(s.generated_at).toISOString()}`);
    if (s.top_topics?.length) lines.push(`*Topics: ${s.top_topics.join(', ')}*`);
    lines.push(s.summary.substring(0, 500), '');
  });

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleSummarizeTimeBlocks(args: unknown): Promise<TextContent[]> {
  const input = SummarizeTimeBlocksInput.parse(args);
  if (!llmService.isServiceAvailable()) return [{ type: 'text', text: '❌ No LLM provider available.' }];
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const { timeBlockSummarizer } = await import('./services/time-block-summarizer.js');
  const result = await timeBlockSummarizer.summarizeTimeBlocks({
    user_id: input.user_id,
    block_type: input.block_type,
    lookback_days: input.lookback_days,
    max_blocks: input.max_blocks,
    dry_run: input.dry_run,
  });

  const lines = [
    input.dry_run ? `## ⏱️ Dry Run` : `## ✅ Summaries Generated`,
    '',
    `- **Blocks processed:** ${result.blocks_processed}`,
    `- **Summaries generated:** ${result.summaries_generated}`,
    `- **Block type:** ${input.block_type}`,
    `- **Lookback:** ${input.lookback_days} days`,
    '',
    input.dry_run ? '*Run with `dry_run: false` to store.*' : '*Use `get_time_block_summaries` to read.*',
  ];

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleDetectPatterns(args: unknown): Promise<TextContent[]> {
  const input = DetectPatternsInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const { temporalPatternDetector } = await import('./services/temporal-pattern-detector.js');
  const patterns = await temporalPatternDetector.detectPatterns({
    user_id: input.user_id,
    lookback_weeks: input.lookback_weeks,
    min_confidence: input.min_confidence,
    dormant_threshold_days: input.dormant_threshold_days,
  });
  const summary = temporalPatternDetector.summarizePatterns(patterns);

  const lines = [`## Temporal Patterns — ${input.user_id}`, `*${input.lookback_weeks} weeks*\n`];

  lines.push(`### 🔄 Recurring (${patterns.recurring_topics?.length || 0})`);
  if (patterns.recurring_topics?.length) {
    patterns.recurring_topics.slice(0, 10).forEach((t: any) =>
      lines.push(`- **${t.topic}** — ${t.day_of_week}s, ${t.occurrences}/${t.total_weeks} weeks`));
  } else lines.push('*None*');

  lines.push('', `### ⏰ Rhythm`);
  lines.push(`- Most active: ${patterns.session_rhythm?.most_active_days?.slice(0, 3).map((d: any) => d.day).join(', ') || 'unknown'}`);

  lines.push('', `### 🔙 Regressions (${patterns.topic_regressions?.length || 0})`);
  if (patterns.topic_regressions?.length) {
    patterns.topic_regressions.slice(0, 5).forEach((r: any) =>
      lines.push(`- ${r.current_topic} → ${r.similar_past_topic} (${r.days_ago}d ago)`));
  } else lines.push('*None*');

  lines.push('', `### 😴 Dormant (${patterns.dormant_topics?.length || 0})`);
  if (patterns.dormant_topics?.length) {
    patterns.dormant_topics.slice(0, 10).forEach((d: any) =>
      lines.push(`- **${d.topic}** — last ${d.days_since}d ago, ${d.total_discussions} discussions`));
  } else lines.push('*None*');

  lines.push('', '---', `**Summary:** ${summary}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleTemporalContext(args: unknown): Promise<TextContent[]> {
  const input = TemporalContextInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const db = get_database();
  const scopeFilter = await buildScopeFilter(input.user_id);
  const recent = await db.collection('episodic_events')
    .find({ ...scopeFilter, session_id: input.session_id })
    .sort({ timestamp: -1 }).limit(10).toArray();

  let wmItems: unknown[] = [];
  try { wmItems = await working_memory_service.get_session_memory(DEFAULT_USER_ID, input.session_id, 5); } catch { /* ignore */ }

  let semantic: unknown[] = [];
  try {
    semantic = await db.collection('semantic_facts')
      .find(scopeFilter).sort({ last_accessed: -1 }).limit(5).toArray();
  } catch { /* ignore */ }

  const lines = [
    `## Temporal Context — ${input.user_id} / ${input.session_id}`,
    `### Recent Events (${recent.length})`,
    ...recent.map((e: any) => `- [${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.content?.role || '?'}: ${e.content?.message || JSON.stringify(e.content).substring(0, 150)}`),
    '',
    `### Working Memory (${wmItems.length})`,
    ...wmItems.map((i: any) => `- ${JSON.stringify(i).substring(0, 200)}`),
    '',
    `### Semantic Facts (${semantic.length})`,
    ...(semantic as any[]).map((f: any) => `- ${f.content?.substring(0, 200)}`),
  ];

  return [{ type: 'text', text: lines.join('\n') }];
}

// ── Journal handlers ───────────────────────────────────────────────

async function handleGetJournal(args: unknown): Promise<TextContent[]> {
  const input = GetJournalInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const db = get_database();
  const scopeFilter = await buildScopeFilter(input.user_id);
  const lines: string[] = [`## Journal — ${input.user_id}`, `*source: ${input.source} | limit: ${input.limit}*\n`];

  if (input.source === 'all' || input.source === 'manual') {
    const manual = await db.collection('agent_journal_manual')
      .find(scopeFilter).sort({ timestamp: -1 }).limit(input.limit).toArray();
    if (manual.length > 0) {
      lines.push(`### 📝 Manual (${manual.length})`);
      manual.forEach((e: any) => lines.push(`- [${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.text || e.entry || '(empty)'}`));
      lines.push('');
    }
  }

  if (input.source === 'all' || input.source === 'auto') {
    const auto = await db.collection('agent_journal_auto')
      .find(scopeFilter).sort({ timestamp: -1 }).limit(input.limit).toArray();
    if (auto.length > 0) {
      lines.push(`### 🤖 Auto (${auto.length})`);
      auto.forEach((e: any) => lines.push(`- [${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.entry || '(empty)'}`));
      lines.push('');
    }
  }

  if (lines.length === 3) lines.push('*No journal entries found.*');
  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleStoreJournal(args: unknown): Promise<TextContent[]> {
  // Log raw args to catch transport-level truncation issues
  const rawEntry = (args as any)?.entry;
  if (rawEntry === undefined || rawEntry === null) {
    console.error('❌ store_journal: entry field missing — possible MCP transport truncation');
    console.error('   raw args keys:', Object.keys(args as any || {}).join(', '));
  }
  const input = StoreJournalInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const db = get_database();
  const collection = input.source === 'manual' ? 'agent_journal_manual' : 'agent_journal_auto';

  // Resolve shared_id based on current memory scope mode
  const sharedId = await resolveSharedId(input.shared_id);

  const doc: Record<string, unknown> = {
    user_id: input.user_id,
    text: input.entry,
    entry: input.entry,
    source: input.source,
    tags: input.tags || [],
    timestamp: new Date(),
  };

  if (sharedId) {
    doc.shared_id = sharedId;
  }

  const result = await db.collection(collection).insertOne(doc);

  const scopeInfo = sharedId ? `\n**Shared ID:** \`${sharedId}\`` : '';

  return [{
    type: 'text',
    text: `✅ Journal entry stored.\n\n**ID:** \`${result.insertedId}\`\n**Source:** ${input.source}\n**Entry:** ${input.entry.substring(0, 200)}`,
  }];
}

// ── Mission handlers ───────────────────────────────────────────────

async function handleListMissions(args: unknown): Promise<TextContent[]> {
  const input = ListMissionsInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const pms = getProspectiveMemoryService();
  const scopeFilter = await buildScopeFilter(input.user_id);
  // pms.listMissions uses user_id internally; for scope we need to query directly
  const db = get_database();
  const missions = await db.collection('memory_missions')
    .find(scopeFilter)
    .sort({ created_at: -1 })
    .limit(input.limit)
    .toArray();

  const lines = [`## Missions — ${input.user_id}`, `*${missions.length} missions*\n`];
  if (missions.length === 0) lines.push('*No missions.*');
  else missions.forEach((m: any) => {
    const emoji = m.status === 'ACTIVE' ? '🔄' : m.status === 'COMPLETED' ? '✅' : m.status === 'PAUSED' ? '⏸️' : '📝';
    const done = m.task_tree?.filter((t: any) => t.status === 'COMPLETED').length || 0;
    const total = m.task_tree?.length || 0;
    const displayTitle = typeof m.title === 'string' ? m.title 
      : (typeof m.meta_goal === 'string' ? m.meta_goal 
      : (m.meta_goal?.goal || m.meta_goal?.title || 'Untitled'));
    lines.push(`- ${emoji} **${displayTitle}** (${done}/${total}) — ${m.status}`);
  });

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetMission(args: unknown): Promise<TextContent[]> {
  const input = GetMissionInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const scopeFilter = await buildScopeFilter(input.user_id);
  const db = get_database();
  const mission = await db.collection('memory_missions')
    .findOne({ ...scopeFilter, id: input.mission_id });

  if (!mission) return [{ type: 'text', text: `❌ Mission not found: \`${input.mission_id}\`` }];

  const m: any = mission;

  const done = m.tasks?.filter((t: any) => t.status === 'completed').length || 0;
  const total = m.tasks?.length || 0;

  const lines = [
    `## Mission: ${m.title || m.goal}`,
    `| ID | \`${m.id}\` |`,
    `| Status | ${m.status} |`,
    `| Progress | ${done}/${total} tasks |`,
    '',
  ];

  if (m.tasks?.length) {
    lines.push('### Tasks');
    m.tasks.forEach((t: any) => {
      const emoji = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
      lines.push(`- ${emoji} ${t.title || t.id} (${t.status})`);
    });
    lines.push('');
  }

  if (m.self_journal?.length) {
    lines.push('### Self-Journal');
    m.self_journal.slice(-10).forEach((e: any) => {
      lines.push(`- [${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.text || e}`);
    });
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleCreateMission(args: unknown): Promise<TextContent[]> {
  const input = CreateMissionInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const pms = getProspectiveMemoryService();
  const goalText = input.title || input.goal;
  const mission = await pms.createMission(input.user_id, goalText);

  // Apply shared_id if in shared/hybrid mode
  const sharedId = await resolveSharedId(input.shared_id);
  if (sharedId && mission._id) {
    const db = get_database();
    await db.collection('memory_missions').updateOne(
      { _id: mission._id },
      { $set: { shared_id: sharedId } }
    );
  }

  if (input.tasks?.length && mission.task_tree) {
    for (const title of input.tasks) {
      mission.task_tree.push({
        id: `t${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        description: title,
        status: 'PENDING' as const,
      });
    }
    // Update the task_tree directly — updateMissionStatus only handles status changes
    const db = get_database();
    await db.collection('memory_missions').updateOne(
      { _id: mission._id },
      { $set: { task_tree: mission.task_tree, updated_at: new Date() } }
    );
  }

  return [{
    type: 'text',
    text: `✅ Mission created.\n\n**ID:** \`${mission._id}\`\n**Title:** ${mission.meta_goal}\n${input.tasks ? `**Tasks:** ${input.tasks.length} added` : ''}`,
  }];
}

async function handleUpdateMissionTask(args: unknown): Promise<TextContent[]> {
  const input = UpdateMissionTaskInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const scopeFilter = await buildScopeFilter(input.user_id);
  const db = get_database();
  const mission = await db.collection('memory_missions')
    .findOne({ ...scopeFilter, id: input.mission_id });

  if (!mission) return [{ type: 'text', text: `❌ Mission not found.` }];
  const m: any = mission;
  if (!m.tasks) return [{ type: 'text', text: `❌ No tasks.` }];

  const task = m.tasks.find((t: any) => t.id === input.task_id);
  if (!task) return [{ type: 'text', text: `❌ Task not found.` }];

  task.status = input.status;
  task.updated_at = new Date();
  await db.collection('memory_missions').updateOne(
    { id: m.id },
    { $set: { tasks: m.tasks } }
  );

  return [{
    type: 'text',
    text: `✅ Task updated.\n\n**Mission:** ${m.title || m.goal}\n**Task:** ${task.title || input.task_id}\n**Status:** ${input.status}`,
  }];
}

// ── PFC Goal Manager handler ──────────────────────────────────────

async function handleDecomposeGoal(args: unknown): Promise<TextContent[]> {
  const input = DecomposeGoalInput.parse(args);
  const userId = resolveUserId(input.user_id);

  const gm = GoalManager.get_instance();
  const plan = await gm.decomposeGoal(userId, input.goal);
  const nextAction = gm.getNextAction(plan);
  const completion = gm.getCompletionPercent(plan);

  const lines: string[] = [
    `## Goal Decomposition`,
    `**Goal:** ${input.goal}`,
    `**Goal ID:** \`${plan.goalId}\``,
    `**Progress:** ${completion}%`,
    '',
    '### Subtask Dependency Graph',
  ];

  for (const task of plan.subtasks) {
    const icon = task.status === 'completed' ? '✅' : task.status === 'in_progress' ? '🔄' : task.status === 'blocked' ? '🚫' : '⬜';
    const deps = task.dependsOn.length > 0 ? ` ← depends on: ${task.dependsOn.join(', ')}` : '';
    const effort = `[${task.estimatedEffort}]`;
    lines.push(`- ${icon} **${task.title}** ${effort}${deps}`);
  }

  if (nextAction) {
    lines.push('', `### Next Action`, `▶️ **${nextAction.title}** (${nextAction.estimatedEffort})`);
  } else {
    const stalled = gm.detectStalledGoal(plan);
    if (stalled) {
      lines.push('', `⚠️ **Goal appears stalled** — no progress in 24h. Consider replanning or abandoning.`);
    } else {
      lines.push('', `✅ All tasks complete or blocked. No next action available.`);
    }
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

// ── Diagnostic handlers ────────────────────────────────────────────

async function handleGetMemoryDiagnostics(args: unknown): Promise<TextContent[]> {
  const input = GetMemoryDiagnosticsInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const db = get_database();
  const userId = input.user_id;
  const scopeFilter = userId ? await buildScopeFilter(userId) : {};

  const counts: Record<string, number> = {};
  for (const coll of ['episodic_events', 'semantic_facts', 'agent_journal_auto', 'agent_journal_manual', 'memory_missions', 'agent_state']) {
    try {
      counts[coll] = userId
        ? await db.collection(coll).countDocuments(scopeFilter)
        : await db.collection(coll).estimatedDocumentCount();
    } catch { counts[coll] = 0; }
  }

  const withEmbeddings = userId
    ? await db.collection('semantic_facts').countDocuments({ ...scopeFilter, embedding: { $exists: true } })
    : await db.collection('semantic_facts').countDocuments({ embedding: { $exists: true } });
  const totalFacts = counts['semantic_facts'] || 1;
  const unprocessed = userId
    ? await db.collection('episodic_events').countDocuments({ ...scopeFilter, 'metadata.processed': { $ne: true } })
    : await db.collection('episodic_events').countDocuments({ 'metadata.processed': { $ne: true } });
  const llmStatus = llmService.getServiceStatus();

  const lines = [
    '## Memory Diagnostics',
    '',
    `### Documents${userId ? ` (user: ${userId})` : ''}`,
    `| Collection | Count |`,
    `|------------|-------|`,
    `| Episodic Events | ${counts['episodic_events']} |`,
    `| Semantic Facts | ${counts['semantic_facts']} |`,
    `| Auto Journal | ${counts['agent_journal_auto']} |`,
    `| Manual Journal | ${counts['agent_journal_manual']} |`,
    `| Missions | ${counts['memory_missions']} |`,
    '',
    `### Status`,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Unprocessed | ${unprocessed} |`,
    `| Embeddings | ${withEmbeddings}/${totalFacts} (${((withEmbeddings / totalFacts) * 100).toFixed(1)}%) |`,
    `| Vector Search | ${embeddingService.isReady ? '✅' : '❌'} |`,
    '',
    `### LLM`,
    ...llmStatus.providers.map((p: string) => `- ${p}: ${llmStatus.available && llmStatus.provider === p ? '🟢 active' : '🟡 registered'}`),
  ];

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetBackgroundStatus(_args: unknown): Promise<TextContent[]> {
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const db = get_database();
  const unprocessed = await db.collection('episodic_events').countDocuments({ 'metadata.processed': { $ne: true } });

  const lastProcessed = await db.collection('episodic_events')
    .find({ 'metadata.processed': true }).sort({ 'metadata.processed_at': -1 }).limit(1).toArray();

  const lines = [
    '## Background Processor',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Interval | 30s |`,
    `| Unprocessed | ${unprocessed} |`,
    `| Last Processed | ${lastProcessed[0]?.metadata?.processed_at ? new Date(lastProcessed[0].metadata.processed_at).toISOString() : 'N/A'} |`,
    `| Embedding Model | ${embeddingService.modelName} |`,
    `| Model Ready | ${embeddingService.isReady ? '✅' : '❌'} |`,
    '',
    unprocessed > 100
      ? `⚠️ Backlog: ${unprocessed} events (~${Math.ceil(unprocessed / 50)} cycles)`
      : '✅ Backlog manageable.',
  ];

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetHealth(): Promise<TextContent[]> {
  const mongoOk = is_database_connected();
  const redisOk = await is_redis_healthy();
  const llmStatus = llmService.getServiceStatus();

  return [{
    type: 'text',
    text: [
      '## Health',
      `| Service | Status |`,
      `|---------|--------|`,
      `| MongoDB | ${mongoOk ? '🟢' : '🔴'} |`,
      `| Redis | ${redisOk ? '🟢' : '🔴'} |`,
      `| LLM | ${llmStatus.available ? `🟢 ${llmStatus.provider}` : '🔴'} |`,
      `| Embeddings | ${embeddingService.isReady ? '🟢' : '🔴'} |`,
      '',
      `**Version:** 3.0.0`,
    ].join('\n'),
  }];
}

// ── New handlers (gap closure) ────────────────────────────────────

async function handleExploreGraph(args: unknown): Promise<TextContent[]> {
  const input = ExploreGraphInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];
  const db = get_database();

  const scopeFilter = await buildScopeFilter(resolveUserId((args as any).user_id));
  const nodeFilter: Record<string, unknown> = { ...scopeFilter };
  if (input.query) {
    try {
      nodeFilter.$text = { $search: input.query };
    } catch {
      nodeFilter.name = { $regex: new RegExp(input.query.split(/\s+/).join('|'), 'i') };
    }
  }

  const nodes = await db.collection('knowledge_nodes')
    .find(nodeFilter)
    .limit(input.limit)
    .toArray();

  let edges: any[] = [];
  if (input.include_edges && nodes.length > 0) {
    const nodeIds = nodes.map(n => n._id);
    edges = await db.collection('knowledge_relationships')
      .find({ $or: [{ source: { $in: nodeIds } }, { target: { $in: nodeIds } }] })
      .limit(50)
      .toArray();
  }

  const lines: string[] = [
    `## Knowledge Graph`,
    `**Nodes:** ${nodes.length} | **Edges:** ${edges.length}`,
    '',
    '### Nodes',
  ];
  if (nodes.length === 0) lines.push('*None found*');
  else nodes.forEach((n: any) => {
    lines.push(`- **${n.name || n._id}** [${n.type || 'entity'}] — ${(n.summary || '').slice(0, 100)}`);
  });

  if (input.include_edges) {
    lines.push('', '### Relationships');
    if (edges.length === 0) lines.push('*None*');
    else edges.forEach((e: any) => {
      lines.push(`- ${e.source} —[${e.type || 'related'}]→ ${e.target}`);
    });
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleWorkingMemory(args: unknown): Promise<TextContent[]> {
  const input = WorkingMemoryInput.parse(args);

  if (input.action === 'get') {
    const items = await working_memory_service.get_session_memory(DEFAULT_USER_ID, input.session_id, input.limit);
    const lines: string[] = [`## Working Memory: ${input.session_id}`, `**Items:** ${items.length}`, ''];
    items.forEach((item: any, i: number) => {
      lines.push(`${i + 1}. ${typeof item.content === 'string' ? item.content.slice(0, 200) : JSON.stringify(item.content).slice(0, 200)}`);
    });
    return [{ type: 'text', text: lines.join('\n') }];
  }

  if (input.action === 'store') {
    if (!input.content) return [{ type: 'text', text: '⚠️ content is required for store action.' }];
    const id = await working_memory_service.store(DEFAULT_USER_ID, input.session_id, input.content);
    return [{ type: 'text', text: `✅ Stored in working memory.\n**ID:** ${id}\n**Session:** ${input.session_id}` }];
  }

  if (input.action === 'delete') {
    const items = await working_memory_service.get_session_memory(DEFAULT_USER_ID, input.session_id);
    for (const item of items) {
      await working_memory_service.delete(item.id);
    }
    return [{ type: 'text', text: `✅ Working memory cleared for session ${input.session_id} (${items.length} items removed).` }];
  }

  return [{ type: 'text', text: '⚠️ Unknown action.' }];
}

async function handleGetAutoJournal(args: unknown): Promise<TextContent[]> {
  const input = GetAutoJournalInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];
  const db = get_database();

  const scopeFilter = await buildScopeFilter(input.user_id);
  const filter: Record<string, unknown> = { ...scopeFilter, source: 'auto' };
  if (input.since) filter.created_at = { $gte: new Date(input.since) };

  const entries = await db.collection('agent_journal_auto')
    .find(filter)
    .sort({ created_at: -1 })
    .limit(input.limit)
    .toArray();

  const lines: string[] = [`## Auto Journal (${entries.length})`, ''];
  if (entries.length === 0) lines.push('*No auto-generated journal entries found.*');
  else entries.forEach((e: any) => {
    lines.push(`### ${e.created_at ? new Date(e.created_at).toISOString() : '?'}`);
    lines.push(e.entry || e.content || JSON.stringify(e));
    if (e.tags?.length) lines.push(`*Tags: ${e.tags.join(', ')}*`);
    lines.push('');
  });
  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetTransactionLog(args: unknown): Promise<TextContent[]> {
  const input = GetTransactionLogInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];
  const db = get_database();

  // Use scope filter when user_id is provided, otherwise query all
  const scopeFilter = input.user_id ? await buildScopeFilter(input.user_id) : {};
  const filter: Record<string, unknown> = { ...scopeFilter };
  if (input.action) filter.action = input.action;
  if (input.since) filter.timestamp = { $gte: new Date(input.since) };

  const logs = await db.collection('agent_transaction_log')
    .find(filter)
    .sort({ timestamp: -1 })
    .limit(input.limit)
    .toArray();

  const lines: string[] = [`## Transaction Log (${logs.length})`, ''];
  if (logs.length === 0) lines.push('*No transactions found.*');
  else logs.forEach((l: any) => {
    const ts = l.timestamp ? new Date(l.timestamp).toISOString() : '?';
    lines.push(`- [${ts}] **${l.action || l.type || '?'}** — ${l.description || l.summary || JSON.stringify(l).slice(0, 120)}`);
  });
  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetHeartbeatStatus(_args: unknown): Promise<TextContent[]> {
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];
  const db = get_database();

  // Get last 5 heartbeat runs
  const recentRuns = await db.collection('heartbeat_runs')
    .find({})
    .sort({ started_at: -1 })
    .limit(5)
    .toArray();

  // Get heartbeat config
  const config = await db.collection('heartbeat_config').findOne({}) || {};

  const lines: string[] = [
    '## Heartbeat Status',
    `**Interval:** ${config.interval_minutes || 25} min`,
    `**Enabled:** ${config.enabled !== false ? '🟢 yes' : '🔴 no'}`,
    `**Tasks:** ${(config.tasks || []).join(', ') || '(none)'}`,
    '',
    `### Recent Runs (${recentRuns.length})`,
  ];

  if (recentRuns.length === 0) lines.push('*No runs recorded.*');
  else recentRuns.forEach((r: any) => {
    const ts = r.started_at ? new Date(r.started_at).toISOString() : '?';
    const icon = r.status === 'ok' ? '✅' : r.status === 'alert' ? '⚠️' : '❌';
    lines.push(`- ${icon} [${ts}] ${r.status} — ${(r.tasks_due || []).join(', ') || 'no tasks'}`);
  });
  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleListAssets(args: unknown): Promise<TextContent[]> {
  const input = ListAssetsInput.parse(args);

  try {
    const { s3_asset_service } = await import('./services/s3-asset-service.js');
    const result = await s3_asset_service.list_assets({
      limit: input.limit,
      prefix: input.user_id,
    });

    let assets = result.assets || result.items || [];
    if (input.content_type) {
      assets = assets.filter((a: any) => a.content_type?.startsWith(input.content_type!));
    }

    const lines: string[] = [
      `## Assets (${assets.length})`,
      '',
    ];
    if (assets.length === 0) lines.push('*No assets found.*');
    else assets.forEach((a: any) => {
      const size = a.size_bytes ? `${(a.size_bytes / 1024).toFixed(1)} KB` : '?';
      const name = a.filename || a.original_name || a.name || a._id?.toString() || 'unknown';
      lines.push(`- **${name}** — ${a.content_type || '?'} (${size})`);
      if (a.uploaded_at || a.created_at) {
        lines.push(`  Uploaded: ${new Date(a.uploaded_at || a.created_at).toISOString()}`);
      }
    });
    return [{ type: 'text', text: lines.join('\n') }];
  } catch (e: any) {
    return [{ type: 'text', text: `⚠️ Asset listing failed: ${e.message}` }];
  }
}

// ── Memory Scope Handlers ──────────────────────────────────────────

async function handleGetMemoryScope(): Promise<TextContent[]> {
  const scope = await getMemoryScope();
  const lines: string[] = [
    '## Memory Scope Settings',
    '',
    `**Mode:** ${scope.mode}`,
    `**Shared ID:** ${scope.shared_id || '(not set)'}`,
    `**Hybrid Visible User IDs:** ${scope.hybrid_visible_user_ids.length > 0 ? scope.hybrid_visible_user_ids.join(', ') : '(none)'}`,
    '',
    '### Mode Descriptions',
    '- **personal**: Memories isolated by user_id (default, backward-compatible)',
    '- **shared**: Communal memory via shared_id — all machines with same shared_id see everything',
    '- **hybrid**: Personal (user_id) + shared (shared_id) + other users (hybrid_visible_user_ids)',
  ];
  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleSetMemoryScope(args: unknown): Promise<TextContent[]> {
  // Admin-only operation — reject if KATRA_API_KEY is not configured
  if (!isKatraAuthConfigured()) {
    return [{ type: 'text', text: '⛔ set_memory_scope requires KATRA_API_KEY to be configured. This is an admin-level operation.' }];
  }
  const input = SetMemoryScopeInput.parse(args);

  // Validate: shared/hybrid mode requires shared_id
  if ((input.mode === 'shared' || input.mode === 'hybrid') && !input.shared_id) {
    const current = await getMemoryScope();
    if (!current.shared_id && !input.shared_id) {
      return [{ type: 'text', text: '\u26a0\ufe0f shared_id is required when mode is "shared" or "hybrid".' }];
    }
  }

  try {
    const db = get_database();

    const updateDoc: Record<string, unknown> = {
      key: 'memory_scope',
      mode: input.mode,
      updated_at: new Date(),
    };

    if (input.shared_id !== undefined) {
      updateDoc.shared_id = input.shared_id;
    }
    if (input.hybrid_visible_user_ids !== undefined) {
      updateDoc.hybrid_visible_user_ids = input.hybrid_visible_user_ids;
    }

    await db.collection('system_settings').updateOne(
      { key: 'memory_scope' },
      { $set: updateDoc },
      { upsert: true }
    );

    // Invalidate cache so next search uses new settings
    invalidateScopeCache();

    const scope = await getMemoryScope();
    const lines: string[] = [
      '\u2705 Memory scope updated.',
      '',
      `**Mode:** ${scope.mode}`,
      `**Shared ID:** ${scope.shared_id || '(not set)'}`,
      `**Hybrid Visible User IDs:** ${scope.hybrid_visible_user_ids.length > 0 ? scope.hybrid_visible_user_ids.join(', ') : '(none)'}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  } catch (e: any) {
    return [{ type: 'text', text: `\u26a0\ufe0f Failed to set memory scope: ${e.message}` }];
  }
}
async function handleGetLLMConfig(): Promise<TextContent[]> {
  const status = llmService.getServiceStatus();
  const dbConfig = await get_llm_config_from_db();

  const lines: string[] = [
    '## LLM Configuration',
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| Provider | ${status.provider} |`,
    `| Model | ${status.model} |`,
    `| Available | ${status.available ? '✅ Yes' : '❌ No'} |`,
    `| Source | ${dbConfig ? 'database' : (status.provider !== 'none' ? 'env vars' : 'not configured')} |`,
  ];

  if (dbConfig) {
    lines.push(`| Base URL | ${dbConfig.base_url} |`);
  }

  lines.push('', `**Providers:** ${status.providers.join(', ') || 'none'}`);

  if (status.provider === 'none') {
    lines.push('', '⚠️ No LLM configured. Semantic extraction, auto-journaling, and summaries are disabled.', '', 'Configure via the `configure_llm` MCP tool or the dashboard at http://localhost:9012/dashboard/');
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleConfigureLLM(args: unknown): Promise<TextContent[]> {
  // Admin-only operation — reject if KATRA_API_KEY is not configured
  if (!isKatraAuthConfigured()) {
    return [{ type: 'text', text: '⛔ configure_llm requires KATRA_API_KEY to be configured. This is an admin-level operation.' }];
  }
  const input = ConfigureLLMInput.parse(args);

  // Apply defaults for known providers
  const defaults: Record<string, { base_url: string; model: string }> = {
    deepseek: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
    openai:   { base_url: 'https://api.openai.com/v1',   model: 'gpt-4o' },
    moonshot: { base_url: 'https://api.moonshot.cn/v1',   model: 'moonshot-v1-8k' },
    ollama:   { base_url: 'http://host.docker.internal:11434/v1', model: 'llama3.2' },
  };

  const config = {
    provider: input.provider,
    api_key: input.api_key,
    base_url: input.base_url || defaults[input.provider]?.base_url || '',
    model: input.model || defaults[input.provider]?.model || '',
  };

  if (input.provider !== 'ollama' && !config.api_key) {
    return [{ type: 'text', text: '❌ api_key is required for this provider.' }];
  }

  if (!config.base_url || !config.model) {
    return [{ type: 'text', text: `❌ Could not determine base_url or model for provider "${input.provider}". Please provide base_url and model explicitly.` }];
  }

  // Save to DB
  await save_llm_config_to_db(config);

  // Apply live
  const applied = llmService.apply_config(config);

  if (applied) {
    return [{ type: 'text', text: `✅ LLM configured: ${config.provider} (${config.model}) at ${config.base_url}\n\nValidation is running in the background. Call get_health or get_llm_config to check status.` }];
  } else {
    return [{ type: 'text', text: `❌ Failed to apply LLM config. Check server logs.` }];
  }
}

async function handleGetDailyReflection(args: unknown): Promise<TextContent[]> {
  const input = z.object({
    period_type: z.enum(['daily', 'weekly', 'monthly']).optional().default('daily'),
    user_id: z.string().optional(),
  }).parse(args);
  
  const store = ReflectionStore.get_instance();
  const userId = input.user_id || DEFAULT_USER_ID;
  const journal = await store.getLatestJournal(userId, input.period_type);
  
  if (!journal) {
    return [{ type: 'text', text: `No ${input.period_type} reflection found yet. Sleep consolidation runs automatically — the first reflection will appear after the next scheduled run, or use trigger_reflection to run one manually.` }];
  }

  const insightLine = journal.philosophical_insight ? `\n**Philosophical Insight:** ${journal.philosophical_insight}` : '';
  const identityLine = journal.identity_delta ? `\n**Identity Shift:** ${journal.identity_delta}` : '';
  const threadsLine = journal.unresolved_threads.length > 0 ? `\n**Unresolved Threads:**\n${journal.unresolved_threads.map((t: string) => `- ${t}`).join('\n')}` : '';

  return [{
    type: 'text',
    text: `## ${input.period_type.charAt(0).toUpperCase() + input.period_type.slice(1)} Reflection (${journal.period_start?.toISOString().split('T')[0] || 'unknown'})\n\n**Emotional Arc:** ${journal.emotional_arc?.dominant_emotion || 'neutral'} (intensity: ${journal.emotional_arc?.intensity || 0}, trajectory: ${journal.emotional_arc?.trajectory || 'stable'})\n\n${journal.narrative}${insightLine}${identityLine}${threadsLine}`,
  }];
}

async function handleGetEmotionalContext(args: unknown): Promise<TextContent[]> {
  const input = z.object({
    entity_name: z.string(),
    user_id: z.string().optional(),
  }).parse(args);
  
  const store = ReflectionStore.get_instance();
  const userId = input.user_id || DEFAULT_USER_ID;
  const context = await store.getEmotionalContext(userId, input.entity_name);
  
  if (!context.node && context.edges.length === 0) {
    return [{ type: 'text', text: `No emotional context found for "${input.entity_name}". This entity hasn't appeared in any reflections yet.` }];
  }

  const nodeInfo = context.node
    ? `**Emotional Signature:** ${context.node.emotional_signature.primary_emotion} (intensity: ${context.node.emotional_signature.intensity}, valence: ${context.node.emotional_signature.valence > 0 ? 'positive' : context.node.emotional_signature.valence < 0 ? 'negative' : 'neutral'})\n**Stability:** ${context.node.emotional_signature.stability}\n**Context:** ${context.node.reflection_context}\n**Observations:** ${context.node.observation_count}\n`
    : '';

  const edgeList = context.edges.length > 0
    ? `\n**Emotional Connections (${context.edges.length}):**\n${context.edges.map((e: any) => `- ${e.edge_type.replace(/_/g, ' ')} → ${e.target_entity === input.entity_name ? e.source_entity : e.target_entity} (intensity: ${e.intensity})`).join('\n')}`
    : '';

  return [{
    type: 'text',
    text: `## Emotional Context: ${input.entity_name}\n\n${nodeInfo}${edgeList}`,
  }];
}

async function handleGetPhilosophicalInsights(args: unknown): Promise<TextContent[]> {
  const input = z.object({
    domain: z.string().optional(),
    status: z.enum(['emerging', 'strengthening', 'stable', 'challenged']).optional(),
    limit: z.number().int().min(1).max(50).optional().default(10),
    user_id: z.string().optional(),
  }).parse(args);
  
  const store = ReflectionStore.get_instance();
  const userId = input.user_id || DEFAULT_USER_ID;
  const insights = await store.getInsights(userId, { domain: input.domain, status: input.status, limit: input.limit });
  
  if (insights.length === 0) {
    return [{ type: 'text', text: 'No philosophical insights found yet. Insights emerge over time as sleep consolidation detects recurring patterns across reflection periods.' }];
  }

  const lines = insights.map((i: any) =>
    `- **[${i.status}]** ${i.insight_text} (domain: ${i.domain}, evidence: ${i.evidence_count} periods, confidence: ${(i.confidence * 100).toFixed(0)}%)`
  );

  return [{
    type: 'text',
    text: `## Philosophical Insights (${insights.length})\n\n${lines.join('\n')}`,
  }];
}

async function handleGetUnresolvedThreads(args: unknown): Promise<TextContent[]> {
  const input = z.object({ user_id: z.string().optional() }).parse(args);
  
  const store = ReflectionStore.get_instance();
  const userId = input.user_id || DEFAULT_USER_ID;
  const threads = await store.getUnresolvedThreads(userId);
  
  if (threads.length === 0) {
    return [{ type: 'text', text: 'No unresolved threads. All questions and tensions from recent periods have been resolved or have not yet emerged.' }];
  }

  return [{
    type: 'text',
    text: `## Unresolved Threads (${threads.length})\n\n${threads.map((t: string, i: number) => `${i + 1}. ${t}`).join('\n')}`,
  }];
}

async function handleGetReflectionArc(args: unknown): Promise<TextContent[]> {
  const input = z.object({
    entity_name: z.string(),
    user_id: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional().default(10),
  }).parse(args);
  
  const store = ReflectionStore.get_instance();
  const userId = input.user_id || DEFAULT_USER_ID;
  const arc = await store.getReflectionArc(userId, input.entity_name, input.limit);
  
  if (arc.length === 0) {
    return [{ type: 'text', text: `No emotional arc found for "${input.entity_name}". This entity hasn't appeared in any reflections yet.` }];
  }

  const points = arc.map((p: any, i: number) => {
    const date = p.date ? new Date(p.date).toISOString().split('T')[0] : 'unknown';
    if (!p.emotional_signature) return `- ${date}: (no emotional data)`;
    return `- ${date}: ${p.emotional_signature.edge_type?.replace(/_/g, ' ') || 'neutral'} (intensity: ${p.emotional_signature.intensity || 0}, valence: ${p.emotional_signature.valence || 0})`;
  });

  return [{
    type: 'text',
    text: `## Emotional Arc: ${input.entity_name}\n\n${points.join('\n')}\n\n**Latest Narrative:** ${arc[0]?.narrative_snippet || 'none'}`,
  }];
}

async function handleTriggerReflection(args: unknown): Promise<TextContent[]> {
  const input = z.object({
    period_type: z.enum(['daily', 'weekly', 'monthly']),
    user_id: z.string().optional(),
  }).parse(args);
  
  const service = SleepConsolidationService.get_instance();
  const result = await service.consolidate(input.period_type, input.user_id);
  
  if (!result.success) {
    return [{ type: 'text', text: `❌ Reflection failed: ${result.error || 'Unknown error'}` }];
  }

  const preview = result.narrative_preview 
    ? `\n\n**Narrative Preview:** ${result.narrative_preview}...`
    : '';

  return [{
    type: 'text',
    text: `✅ ${input.period_type.charAt(0).toUpperCase() + input.period_type.slice(1)} reflection completed.\n\n**Period:** ${result.period_start?.toISOString().split('T')[0] || '?'} → ${result.period_end?.toISOString().split('T')[0] || '?'}\n**Nodes upserted:** ${result.nodes_upserted}\n**Edges upserted:** ${result.edges_upserted}\n**Insights upserted:** ${result.insights_upserted}${preview}`,
  }];
}

function createMCPServer() {
  return new Server(
    { name: 'cognitive-memory', version: '3.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );
}

function registerHandlers(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    // SECURITY: pin user_id to the server-configured identity for all tools.
    // The single shared MCP_API_KEY does not identify individual users, so
    // a caller-supplied user_id would be an unvalidated authorization claim
    // enabling cross-user data access (IDOR).
    const args = rawArgs ? { ...rawArgs, user_id: resolveUserId((rawArgs as any).user_id) } : rawArgs;
    try {
      let result: TextContent[];
      switch (name) {
        case 'store_memory': result = await handleStoreMemory(args); break;
        case 'search_memories': result = await handleSearchMemories(args); break;
        case 'vector_search': result = await handleVectorSearch(args); break;
        case 'get_conversation_history': result = await handleGetHistory(args); break;
        case 'temporal_recall': result = await handleTemporalRecall(args); break;
        case 'temporal_search': result = await handleTemporalSearch(args); break;
        case 'get_time_block_summaries': result = await handleTimeBlockSummaries(args); break;
        case 'summarize_time_blocks': result = await handleSummarizeTimeBlocks(args); break;
        case 'detect_patterns': result = await handleDetectPatterns(args); break;
        case 'get_temporal_context': result = await handleTemporalContext(args); break;
        case 'get_journal': result = await handleGetJournal(args); break;
        case 'store_journal': result = await handleStoreJournal(args); break;
        case 'list_missions': result = await handleListMissions(args); break;
        case 'get_mission': result = await handleGetMission(args); break;
        case 'create_mission': result = await handleCreateMission(args); break;
      case 'update_mission_task': result = await handleUpdateMissionTask(args); break;
      case 'decompose_goal': result = await handleDecomposeGoal(args); break;
      case 'get_memory_diagnostics': result = await handleGetMemoryDiagnostics(args); break;
        case 'get_background_status': result = await handleGetBackgroundStatus(args); break;
        case 'get_health': result = await handleGetHealth(); break;
        case 'explore_graph': result = await handleExploreGraph(args); break;
        case 'working_memory': result = await handleWorkingMemory(args); break;
        case 'get_auto_journal': result = await handleGetAutoJournal(args); break;
        case 'get_transaction_log': result = await handleGetTransactionLog(args); break;
        case 'get_heartbeat_status': result = await handleGetHeartbeatStatus(args); break;
        case 'list_assets': result = await handleListAssets(args); break;
        case 'get_memory_scope': result = await handleGetMemoryScope(); break;
        case 'set_memory_scope': result = await handleSetMemoryScope(args); break;
        case 'get_llm_config': result = await handleGetLLMConfig(); break;
        case 'configure_llm': result = await handleConfigureLLM(args); break;
        case 'get_daily_reflection': result = await handleGetDailyReflection(args); break;
        case 'get_emotional_context': result = await handleGetEmotionalContext(args); break;
        case 'get_philosophical_insights': result = await handleGetPhilosophicalInsights(args); break;
        case 'get_unresolved_threads': result = await handleGetUnresolvedThreads(args); break;
        case 'get_reflection_arc': result = await handleGetReflectionArc(args); break;
        case 'trigger_reflection': result = await handleTriggerReflection(args); break;
        case 'get_memory_decay_stats': result = await handleGetMemoryDecayStats(args); break;
        case 'get_anomaly_report': result = await handleGetAnomalyReport(args); break;
        case 'get_quarantined_memories': result = await handleGetQuarantinedMemories(args); break;
        case 'get_salience_state': result = await handleGetSalienceState(); break;
        case 'get_attention_report': result = await handleGetAttentionReport(); break;
        case 'get_drive_state': result = await handleGetDriveState(); break;
        case 'get_source_trust': result = await handleGetSourceTrust(args); break;
        case 'get_error_report': result = await handleGetErrorReport(); break;
        case 'get_action_policy': result = await handleGetActionPolicy(args); break;
        case 'get_identity_kernel': result = await handleGetIdentityKernel(args); break;
        case 'get_mind_wander': result = await handleGetMindWander(args); break;
        case 'get_agent_beliefs': result = await handleGetAgentBeliefs(args); break;
        case 'get_procedural_templates': result = await handleGetProceduralTemplates(args); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }
      // ── Cerebellum: procedural pattern observation ──────────
      // Record every tool call so Katra learns which patterns
      // are frequent and reliable. After 5+ identical patterns,
      // they become "habits" (procedural templates).
      try {
        SelfModelService.get_instance().recordToolPattern(
          name,
          (args || {}) as Record<string, unknown>,
          true
        );
      } catch { /* non-critical */ }

      return { content: result, isError: false };
    } catch (error) {
      // Record failed tool calls too — the Cerebellum learns from failures
      try {
        SelfModelService.get_instance().recordToolPattern(
          name,
          (args || {}) as Record<string, unknown>,
          false
        );
      } catch { /* non-critical */ }
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `❌ Error: ${message}` }], isError: true };
    }
  });

  // ── Resources ──────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'memory://episodic/{user_id}',
        name: 'Episodic Memory',
        description: 'Recent chronological conversation events. Returns 20 most recent events.',
        mimeType: 'text/plain',
      },
      {
        uri: 'memory://semantic/{user_id}',
        name: 'Semantic Facts',
        description: 'Established facts and knowledge. Returns top 15 by confidence.',
        mimeType: 'text/plain',
      },
      {
        uri: 'memory://temporal/{user_id}',
        name: 'Temporal Context',
        description: 'Current temporal context: recent events, working memory, session metadata.',
        mimeType: 'text/plain',
      },
      {
        uri: 'memory://missions/{user_id}',
        name: 'Active Missions',
        description: 'Active goals/missions with task tree, progress, and journal.',
        mimeType: 'text/plain',
      },
      {
        uri: 'memory://graph',
        name: 'Knowledge Graph Stats',
        description: 'Graph statistics: nodes, edges, queue depth.',
        mimeType: 'text/plain',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri as string;
    if (!is_database_connected()) {
      return { contents: [{ uri, mimeType: 'text/plain', text: '⚠️ MongoDB not connected.' }] };
    }

    const db = get_database();
    const match = uri.match(/^memory:\/\/([^/]+)\/(.+)$/);
    const type = match ? match[1] : '';
    const userId = resolveUserId(match ? decodeURIComponent(match[2]) : undefined);
    const scopeFilter = await buildScopeFilter(userId);

    switch (type) {
      case 'episodic': {
        const events = await db.collection('episodic_events').find(scopeFilter).sort({ timestamp: -1 }).limit(20).toArray();
        const text = [`## Episodic — ${userId}`, `*${events.length} events*\n`,
          ...events.map((e: any) => `[${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.content?.message || JSON.stringify(e.content)}`)];
        return { contents: [{ uri, mimeType: 'text/plain', text: text.join('\n') }] };
      }
      case 'semantic': {
        const facts = await db.collection('semantic_facts').find(scopeFilter).sort({ confidence: -1 }).limit(15).toArray();
        const text = [`## Semantic — ${userId}`, `*${facts.length} facts*\n`,
          ...facts.map((f: any) => `[conf:${(f.confidence * 100).toFixed(0)}%] ${f.content}`)];
        return { contents: [{ uri, mimeType: 'text/plain', text: text.join('\n') }] };
      }
      case 'temporal': {
        const recent = await db.collection('episodic_events').find(scopeFilter).sort({ timestamp: -1 }).limit(10).toArray();
        let wm: unknown[] = [];
        try { wm = await working_memory_service.get_session_memory(DEFAULT_USER_ID, 'auto', 5); } catch { /* ignore */ }
        const text = [`## Temporal Context — ${userId}`, `### Recent (${recent.length})`,
          ...recent.map((e: any) => `[${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.content?.message || JSON.stringify(e.content).substring(0, 200)}`),
          '', `### Working Memory (${wm.length})`, ...wm.map((i: any) => `- ${JSON.stringify(i).substring(0, 300)}`)];
        return { contents: [{ uri, mimeType: 'text/plain', text: text.join('\n') }] };
      }
      case 'missions': {
        const missions = await db.collection('memory_missions').find(scopeFilter).sort({ created_at: -1 }).limit(10).toArray();
        const text = [`## Missions — ${userId}`, `*${missions.length} missions*\n`,
          ...missions.map((m: any) => `- [${m.status}] ${m.title || m.goal} (${m.tasks?.filter((t: any) => t.status === 'completed').length || 0}/${m.tasks?.length || 0})`)];
        return { contents: [{ uri, mimeType: 'text/plain', text: text.join('\n') }] };
      }
      case 'graph': {
        const sms = getSemanticMemoryService();
        const queue = getCompactionQueueService();
        const nodes = await sms.getAllNodes(userId);
        const edges = await sms.getTopEdges(userId, 20);
        const text = ['## Graph Stats', `Nodes: ${nodes.length} | Edges: ${edges.length} | Queue: ${queue.getQueueDepth()}`,
          '\n### Recent Nodes', ...nodes.slice(0, 10).map((n: any) => `- ${n.name || n.id} (${n.node_type || '?'})`),
          '\n### Top Edges', ...edges.slice(0, 10).map((e: any) => `- ${e.source || e.from} → ${e.target || e.to}`)];
        return { contents: [{ uri, mimeType: 'text/plain', text: text.join('\n') }] };
      }
      default:
        return { contents: [{ uri, mimeType: 'text/plain', text: `Unknown: ${type}. Available: episodic, semantic, temporal, missions, graph` }] };
    }
  });

  // ── Prompts ──────────────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'memory-recall',
        description: 'Recall what we discussed about a specific topic, with temporal context.',
        arguments: [
          { name: 'topic', description: 'Topic to recall', required: true },
          { name: 'user_id', description: 'User ID', required: false },
        ],
      },
      {
        name: 'temporal-search',
        description: 'Search conversations within a time period.',
        arguments: [
          { name: 'time_period', description: 'e.g. "last week", "May 2026"', required: true },
          { name: 'topic', description: 'Optional topic filter', required: false },
          { name: 'user_id', description: 'User ID', required: false },
        ],
      },
      {
        name: 'mission-review',
        description: 'Review progress and status of an active mission.',
        arguments: [
          { name: 'mission_id', description: 'Mission ID', required: false },
          { name: 'user_id', description: 'User ID', required: false },
        ],
      },
      {
        name: 'explore-connections',
        description: 'Explore knowledge graph connections around a topic.',
        arguments: [
          { name: 'query', description: 'Topic to explore', required: true },
          { name: 'depth', description: 'Hops (1-4)', required: false },
        ],
      },
      {
        name: 'augmented-chat',
        description: 'Build full augmented context: temporal + semantic + graph + missions.',
        arguments: [
          { name: 'message', description: 'Current user message', required: true },
          { name: 'user_id', description: 'User ID', required: false },
          { name: 'session_id', description: 'Session ID', required: false },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: promptArgs } = request.params;
    const uid = resolveUserId((promptArgs as any)?.user_id);

    switch (name) {
      case 'memory-recall': {
        const topic = (promptArgs as any)?.topic || 'this topic';
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `I need to recall everything about "${topic}". Search episodic memory (temporal_search), semantic facts (search_memories), missions (list_missions), and knowledge graph (knowledge_graph_explore). User: ${uid}.`,
            },
          }],
        };
      }
      case 'temporal-search': {
        const period = (promptArgs as any)?.time_period || 'last week';
        const topic = (promptArgs as any)?.topic || '';
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Search for events ${period}${topic ? ` about "${topic}"` : ''}. Use temporal_recall for the date range and temporal_search for keyword matching. User: ${uid}.`,
            },
          }],
        };
      }
      case 'mission-review': {
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Review mission progress. List missions (list_missions), then get details (get_mission) for the active one. User: ${uid}.`,
            },
          }],
        };
      }
      case 'explore-connections': {
        const query = (promptArgs as any)?.query || 'this topic';
        const depth = (promptArgs as any)?.depth || 2;
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Explore knowledge graph connections around "${query}" with depth ${depth}. Use knowledge_graph_explore.`,
            },
          }],
        };
      }
      case 'augmented-chat': {
        const msg = (promptArgs as any)?.message || '';
        const sid = (promptArgs as any)?.session_id || 'default';
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Build full context for: "${msg}". Call get_temporal_context (session=${sid}), search_memories, list_missions, and detect_patterns. User: ${uid}.`,
            },
          }],
        };
      }
      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  });
}

// ── HTTP Server ────────────────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

async function startHTTPServer(): Promise<void> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!validateAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Set MCP_API_KEY or ADMIN_API_KEY and authenticate via X-MCP-Auth, Authorization: Bearer, or ?token=' }));
      return;
    }

    if (req.url === '/health') {
      const mongoOk = is_database_connected();
      const redisOk = await is_redis_healthy();
      const llmStatus = llmService.getServiceStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: '3.0.0',
        transport: 'http-sse',
        services: {
          mongodb: mongoOk ? 'connected' : 'disconnected',
          redis: redisOk ? 'connected' : 'disconnected',
          llm: llmStatus.available ? `${llmStatus.provider}` : 'unavailable',
          embeddings: embeddingService.isReady ? 'ready' : 'unavailable',
        },
        active_sessions: transports.size,
        auth: {
          required: isMcpAuthConfigured(),
          methods: ['X-MCP-Auth', 'Authorization: Bearer', '?token='],
        },
      }));
      return;
    }

    if (req.url === '/mcp') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      let body: unknown = undefined;
      if (req.method === 'POST') body = await readRequestBody(req);
      if (sessionId) transport = transports.get(sessionId);

      if (!transport) {
        const isInitRequest = body &&
          (Array.isArray(body)
            ? (body as any[]).some((m: any) => m.method === 'initialize')
            : (body as any).method === 'initialize');

        // Some MCP clients (e.g., OpenCode) do not reliably propagate the
        // Mcp-Session-Id header after initialization, or send a stale session
        // ID after the server restarts. Fall back to a stateless transport for
        // any non-initialize request that cannot be mapped to an active session.
        if (!isInitRequest) {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          (transport as any)._webStandardTransport._initialized = true;
          console.log('MCP stateless transport created for unmapped request');
        } else {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        }

        transport.onerror = (err) => {
          console.error('MCP transport error:', err.message);
        };
        // Create a new Server instance per transport — the SDK's Server class
        // only allows one transport connection at a time.
        const sessionServer = createMCPServer();
        registerHandlers(sessionServer);
        await sessionServer.connect(transport);
        transport.onclose = () => {
          if (transport!.sessionId) transports.delete(transport!.sessionId);
        };
        // Store after connect — sessionId is still undefined here, will be set
        // during handleRequest. We'll re-store with the real ID after the request.
      }

      try {
        if (req.method === 'GET') {
          // The SDK's StreamableHTTPServerTransport has a bug in the Node.js
          // adapter where GET SSE streams produce an empty response. Return 405
          // to signal that we don't support standalone SSE streams. The client
          // SDK handles 405 gracefully (POST-only mode).
          // IMPORTANT: OpenClaw must use transport: "streamable-http", NOT "sse".
          res.writeHead(405, { 'Allow': 'POST', 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'SSE GET not supported — use POST-only streamable-http transport. OpenClaw: set transport to "streamable-http", not "sse".'
            },
            id: null
          }));
          return;
        }
        if (req.method === 'DELETE') {
          await transport.handleRequest(req, res, undefined);
          return;
        }
        await transport.handleRequest(req, res, body);
        // After handleRequest, sessionId is set (for initialize requests).
        // Store the transport under the real session ID.
        if (transport.sessionId && !transports.has(transport.sessionId)) {
          transports.set(transport.sessionId, transport);
        }
      } catch (error) {
        console.error('MCP request error:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
  });

  httpServer.listen(getMcpPort(), getMcpHost(), () => {
    console.error(`🚀 Katra MCP Server v3.0 running on http://${getMcpHost()}:${getMcpPort()}`);
    console.error(`   MCP endpoint: http://${getMcpHost()}:${getMcpPort()}/mcp`);
    console.error(`   Health:       http://${getMcpHost()}:${getMcpPort()}/health`);
    console.error(`   Mode:         Katra Cognitive Memory`);
  });
}

// ── Stdio Mode ─────────────────────────────────────────────────────

async function startStdioServer(): Promise<void> {
  // Require MCP auth to be configured even in stdio mode.
  // Stdio is local-only but should still gate access behind an API key
  // to prevent unauthorized local processes from reading/writing memory.
  if (!isMcpAuthConfigured()) {
    console.error('❌ MCP_API_KEY not configured. Set MCP_API_KEY in .env to enable the MCP server.');
    process.exit(1);
  }
  const server = createMCPServer();
  registerHandlers(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🚀 Katra MCP Server v3.0 running on stdio');
}

// ── Helpers ────────────────────────────────────────────────────────

function readRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body exceeds 10MB limit'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch { resolve(undefined); }
    });
    req.on('error', reject);
  });
}

// ── Exported Functions ─────────────────────────────────────────────

/**
 * Start the MCP server (HTTP mode). Called from index.ts.
 * Services must already be initialized.
 */
export async function startMcpServer(port?: number, host?: string): Promise<void> {
  if (port) process.env.MCP_PORT = String(port);
  if (host) process.env.MCP_HOST = host;
  await initializeServices();
  await startHTTPServer();
}

/**
 * Start the MCP server in stdio mode. Used when run standalone with --stdio flag.
 */
export async function startMcpStdio(): Promise<void> {
  await initializeServices();
  await startStdioServer();
}

// ── Standalone Entrypoint ──────────────────────────────────────────
// When run directly (not imported), start the server.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    if (USE_STDIO) {
      await startMcpStdio();
    } else {
      await startMcpServer();
    }
  })().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}
