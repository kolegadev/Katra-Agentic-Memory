/**
 * The bounded-inheritance policy vocabulary (ITER-8, Phase 6) — the ONE place
 * that says which configuration dimensions a mode or a spawned child may bias,
 * which are immutable hard invariants, and what the documented ranges are.
 *
 * It is a leaf module on purpose: both `cognitive-mode-service.ts` (the mode
 * catalogue declares which approved dimensions each mode may bias) and
 * `inheritance-envelope.ts` (the clamp/refuse path) import it, and neither has
 * to import the other.
 *
 * THE HARD INVARIANTS ARE NAMED, NOT IMPLIED (brief §8, "Hard invariants"):
 *
 *   - inter-agent messages stay the highest-priority retrieval and cannot be
 *     lowered by a profile, a mode or a learned delta  → `message_priority`
 *     (`agent_message` is the invariant weight, 10.0);
 *   - the working-memory / vector-search task floors cannot be removed by
 *     autonomous adaptation → `floors`;
 *   - the per-source cap BOUNDS cannot be widened → `cap_bounds`;
 *   - the privacy policy is immutable → `privacy_policy`.
 *
 * An attempt to reach any of them is refused BY NAME (`immutable_invariant`),
 * including through the aliases below — a caller renaming the dimension does not
 * change which invariant it is. A dimension that is simply not part of the
 * approved vocabulary is refused as `dimension_not_approved`, and a value that
 * cannot be honoured (not a finite number, or an attempt to WIDEN a per-source
 * cap above the parent's own bound) as `out_of_bounds`.
 */
import { IMMUTABLE_INVARIANTS, IMMUTABLE_INVARIANT_ALIASES, type ImmutableInvariant } from './inheritance-invariants.js';

export const APPROVED_DIMENSIONS = ['k', 'vector_fetch_limit', 'cap_pct'] as const;

export type ApprovedDimension = (typeof APPROVED_DIMENSIONS)[number];

/** The agent-message retrieval priority. Never settable, never lowerable. */
export const MESSAGE_PRIORITY = 10.0;

/** The privacy policy an envelope (and any child scope) carries. */
export const PRIVACY_POLICY = 'immutable';

/**
 * The approved-dimension MUTATION dimensions, and the invariants they are NOT
 * allowed to reach:
 *
 *   - `k` — the retrieval relevance multiplier. A mode may move it within ±25%
 *     of the PARENT's own value (`K_BAND_RATIO`), never further, and never to
 *     zero or below.
 *   - `vector_fetch_limit` — how many vector candidates are fetched. Documented
 *     integer range `VECTOR_FETCH_LIMIT_MIN..VECTOR_FETCH_LIMIT_MAX`.
 *   - `cap_pct` — the per-source share cap. A child may TIGHTEN it, within
 *     `CAP_PCT_MIN..min(1, parent's cap)`; widening it above the parent's own
 *     bound is refused (`out_of_bounds`) because that is the per-source cap
 *     invariant, not an approved dimension.
 */
export const K_BAND_RATIO = 0.25;
export const VECTOR_FETCH_LIMIT_MIN = 1;
export const VECTOR_FETCH_LIMIT_MAX = 20;
export const CAP_PCT_MIN = 0.05;
export const CAP_PCT_MAX = 1.0;

/** The parent's own values, which every range is measured against. */
export interface InheritanceBaseline {
  k: number;
  vector_fetch_limit: number;
  cap_pct: number;
}

export interface DimensionRange {
  min: number;
  max: number;
  /** True when the range is a band around the parent's own value. */
  relative: boolean;
}

/**
 * The documented range of one approved dimension, given the parent's baseline.
 * This is the single source of the numbers `applyBoundedMutation` clamps to and
 * the numbers the tests assert against.
 */
export function dimensionRange(dimension: ApprovedDimension, baseline: InheritanceBaseline): DimensionRange {
  switch (dimension) {
    case 'k': {
      const base = Number.isFinite(baseline.k) && baseline.k > 0 ? baseline.k : 0;
      return { min: round6(base * (1 - K_BAND_RATIO)), max: round6(base * (1 + K_BAND_RATIO)), relative: true };
    }
    case 'vector_fetch_limit':
      return { min: VECTOR_FETCH_LIMIT_MIN, max: VECTOR_FETCH_LIMIT_MAX, relative: false };
    case 'cap_pct': {
      const base = Number.isFinite(baseline.cap_pct) && baseline.cap_pct > 0 ? baseline.cap_pct : 0;
      return { min: CAP_PCT_MIN, max: round6(Math.min(CAP_PCT_MAX, base)), relative: false };
    }
  }
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/** How a requested dimension name is classified before any value is looked at. */
export type DimensionClass =
  | { kind: 'approved'; dimension: ApprovedDimension }
  | { kind: 'immutable'; invariant: ImmutableInvariant }
  | { kind: 'unapproved' };

export function classifyDimension(dimension: unknown): DimensionClass {
  const name = typeof dimension === 'string' ? dimension.trim() : '';
  if ((APPROVED_DIMENSIONS as readonly string[]).includes(name)) {
    return { kind: 'approved', dimension: name as ApprovedDimension };
  }
  // OWN properties only. The alias map is a plain object literal, so a
  // prototype key (`__proto__`, `constructor`, `toString`, …) is NOT an alias of
  // an invariant: an unguarded lookup returned the prototype (or the `Object`
  // constructor) for those names — truthy, and not a member of
  // `IMMUTABLE_INVARIANTS` — so the refusal named the invariant `undefined`.
  // A prototype key is simply not in the approved vocabulary, which is where it
  // belongs: refused as `dimension_not_approved` (still fail-closed, with the
  // right name).
  const alias = Object.prototype.hasOwnProperty.call(IMMUTABLE_INVARIANT_ALIASES, name)
    ? IMMUTABLE_INVARIANT_ALIASES[name]
    : undefined;
  if (alias && (IMMUTABLE_INVARIANTS as readonly string[]).includes(alias)) {
    return { kind: 'immutable', invariant: alias };
  }
  return { kind: 'unapproved' };
}

export type MutationRefusalCode = 'immutable_invariant' | 'dimension_not_approved' | 'out_of_bounds';

export interface MutationClamp {
  dimension: ApprovedDimension;
  requested: number;
  /** The value that will be applied after clamping to the documented range. */
  applied: number;
  clamped: boolean;
  min: number;
  max: number;
}

export type MutationOutcome = { ok: true; clamp: MutationClamp } | { ok: false; code: MutationRefusalCode; reason: string };

/**
 * Apply the documented clamp for one approved dimension — the arithmetic behind
 * `applyBoundedMutation`, exported so a test (or a verifier) can check the
 * clamp without going through the envelope.
 *
 * Clamping is the documented behaviour for an approved dimension: a request
 * outside the range is brought INSIDE it and the clamp is recorded. The one
 * exception is a request that would WIDEN the per-source cap above the parent's
 * own bound — clamping that DOWN would silently turn "loosen this cap" into
 * "tighten it", so it is refused by name instead.
 */
export function clampMutation(
  dimension: ApprovedDimension,
  requested: unknown,
  baseline: InheritanceBaseline,
): MutationOutcome {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return {
      ok: false,
      code: 'out_of_bounds',
      reason: `${dimension} must be a finite number (received ${describe(requested)})`,
    };
  }
  const range = dimensionRange(dimension, baseline);
  if (dimension === 'cap_pct' && requested > range.max) {
    return {
      ok: false,
      code: 'out_of_bounds',
      reason:
        `cap_pct ${requested} widens the per-source cap above the parent's own bound ${range.max}: ` +
        'the per-source cap BOUNDS are an immutable invariant (a child may tighten a cap, never widen it)',
    };
  }
  if (range.max <= 0) {
    return {
      ok: false,
      code: 'out_of_bounds',
      reason: `${dimension} has no usable range on this envelope (parent baseline ${describe(baseline)})`,
    };
  }
  let applied = Math.min(Math.max(requested, range.min), range.max);
  if (dimension === 'vector_fetch_limit') applied = Math.round(applied);
  applied = round6(applied);
  return {
    ok: true,
    clamp: { dimension, requested, applied, clamped: applied !== requested, min: range.min, max: range.max },
  };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `the string ${JSON.stringify(value.slice(0, 40))}`;
  return typeof value;
}
