/**
 * Cross-Session Integration Service
 * 
 * Enhances memory retrieval by automatically surfacing relevant memories
 * from other sessions when a user asks questions in a new session.
 */

import { get_database } from '../database/connection.js';
import { MemoryManager } from './memory-manager.js';
import type { EpisodicEvent, SemanticFact, KnowledgeNode } from '../types/memory.js';

export interface CrossSessionContext {
  userId: string;
  currentSessionId: string;
  userQuery: string;
  relevanceThreshold: number;
  maxResultsPerType: number;
}

export interface CrossSessionResult {
  episodicMemories: EpisodicEvent[];
  semanticFacts: SemanticFact[];
  knowledgeNodes: KnowledgeNode[];
  sessionMappings: SessionMapping[];
  confidenceScore: number;
  totalMatches: number;
}

export interface SessionMapping {
  sessionId: string;
  sessionName?: string;
  matchCount: number;
  lastActivity: Date;
  topTopics: string[];
}

class CrossSessionIntegrator {
  private memoryManager = MemoryManager.get_instance();
  
  /**
   * Find relevant memories from other user sessions
   */
  async findCrossSessionMemories(context: CrossSessionContext): Promise<CrossSessionResult> {
    console.log('🔄 Cross-session memory search:', {
      userId: context.userId,
      currentSession: context.currentSessionId.slice(-12),
      query: context.userQuery.substring(0, 50) + '...'
    });

    const db = get_database();
    const startTime = Date.now();

    try {
      // Extract search terms from user query
      const searchTerms = this.extractSearchTerms(context.userQuery);
      
      // Build comprehensive search across all user sessions
      const [episodicMemories, semanticFacts, knowledgeNodes] = await Promise.all([
        this.searchCrossSessionEpisodic(context, searchTerms),
        this.searchCrossSessionSemantic(context, searchTerms),
        this.searchCrossSessionKnowledge(context, searchTerms)
      ]);

      // Build session mappings
      const sessionMappings = await this.buildSessionMappings(
        context, 
        [...episodicMemories, ...semanticFacts]
      );

      const totalMatches = episodicMemories.length + semanticFacts.length + knowledgeNodes.length;
      const confidenceScore = this.calculateCrossSessionConfidence(
        episodicMemories,
        semanticFacts, 
        knowledgeNodes,
        searchTerms
      );

      const executionTime = Date.now() - startTime;

      console.log('✅ Cross-session search completed:', {
        episodicMatches: episodicMemories.length,
        semanticMatches: semanticFacts.length,
        knowledgeMatches: knowledgeNodes.length,
        sessionCount: sessionMappings.length,
        confidence: confidenceScore.toFixed(2),
        executionTime: `${executionTime}ms`
      });

      return {
        episodicMemories,
        semanticFacts,
        knowledgeNodes,
        sessionMappings,
        confidenceScore,
        totalMatches
      };

    } catch (error) {
      console.error('❌ Cross-session integration failed:', error);
      return {
        episodicMemories: [],
        semanticFacts: [],
        knowledgeNodes: [],
        sessionMappings: [],
        confidenceScore: 0,
        totalMatches: 0
      };
    }
  }

  /**
   * Search episodic memories across all user sessions
   */
  private async searchCrossSessionEpisodic(
    context: CrossSessionContext, 
    searchTerms: string[]
  ): Promise<EpisodicEvent[]> {
    const db = get_database();

    if (searchTerms.length === 0) return [];

    const searchPattern = searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    
    const query = {
      user_id: context.userId,
      session_id: { $ne: context.currentSessionId }, // Exclude current session
      $or: [
        { 'content.message': { $regex: searchPattern, $options: 'i' } },
        { content: { $regex: searchPattern, $options: 'i' } },
        { description: { $regex: searchPattern, $options: 'i' } }
      ],
      // Only substantive content
      $and: [
        { 'content.message_type': { $ne: 'metadata_only' } },
        { event_type: { $in: ['user_message', 'assistant_response'] } }
      ]
    };

    const results = await db.collection('episodic_events')
      .find(query)
      .sort({ timestamp: -1 })
      .limit(context.maxResultsPerType)
      .toArray();

    return results as unknown as EpisodicEvent[];
  }

  /**
   * Search semantic facts across user's history
   */
  private async searchCrossSessionSemantic(
    context: CrossSessionContext,
    searchTerms: string[]
  ): Promise<SemanticFact[]> {
    const db = get_database();

    if (searchTerms.length === 0) return [];

    const searchPattern = searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

    const query = {
      user_id: context.userId,
      $or: [
        { content: { $regex: searchPattern, $options: 'i' } },
        { description: { $regex: searchPattern, $options: 'i' } },
        { 'properties.summary': { $regex: searchPattern, $options: 'i' } }
      ]
    };

    const results = await db.collection('semantic_facts')
      .find(query)
      .sort({ confidence: -1, created_at: -1 })
      .limit(context.maxResultsPerType)
      .toArray();

    return results as unknown as SemanticFact[];
  }

  /**
   * Search knowledge nodes for related entities
   */
  private async searchCrossSessionKnowledge(
    context: CrossSessionContext,
    searchTerms: string[]
  ): Promise<KnowledgeNode[]> {
    const db = get_database();

    if (!context.userId) return [];
    if (searchTerms.length === 0) return [];

    const searchPattern = searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

    const query = {
      user_id: context.userId,
      $or: [
        { 'properties.name': { $regex: searchPattern, $options: 'i' } },
        { 'properties.description': { $regex: searchPattern, $options: 'i' } },
        { type: { $regex: searchPattern, $options: 'i' } }
      ]
    };

    const results = await db.collection('knowledge_nodes')
      .find(query)
      .sort({ updated_at: -1 })
      .limit(context.maxResultsPerType)
      .toArray();

    // Get connected nodes for richer context
    const enrichedResults: KnowledgeNode[] = [];
    for (const node of results) {
      enrichedResults.push(node as unknown as KnowledgeNode);
      
      // Get one level of connected nodes
      const connected = await this.memoryManager.get_connected_nodes(node.id, 1);
      enrichedResults.push(...connected.slice(0, 2)); // Max 2 connected per node
    }

    return enrichedResults.slice(0, context.maxResultsPerType);
  }

  /**
   * Build session mappings showing which sessions contain relevant information
   */
  private async buildSessionMappings(
    context: CrossSessionContext,
    relevantMemories: Array<EpisodicEvent | SemanticFact>
  ): Promise<SessionMapping[]> {
    const db = get_database();
    
    // Group memories by session
    const sessionGroups = new Map<string, { count: number; lastActivity: Date; topics: Set<string> }>();
    
    for (const memory of relevantMemories) {
      if ('session_id' in memory && memory.session_id) {
        const sessionId = memory.session_id;
        
        if (!sessionGroups.has(sessionId)) {
          sessionGroups.set(sessionId, {
            count: 0,
            lastActivity: new Date(0),
            topics: new Set()
          });
        }
        
        const group = sessionGroups.get(sessionId)!;
        group.count++;
        
        const timestamp = memory.timestamp || ('created_at' in memory ? memory.created_at : new Date());
        const dateTimestamp = timestamp instanceof Date ? timestamp : new Date(String(timestamp));
        if (dateTimestamp > group.lastActivity) {
          group.lastActivity = dateTimestamp;
        }
        
        // Extract topics from content
        const content = 'content' in memory ? memory.content : (memory as any).description || '';
        const topics = this.extractTopics(JSON.stringify(content));
        topics.forEach(topic => group.topics.add(topic));
      }
    }

    // Convert to SessionMapping objects
    const mappings: SessionMapping[] = [];
    for (const [sessionId, group] of sessionGroups) {
      mappings.push({
        sessionId,
        sessionName: this.generateSessionName(sessionId),
        matchCount: group.count,
        lastActivity: group.lastActivity,
        topTopics: Array.from(group.topics).slice(0, 5)
      });
    }

    // Sort by relevance (match count and recency)
    return mappings.sort((a, b) => {
      const scoreA = a.matchCount * 2 + (a.lastActivity.getTime() / 1000000);
      const scoreB = b.matchCount * 2 + (b.lastActivity.getTime() / 1000000);
      return scoreB - scoreA;
    });
  }

  /**
   * Calculate confidence score for cross-session results
   */
  private calculateCrossSessionConfidence(
    episodicMemories: EpisodicEvent[],
    semanticFacts: SemanticFact[],
    knowledgeNodes: KnowledgeNode[],
    searchTerms: string[]
  ): number {
    if (searchTerms.length === 0) return 0;

    const totalResults = episodicMemories.length + semanticFacts.length + knowledgeNodes.length;
    if (totalResults === 0) return 0;

    // Weight different memory types
    const episodicWeight = 0.4;
    const semanticWeight = 0.4; 
    const knowledgeWeight = 0.2;

    const episodicScore = Math.min(episodicMemories.length / 5, 1) * episodicWeight;
    const semanticScore = Math.min(semanticFacts.length / 3, 1) * semanticWeight;
    const knowledgeScore = Math.min(knowledgeNodes.length / 2, 1) * knowledgeWeight;

    return episodicScore + semanticScore + knowledgeScore;
  }

  /**
   * Extract search terms from user query
   */
  private extractSearchTerms(query: string): string[] {
    // Remove common stop words and extract meaningful terms
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      'from', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once',
      'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each',
      'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
      'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should',
      'now', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'them', 'their', 'what',
      'tell', 'me', 'do', 'know', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'having'
    ]);

    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 2 && !stopWords.has(term))
      .slice(0, 10); // Limit to top 10 terms
  }

  /**
   * Extract key topics from content
   */
  private extractTopics(content: string): string[] {
    const text = content.toLowerCase();
    
    // Common topic patterns
    const topicPatterns = [
      /\b(jaguar|e-type|car|vehicle|engine|restoration)\b/g,
      /\b(cylinder|head|porting|performance|tuning)\b/g,
      /\b(reddit|marketing|automation|campaign)\b/g,
      /\b(techcorp|dataflow|partnership|business)\b/g,
      /\b(sarah|wilson|person|people|team)\b/g
    ];

    const topics = new Set<string>();
    
    for (const pattern of topicPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => topics.add(match));
      }
    }

    return Array.from(topics);
  }

  /**
   * Generate a human-readable session name
   */
  private generateSessionName(sessionId: string): string {
    const timestamp = sessionId.includes('-') ? 
      sessionId.split('-').pop() : 
      sessionId.slice(-13);
    
    if (timestamp && !isNaN(Number(timestamp))) {
      const date = new Date(Number(timestamp));
      return `Session ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    
    return `Session ${sessionId.slice(-8)}`;
  }

  /**
   * Get user's session history for context
   */
  async getUserSessionHistory(userId: string, limit = 20): Promise<SessionMapping[]> {
    const db = get_database();
    
    const sessions = await db.collection('episodic_events').aggregate([
      { $match: { user_id: userId } },
      {
        $group: {
          _id: '$session_id',
          lastActivity: { $max: '$timestamp' },
          messageCount: { $sum: 1 },
          topics: { $push: '$content.message' }
        }
      },
      { $sort: { lastActivity: -1 } },
      { $limit: limit }
    ]).toArray();

    return sessions.map(session => ({
      sessionId: session._id,
      sessionName: this.generateSessionName(session._id),
      matchCount: session.messageCount,
      lastActivity: session.lastActivity,
      topTopics: this.extractTopics(session.topics.join(' ')).slice(0, 3)
    }));
  }
}

export const crossSessionIntegrator = new CrossSessionIntegrator();