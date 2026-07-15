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
      const { MotivationalEngine } = await import('../processing/motivational-engine.js');
      const engine = MotivationalEngine.get_instance();
      engine.receiveConsolidationResult({
        expertiseCount: profile.expertiseAreas?.length ?? 0,
        interestCount: profile.interestAreas?.length ?? 0,
        entityCount: profile.keyEntities?.length ?? 0,
        knowledgeEvolution: undefined,
        // Cast to match MotivationalEngine's expected parameter shapes
        activityPatterns: profile.activityPatterns as any,
        communicationStyle: profile.communicationStyle as any,
        memoryStats: profile.memoryStats as any,
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
        user_id: profile.userId,
        expertise_domains: profile.expertiseAreas?.map((e: any) => e.domain) ?? [],
        interest_areas: profile.interestAreas?.map((i: any) => i.topic) ?? [],
        top_entities: profile.keyEntities?.slice(0, 10).map((e: any) => e.entityName) ?? [],
        knowledge_depth_trend: 'stable',
        total_conversation_turns: profile.activityPatterns?.length ?? 0,
        communication_formality: profile.communicationStyle?.formalityLevel ?? 'unknown',
        memory_stats: profile.memoryStats ?? {},
        consolidation_run_at: new Date().toISOString(),
      };

      await db.collection('semantic_facts').insertOne({
        ...summary,
        content: `Consolidation run for ${profile.userId}: ${(summary.expertise_domains as any[]).length} expertise areas, ${(summary.interest_areas as any[]).length} interests, ${(summary.top_entities as any[]).length} key entities. Knowledge depth trend: ${summary.knowledge_depth_trend}.`,
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
