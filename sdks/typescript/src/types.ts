/**
 * Katra SDK — TypeScript Type Definitions
 *
 * Covers all request parameters and response shapes for the 29 MCP tools
 * exposed by the Katra cognitive memory server, plus MCP protocol types.
 *
 * @module types
 */

// ── MCP Protocol ───────────────────────────────────────────────────

/** JSON-RPC 2.0 request envelope. */
export interface MCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response envelope (success). */
export interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: MCPError;
}

/** JSON-RPC 2.0 error. */
export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

/** MCP initialize result. */
export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: {
    name: string;
    version: string;
  };
}

// ── KatraClient Config ─────────────────────────────────────────────

/** Constructor options for `KatraClient`. */
export interface KatraClientOptions {
  /** Base URL of the Katra MCP server (e.g. `http://localhost:3112`). */
  url: string;
  /** API key for authentication. */
  apiKey?: string;
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetch?: typeof fetch;
  /** AbortSignal for cancelling all requests. */
  signal?: AbortSignal;
}

// ── Tool Parameter Types ───────────────────────────────────────────

// -- Core Memory --

export interface StoreMemoryParams {
  /** The memory content (required). */
  content: string;
  /** Optional user ID. */
  user_id?: string;
  /** Category: fact, preference, insight, event, or general. */
  category?: 'fact' | 'preference' | 'insight' | 'event' | 'general';
  /** Confidence score 0–1 (default 0.8). */
  confidence?: number;
}

export interface StoreMemoryResult {
  insertedId: string;
  content: string;
  category: string;
  confidence: number;
}

export interface SearchMemoriesParams {
  /** Search query (required). */
  query: string;
  /** Optional user ID filter. */
  user_id?: string;
  /** Max results 1–50 (default 10). */
  limit?: number;
}

export interface SearchMemoryItem {
  timestamp?: string;
  content: string | { message?: string; role?: string; [key: string]: unknown };
  confidence?: number;
  category?: string;
  [key: string]: unknown;
}

export interface SearchMemoriesResult {
  episodic: SearchMemoryItem[];
  semantic: SearchMemoryItem[];
}

export interface VectorSearchParams {
  /** Search query (required). */
  query: string;
  /** Optional user ID. */
  user_id?: string;
  /** Max results 1–20 (default 10). */
  limit?: number;
}

export interface VectorSearchItem {
  content: string;
  _score?: number;
  fact_type?: string;
  embedding?: number[];
  [key: string]: unknown;
}

export interface GetConversationHistoryParams {
  /** Session ID (required). */
  session_id: string;
  /** Max events (default 20). */
  limit?: number;
}

export interface ConversationEvent {
  timestamp?: string;
  content?: {
    role?: string;
    message?: string;
    [key: string]: unknown;
  };
  event_type?: string;
  [key: string]: unknown;
}

// -- Temporal Memory --

export interface TemporalRecallParams {
  /** User ID (required). */
  user_id: string;
  /** ISO 8601 start date (defaults to 24h ago). */
  from?: string;
  /** ISO 8601 end date (defaults to now). */
  to?: string;
  /** Max events 1–200 (default 50). */
  limit?: number;
  /** Optional event type filter. */
  event_type?: string;
  /** Optional role filter. */
  role?: 'user' | 'assistant';
}

export interface TemporalSearchParams {
  /** User ID (required). */
  user_id: string;
  /** Keyword query (required). */
  query: string;
  /** Max results (default 20). */
  limit?: number;
}

export interface TimeBlockSummariesParams {
  /** User ID (required). */
  user_id: string;
  /** ISO 8601 start date (defaults to 30 days ago). */
  from?: string;
  /** ISO 8601 end date (defaults to now). */
  to?: string;
  /** Time block granularity. */
  block_type?: 'day' | 'week' | 'month';
  /** Max summaries (default 20). */
  limit?: number;
}

export interface TimeBlockSummary {
  block_type: 'day' | 'week' | 'month';
  block_start: string;
  event_count: number;
  generated_at: string;
  top_topics?: string[];
  summary: string;
  [key: string]: unknown;
}

export interface SummarizeTimeBlocksParams {
  /** User ID (required). */
  user_id: string;
  /** Time block granularity (default: week). */
  block_type?: 'day' | 'week' | 'month';
  /** Days to look back 1–365 (default 90). */
  lookback_days?: number;
  /** Max blocks 1–52 (default 20). */
  max_blocks?: number;
  /** Preview without storing (default false). */
  dry_run?: boolean;
}

export interface SummarizeTimeBlocksResult {
  blocks_processed: number;
  summaries_generated: number;
  block_type: string;
  lookback_days: number;
  dry_run: boolean;
}

export interface DetectPatternsParams {
  /** User ID (required). */
  user_id: string;
  /** Weeks to analyze 1–52 (default 12). */
  lookback_weeks?: number;
  /** Min confidence 0–1 (default 0.5). */
  min_confidence?: number;
  /** Dormant threshold in days 1–365 (default 14). */
  dormant_threshold_days?: number;
}

export interface RecurringTopic {
  topic: string;
  day_of_week: string;
  occurrences: number;
  total_weeks: number;
}

export interface SessionRhythm {
  most_active_days: Array<{ day: string; count: number }>;
  [key: string]: unknown;
}

export interface TopicRegression {
  current_topic: string;
  similar_past_topic: string;
  days_ago: number;
}

export interface DormantTopic {
  topic: string;
  days_since: number;
  total_discussions: number;
}

export interface DetectPatternsResult {
  recurring_topics?: RecurringTopic[];
  session_rhythm?: SessionRhythm;
  topic_regressions?: TopicRegression[];
  dormant_topics?: DormantTopic[];
  summary?: string;
}

export interface TemporalContextParams {
  /** User ID (required). */
  user_id: string;
  /** Session ID for context recovery (required). */
  session_id: string;
}

export interface TemporalContextResult {
  recent: ConversationEvent[];
  working_memory: unknown[];
  semantic_facts: SearchMemoryItem[];
}

// -- Journal --

export interface GetJournalParams {
  /** User ID (required). */
  user_id: string;
  /** Source filter: auto, manual, or all (default all). */
  source?: 'auto' | 'manual' | 'all';
  /** Max entries (default 20). */
  limit?: number;
}

export interface JournalEntry {
  timestamp?: string;
  text?: string;
  entry?: string;
  source?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface GetJournalResult {
  manual: JournalEntry[];
  auto: JournalEntry[];
}

export interface StoreJournalParams {
  /** User ID (required). */
  user_id: string;
  /** Journal entry text (required). */
  entry: string;
  /** Source: manual or system (default manual). */
  source?: 'manual' | 'system';
  /** Optional tags. */
  tags?: string[];
}

export interface StoreJournalResult {
  insertedId: string;
  source: string;
  entry: string;
}

// -- Missions --

export interface ListMissionsParams {
  /** User ID (required). */
  user_id: string;
  /** Max missions (default 10). */
  limit?: number;
}

export interface MissionTask {
  id: string;
  title?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  created_at?: string;
  updated_at?: string;
}

export interface MissionSummary {
  id: string;
  title?: string;
  goal: string;
  status: string;
  tasks?: MissionTask[];
  [key: string]: unknown;
}

export interface GetMissionParams {
  /** User ID (required). */
  user_id: string;
  /** Mission ID (required). */
  mission_id: string;
}

export interface MissionDetail extends MissionSummary {
  self_journal?: Array<{ timestamp: string; text: string }>;
}

export interface CreateMissionParams {
  /** User ID (required). */
  user_id: string;
  /** Mission goal (required). */
  goal: string;
  /** Optional title (defaults to goal). */
  title?: string;
  /** Optional initial task titles. */
  tasks?: string[];
}

export interface CreateMissionResult {
  id: string;
  title?: string;
  goal: string;
  task_count?: number;
}

export interface UpdateMissionTaskParams {
  /** User ID (required). */
  user_id: string;
  /** Mission ID (required). */
  mission_id: string;
  /** Task ID (required). */
  task_id: string;
  /** New status. */
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

export interface UpdateMissionTaskResult {
  mission_title?: string;
  task_title?: string;
  status: string;
}

// -- Diagnostics --

export interface GetMemoryDiagnosticsParams {
  /** Optional user ID filter. */
  user_id?: string;
}

export interface MemoryDiagnostics {
  collections: Record<string, number>;
  unprocessed: number;
  embeddingCoverage: string;
  vectorSearchAvailable: boolean;
  llmProviders: string[];
  llmActive: string;
}

export interface BackgroundStatus {
  interval: string;
  unprocessed: number;
  lastProcessed?: string;
  embeddingModel: string;
  modelReady: boolean;
  backlogWarning?: string;
}

export interface HealthStatus {
  mongodb: boolean;
  redis: boolean;
  llm: { available: boolean; provider: string };
  embeddings: boolean;
  version: string;
}

// -- Knowledge Graph --

export interface ExploreGraphParams {
  /** Optional keyword filter for nodes. */
  query?: string;
  /** Max nodes (default 20). */
  limit?: number;
  /** Include relationships (default true). */
  include_edges?: boolean;
}

export interface GraphNode {
  name?: string;
  _id?: string;
  type?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  type?: string;
  [key: string]: unknown;
}

export interface ExploreGraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// -- Working Memory --

export interface WorkingMemoryParams {
  /** Session ID (required). */
  session_id: string;
  /** Action: get, store, or delete. */
  action: 'get' | 'store' | 'delete';
  /** Content to store (required for store). */
  content?: string;
  /** Max items for get (default 10). */
  limit?: number;
}

export interface WorkingMemoryItem {
  content: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkingMemoryStoreResult {
  id: string;
  session_id: string;
}

// -- Auto Journal --

export interface GetAutoJournalParams {
  /** User ID (required). */
  user_id: string;
  /** Max entries (default 20). */
  limit?: number;
  /** ISO 8601 date to filter after. */
  since?: string;
}

// -- Transaction Log --

export interface GetTransactionLogParams {
  /** Optional user ID filter. */
  user_id?: string;
  /** Optional action type filter (e.g. heartbeat_run). */
  action?: string;
  /** Max entries (default 50). */
  limit?: number;
  /** ISO 8601 date to filter after. */
  since?: string;
}

export interface TransactionLogEntry {
  timestamp?: string;
  action?: string;
  type?: string;
  description?: string;
  summary?: string;
  [key: string]: unknown;
}

// -- Heartbeat --

export interface HeartbeatRun {
  started_at?: string;
  status: 'ok' | 'alert' | 'error';
  tasks_due?: string[];
  [key: string]: unknown;
}

export interface HeartbeatStatus {
  interval_minutes: number;
  enabled: boolean;
  tasks: string[];
  recent_runs: HeartbeatRun[];
}

// -- Assets --

export interface ListAssetsParams {
  /** Optional user ID filter. */
  user_id?: string;
  /** Optional MIME type prefix filter (e.g. 'image/'). */
  content_type?: string;
  /** Max assets (default 20). */
  limit?: number;
}

export interface AssetItem {
  filename?: string;
  original_name?: string;
  name?: string;
  _id?: string;
  content_type?: string;
  size_bytes?: number;
  uploaded_at?: string;
  created_at?: string;
  [key: string]: unknown;
}
