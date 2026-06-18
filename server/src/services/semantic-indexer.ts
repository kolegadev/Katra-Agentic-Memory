/**
 * Enhanced Semantic Indexing Service
 * 
 * Improves semantic search with better indexing, similarity matching,
 * and context-aware retrieval for more accurate memory recall.
 */

import { get_database } from '../database/connection.js';
import { MemoryManager } from './memory-manager.js';
import type { SemanticFact, KnowledgeNode, EpisodicEvent } from '../types/memory.js';

export interface SemanticIndex {
  id: string;
  content: string;
  contentType: 'episodic' | 'semantic' | 'knowledge';
  sourceId: string;
  userId: string;
  sessionId?: string;
  keywords: string[];
  concepts: string[];
  entities: string[];
  semanticVector?: number[]; // Future: actual embeddings
  confidence: number;
  created_at: Date;
  updated_at: Date;
}

export interface SemanticSearchContext {
  userId: string;
  query: string;
  contentTypes?: ('episodic' | 'semantic' | 'knowledge')[];
  maxResults?: number;
  similarityThreshold?: number;
  boostRecent?: boolean;
  sessionContext?: string;
}

export interface SemanticSearchResult {
  matches: SemanticMatch[];
  conceptClusters: ConceptCluster[];
  entityConnections: EntityConnection[];
  searchMetadata: SearchMetadata;
}

export interface SemanticMatch {
  sourceId: string;
  contentType: 'episodic' | 'semantic' | 'knowledge';
  content: string;
  similarityScore: number;
  relevanceScore: number;
  matchedKeywords: string[];
  matchedConcepts: string[];
  matchedEntities: string[];
  sessionId?: string;
  timestamp: Date;
}

export interface ConceptCluster {
  concept: string;
  relatedTerms: string[];
  matchCount: number;
  avgSimilarity: number;
  sessions: string[];
}

export interface EntityConnection {
  entity: string;
  connectedEntities: string[];
  relationshipTypes: string[];
  strength: number;
  occurrenceCount: number;
}

export interface SearchMetadata {
  totalMatches: number;
  executionTime: number;
  queryComplexity: number;
  indexCoverage: number;
  conceptCoverage: number;
}

class SemanticIndexer {
  private memoryManager = MemoryManager.get_instance();

  /**
   * Build comprehensive semantic search with enhanced indexing
   */
  async performSemanticSearch(context: SemanticSearchContext): Promise<SemanticSearchResult> {
    console.log('🔍 Enhanced semantic search:', {
      userId: context.userId,
      query: context.query.substring(0, 50) + '...',
      contentTypes: context.contentTypes || ['all'],
      maxResults: context.maxResults || 20
    });

    const startTime = Date.now();
    const db = get_database();

    try {
      // Extract semantic features from query
      const queryFeatures = await this.extractQueryFeatures(context.query);
      
      // Build enhanced search queries for different content types
      const searchPromises = [];
      const contentTypes = context.contentTypes || ['episodic', 'semantic', 'knowledge'];

      if (contentTypes.includes('episodic')) {
        searchPromises.push(this.searchEpisodicSemantic(context, queryFeatures));
      }
      
      if (contentTypes.includes('semantic')) {
        searchPromises.push(this.searchSemanticFacts(context, queryFeatures));
      }
      
      if (contentTypes.includes('knowledge')) {
        searchPromises.push(this.searchKnowledgeNodes(context, queryFeatures));
      }

      // Execute searches in parallel
      const searchResults = await Promise.all(searchPromises);
      const allMatches = searchResults.flat();

      // Post-process and enhance results
      const enhancedMatches = await this.enhanceMatches(allMatches, queryFeatures);
      
      // Build concept clusters
      const conceptClusters = this.buildConceptClusters(enhancedMatches);
      
      // Build entity connections
      const entityConnections = await this.buildEntityConnections(enhancedMatches);

      // Sort by relevance
      const sortedMatches = this.rankByRelevance(enhancedMatches, context);

      const executionTime = Date.now() - startTime;

      console.log('✅ Semantic search completed:', {
        totalMatches: sortedMatches.length,
        concepts: conceptClusters.length,
        entities: entityConnections.length,
        executionTime: `${executionTime}ms`
      });

      return {
        matches: sortedMatches.slice(0, context.maxResults || 20),
        conceptClusters: conceptClusters.slice(0, 10),
        entityConnections: entityConnections.slice(0, 10),
        searchMetadata: {
          totalMatches: sortedMatches.length,
          executionTime,
          queryComplexity: this.calculateQueryComplexity(queryFeatures),
          indexCoverage: this.calculateIndexCoverage(allMatches),
          conceptCoverage: conceptClusters.length / Math.max(queryFeatures.concepts.length, 1)
        }
      };

    } catch (error) {
      console.error('❌ Semantic search failed:', error);
      return {
        matches: [],
        conceptClusters: [],
        entityConnections: [],
        searchMetadata: {
          totalMatches: 0,
          executionTime: Date.now() - startTime,
          queryComplexity: 0,
          indexCoverage: 0,
          conceptCoverage: 0
        }
      };
    }
  }

  /**
   * Extract semantic features from query
   */
  private async extractQueryFeatures(query: string): Promise<{
    keywords: string[];
    concepts: string[];
    entities: string[];
    intent: string;
    complexity: number;
  }> {
    const text = query.toLowerCase();
    
    // Extract keywords (remove stop words)
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      'from', 'about', 'what', 'when', 'where', 'why', 'how', 'tell', 'me', 'you', 'i', 'is', 'are'
    ]);
    
    const keywords = text
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 20);

    // Extract technical concepts
    const concepts = this.extractConcepts(text);
    
    // Extract entities
    const entities = this.extractEntities(text);
    
    // Determine query intent
    const intent = this.determineQueryIntent(text);
    
    return {
      keywords,
      concepts,
      entities,
      intent,
      complexity: keywords.length + concepts.length + entities.length
    };
  }

  /**
   * Search episodic memories with semantic enhancement
   */
  private async searchEpisodicSemantic(
    context: SemanticSearchContext,
    queryFeatures: any
  ): Promise<SemanticMatch[]> {
    const db = get_database();
    
    // Build comprehensive search query
    const searchTerms = [
      ...queryFeatures.keywords,
      ...queryFeatures.concepts,
      ...queryFeatures.entities
    ];

    if (searchTerms.length === 0) return [];

    const searchPattern = searchTerms.join('|');
    
    const query = {
      user_id: context.userId,
      $or: [
        { 'content.message': { $regex: searchPattern, $options: 'i' } },
        { content: { $regex: searchPattern, $options: 'i' } },
        { description: { $regex: searchPattern, $options: 'i' } }
      ],
      event_type: { $in: ['user_message', 'assistant_response'] },
      'content.message_type': { $ne: 'metadata_only' }
    };

    // Add session context if provided
    if (context.sessionContext) {
      (query as any).session_id = { $ne: context.sessionContext }; // Exclude current session
    }

    const results = await db.collection('episodic_events')
      .find(query)
      .sort({ timestamp: -1 })
      .limit((context.maxResults || 20) * 2) // Get more for better ranking
      .toArray();

    return results.map(result => this.convertToSemanticMatch(
      result as unknown as EpisodicEvent,
      'episodic',
      queryFeatures
    ));
  }

  /**
   * Search semantic facts with concept matching
   */
  private async searchSemanticFacts(
    context: SemanticSearchContext,
    queryFeatures: any
  ): Promise<SemanticMatch[]> {
    const db = get_database();
    
    const searchTerms = [
      ...queryFeatures.keywords,
      ...queryFeatures.concepts,
      ...queryFeatures.entities
    ];

    if (searchTerms.length === 0) return [];

    const searchPattern = searchTerms.join('|');
    
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
      .limit((context.maxResults || 20) * 2)
      .toArray();

    return results.map(result => this.convertToSemanticMatch(
      result as unknown as SemanticFact,
      'semantic',
      queryFeatures
    ));
  }

  /**
   * Search knowledge nodes with entity relationship expansion
   */
  private async searchKnowledgeNodes(
    context: SemanticSearchContext,
    queryFeatures: any
  ): Promise<SemanticMatch[]> {
    const db = get_database();
    
    const searchTerms = [
      ...queryFeatures.keywords,
      ...queryFeatures.concepts,
      ...queryFeatures.entities
    ];

    if (searchTerms.length === 0) return [];

    const searchPattern = searchTerms.join('|');
    
    const query = {
      $or: [
        { 'properties.name': { $regex: searchPattern, $options: 'i' } },
        { 'properties.description': { $regex: searchPattern, $options: 'i' } },
        { type: { $regex: searchPattern, $options: 'i' } }
      ]
    };

    const results = await db.collection('knowledge_nodes')
      .find(query)
      .sort({ updated_at: -1 })
      .limit((context.maxResults || 20) * 2)
      .toArray();

    // Expand with connected nodes for richer context
    const expandedResults = [];
    for (const node of results) {
      expandedResults.push(node);
      
      // Get connected nodes
      const connected = await this.memoryManager.get_connected_nodes(node.id, 1);
      expandedResults.push(...connected.slice(0, 2));
    }

    return expandedResults.map(result => this.convertToSemanticMatch(
      result as unknown as KnowledgeNode,
      'knowledge',
      queryFeatures
    ));
  }

  /**
   * Convert different memory types to unified semantic match format
   */
  private convertToSemanticMatch(
    source: EpisodicEvent | SemanticFact | KnowledgeNode,
    contentType: 'episodic' | 'semantic' | 'knowledge',
    queryFeatures: any
  ): SemanticMatch {
    let content = '';
    let sourceId = '';
    let sessionId: string | undefined;
    let timestamp = new Date();

    if (contentType === 'episodic') {
      const event = source as EpisodicEvent;
      content = event.content?.message || JSON.stringify(event.content);
      sourceId = event.id || (event as any)._id?.toString();
      sessionId = event.session_id;
      timestamp = event.timestamp || new Date();
    } else if (contentType === 'semantic') {
      const fact = source as SemanticFact;
      content = fact.content || (fact as any).description || '';
      sourceId = fact.id || (fact as any)._id?.toString();
      timestamp = fact.created_at || new Date();
    } else {
      const node = source as KnowledgeNode;
      content = `${node.properties?.name || ''} ${node.properties?.description || ''}`;
      sourceId = node.id;
      timestamp = node.updated_at || new Date();
    }

    // Calculate similarity and relevance
    const similarityScore = this.calculateSimilarity(content, queryFeatures);
    const relevanceScore = this.calculateRelevance(source, contentType, queryFeatures);

    // Find matched features
    const matchedKeywords = this.findMatches(content, queryFeatures.keywords);
    const matchedConcepts = this.findMatches(content, queryFeatures.concepts);
    const matchedEntities = this.findMatches(content, queryFeatures.entities);

    return {
      sourceId,
      contentType,
      content,
      similarityScore,
      relevanceScore,
      matchedKeywords,
      matchedConcepts,
      matchedEntities,
      sessionId,
      timestamp
    };
  }

  /**
   * Calculate semantic similarity between content and query features
   */
  private calculateSimilarity(content: string, queryFeatures: any): number {
    const text = content.toLowerCase();
    const allQueryTerms = [
      ...queryFeatures.keywords,
      ...queryFeatures.concepts,
      ...queryFeatures.entities
    ];

    if (allQueryTerms.length === 0) return 0;

    let matches = 0;
    for (const term of allQueryTerms) {
      if (text.includes(term.toLowerCase())) {
        matches++;
      }
    }

    return matches / allQueryTerms.length;
  }

  /**
   * Calculate relevance score considering content type and context
   */
  private calculateRelevance(
    source: any,
    contentType: string,
    queryFeatures: any
  ): number {
    let score = 0;

    // Base similarity score
    const similarity = this.calculateSimilarity(
      contentType === 'knowledge' ? 
        `${source.properties?.name || ''} ${source.properties?.description || ''}` :
        source.content?.message || source.content || source.description || '',
      queryFeatures
    );
    
    score += similarity * 0.6;

    // Content type weighting
    if (contentType === 'episodic') score += 0.2; // Prioritize actual conversations
    if (contentType === 'semantic') score += 0.15;
    if (contentType === 'knowledge') score += 0.05;

    // Recency boost for episodic memories
    if (contentType === 'episodic' && source.timestamp) {
      const daysSince = (Date.now() - new Date(source.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 7) score += 0.1; // Recent conversations get boost
    }

    // Confidence boost for semantic facts
    if (contentType === 'semantic' && source.confidence) {
      score += source.confidence * 0.1;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Find matching terms in content
   */
  private findMatches(content: string, terms: string[]): string[] {
    const text = content.toLowerCase();
    return terms.filter(term => text.includes(term.toLowerCase()));
  }

  /**
   * Enhance matches with additional context and scoring
   */
  private async enhanceMatches(
    matches: SemanticMatch[],
    queryFeatures: any
  ): Promise<SemanticMatch[]> {
    // Group matches by session for context enhancement
    const sessionGroups = new Map<string, SemanticMatch[]>();
    
    for (const match of matches) {
      if (match.sessionId) {
        if (!sessionGroups.has(match.sessionId)) {
          sessionGroups.set(match.sessionId, []);
        }
        sessionGroups.get(match.sessionId)!.push(match);
      }
    }

    // Boost matches that appear in sessions with multiple related matches
    const enhancedMatches = matches.map(match => {
      if (match.sessionId && sessionGroups.has(match.sessionId)) {
        const sessionMatches = sessionGroups.get(match.sessionId)!;
        if (sessionMatches.length > 1) {
          match.relevanceScore *= 1.2; // Boost for context clustering
        }
      }
      return match;
    });

    return enhancedMatches;
  }

  /**
   * Build concept clusters from matches
   */
  private buildConceptClusters(matches: SemanticMatch[]): ConceptCluster[] {
    const conceptMap = new Map<string, {
      relatedTerms: Set<string>;
      matches: SemanticMatch[];
      sessions: Set<string>;
    }>();

    // Group matches by concepts
    for (const match of matches) {
      for (const concept of match.matchedConcepts) {
        if (!conceptMap.has(concept)) {
          conceptMap.set(concept, {
            relatedTerms: new Set(),
            matches: [],
            sessions: new Set()
          });
        }
        
        const group = conceptMap.get(concept)!;
        group.matches.push(match);
        
        // Add related terms
        match.matchedKeywords.forEach(term => group.relatedTerms.add(term));
        match.matchedEntities.forEach(term => group.relatedTerms.add(term));
        
        if (match.sessionId) {
          group.sessions.add(match.sessionId);
        }
      }
    }

    // Convert to concept clusters
    const clusters: ConceptCluster[] = [];
    for (const [concept, group] of conceptMap) {
      const avgSimilarity = group.matches.reduce((sum, match) => 
        sum + match.similarityScore, 0) / group.matches.length;
      
      clusters.push({
        concept,
        relatedTerms: Array.from(group.relatedTerms),
        matchCount: group.matches.length,
        avgSimilarity,
        sessions: Array.from(group.sessions)
      });
    }

    return clusters.sort((a, b) => b.matchCount - a.matchCount);
  }

  /**
   * Build entity connections from knowledge graph
   */
  private async buildEntityConnections(matches: SemanticMatch[]): Promise<EntityConnection[]> {
    const db = get_database();
    const entityCounts = new Map<string, number>();
    
    // Count entity occurrences
    for (const match of matches) {
      for (const entity of match.matchedEntities) {
        entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
      }
    }

    // Get top entities
    const topEntities = Array.from(entityCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([entity]) => entity);

    // Build connections for top entities
    const connections: EntityConnection[] = [];
    
    for (const entity of topEntities) {
      try {
        // Find related entities in knowledge graph
        const relatedNodes = await db.collection('knowledge_relationships').aggregate([
          { $match: { $or: [
            { 'from_id': { $regex: entity, $options: 'i' } },
            { 'to_id': { $regex: entity, $options: 'i' } }
          ]}},
          { $group: {
            _id: '$relationship_type',
            connections: { $push: { from: '$from_id', to: '$to_id' } },
            strength: { $avg: '$strength' }
          }},
          { $limit: 5 }
        ]).toArray();

        if (relatedNodes.length > 0) {
          const connectedEntities = new Set<string>();
          const relationshipTypes = new Set<string>();
          let totalStrength = 0;

          for (const node of relatedNodes) {
            relationshipTypes.add(node._id);
            totalStrength += node.strength || 0;
            
            for (const conn of node.connections) {
              if (conn.from !== entity) connectedEntities.add(conn.from);
              if (conn.to !== entity) connectedEntities.add(conn.to);
            }
          }

          connections.push({
            entity,
            connectedEntities: Array.from(connectedEntities).slice(0, 5),
            relationshipTypes: Array.from(relationshipTypes),
            strength: totalStrength / relatedNodes.length,
            occurrenceCount: entityCounts.get(entity) || 0
          });
        }
      } catch (error) {
        console.warn(`Failed to build connections for entity ${entity}:`, error);
      }
    }

    return connections.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
  }

  /**
   * Rank matches by relevance considering multiple factors
   */
  private rankByRelevance(matches: SemanticMatch[], context: SemanticSearchContext): SemanticMatch[] {
    return matches.sort((a, b) => {
      // Primary sort by relevance score
      let scoreA = a.relevanceScore;
      let scoreB = b.relevanceScore;

      // Boost recent matches if requested
      if (context.boostRecent) {
        const daysSinceA = (Date.now() - a.timestamp.getTime()) / (1000 * 60 * 60 * 24);
        const daysSinceB = (Date.now() - b.timestamp.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSinceA < 7) scoreA += 0.1;
        if (daysSinceB < 7) scoreB += 0.1;
      }

      // Boost matches with more matched features
      const featuresA = a.matchedKeywords.length + a.matchedConcepts.length + a.matchedEntities.length;
      const featuresB = b.matchedKeywords.length + b.matchedConcepts.length + b.matchedEntities.length;
      
      scoreA += featuresA * 0.05;
      scoreB += featuresB * 0.05;

      return scoreB - scoreA;
    });
  }

  /**
   * Extract domain-specific concepts from text
   */
  private extractConcepts(text: string): string[] {
    const concepts = new Set<string>();
    
    // Technical concepts
    const technicalPatterns = [
      /\b(cylinder\s+head|head\s+porting|performance\s+tuning|engine\s+modification)\b/g,
      /\b(restoration|rebuild|overhaul|maintenance)\b/g,
      /\b(jaguar\s+e-type|classic\s+car|vintage\s+automobile)\b/g,
      /\b(digital\s+marketing|social\s+media|content\s+strategy)\b/g,
      /\b(automation|campaign|reddit\s+posting)\b/g
    ];

    for (const pattern of technicalPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => concepts.add(match.trim()));
      }
    }

    return Array.from(concepts);
  }

  /**
   * Extract named entities from text
   */
  private extractEntities(text: string): string[] {
    const entities = new Set<string>();
    
    // Named entity patterns
    const entityPatterns = [
      /\b(jaguar|e-type|series\s+\d+|xke)\b/gi,
      /\b(sarah\s+wilson|john\s+smith|dr\.\s+\w+)\b/gi,
      /\b(techcorp|dataflow|reddit|linkedin)\b/gi,
      /\b(\d{4}\s+\w+|\w+\s+\d{4})\b/g // Years with models
    ];

    for (const pattern of entityPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(match => entities.add(match.trim()));
      }
    }

    return Array.from(entities);
  }

  /**
   * Determine the intent of the user query
   */
  private determineQueryIntent(text: string): string {
    if (text.includes('when') || text.includes('time') || text.includes('date')) {
      return 'temporal';
    }
    if (text.includes('how') || text.includes('process') || text.includes('method')) {
      return 'procedural';
    }
    if (text.includes('what') || text.includes('tell me about')) {
      return 'informational';
    }
    if (text.includes('compare') || text.includes('difference') || text.includes('vs')) {
      return 'comparative';
    }
    return 'general';
  }

  /**
   * Calculate query complexity for metadata
   */
  private calculateQueryComplexity(queryFeatures: any): number {
    return (queryFeatures.keywords.length * 1) + 
           (queryFeatures.concepts.length * 2) + 
           (queryFeatures.entities.length * 3);
  }

  /**
   * Calculate index coverage for metadata
   */
  private calculateIndexCoverage(matches: SemanticMatch[]): number {
    const contentTypes = new Set(matches.map(m => m.contentType));
    return contentTypes.size / 3; // 3 possible content types
  }
}

export const semanticIndexer = new SemanticIndexer();