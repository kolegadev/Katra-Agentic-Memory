/**
 * The descriptor space — the CONFIGURABLE diversity bins (ITER-11, WS-2).
 *
 * The brief's §9 bullet 3 asks for seeds that "span configurable diversity
 * bins". Until this iteration the bin vocabulary was a closed five-dimension
 * constant (`DESCRIPTOR_BINS` in `idea-archive-service.ts`): the archive,
 * the baton compiler's coverage-gap re-validation and the coverage view all
 * read it, and there was no configuration surface for it.
 *
 * `IMAGINATION_BINS` is that surface. It is JSON in the environment (or a
 * documented value an operator writes into `.env`, or a file path they read):
 *
 *   # plain form — EXTEND/OVERRIDE the defaults
 *   IMAGINATION_BINS={"mechanism":["a","b"],"risk":["low","high"]}
 *     → mechanism's bins become [a, b]; the other four default dimensions keep
 *       their default bins; `risk` is APPENDED as a new dimension.
 *
 *   # structured form — replace the default dimensions entirely
 *   IMAGINATION_BINS={"dimensions":{"mechanism":["a","b"],"risk":["low","high"]},"replace":true}
 *
 * Fail-closed rules (the same discipline the flags use):
 *
 *  - UNSET (or empty/whitespace) ⇒ the default space, byte for byte. Nothing
 *    in the resolved object differs from the closed constants, so every stored
 *    cell key, coverage number and baton compiled before this iteration is
 *    still valid.
 *  - A HOSTILE config — non-JSON, not an object, a malformed/reserved dimension
 *    name, a name that would resolve through `Object.prototype`, non-string or
 *    empty bins, duplicate bins, huge arrays, a huge string, too many
 *    dimensions — is REFUSED BY NAME and the DEFAULTS STAY IN FORCE. A rejected
 *    config never narrows the space (which would strand stored cells) and never
 *    widens it (which would let an operator inject a marker into the shared
 *    coverage view by misconfiguring a bin name).
 *  - A dimension OUTSIDE the resolved space is never silently folded in: a
 *    stored cell whose `cell_key` names one is COUNTED and left out of the
 *    occupancy maps (`IdeaArchiveService.coverage`), and the baton compiler's
 *    `validateCoverageGaps` drops it as `dropped_unknown_dimension` — the two
 *    behaviours a verifier can attack with a config change.
 *
 * The resolved space is CACHED per raw environment string, so a test (or an
 * operator) that changes the variable gets a freshly parsed space without a
 * process restart, and a caller that does not gets the same object.
 */

/** The environment variable that configures the space. */
export const IMAGINATION_BINS_ENV = 'IMAGINATION_BINS';

/** The five dimensions the closed default space defines, in order. */
export const DEFAULT_DESCRIPTOR_DIMENSIONS = [
  'mechanism',
  'representation',
  'violated_assumption',
  'evidence_family',
  'test_strategy',
] as const;

/**
 * The closed bin vocabulary per default dimension. `unclassified` is always
 * available (and is the fallback for anything the model did not choose from the
 * list): an unclassified seed is still archived, in a cell of its own, and
 * counted in the coverage view's occupancy denominator.
 */
export const DEFAULT_DESCRIPTOR_BINS: Record<string, readonly string[]> = Object.freeze({
  mechanism: Object.freeze(['removal', 'substitution', 'reversal', 'amplification', 'relocation', 'composition']),
  representation: Object.freeze(['prose', 'list', 'table', 'graph', 'numeric', 'protocol']),
  violated_assumption: Object.freeze(['necessity', 'sufficiency', 'independence', 'stability', 'scarcity', 'identity']),
  evidence_family: Object.freeze([
    'operational_state',
    'epistemic_ledger',
    'work_queue',
    'temporal_series',
    'external_observation',
    'trace_absence',
  ]),
  test_strategy: Object.freeze(['cheapest_probe', 'ab_test', 'simulation', 'instrumentation', 'observation_study', 'kill_criterion']),
});

/** Why a configuration was refused (by name, never silently). */
export type DescriptorSpaceRefusalCode =
  | 'too_large'
  | 'not_json'
  | 'not_object'
  | 'invalid_dimensions'
  | 'invalid_replace'
  | 'invalid_dimension'
  | 'reserved_dimension'
  | 'prototype_dimension'
  | 'invalid_bins'
  | 'empty_bins'
  | 'too_many_bins'
  | 'invalid_bin'
  | 'duplicate_bin'
  | 'reserved_bin'
  | 'prototype_bin'
  | 'too_many_dimensions';

export interface DescriptorSpaceRefusal {
  code: DescriptorSpaceRefusalCode;
  reason: string;
}

export interface DescriptorSpace {
  /** The dimensions of the ACTIVE space, in cell-key order. */
  dimensions: readonly string[];
  /** The active bin vocabulary per dimension (never includes `unclassified`). */
  bins: Record<string, readonly string[]>;
  /** `defaults` when the variable is unset/empty or refused; `env` otherwise. */
  source: 'defaults' | 'env';
  /** True only for the structured form with `replace: true`. */
  replaced: boolean;
  /** True when the variable carried any non-whitespace value. */
  env_present: boolean;
  /** The refusal, when a present configuration was rejected (defaults in force). */
  refused: DescriptorSpaceRefusal | null;
}

/** A bin value: a lowercase slug, and never the reserved fallback. */
const BIN_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** A dimension name: the same shape, so a cell key is always parseable. */
const DIMENSION_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Bounds: a config beyond these is refused, not truncated. */
export const MAX_BINS_CONFIG_CHARS = 8192;
export const MAX_DESCRIPTOR_DIMENSIONS = 16;
export const MAX_BINS_PER_DIMENSION = 64;

/** Reserved words: the fallback bin and the structured form's own keys. */
export const RESERVED_DIMENSION_NAMES: readonly string[] = ['unclassified', 'dimensions', 'replace'];

/**
 * The names `Object.prototype` ITSELF defines — derived from the object, never
 * hand-maintained, so the list cannot go stale.
 *
 * A dimension or bin named one of these is refused BY NAME because a name that
 * resolves through the prototype is not a name in the SPACE: `{"constructor":[…]}` would put
 * `Function.prototype` (via `Object.prototype.constructor`) where the space's
 * bins live — `space.bins[name]` then reads a function, `possibleCellCount()`
 * counts `Function.length` — and a coverage gap whose dimension is `constructor`
 * makes the compiler's `vocabularyOf[dimension]` return a function, whose
 * `.includes` does not exist, so re-validation throws instead of dropping the
 * gap. `__proto__` is the same hazard through the assignment path
 * (`bins[name] = …` would set the prototype rather than a key). A slug-shaped
 * name can only collide for `constructor` (every other prototype key fails the
 * lowercase-slug pattern), but the check is written against the prototype
 * itself so it stays correct if the pattern ever changes.
 */
export const PROTOTYPE_KEY_NAMES: readonly string[] = Object.freeze(
  Object.getOwnPropertyNames(Object.prototype),
);

/** Does this name resolve through `Object.prototype` rather than the space? */
export function isPrototypeKeyName(name: string): boolean {
  return PROTOTYPE_KEY_NAMES.includes(name);
}

/** The always-available fallback bin (never configurable). */
export const UNCLASSIFIED_BIN_NAME = 'unclassified';

function defaultSpace(envPresent: boolean, refused: DescriptorSpaceRefusal | null): DescriptorSpace {
  return {
    dimensions: [...DEFAULT_DESCRIPTOR_DIMENSIONS],
    bins: { ...DEFAULT_DESCRIPTOR_BINS },
    source: 'defaults',
    replaced: false,
    env_present: envPresent,
    refused,
  };
}

function refuse(code: DescriptorSpaceRefusalCode, reason: string, envPresent = true): DescriptorSpace {
  return defaultSpace(envPresent, { code, reason });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one dimension's bin list. Returns the refusal code, or null. */
function validateBins(dimension: string, value: unknown): DescriptorSpaceRefusal | null {
  if (!Array.isArray(value)) {
    return { code: 'invalid_bins', reason: `dimension '${dimension}': bins must be an array of strings` };
  }
  if (value.length === 0) {
    return { code: 'empty_bins', reason: `dimension '${dimension}': the bin list is empty (a dimension needs at least one bin)` };
  }
  if (value.length > MAX_BINS_PER_DIMENSION) {
    return {
      code: 'too_many_bins',
      reason: `dimension '${dimension}': ${value.length} bins exceeds the ${MAX_BINS_PER_DIMENSION} bin limit`,
    };
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { code: 'invalid_bin', reason: `dimension '${dimension}': bin ${JSON.stringify(entry)} is not a string` };
    }
    // Checked BEFORE the pattern: the hazard is the prototype, and the refusal
    // has to say so rather than blame the shape of the name.
    if (isPrototypeKeyName(entry)) {
      return {
        code: 'prototype_bin',
        reason:
          `dimension '${dimension}': bin '${entry}' is a key of Object.prototype — a bin that resolves through ` +
          'the prototype is not a bin of the space',
      };
    }
    if (!BIN_PATTERN.test(entry)) {
      return {
        code: 'invalid_bin',
        reason: `dimension '${dimension}': bin '${entry}' is not a lowercase slug (${BIN_PATTERN})`,
      };
    }
    if (entry === UNCLASSIFIED_BIN_NAME) {
      return {
        code: 'reserved_bin',
        reason: `dimension '${dimension}': '${UNCLASSIFIED_BIN_NAME}' is the reserved fallback bin and cannot be configured`,
      };
    }
    if (seen.has(entry)) {
      return { code: 'duplicate_bin', reason: `dimension '${dimension}': bin '${entry}' is listed twice` };
    }
    seen.add(entry);
  }
  return null;
}

/** Validate one dimension name. Returns the refusal code, or null. */
function validateDimensionName(name: unknown): DescriptorSpaceRefusal | null {
  // The prototype check comes FIRST, so a name that would resolve through
  // `Object.prototype` is refused for THAT reason by name — and so that a
  // non-slug prototype key (`toString`, `__proto__`) is reported as the hazard
  // it is rather than as a shape problem.
  if (typeof name === 'string' && isPrototypeKeyName(name)) {
    return {
      code: 'prototype_dimension',
      reason:
        `dimension name '${name}' is a key of Object.prototype — a dimension that resolves through the ` +
        'prototype is not a dimension of the space (a lookup for it would read the prototype, not the space)',
    };
  }
  if (typeof name !== 'string' || !DIMENSION_PATTERN.test(name)) {
    return {
      code: 'invalid_dimension',
      reason: `dimension name ${JSON.stringify(name)} is not a lowercase slug (${DIMENSION_PATTERN})`,
    };
  }
  if (RESERVED_DIMENSION_NAMES.includes(name)) {
    return { code: 'reserved_dimension', reason: `dimension name '${name}' is reserved` };
  }
  return null;
}

/**
 * Parse an `IMAGINATION_BINS` value into the space it configures. Pure and
 * total: every input yields a space (the defaults, plus the refusal when one
 * was found). The caller never sees a throw.
 */
export function parseDescriptorSpace(raw: string | null | undefined): DescriptorSpace {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return defaultSpace(false, null);
  if (text.length > MAX_BINS_CONFIG_CHARS) {
    return refuse(
      'too_large',
      `${IMAGINATION_BINS_ENV} is ${text.length} characters — the limit is ${MAX_BINS_CONFIG_CHARS}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return refuse('not_json', `${IMAGINATION_BINS_ENV} is not valid JSON: ${String((error as Error)?.message ?? error)}`);
  }
  if (!isPlainObject(parsed)) {
    return refuse('not_object', `${IMAGINATION_BINS_ENV} must be a JSON object mapping dimension → bins`);
  }

  // The structured form is recognised by its own keys, so a deployment cannot
  // accidentally spell a dimension `dimensions` or `replace`.
  const structured = Object.prototype.hasOwnProperty.call(parsed, 'dimensions') ||
    Object.prototype.hasOwnProperty.call(parsed, 'replace');
  let requested: Record<string, unknown> = parsed;
  let replace = false;
  if (structured) {
    if (Object.prototype.hasOwnProperty.call(parsed, 'replace')) {
      const raw = parsed.replace;
      // Only a literal true (or the string 'true') replaces: a truthy-but-wrong
      // value is refused rather than interpreted, because "replace" is the one
      // switch that can strand every stored cell.
      if (raw === true || raw === 'true') replace = true;
      else if (raw === false || raw === 'false' || raw === undefined) replace = false;
      else return refuse('invalid_replace', `${IMAGINATION_BINS_ENV}: "replace" must be true or false, got ${JSON.stringify(raw)}`);
    }
    const dimensions = parsed.dimensions;
    if (dimensions === undefined) {
      return refuse('invalid_dimensions', `${IMAGINATION_BINS_ENV}: the structured form needs a "dimensions" object`);
    }
    if (!isPlainObject(dimensions)) {
      return refuse('invalid_dimensions', `${IMAGINATION_BINS_ENV}: "dimensions" must be an object mapping dimension → bins`);
    }
    requested = dimensions;
  }

  const names = Object.keys(requested);
  if (names.length === 0) {
    return refuse('invalid_dimensions', `${IMAGINATION_BINS_ENV} configures no dimensions`);
  }

  const configured: Array<{ name: string; bins: string[] }> = [];
  for (const name of names) {
    const nameRefusal = validateDimensionName(name);
    if (nameRefusal) return refuse(nameRefusal.code, nameRefusal.reason);
    const bins = requested[name];
    const binsRefusal = validateBins(name, bins);
    if (binsRefusal) return refuse(binsRefusal.code, binsRefusal.reason);
    configured.push({ name, bins: (bins as string[]).slice() });
  }

  if (replace) {
    if (configured.length > MAX_DESCRIPTOR_DIMENSIONS) {
      return refuse(
        'too_many_dimensions',
        `${configured.length} dimensions exceed the ${MAX_DESCRIPTOR_DIMENSIONS} dimension limit`,
      );
    }
    const bins: Record<string, readonly string[]> = {};
    for (const entry of configured) bins[entry.name] = Object.freeze(entry.bins);
    return {
      dimensions: configured.map((entry) => entry.name),
      bins,
      source: 'env',
      replaced: true,
      env_present: true,
      refused: null,
    };
  }

  // Extend/override: the defaults stay, in their order; a configured default
  // dimension has its bin list REPLACED; a new dimension is appended in the
  // config's own order.
  const dimensions: string[] = [...DEFAULT_DESCRIPTOR_DIMENSIONS];
  const bins: Record<string, readonly string[]> = { ...DEFAULT_DESCRIPTOR_BINS };
  for (const entry of configured) {
    bins[entry.name] = Object.freeze(entry.bins);
    if (!dimensions.includes(entry.name)) dimensions.push(entry.name);
  }
  if (dimensions.length > MAX_DESCRIPTOR_DIMENSIONS) {
    return refuse(
      'too_many_dimensions',
      `${dimensions.length} dimensions (defaults + configured) exceed the ${MAX_DESCRIPTOR_DIMENSIONS} dimension limit`,
    );
  }
  return { dimensions, bins, source: 'env', replaced: false, env_present: true, refused: null };
}

/** Cache key → space. Keyed by the RAW value, so a changed env re-parses. */
const cache = new Map<string, DescriptorSpace>();

/**
 * The ACTIVE descriptor space for this process: the configured space when
 * `IMAGINATION_BINS` parses, the defaults otherwise. Cached per raw value.
 */
export function descriptorSpace(raw: string | null | undefined = process.env[IMAGINATION_BINS_ENV]): DescriptorSpace {
  const key = typeof raw === 'string' ? raw : '';
  const cached = cache.get(key);
  if (cached) return cached;
  const space = parseDescriptorSpace(key);
  // Bounded: only the handful of distinct values a process sees are kept.
  if (cache.size > 32) cache.clear();
  cache.set(key, space);
  return space;
}

/**
 * The report the surfaces show about the configuration: which space is in
 * force, where it came from, and — when one was refused — the refusal by name.
 * A refused configuration is never silent.
 */
export interface DescriptorSpaceReport {
  source: 'defaults' | 'env';
  env_var: string;
  env_present: boolean;
  replaced: boolean;
  dimensions: string[];
  bins_per_dimension: Record<string, number>;
  possible_cells: number;
  refused: DescriptorSpaceRefusal | null;
  basis: string;
}

export function descriptorSpaceReport(
  raw: string | null | undefined = process.env[IMAGINATION_BINS_ENV],
): DescriptorSpaceReport {
  const space = descriptorSpace(raw);
  return {
    source: space.source,
    env_var: IMAGINATION_BINS_ENV,
    env_present: space.env_present,
    replaced: space.replaced,
    dimensions: [...space.dimensions],
    bins_per_dimension: Object.fromEntries(space.dimensions.map((d) => [d, space.bins[d]?.length ?? 0])),
    possible_cells: space.dimensions.reduce((product, d) => product * ((space.bins[d]?.length ?? 0) + 1), 1),
    refused: space.refused,
    basis:
      space.refused
        ? `${IMAGINATION_BINS_ENV} was present but REFUSED (${space.refused.code}) — the closed defaults are in force`
        : space.source === 'env'
          ? `${IMAGINATION_BINS_ENV} parsed: ${space.replaced ? 'replacing' : 'extending/overriding'} the closed defaults`
          : `${IMAGINATION_BINS_ENV} is unset — the closed default space is in force`,
  };
}
