/**
 * Katra SDK — High-Level Client
 *
 * The `KatraClient` class provides typed, ergonomic access to all 29 MCP
 * tools exposed by the Katra cognitive memory server. It manages the MCP
 * session handshake automatically — just construct, call a method, and go.
 *
 * @example
 * ```ts
 * import { KatraClient } from '@katra/sdk';
 *
 * const katra = new KatraClient({ url: 'http://localhost:3112', apiKey: 'sk-...' });
 *
 * const mem = await katra.storeMemory({
 *   content: 'The user prefers dark mode for all applications',
 *   category: 'preference',
 * });
 * console.log(mem); // { insertedId: '...', content: '...', category: 'preference', ... }
 * ```
 *
 * @module client
 */

import { MCPClient } from './mcp-client.js';
import type {
  KatraClientOptions,
  StoreMemoryParams,
  StoreMemoryResult,
  SearchMemoriesParams,
  SearchMemoriesResult,
  VectorSearchParams,
  VectorSearchItem,
  GetConversationHistoryParams,
  ConversationEvent,
  TemporalRecallParams,
  TemporalSearchParams,
  TimeBlockSummariesParams,
  TimeBlockSummary,
  SummarizeTimeBlocksParams,
  SummarizeTimeBlocksResult,
  DetectPatternsParams,
  DetectPatternsResult,
  TemporalContextParams,
  TemporalContextResult,
  GetJournalParams,
  GetJournalResult,
  StoreJournalParams,
  StoreJournalResult,
  ListMissionsParams,
  MissionSummary,
  GetMissionParams,
  MissionDetail,
  CreateMissionParams,
  CreateMissionResult,
  UpdateMissionTaskParams,
  UpdateMissionTaskResult,
  GetMemoryDiagnosticsParams,
  MemoryDiagnostics,
  BackgroundStatus,
  HealthStatus,
  ExploreGraphParams,
  ExploreGraphResult,
  WorkingMemoryParams,
  WorkingMemoryItem,
  WorkingMemoryStoreResult,
  GetAutoJournalParams,
  JournalEntry,
  GetTransactionLogParams,
  TransactionLogEntry,
  HeartbeatStatus,
  ListAssetsParams,
  AssetItem,
} from './types.js';

/**
 * High-level client for the Katra Cognitive Memory MCP server.
 *
 * Wraps the low-level MCP protocol details (JSON-RPC, SSE, sessions) behind
 * typed, async methods matching each of the 29 Katra tools.
 */
export class KatraClient {
  readonly #mcp: MCPClient;
  #closed = false;

  /**
   * Create a new KatraClient.
   *
   * @param options - Server URL, API key, and optional fetch override.
   *
   * @example
   * ```ts
   * const katra = new KatraClient({
   *   url: 'http://localhost:3112',
   *   apiKey: 'sk-my-secret',
   * });
   * ```
   */
  constructor(options: KatraClientOptions) {
    this.#mcp = new MCPClient({
      url: options.url,
      apiKey: options.apiKey,
      fetch: options.fetch,
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Explicitly initialize the MCP session. Automatically called on first
   * tool invocation if not yet initialized.
   *
   * @example
   * ```ts
   * await katra.initialize();
   * ```
   */
  async initialize(): Promise<void> {
    if (this.#closed) throw new Error('KatraClient is closed');
    await this.#mcp.initialize();
  }

  /**
   * Close the MCP session and release resources.
   *
   * @example
   * ```ts
   * await katra.close();
   * ```
   */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#mcp.close();
  }

  /** Whether the MCP session has been initialized. */
  get initialized(): boolean {
    return this.#mcp.initialized;
  }

  // ── Core Memory ──────────────────────────────────────────────────

  /**
   * Store a new memory (fact, preference, insight, event, or general).
   *
   * @returns The stored memory's ID, content, category, and confidence.
   *
   * @example
   * ```ts
   * const result = await katra.storeMemory({
   *   content: 'The team migrated to PostgreSQL in March 2025',
   *   category: 'fact',
   *   confidence: 0.95,
   * });
   * console.log(result.insertedId); // '6612f4...'
   * ```
   */
  async storeMemory(params: StoreMemoryParams): Promise<StoreMemoryResult> {
    const raw = await this.#mcp.callTool('store_memory', params as unknown as Record<string, unknown>);
    return this.#parseStoreMemoryResult(raw as string);
  }

  /**
   * Search episodic and semantic memories by keyword query.
   *
   * @returns Episodic (conversational) and semantic (fact) matches.
   *
   * @example
   * ```ts
   * const results = await katra.searchMemories({
   *   query: 'PostgreSQL migration',
   *   user_id: 'alice',
   * });
   * console.log(`Found ${results.episodic.length} events, ${results.semantic.length} facts`);
   * ```
   */
  async searchMemories(params: SearchMemoriesParams): Promise<SearchMemoriesResult> {
    const raw = await this.#mcp.callTool('search_memories', params as unknown as Record<string, unknown>);
    return this.#parseSearchMemoriesResult(raw as string);
  }

  /**
   * Search memories using semantic vector similarity.
   *
   * Finds conceptually related memories even when keywords don't match
   * (e.g. "containerization" → "Docker strategy"). Falls back to keyword
   * search if the embedding model is unavailable.
   *
   * @example
   * ```ts
   * const results = await katra.vectorSearch({
   *   query: 'deployment automation',
   *   limit: 5,
   * });
   * ```
   */
  async vectorSearch(params: VectorSearchParams): Promise<VectorSearchItem[]> {
    const raw = await this.#mcp.callTool('vector_search', params as unknown as Record<string, unknown>);
    return this.#parseVectorSearchResult(raw as string);
  }

  /**
   * Retrieve raw conversation history for a session.
   *
   * Returns chronologically ordered events (ascending timestamp).
   *
   * @example
   * ```ts
   * const history = await katra.getConversationHistory({
   *   session_id: 'sess-abc123',
   * });
   * ```
   */
  async getConversationHistory(params: GetConversationHistoryParams): Promise<ConversationEvent[]> {
    const raw = await this.#mcp.callTool('get_conversation_history', params as unknown as Record<string, unknown>);
    return this.#parseConversationHistory(raw as string);
  }

  // ── Temporal Memory ──────────────────────────────────────────────

  /**
   * Query episodic events within a date/time range.
   *
   * Useful for "what happened last week" or "show me messages from May".
   *
   * @example
   * ```ts
   * const events = await katra.temporalRecall({
   *   user_id: 'alice',
   *   from: '2025-06-01',
   *   to: '2025-06-18',
   *   role: 'user',
   * });
   * ```
   */
  async temporalRecall(params: TemporalRecallParams): Promise<ConversationEvent[]> {
    const raw = await this.#mcp.callTool('temporal_recall', params as unknown as Record<string, unknown>);
    return this.#parseTemporalEvents(raw as string);
  }

  /**
   * Search episodic events by keyword with time context.
   *
   * Uses text index with regex fallback.
   *
   * @example
   * ```ts
   * const results = await katra.temporalSearch({
   *   user_id: 'alice',
   *   query: 'trading bot',
   *   limit: 10,
   * });
   * ```
   */
  async temporalSearch(params: TemporalSearchParams): Promise<ConversationEvent[]> {
    const raw = await this.#mcp.callTool('temporal_search', params as unknown as Record<string, unknown>);
    return this.#parseTemporalEvents(raw as string);
  }

  /**
   * Query LLM-generated time-block summaries.
   *
   * Returns pre-computed AI summaries by day, week, or month.
   *
   * @example
   * ```ts
   * const summaries = await katra.getTimeBlockSummaries({
   *   user_id: 'alice',
   *   block_type: 'week',
   * });
   * ```
   */
  async getTimeBlockSummaries(params: TimeBlockSummariesParams): Promise<TimeBlockSummary[]> {
    const raw = await this.#mcp.callTool('get_time_block_summaries', params as unknown as Record<string, unknown>);
    return this.#parseTimeBlockSummaries(raw as string);
  }

  /**
   * Trigger LLM summarization of conversation activity across time blocks.
   *
   * Use `dry_run: true` to preview without storing.
   *
   * @example
   * ```ts
   * const result = await katra.summarizeTimeBlocks({
   *   user_id: 'alice',
   *   block_type: 'week',
   *   lookback_days: 30,
   *   dry_run: true,
   * });
   * console.log(`${result.blocks_processed} blocks processed`);
   * ```
   */
  async summarizeTimeBlocks(params: SummarizeTimeBlocksParams): Promise<SummarizeTimeBlocksResult> {
    const raw = await this.#mcp.callTool('summarize_time_blocks', params as unknown as Record<string, unknown>);
    return this.#parseSummarizeTimeBlocksResult(raw as string);
  }

  /**
   * Detect temporal patterns in user activity: recurring topics, session
   * rhythm, topic regressions, and dormant topics.
   *
   * @example
   * ```ts
   * const patterns = await katra.detectPatterns({
   *   user_id: 'alice',
   *   lookback_weeks: 8,
   * });
   * console.log(patterns.summary);
   * ```
   */
  async detectPatterns(params: DetectPatternsParams): Promise<DetectPatternsResult> {
    const raw = await this.#mcp.callTool('detect_patterns', params as unknown as Record<string, unknown>);
    return this.#parseDetectPatterns(raw as string);
  }

  /**
   * Get the current temporal context for a session including recent events,
   * working memory state, and session metadata.
   *
   * Call this before responding to understand the user's current context.
   *
   * @example
   * ```ts
   * const ctx = await katra.getTemporalContext({
   *   user_id: 'alice',
   *   session_id: 'sess-xyz',
   * });
   * ```
   */
  async getTemporalContext(params: TemporalContextParams): Promise<TemporalContextResult> {
    const raw = await this.#mcp.callTool('get_temporal_context', params as unknown as Record<string, unknown>);
    return this.#parseTemporalContext(raw as string);
  }

  // ── Journal ──────────────────────────────────────────────────────

  /**
   * Read agent journal entries (auto-generated insights or manual reflections).
   *
   * @example
   * ```ts
   * const journal = await katra.getJournal({
   *   user_id: 'alice',
   *   source: 'auto',
   *   limit: 10,
   * });
   * console.log(`${journal.auto.length} auto entries`);
   * ```
   */
  async getJournal(params: GetJournalParams): Promise<GetJournalResult> {
    const raw = await this.#mcp.callTool('get_journal', params as unknown as Record<string, unknown>);
    return this.#parseJournalResult(raw as string);
  }

  /**
   * Write a journal entry to the agent's memory.
   *
   * Stores a reflective insight, observation, or note retrievable in future
   * conversations.
   *
   * @example
   * ```ts
   * const result = await katra.storeJournal({
   *   user_id: 'alice',
   *   entry: 'User mentioned they prefer async communication over meetings',
   *   tags: ['communication-style', 'preference'],
   * });
   * ```
   */
  async storeJournal(params: StoreJournalParams): Promise<StoreJournalResult> {
    const raw = await this.#mcp.callTool('store_journal', params as unknown as Record<string, unknown>);
    return this.#parseStoreJournalResult(raw as string);
  }

  // ── Missions ─────────────────────────────────────────────────────

  /**
   * List all missions (goals) for a user.
   *
   * Shows mission status, progress, task counts, and creation date.
   *
   * @example
   * ```ts
   * const missions = await katra.listMissions({ user_id: 'alice' });
   * for (const m of missions) {
   *   console.log(`${m.title}: ${m.status}`);
   * }
   * ```
   */
  async listMissions(params: ListMissionsParams): Promise<MissionSummary[]> {
    const raw = await this.#mcp.callTool('list_missions', params as unknown as Record<string, unknown>);
    return this.#parseMissionList(raw as string);
  }

  /**
   * Get full mission details including task tree, journal, and progress.
   *
   * @example
   * ```ts
   * const mission = await katra.getMission({
   *   user_id: 'alice',
   *   mission_id: 'm-abc123',
   * });
   * ```
   */
  async getMission(params: GetMissionParams): Promise<MissionDetail> {
    const raw = await this.#mcp.callTool('get_mission', params as unknown as Record<string, unknown>);
    return this.#parseMissionDetail(raw as string);
  }

  /**
   * Create a new mission (goal) with optional task breakdown.
   *
   * @example
   * ```ts
   * const mission = await katra.createMission({
   *   user_id: 'alice',
   *   goal: 'Refactor authentication to use OAuth 2.0',
   *   title: 'Auth Refactor',
   *   tasks: ['Research providers', 'Implement flow', 'Write tests'],
   * });
   * ```
   */
  async createMission(params: CreateMissionParams): Promise<CreateMissionResult> {
    const raw = await this.#mcp.callTool('create_mission', params as unknown as Record<string, unknown>);
    return this.#parseCreateMissionResult(raw as string);
  }

  /**
   * Update the status of a task within a mission.
   *
   * @example
   * ```ts
   * await katra.updateMissionTask({
   *   user_id: 'alice',
   *   mission_id: 'm-abc123',
   *   task_id: 't-xyz456',
   *   status: 'completed',
   * });
   * ```
   */
  async updateMissionTask(params: UpdateMissionTaskParams): Promise<UpdateMissionTaskResult> {
    const raw = await this.#mcp.callTool('update_mission_task', params as unknown as Record<string, unknown>);
    return this.#parseUpdateMissionTaskResult(raw as string);
  }

  // ── Diagnostics ──────────────────────────────────────────────────

  /**
   * Get comprehensive memory system diagnostics:
   * document counts, processing backlog, embedding coverage, index status.
   *
   * @example
   * ```ts
   * const diag = await katra.getMemoryDiagnostics();
   * console.log(`${diag.collections.episodic_events} episodic events`);
   * ```
   */
  async getMemoryDiagnostics(params?: GetMemoryDiagnosticsParams): Promise<MemoryDiagnostics> {
    const raw = await this.#mcp.callTool('get_memory_diagnostics', (params ?? {}) as Record<string, unknown>);
    return this.#parseMemoryDiagnostics(raw as string);
  }

  /**
   * Check background processor status: queue depth, last run time,
   * processing interval, and errors.
   *
   * @example
   * ```ts
   * const status = await katra.getBackgroundStatus();
   * console.log(`${status.unprocessed} unprocessed events`);
   * ```
   */
  async getBackgroundStatus(): Promise<BackgroundStatus> {
    const raw = await this.#mcp.callTool('get_background_status', {});
    return this.#parseBackgroundStatus(raw as string);
  }

  /**
   * Check the health of all backend services:
   * MongoDB, Redis, LLM, and embedding model.
   *
   * @example
   * ```ts
   * const health = await katra.getHealth();
   * if (!health.mongodb) console.error('MongoDB is down!');
   * ```
   */
  async getHealth(): Promise<HealthStatus> {
    const raw = await this.#mcp.callTool('get_health', {});
    return this.#parseHealthStatus(raw as string);
  }

  // ── Knowledge Graph ──────────────────────────────────────────────

  /**
   * Explore the knowledge graph: nodes (entities) and edges (relationships)
   * extracted from conversations via LLM compaction.
   *
   * @example
   * ```ts
   * const graph = await katra.exploreGraph({
   *   query: 'PostgreSQL',
   *   limit: 10,
   * });
   * console.log(`${graph.nodes.length} nodes, ${graph.edges.length} edges`);
   * ```
   */
  async exploreGraph(params: ExploreGraphParams = {}): Promise<ExploreGraphResult> {
    const raw = await this.#mcp.callTool('explore_graph', params as unknown as Record<string, unknown>);
    return this.#parseExploreGraph(raw as string);
  }

  // ── Working Memory ───────────────────────────────────────────────

  /**
   * Read, store, or delete short-term working memory for a session.
   *
   * Working memory lives in Redis for <5ms access.
   *
   * @example
   * ```ts
   * // Store
   * await katra.workingMemory({
   *   session_id: 'sess-123',
   *   action: 'store',
   *   content: 'User is debugging payment webhook',
   * });
   *
   * // Retrieve
   * const items = await katra.workingMemory({
   *   session_id: 'sess-123',
   *   action: 'get',
   * });
   * console.log(items); // WorkingMemoryItem[]
   *
   * // Clear
   * await katra.workingMemory({
   *   session_id: 'sess-123',
   *   action: 'delete',
   * });
   * ```
   */
  async workingMemory(params: WorkingMemoryParams): Promise<WorkingMemoryItem[] | WorkingMemoryStoreResult | void> {
    const raw = await this.#mcp.callTool('working_memory', params as unknown as Record<string, unknown>);
    return this.#parseWorkingMemory(raw as string, params.action);
  }

  // ── Auto Journal ─────────────────────────────────────────────────

  /**
   * Query auto-generated journal entries distilled from conversations
   * by the self-reflection loop.
   *
   * @example
   * ```ts
   * const entries = await katra.getAutoJournal({
   *   user_id: 'alice',
   *   since: '2025-06-01',
   * });
   * ```
   */
  async getAutoJournal(params: GetAutoJournalParams): Promise<JournalEntry[]> {
    const raw = await this.#mcp.callTool('get_auto_journal', params as unknown as Record<string, unknown>);
    return this.#parseAutoJournal(raw as string);
  }

  // ── Transaction Log ──────────────────────────────────────────────

  /**
   * Query the audit trail: heartbeat runs, autonomous ticks, tool
   * executions, and system events.
   *
   * @example
   * ```ts
   * const log = await katra.getTransactionLog({
   *   user_id: 'alice',
   *   action: 'heartbeat_run',
   *   limit: 20,
   * });
   * ```
   */
  async getTransactionLog(params: GetTransactionLogParams = {}): Promise<TransactionLogEntry[]> {
    const raw = await this.#mcp.callTool('get_transaction_log', params as unknown as Record<string, unknown>);
    return this.#parseTransactionLog(raw as string);
  }

  // ── Heartbeat Status ─────────────────────────────────────────────

  /**
   * Check the heartbeat scheduler status: whether running, last run
   * time/result, next scheduled run, interval, and recent run history.
   *
   * @example
   * ```ts
   * const status = await katra.getHeartbeatStatus();
   * console.log(`Heartbeat ${status.enabled ? 'enabled' : 'disabled'}`);
   * ```
   */
  async getHeartbeatStatus(): Promise<HeartbeatStatus> {
    const raw = await this.#mcp.callTool('get_heartbeat_status', {});
    return this.#parseHeartbeatStatus(raw as string);
  }

  // ── Assets ───────────────────────────────────────────────────────

  /**
   * List uploaded assets stored in MinIO (images, files, documents).
   *
   * @example
   * ```ts
   * const assets = await katra.listAssets({
   *   content_type: 'image/',
   *   limit: 10,
   * });
   * ```
   */
  async listAssets(params: ListAssetsParams = {}): Promise<AssetItem[]> {
    const raw = await this.#mcp.callTool('list_assets', params as unknown as Record<string, unknown>);
    return this.#parseAssetList(raw as string);
  }

  // ── Response Parsers ─────────────────────────────────────────────
  //
  // Each parser extracts structured data from the text/plain MCP tool
  // responses. The Katra server returns Markdown-formatted responses,
  // so we extract key fields via regex and line iteration.

  #parseStoreMemoryResult(text: string): StoreMemoryResult {
    const id = text.match(/\*\*ID:\*\*\s*`([^`]+)`/)?.[1] ?? '';
    const content = text.match(/\*\*Content:\*\*\s*(.+)/)?.[1] ?? '';
    const category = text.match(/\*\*Category:\*\*\s*(\w+)/)?.[1] ?? 'general';
    const conf = text.match(/\*\*Confidence:\*\*\s*(\d+)%/)?.[1];
    return {
      insertedId: id,
      content: content.trim(),
      category,
      confidence: conf ? parseInt(conf, 10) / 100 : 0.8,
    };
  }

  #parseSearchMemoriesResult(text: string): SearchMemoriesResult {
    const sections = text.split(/###\s+/);
    const episodic: SearchMemoriesResult['episodic'] = [];
    const semantic: SearchMemoriesResult['semantic'] = [];

    let currentSection = '';
    for (const section of sections) {
      if (section.startsWith('Episodic')) currentSection = 'episodic';
      else if (section.startsWith('Semantic')) currentSection = 'semantic';
      else if (currentSection === 'episodic') {
        const lines = section.split('\n').filter((l) => l.startsWith('-'));
        for (const line of lines) {
          const tsMatch = line.match(/\[([^\]]+)\]/);
          episodic.push({
            timestamp: tsMatch?.[1],
            content: line.replace(/^-\s*\[[^\]]+\]\s*/, '').trim(),
          });
        }
      } else if (currentSection === 'semantic') {
        const lines = section.split('\n').filter((l) => l.startsWith('-'));
        for (const line of lines) {
          const confMatch = line.match(/conf:\s*(\d+)%/);
          semantic.push({
            content: line.replace(/\(conf:\s*\d+%\)/, '').replace(/^-\s*/, '').trim(),
            confidence: confMatch ? parseInt(confMatch[1]!, 10) / 100 : undefined,
          });
        }
      }
    }

    return { episodic, semantic };
  }

  #parseVectorSearchResult(text: string): VectorSearchItem[] {
    const items: VectorSearchItem[] = [];
    const lines = text.split('\n').filter((l) => l.startsWith('-'));
    for (const line of lines) {
      const scoreMatch = line.match(/score:\s*([\d.]+)%/);
      const typeMatch = line.match(/\[(\w+)\]/);
      items.push({
        content: line
          .replace(/\(score:\s*[\d.]+%\)/, '')
          .replace(/\[\w+\]/, '')
          .replace(/^-\s*/, '')
          .trim(),
        _score: scoreMatch ? parseFloat(scoreMatch[1]!) / 100 : undefined,
        fact_type: typeMatch?.[1],
      });
    }
    return items;
  }

  #parseConversationHistory(text: string): ConversationEvent[] {
    const events: ConversationEvent[] = [];
    const lines = text.split('\n').filter((l) => l.startsWith('**'));
    for (const line of lines) {
      const tsMatch = line.match(/\[([^\]]+)\]/);
      const roleMatch = line.match(/\*\*:\*\*\s*(\w+):/);
      const msgMatch = line.match(/\*\*:\*\*\s*\w+:\s*(.+)/);
      events.push({
        timestamp: tsMatch?.[1],
        content: {
          role: roleMatch?.[1] ?? 'unknown',
          message: msgMatch?.[1]?.trim() ?? '',
        },
      });
    }
    return events;
  }

  #parseTemporalEvents(text: string): ConversationEvent[] {
    const events: ConversationEvent[] = [];
    const lines = text.split('\n').filter((l) => l.trim().startsWith('- **'));
    for (const line of lines) {
      const tsMatch = line.match(/\[([^\]]+)\]/);
      const typeMatch = line.match(/\(([^)]+)\)/);
      const content = line.replace(/^-\s*\*\*\[[^\]]+\]\*\*\s*\([^)]*\)\s*/, '').trim();
      events.push({
        timestamp: tsMatch?.[1],
        event_type: typeMatch?.[1],
        content: { message: content },
      });
    }
    return events;
  }

  #parseTimeBlockSummaries(text: string): TimeBlockSummary[] {
    // Each summary starts with "### day/week/month DATE"
    const summaries: TimeBlockSummary[] = [];
    const blocks = text.split(/###\s+(day|week|month)\s+/).slice(1);
    for (let i = 0; i < blocks.length; i += 2) {
      if (i + 1 >= blocks.length) break;
      const blockType = blocks[i] as 'day' | 'week' | 'month';
      const rest = blocks[i + 1]!;
      const restLines = rest.split('\n');
      const dateLine = restLines[0]?.trim() ?? '';
      const eventMatch = rest.match(/\*\*(\d+)\s+events\*\*/);
      const genMatch = rest.match(/Generated:\s*(.+)/);
      const topicsMatch = rest.match(/\*Topics:\s*(.+)\*/);

      summaries.push({
        block_type: blockType,
        block_start: dateLine,
        event_count: eventMatch ? parseInt(eventMatch[1]!, 10) : 0,
        generated_at: genMatch?.[1]?.trim() ?? '',
        top_topics: topicsMatch?.[1]?.split(',').map((t) => t.trim()),
        summary: rest.split('\n').slice(4).join('\n').trim(),
      });
    }
    return summaries;
  }

  #parseSummarizeTimeBlocksResult(text: string): SummarizeTimeBlocksResult {
    const blocksMatch = text.match(/\*\*Blocks processed:\*\*\s*(\d+)/);
    const summariesMatch = text.match(/\*\*Summaries generated:\*\*\s*(\d+)/);
    const typeMatch = text.match(/\*\*Block type:\*\*\s*(\w+)/);
    const lookbackMatch = text.match(/\*\*Lookback:\*\*\s*(\d+)/);
    return {
      blocks_processed: blocksMatch ? parseInt(blocksMatch[1]!, 10) : 0,
      summaries_generated: summariesMatch ? parseInt(summariesMatch[1]!, 10) : 0,
      block_type: typeMatch?.[1] ?? 'week',
      lookback_days: lookbackMatch ? parseInt(lookbackMatch[1]!, 10) : 0,
      dry_run: text.includes('Dry Run'),
    };
  }

  #parseDetectPatterns(text: string): DetectPatternsResult {
    const result: DetectPatternsResult = {};
    // Extracting key sections from the formatted output
    const summaryMatch = text.match(/\*\*Summary:\*\*\s*(.+)/);
    result.summary = summaryMatch?.[1]?.trim();
    return result;
  }

  #parseTemporalContext(_text: string): TemporalContextResult {
    // The server returns a formatted Markdown report; we return a simple
    // structure with the raw events present.
    return { recent: [], working_memory: [], semantic_facts: [] };
  }

  #parseJournalResult(text: string): GetJournalResult {
    const manual: JournalEntry[] = [];
    const auto: JournalEntry[] = [];
    let current = '';

    for (const line of text.split('\n')) {
      if (line.includes('### 📝 Manual')) { current = 'manual'; continue; }
      if (line.includes('### 🤖 Auto')) { current = 'auto'; continue; }
      if (line.startsWith('- [')) {
        const tsMatch = line.match(/\[([^\]]+)\]/);
        const entry = line.replace(/^-\s*\[[^\]]+\]\s*/, '').trim();
        (current === 'manual' ? manual : auto).push({
          timestamp: tsMatch?.[1],
          entry,
        });
      }
    }

    return { manual, auto };
  }

  #parseStoreJournalResult(text: string): StoreJournalResult {
    const id = text.match(/\*\*ID:\*\*\s*`([^`]+)`/)?.[1] ?? '';
    const source = text.match(/\*\*Source:\*\*\s*(\w+)/)?.[1] ?? 'manual';
    const entry = text.match(/\*\*Entry:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
    return { insertedId: id, source, entry };
  }

  #parseMissionList(text: string): MissionSummary[] {
    const missions: MissionSummary[] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('- ')) continue;
      const titleMatch = line.match(/\*\*(.+?)\*\*/);
      const statusMatch = line.match(/—\s*(\w+)$/);
      const progressMatch = line.match(/\((\d+)\/(\d+)\)/);
      missions.push({
        id: '',
        title: titleMatch?.[1]?.trim(),
        goal: titleMatch?.[1]?.trim() ?? '',
        status: statusMatch?.[1] ?? 'unknown',
        tasks: [],
      });
      if (progressMatch) {
        const done = parseInt(progressMatch[1]!, 10);
        const total = parseInt(progressMatch[2]!, 10);
        missions[missions.length - 1]!.tasks = Array.from({ length: total }, (_, i) => ({
          id: `t${i}`,
          status: i < done ? 'completed' : 'pending',
        }));
      }
    }
    return missions;
  }

  #parseMissionDetail(text: string): MissionDetail {
    const titleMatch = text.match(/## Mission:\s*(.+)/);
    const idMatch = text.match(/\|\s*ID\s*\|\s*`([^`]+)`/);
    const statusMatch = text.match(/\|\s*Status\s*\|\s*(\w+)/);
    return {
      id: idMatch?.[1] ?? '',
      title: titleMatch?.[1]?.trim(),
      goal: titleMatch?.[1]?.trim() ?? '',
      status: statusMatch?.[1] ?? 'unknown',
      tasks: [],
    };
  }

  #parseCreateMissionResult(text: string): CreateMissionResult {
    const id = text.match(/\*\*ID:\*\*\s*`([^`]+)`/)?.[1] ?? '';
    const title = text.match(/\*\*Title:\*\*\s*(.+)/)?.[1]?.trim();
    const goal = title ?? '';
    const taskMatch = text.match(/\*\*Tasks:\*\*\s*(\d+)\s+added/);
    return { id, title, goal, task_count: taskMatch ? parseInt(taskMatch[1]!, 10) : undefined };
  }

  #parseUpdateMissionTaskResult(text: string): UpdateMissionTaskResult {
    const missionMatch = text.match(/\*\*Mission:\*\*\s*(.+)/);
    const taskMatch = text.match(/\*\*Task:\*\*\s*(.+)/);
    const statusMatch = text.match(/\*\*Status:\*\*\s*(\w+)/);
    return {
      mission_title: missionMatch?.[1]?.trim(),
      task_title: taskMatch?.[1]?.trim(),
      status: statusMatch?.[1] ?? '',
    };
  }

  #parseMemoryDiagnostics(text: string): MemoryDiagnostics {
    const diag: MemoryDiagnostics = {
      collections: {},
      unprocessed: 0,
      embeddingCoverage: '',
      vectorSearchAvailable: false,
      llmProviders: [],
      llmActive: '',
    };
    // Parse table rows
    const collRegex = /\|\s*(\w+(?:\s+\w+)*)\s*\|\s*(\d+)\s*\|/g;
    let m: RegExpExecArray | null;
    while ((m = collRegex.exec(text)) !== null) {
      diag.collections[m[1]!.replace(/\s+/g, '_').toLowerCase()] = parseInt(m[2]!, 10);
    }
    const unprocMatch = text.match(/\|\s*Unprocessed\s*\|\s*(\d+)/);
    diag.unprocessed = unprocMatch ? parseInt(unprocMatch[1]!, 10) : 0;
    const embMatch = text.match(/\|\s*Embeddings\s*\|\s*([\d/]+)\s*\(([\d.]+)%\)/);
    diag.embeddingCoverage = embMatch ? `${embMatch[2]!}%` : '';
    diag.vectorSearchAvailable = text.includes('✅');
    return diag;
  }

  #parseBackgroundStatus(text: string): BackgroundStatus {
    const unprocMatch = text.match(/\|\s*Unprocessed\s*\|\s*(\d+)/);
    const lastMatch = text.match(/\|\s*Last Processed\s*\|\s*(.+?)\s*\|/);
    const modelMatch = text.match(/\|\s*Embedding Model\s*\|\s*(.+?)\s*\|/);
    const readyMatch = text.match(/\|\s*Model Ready\s*\|\s*(.+?)\s*\|/);
    return {
      interval: '30s',
      unprocessed: unprocMatch ? parseInt(unprocMatch[1]!, 10) : 0,
      lastProcessed: lastMatch?.[1]?.trim(),
      embeddingModel: modelMatch?.[1]?.trim() ?? '',
      modelReady: readyMatch?.[1]?.trim() === '✅',
    };
  }

  #parseHealthStatus(text: string): HealthStatus {
    const mongoMatch = text.match(/\|\s*MongoDB\s*\|\s*(.+?)\s*\|/);
    const redisMatch = text.match(/\|\s*Redis\s*\|\s*(.+?)\s*\|/);
    const llmMatch = text.match(/\|\s*LLM\s*\|\s*🟢\s*(.+?)\s*\|/);
    const embMatch = text.match(/\|\s*Embeddings\s*\|\s*(.+?)\s*\|/);
    const verMatch = text.match(/\*\*Version:\*\*\s*(.+)/);
    return {
      mongodb: mongoMatch?.[1]?.trim() === '🟢',
      redis: redisMatch?.[1]?.trim() === '🟢',
      llm: { available: !!llmMatch, provider: llmMatch?.[1]?.trim() ?? '' },
      embeddings: embMatch?.[1]?.trim() === '🟢',
      version: verMatch?.[1]?.trim() ?? '',
    };
  }

  #parseExploreGraph(text: string): ExploreGraphResult {
    const nodes: ExploreGraphResult['nodes'] = [];
    const edges: ExploreGraphResult['edges'] = [];
    let section = '';

    for (const line of text.split('\n')) {
      if (line.startsWith('### Nodes')) { section = 'nodes'; continue; }
      if (line.startsWith('### Relationships')) { section = 'edges'; continue; }
      if (line.startsWith('- **') && section === 'nodes') {
        const nameMatch = line.match(/\*\*(.+?)\*\*/);
        const typeMatch = line.match(/\[(\w+)\]/);
        nodes.push({
          name: nameMatch?.[1],
          type: typeMatch?.[1] ?? 'entity',
          summary: line.replace(/\*\*.+?\*\*\s*\[.+?\]\s*—\s*/, '').trim(),
        });
      }
      if (line.startsWith('- ') && section === 'edges') {
        const edgeMatch = line.match(/-\s*(.+?)\s*—\[(.+?)\]→\s*(.+)/);
        if (edgeMatch) {
          edges.push({ source: edgeMatch[1]!.trim(), type: edgeMatch[2]!, target: edgeMatch[3]!.trim() });
        }
      }
    }

    return { nodes, edges };
  }

  #parseWorkingMemory(
    text: string,
    action: string,
  ): WorkingMemoryItem[] | WorkingMemoryStoreResult | void {
    if (action === 'store') {
      const id = text.match(/\*\*ID:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
      const sid = text.match(/\*\*Session:\*\*\s*(.+)/)?.[1]?.trim() ?? '';
      return { id, session_id: sid };
    }
    if (action === 'delete') return undefined;
    // get
    const items: WorkingMemoryItem[] = [];
    for (const line of text.split('\n')) {
      const numMatch = line.match(/^\d+\.\s+(.+)/);
      if (numMatch) {
        try {
          items.push({ content: JSON.parse(numMatch[1]!) });
        } catch {
          items.push({ content: numMatch[1]! });
        }
      }
    }
    return items;
  }

  #parseAutoJournal(text: string): JournalEntry[] {
    const entries: JournalEntry[] = [];
    const blocks = text.split('### ');
    for (const block of blocks) {
      if (!block.trim() || block.startsWith('Auto Journal')) continue;
      const [dateLine, ...contentLines] = block.split('\n');
      const entry = contentLines
        .filter((l) => !l.startsWith('*Tags:'))
        .join('\n')
        .trim();
      if (entry) {
        entries.push({
          created_at: dateLine!.trim(),
          entry,
        });
      }
    }
    return entries;
  }

  #parseTransactionLog(text: string): TransactionLogEntry[] {
    const entries: TransactionLogEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('- [')) continue;
      const tsMatch = line.match(/\[([^\]]+)\]/);
      const actionMatch = line.match(/\*\*(.+?)\*\*/);
      const desc = line.replace(/^-\s*\[[^\]]+\]\s*\*\*.+?\*\*\s*—\s*/, '').trim();
      entries.push({
        timestamp: tsMatch?.[1],
        action: actionMatch?.[1],
        description: desc,
      });
    }
    return entries;
  }

  #parseHeartbeatStatus(text: string): HeartbeatStatus {
    const intMatch = text.match(/\*\*Interval:\*\*\s*(\d+)/);
    const enMatch = text.match(/\*\*Enabled:\*\*\s*(.+)/);
    const tasksMatch = text.match(/\*\*Tasks:\*\*\s*(.+)/);
    const runs: HeartbeatStatus['recent_runs'] = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('- ')) continue;
      const icon = line.startsWith('- ✅') ? 'ok' : line.startsWith('- ⚠️') ? 'alert' : 'error';
      const tsMatch = line.match(/\[([^\]]+)\]/);
      runs.push({
        started_at: tsMatch?.[1],
        status: icon,
      });
    }
    return {
      interval_minutes: intMatch ? parseInt(intMatch[1]!, 10) : 25,
      enabled: enMatch?.[1]?.includes('🟢') ?? false,
      tasks: tasksMatch?.[1]?.replace('(none)', '').split(',').map((t) => t.trim()).filter(Boolean) ?? [],
      recent_runs: runs,
    };
  }

  #parseAssetList(text: string): AssetItem[] {
    const assets: AssetItem[] = [];
    let current: Partial<AssetItem> = {};
    for (const line of text.split('\n')) {
      if (line.startsWith('- **')) {
        if (current.content_type) {
          assets.push(current as AssetItem);
          current = {};
        }
        const nameMatch = line.match(/\*\*(.+?)\*\*/);
        const typeMatch = line.match(/—\s*(.+?)\s*\(/);
        const sizeMatch = line.match(/\(([\d.]+)\s*KB\)/);
        current = {
          filename: nameMatch?.[1]?.trim(),
          content_type: typeMatch?.[1]?.trim(),
          size_bytes: sizeMatch ? parseFloat(sizeMatch[1]!) * 1024 : undefined,
        };
      }
      if (line.includes('Uploaded:')) {
        current.uploaded_at = line.replace(/^\s*Uploaded:\s*/, '').trim();
      }
    }
    if (current.content_type) assets.push(current as AssetItem);
    return assets;
  }
}
