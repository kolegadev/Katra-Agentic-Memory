/**
 * Memory Decay Service
 *
 * Implements power-law decay (S(t) = a * t^(-d)), retrieval-strength tracking,
 * and spaced repetition boosting for all memory types.
 */

import { get_database } from '../../database/connection.js';
import {
  DEFAULT_DECAY_CONFIGS,
  SPACED_REPETITION_INTERVALS_DAYS,
  DEFAULT_REINFORCEMENT_FACTOR,
} from '../../types/memory.js';
import type { DecayStats, DecayConfig } from '../../types/memory.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class MemoryDecayService {
  private static instance: MemoryDecayService;

  private constructor() {}

  static get_instance(): MemoryDecayService {
    if (!MemoryDecayService.instance) {
      MemoryDecayService.instance = new MemoryDecayService();
    }
    return MemoryDecayService.instance;
  }

  getConfig(memoryType: string): DecayConfig {
    const config = DEFAULT_DECAY_CONFIGS[memoryType];
    if (!config) {
      return { memoryType, decayExponent: 0.3, initialStrength: 1.0 };
    }
    return config;
  }

  computeRetrievalStrength(
    memoryType: string,
    createdAt: Date,
    lastAccessedAt: Date | null,
    accessCount: number,
    emotionalArousal?: number,
    decayResistant?: boolean
  ): number {
    const config = this.getConfig(memoryType);
    const lastAccess = lastAccessedAt || createdAt;
    const t = Math.max(1, (Date.now() - lastAccess.getTime()) / DAY_MS);
    const a = config.initialStrength;
    let d = config.decayExponent;

    // ── Emotional modulation of decay ──────────────────────────
    // High-arousal events resist forgetting (amygdala modulation)
    if (decayResistant) {
      d *= 0.3;  // 70% slower decay for emotionally charged events
    } else if (emotionalArousal !== undefined && emotionalArousal > 0.6) {
      d *= 0.5;  // 50% slower decay for high-arousal events
    } else if (emotionalArousal !== undefined && emotionalArousal < 0.2) {
      d *= 1.5;  // 50% faster decay for low-arousal (boring) events
    }

    let strength = a * Math.pow(t, -d);

    if (accessCount > 0) {
      strength = Math.min(1.0, strength * (1 + 0.01 * Math.log(accessCount + 1)));
    }

    return Math.max(0, Math.min(1.0, strength));
  }

  boostOnRecall(
    memoryType: string,
    currentStrength: number,
    accessCount: number
  ): { newStrength: number; newDecayExponent: number } {
    const config = this.getConfig(memoryType);
    const newAccessCount = accessCount + 1;

    const newStrength = Math.min(1.0, config.initialStrength);
    const newDecayExponent = config.decayExponent * Math.pow(DEFAULT_REINFORCEMENT_FACTOR, Math.min(newAccessCount, 10));

    return { newStrength, newDecayExponent };
  }

  getCurrentInterval(accessCount: number): number {
    if (accessCount <= 0) return 1;
    const idx = Math.min(accessCount - 1, SPACED_REPETITION_INTERVALS_DAYS.length - 1);
    return SPACED_REPETITION_INTERVALS_DAYS[idx];
  }

  async getDecayStats(userId: string): Promise<DecayStats[]> {
    const db = get_database();
    const stats: DecayStats[] = [];

    const collections = [
      { name: 'episodic_events', type: 'episodic' },
      { name: 'semantic_facts', type: 'semantic' },
      { name: 'knowledge_relationships', type: 'knowledge' },
    ];

    for (const { name, type } of collections) {
      try {
        const memories = await db.collection(name)
          .find({ user_id: userId })
          .sort({ timestamp: -1, created_at: -1 } as any)
          .limit(1000)
          .toArray();

        if (memories.length === 0) {
          stats.push({
            memoryType: type,
            totalMemories: 0,
            averageStrength: 0,
            minStrength: 0,
            maxStrength: 0,
            decayedCount: 0,
            reinforcedCount: 0,
          });
          continue;
        }

        // Compute real-time decay strengths instead of reading stale cached values
        const strengths: number[] = [];
        let decayedCount = 0;
        let reinforcedCount = 0;

        for (const m of memories) {
          const createdAt = m.created_at || m.timestamp || new Date();
          const lastAccessedAt = m.last_accessed_at || m.last_accessed
            || m.metadata?.last_accessed_at || null;
          const accessCount = m.access_count || m.metadata?.access_count || 0;

          const strength = this.computeRetrievalStrength(
            type, createdAt, lastAccessedAt, accessCount
          );
          strengths.push(strength);

          if (strength < 0.3) decayedCount++;
          if (accessCount > 1) reinforcedCount++;
        }

        const avg = strengths.reduce((a: number, b: number) => a + b, 0) / strengths.length;

        stats.push({
          memoryType: type,
          totalMemories: memories.length,
          averageStrength: parseFloat(avg.toFixed(4)),
          minStrength: parseFloat(Math.min(...strengths).toFixed(4)),
          maxStrength: parseFloat(Math.max(...strengths).toFixed(4)),
          decayedCount,
          reinforcedCount,
        });
      } catch {
        stats.push({
          memoryType: type,
          totalMemories: 0,
          averageStrength: 0,
          minStrength: 0,
          maxStrength: 0,
          decayedCount: 0,
          reinforcedCount: 0,
        });
      }
    }

    return stats;
  }
}
