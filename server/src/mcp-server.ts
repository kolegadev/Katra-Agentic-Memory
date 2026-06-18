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
import { llmService } from './services/llm-service.js';
import { working_memory_service } from './services/working-memory-service.js';
import {
  getSemanticMemoryService,
  getCompactionQueueService,
  getMemorySynthesisService,
  getProspectiveMemoryService,
} from './services/knowledge-graph-factory.js';
import { embeddingService } from './services/embedding-service.js';

dotenv.config();

// ── Authentication ─────────────────────────────────────────────────

const AUTH_REQUIRED = !!(process.env.MCP_API_KEY || process.env.ADMIN_API_KEY);
const API_KEY = process.env.MCP_API_KEY || process.env.ADMIN_API_KEY || null;

if (AUTH_REQUIRED) {
  console.error(`🔐 MCP authentication ENABLED (via ${process.env.MCP_API_KEY ? 'MCP_API_KEY' : 'ADMIN_API_KEY'})`);
} else {
  console.error('⚠️ MCP authentication DISABLED — set MCP_API_KEY or ADMIN_API_KEY to enable');
}

function validateAuth(req: IncomingMessage): boolean {
  if (!AUTH_REQUIRED) return true;
  const mcpAuth = req.headers['x-mcp-auth'] as string | undefined;
  if (mcpAuth === API_KEY) return true;
  const authHeader = req.headers['authorization'] as string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    if (authHeader.slice(7) === API_KEY) return true;
  }
  if (req.url) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.searchParams.get('token') === API_KEY) return true;
    } catch { /* ignore */ }
  }
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
    await embeddingService.encode('warmup');
    console.error('  ✅ Embedding service ready');
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
  user_id: z.string().optional().describe('Optional user ID'),
  category: z.enum(['fact', 'preference', 'insight', 'event', 'general']).optional().default('general'),
  confidence: z.number().min(0).max(1).optional().default(0.8),
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
  entry: z.string().min(1).describe('Journal entry text'),
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
];

// ── Tool handlers ──────────────────────────────────────────────────

async function handleStoreMemory(args: unknown): Promise<TextContent[]> {
  const input = StoreMemoryInput.parse(args);
  if (!is_database_connected()) {
    return [{ type: 'text', text: '⚠️ MongoDB is not connected. Cannot store memory.' }];
  }

  const db = get_database();
  const doc = {
    user_id: input.user_id || 'mcp-user',
    content: input.content,
    category: input.category,
    confidence: input.confidence,
    source: 'mcp_store',
    timestamp: new Date(),
    last_accessed: new Date(),
    access_count: 0,
  };
  const result = await db.collection('semantic_facts').insertOne(doc);

  // Fire-and-forget embedding
  try {
    const vec = await embeddingService.encode(input.content);
    if (vec) {
      await db.collection('semantic_facts').updateOne(
        { _id: result.insertedId },
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

  return [{
    type: 'text',
    text: `✅ Memory stored.\n\n**ID:** \`${result.insertedId}\`\n**Content:** ${input.content}\n**Category:** ${input.category}\n**Confidence:** ${(input.confidence * 100).toFixed(0)}%`,
  }];
}

async function handleSearchMemories(args: unknown): Promise<TextContent[]> {
  const input = SearchMemoriesInput.parse(args);
  if (!is_database_connected()) {
    return [{ type: 'text', text: '⚠️ MongoDB is not connected.' }];
  }

  const db = get_database();
  const baseFilter: Record<string, unknown> = {};
  if (input.user_id) baseFilter.user_id = input.user_id;

  // Episodic: apply text search with regex fallback (was previously unfiltered)
  let episodic: any[] = [];
  try {
    const episodicQuery: Record<string, unknown> = { ...baseFilter };
    // Try text search on the content.message field first
    episodic = await db.collection('episodic_events')
      .find({ ...baseFilter, $text: { $search: input.query } })
      .sort({ timestamp: -1 })
      .limit(input.limit)
      .toArray();
  } catch {
    // Text index not available — use regex on content.message
    const regex = new RegExp(input.query.split(/\s+/).join('|'), 'i');
    episodic = await db.collection('episodic_events')
      .find({ ...baseFilter, 'content.message': { $regex: regex } })
      .sort({ timestamp: -1 })
      .limit(input.limit)
      .toArray();
  }

  let semantic: unknown[] = [];
  try {
    semantic = await db.collection('semantic_facts')
      .find(input.user_id
        ? { $text: { $search: input.query }, user_id: input.user_id }
        : { $text: { $search: input.query } })
      .limit(input.limit)
      .toArray();
  } catch {
    const regex = new RegExp(input.query.split(/\s+/).join('|'), 'i');
    semantic = await db.collection('semantic_facts')
      .find({ ...baseFilter, content: { $regex: regex } })
      .limit(input.limit)
      .toArray();
  }

  const lines: string[] = [
    `## Memory Search: "${input.query}"`,
    '',
    `### Episodic (${episodic.length})`,
  ];
  if (episodic.length === 0) lines.push('*None*');
  else episodic.forEach(e => lines.push(`- [${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.content?.message || JSON.stringify(e.content)}`));

  lines.push('', `### Semantic Facts (${semantic.length})`);
  if (semantic.length === 0) lines.push('*None*');
  else (semantic as any[]).forEach(s => lines.push(`- ${s.content} (conf: ${(s.confidence * 100).toFixed(0)}%)`));

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleVectorSearch(args: unknown): Promise<TextContent[]> {
  const input = VectorSearchInput.parse(args);
  if (!is_database_connected()) {
    return [{ type: 'text', text: '⚠️ MongoDB is not connected.' }];
  }

  const db = get_database();
  const userId = input.user_id || 'mcp-user';
  let results: any[] = [];
  let usedVector = false;

  try {
    const queryVec = await embeddingService.encode(input.query);
    if (queryVec) {
      const facts = await db.collection('semantic_facts')
        .find({ user_id: userId, embedding: { $exists: true } })
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
        .find({ user_id: userId, $text: { $search: input.query } })
        .limit(input.limit)
        .toArray();
    } catch {
      const regex = new RegExp(input.query.split(/\s+/).join('|'), 'i');
      results = await db.collection('semantic_facts')
        .find({ user_id: userId, content: { $regex: regex } })
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
  const events = await db.collection('episodic_events')
    .find({ session_id: input.session_id })
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

  const match: any = { user_id: input.user_id, timestamp: { $gte: from, $lte: to } };
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
  let results: unknown[] = [];

  try {
    results = await db.collection('episodic_events')
      .find({ user_id: input.user_id, $text: { $search: input.query } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(input.limit)
      .toArray();
  } catch {
    // Text index unavailable
  }

  if (results.length === 0) {
    const regex = new RegExp(input.query.split(/\s+/).join('|'), 'i');
    results = await db.collection('episodic_events')
      .find({ user_id: input.user_id, $or: [{ 'content.message': regex }, { event_type: regex }] })
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
  const recent = await db.collection('episodic_events')
    .find({ user_id: input.user_id, session_id: input.session_id })
    .sort({ timestamp: -1 }).limit(10).toArray();

  let wmItems: unknown[] = [];
  try { wmItems = await working-memory-service.get_session_memory(input.session_id, 5); } catch { /* ignore */ }

  let semantic: unknown[] = [];
  try {
    semantic = await db.collection('semantic_facts')
      .find({ user_id: input.user_id }).sort({ last_accessed: -1 }).limit(5).toArray();
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
  const lines: string[] = [`## Journal — ${input.user_id}`, `*source: ${input.source} | limit: ${input.limit}*\n`];

  if (input.source === 'all' || input.source === 'manual') {
    const manual = await db.collection('agent_journal_manual')
      .find({ user_id: input.user_id }).sort({ timestamp: -1 }).limit(input.limit).toArray();
    if (manual.length > 0) {
      lines.push(`### 📝 Manual (${manual.length})`);
      manual.forEach((e: any) => lines.push(`- [${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.text || e.entry || '(empty)'}`));
      lines.push('');
    }
  }

  if (input.source === 'all' || input.source === 'auto') {
    const auto = await db.collection('agent_journal_auto')
      .find({ user_id: input.user_id }).sort({ timestamp: -1 }).limit(input.limit).toArray();
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
  const input = StoreJournalInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const db = get_database();
  const collection = input.source === 'manual' ? 'agent_journal_manual' : 'agent_journal_auto';

  const result = await db.collection(collection).insertOne({
    user_id: input.user_id,
    text: input.entry,
    entry: input.entry,
    source: input.source,
    tags: input.tags || [],
    timestamp: new Date(),
  });

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
  const missions = await pms.listMissions(input.user_id, input.limit);

  const lines = [`## Missions — ${input.user_id}`, `*${missions.length} missions*\n`];
  if (missions.length === 0) lines.push('*No missions.*');
  else missions.forEach((m: any) => {
    const emoji = m.status === 'active' ? '🔄' : m.status === 'completed' ? '✅' : m.status === 'paused' ? '⏸️' : '📝';
    const done = m.tasks?.filter((t: any) => t.status === 'completed').length || 0;
    const total = m.tasks?.length || 0;
    lines.push(`- ${emoji} **${m.title || m.goal}** (${done}/${total}) — ${m.status}`);
  });

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleGetMission(args: unknown): Promise<TextContent[]> {
  const input = GetMissionInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const pms = getProspectiveMemoryService();
  const missions = await pms.listMissions(input.user_id, 50);
  const mission = missions.find((m: any) => m.id === input.mission_id);

  if (!mission) return [{ type: 'text', text: `❌ Mission not found: \`${input.mission_id}\`` }];

  const done = mission.tasks?.filter((t: any) => t.status === 'completed').length || 0;
  const total = mission.tasks?.length || 0;

  const lines = [
    `## Mission: ${mission.title || mission.goal}`,
    `| ID | \`${mission.id}\` |`,
    `| Status | ${mission.status} |`,
    `| Progress | ${done}/${total} tasks |`,
    '',
  ];

  if (mission.tasks?.length) {
    lines.push('### Tasks');
    mission.tasks.forEach((t: any) => {
      const emoji = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
      lines.push(`- ${emoji} ${t.title || t.id} (${t.status})`);
    });
    lines.push('');
  }

  if (mission.self_journal?.length) {
    lines.push('### Self-Journal');
    mission.self_journal.slice(-10).forEach((e: any) => {
      lines.push(`- [${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.text || e}`);
    });
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

async function handleCreateMission(args: unknown): Promise<TextContent[]> {
  const input = CreateMissionInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const pms = getProspectiveMemoryService();
  const mission = await pms.createMission(input.user_id, {
    goal: input.goal,
    title: input.title || input.goal,
  });

  if (input.tasks?.length && mission.tasks) {
    for (const title of input.tasks) {
      mission.tasks.push({
        id: `t${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title,
        status: 'pending',
        created_at: new Date(),
      });
    }
    await pms.updateMission(input.user_id, mission.id, { tasks: mission.tasks });
  }

  return [{
    type: 'text',
    text: `✅ Mission created.\n\n**ID:** \`${mission.id}\`\n**Title:** ${mission.title || mission.goal}\n${input.tasks ? `**Tasks:** ${input.tasks.length} added` : ''}`,
  }];
}

async function handleUpdateMissionTask(args: unknown): Promise<TextContent[]> {
  const input = UpdateMissionTaskInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const pms = getProspectiveMemoryService();
  const missions = await pms.listMissions(input.user_id, 50);
  const mission = missions.find((m: any) => m.id === input.mission_id);

  if (!mission) return [{ type: 'text', text: `❌ Mission not found.` }];
  if (!mission.tasks) return [{ type: 'text', text: `❌ No tasks.` }];

  const task = mission.tasks.find((t: any) => t.id === input.task_id);
  if (!task) return [{ type: 'text', text: `❌ Task not found.` }];

  task.status = input.status;
  task.updated_at = new Date();
  await pms.updateMission(input.user_id, mission.id, { tasks: mission.tasks });

  return [{
    type: 'text',
    text: `✅ Task updated.\n\n**Mission:** ${mission.title || mission.goal}\n**Task:** ${task.title || input.task_id}\n**Status:** ${input.status}`,
  }];
}

// ── Diagnostic handlers ────────────────────────────────────────────

async function handleGetMemoryDiagnostics(args: unknown): Promise<TextContent[]> {
  const input = GetMemoryDiagnosticsInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];

  const db = get_database();
  const userId = input.user_id;

  const counts: Record<string, number> = {};
  for (const coll of ['episodic_events', 'semantic_facts', 'agent_journal_auto', 'agent_journal_manual', 'memory_missions', 'agent_state']) {
    try {
      counts[coll] = userId
        ? await db.collection(coll).countDocuments({ user_id: userId })
        : await db.collection(coll).estimatedDocumentCount();
    } catch { counts[coll] = 0; }
  }

  const withEmbeddings = await db.collection('semantic_facts').countDocuments({ embedding: { $exists: true } });
  const totalFacts = counts['semantic_facts'] || 1;
  const unprocessed = await db.collection('episodic_events').countDocuments({ 'metadata.processed': { $ne: true } });
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

  const nodeFilter: Record<string, unknown> = {};
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
    const items = await working-memory-service.get_session_memory(input.session_id, input.limit);
    const lines: string[] = [`## Working Memory: ${input.session_id}`, `**Items:** ${items.length}`, ''];
    items.forEach((item: any, i: number) => {
      lines.push(`${i + 1}. ${typeof item.content === 'string' ? item.content.slice(0, 200) : JSON.stringify(item.content).slice(0, 200)}`);
    });
    return [{ type: 'text', text: lines.join('\n') }];
  }

  if (input.action === 'store') {
    if (!input.content) return [{ type: 'text', text: '⚠️ content is required for store action.' }];
    const id = await working-memory-service.store({
      session_id: input.session_id,
      content: input.content,
    });
    return [{ type: 'text', text: `✅ Stored in working memory.\n**ID:** ${id}\n**Session:** ${input.session_id}` }];
  }

  if (input.action === 'delete') {
    await working-memory-service.delete(input.session_id);
    return [{ type: 'text', text: `✅ Working memory cleared for session ${input.session_id}` }];
  }

  return [{ type: 'text', text: '⚠️ Unknown action.' }];
}

async function handleGetAutoJournal(args: unknown): Promise<TextContent[]> {
  const input = GetAutoJournalInput.parse(args);
  if (!is_database_connected()) return [{ type: 'text', text: '⚠️ MongoDB disconnected.' }];
  const db = get_database();

  const filter: Record<string, unknown> = { user_id: input.user_id, source: 'auto' };
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

  const filter: Record<string, unknown> = {};
  if (input.user_id) filter.user_id = input.user_id;
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

function createMCPServer() {
  return new Server(
    { name: 'cognitive-memory', version: '3.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );
}

function registerHandlers(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
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
        case 'get_memory_diagnostics': result = await handleGetMemoryDiagnostics(args); break;
        case 'get_background_status': result = await handleGetBackgroundStatus(args); break;
        case 'get_health': result = await handleGetHealth(); break;
        case 'explore_graph': result = await handleExploreGraph(args); break;
        case 'working_memory': result = await handleWorkingMemory(args); break;
        case 'get_auto_journal': result = await handleGetAutoJournal(args); break;
        case 'get_transaction_log': result = await handleGetTransactionLog(args); break;
        case 'get_heartbeat_status': result = await handleGetHeartbeatStatus(args); break;
        case 'list_assets': result = await handleListAssets(args); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }
      return { content: result, isError: false };
    } catch (error) {
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
    const userId = match ? decodeURIComponent(match[2]) : 'mcp-user';

    switch (type) {
      case 'episodic': {
        const events = await db.collection('episodic_events').find({ user_id: userId }).sort({ timestamp: -1 }).limit(20).toArray();
        const text = [`## Episodic — ${userId}`, `*${events.length} events*\n`,
          ...events.map((e: any) => `[${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.content?.message || JSON.stringify(e.content)}`)];
        return { contents: [{ uri, mimeType: 'text/plain', text: text.join('\n') }] };
      }
      case 'semantic': {
        const facts = await db.collection('semantic_facts').find({ user_id: userId }).sort({ confidence: -1 }).limit(15).toArray();
        const text = [`## Semantic — ${userId}`, `*${facts.length} facts*\n`,
          ...facts.map((f: any) => `[conf:${(f.confidence * 100).toFixed(0)}%] ${f.content}`)];
        return { contents: [{ uri, mimeType: 'text/plain', text: text.join('\n') }] };
      }
      case 'temporal': {
        const recent = await db.collection('episodic_events').find({ user_id: userId }).sort({ timestamp: -1 }).limit(10).toArray();
        let wm: unknown[] = [];
        try { wm = await working-memory-service.get_session_memory('auto', 5); } catch { /* ignore */ }
        const text = [`## Temporal Context — ${userId}`, `### Recent (${recent.length})`,
          ...recent.map((e: any) => `[${e.timestamp ? new Date(e.timestamp).toISOString() : '?'}] ${e.content?.message || JSON.stringify(e.content).substring(0, 200)}`),
          '', `### Working Memory (${wm.length})`, ...wm.map((i: any) => `- ${JSON.stringify(i).substring(0, 300)}`)];
        return { contents: [{ uri, mimeType: 'text/plain', text: text.join('\n') }] };
      }
      case 'missions': {
        const pms = getProspectiveMemoryService();
        const missions = await pms.listMissions(userId, 10);
        const text = [`## Missions — ${userId}`, `*${missions.length} missions*\n`,
          ...missions.map((m: any) => `- [${m.status}] ${m.title || m.goal} (${m.tasks?.filter((t: any) => t.status === 'completed').length || 0}/${m.tasks?.length || 0})`)];
        return { contents: [{ uri, mimeType: 'text/plain', text: text.join('\n') }] };
      }
      case 'graph': {
        const sms = getSemanticMemoryService();
        const queue = getCompactionQueueService();
        const nodes = await sms.getAllNodes();
        const edges = await sms.getTopEdges(20);
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
    const uid = (promptArgs as any)?.user_id || 'mcp-user';

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
          required: AUTH_REQUIRED,
          methods: ['X-MCP-Auth', 'Authorization: Bearer', '?token='],
        },
      }));
      return;
    }

    if (req.url === '/mcp') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId) transport = transports.get(sessionId);
      
      if (!transport) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
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
          res.writeHead(405, { 'Allow': 'POST' });
          res.end();
          return;
        }
        if (req.method === 'DELETE') {
          await transport.handleRequest(req, res, undefined);
          return;
        }
        let body: unknown = undefined;
        if (req.method === 'POST') body = await readRequestBody(req);
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
  const server = createMCPServer();
  registerHandlers(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🚀 Katra MCP Server v3.0 running on stdio');
}

// ── Helpers ────────────────────────────────────────────────────────

function readRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
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
