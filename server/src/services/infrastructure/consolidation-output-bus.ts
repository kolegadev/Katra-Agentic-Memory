/**
 * Consolidation Output Bus — Distribution layer for MemoryConsolidator results.
 *
 * After each consolidation cycle, this bus receives the UserMemoryProfile and:
 *  1. Updates the MotivationalEngine drive states (coherence, novelty, connection, growth)
 *  2. Stores the profile as a tagged semantic fact for future retrieval
 *  3. Notifies downstream subscribers (e.g., autonomous trigger, identity kernel)
 *
 * Design: Singleton, following the pattern of EmbeddingService / ReflectionStore.
 * MotivationalEngine is lazily imported at runtime to avoid circular dependencies.
 */

import { get_database } from '../../database/connection.js';
import type { UserMemoryProfile } from '../memory/memory-consolidator.js';

type ConsolidationCallback = (profile: UserMemoryProfile) => void | Promise<void>;

export class ConsolidationOutputBus {
  private static instance: ConsolidationOutputBus;
  private subscribers: ConsolidationCallback[] = [];
  private lastProfile: UserMemoryProfile | null = null;
  private lastRun: Date | null = null;

  private constructor() {}

  static get_instance(): ConsolidationOutputBus {
    if (!ConsolidationOutputBus.instance) {
      ConsolidationOutputBus.instance = new ConsolidationOutputBus();
    }
    return ConsolidationOutputBus.instance;
  }

  /** Register a callback to be invoked after each consolidation cycle. */
  onConsolidationComplete(callback: ConsolidationCallback): void {
    this.subscribers.push(callback);
  }

  /**
   * Publish a consolidation result. This is the primary entry point,
   * called by MemoryConsolidator after buildUserMemoryProfile completes.
   */
  async publish(profile: UserMemoryProfile): Promise<void> {
    this.lastProfile = profile;
    this.lastRun = new Date();

    // 1. Update drive states via MotivationalEngine
    await this._updateDriveStates(profile);

    // 2. Store profile as a tagged semantic fact
    await this._storeAsSemanticFact(profile);

    // 3. Notify subscribers
    for (const subscriber of this.subscribers) {
      try {
        await subscriber(profile);
      } catch (err) {
        console.error('[ConsolidationOutputBus] subscriber error:', err);
      }
    }
  }

  /** Get the most recent consolidation profile (or null if never run). */
  getLastProfile(): UserMemoryProfile | null {
    return this.lastProfile;
  }

  /** Get the timestamp of the last consolidation run. */
  getLastRun(): Date | null {
    return this.lastRun;
  }

  // ── Private ───────────────────────────────────────────────────────

  private async _updateDriveStates(profile: UserMemoryProfile): Promise<void> {
    try {
      // Lazy import to avoid circular dependency at module load time
      const { motivationalEngine } = await import('../processing/motivational-engine.js');
      motivationalEngine.receiveConsolidationResult({
        expertiseCount: profile.expertise?.length ?? 0,
        interestCount: profile.interests?.length ?? 0,
        entityCount: profile.entities?.length ?? 0,
        knowledgeEvolution: profile.knowledge_evolution,
        activityPatterns: profile.activity_patterns,
        communicationStyle: profile.communication_style,
        memoryStats: profile.memory_stats,
      });
    } catch (err) {
      console.error('[ConsolidationOutputBus] drive state update failed:', err);
    }
  }

  private async _storeAsSemanticFact(profile: UserMemoryProfile): Promise<void> {
    try {
      const db = get_database();
      if (!db) return;

      const summary: Record<string, unknown> = {
        type: 'consolidation_output',
        user_id: profile.user_id,
        expertise_domains: profile.expertise?.map(e => e.domain) ?? [],
        interest_areas: profile.interests?.map(i => i.area) ?? [],
        top_entities: profile.entities?.slice(0, 10).map(e => e.name) ?? [],
        knowledge_depth_trend: profile.knowledge_evolution?.trend ?? 'stable',
        total_conversation_turns: profile.activity_patterns?.reduce((s, p) => s + (p.total_conversations || 0), 0) ?? 0,
        communication_formality: profile.communication_style?.formality ?? 'unknown',
        memory_stats: profile.memory_stats ?? {},
        consolidation_run_at: new Date().toISOString(),
      };

      await db.collection('semantic_facts').insertOne({
        ...summary,
        content: `Consolidation run for ${profile.user_id}: ${summary.expertise_domains.length} expertise areas, ${summary.interest_areas.length} interests, ${summary.top_entities.length} key entities. Knowledge depth trend: ${summary.knowledge_depth_trend}.`,
        category: 'fact',
        source: 'consolidation-output-bus',
        confidence: 0.9,
        tags: ['consolidation-output', 'memory-profile', 'drive-system'],
        created_at: new Date(),
      });
    } catch (err) {
      console.error('[ConsolidationOutputBus] semantic fact storage failed:', err);
    }
  }
}

export const consolidationOutputBus = ConsolidationOutputBus.get_instance();
