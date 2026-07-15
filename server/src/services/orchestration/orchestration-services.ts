/**
 * Service Orchestration Layer — Dedicated service classes for the five missing
 * orchestrators identified in the Graphify gap analysis.
 *
 * Each follows the singleton pattern (EmbeddingService / ReflectionStore convention),
 * stores metadata in MongoDB for Graphify extraction, and exposes a clean API for
 * the MCP server to delegate to.
 *
 * Services:
 *  1. SalienceService — attention state management
 *  2. DriveStateService — homeostatic drive orchestration (wraps MotivationalEngine)
 *  3. EmotionalContextService — emotional metadata index
 *  4. IdentityKernelService — identity integrity validation
 *  5. ActionPolicyService — learned Q-value policy access (wraps DecisionActionService)
 */

import { get_database } from '../../database/connection.js';
import { DecisionActionService } from '../processing/decision-action-service.js';

// ──────────────────────────────────────────────────────────────────────────────
// 1. SALIENCE SERVICE
// ──────────────────────────────────────────────────────────────────────────────

export interface SalienceState {
  mode: 'exploration' | 'task_execution' | 'reflection' | 'alert' | 'idle';
  active_entities: Array<{ entity: string; salience: number }>;
  attention_span_seconds: number;
  last_shift: string;
}

export interface AttentionReport {
  high_salience_count: number;
  medium_salience_count: number;
  low_salience_count: number;
  avg_salience: number;
  dominant_focus: string | null;
  generated_at: string;
}

export class SalienceService {
  private static instance: SalienceService;
  private currentMode: SalienceState['mode'] = 'idle';
  private entitySalience: Map<string, { salience: number; last_updated: Date }> = new Map();
  private attentionStart: Date = new Date();
  private _initialized = false;

  private constructor() {}

  static get_instance(): SalienceService {
    if (!SalienceService.instance) {
      SalienceService.instance = new SalienceService();
    }
    return SalienceService.instance;
  }

  /** Load persisted salience from MongoDB on first use. Safe to call multiple times. */
  async initialize(): Promise<void> {
    if (this._initialized) return;
    try {
      const db = get_database();
      if (!db) return;
      const rows = await db.collection('entity_salience').find({}).toArray();
      for (const row of rows) {
        if (row.entity && row.salience != null) {
          this.entitySalience.set(row.entity, {
            salience: row.salience,
            last_updated: row.last_updated ? new Date(row.last_updated) : new Date(),
          });
        }
      }
      this._initialized = true;
    } catch (err) {
      console.error('[SalienceService] initialize failed:', err);
    }
  }

  getCurrentSalience(): SalienceState {
    const entities = Array.from(this.entitySalience.entries())
      .map(([entity, data]) => ({ entity, salience: data.salience }))
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 10);

    return {
      mode: this.currentMode,
      active_entities: entities,
      attention_span_seconds: Math.floor((Date.now() - this.attentionStart.getTime()) / 1000),
      last_shift: this.attentionStart.toISOString(),
    };
  }

  async shiftSalience(entity: string, weight: number): Promise<void> {
    const existing = this.entitySalience.get(entity);
    const decayed = existing ? existing.salience * 0.85 : 0;
    const salience = Math.min(1, decayed + weight);
    const last_updated = new Date();
    this.entitySalience.set(entity, { salience, last_updated });

    // Persist to MongoDB
    try {
      const db = get_database();
      if (db) {
        await db.collection('entity_salience').updateOne(
          { entity },
          { $set: { entity, salience, last_updated } },
          { upsert: true }
        );
      }
    } catch (err) {
      console.error('[SalienceService] persist failed:', err);
    }

    // Determine mode from highest-salience entity
    const top = this.getCurrentSalience().active_entities[0];
    if (top && top.salience > 0.8) {
      this.currentMode = 'alert';
    } else if (top && top.salience > 0.4) {
      this.currentMode = 'task_execution';
    } else {
      this.currentMode = 'exploration';
    }

    this.attentionStart = new Date();
  }

  getAttentionReport(): AttentionReport {
    const entities = Array.from(this.entitySalience.values());
    const high = entities.filter(e => e.salience >= 0.6).length;
    const medium = entities.filter(e => e.salience >= 0.3 && e.salience < 0.6).length;
    const low = entities.filter(e => e.salience < 0.3).length;
    const avg = entities.length > 0
      ? entities.reduce((s, e) => s + e.salience, 0) / entities.length
      : 0;
    const top = this.getCurrentSalience().active_entities[0];

    return {
      high_salience_count: high,
      medium_salience_count: medium,
      low_salience_count: low,
      avg_salience: avg,
      dominant_focus: top?.entity ?? null,
      generated_at: new Date().toISOString(),
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. DRIVE STATE SERVICE
// ──────────────────────────────────────────────────────────────────────────────

export interface DriveStateSnapshot {
  drives: Record<string, { current: number; target: number; strength: number; trend: string }>;
  dominant: string;
  timestamp: string;
}

export class DriveStateService {
  private static instance: DriveStateService;

  private constructor() {}

  static get_instance(): DriveStateService {
    if (!DriveStateService.instance) {
      DriveStateService.instance = new DriveStateService();
    }
    return DriveStateService.instance;
  }

  /** Delegate to MotivationalEngine for current drive state. */
  getDriveState(): DriveStateSnapshot {
    // Lazy import to avoid circular dependency at module load time
    const { MotivationalEngine } = require('../processing/motivational-engine.js');
    const engine = MotivationalEngine.get_instance();
    const snapshot = engine.tick();
    const dominant = engine.getDominantDrive();
    return {
      drives: snapshot.drives as Record<string, any>,
      dominant,
      timestamp: snapshot.timestamp.toISOString(),
    };
  }

  /** Recalculate drives from recent events. Used by the consolidation bus. */
  async recalculateFromEvents(userId: string): Promise<void> {
    try {
      const db = get_database();
      if (!db) return;

      const { MotivationalEngine } = require('../processing/motivational-engine.js');
      const engine = MotivationalEngine.get_instance();

      // Count recent events as a proxy for activity level
      const recentWindow = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const eventCount = await db.collection('episodic_events').countDocuments({
        user_id: userId,
        timestamp: { $gte: recentWindow },
      });

      const factCount = await db.collection('semantic_facts').countDocuments({
        user_id: userId,
        created_at: { $gte: recentWindow },
      });

      if (eventCount > 10) engine.replenishDrive('connection', 0.02);
      if (factCount > 5) engine.replenishDrive('coherence', 0.02);
      if (eventCount > 50) engine.replenishDrive('novelty', 0.01);
    } catch (err) {
      console.error('[DriveStateService] recalculateFromEvents failed:', err);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. EMOTIONAL CONTEXT SERVICE
// ──────────────────────────────────────────────────────────────────────────────

export interface EmotionalContext {
  entity: string;
  dominant_emotion: string;
  intensity: number;
  trajectory: 'rising' | 'falling' | 'stable';
  sentiment_ratio: number;
  associated_entities: string[];
}

export class EmotionalContextService {
  private static instance: EmotionalContextService;

  private constructor() {}

  static get_instance(): EmotionalContextService {
    if (!EmotionalContextService.instance) {
      EmotionalContextService.instance = new EmotionalContextService();
    }
    return EmotionalContextService.instance;
  }

  /** Subscribe to ConsolidationOutputBus for profile-driven emotional updates. */
  async subscribeToConsolidationBus(): Promise<void> {
    try {
      const { consolidationOutputBus } = await import('../infrastructure/consolidation-output-bus.js');
      consolidationOutputBus.onConsolidationComplete(async (profile: any) => {
        // Update emotional context for key entities from the consolidation profile
        const entities = [
          ...(profile.expertise?.map((e: any) => e.domain) ?? []),
          ...(profile.interests?.map((i: any) => i.area) ?? []),
          ...(profile.entities?.slice(0, 5).map((e: any) => e.name) ?? []),
        ];
        for (const entity of entities) {
          if (entity) {
            await this.updateEmotionalResponse(entity, {
              emotion: profile.communication_style?.formality > 0.7 ? 'engaged' : 'curious',
              intensity: 0.3,
            });
          }
        }
      });
    } catch (err) {
      console.error('[EmotionalContextService] bus subscription failed:', err);
    }
  }

  async getEmotionalContext(entity: string): Promise<EmotionalContext | null> {
    try {
      const db = get_database();
      if (!db) return null;

      // Query the reflection store for emotional metadata about this entity
      const reflectionNode = await db.collection('reflection_nodes').findOne({
        name: { $regex: new RegExp(entity, 'i') },
      });

      if (!reflectionNode) {
        return {
          entity,
          dominant_emotion: 'neutral',
          intensity: 0,
          trajectory: 'stable',
          sentiment_ratio: 0.5,
          associated_entities: [],
        };
      }

      return {
        entity,
        dominant_emotion: reflectionNode.properties?.dominant_emotion || 'neutral',
        intensity: reflectionNode.properties?.emotional_intensity || 0,
        trajectory: reflectionNode.properties?.trajectory || 'stable',
        sentiment_ratio: reflectionNode.properties?.sentiment_ratio || 0.5,
        associated_entities: reflectionNode.properties?.related_entities || [],
      };
    } catch (err) {
      console.error('[EmotionalContextService] getEmotionalContext failed:', err);
      return null;
    }
  }

  async updateEmotionalResponse(entity: string, event: { emotion: string; intensity: number }): Promise<void> {
    try {
      const db = get_database();
      if (!db) return;

      await db.collection('reflection_nodes').updateOne(
        { name: entity },
        {
          $set: {
            'properties.dominant_emotion': event.emotion,
            'properties.emotional_intensity': event.intensity,
            'properties.updated_at': new Date().toISOString(),
          },
          $inc: { 'properties.event_count': 1 },
        },
        { upsert: true }
      );
    } catch (err) {
      console.error('[EmotionalContextService] updateEmotionalResponse failed:', err);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. IDENTITY KERNEL SERVICE
// ──────────────────────────────────────────────────────────────────────────────

export interface IdentityKernel {
  narrative: string;
  insights: Array<{
    domain: string;
    insight_text: string;
    confidence: number;
    status: 'strengthening' | 'stable' | 'weakening';
  }>;
  stability_score: number;
  generated_at: string;
}

export class IdentityKernelService {
  private static instance: IdentityKernelService;

  private constructor() {}

  static get_instance(): IdentityKernelService {
    if (!IdentityKernelService.instance) {
      IdentityKernelService.instance = new IdentityKernelService();
    }
    return IdentityKernelService.instance;
  }

  async getIdentityKernel(userId: string): Promise<IdentityKernel> {
    try {
      const db = get_database();
      if (!db) {
        return this._emptyKernel();
      }

      // Query philosophical insights and reflection journals for identity signals
      const insights = await db.collection('philosophical_insights')
        .find({ user_id: userId })
        .sort({ created_at: -1 })
        .limit(10)
        .toArray();

      const journals = await db.collection('reflective_journals')
        .find({ user_id: userId })
        .sort({ created_at: -1 })
        .limit(3)
        .toArray();

      // Build narrative from latest journal
      const narrative = journals.length > 0
        ? journals[0].narrative || journals[0].content || 'No narrative available.'
        : 'Identity is forming. No reflective journals yet.';

      // Map insights
      const mappedInsights = insights.map(ins => ({
        domain: ins.domain || 'general',
        insight_text: ins.insight_text || ins.content || '',
        confidence: ins.confidence || 0.5,
        status: (ins.status || 'stable') as 'strengthening' | 'stable' | 'weakening',
      }));

      // Stability: % of stable/strengthening insights
      const stableCount = mappedInsights.filter(i => i.status !== 'weakening').length;
      const stability = mappedInsights.length > 0 ? stableCount / mappedInsights.length : 1;

      return {
        narrative,
        insights: mappedInsights,
        stability_score: stability,
        generated_at: new Date().toISOString(),
      };
    } catch (err) {
      console.error('[IdentityKernelService] getIdentityKernel failed:', err);
      return this._emptyKernel();
    }
  }

  async validateIdentityIntegrity(userId: string): Promise<{ valid: boolean; issues: string[] }> {
    const kernel = await this.getIdentityKernel(userId);
    const issues: string[] = [];

    if (kernel.insights.length === 0) {
      issues.push('No philosophical insights — identity has not been distilled from experience');
    }
    if (kernel.stability_score < 0.5) {
      issues.push(`Low identity stability (${(kernel.stability_score * 100).toFixed(0)}%) — weakening insights outnumber stable ones`);
    }
    if (kernel.narrative === 'Identity is forming. No reflective journals yet.') {
      issues.push('No reflective journals — sleep consolidation has not produced self-model');
    }

    return { valid: issues.length === 0, issues };
  }

  private _emptyKernel(): IdentityKernel {
    return {
      narrative: 'Identity is forming. No reflective journals yet.',
      insights: [],
      stability_score: 1,
      generated_at: new Date().toISOString(),
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. ACTION POLICY SERVICE
// ──────────────────────────────────────────────────────────────────────────────

export interface ActionPolicyEntry {
  action_id: string;
  q_value: number;
  probability: number;
}

export interface ActionPolicy {
  state_key: string;
  actions: ActionPolicyEntry[];
  last_updated: string;
}

export class ActionPolicyService {
  private static instance: ActionPolicyService;

  private constructor() {}

  static get_instance(): ActionPolicyService {
    if (!ActionPolicyService.instance) {
      ActionPolicyService.instance = new ActionPolicyService();
    }
    return ActionPolicyService.instance;
  }

  getPolicyForState(stateKey: string): ActionPolicy {
    const service = DecisionActionService.get_instance();
    const policy = service.getPolicy(stateKey);

    return {
      state_key: stateKey,
      actions: policy.map((p: any) => ({
        action_id: p.action_id,
        q_value: p.q_value,
        probability: p.probability,
      })),
      last_updated: new Date().toISOString(),
    };
  }

  async updatePolicy(stateKey: string, actionId: string, reward: number): Promise<void> {
    try {
      const db = get_database();
      if (!db) return;

      // Store policy update in MongoDB for persistence
      await db.collection('action_policies').updateOne(
        { state_key: stateKey, action_id: actionId },
        {
          $set: {
            state_key: stateKey,
            action_id: actionId,
            reward,
            updated_at: new Date(),
          },
          $inc: { update_count: 1 },
        },
        { upsert: true }
      );
    } catch (err) {
      console.error('[ActionPolicyService] updatePolicy failed:', err);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Singleton exports
// ──────────────────────────────────────────────────────────────────────────────

export const salienceService = SalienceService.get_instance();
export const driveStateService = DriveStateService.get_instance();
export const emotionalContextService = EmotionalContextService.get_instance();
export const identityKernelService = IdentityKernelService.get_instance();
export const actionPolicyService = ActionPolicyService.get_instance();
