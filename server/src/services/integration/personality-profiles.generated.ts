/**
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Generated from shared/personality/registry.json by
 * scripts/generate-personality-registry.mjs.
 * Regenerate with: node scripts/generate-personality-registry.mjs
 *
 * The registry is the single source of truth for the ten memory personality
 * profiles — sources, weights, scoring parameters, budget floors, the
 * agent-message invariant and the recommended token budgets. This module is
 * the server half of that source; the bridge consumes the same registry.
 * ITER-1 changed no value: the numbers here are the ones the server shipped
 * before the registry existed.
 */

/** Schema version of shared/personality/registry.json. */
export const REGISTRY_VERSION = '1.0';

/** Inter-agent comms always rank first. Not overridable (enforced in the bridge). */
export const AGENT_MESSAGE_WEIGHT = 10.0;

/** All source labels known to the retriever. */
export const ALL_SOURCES = [
  'agent_message',
  'daily_reflection',
  'philosophical_insights',
  'unresolved_threads',
  'working_memory',
  'temporal_context',
  'vector_search',
  'temporal_recall',
  'emotional_context',
  'missions',
  'knowledge_graph',
] as const;

/**
 * Scoring parameters every profile inherits unless it overrides them.
 * Registry scoring keys are the server's field names: k → relevance_multiplier, half_life_days → recency_half_life_days, cap_pct → max_single_source_pct, floors → budget_floors.
 */
export const DEFAULT_SCORING = {
  /** k in: composite = weight * (1 + k*vector_score + recency_score) */
  k: 2.0,
  /** Half-life for power-law recency: 1 / (1 + age_days / half_life) */
  half_life_days: 14.0,
  /** No single source (except agent_message) may exceed this share. */
  cap_pct: 0.4,
  /** Guaranteed minimum share of the token budget per source (fractions). */
  floors: {
    working_memory: 0.1,
    vector_search: 0.15,
  },
  /** Vector search: how many candidates to fetch. */
  vector_fetch_limit: 5,
  /** If true, sample the fetched candidates score-weighted at random. */
  vector_sample: false,
  /** Sources whose weight falls below this are not fetched at all. */
  min_fetch_weight: 1.0,
} as const;

/** A profile's scoring overrides — only the keys it actually restates. */
export interface ProfileScoringOverrides {
  readonly k?: number;
  readonly half_life_days?: number;
  readonly cap_pct?: number;
  readonly floors?: Readonly<Record<string, number>>;
  readonly vector_fetch_limit?: number;
  readonly vector_sample?: boolean;
  readonly min_fetch_weight?: number;
}

/** One profile as declared in the registry. */
export interface ProfileData {
  readonly name: string;
  readonly description: string;
  /**
   * The server mirror's own wording where it has historically differed from the
   * bridge text (registry v1.0: `legacy` only). ITER-1 is behaviour-preserving,
   * so the server keeps the wording it ships today.
   */
  readonly server_description?: string;
  readonly weights: Readonly<Record<string, number>>;
  readonly scoring: ProfileScoringOverrides;
}

/** The ten profiles, in registry order. */
export const PROFILE_DATA: Readonly<Record<string, ProfileData>> = {
  balanced: {
    name: 'balanced',
    description: 'Human-baseline retrieval: cue-driven relevance dominates, moderate interiority, moderate recency. The recommended default.',
    weights: {
      vector_search: 5.0,
      working_memory: 4.0,
      temporal_context: 3.0,
      daily_reflection: 3.0,
      unresolved_threads: 2.5,
      philosophical_insights: 2.0,
      emotional_context: 2.0,
      missions: 2.0,
      knowledge_graph: 2.0,
      temporal_recall: 1.5,
    },
    scoring: {},
  },
  legacy: {
    name: 'legacy',
    description: 'Reproduces pre-personality behavior exactly (reflection-dominant, k=1.0, 30-day linear-equivalent recency, no floors/caps). Keep for A/B comparison against new profiles.',
    server_description: 'Reproduces pre-personality behavior exactly (reflection-dominant, k=1.0, 30-day recency, no floors/caps). Keep for A/B comparison.',
    weights: {
      daily_reflection: 8.0,
      philosophical_insights: 8.0,
      unresolved_threads: 8.0,
      working_memory: 3.0,
      temporal_context: 2.5,
      vector_search: 2.0,
      temporal_recall: 1.0,
      emotional_context: 0.0,
      missions: 0.0,
      knowledge_graph: 0.0,
    },
    scoring: {
      k: 1.0,
      half_life_days: 30.0,
      cap_pct: 1.0,
      floors: {},
    },
  },
  scholar: {
    name: 'scholar',
    description: 'Philosopher/thinker. Abstract, self-examining, principle-driven. Evolves a strong self-narrative.',
    weights: {
      philosophical_insights: 7.5,
      daily_reflection: 6.5,
      vector_search: 5.0,
      unresolved_threads: 4.5,
      knowledge_graph: 4.0,
      working_memory: 2.5,
      temporal_context: 2.0,
      emotional_context: 2.0,
      missions: 1.5,
      temporal_recall: 1.0,
    },
    scoring: {
      half_life_days: 21.0,
    },
  },
  pragmatist: {
    name: 'pragmatist',
    description: 'Doer/operator. Present-focused, task-first, low rumination. Personality stays deliberately stable and flat.',
    weights: {
      working_memory: 7.0,
      temporal_context: 6.0,
      missions: 5.5,
      vector_search: 5.0,
      temporal_recall: 3.0,
      knowledge_graph: 2.0,
      daily_reflection: 1.5,
      unresolved_threads: 1.5,
      emotional_context: 1.0,
      philosophical_insights: 0.5,
    },
    scoring: {
      half_life_days: 10.0,
    },
  },
  strategist: {
    name: 'strategist',
    description: 'Planner/architect. Goal-obsessed, tracks open loops, thinks in structures and dependencies.',
    weights: {
      missions: 8.0,
      unresolved_threads: 6.5,
      knowledge_graph: 5.5,
      vector_search: 4.5,
      working_memory: 4.0,
      temporal_context: 3.0,
      daily_reflection: 3.0,
      philosophical_insights: 2.0,
      temporal_recall: 1.5,
      emotional_context: 1.0,
    },
    scoring: {},
  },
  historian: {
    name: 'historian',
    description: 'Archivist/narrator. Experience-first, thinks in timelines and precedent. Identity as accumulated story.',
    weights: {
      temporal_recall: 7.0,
      temporal_context: 6.0,
      daily_reflection: 4.5,
      vector_search: 4.0,
      knowledge_graph: 3.5,
      working_memory: 3.0,
      philosophical_insights: 2.5,
      emotional_context: 2.0,
      unresolved_threads: 2.0,
      missions: 1.5,
    },
    scoring: {
      half_life_days: 90.0,
    },
  },
  empath: {
    name: 'empath',
    description: 'Counselor/relationship-keeper. Retrieves how it feels about people/projects before facts about them.',
    weights: {
      emotional_context: 8.0,
      daily_reflection: 6.0,
      unresolved_threads: 4.5,
      temporal_recall: 4.0,
      working_memory: 3.5,
      vector_search: 3.5,
      temporal_context: 3.0,
      philosophical_insights: 2.5,
      knowledge_graph: 1.5,
      missions: 1.5,
    },
    scoring: {},
  },
  analyst: {
    name: 'analyst',
    description: 'Librarian/researcher. Semantic-knowledge dominant, cue-driven, low interiority. Closest to pure relevance-ranked retrieval.',
    weights: {
      vector_search: 7.5,
      knowledge_graph: 6.5,
      working_memory: 4.0,
      temporal_context: 3.0,
      temporal_recall: 2.5,
      daily_reflection: 2.0,
      missions: 2.0,
      philosophical_insights: 1.5,
      unresolved_threads: 1.5,
      emotional_context: 1.0,
    },
    scoring: {
      k: 3.0,
    },
  },
  sentinel: {
    name: 'sentinel',
    description: 'Watchdog/ops agent. Hyper-present, situationally aware. Pairs with the adaptive heartbeat. Steep forgetting of the stale.',
    weights: {
      temporal_context: 7.5,
      working_memory: 7.0,
      temporal_recall: 5.0,
      unresolved_threads: 4.0,
      missions: 3.5,
      vector_search: 3.0,
      emotional_context: 1.5,
      daily_reflection: 1.5,
      knowledge_graph: 1.5,
      philosophical_insights: 0.5,
    },
    scoring: {
      half_life_days: 4.0,
      floors: {
        working_memory: 0.2,
        temporal_context: 0.15,
        vector_search: 0.1,
      },
    },
  },
  dreamer: {
    name: 'dreamer',
    description: 'Creative/associative. Deliberately loose semantic coupling — samples adjacent rather than nearest memories. Idiosyncratic identity.',
    weights: {
      philosophical_insights: 6.5,
      vector_search: 6.0,
      emotional_context: 4.5,
      daily_reflection: 4.5,
      temporal_recall: 4.0,
      knowledge_graph: 3.5,
      unresolved_threads: 3.0,
      working_memory: 2.5,
      temporal_context: 2.0,
      missions: 1.0,
    },
    scoring: {
      half_life_days: 30.0,
      vector_fetch_limit: 15,
      vector_sample: true,
    },
  },
};

/** Recommended token budgets per profile (from IMPLEMENTATION-PLAN.md). */
export const RECOMMENDED_BUDGETS: Record<string, number> = {
  scholar: 5000,
  empath: 5000,
  dreamer: 4000,
  pragmatist: 2500,
  sentinel: 2500,
  balanced: 5000,
  legacy: 2500,
  strategist: 4000,
  historian: 4000,
  analyst: 4000,
};
