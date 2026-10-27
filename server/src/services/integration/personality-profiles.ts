/**
 * Personality Profiles — server-side mirror of the bridge's personality.py registry.
 *
 * These profiles define memory-source retrieval weights that shape an agent's
 * long-term disposition. The dashboard reads this registry to populate the
 * personality selector and pre-fill the editable weight grid; the chosen
 * profile + overrides are persisted to system_settings and consumed by the
 * kolega-katra-bridge on each prompt.
 *
 * The values themselves are no longer hand-maintained here: they live in
 * `shared/personality/registry.json`, the single source of truth for both
 * runtimes, and reach this module through the generated artifact
 * `personality-profiles.generated.ts`. Editing either generated file by hand is
 * detected by `node scripts/generate-personality-registry.mjs --check` and by
 * tests/unit/personality-registry-parity.test.ts.
 */

import {
  AGENT_MESSAGE_WEIGHT,
  ALL_SOURCES,
  DEFAULT_SCORING,
  PROFILE_DATA,
  RECOMMENDED_BUDGETS,
  type ProfileData,
} from './personality-profiles.generated.js';

export { AGENT_MESSAGE_WEIGHT, ALL_SOURCES, RECOMMENDED_BUDGETS };

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

/** Budget floors every profile inherits unless it overrides them. */
export const DEFAULT_FLOORS: { working_memory: number; vector_search: number } = {
  ...DEFAULT_SCORING.floors,
};

/**
 * Materialise a profile from its registry entry: the registry's defaults, the
 * profile's own scoring overrides, and the agent-message invariant re-pinned
 * last so no entry — registry or caller — can weaken it.
 */
function fromRegistry(data: ProfileData): PersonalityProfile {
  const overrides = data.scoring;
  return {
    name: data.name,
    description: data.server_description ?? data.description,
    weights: { ...data.weights, agent_message: AGENT_MESSAGE_WEIGHT },
    relevance_multiplier: overrides.k ?? DEFAULT_SCORING.k,
    recency_half_life_days: overrides.half_life_days ?? DEFAULT_SCORING.half_life_days,
    budget_floors: { ...(overrides.floors ?? DEFAULT_SCORING.floors) },
    max_single_source_pct: overrides.cap_pct ?? DEFAULT_SCORING.cap_pct,
    vector_fetch_limit: overrides.vector_fetch_limit ?? DEFAULT_SCORING.vector_fetch_limit,
    vector_sample: overrides.vector_sample ?? DEFAULT_SCORING.vector_sample,
    min_fetch_weight: overrides.min_fetch_weight ?? DEFAULT_SCORING.min_fetch_weight,
  };
}

export const PROFILES: Record<string, PersonalityProfile> = Object.fromEntries(
  Object.entries(PROFILE_DATA).map(([name, data]) => [name, fromRegistry(data)]),
);

export const PROFILE_NAMES = Object.keys(PROFILES);

/**
 * Look up a profile the way the bridge does: case-insensitively, falling back
 * to `balanced` when the name is unknown or empty.
 */
export function profile(name: string): PersonalityProfile {
  const key = String(name ?? '').trim().toLowerCase();
  return PROFILES[key] ?? PROFILES.balanced;
}
