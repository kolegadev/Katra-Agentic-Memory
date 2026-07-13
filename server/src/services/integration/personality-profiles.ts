/**
 * Personality Profiles — server-side mirror of the bridge's personality.py registry.
 *
 * These profiles define memory-source retrieval weights that shape an agent's
 * long-term disposition. The dashboard reads this registry to populate the
 * personality selector and pre-fill the editable weight grid; the chosen
 * profile + overrides are persisted to system_settings and consumed by the
 * kolega-katra-bridge on each prompt.
 *
 * IMPORTANT: keep the numbers here in sync with
 * integrations/kolega-code/kolega_katra_bridge/personality.py. The bridge is
 * the authoritative runtime; this mirror is for display + validation only.
 */

// Inter-agent comms always rank first. Not overridable (enforced in the bridge).
export const AGENT_MESSAGE_WEIGHT = 10.0;

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

export type SourceName = (typeof ALL_SOURCES)[number];

export interface PersonalityProfile {
  name: string;
  description: string;
  weights: Record<string, number>;
  relevance_multiplier: number;
  recency_half_life_days: number;
  budget_floors: Record<string, number>;
  max_single_source_pct: number;
  vector_fetch_limit: number;
  vector_sample: boolean;
  min_fetch_weight: number;
}

const DEFAULT_FLOORS = { working_memory: 0.1, vector_search: 0.15 };

function profile(
  name: string,
  description: string,
  weights: Record<string, number>,
  overrides: Partial<PersonalityProfile> = {},
): PersonalityProfile {
  return {
    name,
    description,
    weights: { ...weights, agent_message: AGENT_MESSAGE_WEIGHT },
    relevance_multiplier: 2.0,
    recency_half_life_days: 14.0,
    budget_floors: { ...DEFAULT_FLOORS },
    max_single_source_pct: 0.4,
    vector_fetch_limit: 5,
    vector_sample: false,
    min_fetch_weight: 1.0,
    ...overrides,
  };
}

export const PROFILES: Record<string, PersonalityProfile> = {
  balanced: profile(
    'balanced',
    'Human-baseline retrieval: cue-driven relevance dominates, moderate interiority, moderate recency. The recommended default.',
    {
      vector_search: 5.0, working_memory: 4.0, temporal_context: 3.0,
      daily_reflection: 3.0, unresolved_threads: 2.5, philosophical_insights: 2.0,
      emotional_context: 2.0, missions: 2.0, knowledge_graph: 2.0, temporal_recall: 1.5,
    },
  ),
  legacy: profile(
    'legacy',
    'Reproduces pre-personality behavior exactly (reflection-dominant, k=1.0, 30-day recency, no floors/caps). Keep for A/B comparison.',
    {
      daily_reflection: 8.0, philosophical_insights: 8.0, unresolved_threads: 8.0,
      working_memory: 3.0, temporal_context: 2.5, vector_search: 2.0,
      temporal_recall: 1.0, emotional_context: 0.0, missions: 0.0, knowledge_graph: 0.0,
    },
    { relevance_multiplier: 1.0, recency_half_life_days: 30.0, budget_floors: {}, max_single_source_pct: 1.0 },
  ),
  scholar: profile(
    'scholar',
    'Philosopher/thinker. Abstract, self-examining, principle-driven. Evolves a strong self-narrative.',
    {
      philosophical_insights: 7.5, daily_reflection: 6.5, vector_search: 5.0,
      unresolved_threads: 4.5, knowledge_graph: 4.0, working_memory: 2.5,
      temporal_context: 2.0, emotional_context: 2.0, missions: 1.5, temporal_recall: 1.0,
    },
    { recency_half_life_days: 21.0 },
  ),
  pragmatist: profile(
    'pragmatist',
    'Doer/operator. Present-focused, task-first, low rumination. Personality stays deliberately stable and flat.',
    {
      working_memory: 7.0, temporal_context: 6.0, missions: 5.5, vector_search: 5.0,
      temporal_recall: 3.0, knowledge_graph: 2.0, daily_reflection: 1.5,
      unresolved_threads: 1.5, emotional_context: 1.0, philosophical_insights: 0.5,
    },
    { recency_half_life_days: 10.0 },
  ),
  strategist: profile(
    'strategist',
    'Planner/architect. Goal-obsessed, tracks open loops, thinks in structures and dependencies.',
    {
      missions: 8.0, unresolved_threads: 6.5, knowledge_graph: 5.5, vector_search: 4.5,
      working_memory: 4.0, temporal_context: 3.0, daily_reflection: 3.0,
      philosophical_insights: 2.0, temporal_recall: 1.5, emotional_context: 1.0,
    },
  ),
  historian: profile(
    'historian',
    'Archivist/narrator. Experience-first, thinks in timelines and precedent. Identity as accumulated story.',
    {
      temporal_recall: 7.0, temporal_context: 6.0, daily_reflection: 4.5, vector_search: 4.0,
      knowledge_graph: 3.5, working_memory: 3.0, philosophical_insights: 2.5,
      emotional_context: 2.0, unresolved_threads: 2.0, missions: 1.5,
    },
    { recency_half_life_days: 90.0 },
  ),
  empath: profile(
    'empath',
    'Counselor/relationship-keeper. Retrieves how it feels about people/projects before facts about them.',
    {
      emotional_context: 8.0, daily_reflection: 6.0, unresolved_threads: 4.5, temporal_recall: 4.0,
      working_memory: 3.5, vector_search: 3.5, temporal_context: 3.0,
      philosophical_insights: 2.5, knowledge_graph: 1.5, missions: 1.5,
    },
  ),
  analyst: profile(
    'analyst',
    'Librarian/researcher. Semantic-knowledge dominant, cue-driven, low interiority. Closest to pure relevance-ranked retrieval.',
    {
      vector_search: 7.5, knowledge_graph: 6.5, working_memory: 4.0, temporal_context: 3.0,
      temporal_recall: 2.5, daily_reflection: 2.0, missions: 2.0,
      philosophical_insights: 1.5, unresolved_threads: 1.5, emotional_context: 1.0,
    },
    { relevance_multiplier: 3.0 },
  ),
  sentinel: profile(
    'sentinel',
    'Watchdog/ops agent. Hyper-present, situationally aware. Pairs with the adaptive heartbeat. Steep forgetting of the stale.',
    {
      temporal_context: 7.5, working_memory: 7.0, temporal_recall: 5.0, unresolved_threads: 4.0,
      missions: 3.5, vector_search: 3.0, emotional_context: 1.5, daily_reflection: 1.5,
      knowledge_graph: 1.5, philosophical_insights: 0.5,
    },
    {
      recency_half_life_days: 4.0,
      budget_floors: { working_memory: 0.2, temporal_context: 0.15, vector_search: 0.1 },
    },
  ),
  dreamer: profile(
    'dreamer',
    'Creative/associative. Deliberately loose semantic coupling — samples adjacent rather than nearest memories. Idiosyncratic identity.',
    {
      philosophical_insights: 6.5, vector_search: 6.0, emotional_context: 4.5, daily_reflection: 4.5,
      temporal_recall: 4.0, knowledge_graph: 3.5, unresolved_threads: 3.0,
      working_memory: 2.5, temporal_context: 2.0, missions: 1.0,
    },
    { vector_fetch_limit: 15, vector_sample: true, recency_half_life_days: 30.0 },
  ),
};

export const PROFILE_NAMES = Object.keys(PROFILES);

/** Recommended token budgets per profile (from IMPLEMENTATION-PLAN.md). */
export const RECOMMENDED_BUDGETS: Record<string, number> = {
  scholar: 5000, empath: 5000, dreamer: 4000,
  pragmatist: 2500, sentinel: 2500,
  balanced: 5000, legacy: 2500, strategist: 4000, historian: 4000, analyst: 4000,
};
