/**
 * LLM-Driven Memory Curator
 * 
 * This service allows the LLM to intelligently decide:
 * 1. When to query memories
 * 2. What types of memories are relevant
 * 3. How to synthesize and present them
 * 4. How to prevent recursion without breaking functionality
 */

import { LLMService } from './llm-service.js';
import { MemoryManager } from './memory-manager.js';
import { queryOrchestrationService } from './query-orchestration-service.js';
import { escape_regex } from '../utils/regex-escape.js';
import { CAPABILITY_CARD } from './capability-card.js';
import { temporalResolver } from './temporal-resolver.js';
import { get_database } from '../database/connection.js';
import { embeddingService } from './embedding-service.js';

export interface MemoryTrigger {
  type: 'temporal' | 'semantic' | 'episodic' | 'procedural' | 'emotional' | 'factual' | 'entity';
  confidence: number;
  reasoning: string;
  suggestedQuery: string;
}

export interface MemoryCurationRequest {
  userInput: string;
  conversationContext: string[];
  sessionId: string;
  userId: string;
  preventRecursion?: boolean;
}

export interface CuratedMemoryResponse {
  hasRelevantMemories: boolean;
  memoryTypes: string[];
  synthesizedResponse: string;
  confidence: number;
  memoriesUsed: any[];
  recursionPrevented: boolean;
}

export class LLMMemoryCurator {
  private llmService: LLMService;
  private memoryManager: MemoryManager;
  private recursionGuard: Map<string, number> = new Map();

  constructor() {
    this.llmService = new LLMService();
    this.memoryManager = MemoryManager.get_instance();
  }

  /**
   * Main method: Let the LLM decide if and how to use memories
   */
  async curateMemoryResponse(request: MemoryCurationRequest): Promise<CuratedMemoryResponse> {
    const { userInput, conversationContext, sessionId, userId, preventRecursion = true } = request;

    try {
      // Check for recursion patterns (but don't block unnecessarily)
      if (preventRecursion && this.wouldCauseRecursion(userInput, sessionId)) {
        return this.generateWithRecursionPrevention(userInput, conversationContext);
      }

      // ALWAYS run memory retrieval — don't gate it behind an LLM trigger check.
      // The LLM doesn't know what's in the memory stores, so it can't decide
      // whether memories would be useful. Let the retrieval + synthesis pipeline
      // determine relevance naturally.
      const memoryTypes = ['episodic', 'semantic', 'knowledge_graph'];
      
      // Fast-path: check if this is clearly a memory-specific query
      const enhancedRecall = this.detectMemoryIntent(userInput);

      // Detect temporal queries ("when did X?", "what date?") for dedicated resolution
      const isTemporalQuery = this.detectTemporalIntent(userInput);

      // Step 1: Retrieve relevant memories (always)
      const memories = await this.retrieveRelevantMemories(memoryTypes, userInput, sessionId, userId, enhancedRecall);

      // Step 1b: If temporal query, resolve explicit date/timestamp information
      let temporalContext = '';
      if (isTemporalQuery) {
        try {
          const temporalResult = await temporalResolver.resolveWhen(userId, userInput, { maxResults: 5 });
          if (temporalResult.found) {
            temporalContext = temporalResolver.formatTemporalContext(temporalResult);
            console.log(`📅 Temporal context resolved: ${temporalResult.events.length} events, ${temporalResult.facts.length} facts`);
          }
        } catch (e) {
          console.warn('⚠️ Temporal resolution failed:', e);
        }
      }

      // Step 2: Let LLM synthesize memories into natural response
      const synthesizedResponse = await this.synthesizeMemories(userInput, memories, conversationContext, temporalContext);

      return {
        hasRelevantMemories: memories.length > 0,
        memoryTypes: memoryTypes,
        synthesizedResponse: synthesizedResponse,
        confidence: memories.length > 0 ? Math.min(0.5 + memories.length / 10, 0.95) : 0.5,
        memoriesUsed: memories,
        recursionPrevented: false
      };

    } catch (error) {
      console.error('Memory curation failed:', error);
      return this.generateFreshResponse(userInput, conversationContext);
    }
  }

  /**
   * Let the LLM detect when memories might be relevant to the conversation
   */
  private async detectMemoryTriggers(userInput: string, context: string[]): Promise<MemoryTrigger[]> {
    const prompt = `Analyze this user input to determine if accessing memories would enhance the response:

User Input: "${userInput}"
Recent Context: ${context.slice(-3).join(' → ')}

Memory trigger analysis:
1. Does the user mention previous conversations? (temporal triggers)
2. Are they asking about specific people, entities, or topics? (semantic/entity triggers)  
3. Are they asking "do you remember" or similar? (episodic triggers)
4. Are they asking about procedures or how-to information? (procedural triggers)
5. Are they referencing emotions or experiences? (emotional triggers)
6. Are they asking about facts or information? (factual triggers)

For each relevant trigger type, provide:
- Type (temporal/semantic/episodic/procedural/emotional/factual/entity)
- Confidence (0.0-1.0)
- Reasoning (why this trigger is relevant)
- Suggested query (what to search for in memory)

Respond in JSON format with an array of triggers. If no memories seem relevant, return empty array.`;

    try {
      const response = await this.llmService.generateResponse(prompt);
      
      // Try to parse as JSON, with fallback to simple analysis
      try {
        const triggers = JSON.parse(response);
        return Array.isArray(triggers) ? triggers : [];
      } catch {
        // Fallback: analyze response text for trigger indicators
        return this.parseTriggersFromText(response, userInput);
      }
    } catch (error) {
      console.error('Trigger detection failed:', error);
      return [];
    }
  }

  /**
   * Fallback trigger detection when JSON parsing fails
   */
  private parseTriggersFromText(response: string, userInput: string): MemoryTrigger[] {
    const triggers: MemoryTrigger[] = [];
    
    // Look for memory-related keywords in user input
    const temporalKeywords = ['remember', 'recall', 'previous', 'before', 'last time', 'earlier'];
    const entityKeywords = ['who', 'what', 'where', 'when', 'which', 'person', 'people', 'name', 'company', 'organization', 'team', 'project', 'document', 'file', 'task', 'meeting', 'event', 'topic', 'subject', 'item', 'thing', 'details', 'information'];
    const episodicKeywords = ['conversation', 'discussed', 'talked about', 'mentioned'];
    
    if (temporalKeywords.some(keyword => userInput.toLowerCase().includes(keyword))) {
      triggers.push({
        type: 'temporal',
        confidence: 0.7,
        reasoning: 'User mentioned temporal references',
        suggestedQuery: userInput
      });
    }

    if (entityKeywords.some(keyword => userInput.toLowerCase().includes(keyword))) {
      triggers.push({
        type: 'entity',
        confidence: 0.8,
        reasoning: 'User mentioned specific entities',
        suggestedQuery: userInput
      });
    }

    if (episodicKeywords.some(keyword => userInput.toLowerCase().includes(keyword))) {
      triggers.push({
        type: 'episodic',
        confidence: 0.6,
        reasoning: 'User referenced previous conversations',
        suggestedQuery: userInput
      });
    }

    return triggers;
  }

  /**
   * Let LLM decide which memory types to query based on triggers
   */
  private async selectMemoryTypes(userInput: string, triggers: MemoryTrigger[]): Promise<string[]> {
    const prompt = `Based on this analysis, which memory types should be queried?

User Input: "${userInput}"
Detected Triggers: ${JSON.stringify(triggers)}

Available memory types:
- episodic: Conversation history and events
- semantic: Facts and knowledge
- knowledge_graph: Entities and relationships
- procedural: How-to information and processes
- emotional: Sentiment and emotional context
- assets: Files and documents

Select the most relevant memory types for this query. Consider:
1. What would provide the most useful context?
2. What memory types align with the detected triggers?
3. What would enhance the conversation naturally?

Respond with a JSON array of memory type names, e.g., ["episodic", "semantic"]`;

    try {
      const response = await this.llmService.generateResponse(prompt);
      const memoryTypes = JSON.parse(response);
      return Array.isArray(memoryTypes) ? memoryTypes : ['episodic', 'semantic'];
    } catch (error) {
      console.error('Memory type selection failed:', error);
      // Fallback based on triggers
      return triggers.map(t => this.mapTriggerToMemoryType(t.type));
    }
  }

  /**
   * Map trigger types to memory types
   */
  private mapTriggerToMemoryType(triggerType: string): string {
    const mapping: Record<string, string> = {
      temporal: 'episodic',
      semantic: 'semantic',
      episodic: 'episodic',
      procedural: 'procedural',
      emotional: 'episodic',
      factual: 'semantic',
      entity: 'knowledge_graph'
    };
    return mapping[triggerType] || 'episodic';
  }

  /**
   * Retrieve relevant memories using simple, reliable queries.
   * Replaces the broken queryOrchestrationService approach with direct DB access.
   */
  public async retrieveRelevantMemories(
    memoryTypes: string[],
    userInput: string,
    sessionId: string,
    userId: string,
    enhancedRecall: boolean = false
  ): Promise<any[]> {
    try {
      const db = get_database();

      // 1. Always get recent session events for conversation continuity
      const recentEvents = await this.getRecentSessionContext(sessionId, userId, 6);
      const seenIds = new Set(recentEvents.map(e => e.id || e._id?.toString?.()));

      // 2. Keyword search across all user events (works with or without text index)
      let crossSessionEvents: any[] = [];
      const keywords = this.extractQueryTerms(userInput);

      if (keywords.length > 0) {
        try {
          // Try text search first (fastest, but requires index)
          crossSessionEvents = await db.collection('episodic_events')
            .find({
              user_id: userId,
              $text: { $search: keywords.join(' ') }
            })
            .sort({ score: { $meta: 'textScore' } })
            .limit(20)
            .toArray();
          console.log(`📝 Text search found ${crossSessionEvents.length} events`);
        } catch {
          // Fallback: regex search on content.message
          const orConditions = keywords.map(k => ({
            'content.message': { $regex: k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
          }));
          crossSessionEvents = await db.collection('episodic_events')
            .find({ user_id: userId, $or: orConditions })
            .sort({ timestamp: -1 })
            .limit(20)
            .toArray();
          console.log(`📝 Regex fallback found ${crossSessionEvents.length} events`);
        }
      }

      // 3. Semantic facts (with fallback)
      let facts: any[] = [];
      try {
        facts = await db.collection('semantic_facts')
          .find({ user_id: userId, $text: { $search: userInput } })
          .limit(15)
          .toArray();
      } catch {
        // Fallback: simple find + optional keyword filter
        if (keywords.length > 0) {
          const orConditions = keywords.map(k => ({
            content: { $regex: k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
          }));
          facts = await db.collection('semantic_facts')
            .find({ user_id: userId, $or: orConditions })
            .sort({ created_at: -1 })
            .limit(15)
            .toArray();
        } else {
          facts = await db.collection('semantic_facts')
            .find({ user_id: userId })
            .sort({ created_at: -1 })
            .limit(15)
            .toArray();
        }
      }

      // 4. Enhanced recall: also search auto-journal for long-term context
      let journalResults: any[] = [];
      if (enhancedRecall) {
        try {
          const { getProspectiveMemoryService } = await import('./knowledge-graph-factory.js');
          const prospective = getProspectiveMemoryService();
          const journalEntries = await prospective.searchAutoJournal(userId, userInput, 5);
          journalResults = journalEntries.map(e => ({
            id: 'auto-journal',
            event_type: 'auto_journal',
            content: { role: 'system', message: `[Journal entry]: ${e.entry}` },
            timestamp: e.timestamp,
          }));
        } catch (e) {
          // Non-fatal — journal search is best-effort
        }
      }

      // 5. Vector re-ranking (NEW): re-order cross-session events and facts by semantic similarity
      let vectorRankedEvents = crossSessionEvents;
      let vectorRankedFacts = facts;
      let vectorUsed = false;

      try {
        const queryVec = await embeddingService.encode(userInput);
        if (queryVec) {
          // Re-rank events with embeddings
          const eventsWithEmbeddings = crossSessionEvents.filter(e => e.embedding && e.embedding.length === embeddingService.embeddingDimension);
          if (eventsWithEmbeddings.length > 0) {
            vectorRankedEvents = crossSessionEvents
              .map((e: any) => {
                if (e.embedding && e.embedding.length === embeddingService.embeddingDimension) {
                  const cosine = embeddingService.cosineSimilarity(queryVec, e.embedding);
                  const score = embeddingService.combinedScore(cosine, e.timestamp || e.created_at, 0.6);
                  return { ...e, _vectorScore: score };
                }
                return { ...e, _vectorScore: 0 };
              })
              .sort((a: any, b: any) => b._vectorScore - a._vectorScore);
          }

          // Re-rank facts with embeddings
          const factsWithEmbeddings = facts.filter((f: any) => f.embedding && f.embedding.length === embeddingService.embeddingDimension);
          if (factsWithEmbeddings.length > 0) {
            vectorRankedFacts = facts
              .map((f: any) => {
                if (f.embedding && f.embedding.length === embeddingService.embeddingDimension) {
                  const cosine = embeddingService.cosineSimilarity(queryVec, f.embedding);
                  const score = embeddingService.combinedScore(cosine, f.created_at || f.timestamp, 0.6);
                  return { ...f, _vectorScore: score };
                }
                return { ...f, _vectorScore: 0 };
              })
              .sort((a: any, b: any) => b._vectorScore - a._vectorScore);
          }

          vectorUsed = eventsWithEmbeddings.length > 0 || factsWithEmbeddings.length > 0;
          if (vectorUsed) {
            console.log(`🔍 Vector re-ranked: ${eventsWithEmbeddings.length}/${crossSessionEvents.length} events, ${factsWithEmbeddings.length}/${facts.length} facts`);
          }
        }
      } catch (vecErr: any) {
        console.warn('⚠️ Vector re-ranking failed, using keyword order:', vecErr.message);
      }

      // Merge and deduplicate: recent first, then vector-ranked facts, then vector-ranked events, then journal
      const merged = [
        ...recentEvents,
        ...vectorRankedFacts.filter((f: any) => !seenIds.has(f._id?.toString?.() || f.id)).slice(0, 10),
        ...vectorRankedEvents.filter((e: any) => !seenIds.has(e._id?.toString?.() || e.id)).slice(0, 10),
        ...journalResults.filter(j => !seenIds.has(j.id)),
      ].slice(0, 20);

      const factCount = merged.filter(m => m.metadata?.fact_key || m.fact_key).length;
      const vectorBadge = vectorUsed ? ' [vector]' : '';
      console.log(`🧠 Memory retrieval${vectorBadge}: ${recentEvents.length} recent + ${Math.min(vectorRankedEvents.length, 10)} searched + ${Math.min(vectorRankedFacts.length, 10)} facts + ${journalResults.length} journal = ${merged.length} total (${factCount} semantic)`);
      return merged;
    } catch (error) {
      console.error('Memory retrieval failed:', error);
      return [];
    }
  }

  /**
   * Get recent session events for conversation continuity.
   */
  private async getRecentSessionContext(sessionId: string, userId: string, limit: number): Promise<any[]> {
    try {
      const db = get_database();
      const events = await db.collection('episodic_events')
        .find({ session_id: sessionId })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      return events || [];
    } catch {
      return [];
    }
  }

  /**
   * Detect if the user is asking a temporal question ("when", "what date", etc.).
   * These queries benefit from dedicated date/timestamp resolution.
   */
  private detectTemporalIntent(userInput: string): boolean {
    const temporalPatterns = [
      /\bwhen\s+(did|was|were|have|will|should)\b/i,
      /\bwhat\s+(date|day|time|year|month|week)\b/i,
      /\bhow\s+(long|old|many\s+(days?|weeks?|months?|years?))\b/i,
      /\b(which|what)\s+(day|time)\b/i,
      /\blast\s+(time|week|month|year|night|morning|evening|session)\b/i,
      /\b(twenty\s*twenty|202\d|2026|last\s+(january|february|march|april|may|june|july|august|september|october|november|december))\b/i,
      /\b(ago|earlier|previously|in the past|before that|at that time)\b/i,
      /\b(yesterday|today|tomorrow|last night|this morning|this afternoon)\b/i,
    ];
    return temporalPatterns.some(p => p.test(userInput));
  }

  /**
   * Detect if input is asking for memory recall or would benefit from it.
   * Broad keywords catch task-execution queries that need past context.
   */
  private detectMemoryIntent(userInput: string): boolean {
    const memoryKeywords = [
      'remember', 'recall', 'what did we', 'what was the', 'do you remember',
      'can you recall', 'we discussed', 'we talked about', 'we decided',
      'what make', 'what model', 'which car', 'what vehicle', 'previously mentioned',
      // Task-execution keywords that benefit from memory context
      'pull', 'clone', 'push', 'commit', 'repo', 'repository', 'branch',
      'github', 'gitea', 'gitlab', 'token', 'credential',
      'access', 'api key', 'secret', 'env file', '.env', 'config',
      'dataset', 'data file', 'download', 'upload',
      'create repo', 'fork', 'merge', 'pr'
    ];
    
    const lowerInput = userInput.toLowerCase();
    return memoryKeywords.some(keyword => lowerInput.includes(keyword));
  }

  /**
   * Perform enhanced recall for memory queries (searches across all sessions).
   * Now delegates to retrieveRelevantMemories with enhancedRecall=true.
   */
  private async performEnhancedRecall(userInput: string, sessionId: string, userId: string): Promise<any[]> {
    // This method is kept for compatibility but the logic has been inlined
    // into retrieveRelevantMemories. Call that instead.
    return this.retrieveRelevantMemories(['episodic', 'semantic'], userInput, sessionId, userId, true);
  }

  /**
   * Perform standard recall (session-focused).
   * Now delegates to retrieveRelevantMemories — the queryOrchestrationService
   * approach was over-engineered and relied on missing text indexes.
   */
  private async performStandardRecall(
    userInput: string, 
    sessionId: string, 
    userId: string, 
    memoryTypes: string[]
  ): Promise<any[]> {
    return this.retrieveRelevantMemories(memoryTypes, userInput, sessionId, userId, false);
  }

  /**
   * Extract key terms from query for search
   */
  private extractQueryTerms(query: string): string[] {
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'was', 'are', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may', 'might'];
    
    const terms = query.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 2 && !stopWords.includes(term));
      
    return terms;
  }

  /**
   * Let the LLM synthesize memories into a natural response
   */
  private async synthesizeMemories(
    userInput: string, 
    memories: any[], 
    conversationContext: string[],
    temporalContext?: string
  ): Promise<string> {
    if (memories.length === 0) {
      return await this.generateFreshResponse(userInput, conversationContext).then(r => r.synthesizedResponse);
    }

    // Format memories for LLM consumption
    const formattedMemories = memories.map((memory, index) => {
      const content = this.extractContentFromMemory(memory);
      const timestamp = this.formatMemoryTimestamp(memory);
      const type = memory.event_type || memory.type || 'Unknown type';
      
      return `Memory ${index + 1} [${timestamp}] (${type}): ${content}`;
    }).join('\n\n');

    const capabilityCard = CAPABILITY_CARD;

    // Inject temporal context if available (for "when did X happen?" queries)
    const temporalSection = temporalContext ? `\n${temporalContext}\n\n---\n\n` : '';

    const prompt = `You are Solomon, the cognitive-memory-chat agent with a multi-layer memory system.

## SYSTEM CAPABILITIES (AUTHORITATIVE — FACTS, override conflicting memories)
${capabilityCard}

${temporalSection}User Question: "${userInput}"
Recent Context: ${(conversationContext || []).slice(-2).join(' → ')}

Retrieved Memories (context only — SYSTEM CAPABILITIES above takes priority if they conflict):
${formattedMemories}

GUIDELINES:
1. If the context or memories contain a SYSTEM CAPABILITIES block, those facts are AUTHORITATIVE — they override any conflicting memories
2. Use the retrieved memories as context — they contain the user's past discussions, decisions, and your past responses
3. If the memories contain specific details (URLs, credentials, commands), use them exactly as recorded unless contradicted by SYSTEM CAPABILITIES
4. If memories describe an OLD environment (e.g., Docker container) that conflicts with current capabilities (e.g., running on Pi host), TRUST the capabilities
5. Never fabricate specific details that aren't in the memories or your identity files
6. Be conversational — you are Solomon, not a search engine
7. If asked WHEN something happened, cite the specific date AND relative time (e.g., "on 2026-06-13 at 11:34 UTC, which was yesterday")
8. DIRECTIVES: If you learn something important, output "JOURNAL: [your insight]" on its own line. Do not just say "I'm journaling this" — output the directive so it gets saved.

Response:`;

    try {
      return await this.llmService.generateResponse(prompt);
    } catch (error) {
      console.error('Memory synthesis failed:', error);
      return `I found some relevant information from our previous conversations, but I'm having trouble synthesizing it right now. Could you rephrase your question?`;
    }
  }

  /**
   * Format a memory's timestamp as a reliable ISO 8601 string.
   * Checks source_event_timestamp > timestamp > created_at in priority order.
   */
  private formatMemoryTimestamp(memory: any): string {
    // Priority: source_event_timestamp (the original event time) > timestamp > created_at
    const ts = memory.source_event_timestamp || memory.timestamp || memory.created_at;
    if (!ts) {
      // Check nested metadata fields
      const metaTs = memory.metadata?.created_at || memory.metadata?.extraction_context?.timestamp;
      if (metaTs) return new Date(metaTs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
      return 'Unknown date';
    }
    // ISO 8601 with space separator: "2026-06-13 14:35:00 UTC"
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  /**
   * Extract meaningful content from memory objects
   */
  private extractContentFromMemory(memory: any): string {
    // Try different content fields
    const contentFields = [
      'content.message',
      'content',
      'message', 
      'fact',
      'description',
      'properties.description',
      'properties.name'
    ];

    for (const field of contentFields) {
      const value = this.getNestedProperty(memory, field);
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    return JSON.stringify(memory).substring(0, 200);
  }

  /**
   * Get nested property from object
   */
  private getNestedProperty(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Check if this would cause recursion (smart detection)
   */
  private wouldCauseRecursion(userInput: string, sessionId: string): boolean {
    const recursionKey = `${sessionId}:${userInput.substring(0, 50)}`;
    const currentCount = this.recursionGuard.get(recursionKey) || 0;
    
    // Allow up to 2 similar queries, block after that
    if (currentCount >= 2) {
      return true;
    }
    
    // Update counter
    this.recursionGuard.set(recursionKey, currentCount + 1);
    
    // Clean up old entries (prevent memory leaks)
    if (this.recursionGuard.size > 1000) {
      const entries = Array.from(this.recursionGuard.entries());
      entries.slice(0, 500).forEach(([key]) => this.recursionGuard.delete(key));
    }
    
    return false;
  }

  /**
   * Generate response with recursion prevention
   */
  private async generateWithRecursionPrevention(
    userInput: string, 
    conversationContext: string[]
  ): Promise<CuratedMemoryResponse> {
    const response = await this.llmService.generateResponse(
      `The user is asking: "${userInput}"
      
      I've detected this might be a repetitive query. Provide a helpful response that:
      1. Acknowledges their question
      2. Explains that I may have limited context on this specific topic
      3. Offers to help in other ways
      4. Is conversational and friendly
      
      Don't mention technical details about recursion or memory systems.`
    );

    return {
      hasRelevantMemories: false,
      memoryTypes: [],
      synthesizedResponse: response,
      confidence: 0.5,
      memoriesUsed: [],
      recursionPrevented: true
    };
  }

  /**
   * Generate fresh response when no memories are relevant
   */
  private async generateFreshResponse(
    userInput: string, 
    conversationContext: string[]
  ): Promise<CuratedMemoryResponse> {
    const capabilityCard = CAPABILITY_CARD;
    const ctx = (conversationContext || []).slice(-2).join(' → ');
    const prompt = `## SYSTEM CAPABILITIES (AUTHORITATIVE — trust these facts)
${capabilityCard}

User: ${userInput}
${ctx ? `Context: ${ctx}` : ''}

Provide a helpful, conversational response. Use the SYSTEM CAPABILITIES if relevant. Do NOT ask clarifying questions you already know the answer to.

If you reflect on something important, output "JOURNAL: [your insight]" on its own line. Do not just say "I'm journaling this" — output the directive so it gets saved.`;
    const response = await this.llmService.generateResponse(prompt);

    return {
      hasRelevantMemories: false,
      memoryTypes: [],
      synthesizedResponse: response,
      confidence: 0.7,
      memoriesUsed: [],
      recursionPrevented: false
    };
  }

  /**
   * Calculate confidence based on memories and triggers
   */
  private calculateConfidence(memories: any[], triggers: MemoryTrigger[]): number {
    if (memories.length === 0) return 0.3;
    
    const memoryScore = Math.min(memories.length / 5, 1) * 0.5;
    const triggerScore = triggers.reduce((sum, t) => sum + t.confidence, 0) / triggers.length * 0.5;
    
    return Math.min(memoryScore + triggerScore, 0.95);
  }
}

export const llmMemoryCurator = new LLMMemoryCurator();