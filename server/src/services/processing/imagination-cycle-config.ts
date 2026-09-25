/**
 * ITER-7 knobs, in ONE place (Phase 5: Creative Baton, plateau triggers,
 * controller adapter, resume).
 *
 * Every threshold the plateau evaluation compares against, every budget the
 * cycle enforces and every bound the compiler applies is read from the
 * environment here and nowhere else, so "which number decided this" has a
 * single answer. The defaults are the documented values a default deployment
 * runs with; a value that is missing, non-numeric or not positive falls back to
 * its default (a knob can never switch a rule off — the same rule ITER-6
 * applies to its budget caps).
 *
 * The two flags are NOT defined here: `FOCUSED_IMAGINATION` lives where ITER-5
 * defined it (`focused-consolidation-service.ts`, re-exported by every tool
 * module) and `CREATIVE_BATON_PROMOTION` lives next to the compiler that is the
 * only thing allowed to write a shared baton (`creative-baton-compiler.ts`).
 * Both fail closed: a value that is not `1|true|yes` (case-insensitive) is off.
 */

/** How long after a cycle the same mission may not start another one. */
export const DEFAULT_CYCLE_COOLDOWN_MS = 15 * 60 * 1000;
/** The budget window the per-mission cycle/token caps are counted over. */
export const DEFAULT_CYCLE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Cycles per mission per window. */
export const DEFAULT_MAX_CYCLES_PER_WINDOW = 3;
/** Measured tokens per mission per window (ITER-5 + ITER-6 calls together). */
export const DEFAULT_MAX_TOKENS_PER_WINDOW = 20_000;
/** Below this many admitted candidates a mission counts as under-inventoried. */
export const DEFAULT_PLATEAU_MIN_CANDIDATES = 3;
/** Novelty gain below this over `NOVELTY_ROUNDS` rounds is a plateau. */
export const DEFAULT_PLATEAU_NOVELTY_EPSILON = 0.05;
/** The N of "novelty gain below ε over N rounds". */
export const DEFAULT_PLATEAU_NOVELTY_ROUNDS = 2;
/** Below this many archive cells the descriptor space is under-explored. */
export const DEFAULT_PLATEAU_COVERAGE_FLOOR = 6;
/** At or above this many live contradictions the mission is under pressure. */
export const DEFAULT_PLATEAU_CONTRADICTION_THRESHOLD = 2;
/** At or above this many cells the coverage target counts as reached. */
export const DEFAULT_COVERAGE_TARGET = 12;
/** A candidate must clear this on novelty AND coherence to be eligible. */
export const DEFAULT_CANDIDATE_FLOOR = 0.35;
/** A promoted candidate at or above this quality counts as high-value. */
export const DEFAULT_PROMOTION_MIN_QUALITY = 0.6;
/** How many candidates a compiled baton may carry. */
export const DEFAULT_MAX_BATON_CANDIDATES = 8;
/** How many attention cues a compiled baton may carry. */
export const DEFAULT_MAX_ATTENTION_TARGETS = 6;
/** How many excluded-region fingerprints a compiled baton may carry. */
export const DEFAULT_MAX_EXCLUDED_REGIONS = 12;

/**
 * The five plateau conditions of the brief's §4.1, in the order
 * `evaluatePlateau` reports them. `plateau` is true when ANY of them is met —
 * the brief lists alternatives, and each condition carries the evidence that
 * decided it, so a reader can see that the other four did not fire.
 */
export const PLATEAU_CONDITIONS = [
  'below_minimum_active_candidates',
  'novelty_gain_below_epsilon',
  'repeated_failure_signature',
  'archive_coverage_below_floor',
  'contradiction_pressure_above_threshold',
] as const;

export type PlateauConditionName = (typeof PLATEAU_CONDITIONS)[number];

/**
 * The stop conditions of the brief's §8, in PRECEDENCE order: the first one
 * that is met is the cycle's `stop_reason` (every condition is still reported
 * with whether it was met, so a lower-precedence one that also fired is
 * visible). `completed` is the absence of a stop condition, recorded as such —
 * never as "nothing happened".
 */
export const STOP_CONDITIONS = [
  'privacy_validation_failed',
  'mission_cancelled_or_superseded',
  'upstream_failure',
  'no_candidate_above_floor',
  'budget_exhausted',
  'coverage_target_reached',
  'no_new_cells_two_rounds',
  'promoted_inventory_restored',
  'completed',
] as const;

export type StopConditionName = (typeof STOP_CONDITIONS)[number];

function positiveInt(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function positiveFloat(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function cycleCooldownMs(): number {
  return positiveInt(process.env.IMAGINATION_CYCLE_COOLDOWN_MS, DEFAULT_CYCLE_COOLDOWN_MS);
}

export function cycleBudgetWindowMs(): number {
  return positiveInt(process.env.IMAGINATION_CYCLE_WINDOW_MS, DEFAULT_CYCLE_WINDOW_MS);
}

export function maxCyclesPerWindow(): number {
  return positiveInt(process.env.IMAGINATION_CYCLE_MAX_PER_WINDOW, DEFAULT_MAX_CYCLES_PER_WINDOW);
}

export function maxTokensPerWindow(): number {
  return positiveInt(process.env.IMAGINATION_CYCLE_MAX_TOKENS_PER_WINDOW, DEFAULT_MAX_TOKENS_PER_WINDOW);
}

export function plateauMinCandidates(): number {
  return positiveInt(process.env.IMAGINATION_PLATEAU_MIN_CANDIDATES, DEFAULT_PLATEAU_MIN_CANDIDATES);
}

export function plateauNoveltyEpsilon(): number {
  return positiveFloat(process.env.IMAGINATION_PLATEAU_NOVELTY_EPSILON, DEFAULT_PLATEAU_NOVELTY_EPSILON);
}

export function plateauNoveltyRounds(): number {
  return positiveInt(process.env.IMAGINATION_PLATEAU_NOVELTY_ROUNDS, DEFAULT_PLATEAU_NOVELTY_ROUNDS);
}

export function plateauCoverageFloor(): number {
  return positiveInt(process.env.IMAGINATION_PLATEAU_COVERAGE_FLOOR, DEFAULT_PLATEAU_COVERAGE_FLOOR);
}

export function plateauContradictionThreshold(): number {
  return positiveInt(process.env.IMAGINATION_PLATEAU_CONTRADICTION_THRESHOLD, DEFAULT_PLATEAU_CONTRADICTION_THRESHOLD);
}

export function coverageTarget(): number {
  return positiveInt(process.env.IMAGINATION_COVERAGE_TARGET, DEFAULT_COVERAGE_TARGET);
}

export function candidateFloor(): number {
  return positiveFloat(process.env.IMAGINATION_CANDIDATE_FLOOR, DEFAULT_CANDIDATE_FLOOR);
}

export function promotionMinQuality(): number {
  return positiveFloat(process.env.IMAGINATION_PROMOTION_MIN_QUALITY, DEFAULT_PROMOTION_MIN_QUALITY);
}

export function maxBatonCandidates(): number {
  return positiveInt(process.env.IMAGINATION_MAX_BATON_CANDIDATES, DEFAULT_MAX_BATON_CANDIDATES);
}

export function maxAttentionTargets(): number {
  return positiveInt(process.env.IMAGINATION_MAX_ATTENTION_TARGETS, DEFAULT_MAX_ATTENTION_TARGETS);
}

export function maxExcludedRegions(): number {
  return positiveInt(process.env.IMAGINATION_MAX_EXCLUDED_REGIONS, DEFAULT_MAX_EXCLUDED_REGIONS);
}
