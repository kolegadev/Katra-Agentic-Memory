/**
 * Katra SDK for TypeScript
 *
 * Typed client for the Katra Cognitive Memory server.
 * Provides access to all 29 MCP tools via a clean async API.
 *
 * @example
 * ```ts
 * import { KatraClient } from '@katra/sdk';
 *
 * const katra = new KatraClient({ url: 'http://localhost:3112' });
 *
 * // Store a memory
 * await katra.storeMemory({ content: 'User likes dark mode', category: 'preference' });
 *
 * // Search
 * const results = await katra.searchMemories({ query: 'dark mode' });
 *
 * // Health check
 * const health = await katra.getHealth();
 * console.log(health);
 * ```
 *
 * @module @katra/sdk
 */

export { KatraClient } from './client.js';

// Re-export error classes for consumers who want to catch specific errors
export {
  KatraError,
  KatraAuthError,
  KatraConnectionError,
} from './errors.js';

// Re-export the low-level MCP client for advanced usage
export { MCPClient } from './mcp-client.js';
export type { MCPClientOptions } from './mcp-client.js';

// Re-export all types
export type {
  // Protocol
  MCPRequest,
  MCPResponse,
  MCPError,
  MCPInitializeResult,

  // Client config
  KatraClientOptions,

  // Core Memory
  StoreMemoryParams,
  StoreMemoryResult,
  SearchMemoriesParams,
  SearchMemoriesResult,
  SearchMemoryItem,
  VectorSearchParams,
  VectorSearchItem,
  GetConversationHistoryParams,
  ConversationEvent,

  // Temporal Memory
  TemporalRecallParams,
  TemporalSearchParams,
  TimeBlockSummariesParams,
  TimeBlockSummary,
  SummarizeTimeBlocksParams,
  SummarizeTimeBlocksResult,
  DetectPatternsParams,
  DetectPatternsResult,
  RecurringTopic,
  SessionRhythm,
  TopicRegression,
  DormantTopic,
  TemporalContextParams,
  TemporalContextResult,

  // Journal
  GetJournalParams,
  GetJournalResult,
  JournalEntry,
  StoreJournalParams,
  StoreJournalResult,

  // Missions
  ListMissionsParams,
  MissionSummary,
  MissionTask,
  GetMissionParams,
  MissionDetail,
  CreateMissionParams,
  CreateMissionResult,
  UpdateMissionTaskParams,
  UpdateMissionTaskResult,

  // Diagnostics
  GetMemoryDiagnosticsParams,
  MemoryDiagnostics,
  BackgroundStatus,
  HealthStatus,

  // Knowledge Graph
  ExploreGraphParams,
  ExploreGraphResult,
  GraphNode,
  GraphEdge,

  // Working Memory
  WorkingMemoryParams,
  WorkingMemoryItem,
  WorkingMemoryStoreResult,

  // Auto Journal
  GetAutoJournalParams,

  // Transaction Log
  GetTransactionLogParams,
  TransactionLogEntry,

  // Heartbeat
  HeartbeatStatus,
  HeartbeatRun,

  // Assets
  ListAssetsParams,
  AssetItem,
} from './types.js';
