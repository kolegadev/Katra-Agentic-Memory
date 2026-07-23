/**
 * Salience Service (Attention Gate / Thalamus Proxy)
 *
 * 6-signal salience function that gates what reaches consciousness.
 * Without this, every memory has equal retrieval weight.
 *
 * S = w1*Recency + w2*EmotionalIntensity + w3*GoalRelevance
 *   + w4*Novelty + w5*FrequencyRarity + w6*Intensity
 *
 * 5 meta-states modulate weight distribution.
 * Bayesian surprise for valence/intensity shifts.
 * Yerkes-Dodson arousal-threshold modulation.
 */

export type MetaState = 'exploration' | 'task_execution' | 'reflection' | 'alert' | 'idle';

export interface SalienceParams {
  recency?: number;
  hoursSinceEvent?: number;
  emotionalIntensity?: number;
  goalRelevance?: number;
  novelty?: number;
  frequencyRarity?: number;
  intensity?: number;
  confidence?: number;
  embedding?: number[];
  priorValence?: number;
  priorIntensity?: number;
  newValence?: number;
  newIntensity?: number;
}

export interface SalienceResult {
  score: number;
  tier: 'high' | 'medium' | 'low';
  signals: Record<string, number>;
  weights: Record<string, number>;
  meta_state: MetaState;
  threshold: number;
}

export interface ProcessingDirective {
  compute_embedding: boolean;
  trigger_consolidation: boolean;
  decay_multiplier: number;
  add_to_working_memory: boolean;
}

export interface AttentionReport {
  meta_state: MetaState;
  threshold: number;
  weights: Record<string, number>;
  goal_count: number;
  recent_scores: number[];
}

const META_WEIGHTS: Record<MetaState, Record<string, number>> = {
  exploration:    { novelty: 0.35, emotion: 0.18, goal: 0.13, recency: 0.10, freq: 0.10, intensity: 0.05, surprise: 0.09 },
  task_execution: { goal: 0.45, recency: 0.22, novelty: 0.10, emotion: 0.05, freq: 0.05, intensity: 0.05, surprise: 0.08 },
  reflection:     { emotion: 0.30, goal: 0.18, recency: 0.13, novelty: 0.13, freq: 0.10, intensity: 0.05, surprise: 0.11 },
  alert:          { emotion: 0.25, novelty: 0.20, recency: 0.18, goal: 0.18, freq: 0.03, intensity: 0.02, surprise: 0.14 },
  idle:           { novelty: 0.28, emotion: 0.23, recency: 0.14, goal: 0.09, freq: 0.14, intensity: 0.05, surprise: 0.07 },
};

const META_AROUSAL: Record<MetaState, number> = {
  exploration: 0.80,
  task_execution: 0.65,
  reflection: 0.50,
  alert: 0.90,
  idle: 0.20,
};

import { DecisionActionService } from './decision-action-service.js';

export class SalienceService {
  private static instance: SalienceService;
  private metaState: MetaState = 'idle';
  private goalEmbeddings: Map<string, number[]> = new Map();
  private recentScores: number[] = [];
  private static readonly MAX_RECENT_SCORES = 100;

  private constructor() {}

  static get_instance(): SalienceService {
    if (!SalienceService.instance) {
      SalienceService.instance = new SalienceService();
    }
    return SalienceService.instance;
  }

  setMetaState(state: MetaState): void {
    this.metaState = state;
  }

  getMetaState(): MetaState {
    return this.metaState;
  }

  setGoalEmbedding(goalId: string, embedding: number[]): void {
    this.goalEmbeddings.set(goalId, embedding);
  }

  removeGoal(goalId: string): void {
    this.goalEmbeddings.delete(goalId);
  }

  getGoalCount(): number {
    return this.goalEmbeddings.size;
  }

  computeSalience(params: SalienceParams): SalienceResult {
    const weights = META_WEIGHTS[this.metaState];
    const arousal = META_AROUSAL[this.metaState];

    const threshold = 0.5 + 0.3 * Math.pow(arousal - 0.5, 2);

    const hoursSinceEvent = params.hoursSinceEvent ?? 0;
    const recency = params.recency ?? (1 / (1 + 0.1 * Math.max(0, hoursSinceEvent)));

    const emotionalIntensity = params.emotionalIntensity ?? (params.confidence ?? 0.5);

    let goalRelevance = params.goalRelevance ?? 0;
    if (goalRelevance === 0 && params.embedding && this.goalEmbeddings.size > 0) {
      goalRelevance = this.computeMaxGoalSimilarity(params.embedding);
    }

    const novelty = params.novelty ?? 0.5;
    const frequencyRarity = params.frequencyRarity ?? 0.5;
    const intensity = params.intensity ?? (params.confidence ?? 0.5);

    // Bayesian surprise: belief-shift magnitude when entity emotional signature changes.
    // High = belief-changing event (e.g. "server architecture is different")
    // Low = inconsequential event (e.g. "it rained today")
    let bayesianSurprise = 0;
    if (params.priorValence !== undefined && params.newValence !== undefined) {
      bayesianSurprise = this.computeBayesianSurprise(
        params.priorValence ?? 0,
        params.priorIntensity ?? 0,
        params.newValence ?? 0,
        params.newIntensity ?? 0
      );
    }

    const signals: Record<string, number> = {
      recency: Math.max(0, Math.min(1, recency)),
      emotionalIntensity: Math.max(0, Math.min(1, emotionalIntensity)),
      goalRelevance: Math.max(0, Math.min(1, goalRelevance)),
      novelty: Math.max(0, Math.min(1, novelty)),
      frequencyRarity: Math.max(0, Math.min(1, frequencyRarity)),
      intensity: Math.max(0, Math.min(1, intensity)),
      bayesianSurprise: Math.max(0, Math.min(1, bayesianSurprise)),
    };

    const score =
      weights.recency * signals.recency +
      weights.emotion * signals.emotionalIntensity +
      weights.goal * signals.goalRelevance +
      weights.novelty * signals.novelty +
      weights.freq * signals.frequencyRarity +
      weights.intensity * signals.intensity +
      (weights.surprise || 0) * signals.bayesianSurprise;

    const clampedScore = Math.max(0, Math.min(1, score));

    let tier: 'high' | 'medium' | 'low';
    if (clampedScore > 0.7) {
      tier = 'high';
    } else if (clampedScore >= 0.35) {
      tier = 'medium';
    } else {
      tier = 'low';
    }

    this.recentScores.push(clampedScore);
    if (this.recentScores.length > SalienceService.MAX_RECENT_SCORES) {
      this.recentScores.shift();
    }

    return {
      score: parseFloat(clampedScore.toFixed(4)),
      tier,
      signals,
      weights,
      meta_state: this.metaState,
      threshold: parseFloat(threshold.toFixed(4)),
    };
  }

  computeBayesianSurprise(
    priorValence: number,
    priorIntensity: number,
    newValence: number,
    newIntensity: number
  ): number {
    const valenceShift = Math.abs(newValence - priorValence);
    const intensityShift = Math.abs(newIntensity - priorIntensity);
    return parseFloat((0.6 * valenceShift + 0.4 * intensityShift).toFixed(4));
  }

  getProcessingDirective(tier: 'high' | 'medium' | 'low'): ProcessingDirective {
    switch (tier) {
      case 'high':
        return {
          compute_embedding: true,
          trigger_consolidation: true,
          decay_multiplier: 1.0,
          add_to_working_memory: true,
        };
      case 'medium':
        return {
          compute_embedding: true,
          trigger_consolidation: false,
          decay_multiplier: 1.5,
          add_to_working_memory: false,
        };
      case 'low':
        return {
          compute_embedding: false,
          trigger_consolidation: false,
          decay_multiplier: 3.0,
          add_to_working_memory: false,
        };
    }
  }

  getAttentionReport(): AttentionReport {
    const arousal = META_AROUSAL[this.metaState];
    const threshold = 0.5 + 0.3 * Math.pow(arousal - 0.5, 2);

    return {
      meta_state: this.metaState,
      threshold: parseFloat(threshold.toFixed(4)),
      weights: { ...META_WEIGHTS[this.metaState] },
      goal_count: this.goalEmbeddings.size,
      recent_scores: [...this.recentScores].slice(-20),
    };
  }

  /**
   * ACC → Thalamus feedback loop. Reads error/surprise signals from
   * DecisionActionService and interpolates salience weights toward the
   * appropriate meta-state profile. Smooth transitions (10% per cycle)
   * prevent oscillation. Called from background processor each cycle.
   */
  adaptWeights(): void {
    try {
      const acc = DecisionActionService.get_instance();
      const surpriseRate = acc.getSurpriseRate();
      const accuracy = acc.getRecentAccuracy();
      const totalOutcomes = acc.getTotalOutcomes();

      // No outcomes yet — stay at current weights (bootstrap phase)
      if (totalOutcomes === 0) return;

      // Determine target meta-state from ACC signals
      let targetState: MetaState = this.metaState;
      if (surpriseRate > 0.3) {
        targetState = 'exploration';  // High surprise → explore broadly
      } else if (accuracy > 0.7 && surpriseRate < 0.1) {
        targetState = 'task_execution';  // High accuracy, low surprise → exploit
      } else if (totalOutcomes < 10) {
        targetState = 'idle';  // Bootstrap — not enough data yet
      }

      // Smooth interpolation: 10% toward target per cycle
      const targetWeights = META_WEIGHTS[targetState];
      for (const state of Object.keys(META_WEIGHTS) as MetaState[]) {
        const current = META_WEIGHTS[state];
        for (const weight of Object.keys(current)) {
          const targetVal = targetWeights[weight] || current[weight];
          current[weight] = parseFloat((current[weight] * 0.9 + targetVal * 0.1).toFixed(4));
        }
      }

      if (targetState !== this.metaState) {
        this.setMetaState(targetState);
      }
    } catch {
      // ACC not available — keep current weights (non-critical)
    }
  }

  private computeMaxGoalSimilarity(embedding: number[]): number {
    let maxSim = 0;
    for (const goalEmb of this.goalEmbeddings.values()) {
      const sim = this.cosineSimilarity(embedding, goalEmb);
      if (sim > maxSim) maxSim = sim;
    }
    return maxSim;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
