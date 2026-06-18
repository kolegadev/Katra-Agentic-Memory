/**
 * Memory Consolidation Service
 * 
 * Consolidates and organizes memories over time, creating user-level profiles
 * and identifying patterns across conversations for better memory recall.
 */

import { get_database } from '../database/connection.js';
import { MemoryManager } from './memory-manager.js';
import type { EpisodicEvent, SemanticFact, KnowledgeNode } from '../types/memory.js';

export interface UserMemoryProfile {
  userId: string;
  profileCreated: Date;
  lastUpdated: Date;
  
  // Conversation patterns
  totalSessions: number;
  totalMessages: number;
  avgSessionLength: number;
  preferredTopics: TopicSummary[];
  communicationStyle: CommunicationStyle;
  
  // Knowledge areas
  expertiseAreas: ExpertiseArea[];
  interestAreas: InterestArea[];
  keyEntities: EntitySummary[];
  
  // Temporal patterns
  activityPatterns: ActivityPattern[];
  knowledgeEvolution: KnowledgeEvolution[];
  
  // Memory statistics
  memoryStats: MemoryStatistics;
}

export interface TopicSummary {
  topic: string;
  frequency: number;
  lastMentioned: Date;
  relatedTopics: string[];
  sentimentScore: number;
  confidenceLevel: number;
}

export interface CommunicationStyle {
  formalityLevel: number; // 0-1 scale
  technicalDepth: number; // 0-1 scale
  questionFrequency: number;
  avgMessageLength: number;
  preferredResponseLength: 'brief' | 'detailed' | 'comprehensive';
  commonPhrases: string[];
}

export interface ExpertiseArea {
  domain: string;
  confidenceLevel: number;
  evidenceCount: number;
  keyTerms: string[];
  relatedProjects: string[];
  knowledgeDepth: 'beginner' | 'intermediate' | 'advanced' | 'expert';
}

export interface InterestArea {
  topic: string;
  interestLevel: number;
  engagementHistory: EngagementPoint[];
  relatedQuestions: string[];
  learningProgression: LearningPoint[];
}

export interface EntitySummary {
  entityId: string;
  entityName: string;
  entityType: string;
  mentionCount: number;
  relationship: 'personal' | 'professional' | 'interest' | 'project';
  lastInteraction: Date;
  contextSummary: string;
}

export interface ActivityPattern {
  timeRange: 'daily' | 'weekly' | 'monthly';
  pattern: Record<string, number>;
  peakActivity: string;
  quietPeriods: string[];
}

export interface KnowledgeEvolution {
  domain: string;
  timelineSessions: string[];
  progressionPoints: LearningPoint[];
  skillDevelopment: SkillDevelopment[];
}

export interface EngagementPoint {
  sessionId: string;
  timestamp: Date;
  engagementLevel: number;
  topics: string[];
}

export interface LearningPoint {
  sessionId: string;
  timestamp: Date;
  concept: string;
  understandingLevel: number;
  questions: string[];
}

export interface SkillDevelopment {
  skill: string;
  startLevel: number;
  currentLevel: number;
  evidence: string[];
  milestones: Date[];
}

export interface MemoryStatistics {
  totalEpisodicEvents: number;
  totalSemanticFacts: number;
  totalKnowledgeNodes: number;
  averageSessionQuality: number;
  memoryRetentionRate: number;
  crossSessionConnections: number;
}

export interface ConsolidationTask {
  taskId: string;
  userId: string;
  taskType: 'profile_update' | 'pattern_analysis' | 'knowledge_mapping' | 'cleanup';
  priority: 'high' | 'medium' | 'low';
  scheduledFor: Date;
  estimatedDuration: number;
  dependencies: string[];
}

class MemoryConsolidator {
  private memoryManager = MemoryManager.get_instance();

  /**
   * Build comprehensive user memory profile
   */
  async buildUserMemoryProfile(userId: string): Promise<UserMemoryProfile> {
    console.log('🧠 Building comprehensive memory profile for user:', userId);

    const startTime = Date.now();
    const db = get_database();

    try {
      // Get all user data
      const [episodicEvents, semanticFacts, knowledgeNodes] = await Promise.all([
        this.getUserEpisodicEvents(userId),
        this.getUserSemanticFacts(userId),
        this.getUserKnowledgeNodes(userId)
      ]);

      // Analyze conversation patterns
      const conversationPatterns = await this.analyzeConversationPatterns(episodicEvents);
      
      // Identify expertise and interest areas
      const expertiseAreas = await this.identifyExpertiseAreas(episodicEvents, semanticFacts, knowledgeNodes);
      const interestAreas = await this.identifyInterestAreas(episodicEvents);
      
      // Extract key entities
      const keyEntities = await this.extractKeyEntities(knowledgeNodes, episodicEvents);
      
      // Analyze temporal patterns
      const activityPatterns = this.analyzeActivityPatterns(episodicEvents);
      const knowledgeEvolution = await this.analyzeKnowledgeEvolution(episodicEvents, expertiseAreas);
      
      // Calculate memory statistics
      const memoryStats = this.calculateMemoryStatistics(episodicEvents, semanticFacts, knowledgeNodes);

      const profile: UserMemoryProfile = {
        userId,
        profileCreated: new Date(),
        lastUpdated: new Date(),
        
        totalSessions: conversationPatterns.totalSessions,
        totalMessages: conversationPatterns.totalMessages,
        avgSessionLength: conversationPatterns.avgSessionLength,
        preferredTopics: conversationPatterns.preferredTopics,
        communicationStyle: conversationPatterns.communicationStyle,
        
        expertiseAreas,
        interestAreas,
        keyEntities,
        
        activityPatterns,
        knowledgeEvolution,
        
        memoryStats
      };

      // Store profile in memory system
      await this.storeUserProfile(profile);

      const executionTime = Date.now() - startTime;

      console.log('✅ User memory profile built successfully:', {
        userId,
        totalSessions: profile.totalSessions,
        expertiseAreas: profile.expertiseAreas.length,
        interestAreas: profile.interestAreas.length,
        keyEntities: profile.keyEntities.length,
        executionTime: `${executionTime}ms`
      });

      return profile;

    } catch (error) {
      console.error('❌ Failed to build user memory profile:', error);
      throw error;
    }
  }

  /**
   * Get all episodic events for a user
   */
  private async getUserEpisodicEvents(userId: string): Promise<EpisodicEvent[]> {
    const db = get_database();
    const events = await db.collection('episodic_events')
      .find({ user_id: userId })
      .sort({ timestamp: 1 })
      .toArray();
    return events as unknown as EpisodicEvent[];
  }

  /**
   * Get all semantic facts for a user
   */
  private async getUserSemanticFacts(userId: string): Promise<SemanticFact[]> {
    const db = get_database();
    const facts = await db.collection('semantic_facts')
      .find({ user_id: userId })
      .sort({ created_at: 1 })
      .toArray();
    return facts as unknown as SemanticFact[];
  }

  /**
   * Get all knowledge nodes for a user
   */
  private async getUserKnowledgeNodes(userId: string): Promise<KnowledgeNode[]> {
    const db = get_database();
    const nodes = await db.collection('knowledge_nodes')
      .find({ 'properties.user_id': userId })
      .sort({ updated_at: -1 })
      .toArray();
    return nodes as unknown as KnowledgeNode[];
  }

  /**
   * Analyze conversation patterns from episodic events
   */
  private async analyzeConversationPatterns(events: EpisodicEvent[]): Promise<{
    totalSessions: number;
    totalMessages: number;
    avgSessionLength: number;
    preferredTopics: TopicSummary[];
    communicationStyle: CommunicationStyle;
  }> {
    // Group events by session
    const sessionGroups = new Map<string, EpisodicEvent[]>();
    for (const event of events) {
      if (event.session_id) {
        if (!sessionGroups.has(event.session_id)) {
          sessionGroups.set(event.session_id, []);
        }
        sessionGroups.get(event.session_id)!.push(event);
      }
    }

    const totalSessions = sessionGroups.size;
    const totalMessages = events.filter(e => e.event_type === 'user_message').length;
    
    // Calculate average session length
    const sessionLengths = Array.from(sessionGroups.values()).map(events => events.length);
    const avgSessionLength = sessionLengths.reduce((sum, len) => sum + len, 0) / sessionLengths.length || 0;

    // Extract topics
    const topicCounts = new Map<string, { count: number; lastMentioned: Date; sentiment: number[] }>();
    
    for (const event of events) {
      const content = event.content?.message || JSON.stringify(event.content);
      const topics = this.extractTopicsFromContent(content);
      const timestamp = event.timestamp || new Date();
      
      for (const topic of topics) {
        if (!topicCounts.has(topic)) {
          topicCounts.set(topic, { count: 0, lastMentioned: new Date(0), sentiment: [] });
        }
        const topicData = topicCounts.get(topic)!;
        topicData.count++;
        if (timestamp > topicData.lastMentioned) {
          topicData.lastMentioned = timestamp;
        }
        // Simple sentiment analysis (placeholder)
        topicData.sentiment.push(this.analyzeSentiment(content));
      }
    }

    // Convert to TopicSummary
    const preferredTopics: TopicSummary[] = Array.from(topicCounts.entries())
      .map(([topic, data]) => ({
        topic,
        frequency: data.count,
        lastMentioned: data.lastMentioned,
        relatedTopics: this.findRelatedTopics(topic, Array.from(topicCounts.keys())),
        sentimentScore: data.sentiment.reduce((sum, s) => sum + s, 0) / data.sentiment.length,
        confidenceLevel: Math.min(data.count / 10, 1.0) // Simple confidence calculation
      }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 20);

    // Analyze communication style
    const userMessages = events.filter(e => e.event_type === 'user_message');
    const messageLengths = userMessages.map(e => (e.content?.message || '').length);
    const avgMessageLength = messageLengths.reduce((sum, len) => sum + len, 0) / messageLengths.length || 0;
    
    const communicationStyle: CommunicationStyle = {
      formalityLevel: this.analyzeFormalityLevel(userMessages),
      technicalDepth: this.analyzeTechnicalDepth(userMessages),
      questionFrequency: userMessages.filter(e => (e.content?.message || '').includes('?')).length / userMessages.length,
      avgMessageLength,
      preferredResponseLength: this.inferPreferredResponseLength(avgMessageLength),
      commonPhrases: this.extractCommonPhrases(userMessages)
    };

    return {
      totalSessions,
      totalMessages,
      avgSessionLength,
      preferredTopics,
      communicationStyle
    };
  }

  /**
   * Identify expertise areas from user's memory
   */
  private async identifyExpertiseAreas(
    events: EpisodicEvent[],
    facts: SemanticFact[],
    nodes: KnowledgeNode[]
  ): Promise<ExpertiseArea[]> {
    const domainMap = new Map<string, {
      mentions: number;
      evidence: string[];
      keyTerms: Set<string>;
      confidenceScores: number[];
    }>();

    // Analyze episodic events for expertise indicators
    for (const event of events) {
      const content = event.content?.message || JSON.stringify(event.content);
      const domains = this.extractExpertiseDomains(content);
      
      for (const domain of domains) {
        if (!domainMap.has(domain)) {
          domainMap.set(domain, {
            mentions: 0,
            evidence: [],
            keyTerms: new Set(),
            confidenceScores: []
          });
        }
        
        const domainData = domainMap.get(domain)!;
        domainData.mentions++;
        domainData.evidence.push(content.substring(0, 100));
        
        // Extract technical terms
        const techTerms = this.extractTechnicalTerms(content, domain);
        techTerms.forEach(term => domainData.keyTerms.add(term));
        
        // Calculate confidence based on language used
        domainData.confidenceScores.push(this.calculateExpertiseConfidence(content, domain));
      }
    }

    // Enhance with semantic facts and knowledge nodes
    for (const fact of facts) {
      const domains = this.extractExpertiseDomains(fact.content || '');
      for (const domain of domains) {
        if (domainMap.has(domain)) {
          const domainData = domainMap.get(domain)!;
          domainData.confidenceScores.push(fact.confidence || 0.5);
        }
      }
    }

    // Convert to ExpertiseArea objects
    const expertiseAreas: ExpertiseArea[] = [];
    
    for (const [domain, data] of domainMap) {
      if (data.mentions >= 3) { // Threshold for considering it an expertise area
        const avgConfidence = data.confidenceScores.reduce((sum, conf) => sum + conf, 0) / data.confidenceScores.length;
        
        expertiseAreas.push({
          domain,
          confidenceLevel: avgConfidence,
          evidenceCount: data.evidence.length,
          keyTerms: Array.from(data.keyTerms).slice(0, 10),
          relatedProjects: this.extractRelatedProjects(data.evidence),
          knowledgeDepth: this.determineKnowledgeDepth(avgConfidence, data.mentions, data.keyTerms.size)
        });
      }
    }

    return expertiseAreas.sort((a, b) => b.confidenceLevel - a.confidenceLevel);
  }

  /**
   * Identify areas of interest from conversations
   */
  private async identifyInterestAreas(events: EpisodicEvent[]): Promise<InterestArea[]> {
    const interestMap = new Map<string, {
      engagements: EngagementPoint[];
      questions: string[];
      learningPoints: LearningPoint[];
    }>();

    // Group events by session to analyze engagement
    const sessionGroups = new Map<string, EpisodicEvent[]>();
    for (const event of events) {
      if (event.session_id) {
        if (!sessionGroups.has(event.session_id)) {
          sessionGroups.set(event.session_id, []);
        }
        sessionGroups.get(event.session_id)!.push(event);
      }
    }

    // Analyze each session for interests
    for (const [sessionId, sessionEvents] of sessionGroups) {
      const topics = new Set<string>();
      const questions: string[] = [];
      let engagementLevel = 0;

      for (const event of sessionEvents) {
        const content = event.content?.message || '';
        const eventTopics = this.extractTopicsFromContent(content);
        eventTopics.forEach(topic => topics.add(topic));

        if (event.event_type === 'user_message') {
          // Track questions
          if (content.includes('?')) {
            questions.push(content);
          }
          
          // Calculate engagement based on message length and complexity
          engagementLevel += Math.min(content.length / 100, 2.0);
        }
      }

      // Create engagement points for interested topics
      for (const topic of topics) {
        if (!interestMap.has(topic)) {
          interestMap.set(topic, {
            engagements: [],
            questions: [],
            learningPoints: []
          });
        }

        const interestData = interestMap.get(topic)!;
        
        if (engagementLevel > 1.0) { // Threshold for genuine interest
          interestData.engagements.push({
            sessionId,
            timestamp: sessionEvents[0].timestamp || new Date(),
            engagementLevel,
            topics: Array.from(topics)
          });
        }

        // Add relevant questions
        const relevantQuestions = questions.filter(q => 
          this.isQuestionRelevantToTopic(q, topic)
        );
        interestData.questions.push(...relevantQuestions);

        // Track learning progression
        if (this.indicatesLearning(sessionEvents, topic)) {
          interestData.learningPoints.push({
            sessionId,
            timestamp: sessionEvents[0].timestamp || new Date(),
            concept: topic,
            understandingLevel: this.assessUnderstandingLevel(sessionEvents, topic),
            questions: relevantQuestions
          });
        }
      }
    }

    // Convert to InterestArea objects
    const interestAreas: InterestArea[] = [];
    
    for (const [topic, data] of interestMap) {
      if (data.engagements.length >= 2) { // Must show sustained interest
        const avgEngagement = data.engagements.reduce((sum, eng) => sum + eng.engagementLevel, 0) / data.engagements.length;
        
        interestAreas.push({
          topic,
          interestLevel: Math.min(avgEngagement, 1.0),
          engagementHistory: data.engagements.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
          relatedQuestions: data.questions.slice(0, 10),
          learningProgression: data.learningPoints.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        });
      }
    }

    return interestAreas.sort((a, b) => b.interestLevel - a.interestLevel);
  }

  /**
   * Extract key entities from knowledge nodes and events
   */
  private async extractKeyEntities(nodes: KnowledgeNode[], events: EpisodicEvent[]): Promise<EntitySummary[]> {
    const entityMap = new Map<string, {
      mentions: number;
      lastInteraction: Date;
      contexts: string[];
      relationshipIndicators: string[];
    }>();

    // Count entity mentions in events
    for (const event of events) {
      const content = event.content?.message || JSON.stringify(event.content);
      const timestamp = event.timestamp || new Date();
      
      // Find entity mentions in content
      for (const node of nodes) {
        const entityName = node.properties?.name || node.properties?.canonical_name || '';
        if (entityName && content.toLowerCase().includes(entityName.toLowerCase())) {
          if (!entityMap.has(node.id)) {
            entityMap.set(node.id, {
              mentions: 0,
              lastInteraction: new Date(0),
              contexts: [],
              relationshipIndicators: []
            });
          }
          
          const entityData = entityMap.get(node.id)!;
          entityData.mentions++;
          if (timestamp > entityData.lastInteraction) {
            entityData.lastInteraction = timestamp;
          }
          entityData.contexts.push(content.substring(0, 200));
          
          // Analyze relationship indicators
          const relationship = this.inferEntityRelationship(content, entityName);
          if (relationship) {
            entityData.relationshipIndicators.push(relationship);
          }
        }
      }
    }

    // Convert to EntitySummary objects
    const entitySummaries: EntitySummary[] = [];
    
    for (const node of nodes) {
      const entityData = entityMap.get(node.id);
      if (entityData && entityData.mentions > 0) {
        const relationship = this.determineEntityRelationship(entityData.relationshipIndicators);
        
        entitySummaries.push({
          entityId: node.id,
          entityName: node.properties?.name || node.properties?.canonical_name || '',
          entityType: node.type,
          mentionCount: entityData.mentions,
          relationship,
          lastInteraction: entityData.lastInteraction,
          contextSummary: this.summarizeContexts(entityData.contexts)
        });
      }
    }

    return entitySummaries.sort((a, b) => b.mentionCount - a.mentionCount).slice(0, 50);
  }

  /**
   * Analyze activity patterns over time
   */
  private analyzeActivityPatterns(events: EpisodicEvent[]): ActivityPattern[] {
    const patterns: ActivityPattern[] = [];

    // Daily pattern
    const hourCounts = new Array(24).fill(0);
    const dayOfWeekCounts = new Array(7).fill(0);
    const monthCounts = new Array(12).fill(0);

    for (const event of events) {
      const timestamp = event.timestamp || new Date();
      hourCounts[timestamp.getHours()]++;
      dayOfWeekCounts[timestamp.getDay()]++;
      monthCounts[timestamp.getMonth()]++;
    }

    // Daily pattern
    const dailyPattern: Record<string, number> = {};
    hourCounts.forEach((count, hour) => {
      dailyPattern[`${hour}:00`] = count;
    });
    
    patterns.push({
      timeRange: 'daily',
      pattern: dailyPattern,
      peakActivity: this.findPeakActivity(dailyPattern),
      quietPeriods: this.findQuietPeriods(dailyPattern)
    });

    // Weekly pattern
    const weeklyPattern: Record<string, number> = {};
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    dayOfWeekCounts.forEach((count, day) => {
      weeklyPattern[dayNames[day]] = count;
    });
    
    patterns.push({
      timeRange: 'weekly',
      pattern: weeklyPattern,
      peakActivity: this.findPeakActivity(weeklyPattern),
      quietPeriods: this.findQuietPeriods(weeklyPattern)
    });

    return patterns;
  }

  /**
   * Analyze knowledge evolution over time
   */
  private async analyzeKnowledgeEvolution(
    events: EpisodicEvent[],
    expertiseAreas: ExpertiseArea[]
  ): Promise<KnowledgeEvolution[]> {
    const evolutions: KnowledgeEvolution[] = [];

    for (const area of expertiseAreas.slice(0, 5)) { // Top 5 expertise areas
      const domainEvents = events.filter(event => {
        const content = event.content?.message || JSON.stringify(event.content);
        return this.isContentRelatedToDomain(content, area.domain);
      });

      if (domainEvents.length < 3) continue;

      // Group by sessions
      const sessionGroups = new Map<string, EpisodicEvent[]>();
      for (const event of domainEvents) {
        if (event.session_id) {
          if (!sessionGroups.has(event.session_id)) {
            sessionGroups.set(event.session_id, []);
          }
          sessionGroups.get(event.session_id)!.push(event);
        }
      }

      // Analyze progression
      const progressionPoints: LearningPoint[] = [];
      const skillDevelopment: SkillDevelopment[] = [];

      for (const [sessionId, sessionEvents] of sessionGroups) {
        const sessionTimestamp = sessionEvents[0].timestamp || new Date();
        const concepts = this.extractConceptsFromSession(sessionEvents, area.domain);
        const understandingLevel = this.assessSessionUnderstandingLevel(sessionEvents, area.domain);

        for (const concept of concepts) {
          progressionPoints.push({
            sessionId,
            timestamp: sessionTimestamp,
            concept,
            understandingLevel,
            questions: this.extractQuestionsAboutConcept(sessionEvents, concept)
          });
        }
      }

      // Track skill development
      const skills = this.identifySkillsInDomain(area.domain, domainEvents);
      for (const skill of skills) {
        const skillEvents = domainEvents.filter(event => 
          this.isEventRelatedToSkill(event, skill)
        );
        
        if (skillEvents.length >= 2) {
          const startLevel = this.assessSkillLevel(skillEvents.slice(0, Math.ceil(skillEvents.length / 3)));
          const currentLevel = this.assessSkillLevel(skillEvents.slice(-Math.ceil(skillEvents.length / 3)));
          
          skillDevelopment.push({
            skill,
            startLevel,
            currentLevel,
            evidence: skillEvents.map(e => e.content?.message || '').slice(0, 5),
            milestones: this.identifySkillMilestones(skillEvents)
          });
        }
      }

      evolutions.push({
        domain: area.domain,
        timelineSessions: Array.from(sessionGroups.keys()).sort(),
        progressionPoints: progressionPoints.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
        skillDevelopment
      });
    }

    return evolutions;
  }

  /**
   * Calculate comprehensive memory statistics
   */
  private calculateMemoryStatistics(
    events: EpisodicEvent[],
    facts: SemanticFact[],
    nodes: KnowledgeNode[]
  ): MemoryStatistics {
    // Calculate session quality
    const sessionGroups = new Map<string, EpisodicEvent[]>();
    for (const event of events) {
      if (event.session_id) {
        if (!sessionGroups.has(event.session_id)) {
          sessionGroups.set(event.session_id, []);
        }
        sessionGroups.get(event.session_id)!.push(event);
      }
    }

    let totalQuality = 0;
    let qualityCount = 0;

    for (const sessionEvents of sessionGroups.values()) {
      const quality = this.calculateSessionQuality(sessionEvents);
      totalQuality += quality;
      qualityCount++;
    }

    const averageSessionQuality = qualityCount > 0 ? totalQuality / qualityCount : 0;

    // Calculate retention rate (simplified)
    const recentEvents = events.filter(e => {
      const daysSince = (Date.now() - (e.timestamp || new Date()).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince <= 30;
    });
    const memoryRetentionRate = events.length > 0 ? recentEvents.length / events.length : 0;

    // Calculate cross-session connections
    const sessionIds = new Set(events.map(e => e.session_id).filter(Boolean));
    const crossSessionConnections = this.calculateCrossSessionConnections(nodes, Array.from(sessionIds));

    return {
      totalEpisodicEvents: events.length,
      totalSemanticFacts: facts.length,
      totalKnowledgeNodes: nodes.length,
      averageSessionQuality,
      memoryRetentionRate,
      crossSessionConnections
    };
  }

  /**
   * Store user profile in memory system
   */
  private async storeUserProfile(profile: UserMemoryProfile): Promise<void> {
    const db = get_database();
    
    await db.collection('user_memory_profiles').replaceOne(
      { userId: profile.userId },
      profile,
      { upsert: true }
    );
  }

  // Helper methods for analysis (simplified implementations)
  private extractTopicsFromContent(content: string): string[] {
    const topics = new Set<string>();
    
    // Simple keyword extraction for automotive topics
    const automotivePattern = /\b(jaguar|e-type|engine|cylinder|head|porting|restoration|performance|tuning|car|vehicle|automotive)\b/gi;
    const matches = content.match(automotivePattern);
    if (matches) {
      matches.forEach(match => topics.add(match.toLowerCase()));
    }

    // Add more domain-specific patterns
    const techPatterns = [
      /\b(marketing|automation|reddit|social media|campaign|digital|strategy)\b/gi,
      /\b(business|partnership|techcorp|dataflow|project|team)\b/gi
    ];

    for (const pattern of techPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        matches.forEach(match => topics.add(match.toLowerCase()));
      }
    }

    return Array.from(topics);
  }

  private analyzeSentiment(content: string): number {
    // Simple sentiment analysis (placeholder)
    const positiveWords = ['great', 'excellent', 'amazing', 'love', 'perfect', 'wonderful'];
    const negativeWords = ['bad', 'terrible', 'hate', 'awful', 'poor', 'disappointing'];
    
    let score = 0;
    const words = content.toLowerCase().split(/\s+/);
    
    for (const word of words) {
      if (positiveWords.includes(word)) score += 1;
      if (negativeWords.includes(word)) score -= 1;
    }
    
    return Math.max(-1, Math.min(1, score / words.length * 10));
  }

  private findRelatedTopics(topic: string, allTopics: string[]): string[] {
    // Simple related topic finding based on common words
    const topicWords = topic.split(/\s+/);
    const related = [];
    
    for (const otherTopic of allTopics) {
      if (otherTopic === topic) continue;
      
      const otherWords = otherTopic.split(/\s+/);
      const commonWords = topicWords.filter(word => otherWords.includes(word));
      
      if (commonWords.length > 0) {
        related.push(otherTopic);
      }
    }
    
    return related.slice(0, 5);
  }

  private analyzeFormalityLevel(messages: EpisodicEvent[]): number {
    const formalIndicators = ['please', 'thank you', 'would you', 'could you', 'i would appreciate'];
    const informalIndicators = ['hey', 'yeah', 'ok', 'cool', 'awesome'];
    
    let formalCount = 0;
    let informalCount = 0;
    
    for (const message of messages) {
      const content = (message.content?.message || '').toLowerCase();
      
      for (const indicator of formalIndicators) {
        if (content.includes(indicator)) formalCount++;
      }
      
      for (const indicator of informalIndicators) {
        if (content.includes(indicator)) informalCount++;
      }
    }
    
    const total = formalCount + informalCount;
    return total > 0 ? formalCount / total : 0.5;
  }

  private analyzeTechnicalDepth(messages: EpisodicEvent[]): number {
    const technicalTerms = [
      'algorithm', 'optimization', 'performance', 'efficiency', 'configuration',
      'implementation', 'architecture', 'specification', 'parameter', 'variable'
    ];
    
    let technicalCount = 0;
    let totalWords = 0;
    
    for (const message of messages) {
      const content = (message.content?.message || '').toLowerCase();
      const words = content.split(/\s+/);
      totalWords += words.length;
      
      for (const term of technicalTerms) {
        if (content.includes(term)) technicalCount++;
      }
    }
    
    return totalWords > 0 ? Math.min(technicalCount / totalWords * 100, 1.0) : 0;
  }

  private inferPreferredResponseLength(avgMessageLength: number): 'brief' | 'detailed' | 'comprehensive' {
    if (avgMessageLength < 50) return 'brief';
    if (avgMessageLength < 150) return 'detailed';
    return 'comprehensive';
  }

  private extractCommonPhrases(messages: EpisodicEvent[]): string[] {
    const phrases = new Map<string, number>();
    
    for (const message of messages) {
      const content = message.content?.message || '';
      // Extract 2-3 word phrases
      const words = content.toLowerCase().split(/\s+/);
      
      for (let i = 0; i < words.length - 1; i++) {
        const phrase = words.slice(i, i + 2).join(' ');
        if (phrase.length > 5) {
          phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
        }
      }
    }
    
    return Array.from(phrases.entries())
      .filter(([phrase, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([phrase]) => phrase);
  }

  private extractExpertiseDomains(content: string): string[] {
    const domains = [];
    
    // Domain patterns
    const patterns = [
      { domain: 'automotive', pattern: /\b(car|vehicle|engine|cylinder|head|porting|jaguar|e-type)\b/gi },
      { domain: 'digital_marketing', pattern: /\b(marketing|campaign|social|media|reddit|automation)\b/gi },
      { domain: 'business', pattern: /\b(business|partnership|strategy|project|team|management)\b/gi },
      { domain: 'technology', pattern: /\b(technology|software|system|development|programming)\b/gi }
    ];
    
    for (const { domain, pattern } of patterns) {
      if (pattern.test(content)) {
        domains.push(domain);
      }
    }
    
    return domains;
  }

  private extractTechnicalTerms(content: string, domain: string): string[] {
    const terms = new Set<string>();
    
    // Domain-specific technical terms
    const domainTerms = {
      automotive: ['cylinder', 'head', 'porting', 'performance', 'tuning', 'restoration', 'engine'],
      digital_marketing: ['automation', 'campaign', 'targeting', 'conversion', 'analytics'],
      business: ['strategy', 'partnership', 'management', 'operations', 'optimization'],
      technology: ['algorithm', 'database', 'api', 'framework', 'architecture']
    };
    
    const relevantTerms = domainTerms[domain as keyof typeof domainTerms] || [];
    
    for (const term of relevantTerms) {
      if (content.toLowerCase().includes(term)) {
        terms.add(term);
      }
    }
    
    return Array.from(terms);
  }

  private calculateExpertiseConfidence(content: string, domain: string): number {
    // Simple confidence calculation based on technical language and specificity
    const technicalTerms = this.extractTechnicalTerms(content, domain);
    const contentLength = content.length;
    const technicalDensity = technicalTerms.length / Math.max(contentLength / 100, 1);
    
    return Math.min(technicalDensity * 0.3 + 0.4, 1.0);
  }

  private extractRelatedProjects(evidence: string[]): string[] {
    const projects = new Set<string>();
    
    for (const text of evidence) {
      // Look for project-like mentions
      const projectPattern = /\b(project|build|restore|develop|create|work on)\s+([a-zA-Z0-9\s]{3,20})\b/gi;
      const matches = text.match(projectPattern);
      
      if (matches) {
        matches.forEach(match => {
          const cleaned = match.replace(/^(project|build|restore|develop|create|work on)\s+/i, '').trim();
          if (cleaned.length > 2) {
            projects.add(cleaned);
          }
        });
      }
    }
    
    return Array.from(projects).slice(0, 5);
  }

  private determineKnowledgeDepth(confidence: number, mentions: number, termCount: number): 'beginner' | 'intermediate' | 'advanced' | 'expert' {
    const expertiseScore = confidence * 0.4 + Math.min(mentions / 20, 1) * 0.3 + Math.min(termCount / 10, 1) * 0.3;
    
    if (expertiseScore >= 0.8) return 'expert';
    if (expertiseScore >= 0.6) return 'advanced';
    if (expertiseScore >= 0.4) return 'intermediate';
    return 'beginner';
  }

  // Additional helper methods (simplified implementations)
  private isQuestionRelevantToTopic(question: string, topic: string): boolean {
    return question.toLowerCase().includes(topic.toLowerCase());
  }

  private indicatesLearning(events: EpisodicEvent[], topic: string): boolean {
    const questions = events.filter(e => (e.content?.message || '').includes('?')).length;
    const statements = events.filter(e => !((e.content?.message || '').includes('?'))).length;
    return questions > 0 && statements > questions; // More statements than questions suggests learning
  }

  private assessUnderstandingLevel(events: EpisodicEvent[], topic: string): number {
    // Simple assessment based on question complexity and response engagement
    const totalEvents = events.length;
    const questions = events.filter(e => (e.content?.message || '').includes('?')).length;
    const questionRatio = questions / totalEvents;
    
    return Math.max(0.1, 1.0 - questionRatio); // Fewer questions = higher understanding
  }

  private inferEntityRelationship(content: string, entityName: string): string | null {
    const personalIndicators = ['my', 'i have', 'i own', 'personally'];
    const professionalIndicators = ['work', 'client', 'project', 'business'];
    const interestIndicators = ['interested in', 'curious about', 'learning about'];
    
    const contentLower = content.toLowerCase();
    
    if (personalIndicators.some(indicator => contentLower.includes(indicator))) {
      return 'personal';
    }
    if (professionalIndicators.some(indicator => contentLower.includes(indicator))) {
      return 'professional';
    }
    if (interestIndicators.some(indicator => contentLower.includes(indicator))) {
      return 'interest';
    }
    
    return 'project'; // Default fallback
  }

  private determineEntityRelationship(indicators: string[]): 'personal' | 'professional' | 'interest' | 'project' {
    const counts = {
      personal: indicators.filter(i => i === 'personal').length,
      professional: indicators.filter(i => i === 'professional').length,
      interest: indicators.filter(i => i === 'interest').length,
      project: indicators.filter(i => i === 'project').length
    };
    
    const maxCount = Math.max(...Object.values(counts));
    const relationship = Object.entries(counts).find(([, count]) => count === maxCount)?.[0];
    
    return (relationship as 'personal' | 'professional' | 'interest' | 'project') || 'project';
  }

  private summarizeContexts(contexts: string[]): string {
    // Simple summary by taking key phrases from contexts
    const words = contexts.join(' ').split(/\s+/);
    const wordFreq = new Map<string, number>();
    
    for (const word of words) {
      if (word.length > 3) {
        wordFreq.set(word.toLowerCase(), (wordFreq.get(word.toLowerCase()) || 0) + 1);
      }
    }
    
    const topWords = Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
    
    return `Commonly discussed: ${topWords.join(', ')}`;
  }

  private findPeakActivity(pattern: Record<string, number>): string {
    return Object.entries(pattern)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }

  private findQuietPeriods(pattern: Record<string, number>): string[] {
    const avgActivity = Object.values(pattern).reduce((sum, count) => sum + count, 0) / Object.values(pattern).length;
    
    return Object.entries(pattern)
      .filter(([, count]) => count < avgActivity * 0.5)
      .map(([time]) => time);
  }

  private isContentRelatedToDomain(content: string, domain: string): boolean {
    const domainKeywords = {
      automotive: ['car', 'engine', 'jaguar', 'cylinder', 'head', 'porting'],
      digital_marketing: ['marketing', 'campaign', 'reddit', 'automation'],
      business: ['business', 'partnership', 'strategy', 'project'],
      technology: ['technology', 'software', 'system', 'development']
    };
    
    const keywords = domainKeywords[domain as keyof typeof domainKeywords] || [];
    return keywords.some(keyword => content.toLowerCase().includes(keyword));
  }

  private extractConceptsFromSession(events: EpisodicEvent[], domain: string): string[] {
    const concepts = new Set<string>();
    
    for (const event of events) {
      const content = event.content?.message || '';
      const terms = this.extractTechnicalTerms(content, domain);
      terms.forEach(term => concepts.add(term));
    }
    
    return Array.from(concepts);
  }

  private assessSessionUnderstandingLevel(events: EpisodicEvent[], domain: string): number {
    const technicalTerms = events.flatMap(e => this.extractTechnicalTerms(e.content?.message || '', domain));
    const questions = events.filter(e => (e.content?.message || '').includes('?')).length;
    
    return Math.min(1.0, technicalTerms.length * 0.1 + (1 - questions / events.length));
  }

  private extractQuestionsAboutConcept(events: EpisodicEvent[], concept: string): string[] {
    return events
      .filter(e => e.event_type === 'user_message')
      .map(e => e.content?.message || '')
      .filter(msg => msg.includes('?') && msg.toLowerCase().includes(concept.toLowerCase()));
  }

  private identifySkillsInDomain(domain: string, events: EpisodicEvent[]): string[] {
    const skillPatterns = {
      automotive: ['restoration', 'tuning', 'porting', 'diagnostics'],
      digital_marketing: ['automation', 'content creation', 'analytics', 'campaign management'],
      business: ['project management', 'strategy', 'negotiation', 'planning'],
      technology: ['programming', 'system design', 'debugging', 'optimization']
    };
    
    const skills = skillPatterns[domain as keyof typeof skillPatterns] || [];
    
    return skills.filter(skill => 
      events.some(event => (event.content?.message || '').toLowerCase().includes(skill))
    );
  }

  private isEventRelatedToSkill(event: EpisodicEvent, skill: string): boolean {
    const content = event.content?.message || '';
    return content.toLowerCase().includes(skill.toLowerCase());
  }

  private assessSkillLevel(events: EpisodicEvent[]): number {
    // Simple skill level assessment based on language complexity and confidence
    let totalComplexity = 0;
    
    for (const event of events) {
      const content = event.content?.message || '';
      const wordCount = content.split(/\s+/).length;
      const technicalTerms = (content.match(/\b[a-z]{6,}\b/gi) || []).length;
      
      totalComplexity += Math.min(1.0, (wordCount / 50) * 0.5 + (technicalTerms / 10) * 0.5);
    }
    
    return events.length > 0 ? totalComplexity / events.length : 0;
  }

  private identifySkillMilestones(events: EpisodicEvent[]): Date[] {
    // Identify significant learning moments based on content changes
    const milestones: Date[] = [];
    
    for (let i = 1; i < events.length; i++) {
      const prevLevel = this.assessSkillLevel([events[i - 1]]);
      const currentLevel = this.assessSkillLevel([events[i]]);
      
      if (currentLevel > prevLevel + 0.2) { // Significant improvement
        milestones.push(events[i].timestamp || new Date());
      }
    }
    
    return milestones;
  }

  private calculateSessionQuality(events: EpisodicEvent[]): number {
    // Simple quality metric based on engagement and content depth
    const messageCount = events.length;
    const userMessages = events.filter(e => e.event_type === 'user_message').length;
    const avgMessageLength = events.reduce((sum, e) => sum + (e.content?.message?.length || 0), 0) / messageCount;
    
    const engagementScore = Math.min(1.0, userMessages / 10);
    const depthScore = Math.min(1.0, avgMessageLength / 100);
    const lengthScore = Math.min(1.0, messageCount / 20);
    
    return (engagementScore + depthScore + lengthScore) / 3;
  }

  private calculateCrossSessionConnections(nodes: KnowledgeNode[], sessionIds: string[]): number {
    // Count entities that appear in multiple sessions
    let crossSessionCount = 0;
    
    for (const node of nodes) {
      const entitySessions = node.properties?.sessions || [];
      const commonSessions = entitySessions.filter((session: string) => sessionIds.includes(session));
      
      if (commonSessions.length > 1) {
        crossSessionCount++;
      }
    }
    
    return crossSessionCount;
  }

  /**
   * Schedule periodic consolidation tasks
   */
  async scheduleConsolidationTasks(userId: string): Promise<ConsolidationTask[]> {
    const tasks: ConsolidationTask[] = [];
    
    // Profile update task (weekly)
    tasks.push({
      taskId: `profile_update_${userId}_${Date.now()}`,
      userId,
      taskType: 'profile_update',
      priority: 'medium',
      scheduledFor: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 1 week
      estimatedDuration: 300, // 5 minutes
      dependencies: []
    });

    // Pattern analysis task (monthly)
    tasks.push({
      taskId: `pattern_analysis_${userId}_${Date.now()}`,
      userId,
      taskType: 'pattern_analysis',
      priority: 'low',
      scheduledFor: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 1 month
      estimatedDuration: 600, // 10 minutes
      dependencies: []
    });

    return tasks;
  }
}

export const memoryConsolidator = new MemoryConsolidator();