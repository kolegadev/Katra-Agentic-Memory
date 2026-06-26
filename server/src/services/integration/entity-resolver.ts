/**
 * Entity Resolution Service
 * 
 * Improves entity linking and resolution to better connect related concepts
 * across sessions and reduce entity duplication in the knowledge graph.
 */

import { get_database } from '../database/connection.js';
import { MemoryManager } from './memory-manager.js';
import type { KnowledgeNode, KnowledgeRelationship } from '../types/memory.js';

export interface EntityResolutionContext {
  userId: string;
  sessionId?: string;
  entityText: string;
  entityType?: string;
  confidence?: number;
  contextTerms?: string[];
  preferredId?: string;
}

export interface ResolvedEntity {
  canonicalId: string;
  canonicalName: string;
  entityType: string;
  confidence: number;
  aliases: string[];
  relatedEntities: string[];
  mergedFrom: string[];
  sessions: string[];
  lastUpdated: Date;
}

export interface EntityCluster {
  clusterId: string;
  entities: ResolvedEntity[];
  strength: number;
  commonTerms: string[];
  relationshipTypes: string[];
}

export interface EntityMergeOperation {
  targetEntityId: string;
  sourceEntityIds: string[];
  mergeStrategy: 'name_similarity' | 'context_similarity' | 'relationship_similarity';
  confidence: number;
  preservedProperties: Record<string, any>;
}

class EntityResolver {
  private memoryManager = MemoryManager.get_instance();
  
  // Similarity thresholds for entity matching
  private readonly EXACT_MATCH_THRESHOLD = 1.0;
  private readonly HIGH_SIMILARITY_THRESHOLD = 0.85;
  private readonly MODERATE_SIMILARITY_THRESHOLD = 0.7;
  private readonly LOW_SIMILARITY_THRESHOLD = 0.5;

  /**
   * Resolve entity to canonical form, merging duplicates
   */
  async resolveEntity(context: EntityResolutionContext): Promise<ResolvedEntity> {
    console.log('🔗 Resolving entity:', {
      text: context.entityText,
      type: context.entityType || 'unknown',
      userId: context.userId,
      sessionId: context.sessionId?.slice(-12)
    });

    const db = get_database();

    try {
      // Find potential matches using various strategies
      const candidates = await this.findEntityCandidates(context);
      
      if (candidates.length === 0) {
        // Create new canonical entity
        return await this.createCanonicalEntity(context);
      }

      // Find best match or merge candidates
      const bestMatch = await this.findBestEntityMatch(context, candidates);
      
      if (bestMatch.confidence >= this.HIGH_SIMILARITY_THRESHOLD) {
        // Update existing entity
        return await this.updateExistingEntity(bestMatch.entity, context);
      } else if (candidates.length > 1) {
        // Consider merging multiple candidates
        const mergedEntity = await this.considerEntityMerge(context, candidates);
        if (mergedEntity) {
          return mergedEntity;
        }
      }

      // Create new entity if no good matches
      return await this.createCanonicalEntity(context);

    } catch (error) {
      console.error('❌ Entity resolution failed:', error);
      // Fallback: create basic entity
      return await this.createCanonicalEntity(context);
    }
  }

  /**
   * Find potential entity candidates using multiple matching strategies
   */
  private async findEntityCandidates(context: EntityResolutionContext): Promise<KnowledgeNode[]> {
    const db = get_database();
    const entityText = context.entityText.toLowerCase();
    const escapedText = entityText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const firstToken = entityText.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Scope candidate search to the requesting user to prevent cross-user leaks
    const scopeFilter: any = { 'properties.user_id': context.userId };

    // Strategy 1: Exact name match
    const exactMatches = await db.collection('knowledge_nodes').find({
      ...scopeFilter,
      'properties.name': { $regex: `^${escapedText}$`, $options: 'i' }
    }).toArray();

    // Strategy 2: Fuzzy name matching (word characters separated by any chars)
    const fuzzyPattern = escapedText.split(/\s+/).join('.*');
    const fuzzyMatches = await db.collection('knowledge_nodes').find({
      ...scopeFilter,
      'properties.name': { $regex: fuzzyPattern, $options: 'i' }
    }).limit(10).toArray();

    // Strategy 3: Alias matching
    const aliasMatches = await db.collection('knowledge_nodes').find({
      ...scopeFilter,
      'properties.aliases': { $elemMatch: { $regex: escapedText, $options: 'i' } }
    }).limit(5).toArray();

    // Strategy 4: Context-based matching
    let contextMatches: any[] = [];
    if (context.contextTerms && context.contextTerms.length > 0) {
      const contextPattern = context.contextTerms
        .map((t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      contextMatches = await db.collection('knowledge_nodes').find({
        ...scopeFilter,
        'properties.description': { $regex: contextPattern, $options: 'i' }
      }).limit(5).toArray();
    }

    // Strategy 5: Type-based matching
    let typeMatches: any[] = [];
    if (context.entityType) {
      typeMatches = await db.collection('knowledge_nodes').find({
        ...scopeFilter,
        type: context.entityType,
        'properties.name': { $regex: firstToken, $options: 'i' }
      }).limit(5).toArray();
    }

    // Combine and deduplicate candidates
    const allCandidates = [
      ...exactMatches,
      ...fuzzyMatches,
      ...aliasMatches,
      ...contextMatches,
      ...typeMatches
    ];

    const uniqueCandidates = new Map<string, KnowledgeNode>();
    for (const candidate of allCandidates) {
      const id = candidate.id || candidate._id?.toString();
      if (id && !uniqueCandidates.has(id)) {
        uniqueCandidates.set(id, candidate as unknown as KnowledgeNode);
      }
    }

    return Array.from(uniqueCandidates.values());
  }

  /**
   * Find the best matching entity from candidates
   */
  private async findBestEntityMatch(
    context: EntityResolutionContext,
    candidates: KnowledgeNode[]
  ): Promise<{ entity: KnowledgeNode; confidence: number }> {
    let bestMatch: KnowledgeNode | null = null;
    let bestConfidence = 0;

    for (const candidate of candidates) {
      const confidence = await this.calculateEntitySimilarity(context, candidate);
      
      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestMatch = candidate;
      }
    }

    return {
      entity: bestMatch!,
      confidence: bestConfidence
    };
  }

  /**
   * Calculate similarity between context entity and candidate
   */
  private async calculateEntitySimilarity(
    context: EntityResolutionContext,
    candidate: KnowledgeNode
  ): Promise<number> {
    let totalScore = 0;
    let weightSum = 0;

    // Name similarity (highest weight)
    const nameScore = this.calculateStringSimilarity(
      context.entityText.toLowerCase(),
      candidate.properties?.name?.toLowerCase() || ''
    );
    totalScore += nameScore * 0.4;
    weightSum += 0.4;

    // Type similarity
    if (context.entityType && candidate.type) {
      const typeScore = context.entityType.toLowerCase() === candidate.type.toLowerCase() ? 1.0 : 0.0;
      totalScore += typeScore * 0.2;
      weightSum += 0.2;
    }

    // Alias similarity
    if (candidate.properties?.aliases) {
      let maxAliasScore = 0;
      for (const alias of candidate.properties.aliases) {
        const aliasScore = this.calculateStringSimilarity(
          context.entityText.toLowerCase(),
          alias.toLowerCase()
        );
        maxAliasScore = Math.max(maxAliasScore, aliasScore);
      }
      totalScore += maxAliasScore * 0.2;
      weightSum += 0.2;
    }

    // Context similarity
    if (context.contextTerms && candidate.properties?.description) {
      const contextScore = this.calculateContextSimilarity(
        context.contextTerms,
        candidate.properties.description
      );
      totalScore += contextScore * 0.2;
      weightSum += 0.2;
    }

    return weightSum > 0 ? totalScore / weightSum : 0;
  }

  /**
   * Calculate string similarity using Levenshtein distance
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    
    const len1 = str1.length;
    const len2 = str2.length;
    
    if (len1 === 0) return len2 === 0 ? 1.0 : 0.0;
    if (len2 === 0) return 0.0;

    // Create matrix
    const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(null));

    // Initialize first row and column
    for (let i = 0; i <= len1; i++) matrix[0][i] = i;
    for (let j = 0; j <= len2; j++) matrix[j][0] = j;

    // Fill matrix
    for (let j = 1; j <= len2; j++) {
      for (let i = 1; i <= len1; i++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j - 1][i] + 1,     // deletion
          matrix[j][i - 1] + 1,     // insertion
          matrix[j - 1][i - 1] + cost // substitution
        );
      }
    }

    const distance = matrix[len2][len1];
    const maxLen = Math.max(len1, len2);
    return 1.0 - (distance / maxLen);
  }

  /**
   * Calculate context similarity between terms and description
   */
  private calculateContextSimilarity(contextTerms: string[], description: string): number {
    const descLower = description.toLowerCase();
    let matches = 0;
    
    for (const term of contextTerms) {
      if (descLower.includes(term.toLowerCase())) {
        matches++;
      }
    }
    
    return contextTerms.length > 0 ? matches / contextTerms.length : 0;
  }

  /**
   * Create a new canonical entity
   */
  private async createCanonicalEntity(context: EntityResolutionContext): Promise<ResolvedEntity> {
    const canonicalId = context.preferredId || `entity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const entity: KnowledgeNode = {
      id: canonicalId,
      type: context.entityType || 'entity',
      user_id: context.userId,
      session_id: context.sessionId,
      properties: {
        name: context.entityText,
        canonical_name: context.entityText,
        aliases: [],
        description: `Entity: ${context.entityText}`,
        confidence: context.confidence || 0.8,
        sessions: context.sessionId ? [context.sessionId] : [],
        user_id: context.userId,
        session_id: context.sessionId,
        created_from_resolution: true
      },
      created_at: new Date(),
      updated_at: new Date()
    };

    await this.memoryManager.upsert_node(entity);

    return {
      canonicalId,
      canonicalName: context.entityText,
      entityType: context.entityType || 'entity',
      confidence: context.confidence || 0.8,
      aliases: [],
      relatedEntities: [],
      mergedFrom: [],
      sessions: context.sessionId ? [context.sessionId] : [],
      lastUpdated: new Date()
    };
  }

  /**
   * Update existing entity with new information
   */
  private async updateExistingEntity(
    entity: KnowledgeNode,
    context: EntityResolutionContext
  ): Promise<ResolvedEntity> {
    // Add session to entity if not already present
    const sessions = entity.properties?.sessions || [];
    if (context.sessionId && !sessions.includes(context.sessionId)) {
      sessions.push(context.sessionId);
    }

    // Add alias if it's different from canonical name
    const aliases = entity.properties?.aliases || [];
    const canonicalName = entity.properties?.canonical_name || entity.properties?.name || '';
    
    if (context.entityText.toLowerCase() !== canonicalName.toLowerCase() &&
        !aliases.some((alias: string) => alias.toLowerCase() === context.entityText.toLowerCase())) {
      aliases.push(context.entityText);
    }

    // Update entity properties
    const updatedEntity: KnowledgeNode = {
      ...entity,
      user_id: entity.user_id || context.userId,
      session_id: entity.session_id || context.sessionId,
      properties: {
        ...entity.properties,
        user_id: entity.properties?.user_id || context.userId,
        session_id: entity.properties?.session_id || context.sessionId,
        aliases,
        sessions,
        last_seen: new Date(),
        occurrence_count: (entity.properties?.occurrence_count || 0) + 1
      },
      updated_at: new Date()
    };

    await this.memoryManager.upsert_node(updatedEntity);

    return {
      canonicalId: entity.id,
      canonicalName: canonicalName,
      entityType: entity.type,
      confidence: entity.properties?.confidence || 0.8,
      aliases,
      relatedEntities: [], // Would be populated from relationships
      mergedFrom: entity.properties?.merged_from || [],
      sessions,
      lastUpdated: new Date()
    };
  }

  /**
   * Consider merging multiple entity candidates
   */
  private async considerEntityMerge(
    context: EntityResolutionContext,
    candidates: KnowledgeNode[]
  ): Promise<ResolvedEntity | null> {
    // Find candidates that are similar enough to merge
    const mergeCandidates = [];
    
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const similarity = await this.calculateEntitySimilarity(
          {
            userId: context.userId,
            entityText: candidates[i].properties?.name || '',
            entityType: candidates[i].type
          },
          candidates[j]
        );
        
        if (similarity >= this.MODERATE_SIMILARITY_THRESHOLD) {
          mergeCandidates.push({
            entities: [candidates[i], candidates[j]],
            similarity
          });
        }
      }
    }

    if (mergeCandidates.length > 0) {
      // Merge the most similar pair
      const bestMerge = mergeCandidates.sort((a, b) => b.similarity - a.similarity)[0];
      return await this.mergeEntities(bestMerge.entities[0], bestMerge.entities[1], context);
    }

    return null;
  }

  /**
   * Merge two entities into one canonical entity
   */
  private async mergeEntities(
    entity1: KnowledgeNode,
    entity2: KnowledgeNode,
    context: EntityResolutionContext
  ): Promise<ResolvedEntity> {
    console.log('🔀 Merging entities:', {
      entity1: entity1.properties?.name,
      entity2: entity2.properties?.name,
      reason: 'high_similarity'
    });

    // Choose the entity with more information as the target
    const target = (entity1.properties?.occurrence_count || 0) >= (entity2.properties?.occurrence_count || 0) 
      ? entity1 : entity2;
    const source = target === entity1 ? entity2 : entity1;

    // Merge properties
    const mergedAliases = new Set([
      ...(target.properties?.aliases || []),
      ...(source.properties?.aliases || []),
      source.properties?.name || source.properties?.canonical_name || ''
    ]);

    const mergedSessions = new Set([
      ...(target.properties?.sessions || []),
      ...(source.properties?.sessions || [])
    ]);

    // Update target entity with merged information
    const mergedEntity: KnowledgeNode = {
      ...target,
      properties: {
        ...target.properties,
        aliases: Array.from(mergedAliases).filter(alias => 
          alias.toLowerCase() !== (target.properties?.canonical_name || target.properties?.name || '').toLowerCase()
        ),
        sessions: Array.from(mergedSessions),
        merged_from: [
          ...(target.properties?.merged_from || []),
          source.id
        ],
        occurrence_count: (target.properties?.occurrence_count || 0) + (source.properties?.occurrence_count || 0),
        confidence: Math.max(
          target.properties?.confidence || 0,
          source.properties?.confidence || 0
        ),
        last_merged: new Date()
      },
      updated_at: new Date()
    };

    // Update the target entity
    await this.memoryManager.upsert_node(mergedEntity);

    // Transfer relationships from source to target
    await this.transferEntityRelationships(source.id, target.id);

    // Mark source entity as merged (don't delete to preserve data integrity)
    const archivedSource: KnowledgeNode = {
      ...source,
      properties: {
        ...source.properties,
        archived: true,
        merged_into: target.id,
        archived_at: new Date()
      },
      updated_at: new Date()
    };
    
    await this.memoryManager.upsert_node(archivedSource);

    return {
      canonicalId: target.id,
      canonicalName: target.properties?.canonical_name || target.properties?.name || '',
      entityType: target.type,
      confidence: mergedEntity.properties?.confidence || 0.8,
      aliases: Array.from(mergedAliases),
      relatedEntities: [],
      mergedFrom: mergedEntity.properties?.merged_from || [],
      sessions: Array.from(mergedSessions),
      lastUpdated: new Date()
    };
  }

  /**
   * Transfer relationships from source entity to target entity
   */
  private async transferEntityRelationships(sourceId: string, targetId: string): Promise<void> {
    const db = get_database();

    try {
      // Update relationships where source is the 'from' entity
      await db.collection('knowledge_relationships').updateMany(
        { from_id: sourceId },
        { 
          $set: { 
            from_id: targetId,
            updated_at: new Date(),
            transferred_from: sourceId
          }
        }
      );

      // Update relationships where source is the 'to' entity
      await db.collection('knowledge_relationships').updateMany(
        { to_id: sourceId },
        { 
          $set: { 
            to_id: targetId,
            updated_at: new Date(),
            transferred_from: sourceId
          }
        }
      );

      console.log(`✅ Transferred relationships from ${sourceId} to ${targetId}`);
    } catch (error) {
      console.error(`❌ Failed to transfer relationships from ${sourceId} to ${targetId}:`, error);
    }
  }

  /**
   * Find entity clusters for batch resolution
   */
  async findEntityClusters(userId: string, maxClusters = 10): Promise<EntityCluster[]> {
    const db = get_database();
    
    // Get all entities for the user
    const entities = await db.collection('knowledge_nodes')
      .find({ 'properties.user_id': userId })
      .toArray();

    const clusters: EntityCluster[] = [];
    const processed = new Set<string>();

    for (const entity of entities) {
      const entityId = entity.id || entity._id?.toString();
      if (!entityId || processed.has(entityId)) continue;

      // Find similar entities
      const similarEntities = [];
      
      for (const otherEntity of entities) {
        const otherId = otherEntity.id || otherEntity._id?.toString();
        if (!otherId || otherId === entityId || processed.has(otherId)) continue;

        const similarity = await this.calculateEntitySimilarity(
          {
            userId,
            entityText: entity.properties?.name || '',
            entityType: entity.type
          },
          otherEntity as unknown as KnowledgeNode
        );

        if (similarity >= this.MODERATE_SIMILARITY_THRESHOLD) {
          similarEntities.push({
            entity: otherEntity as unknown as KnowledgeNode,
            similarity
          });
        }
      }

      if (similarEntities.length > 0) {
        const clusterId = `cluster_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        clusters.push({
          clusterId,
          entities: [
            await this.convertToResolvedEntity(entity as unknown as KnowledgeNode),
            ...similarEntities.map(se => this.convertToResolvedEntityFromSimilar(se.entity))
          ],
          strength: similarEntities.reduce((sum, se) => sum + se.similarity, 0) / similarEntities.length,
          commonTerms: this.findCommonTerms([entity, ...similarEntities.map(se => se.entity)]),
          relationshipTypes: []
        });

        // Mark entities as processed
        processed.add(entityId);
        similarEntities.forEach(se => {
          const id = se.entity.id || (se.entity as any)._id?.toString();
          if (id) processed.add(id);
        });
      }
    }

    return clusters.slice(0, maxClusters);
  }

  /**
   * Convert KnowledgeNode to ResolvedEntity
   */
  private async convertToResolvedEntity(node: KnowledgeNode): Promise<ResolvedEntity> {
    return {
      canonicalId: node.id,
      canonicalName: node.properties?.canonical_name || node.properties?.name || '',
      entityType: node.type,
      confidence: node.properties?.confidence || 0.8,
      aliases: node.properties?.aliases || [],
      relatedEntities: [],
      mergedFrom: node.properties?.merged_from || [],
      sessions: node.properties?.sessions || [],
      lastUpdated: node.updated_at || new Date()
    };
  }

  /**
   * Convert KnowledgeNode to ResolvedEntity (simplified)
   */
  private convertToResolvedEntityFromSimilar(node: KnowledgeNode): ResolvedEntity {
    return {
      canonicalId: node.id,
      canonicalName: node.properties?.canonical_name || node.properties?.name || '',
      entityType: node.type,
      confidence: node.properties?.confidence || 0.8,
      aliases: node.properties?.aliases || [],
      relatedEntities: [],
      mergedFrom: node.properties?.merged_from || [],
      sessions: node.properties?.sessions || [],
      lastUpdated: node.updated_at || new Date()
    };
  }

  /**
   * Find common terms between entities
   */
  private findCommonTerms(entities: any[]): string[] {
    const termCounts = new Map<string, number>();
    
    for (const entity of entities) {
      const text = `${entity.properties?.name || ''} ${entity.properties?.description || ''}`.toLowerCase();
      const terms = text.split(/\s+/).filter(term => term.length > 2);
      
      for (const term of terms) {
        termCounts.set(term, (termCounts.get(term) || 0) + 1);
      }
    }

    return Array.from(termCounts.entries())
      .filter(([term, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([term]) => term);
  }

  /**
   * Batch resolve entities in clusters
   */
  async batchResolveEntities(userId: string): Promise<{
    clustersProcessed: number;
    entitiesMerged: number;
    entitiesUpdated: number;
  }> {
    console.log('🔄 Starting batch entity resolution for user:', userId);

    const clusters = await this.findEntityClusters(userId);
    let entitiesMerged = 0;
    let entitiesUpdated = 0;

    for (const cluster of clusters) {
      if (cluster.entities.length > 1 && cluster.strength >= this.MODERATE_SIMILARITY_THRESHOLD) {
        try {
          // Merge entities in cluster
          const target = cluster.entities[0];
          for (let i = 1; i < cluster.entities.length; i++) {
            const source = cluster.entities[i];
            
            // Get full KnowledgeNode objects
            const targetNode = await this.memoryManager.get_node(target.canonicalId);
            const sourceNode = await this.memoryManager.get_node(source.canonicalId);
            
            if (targetNode && sourceNode) {
              await this.mergeEntities(targetNode, sourceNode, { userId, entityText: target.canonicalName });
              entitiesMerged++;
            }
          }
        } catch (error) {
          console.error(`❌ Failed to merge entities in cluster ${cluster.clusterId}:`, error);
        }
      } else {
        // No mergeable cluster; nothing to update here.
        // Future: could boost confidence or refresh last_seen for singletons.
      }
    }

    console.log('✅ Batch entity resolution completed:', {
      clustersProcessed: clusters.length,
      entitiesMerged,
      entitiesUpdated
    });

    return {
      clustersProcessed: clusters.length,
      entitiesMerged,
      entitiesUpdated
    };
  }
}

export const entityResolver = new EntityResolver();