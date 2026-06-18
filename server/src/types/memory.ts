/**
 * Core memory system type definitions
 */

// Episodic Memory Types
export interface EpisodicEvent {
  id?: string;
  session_id: string;
  user_id: string;
  event_type: string;
  content: Record<string, any>;
  metadata?: Record<string, any>;
  correlation_id?: string;
  timestamp: Date;
  embedding?: number[];
  embedding_model?: string;
  embedding_version?: number;
}

export interface SessionStats {
  session_id: string;
  event_count: number;
  first_event: Date;
  last_event: Date;
  unique_event_types: string[];
}

// Knowledge Graph Types
export interface KnowledgeNode {
  id: string;
  type: string;
  properties: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface KnowledgeRelationship {
  from_id: string;
  to_id: string;
  relationship_type: string;
  properties?: Record<string, any>;
  strength?: number;
  created_at: Date;
}

// Working Memory Types
export interface WorkingMemorySession {
  session_id: string;
  user_id: string;
  state: Record<string, any>;
  last_accessed: Date;
  expires_at?: Date;
}

export interface SemanticFact {
  id?: string;
  user_id: string;
  content: string;
  source: string;
  confidence: number;
  metadata?: Record<string, any>;
  created_at: Date;
  embedding?: number[];
  embedding_model?: string;
  embedding_version?: number;
}

// Asset Storage Types
export interface AssetMetadata {
  id: string;
  user_id: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  size: number;
  hash: string;
  metadata?: Record<string, any>;
  version?: number;
  created_at: Date;
  updated_at: Date;
}

// System Health Types
export interface MemorySystemHealth {
  episodic_memory: {
    status: 'healthy' | 'degraded' | 'unavailable';
    mongodb_connected: boolean;
    total_events: number;
  };
  knowledge_graph: {
    status: 'healthy' | 'degraded' | 'unavailable';
    mongodb_connected: boolean;
    total_nodes: number;
    total_relationships: number;
  };
  working_memory: {
    status: 'healthy' | 'degraded' | 'unavailable';
    redis_connected: boolean;
    active_sessions: number;
  };
  asset_storage: {
    status: 'healthy' | 'degraded' | 'unavailable';
    s3_connected: boolean;
    total_assets: number;
  };
}