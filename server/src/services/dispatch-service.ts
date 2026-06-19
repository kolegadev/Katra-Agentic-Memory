import { MemoryManager } from './memory-manager.js';
import { ExtractionResult, ExtractionContext } from './extraction-service.js';

export interface DispatchResult {
  success: boolean;
  operations_completed: number;
  operations_failed: number;
  errors: string[];
  warnings: string[];
  results: {
    entities_stored: number;
    relationships_stored: number;
    events_stored: number;
    semantic_facts_stored: number;
  };
  processing_time: number;
}

export interface DispatchContext extends ExtractionContext {
  batch_size?: number;
  parallel_operations?: boolean;
  rollback_on_error?: boolean;
  upsert_mode?: boolean;
  source_event_id?: string;
  source_event_timestamp?: Date;
  batch_id?: string;
  priority?: 'high' | 'normal' | 'low';
}

class DispatchService {
  private memory_manager = MemoryManager.get_instance();

  async dispatchToMemory(
    extraction_result: ExtractionResult,
    context: DispatchContext
  ): Promise<DispatchResult> {
    const start_time = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];

    let operations_completed = 0;
    let operations_failed = 0;

    const results = {
      entities_stored: 0,
      relationships_stored: 0,
      events_stored: 0,
      semantic_facts_stored: 0
    };

    try {
      // Use bulk operations for better performance
      return await this.dispatchBulk(extraction_result, context, start_time);
    } catch (error) {
      console.error('Dispatch operation failed:', error);
      return {
        success: false,
        operations_completed,
        operations_failed: operations_failed + 1,
        errors: [error instanceof Error ? error.message : 'Unknown dispatch error'],
        warnings,
        results,
        processing_time: Date.now() - start_time
      };
    }
  }

  private async dispatchSequential(
    extraction_result: ExtractionResult,
    context: DispatchContext,
    start_time: number
  ): Promise<DispatchResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let operations_completed = 0;
    let operations_failed = 0;

    const results = {
      entities_stored: 0,
      relationships_stored: 0,
      events_stored: 0,
      semantic_facts_stored: 0
    };

    console.log(`🔄 Starting dispatch: ${extraction_result.entities.length} entities, ${extraction_result.relationships.length} relationships, ${extraction_result.events.length} events, ${extraction_result.semantic_facts.length} facts`);

    // Store entities first (they may be referenced by other operations)
    try {
      for (const entity of extraction_result.entities) {
        try {
          const node_data = {
            id: entity.id,
            type: entity.type,
            properties: {
              name: entity.name,
              ...entity.properties,
              confidence: entity.confidence,
              source: 'extraction'
            },
            // Preserve the original event timestamp
            source_event_timestamp: (context as any).source_event_timestamp || context.timestamp,
            created_at: new Date(),
            updated_at: new Date()
          };

          await this.memory_manager.upsert_node(node_data);
          const node_result = { success: true };

          if (node_result.success) {
            results.entities_stored++;
            operations_completed++;
          } else {
            operations_failed++;
            errors.push(`Failed to store entity ${entity.name}`);
          }
        } catch (error) {
          operations_failed++;
          errors.push(`Error storing entity ${entity.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    } catch (error) {
      errors.push(`Entity storage batch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Store relationships
    try {
      for (const relationship of extraction_result.relationships) {
        try {
          const rel_data = {
            from_id: relationship.from_entity_id,
            to_id: relationship.to_entity_id,
            relationship_type: relationship.relationship_type,
            properties: {
              ...relationship.properties,
              confidence: relationship.confidence,
              source: 'extraction'
            },
            created_at: new Date()
          };

          await this.memory_manager.add_relationship(rel_data);
          const rel_result = { success: true };

          if (rel_result.success) {
            results.relationships_stored++;
            operations_completed++;
          } else {
            operations_failed++;
            errors.push(`Failed to store relationship`);
          }
        } catch (error) {
          operations_failed++;
          errors.push(`Error storing relationship: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    } catch (error) {
      errors.push(`Relationship storage batch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Store events
    try {
      for (const event of extraction_result.events) {
        try {
          const event_data = {
            id: event.id,
            event_type: event.event_type,
            session_id: context.session_id,
            user_id: context.user_id,
            shared_id: (context as any).shared_id,
            timestamp: event.timestamp,
            content: {
              description: event.description,
              entities_involved: event.entities_involved,
              confidence: event.confidence,
              ...event.metadata
            }
          };

          await this.memory_manager.store_event(event_data);
          const event_result = { success: true };

          if (event_result.success) {
            results.events_stored++;
            operations_completed++;
          } else {
            operations_failed++;
            errors.push(`Failed to store event`);
          }
        } catch (error) {
          operations_failed++;
          errors.push(`Error storing event: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    } catch (error) {
      errors.push(`Event storage batch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Store semantic facts
    try {
      for (const fact of extraction_result.semantic_facts) {
        try {
          const fact_data = {
            user_id: context.user_id,
            shared_id: (context as any).shared_id,
            content: `${fact.fact_key}: ${fact.fact_value}`,
            source: 'extraction',
            confidence: fact.confidence,
            // Preserve the original event timestamp so Solomon can answer "when" questions
            source_event_timestamp: (context as any).source_event_timestamp || context.timestamp,
            timestamp: context.timestamp,
            metadata: {
              fact_key: fact.fact_key,
              fact_value: fact.fact_value,
              context: fact.context,
              session_id: context.session_id,
              // Enhanced properties from new extraction system
              fact_type: fact.fact_type || 'general',
              properties: fact.properties || {},
              extraction_context: {
                source_event_id: (context as any).source_event_id,
                source_event_timestamp: context.timestamp,
                timestamp: new Date().toISOString(),
                extraction_method: extraction_result.processing_metadata?.extraction_method || 'unknown'
              }
            },
            created_at: new Date()
          };

          await this.memory_manager.add_semantic_fact(fact_data);
          const fact_result = { success: true };

          if (fact_result.success) {
            results.semantic_facts_stored++;
            operations_completed++;
          } else {
            operations_failed++;
            errors.push(`Failed to store semantic fact ${fact.fact_key}`);
          }
        } catch (error) {
          operations_failed++;
          errors.push(`Error storing semantic fact ${fact.fact_key}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    } catch (error) {
      errors.push(`Semantic fact storage batch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Generate warnings for low confidence items
    const low_confidence_threshold = 0.3;
    extraction_result.entities.forEach(entity => {
      if (entity.confidence < low_confidence_threshold) {
        warnings.push(`Low confidence entity stored: ${entity.name} (${entity.confidence})`);
      }
    });

    extraction_result.relationships.forEach(rel => {
      if (rel.confidence < low_confidence_threshold) {
        warnings.push(`Low confidence relationship stored: ${rel.relationship_type} (${rel.confidence})`);
      }
    });

    return {
      success: operations_failed === 0,
      operations_completed,
      operations_failed,
      errors,
      warnings,
      results,
      processing_time: Date.now() - start_time
    };
  }

  private async dispatchParallel(
    extraction_result: ExtractionResult,
    context: DispatchContext
  ): Promise<DispatchResult[]> {
    // Dispatch all operations in parallel for better performance
    const dispatch_promises: Promise<DispatchResult>[] = [];

    // Entities
    if (extraction_result.entities.length > 0) {
      dispatch_promises.push(this.dispatchEntitiesParallel(extraction_result.entities, context));
    }

    // Wait for entities before processing relationships (dependencies)
    const entity_results = await Promise.allSettled(dispatch_promises);
    dispatch_promises.length = 0; // Clear array

    // Relationships (after entities are stored)
    if (extraction_result.relationships.length > 0) {
      dispatch_promises.push(this.dispatchRelationshipsParallel(extraction_result.relationships, context));
    }

    // Events and semantic facts can be stored in parallel
    if (extraction_result.events.length > 0) {
      dispatch_promises.push(this.dispatchEventsParallel(extraction_result.events, context));
    }

    if (extraction_result.semantic_facts.length > 0) {
      dispatch_promises.push(this.dispatchSemanticFactsParallel(extraction_result.semantic_facts, context));
    }

    const remaining_results = await Promise.allSettled(dispatch_promises);

    // Combine all results
    const all_results: DispatchResult[] = [];

    entity_results.forEach(result => {
      if (result.status === 'fulfilled') {
        all_results.push(result.value);
      }
    });

    remaining_results.forEach(result => {
      if (result.status === 'fulfilled') {
        all_results.push(result.value);
      }
    });

    return all_results;
  }

  private async dispatchEntitiesParallel(
    entities: any[],
    context: DispatchContext
  ): Promise<DispatchResult> {
    const start_time = Date.now();
    const batch_size = context.batch_size || 10;
    const errors: string[] = [];
    const warnings: string[] = [];
    let operations_completed = 0;
    let operations_failed = 0;

    // Process entities in batches
    for (let i = 0; i < entities.length; i += batch_size) {
      const batch = entities.slice(i, i + batch_size);
      const batch_promises = batch.map(async (entity) => {
        try {
          const node_data = {
            id: entity.id,
            type: entity.type,
            properties: {
              name: entity.name,
              ...entity.properties,
              confidence: entity.confidence,
              source: 'extraction'
            },
            // Preserve the original event timestamp
            source_event_timestamp: (context as any).source_event_timestamp || context.timestamp,
            created_at: new Date(),
            updated_at: new Date()
          };

          await this.memory_manager.upsert_node(node_data);
          return { success: true, error: null };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      });

      const batch_results = await Promise.allSettled(batch_promises);
      batch_results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            operations_completed++;
          } else {
            operations_failed++;
            errors.push(`Entity ${batch[index].name}: ${result.value.error}`);
          }
        } else {
          operations_failed++;
          errors.push(`Entity ${batch[index].name}: ${result.reason}`);
        }
      });
    }

    return {
      success: operations_failed === 0,
      operations_completed,
      operations_failed,
      errors,
      warnings,
      results: {
        entities_stored: operations_completed,
        relationships_stored: 0,
        events_stored: 0,
        semantic_facts_stored: 0
      },
      processing_time: Date.now() - start_time
    };
  }

  private async dispatchRelationshipsParallel(
    relationships: any[],
    context: DispatchContext
  ): Promise<DispatchResult> {
    const start_time = Date.now();
    const errors: string[] = [];
    let operations_completed = 0;
    let operations_failed = 0;

    const promises = relationships.map(async (relationship) => {
      try {
        const rel_data = {
          from_id: relationship.from_entity_id,
          to_id: relationship.to_entity_id,
          relationship_type: relationship.relationship_type,
          properties: {
            ...relationship.properties,
            confidence: relationship.confidence,
            source: 'extraction'
          },
          created_at: new Date()
        };

        await this.memory_manager.add_relationship(rel_data);
        return { success: true, error: null };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    });

    const results = await Promise.allSettled(promises);
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value.success) {
          operations_completed++;
        } else {
          operations_failed++;
          errors.push(`Relationship ${index}: ${result.value.error}`);
        }
      } else {
        operations_failed++;
        errors.push(`Relationship ${index}: ${result.reason}`);
      }
    });

    return {
      success: operations_failed === 0,
      operations_completed,
      operations_failed,
      errors,
      warnings: [],
      results: {
        entities_stored: 0,
        relationships_stored: operations_completed,
        events_stored: 0,
        semantic_facts_stored: 0
      },
      processing_time: Date.now() - start_time
    };
  }

  private async dispatchEventsParallel(
    events: any[],
    context: DispatchContext
  ): Promise<DispatchResult> {
    const start_time = Date.now();
    const errors: string[] = [];
    let operations_completed = 0;
    let operations_failed = 0;

    const promises = events.map(async (event) => {
      try {
        const event_data = {
          id: event.id,
          event_type: event.event_type,
          session_id: context.session_id,
          user_id: context.user_id,
          timestamp: event.timestamp,
          content: {
            description: event.description,
            entities_involved: event.entities_involved,
            confidence: event.confidence,
            ...event.metadata
          }
        };

        await this.memory_manager.store_event(event_data);
        return { success: true, error: null };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    });

    const results = await Promise.allSettled(promises);
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value.success) {
          operations_completed++;
        } else {
          operations_failed++;
          errors.push(`Event ${index}: ${result.value.error}`);
        }
      } else {
        operations_failed++;
        errors.push(`Event ${index}: ${result.reason}`);
      }
    });

    return {
      success: operations_failed === 0,
      operations_completed,
      operations_failed,
      errors,
      warnings: [],
      results: {
        entities_stored: 0,
        relationships_stored: 0,
        events_stored: operations_completed,
        semantic_facts_stored: 0
      },
      processing_time: Date.now() - start_time
    };
  }

  private async dispatchSemanticFactsParallel(
    semantic_facts: any[],
    context: DispatchContext
  ): Promise<DispatchResult> {
    const start_time = Date.now();
    const errors: string[] = [];
    let operations_completed = 0;
    let operations_failed = 0;

    const promises = semantic_facts.map(async (fact) => {
      try {
        const fact_data = {
          user_id: context.user_id,
          content: `${fact.fact_key}: ${fact.fact_value}`,
          source: 'extraction',
          confidence: fact.confidence,
          metadata: {
            fact_key: fact.fact_key,
            fact_value: fact.fact_value,
            context: fact.context,
            session_id: context.session_id
          },
          created_at: new Date()
        };

        await this.memory_manager.add_semantic_fact(fact_data);
        return { success: true, error: null };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    });

    const results = await Promise.allSettled(promises);
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value.success) {
          operations_completed++;
        } else {
          operations_failed++;
          errors.push(`Semantic fact ${semantic_facts[index].fact_key}: ${result.value.error}`);
        }
      } else {
        operations_failed++;
        errors.push(`Semantic fact ${semantic_facts[index].fact_key}: ${result.reason}`);
      }
    });

    return {
      success: operations_failed === 0,
      operations_completed,
      operations_failed,
      errors,
      warnings: [],
      results: {
        entities_stored: 0,
        relationships_stored: 0,
        events_stored: 0,
        semantic_facts_stored: operations_completed
      },
      processing_time: Date.now() - start_time
    };
  }

  private consolidateResults(
    dispatch_results: DispatchResult[],
    start_time: number
  ): DispatchResult {
    const consolidated = {
      success: true,
      operations_completed: 0,
      operations_failed: 0,
      errors: [] as string[],
      warnings: [] as string[],
      results: {
        entities_stored: 0,
        relationships_stored: 0,
        events_stored: 0,
        semantic_facts_stored: 0
      },
      processing_time: Date.now() - start_time
    };

    for (const result of dispatch_results) {
      consolidated.success = consolidated.success && result.success;
      consolidated.operations_completed += result.operations_completed;
      consolidated.operations_failed += result.operations_failed;
      consolidated.errors.push(...result.errors);
      consolidated.warnings.push(...result.warnings);

      consolidated.results.entities_stored += result.results.entities_stored;
      consolidated.results.relationships_stored += result.results.relationships_stored;
      consolidated.results.events_stored += result.results.events_stored;
      consolidated.results.semantic_facts_stored += result.results.semantic_facts_stored;
    }

    return consolidated;
  }

  async getDispatchStats(): Promise<{
    total_dispatches: number;
    successful_dispatches: number;
    failed_dispatches: number;
    average_processing_time: number;
    total_entities_stored: number;
    total_relationships_stored: number;
    total_events_stored: number;
    total_semantic_facts_stored: number;
  }> {
    // This would typically query a dispatch log/metrics collection
    // For now, return mock statistics
    return {
      total_dispatches: 0,
      successful_dispatches: 0,
      failed_dispatches: 0,
      average_processing_time: 0,
      total_entities_stored: 0,
      total_relationships_stored: 0,
      total_events_stored: 0,
      total_semantic_facts_stored: 0
    };
  }

  private async dispatchBulk(
    extraction_result: ExtractionResult,
    context: DispatchContext,
    start_time: number
  ): Promise<DispatchResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let operations_completed = 0;
    let operations_failed = 0;

    const results = {
      entities_stored: 0,
      relationships_stored: 0,
      events_stored: 0,
      semantic_facts_stored: 0
    };

    console.log(`🔄 Starting bulk dispatch: ${extraction_result.entities.length} entities, ${extraction_result.relationships.length} relationships, ${extraction_result.events.length} events, ${extraction_result.semantic_facts.length} facts`);

    try {
      // Bulk store entities
      if (extraction_result.entities.length > 0) {
        const entity_start = Date.now();
        const entity_operations = extraction_result.entities.map(entity => ({
          id: entity.id,
          type: entity.type,
          properties: {
            name: entity.name,
            ...entity.properties,
            session_id: context.session_id,
            discovered_at: context.timestamp.toISOString(),
            confidence: entity.confidence,
            source: 'extraction'
          },
          created_at: new Date(),
          updated_at: new Date()
        }));

        try {
          const bulk_results = await Promise.all(
            entity_operations.map(async (entity_data) => {
              try {
                await this.memory_manager.upsert_node(entity_data);
                return { success: true };
              } catch (error: any) {
                console.error(`Failed to store entity ${entity_data.properties.name}:`, error);
                return { success: false, error: error.message };
              }
            })
          );

          const successful = bulk_results.filter(r => r.success).length;
          const failed = bulk_results.length - successful;

          results.entities_stored = successful;
          operations_completed += successful;
          operations_failed += failed;

          if (failed > 0) {
            errors.push(`${failed} entities failed to store`);
          }

          console.log(`✅ Bulk entity storage: ${successful} stored, ${failed} failed in ${Date.now() - entity_start}ms`);
        } catch (error) {
          operations_failed += extraction_result.entities.length;
          errors.push(`Bulk entity storage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Bulk store relationships
      if (extraction_result.relationships.length > 0) {
        const rel_start = Date.now();
        try {
          const rel_results = await Promise.all(
            extraction_result.relationships.map(async (relationship) => {
              try {
                const rel_data = {
                  from_id: relationship.from_entity_id,
                  to_id: relationship.to_entity_id,
                  relationship_type: relationship.relationship_type,
                  properties: {
                    ...relationship.properties,
                    session_id: context.session_id,
                    discovered_at: context.timestamp.toISOString(),
                    confidence: relationship.confidence,
                    source: 'extraction'
                  },
                  created_at: new Date()
                };

                await this.memory_manager.add_relationship(rel_data);
                return { success: true };
              } catch (error: any) {
                console.error('Failed to store relationship:', error);
                return { success: false, error: error.message };
              }
            })
          );

          const successful = rel_results.filter(r => r.success).length;
          const failed = rel_results.length - successful;

          results.relationships_stored = successful;
          operations_completed += successful;
          operations_failed += failed;

          if (failed > 0) {
            errors.push(`${failed} relationships failed to store`);
          }

          console.log(`✅ Bulk relationship storage: ${successful} stored, ${failed} failed in ${Date.now() - rel_start}ms`);
        } catch (error) {
          operations_failed += extraction_result.relationships.length;
          errors.push(`Bulk relationship storage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Bulk store events
      if (extraction_result.events.length > 0) {
        const event_start = Date.now();
        try {
          const event_results = await Promise.all(
            extraction_result.events.map(async (event) => {
              try {
                const event_data = {
                  id: event.id,
                  event_type: event.event_type,
                  session_id: context.session_id,
                  user_id: context.user_id,
                  timestamp: event.timestamp || context.timestamp,
                  content: {
                    description: event.description,
                    entities_involved: event.entities_involved,
                    confidence: event.confidence,
                    ...event.metadata
                  }
                };

                await this.memory_manager.store_event(event_data);
                return { success: true };
              } catch (error: any) {
                console.error('Failed to store event:', error);
                return { success: false, error: error.message };
              }
            })
          );

          const successful = event_results.filter(r => r.success).length;
          const failed = event_results.length - successful;

          results.events_stored = successful;
          operations_completed += successful;
          operations_failed += failed;

          if (failed > 0) {
            errors.push(`${failed} events failed to store`);
          }

          console.log(`✅ Bulk event storage: ${successful} stored, ${failed} failed in ${Date.now() - event_start}ms`);
        } catch (error) {
          operations_failed += extraction_result.events.length;
          errors.push(`Bulk event storage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Bulk store semantic facts
      if (extraction_result.semantic_facts.length > 0) {
        const fact_start = Date.now();
        try {
          const fact_results = await Promise.all(
            extraction_result.semantic_facts.map(async (fact, index) => {
              try {
                console.log(`🐛 DEBUG: Processing semantic fact ${index + 1}/${extraction_result.semantic_facts.length}`);

                const fact_data = {
                  user_id: context.user_id,
                  content: `${fact.fact_key}: ${fact.fact_value}`,
                  source: 'extraction',
                  confidence: fact.confidence,
                  metadata: {
                    fact_key: fact.fact_key,
                    fact_value: fact.fact_value,
                    context: fact.context,
                    session_id: context.session_id,
                    // Enhanced metadata for better debugging
                    extraction_timestamp: new Date().toISOString(),
                    source_event_id: context.source_event_id,
                    batch_id: context.batch_id
                  },
                  created_at: new Date()
                };

                console.log(`🐛 DEBUG: Fact data structure:`, JSON.stringify(fact_data, null, 2));

                const fact_id = await this.memory_manager.add_semantic_fact(fact_data);

                console.log(`✅ DEBUG: Semantic fact stored with ID: ${fact_id}`);
                return { success: true, fact_id, error: null };

              } catch (error) {
                console.error(`❌ Failed to store semantic fact ${index + 1}:`, error);
                console.error(`❌ Original fact data:`, JSON.stringify(fact, null, 2));
                return {
                  success: false,
                  fact_id: null,
                  error: error instanceof Error ? error.message : 'Unknown error'
                };
              }
            })
          );

          const successful = fact_results.filter(r => r.success).length;
          const failed = fact_results.length - successful;

          results.semantic_facts_stored = successful;
          operations_completed += successful;
          operations_failed += failed;

          if (failed > 0) {
            errors.push(`${failed} semantic facts failed to store`);
          }

          console.log(`✅ Bulk semantic fact storage: ${successful} stored, ${failed} failed in ${Date.now() - fact_start}ms`);
        } catch (error) {
          operations_failed += extraction_result.semantic_facts.length;
          errors.push(`Bulk semantic fact storage failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

    } catch (error) {
      console.error('Bulk dispatch operation failed:', error);
      operations_failed++;
      errors.push(`Bulk dispatch failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const processing_time = Date.now() - start_time;
    const success = operations_failed === 0;

    console.log(`✅ Bulk dispatch completed: ${operations_completed} operations completed, ${operations_failed} failed in ${processing_time}ms`);

    return {
      success,
      operations_completed,
      operations_failed,
      errors,
      warnings,
      results,
      processing_time
    };
  }
}

export const dispatch_service = new DispatchService();