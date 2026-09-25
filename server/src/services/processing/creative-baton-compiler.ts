/**
 * Creative Baton compiler (ITER-7, Phase 5).
 *
 * Contract: CONTRACT-iter7-creative-baton.md §B. This module turns ONE cycle's
 * private material — the Salience Trace, the admitted idea seeds, the mission's
 * exclusion list and the archive's coverage view — into the brief's §4.3
 * artifact: a versioned, SANITISED context packet a controller can pick
 * candidates up from.
 *
 * THE ALLOW-LIST IS THE WHOLE POINT. The baton is CONSTRUCTED field by field;
 * nothing is copied wholesale and nothing is spread. The fields the brief marks
 * private have no place in the shape at all:
 *
 *   - trace statements and the trace's own `why_operationally_relevant` are NOT
 *     copied. `attention_targets` is derived from what a signal IS (its kind,
 *     its calibration numbers, the operator families that kind drives) — never
 *     from its text;
 *   - a seed's `evidence_refs`, `changed_premise`, `bridge_path`/`bridge` and
 *     `parent_seed_ids` are dropped;
 *   - `excluded_regions[].pattern` is a FINGERPRINT (kind + ordinal + sha256 of
 *     the ruled-out text) — the text itself never enters the baton;
 *   - `descriptor_bins`, the scores and the derived ids (`seed_id`,
 *     `lineage_ref`) are copied because they are the compiled material and are
 *     themselves derived values.
 *
 * Two structural guarantees back the allow-list up, and they are separate on
 * purpose:
 *
 *   1. every compiled baton is validated against `creative-baton.schema.json`
 *      (registered in the mission-cognition registry, SCHEMA_IDS.creativeBaton)
 *      and secret-scanned with the same `assertNoSecretMaterial` semantics the
 *      mission's own batons use — BEFORE it is written, so an invalid or
 *      secret-bearing packet never reaches the collection;
 *   2. `payload_hash` is written over the canonical sanitised payload, so the
 *      promoter can prove at promote time that the stored document is the one
 *      the compiler built (see `batonPayloadForHash`).
 *
 * THE COMPILER NEVER PROMOTES. `compileCreativeBaton` returns a packet with
 * `privacy.shared: false` and no `shared_id`; the only code that stamps a shared
 * scope is `promoteCreativeBaton` in `creative-baton-promotion.ts`, which is
 * gated on `CREATIVE_BATON_PROMOTION` (and on `FOCUSED_IMAGINATION`) and
 * requires a trusted caller.
 *
 * DETERMINISM: `baton_id` is DERIVED from the mission, the cycle, the portfolio
 * and the problem-state digest — never a random identifier — so re-compiling
 * the same cycle over the same material produces the same baton id; nothing
 * here reads `Math.random` or generates a uuid.
 */
import type { Db } from 'mongodb';
import { resolveWriteScope, stripSharedId } from '../memory/write-scope-policy.js';
import { SCHEMA_IDS, validateAgainst } from '../mission-cognition/schema-registry.js';
import { assertNoSecretMaterial } from '../mission-cognition/baton-service.js';
import { CREATIVE_BATON_COLLECTIONS, CREATIVE_BATON_KIND, ensureCreativeBatonIndexes } from './creative-baton-collections.js';
import {
  candidateFloor,
  maxAttentionTargets,
  maxBatonCandidates,
  maxExcludedRegions,
  plateauMinCandidates,
} from './imagination-cycle-config.js';
import { OPERATOR_TRACE_MAP, derivedId, hashSeed, sha256Hex, stableStringify } from './imagination-operators.js';
import {
  DESCRIPTOR_BINS,
  type CoverageView,
  type ExclusionRegion,
  type IdeaSeed,
} from './idea-archive-service.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';

// ── Flag ────────────────────────────────────────────────────────────────────

/**
 * CREATIVE_BATON_PROMOTION — default OFF, truthy `1|true|yes` (case-insensitive)
 * exactly like every other flag in this repo, and it FAILS CLOSED.
 *
 * It gates promotion only, and promotion is additionally gated on
 * FOCUSED_IMAGINATION: with either flag off, `promote_creative_baton` is not
 * registered, the dispatch re-check throws the plain `Unknown tool` error and no
 * shared scope is ever written. A deployment may therefore run the whole cycle
 * privately and never share a baton.
 */
export function creativeBatonPromotionEnabled(): boolean {
  const value = (process.env.CREATIVE_BATON_PROMOTION ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}



// ── Shape (the brief's §4.3) ────────────────────────────────────────────────

export const CREATIVE_BATON_VERSION = '1.0';

export interface CreativeBatonCandidate {
  seed_id: string;
  hypothesis: string;
  mechanism: string;
  descriptor_bins: string[];
  novelty_score: number;
  coherence_score: number;
  cheapest_test: string;
  expected_information_gain: number;
  lineage_ref: string;
  privacy_safe: true;
}

export interface CreativeBatonAttentionTarget {
  cue: string;
  why_operationally_relevant: string;
  operator_families: string[];
}

export interface CreativeBatonExcludedRegion {
  pattern: string;
  reason: string;
  unless: string;
}

export interface CreativeBatonCoverageSummary {
  cells_total: number;
  new_cells_this_cycle: number;
  occupancy_ratio: number;
  /** Every bound the coverage view was read through, and whether one bit. */
  scan: {
    cells_limit: number;
    cells_scanned: number;
    cells_truncated: boolean;
    seeds_dedupe_limit: number;
    seeds_scanned: number;
    seeds_truncated: boolean;
    truncated: boolean;
  };
}

export interface CreativeBaton {
  schema_version: '1.0';
  creative_baton_version: '1.0';
  baton_id: string;
  user_id: string;
  mission_id: string;
  mission_version: number;
  cycle_id: string;
  trigger: { type: string; evidence: string[] };
  problem_state_digest: string;
  excluded_regions: CreativeBatonExcludedRegion[];
  attention_targets: CreativeBatonAttentionTarget[];
  candidate_portfolio: CreativeBatonCandidate[];
  coverage_gaps: Array<{ dimension: string; unoccupied_bins: string[] }>;
  coverage_summary: CreativeBatonCoverageSummary;
  next_round_budget: { candidates: number; tests: number };
  counts: {
    candidates_considered: number;
    candidates_eligible: number;
    /** Candidates dropped because their ids were not derived-id-shaped. */
    candidates_dropped_unshaped_ids: number;
    excluded_regions: number;
    attention_targets: number;
    /** Coverage gaps the view offered, and what the vocabulary check dropped. */
    coverage_gaps_considered: number;
    coverage_gaps_dropped_unknown_dimension: number;
    coverage_bins_dropped_unknown: number;
  };
  privacy: { raw_reflections_included: false; shared: boolean };
  payload_hash: string;
  stop_reason: string | null;
  created_at: string;
  /** Stamped by the gated promoter only — never by the compiler. */
  shared_id?: string;
  promotion_id?: string;
  promoted_at?: string;
  promoted_by?: string;
}

/** The trace material the compiler is allowed to look at (shape, not text). */
export interface CreativeBatonTraceInput {
  trace_id: string;
  cycle_id?: string;
  mission_version: number;
  problem_state_digest: string;
  signals: ReadonlyArray<{
    kind: string;
    intensity: number;
    confidence: number;
    valence: number;
    low_confidence?: boolean;
  }>;
}

export interface CreativeBatonCompileInput {
  userId: string;
  missionId: string;
  cycleId: string;
  trace: CreativeBatonTraceInput;
  /** The cycle's stored seeds — admitted ones become the portfolio. */
  seeds: readonly IdeaSeed[];
  exclusions: readonly ExclusionRegion[];
  coverage: CoverageView;
  trigger: { type: string; evidence: string[] };
  stopReason?: string | null;
  now?: () => string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function creativeBatonPayloadSchemaId(): string {
  return SCHEMA_IDS.creativeBaton;
}

/**
 * The shape of a DERIVED id in this feature: `<kind>_<16..64 lowercase hex>`
 * (`derivedId` produces `<kind>_<32 hex>`). Anything else is not an id this
 * repo writes, and the compiler will not carry it into a baton.
 */
export const DERIVED_ID_PATTERN = /^[a-z][a-z0-9]*_[0-9a-f]{16,64}$/;

/**
 * A candidate is ELIGIBLE when it is not rejected and it clears the floor on
 * novelty AND coherence (`candidateFloor()`, the same number the cycle's
 * `no_candidate_above_floor` stop condition uses). The floor is one knob in
 * `imagination-cycle-config.ts`, so the compiler and the stop condition can
 * never disagree about what "above the floor" means.
 */
export function isEligibleCandidate(seed: IdeaSeed, floor: number = candidateFloor()): boolean {
  return (
    seed.state !== 'rejected' &&
    Number(seed.novelty_score) >= floor &&
    Number(seed.coherence_score) >= floor
  );
}

/** Deterministic portfolio order: quality, then testability, then seed id. */
export function rankCandidates(seeds: readonly IdeaSeed[]): IdeaSeed[] {
  return [...seeds].sort(
    (a, b) =>
      Number(b.quality) - Number(a.quality) ||
      Number(b.testability_score) - Number(a.testability_score) ||
      String(a.seed_id).localeCompare(String(b.seed_id)),
  );
}

// ── Canonical payload + hash ────────────────────────────────────────────────

/**
 * The canonical SANITISED payload a baton's `payload_hash` is computed over:
 * the stored document with the promotion stamps removed (so a promoted baton
 * hashes to the same value it had before promotion) and with `privacy.shared`
 * normalised to `false` (that flag is a statement about the scope, not part of
 * the compiled content). Everything else is taken as stored — which is exactly
 * what makes a tampered half of the document change the hash.
 */
export function batonPayloadForHash(baton: Record<string, unknown>): Record<string, unknown> {
  const {
    payload_hash: _payloadHash,
    shared_id: _sharedId,
    promotion_id: _promotionId,
    promoted_at: _promotedAt,
    promoted_by: _promotedBy,
    ...rest
  } = baton;
  const privacy = (rest.privacy ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    privacy: { ...privacy, shared: false },
  };
}

export function creativeBatonPayloadHash(baton: Record<string, unknown>): string {
  return `sha256:${sha256Hex(stableStringify(batonPayloadForHash(baton)))}`;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface CreativeBatonValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a candidate or stored baton: the registered JSON schema, then the
 * secret-shape scan. Both are needed — the schema says the packet is shaped
 * like a Creative Baton, the scan says it carries no credential material — and
 * both run before ANY write and again before a promotion.
 */
export function validateCreativeBaton(baton: unknown, opts: { secretScan?: boolean } = {}): CreativeBatonValidation {
  const check = validateAgainst(SCHEMA_IDS.creativeBaton, baton);
  if (!check.valid) return { valid: false, errors: check.errors };
  if (opts.secretScan !== false) {
    try {
      assertNoSecretMaterial(JSON.stringify(baton));
    } catch (error) {
      return { valid: false, errors: [String((error as Error)?.message ?? error)] };
    }
  }
  return { valid: true, errors: [] };
}

export class CreativeBatonError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CreativeBatonError';
  }
}

// ── Integrity: is a STORED baton still the one the compiler wrote? ──────────

/** Why a stored baton was refused, by name (never a silent null). */
export type BatonIntegrityCode =
  | 'version_unsupported'
  | 'schema_invalid'
  | 'secret_material'
  | 'payload_hash_mismatch';

export interface BatonIntegrity {
  ok: boolean;
  code: BatonIntegrityCode | null;
  reason: string;
}

/**
 * Verify a STORED baton BEFORE it is used for anything: the format version, the
 * registered schema (now CLOSED — an extra key fails), the secret scan, and the
 * payload hash recomputed over the stored document.
 *
 * THIS RUNS ON EVERY READ FOR USE — the caller-facing read, the controller
 * adapter, the compile-reuse path and the promotion idempotency path — because a
 * row can be tampered with AFTER it was written and, in particular, after it was
 * promoted. A `shared_id` is a statement about an EARLIER validation, not a
 * licence to skip the current one.
 *
 * The hash is an UNSIGNED digest of the document, so it proves integrity
 * against accidental or careless writes, not authenticity against a writer who
 * recomputes it; the CLOSED schema is the layer that refuses a packet carrying
 * a field the compiler never wrote, hash or no hash.
 */
export function verifyStoredBaton(stored: Record<string, unknown> | null | undefined): BatonIntegrity {
  if (!stored) return { ok: false, code: 'schema_invalid', reason: 'no stored baton document' };
  const version = nonEmpty(stored.creative_baton_version);
  if (version !== CREATIVE_BATON_VERSION) {
    return {
      ok: false,
      code: 'version_unsupported',
      reason: `creative_baton_version ${version ?? '(missing)'} is not ${CREATIVE_BATON_VERSION}`,
    };
  }
  const check = validateCreativeBaton(stored);
  if (!check.valid) {
    const secret = check.errors.some((error) => /secret-bearing material/i.test(error));
    return {
      ok: false,
      code: secret ? 'secret_material' : 'schema_invalid',
      reason: `stored baton failed re-validation: ${check.errors.slice(0, 3).join('; ')}`,
    };
  }
  const recomputed = creativeBatonPayloadHash(stored);
  const declared = nonEmpty(stored.payload_hash);
  if (recomputed !== declared) {
    return {
      ok: false,
      code: 'payload_hash_mismatch',
      reason:
        `stored payload hash ${declared ?? '(missing)'} does not match the recomputed ${recomputed}: ` +
        'the baton was modified after compilation',
    };
  }
  return { ok: true, code: null, reason: 'verified' };
}

// ── The coverage gaps: a closed vocabulary, re-validated at compile ─────────

export interface CoverageGapValidation {
  gaps: Array<{ dimension: string; unoccupied_bins: string[] }>;
  considered: number;
  dropped_unknown_dimension: number;
  dropped_unknown_bins: number;
}

/**
 * `coverage_gaps[].unoccupied_bins` are BORROWED from the archive's coverage
 * view, and the archive's bins are a CLOSED vocabulary (`DESCRIPTOR_BINS`). A
 * baton is a packet a controller acts on, so the compiler re-checks every entry
 * against that vocabulary instead of copying the view verbatim: a marker (or an
 * invented bin) is DROPPED and COUNTED, and a gap whose dimension is not a
 * descriptor dimension at all is dropped whole (its bins cannot be validated
 * against a vocabulary that dimension does not have).
 */
export function validateCoverageGaps(
  gaps: ReadonlyArray<{ dimension?: unknown; unoccupied_bins?: unknown }>,
): CoverageGapValidation {
  const kept: Array<{ dimension: string; unoccupied_bins: string[] }> = [];
  let droppedDimensions = 0;
  let droppedBins = 0;
  for (const gap of gaps) {
    const dimension = typeof gap?.dimension === 'string' ? gap.dimension : '';
    const vocabulary = (DESCRIPTOR_BINS as Record<string, readonly string[] | undefined>)[dimension];
    if (!vocabulary) {
      droppedDimensions += 1;
      continue;
    }
    const bins: string[] = [];
    const offered = Array.isArray(gap?.unoccupied_bins) ? gap.unoccupied_bins : [];
    for (const value of offered) {
      const bin = typeof value === 'string' ? value.trim() : '';
      if (vocabulary.includes(bin)) bins.push(bin);
      else droppedBins += 1;
    }
    kept.push({ dimension, unoccupied_bins: bins });
  }
  return {
    gaps: kept,
    considered: gaps.length,
    dropped_unknown_dimension: droppedDimensions,
    dropped_unknown_bins: droppedBins,
  };
}

// ── Compilation ─────────────────────────────────────────────────────────────

/**
 * The compiler's §4.3 construction. Pure with respect to its inputs (the store
 * is not read): the same cycle over the same material yields the same baton,
 * the same id and the same payload hash.
 */
export function compileCreativeBaton(input: CreativeBatonCompileInput): CreativeBaton {
  const userId = nonEmpty(input.userId);
  const missionId = nonEmpty(input.missionId);
  const cycleId = nonEmpty(input.cycleId);
  if (!userId) throw new CreativeBatonError('userId is required', 'invalid_args');
  if (!missionId) throw new CreativeBatonError('missionId is required', 'invalid_args');
  if (!cycleId) throw new CreativeBatonError('cycleId is required', 'invalid_args');

  const now = input.now ?? (() => new Date().toISOString());
  const floor = candidateFloor();
  const admitted = input.seeds.filter((seed) => seed.state !== 'rejected');
  // ID SHAPE IS PART OF THE ALLOW-LIST. `seed_id` and `lineage_ref` are the two
  // allow-listed fields that carry an IDENTIFIER rather than a claim, and in
  // this repo every one of them is DERIVED (`<kind>_<sha256 prefix>`) — never
  // free text. A candidate whose ids are not id-shaped is therefore dropped and
  // counted: a caller cannot smuggle a sentence into a shared baton by writing
  // it into an id field, and a malformed id would be useless to a controller
  // anyway (it names no row).
  const idShaped = admitted.filter(
    (seed) => DERIVED_ID_PATTERN.test(String(seed.seed_id)) && DERIVED_ID_PATTERN.test(String(seed.lineage_ref)),
  );
  const droppedUnshapedIds = admitted.length - idShaped.length;
  const eligible = rankCandidates(idShaped.filter((seed) => isEligibleCandidate(seed, floor))).slice(
    0,
    maxBatonCandidates(),
  );

  // The portfolio: allow-listed fields only, each one taken explicitly.
  const candidatePortfolio: CreativeBatonCandidate[] = eligible.map((seed) => ({
    seed_id: String(seed.seed_id),
    hypothesis: String(seed.hypothesis),
    mechanism: String(seed.mechanism),
    descriptor_bins: [...(seed.descriptor_bins ?? [])],
    novelty_score: Number(seed.novelty_score),
    coherence_score: Number(seed.coherence_score),
    cheapest_test: String(seed.cheapest_test),
    expected_information_gain: Number(seed.expected_information_gain),
    lineage_ref: String(seed.lineage_ref),
    privacy_safe: true,
  }));

  // Excluded regions as FINGERPRINTS. `region.text` is used to compute a hash
  // and nothing else: it is never stored, truncated or paraphrased into the
  // baton, and `region.ref` (an evidence id) is dropped for the same reason.
  const excludedRegions: CreativeBatonExcludedRegion[] = input.exclusions
    .slice(0, maxExcludedRegions())
    .map((region, index) => ({
      pattern: `region_${index + 1}:${region.kind}:sha256:${sha256Hex(String(region.text ?? '')).slice(0, 16)}`,
      reason:
        region.kind === 'rejected_hypothesis'
          ? 'a hypothesis this mission already ruled out: a candidate that restates it is refused'
          : 'a region of the salience trace below the confidence floor: treated as ruled out',
      unless:
        'a complete changed premise that introduces at least two content tokens new to the excluded text, plus a lineage link to the prior rejection',
    }));

  // Attention targets: DERIVED from the signal's kind and calibration, never
  // copied from its statement or its own `why_operationally_relevant`.
  const attentionTargets: CreativeBatonAttentionTarget[] = input.trace.signals
    .slice(0, maxAttentionTargets())
    .map((signal, index) => {
      const kind = nonEmpty(signal.kind) ?? 'unknown';
      const mapped = (OPERATOR_TRACE_MAP as Record<string, readonly string[] | undefined>)[kind] ?? [];
      const families = [...mapped];
      const belowFloor = signal.low_confidence === true;
      return {
        cue:
          `${kind} signal #${index + 1} at intensity ${Number(signal.intensity)} ` +
          `(confidence ${Number(signal.confidence)}, valence ${Number(signal.valence)})` +
          (belowFloor ? ' — below the confidence floor, so it is an excluded region' : ''),
        why_operationally_relevant:
          families.length > 0
            ? `a ${kind} presses on ${families.join(', ')}, so it is where this mission's next decision can change`
            : `a ${kind} is recorded on the mission's trace; no operator family claims it as a driver`,
        operator_families: families,
      };
    });

  // Coverage gaps: the archive's CLOSED vocabulary, re-validated here (see
  // `validateCoverageGaps`) so an injected bin cannot ride into a shared packet.
  const gapCheck = validateCoverageGaps(input.coverage.gaps ?? []);
  const coverageGaps = gapCheck.gaps;

  const scan = input.coverage.scan ?? {
    cells_limit: 0,
    cells_scanned: 0,
    cells_truncated: false,
    seeds_dedupe_limit: 0,
    seeds_scanned: 0,
    seeds_truncated: false,
    truncated: false,
  };
  const coverageSummary: CreativeBatonCoverageSummary = {
    cells_total: Number(input.coverage.cells_total ?? 0),
    new_cells_this_cycle: Number(input.coverage.new_cells_this_cycle ?? 0),
    occupancy_ratio: Number(input.coverage.occupancy?.ratio ?? 0),
    scan: {
      cells_limit: Number(scan.cells_limit ?? 0),
      cells_scanned: Number(scan.cells_scanned ?? 0),
      cells_truncated: scan.cells_truncated === true,
      seeds_dedupe_limit: Number(scan.seeds_dedupe_limit ?? 0),
      seeds_scanned: Number(scan.seeds_scanned ?? 0),
      seeds_truncated: scan.seeds_truncated === true,
      truncated: scan.truncated === true,
    },
  };

  const counts = {
    candidates_considered: admitted.length,
    candidates_eligible: eligible.length,
    candidates_dropped_unshaped_ids: droppedUnshapedIds,
    excluded_regions: excludedRegions.length,
    attention_targets: attentionTargets.length,
    coverage_gaps_considered: gapCheck.considered,
    coverage_gaps_dropped_unknown_dimension: gapCheck.dropped_unknown_dimension,
    coverage_bins_dropped_unknown: gapCheck.dropped_unknown_bins,
  };

  const baton: CreativeBaton = {
    schema_version: '1.0',
    creative_baton_version: CREATIVE_BATON_VERSION,
    baton_id: derivedId(
      'cbaton',
      {
        mission_id: missionId,
        cycle_id: cycleId,
        problem_state_digest: String(input.trace.problem_state_digest ?? ''),
        seed_ids: candidatePortfolio.map((candidate) => candidate.seed_id),
      },
      hashSeed(`creative_baton:${missionId}:${cycleId}`),
    ),
    user_id: userId,
    mission_id: missionId,
    mission_version: Number(input.trace.mission_version) || 1,
    cycle_id: cycleId,
    trigger: {
      type: nonEmpty(input.trigger.type) ?? 'manual',
      evidence: [...(input.trigger.evidence ?? [])].map((entry) => String(entry).slice(0, 200)),
    },
    problem_state_digest: String(input.trace.problem_state_digest ?? ''),
    excluded_regions: excludedRegions,
    attention_targets: attentionTargets,
    candidate_portfolio: candidatePortfolio,
    coverage_gaps: coverageGaps,
    coverage_summary: coverageSummary,
    next_round_budget: {
      // How many more candidates the plateau rule says are missing, and one
      // cheapest test per eligible candidate.
      candidates: Math.max(0, plateauMinCandidates() - eligible.length),
      tests: eligible.length,
    },
    counts,
    privacy: { raw_reflections_included: false, shared: false },
    payload_hash: '',
    stop_reason: input.stopReason ?? null,
    created_at: now(),
  };
  baton.payload_hash = creativeBatonPayloadHash(baton as unknown as Record<string, unknown>);

  const check = validateCreativeBaton(baton);
  if (!check.valid) {
    throw new CreativeBatonError(`creative baton invalid: ${check.errors.slice(0, 3).join('; ')}`, 'schema_invalid');
  }
  return baton;
}

/**
 * The contract's spelling of the compiler entry point
 * (`compile({ userId, missionId, cycleId, trace, seeds, exclusions, coverage,
 * trigger })`). Same function; exported under both names so the module reads
 * the way the contract is written.
 */
export const compile = compileCreativeBaton;

// ── Storage + caller-scope-aware reads ──────────────────────────────────────

export class CreativeBatonService {
  constructor(private readonly db: Db) {}

  private batons() {
    return this.db.collection<CreativeBaton>(CREATIVE_BATON_COLLECTIONS.creativeBatons);
  }

  /**
   * Compile a baton and store it PRIVATELY (the policy's explicit opt-out:
   * `resolveWriteScope` resolves `shared_id: null` for this request and the
   * document is `stripSharedId`-ed anyway). Idempotent by `baton_id`: the same
   * cycle over the same material re-compiles to the same id, and a stored row
   * is returned unchanged instead of being rewritten.
   *
   * The REUSE path is a read FOR USE: the stored row is verified (version,
   * closed schema, secret scan, payload hash) before it is handed back, so a
   * tampered row is refused by name (`payload_hash_mismatch`, `schema_invalid`)
   * instead of becoming the cycle's baton.
   */
  async compileAndStore(input: CreativeBatonCompileInput): Promise<{ baton: CreativeBaton; reused: boolean }> {
    await ensureCreativeBatonIndexes(this.db);
    const baton = compileCreativeBaton(input);
    const existing = await this.batons().findOne({ baton_id: baton.baton_id }, { projection: { _id: 0 } });
    if (existing) {
      const stored = existing as unknown as Record<string, unknown>;
      const integrity = verifyStoredBaton(stored);
      if (!integrity.ok) throw new CreativeBatonError(integrity.reason, integrity.code!);
      return { baton: existing as unknown as CreativeBaton, reused: true };
    }

    const scope = resolveWriteScope({
      caller: { user_id: baton.user_id, trusted: false },
      kind: CREATIVE_BATON_KIND,
      requested: { private: true },
    });
    if (scope.shared_id !== null || scope.user_id !== baton.user_id) {
      throw new CreativeBatonError(
        `creative_batons must be compiled privately but resolved { user_id: ${scope.user_id}, shared_id: ${scope.shared_id} }`,
        'scope_invalid',
      );
    }
    const doc = stripSharedId(baton) as CreativeBaton;
    const check = validateCreativeBaton(doc);
    if (!check.valid) {
      throw new CreativeBatonError(`creative baton invalid: ${check.errors.slice(0, 3).join('; ')}`, 'schema_invalid');
    }
    try {
      await this.batons().insertOne(doc);
    } catch (error) {
      // Two concurrent compilations of one cycle race on the unique baton_id;
      // the loser reads the winner's row (one baton per cycle, never two) — and
      // verifies it like any other read for use.
      const winner = await this.batons().findOne({ baton_id: baton.baton_id }, { projection: { _id: 0 } });
      if (!winner) throw error;
      const integrity = verifyStoredBaton(winner as unknown as Record<string, unknown>);
      if (!integrity.ok) throw new CreativeBatonError(integrity.reason, integrity.code!);
      return { baton: winner as unknown as CreativeBaton, reused: true };
    }
    return { baton: doc, reused: false };
  }

  /**
   * `getCreativeBaton(batonId | missionId, caller)` — caller/scope-aware, and
   * verified: the newest VISIBLE row a caller may see is integrity-checked
   * before it is returned (see `readCreativeBaton`), so a tampered row is never
   * served. The refusal's NAME comes back from `readCreativeBaton`.
   *
   * There is deliberately NO unverified list read either: a list path that
   * skipped the check would be the same hole from the other side (see
   * `listVisibleBatons`).
   */
  async getCreativeBaton(ref: string, caller: CallerIdentity): Promise<CreativeBaton | null> {
    return (await this.readCreativeBaton(ref, caller)).baton;
  }

  /**
   * The verified read: the baton the caller may see, or the NAMED refusal that
   * stopped it. A row that is visible but no longer intact (`payload_hash_mismatch`,
   * `schema_invalid`, `secret_material`, `version_unsupported`) is refused rather
   * than served — a read is where a tampered row would otherwise reach a
   * controller, the work queue or a promotion.
   *
   * A baton id (`cbaton_…`) reads that baton; anything else is read as a
   * MISSION id and the newest baton the caller may see is returned. Visible
   * means: the caller owns it, or the caller is trusted, or the baton carries a
   * `shared_id` (a promoted, team-scoped artifact). An untrusted caller
   * therefore never reads another identity's private portfolio, and a
   * non-visible baton is reported exactly like a missing one.
   */
  async readCreativeBaton(ref: string, caller: CallerIdentity): Promise<CreativeBatonReadResult> {
    const target = nonEmpty(ref);
    if (!target) return { baton: null, refusal: null };
    const isBatonId = target.startsWith('cbaton_');
    const filter: Record<string, unknown> = isBatonId ? { baton_id: target } : { mission_id: target };
    const rows = (await this.batons()
      .find(filter, { projection: { _id: 0 } })
      .sort({ created_at: -1, baton_id: 1 })
      .limit(isBatonId ? 1 : 20)
      .toArray()) as unknown as CreativeBaton[];
    for (const row of rows) {
      if (!batonVisibleTo(row, caller)) continue;
      const integrity = verifyStoredBaton(row as unknown as Record<string, unknown>);
      if (!integrity.ok) {
        return { baton: null, refusal: { code: integrity.code!, reason: integrity.reason } };
      }
      return { baton: row, refusal: null };
    }
    return { baton: null, refusal: null };
  }

  /**
   * The caller's visible batons for a mission, each verified: the intact ones
   * are returned, and every refused one is reported BY NAME alongside them. A
   * tampered row is never silently rendered as a baton, and it never silently
   * disappears either.
   */
  async listVisibleBatons(
    userId: string,
    missionId: string,
    caller: CallerIdentity,
    limit = 10,
  ): Promise<{ batons: CreativeBaton[]; refusals: BatonRefusal[] }> {
    const rows = (await this.batons()
      .find({ mission_id: missionId }, { projection: { _id: 0 } })
      .sort({ created_at: -1, baton_id: 1 })
      .limit(Math.min(Math.max(Math.floor(limit) || 1, 1), 50))
      .toArray()) as unknown as CreativeBaton[];
    const batons: CreativeBaton[] = [];
    const refusals: BatonRefusal[] = [];
    for (const row of rows) {
      if (row.user_id !== userId && !caller.trusted && !nonEmpty(row.shared_id)) continue;
      const integrity = verifyStoredBaton(row as unknown as Record<string, unknown>);
      if (!integrity.ok) {
        refusals.push({ baton_id: String(row.baton_id), code: integrity.code!, reason: integrity.reason });
        continue;
      }
      batons.push(row);
    }
    return { batons, refusals };
  }
}

/** A stored baton that was visible but refused, with the name of the refusal. */
export interface BatonRefusal {
  baton_id: string;
  code: BatonIntegrityCode;
  reason: string;
}

export interface CreativeBatonReadResult {
  baton: CreativeBaton | null;
  refusal: { code: BatonIntegrityCode; reason: string } | null;
}

/** Trusted callers see any baton; an untrusted caller sees its own or a shared one. */
export function batonVisibleTo(baton: Pick<CreativeBaton, 'user_id' | 'shared_id'>, caller: CallerIdentity): boolean {
  if (caller.trusted) return true;
  if (baton.user_id === caller.user_id) return true;
  return nonEmpty(baton.shared_id) !== null;
}
