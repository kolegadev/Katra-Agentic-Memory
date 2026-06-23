import { get_database } from '../database/connection.js';
import { ObjectId } from 'mongodb';
import { crossSessionIntegrator } from './cross-session-integrator.js';
import { semanticIndexer } from './semantic-indexer.js';
import { entityResolver } from './entity-resolver.js';
import { memoryConsolidator } from './memory-consolidator.js';

export interface QueryPlan {
  id: string;
  informationNeed: string;
  context: Record<string, unknown>;
  queries: QueryStep[];
  priority: number;
  estimatedCost: number;
}

export interface QueryStep {
  id: string;
  type: 'episodic' | 'semantic' | 'knowledge_graph' | 'asset';
  collection: string;
  query: Record<string, unknown>;
  projection?: Record<string, unknown>;
  limit?: number;
  dependencies?: string[];
  weight: number;
}

export interface QueryResult {
  stepId: string;
  type: string;
  data: unknown[];
  metadata: {
    executionTime: number;
    count: number;
    source: string;
  };
}

export interface AggregatedResult {
  planId: string;
  results: QueryResult[];
  synthesis: {
    totalExecutionTime: number;
    relevanceScore: number;
    confidenceScore: number;
    sources: string[];
  };
  aggregatedData: Record<string, unknown[]>;
}

class QueryOrchestrationService {
  private get database() {
    return get_database();
  }

  /**
   * Build a query plan based on information need and context
   */
  async buildQueryPlan(informationNeed: string, context: Record<string, unknown> = {}): Promise<QueryPlan> {
    const planId = new ObjectId().toString();
    
    // Analyze information need to determine query strategy
    const queryTypes = this.analyzeInformationNeed(informationNeed);
    console.log(`🧠 Building query plan for: "${informationNeed}"`, {
      planId,
      queryTypes,
      context
    });
    
    const queries: QueryStep[] = [];

    // Build episodic queries for conversational memories
    if (queryTypes.includes('temporal') || queryTypes.includes('session') || queryTypes.includes('episodic')) {
      queries.push({
        id: `${planId}_episodic`,
        type: 'episodic',
        collection: 'episodic_events',
        query: this.buildEpisodicQuery(informationNeed, context),
        limit: 50,
        weight: 0.9
      });
    }

    // Build semantic queries for factual information
    if (queryTypes.includes('factual') || queryTypes.includes('semantic')) {
      queries.push({
        id: `${planId}_semantic`,
        type: 'semantic',
        collection: 'semantic_facts',
        query: this.buildSemanticQuery(informationNeed, context),
        limit: 20,
        weight: 0.9
      });
    }

    // Build knowledge graph queries for relationships
    if (queryTypes.includes('relational') || queryTypes.includes('entity')) {
      queries.push({
        id: `${planId}_graph`,
        type: 'knowledge_graph',
        collection: 'knowledge_nodes',
        query: this.buildGraphQuery(informationNeed, context),
        limit: 30,
        weight: 0.85
      });
    }

    // Build asset queries if file/media context is needed
    if (queryTypes.includes('asset') || queryTypes.includes('media')) {
      queries.push({
        id: `${planId}_asset`,
        type: 'asset',
        collection: 'asset_metadata',
        query: this.buildAssetQuery(informationNeed, context),
        limit: 10,
        weight: 0.7
      });
    }

    return {
      id: planId,
      informationNeed,
      context,
      queries,
      priority: this.calculatePriority(queryTypes),
      estimatedCost: this.estimateQueryCost(queries)
    };
  }

  /**
   * Execute coordinated queries based on plan
   */
  async executeCoordinatedQueries(queryPlan: QueryPlan): Promise<AggregatedResult> {
    const startTime = Date.now();
    const results: QueryResult[] = [];

    // Enhanced cross-session integration
    if (queryPlan.context.userId && queryPlan.context.sessionId) {
      try {
        const crossSessionResults = await crossSessionIntegrator.findCrossSessionMemories({
          userId: queryPlan.context.userId as string,
          currentSessionId: queryPlan.context.sessionId as string,
          userQuery: queryPlan.informationNeed,
          relevanceThreshold: 0.6,
          maxResultsPerType: 10
        });

        if (crossSessionResults.totalMatches > 0) {
          results.push({
            stepId: `${queryPlan.id}_cross_session`,
            type: 'cross_session',
            data: [crossSessionResults],
            metadata: {
              executionTime: 0,
              count: crossSessionResults.totalMatches,
              source: 'cross_session_integrator'
            }
          });
        }
      } catch (error) {
        console.warn('Cross-session integration failed:', error);
      }
    }

    // Enhanced semantic search
    if (queryPlan.context.userId) {
      try {
        const semanticResults = await semanticIndexer.performSemanticSearch({
          userId: queryPlan.context.userId as string,
          query: queryPlan.informationNeed,
          contentTypes: ['episodic', 'semantic', 'knowledge'],
          maxResults: 15,
          boostRecent: true,
          sessionContext: queryPlan.context.sessionId as string | undefined
        });

        if (semanticResults.matches.length > 0) {
          results.push({
            stepId: `${queryPlan.id}_semantic_enhanced`,
            type: 'semantic_enhanced',
            data: [semanticResults],
            metadata: {
              executionTime: semanticResults.searchMetadata.executionTime,
              count: semanticResults.matches.length,
              source: 'semantic_indexer'
            }
          });
        }
      } catch (error) {
        console.warn('Enhanced semantic search failed:', error);
      }
    }

    // Group queries by dependencies
    const independentQueries = queryPlan.queries.filter(q => !q.dependencies?.length);
    const dependentQueries = queryPlan.queries.filter(q => q.dependencies?.length);

    // Execute independent queries in parallel
    const independentResults = await Promise.allSettled(
      independentQueries.map(query => this.executeQuery(query))
    );

    // Process independent results
    independentResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        console.error(`Query ${independentQueries[index].id} failed:`, result.reason);
      }
    });

    // Execute dependent queries sequentially
    for (const query of dependentQueries) {
      try {
        const enhancedQuery = this.enhanceQueryWithDependencies(query, results);
        const result = await this.executeQuery(enhancedQuery);
        results.push(result);
      } catch (error) {
        console.error(`Dependent query ${query.id} failed:`, error);
      }
    }

    const totalExecutionTime = Date.now() - startTime;

    return {
      planId: queryPlan.id,
      results,
      synthesis: {
        totalExecutionTime,
        relevanceScore: this.calculateRelevanceScore(results, queryPlan.informationNeed),
        confidenceScore: this.calculateConfidenceScore(results),
        sources: results.map(r => r.metadata.source)
      },
      aggregatedData: this.aggregateResults(results, queryPlan)
    };
  }

  private analyzeInformationNeed(informationNeed: string): string[] {
    const need = informationNeed.toLowerCase();
    const types: string[] = [];

    // Temporal indicators - prioritize episodic memories for time-based queries
    if (need.match(/\b(when|time|date|ago|recent|history|timeline|last|memory)\b/)) {
      types.push('temporal');
      types.push('episodic');
    }

    // Session indicators
    if (need.match(/\b(session|conversation|chat|today|earlier)\b/)) {
      types.push('session');
      types.push('episodic');
    }

    // Factual indicators - prioritize episodic memories that contain facts
    if (need.match(/\b(what is|define|fact|information|about|explain)\b/)) {
      types.push('factual');
      types.push('episodic');
      types.push('semantic');
    }

    // Semantic indicators
    if (need.match(/\b(meaning|concept|definition|knowledge)\b/)) {
      types.push('semantic');
      types.push('episodic');
    }

    // Relational indicators
    if (need.match(/\b(related|connected|relationship|link|association)\b/)) {
      types.push('relational');
      types.push('episodic');
    }

    // Entity indicators - but prioritize episodic memories about entities
    if (need.match(/\b(entity|person|place|thing|concept|node|find|search)\b/)) {
      types.push('entity');
      types.push('episodic');
    }

    // Asset indicators
    if (need.match(/\b(file|image|document|asset|media|upload)\b/)) {
      types.push('asset');
    }

    // Specific entity names and topics - prioritize episodic memories about known entities
    if (need.match(/\b(john|smith|techcorp|jaguar|porting|head|cylinder|reddit|posting|automation|marketing|campaign)\b/)) {
      types.push('episodic');
      types.push('entity');
      types.push('semantic');
    }
    
    // Digital marketing and automation queries
    if (need.match(/\b(reddit|posting|automation|digital|marketing|campaign|social|media|content|strategy)\b/)) {
      types.push('episodic');
      types.push('semantic');
    }

    // Default strategy: prioritize actual memories over extracted entities
    if (types.length === 0) {
      return ['episodic', 'semantic', 'entity'];
    }

    // Remove duplicates while preserving order
    const uniqueTypes = [];
    const seen = new Set();
    for (const type of types) {
      if (!seen.has(type)) {
        seen.add(type);
        uniqueTypes.push(type);
      }
    }

    return uniqueTypes;
  }

  private buildEpisodicQuery(informationNeed: string, context: Record<string, any>): Record<string, any> {
    const query: Record<string, any> = {};

    // Don't restrict by session/user for memory recall if limitToSession/limitToUser is false
    if (context.sessionId && context.limitToSession !== false) {
      query.session_id = context.sessionId;
    }

    if (context.userId && context.limitToUser !== false) {
      query.user_id = context.userId;
    }

    // Extract search terms for episodic search
    const searchTerms = this.extractSearchTerms(informationNeed);
    
    if (searchTerms.length > 0) {
      // Use MongoDB text index for relevance-ranked search
      query.$text = { $search: searchTerms.join(' ') };
    }

    return query;
  }

  private buildSemanticQuery(informationNeed: string, context: Record<string, any>): Record<string, any> {
    const searchTerms = this.extractSearchTerms(informationNeed);
    const query: Record<string, any> = {};

    if (searchTerms.length > 0) {
      // For semantic queries, be more selective with search terms
      // Filter out very generic terms and focus on the most relevant ones
      const semanticTerms = searchTerms.filter(term => {
        const lowerTerm = term.toLowerCase();
        // Skip overly generic terms that might match irrelevant content
        return !['can', 'you', 'tell', 'about', 'from', 'part'].includes(lowerTerm) &&
               term.length > 2;
      });
      
      if (semanticTerms.length > 0) {
        // Use MongoDB text index for relevance-ranked search
        query.$text = { $search: semanticTerms.join(' ') };
      }
    }

    // Add context filters
    if (context.domain) {
      query.domain = context.domain;
    }

    return query;
  }

  private buildGraphQuery(informationNeed: string, context: Record<string, any>): Record<string, any> {
    const searchTerms = this.extractSearchTerms(informationNeed);
    const query: Record<string, any> = {};

    if (searchTerms.length > 0) {
      // Use MongoDB text index for entity name/description search
      query.$text = { $search: searchTerms.join(' ') };
    } else {
      // If no specific search terms, return recent entities (limit will be applied)
      query.created_at = { $exists: true };
    }

    // Add entity type filter if specified
    if (context.entityType) {
      query.type = context.entityType;
    }

    return query;
  }

  private buildAssetQuery(informationNeed: string, context: Record<string, any>): Record<string, any> {
    const query: Record<string, any> = {};

    // Add user context
    if (context.userId) {
      query.userId = context.userId;
    }

    // Add file type filter
    const searchTerms = this.extractSearchTerms(informationNeed);
    if (searchTerms.length > 0) {
      // Use MongoDB text index for file name/description search
      query.$text = { $search: searchTerms.join(' ') };
    }

    return query;
  }

  private async executeQuery(queryStep: QueryStep): Promise<QueryResult> {
    const startTime = Date.now();
    
    try {
      console.log(`🔍 Executing query for ${queryStep.id}:`, {
        collection: queryStep.collection,
        query: queryStep.query,
        type: queryStep.type
      });

      const collection = this.database.collection(queryStep.collection);
      let data: any[] = [];

      // Execute query based on type
      switch (queryStep.type) {
        case 'knowledge_graph':
          // Use aggregation pipeline for graph queries
          data = await collection.aggregate([
            { $match: queryStep.query },
            { $limit: queryStep.limit || 20 },
            ...(queryStep.projection ? [{ $project: queryStep.projection }] : [])
          ]).toArray();
          break;

        default:
          // Standard find query with sorting for episodic events
          let query = queryStep.query;
          let cursor = collection.find(query);
          if (queryStep.projection) cursor.project(queryStep.projection);
          
          // Sort by text relevance when using text search, otherwise by recency
          if (query.$text) {
            cursor.sort({ score: { $meta: 'textScore' } });
          } else if (queryStep.type === 'episodic') {
            cursor.sort({ timestamp: -1 });
          }
          
          if (queryStep.limit) cursor.limit(queryStep.limit);
          
          try {
            data = await cursor.toArray();
          } catch (queryError: any) {
            const errMsg = queryError?.message || String(queryError);
            // If text index is missing, fallback to regex search
            if (errMsg.includes('text index required') || errMsg.includes('$text')) {
              console.log(`📝 Text index missing for ${queryStep.id}, falling back to regex`);
              const fallbackQuery = this.buildRegexFallbackQuery(query);
              cursor = collection.find(fallbackQuery);
              if (queryStep.projection) cursor.project(queryStep.projection);
              if (queryStep.type === 'episodic') cursor.sort({ timestamp: -1 });
              if (queryStep.limit) cursor.limit(queryStep.limit);
              data = await cursor.toArray();
            } else {
              throw queryError;
            }
          }
      }

      const executionTime = Date.now() - startTime;

      console.log(`✅ Query ${queryStep.id} completed:`, {
        resultCount: data.length,
        executionTime,
        firstResult: data.length > 0 ? data[0] : null
      });

      return {
        stepId: queryStep.id,
        type: queryStep.type,
        data,
        metadata: {
          executionTime,
          count: data.length,
          source: queryStep.collection
        }
      };
    } catch (error) {
      console.error(`❌ Query execution failed for ${queryStep.id}:`, error);
      return {
        stepId: queryStep.id,
        type: queryStep.type,
        data: [],
        metadata: {
          executionTime: Date.now() - startTime,
          count: 0,
          source: queryStep.collection
        }
      };
    }
  }

  /**
   * Build a regex fallback query when $text indexes are unavailable.
   * Preserves non-text match criteria and replaces $text with $or regex on common text fields.
   */
  private buildRegexFallbackQuery(originalQuery: Record<string, unknown>): Record<string, unknown> {
    const fallbackQuery: Record<string, unknown> = {};
    const textTerms: string[] = [];

    for (const [key, value] of Object.entries(originalQuery)) {
      if (key === '$text' && typeof value === 'object' && value !== null) {
        const textValue = (value as Record<string, unknown>).$search;
        if (typeof textValue === 'string') {
          textTerms.push(...textValue.split(/\s+/).filter((t) => t.length > 2));
        }
      } else {
        fallbackQuery[key] = value;
      }
    }

    if (textTerms.length > 0) {
      const regexConditions = textTerms.map((term) => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return {
          $or: [
            { 'content.message': { $regex: escaped, $options: 'i' } },
            { content: { $regex: escaped, $options: 'i' } },
            { name: { $regex: escaped, $options: 'i' } },
            { description: { $regex: escaped, $options: 'i' } },
            { 'properties.name': { $regex: escaped, $options: 'i' } },
            { 'properties.description': { $regex: escaped, $options: 'i' } }
          ]
        };
      });
      fallbackQuery.$and = regexConditions;
    }

    return fallbackQuery;
  }

  private enhanceQueryWithDependencies(query: QueryStep, results: QueryResult[]): QueryStep {
    // This would enhance queries based on results from dependencies
    return query;
  }

  private calculatePriority(queryTypes: string[]): number {
    const priorities: Record<string, number> = {
      'session': 10,
      'temporal': 9,
      'relational': 8,
      'semantic': 7,
      'factual': 6,
      'entity': 5,
      'asset': 4
    };

    return Math.max(...queryTypes.map(type => priorities[type] || 1));
  }

  private estimateQueryCost(queries: QueryStep[]): number {
    return queries.reduce((total, query) => {
      const baseCost = query.limit || 20;
      const typeCost = query.type === 'knowledge_graph' ? 2 : 1;
      return total + (baseCost * typeCost);
    }, 0);
  }

  private calculateRelevanceScore(results: QueryResult[], informationNeed: string): number {
    if (results.length === 0) return 0;

    const totalResults = results.reduce((sum, r) => sum + r.data.length, 0);
    if (totalResults === 0) return 0;

    // Simple relevance scoring based on result count and query types
    const baseScore = Math.min(totalResults / 10, 1);
    return Math.round(baseScore * 100) / 100;
  }

  private calculateConfidenceScore(results: QueryResult[]): number {
    if (results.length === 0) return 0;

    const successfulQueries = results.filter(r => r.data.length > 0).length;
    const confidenceScore = successfulQueries / results.length;
    return Math.round(confidenceScore * 100) / 100;
  }

  private aggregateResults(results: QueryResult[], queryPlan: QueryPlan): Record<string, any> {
    const aggregated: Record<string, any> = {
      episodic: [],
      semantic: [],
      knowledge_graph: [],
      assets: []
    };

    results.forEach(result => {
      switch (result.type) {
        case 'episodic':
          aggregated.episodic.push(...result.data);
          break;
        case 'semantic':
          aggregated.semantic.push(...result.data);
          break;
        case 'knowledge_graph':
          aggregated.knowledge_graph.push(...result.data);
          break;
        case 'asset':
          aggregated.assets.push(...result.data);
          break;
        case 'semantic_enhanced':
          // data is [semanticResults] where each has a .matches array
          result.data.forEach(sr => {
            if (sr?.matches) aggregated.semantic.push(...sr.matches);
          });
          break;
        case 'cross_session':
          // data is [crossSessionResults] with episodic/semantic arrays
          result.data.forEach(csr => {
            if (csr?.episodic) aggregated.episodic.push(...csr.episodic);
            if (csr?.semantic) aggregated.semantic.push(...csr.semantic);
          });
          break;
      }
    });

    return aggregated;
  }

  private extractSearchTerms(text: string): string[] {
    // Extract meaningful terms from text, with improved stop word filtering
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 
      'about', 'what', 'is', 'are', 'was', 'were', 'tell', 'me', 'want', 'know', 'information', 
      'when', 'where', 'how', 'why', 'which', 'can', 'you', 'please', 'would', 'could', 'should',
      'from', 'as', 'part', 'that', 'this', 'will', 'be', 'have', 'has', 'do', 'does', 'did'
    ]);
    
    // Extract compound terms and domain-specific phrases
    const compoundTerms: string[] = [];
    
    // Enhanced compound patterns for various domains
    const compoundPatterns = [
      /\breddit\s+posting\b/gi,
      /\bdigital\s+marketing\b/gi,
      /\bsocial\s+media\b/gi,
      /\bhead\s+porting\b/gi,
      /\bcylinder\s+head\b/gi,
      /\b[A-Z]\s+type\s+[A-Z][a-z]+\b/g,
      /\bautomating\s+\w+\s+posting\b/gi,
      /\bmarketing\s+campaign\b/gi,
      /\bcontent\s+automation\b/gi,
      /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g,
    ];
    
    compoundPatterns.forEach(pattern => {
      const matches = text.match(pattern) || [];
      compoundTerms.push(...matches.map(m => m.trim()));
    });
    
    // Extract individual significant terms
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));
    
    // Identify important single terms
    const importantTerms = words.filter(word => {
      return word.match(/^(reddit|posting|automation|marketing|campaign|digital|social|media|engine|porting|jaguar|cylinder|head|tech|api|bot|schedule|content|strategy)$/i) ||
             word.length > 4;
    });
    
    // Combine all terms with priority to compound terms
    const allTerms = [...compoundTerms, ...importantTerms];
    
    // Remove duplicates and limit
    const uniqueTerms = [];
    const seen = new Set();
    
    for (const term of allTerms) {
      const normalizedTerm = term.toLowerCase().trim();
      if (normalizedTerm && !seen.has(normalizedTerm) && normalizedTerm.length > 1) {
        seen.add(normalizedTerm);
        uniqueTerms.push(term);
      }
    }
    
    return uniqueTerms.slice(0, 8);
  }
}

export const queryOrchestrationService = new QueryOrchestrationService();