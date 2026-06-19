import { v4 as uuidv4 } from 'uuid';
import { llmService } from './llm-service.js';

// Types for structured extraction
export interface ExtractedEntity {
  id: string;
  type: string;
  name: string;
  properties: Record<string, any>;
  confidence: number;
}

export interface ExtractedRelationship {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  properties: Record<string, any>;
  confidence: number;
}

export interface ExtractedEvent {
  id: string;
  event_type: string;
  timestamp: Date;
  description: string;
  entities_involved: string[];
  metadata: Record<string, any>;
  confidence: number;
}

export interface ExtractedSemanticFact {
  id: string;
  fact_key: string;
  fact_value: any;
  context: string;
  confidence: number;
  fact_type?: string;
  properties?: {
    certainty_level?: string;
    importance?: string;
    actionability?: string;
    emotional_weight?: string;
    expertise_level?: string;
    change_frequency?: string;
    sharing_context?: string;
    source_entity_id?: string;
    extraction_method?: string;
    domain?: string;
    original_content?: string;
    [key: string]: any; // Allow additional properties
  };
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  events: ExtractedEvent[];
  semantic_facts: ExtractedSemanticFact[];
  processing_metadata: {
    input_length: number;
    extraction_time: number;
    llm_used: boolean;
    extraction_method: string;
  };
}

export interface ExtractionContext {
  session_id: string;
  user_id: string;
  shared_id?: string;
  timestamp: Date;
  conversation_history?: string[];
  current_entities?: string[];
  extraction_focus?: string;
}

class ExtractionService {
  /**
   * Main entry point: extract structured data from text.
   * Uses lightweight regex extraction for most messages;
   * only calls the expensive LLM for substantial content.
   */
  async extractStructuredData(
    input_text: string, 
    context: ExtractionContext
  ): Promise<ExtractionResult> {
    const start_time = Date.now();
    
    console.log(`🔍 ExtractionService: Processing text: "${input_text.substring(0, 100)}..."`);
    
    // Skip extraction for short or low-value messages
    if (input_text.length < 50) {
      console.log(`⏭️ Message too short (${input_text.length} chars), skipping extraction`);
      return this.createEmptyExtraction(input_text, context, start_time, 'too_short');
    }
    
    if (this.isGenericMessage(input_text)) {
      console.log(`⏭️ Generic message detected, skipping extraction`);
      return this.createEmptyExtraction(input_text, context, start_time, 'generic_message');
    }
    
    // Try lightweight extraction first (fast, no LLM)
    const simpleResult = this.extractSimpleFacts(input_text, context);
    if (simpleResult.semantic_facts.length > 0) {
      console.log(`✅ Lightweight extraction: ${simpleResult.semantic_facts.length} facts`);
      return {
        ...simpleResult,
        processing_metadata: {
          input_length: input_text.length,
          extraction_time: Date.now() - start_time,
          llm_used: false,
          extraction_method: 'lightweight_patterns'
        }
      };
    }
    
    // Only call LLM for substantial content that didn't match patterns
    if (input_text.length < 200) {
      console.log(`⏭️ No patterns matched and message is short, skipping LLM extraction`);
      return this.createEmptyExtraction(input_text, context, start_time, 'no_patterns_short');
    }
    
    try {
      const context_string = this.buildContextString(context);
      const llm_result = await llmService.extractStructuredData(input_text, context_string);
      
      console.log(`🔍 LLM raw result:`, {
        hasEntities: !!llm_result?.entities,
        hasKnowledge: !!llm_result?.knowledge,
        hasActivities: !!llm_result?.activities,
        hasRelationships: !!llm_result?.relationships
      });
      
      if (!llm_result) {
        console.log(`⚠️ LLM returned null, using fallback extraction`);
        return this.createFallbackExtraction(input_text, context, start_time);
      }

      const extraction_result = this.transformLLMResponse(llm_result, context);
      
      console.log(`✅ Transformed extraction result:`, {
        entities: extraction_result.entities.length,
        relationships: extraction_result.relationships.length,
        events: extraction_result.events.length,
        semantic_facts: extraction_result.semantic_facts.length
      });

      return {
        ...extraction_result,
        processing_metadata: {
          input_length: input_text.length,
          extraction_time: Date.now() - start_time,
          llm_used: true,
          extraction_method: 'llm_comprehensive'
        }
      };

    } catch (error) {
      console.error(`❌ ExtractionService failed:`, error);
      return this.createFallbackExtraction(input_text, context, start_time);
    }
  }

  /**
   * Check if a message is generic (questions, greetings, etc.)
   * that don't contain extractable knowledge.
   */
  private isGenericMessage(text: string): boolean {
    const lower = text.toLowerCase().trim();
    
    // Questions (usually don't contain declarative knowledge)
    if (/^(what|how|why|when|where|who|can you|could you|would you|do you|are you|is there|tell me|explain|describe)/i.test(lower)) {
      return true;
    }
    
    // Greetings and short social messages
    if (/^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|ok|okay|yes|no|sure|great|nice|cool|awesome)$/i.test(lower)) {
      return true;
    }
    
    // Follow-up prompts
    if (/^(go on|continue|proceed|next|and then|what else|anything else|tell me more)/i.test(lower)) {
      return true;
    }
    
    return false;
  }

  /**
   * Lightweight fact extraction using regex patterns.
   * Fast, no LLM calls, extracts high-value facts.
   */
  private extractSimpleFacts(
    input_text: string,
    context: ExtractionContext
  ): Omit<ExtractionResult, 'processing_metadata'> {
    const semantic_facts: ExtractedSemanticFact[] = [];
    const entities: ExtractedEntity[] = [];
    const events: ExtractedEvent[] = [];
    const relationships: ExtractedRelationship[] = [];
    
    // 1. Extract URLs
    const urlPattern = /https?:\/\/[^\s<>"{}|\^`\[\]]+/g;
    const urls = input_text.match(urlPattern) || [];
    for (const url of [...new Set(urls)]) {
      semantic_facts.push({
        id: uuidv4(),
        fact_key: 'url_reference',
        fact_value: url,
        context: `URL mentioned in session ${context.session_id}`,
        confidence: 0.95,
        fact_type: 'reference',
        properties: {
          certainty_level: 'stated',
          importance: 'useful',
          actionability: 'reference',
          extraction_method: 'pattern_url'
        }
      });
    }
    
    // 2. Extract file paths
    const pathPattern = /(?:[\/~]|\.\/)?[\w\-./]+\.(?:txt|md|json|js|ts|py|csv|yml|yaml|sh|dockerfile|env|config|html|css|tsx|jsx)/gi;
    const paths = input_text.match(pathPattern) || [];
    for (const path of [...new Set(paths)]) {
      semantic_facts.push({
        id: uuidv4(),
        fact_key: 'file_reference',
        fact_value: path,
        context: `File path mentioned in session ${context.session_id}`,
        confidence: 0.9,
        fact_type: 'reference',
        properties: {
          certainty_level: 'stated',
          importance: 'useful',
          actionability: 'actionable',
          extraction_method: 'pattern_filepath'
        }
      });
    }
    
    // 3. Extract commands (lines that look like terminal commands)
    const commandPatterns = [
      /^(git\s+\w+)/m,
      /^(npm\s+\w+)/m,
      /^(python[23]?\s+)/m,
      /^(node\s+)/m,
      /^(docker\s+\w+)/m,
      /^(sudo\s+)/m,
      /^(apt\s+\w+)/m,
      /^(apk\s+\w+)/m,
      /^(curl\s+)/m,
      /^(wget\s+)/m,
      /^(mkdir\s+)/m,
      /^(cd\s+)/m,
      /^(ls\s+)/m,
      /^(cat\s+)/m,
      /^(cp\s+|mv\s+|rm\s+)/m,
    ];
    for (const pattern of commandPatterns) {
      const match = input_text.match(pattern);
      if (match) {
        const command = match[0].trim();
        // Get the full line
        const lines = input_text.split('\n');
        for (const line of lines) {
          if (line.trim().startsWith(command.split(' ')[0])) {
            semantic_facts.push({
              id: uuidv4(),
              fact_key: 'command_reference',
              fact_value: line.trim(),
              context: `Command mentioned in session ${context.session_id}`,
              confidence: 0.9,
              fact_type: 'command',
              properties: {
                certainty_level: 'stated',
                importance: 'critical',
                actionability: 'actionable',
                extraction_method: 'pattern_command'
              }
            });
            break;
          }
        }
        break; // Only extract one command per message to avoid noise
      }
    }
    
    // 4. Extract decisions and preferences
    const decisionPatterns = [
      { pattern: /(?:I\s+)?decided\s+to\s+(.+?)(?:\.|\n|$)/i, key: 'decision', type: 'decision' },
      { pattern: /(?:we\s+)?agreed\s+(?:on|to)\s+(.+?)(?:\.|\n|$)/i, key: 'agreement', type: 'decision' },
      { pattern: /(?:I\s+)?prefer\s+(.+?)(?:\.|\n|$)/i, key: 'preference', type: 'preference' },
      { pattern: /(?:my\s+)?favorite\s+(.+?)(?:\.|\n|$)/i, key: 'preference', type: 'preference' },
      { pattern: /(?:I\s+)?chose\s+(.+?)(?:\.|\n|$)/i, key: 'choice', type: 'decision' },
      { pattern: /(?:let['']?s\s+)(.+?)(?:\.|\n|$)/i, key: 'plan', type: 'plan' },
      { pattern: /(?:I\s+)?need\s+to\s+(.+?)(?:\.|\n|$)/i, key: 'task', type: 'task' },
      { pattern: /(?:I\s+)?want\s+to\s+(.+?)(?:\.|\n|$)/i, key: 'goal', type: 'goal' },
    ];
    for (const { pattern, key, type } of decisionPatterns) {
      const match = input_text.match(pattern);
      if (match && match[1]) {
        const value = match[1].trim();
        if (value.length > 3 && value.length < 200) {
          semantic_facts.push({
            id: uuidv4(),
            fact_key: key,
            fact_value: value,
            context: `${type.charAt(0).toUpperCase() + type.slice(1)} from session ${context.session_id}`,
            confidence: 0.85,
            fact_type: type,
            properties: {
              certainty_level: 'stated',
              importance: 'high',
              actionability: type === 'task' || type === 'goal' ? 'actionable' : 'reference',
              extraction_method: 'pattern_decision'
            }
          });
        }
      }
    }
    
    // 5. Extract credentials / API keys / tokens (with masking)
    const credentialPatterns = [
      { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{16,})["']?/i, key: 'api_key' },
      { pattern: /(?:token|access_token)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{16,})["']?/i, key: 'token' },
      { pattern: /(?:secret|client_secret)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{16,})["']?/i, key: 'secret' },
    ];
    for (const { pattern, key } of credentialPatterns) {
      const match = input_text.match(pattern);
      if (match && match[1]) {
        const masked = match[1].slice(0, 4) + '****' + match[1].slice(-4);
        semantic_facts.push({
          id: uuidv4(),
          fact_key: key,
          fact_value: masked,
          context: `Credential reference (masked) from session ${context.session_id}`,
          confidence: 0.95,
          fact_type: 'credential',
          properties: {
            certainty_level: 'stated',
            importance: 'critical',
            actionability: 'actionable',
            extraction_method: 'pattern_credential_masked'
          }
        });
      }
    }
    
    // 6. Extract email addresses
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    const emails = input_text.match(emailPattern) || [];
    for (const email of [...new Set(emails)]) {
      semantic_facts.push({
        id: uuidv4(),
        fact_key: 'email_reference',
        fact_value: email,
        context: `Email mentioned in session ${context.session_id}`,
        confidence: 0.95,
        fact_type: 'contact',
        properties: {
          certainty_level: 'stated',
          importance: 'useful',
          actionability: 'reference',
          extraction_method: 'pattern_email'
        }
      });
    }

    // 7. Extract person names and biographical facts
    // High-value permanent facts: names, ages, relationships
    const personPatterns = [
      // Name introductions: "his name is Johnny", "my son is Johnny", "she is called Jane"
      // Use \b (word boundary) to prevent capturing trailing words like "is"
      {
        pattern: /(?:his|her|their|my)\s+(?:name\s+is|called)\s+([A-Z][a-zA-Z\-]+(?:\s+[A-Z][a-zA-Z\-]+)?)\b/gi,
        key: 'person_name',
        type: 'biography'
      },
      // "[Name] is my son/daughter/brother/etc"
      {
        pattern: /([A-Z][a-zA-Z\-]+(?:\s+[A-Z][a-zA-Z\-]+)?)\s+is\s+my\s+(son|daughter|child|kid|brother|sister|wife|husband|partner|friend|colleague)\b/gi,
        key: 'person_relationship',
        type: 'biography'
      },
      // "my son/daughter [Name]" — word boundary prevents "is" from being captured
      {
        pattern: /my\s+(son|daughter|child|kid|brother|sister)\s+([A-Z][a-zA-Z\-]+(?:\s+[A-Z][a-zA-Z\-]+)?)\b/gi,
        key: 'person_relationship',
        type: 'biography'
      },
      // Age: "he is 15", "Johnny is 15 years old", "she is 15"
      {
        pattern: /(?:he|she|they|[A-Z][a-zA-Z\-]+)\s+is\s+(\d{1,3})(?:\s+years?\s+old)?\b/gi,
        key: 'person_age',
        type: 'biography'
      },
      // "btw his name is [Name] he is [age]" — combined pattern
      {
        pattern: /(?:his|her)\s+name\s+is\s+([A-Z][a-zA-Z\-]+).*?\s+(?:he|she)\s+is\s+(\d{1,3})\b/gi,
        key: 'person_name_age',
        type: 'biography'
      },
    ];
    for (const { pattern, key, type } of personPatterns) {
      const matches = input_text.matchAll(pattern);
      for (const match of matches) {
        let factValue: string;
        if (key === 'person_name_age' && match[1] && match[2]) {
          factValue = `${match[1].trim()} is ${match[2].trim()} years old`;
        } else if (key === 'person_relationship' && match[1] && match[2]) {
          // For "Name is my son" pattern
          if (match[0].toLowerCase().startsWith('my ')) {
            factValue = `${match[2].trim()} is user's ${match[1].trim()}`;
          } else {
            factValue = `${match[1].trim()} is user's ${match[2].trim()}`;
          }
        } else if (match[1]) {
          factValue = match[1].trim();
        } else {
          continue;
        }

        if (factValue.length > 2 && factValue.length < 200) {
          semantic_facts.push({
            id: uuidv4(),
            fact_key: key,
            fact_value: factValue,
            context: `Personal fact from session ${context.session_id}`,
            confidence: 0.9,
            fact_type: type,
            properties: {
              certainty_level: 'stated',
              importance: 'high',
              actionability: 'reference',
              extraction_method: 'pattern_person_biography'
            }
          });
        }
      }
    }

    return { entities, relationships, events, semantic_facts };
  }

  private createEmptyExtraction(
    input_text: string,
    context: ExtractionContext,
    start_time: number,
    reason: string
  ): ExtractionResult {
    return {
      entities: [],
      relationships: [],
      events: [],
      semantic_facts: [],
      processing_metadata: {
        input_length: input_text.length,
        extraction_time: Date.now() - start_time,
        llm_used: false,
        extraction_method: `skipped_${reason}`
      }
    };
  }

  private transformLLMResponse(llm_result: any, context: ExtractionContext): Omit<ExtractionResult, 'processing_metadata'> {
    const timestamp = context.timestamp;
    
    // Transform entities
    const entities: ExtractedEntity[] = (llm_result.entities || []).map((entity: any) => ({
      id: uuidv4(),
      type: entity.type || 'general',
      name: entity.name || 'unnamed',
      properties: {
        ...entity.properties,
        session_id: context.session_id,
        discovered_at: timestamp.toISOString()
      },
      confidence: entity.confidence || 0.7
    }));

    // Create entity name to ID mapping for relationships
    const entityMap = new Map(entities.map(e => [e.name, e.id]));

    // Transform relationships
    const relationships: ExtractedRelationship[] = (llm_result.relationships || []).map((rel: any) => {
      const from_id = entityMap.get(rel.from_entity) || uuidv4();
      const to_id = entityMap.get(rel.to_entity) || uuidv4();
      
      return {
        id: uuidv4(),
        from_entity_id: from_id,
        to_entity_id: to_id,
        relationship_type: rel.relationship_type || 'related_to',
        properties: {
          ...rel.properties,
          session_id: context.session_id,
          created_at: timestamp.toISOString()
        },
        confidence: rel.confidence || 0.7
      };
    });

    // Transform activities into events
    const events: ExtractedEvent[] = (llm_result.activities || []).map((activity: any) => {
      const involved_entity_ids = entities
        .filter(e => activity.participants?.includes(e.name))
        .map(e => e.id);

      return {
        id: uuidv4(),
        event_type: activity.activity_type || 'general',
        timestamp: timestamp,
        description: activity.description || '',
        entities_involved: involved_entity_ids,
        metadata: {
          ...activity.context,
          session_id: context.session_id,
          user_id: context.user_id,
          temporal_info: activity.temporal_info,
          extracted_at: timestamp.toISOString()
        },
        confidence: activity.confidence || 0.7
      };
    });

    // Transform knowledge into semantic facts
    const semantic_facts: ExtractedSemanticFact[] = (llm_result.knowledge || []).map((knowledge: any) => ({
      id: uuidv4(),
      fact_key: knowledge.knowledge_type || 'general_knowledge',
      fact_value: knowledge.content,
      context: knowledge.context || `Extracted from session ${context.session_id}`,
      confidence: knowledge.confidence || 0.7,
      fact_type: knowledge.knowledge_type || 'general',
      properties: {
        certainty_level: knowledge.attributes?.certainty || 'likely',
        importance: knowledge.attributes?.importance || 'useful',
        actionability: knowledge.attributes?.actionability || 'reference',
        emotional_weight: knowledge.attributes?.emotional_context || 'neutral',
        expertise_level: knowledge.attributes?.expertise_level || 'general',
        change_frequency: knowledge.attributes?.stability || 'static',
        sharing_context: knowledge.attributes?.scope || 'personal',
        domain: knowledge.domain,
        original_content: knowledge.content
      }
    }));

    // Also create semantic facts from simple entities if they represent facts
    entities.forEach(entity => {
      if (entity.type === 'concept' || entity.type === 'preference' || entity.type === 'skill') {
        semantic_facts.push({
          id: uuidv4(),
          fact_key: `entity_${entity.type}`,
          fact_value: entity.name,
          context: `Entity extracted from user input: ${entity.name}`,
          confidence: entity.confidence,
          fact_type: entity.type,
          properties: {
            certainty_level: 'stated',
            importance: 'useful',
            actionability: 'reference',
            emotional_weight: 'neutral',
            expertise_level: 'general',
            change_frequency: 'static',
            sharing_context: 'personal',
            source_entity_id: entity.id
          }
        });
      }
    });

    return {
      entities,
      relationships,
      events,
      semantic_facts
    };
  }

  private createFallbackExtraction(
    input_text: string, 
    context: ExtractionContext, 
    start_time: number
  ): ExtractionResult {
    console.log(`🔧 Creating fallback extraction for: "${input_text.substring(0, 50)}..."`);
    
    const entities: ExtractedEntity[] = [];
    const relationships: ExtractedRelationship[] = [];
    const events: ExtractedEvent[] = [];
    const semantic_facts: ExtractedSemanticFact[] = [];

    // Extract basic patterns
    const patterns = {
      person: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g,
      email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
      url: /https?:\/\/[^\s]+/g,
      date: /\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g,
      number: /\b\d+(?:\.\d+)?\s*(?:years?|months?|days?|hours?|minutes?|seconds?|%|percent|dollars?|\$)\b/g
    };

    // Extract entities using patterns
    for (const [type, pattern] of Object.entries(patterns)) {
      const matches = input_text.match(pattern) || [];
      for (const match of matches) {
        entities.push({
          id: uuidv4(),
          type,
          name: match.trim(),
          properties: { 
            raw_text: match,
            extraction_method: 'pattern_matching',
            session_id: context.session_id 
          },
          confidence: 0.6
        });
      }
    }

    // Create a basic event for the entire input
    events.push({
      id: uuidv4(),
      event_type: 'user_communication',
      timestamp: context.timestamp,
      description: input_text.substring(0, 200) + (input_text.length > 200 ? '...' : ''),
      entities_involved: entities.map(e => e.id),
      metadata: {
        session_id: context.session_id,
        user_id: context.user_id,
        input_length: input_text.length,
        extraction_method: 'fallback'
      },
      confidence: 0.8
    });

    // Create a semantic fact from the user input
    semantic_facts.push({
      id: uuidv4(),
      fact_key: 'user_statement',
      fact_value: input_text,
      context: `User communication in session ${context.session_id}`,
      confidence: 0.9,
      fact_type: 'communication',
      properties: {
        certainty_level: 'stated',
        importance: 'useful',
        actionability: 'reference',
        emotional_weight: 'neutral',
        expertise_level: 'user_provided',
        change_frequency: 'static',
        sharing_context: 'personal',
        extraction_method: 'fallback'
      }
    });

    // Extract key-value pairs as semantic facts
    const kvPattern = /(\w+):\s*([^,\n]+)/g;
    let kvMatch;
    while ((kvMatch = kvPattern.exec(input_text)) !== null) {
      semantic_facts.push({
        id: uuidv4(),
        fact_key: kvMatch[1].toLowerCase(),
        fact_value: kvMatch[2].trim(),
        context: `Key-value pair extracted from user input in session ${context.session_id}`,
        confidence: 0.8,
        fact_type: 'attribute',
        properties: {
          certainty_level: 'stated',
          importance: 'useful',
          actionability: 'reference',
          emotional_weight: 'neutral',
          expertise_level: 'user_provided',
          change_frequency: 'static',
          sharing_context: 'personal'
        }
      });
    }

    console.log(`🔧 Fallback extraction created: ${entities.length} entities, ${semantic_facts.length} facts`);

    return {
      entities,
      relationships,
      events,
      semantic_facts,
      processing_metadata: {
        input_length: input_text.length,
        extraction_time: Date.now() - start_time,
        llm_used: false,
        extraction_method: 'fallback_patterns'
      }
    };
  }

  private buildContextString(context: ExtractionContext): string {
    const parts = [
      `Session: ${context.session_id}`,
      `User: ${context.user_id}`,
      `Time: ${context.timestamp.toISOString()}`
    ];

    if (context.conversation_history && context.conversation_history.length > 0) {
      parts.push(`Recent conversation: ${context.conversation_history.slice(-3).join(' | ')}`);
    }

    if (context.current_entities && context.current_entities.length > 0) {
      parts.push(`Current entities: ${context.current_entities.join(', ')}`);
    }

    if (context.extraction_focus) {
      parts.push(`Focus: ${context.extraction_focus}`);
    }

    return parts.join('\n');
  }

  async validateExtraction(extraction: ExtractionResult): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate entities
    for (const entity of extraction.entities) {
      if (!entity.id) errors.push('Entity missing ID');
      if (!entity.name) errors.push('Entity missing name');
      if (!entity.type) warnings.push('Entity missing type');
      if (entity.confidence < 0 || entity.confidence > 1) {
        warnings.push(`Entity ${entity.name} has invalid confidence: ${entity.confidence}`);
      }
    }

    // Validate relationships
    for (const rel of extraction.relationships) {
      if (!rel.id) errors.push('Relationship missing ID');
      if (!rel.from_entity_id || !rel.to_entity_id) {
        errors.push('Relationship missing entity IDs');
      }
      if (!rel.relationship_type) warnings.push('Relationship missing type');
    }

    // Validate events
    for (const event of extraction.events) {
      if (!event.id) errors.push('Event missing ID');
      if (!event.event_type) warnings.push('Event missing type');
      if (!event.timestamp) errors.push('Event missing timestamp');
    }

    // Validate semantic facts
    for (const fact of extraction.semantic_facts) {
      if (!fact.id) errors.push('Semantic fact missing ID');
      if (!fact.fact_key) errors.push('Semantic fact missing key');
      if (fact.fact_value === undefined || fact.fact_value === null) {
        warnings.push('Semantic fact has empty value');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}

export const extraction_service = new ExtractionService();