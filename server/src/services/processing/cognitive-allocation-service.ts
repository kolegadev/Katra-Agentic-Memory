/**
 * Cognitive allocation — a PORTFOLIO, not one winner (ITER-8, Phase 6).
 *
 * Contract: CONTRACT-iter8-cognitive-team.md §C. The brief's §4.5 score, with
 * every term and every input reported:
 *
 *   allocation_score = 0.35 * emotional_proximity
 *                    + 0.25 * task_skill_fit
 *                    + 0.20 * missing_approach_coverage
 *                    + 0.10 * recent_success
 *                    + 0.10 * availability
 *                    - convergence_penalty
 *                    - load_penalty
 *
 * WHERE EVERY TERM COMES FROM (each is reported with its `source`):
 *
 *   emotional_proximity   0.35 — the existing emotional-proximity allocator's
 *     number (`autonomous-executive.ts` owns it). It is a CALLER input here; a
 *     candidate without one scores the documented neutral 0.5, so an absent
 *     number is never a winning number.
 *   task_skill_fit        0.25 — caller input (the fit of the identity/mode to
 *     the mission's task); neutral 0.5 when absent.
 *   missing_approach_coverage 0.20 — DERIVED from the archive's coverage gaps
 *     (ITER-6/7): the share of the mission's MISSING descriptor bins this
 *     candidate's mode can occupy (`modeBinLabels` off the mode's attention
 *     bins). With no missing bins the term is the documented neutral 0.5, so it
 *     neither helps nor hurts.
 *   recent_success        0.10 — DERIVED from the identity's recorded candidate
 *     outcomes (`idea_candidate_outcomes`, ITER-7): useful outcomes over the
 *     total, with the counts reported. No rows at all ⇒ neutral 0.5.
 *   availability          0.10 — DERIVED from the identity's own mode
 *     assignments on this mission (a mission already carrying two live modes has
 *     less spare capacity than one carrying none), or a caller input.
 *   convergence_penalty   — two reported sub-terms: the STATIC cost of sharing a
 *     mode with peers (0.2 per same-mode peer) and the PORTFOLIO cost of picking
 *     yet another agent of a mode the portfolio already holds (0.2 per
 *     already-selected same-mode agent). The second is recomputed from the LIVE
 *     selection on every comparison, so it decides which candidate is picked —
 *     not merely reported after a pick that was already made.
 *
 *   load_penalty          — 0.2 × the identity's recent cycle load (cycles run
 *     inside the persisted window against the window's own cap), so an identity
 *     that has just been cycling hard is demoted.
 *
 * THE PORTFOLIO. Selection is a documented, deterministic greedy pass:
 *   1. coverage — for each missing bin (sorted), the best-scoring candidate that
 *      can occupy it is selected, so the portfolio targets the bins NOTHING
 *      occupies;
 *   2. reservation — the best remaining `verifier`/`critic` is RESERVED as the
 *      independent evaluator, with the reason "independent evaluator". It is
 *      chosen from candidates that are not generators, so it did not generate
 *      the candidate it will evaluate;
 *   3. fill — the highest-scoring remaining generator candidates, up to the cap.
 * Ties are broken by identity, so equal inputs always produce the same
 * portfolio. An identity appears at most once (a duplicate row is dropped and
 * counted). The `portfolio_id` is derived from the candidate SET — the identities
 * and modes, normalised and SORTED — so re-ordering the same candidates is the
 * same allocation and reuses the stored row instead of writing a second one.
 *
 * NOTHING PRIVATE IS HERE. The portfolio carries identities, modes, bins, scores
 * and counts — never a seed statement, a trace signal, a reflection or a belief,
 * and never a `shared_id` (the row is a personal kind).
 */
import type { Db } from 'mongodb';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { resolveWriteScope, stripSharedId } from '../memory/write-scope-policy.js';
import {
  COGNITIVE_TEAM_COLLECTIONS,
  COGNITIVE_PORTFOLIO_KIND,
  ensureCognitiveTeamIndexes,
} from './cognitive-team-collections.js';
import { derivedId, hashSeed, sha256Hex, stableStringify } from './imagination-operators.js';
import { IdeaArchiveService, type CoverageView } from './idea-archive-service.js';
import { modeBinLabels, modeSpec, type CognitiveMode, type EngineMode } from './cognitive-mode-service.js';
import { cycleBudgetWindowMs, maxCyclesPerWindow } from './imagination-cycle-config.js';
import { CREATIVE_BATON_COLLECTIONS } from './creative-baton-collections.js';

// ── Weights and constants ───────────────────────────────────────────────────

/** The brief's §4.5 weights, verbatim and frozen. */
export const ALLOCATION_WEIGHTS = {
  emotional_proximity: 0.35,
  task_skill_fit: 0.25,
  missing_approach_coverage: 0.2,
  recent_success: 0.1,
  availability: 0.1,
} as const;

/** The neutral value a term takes when the store (or the caller) has nothing. */
export const NEUTRAL_TERM = 0.5;
/** Cost of sharing a mode with a PEER in the same team. */
export const CONVERGENCE_PENALTY_PER_PEER = 0.2;
/** Cost of picking one more agent of a mode the PORTFOLIO already holds. */
export const CONVERGENCE_PENALTY_PER_DUPLICATE_PICK = 0.2;
/** Weight of the measured recent-cycle load. */
export const LOAD_PENALTY_WEIGHT = 0.2;
/** Default portfolio size (generators + the reserved evaluator). */
export const MAX_PORTFOLIO_AGENTS = 6;
/** Modes whose whole job is to evaluate someone else's candidate. */
export const EVALUATOR_MODES: readonly string[] = ['verifier', 'critic'];
/** Availability lost per live mode assignment on the same mission. */
export const AVAILABILITY_LOSS_PER_ASSIGNMENT = 0.25;

export class CognitiveAllocationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CognitiveAllocationError';
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function clamp01(value: unknown, fallback: number = NEUTRAL_TERM): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Number(Math.min(1, Math.max(0, number)).toFixed(6));
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

// ── The portfolio shape ─────────────────────────────────────────────────────

export interface PortfolioComponentReport {
  value: number;
  weighted: number;
  source: string;
  detail: Record<string, unknown>;
}

export interface ConvergencePenaltyReport {
  peer_component: number;
  duplicate_pick_component: number;
  value: number;
  same_mode_peers: number;
  same_mode_selected: number;
}

export interface LoadPenaltyReport {
  value: number;
  cycles_in_window: number;
  max_cycles: number;
}

export interface CandidateAllocationReport {
  identity: string;
  mode: string;
  engine_mode: EngineMode | null;
  components: {
    emotional_proximity: PortfolioComponentReport;
    task_skill_fit: PortfolioComponentReport;
    missing_approach_coverage: PortfolioComponentReport;
    recent_success: PortfolioComponentReport;
    availability: PortfolioComponentReport;
  };
  penalties: { convergence: ConvergencePenaltyReport; load: LoadPenaltyReport };
  static_score: number;
  selection_score: number;
  selection_rank: number | null;
  selected: boolean;
  role: 'generator' | 'evaluator' | null;
  reason: string;
  covered_bins: string[];
  targeted_bins: string[];
}

export interface PortfolioAgent {
  identity: string;
  mode: string;
  role: 'generator' | 'evaluator';
  selection_rank: number;
  engine_mode: EngineMode | null;
  static_score: number;
  selection_score: number;
  covered_bins: string[];
}

export interface VerifierReservation {
  identity: string;
  mode: string;
  /** The contract's recorded reason, verbatim. */
  reason: 'independent evaluator';
  independent: true;
  selection_score: number;
  /** The generators whose candidates it may not have produced. */
  evaluates: string[];
}

export interface CognitivePortfolio {
  schema_version: '1.0';
  portfolio_id: string;
  kind: 'allocation';
  user_id: string;
  mission_id: string;
  weights: typeof ALLOCATION_WEIGHTS;
  missing_bins: string[];
  coverage_source: {
    source: 'archive' | 'requested';
    cells_total: number;
    bins_missing: number;
    scan_truncated: boolean;
    gaps: Array<{ dimension: string; unoccupied_bins: string[] }>;
  };
  agents: PortfolioAgent[];
  /** The reserved evaluator — present whenever the team held one. */
  verifier_reservation: VerifierReservation | null;
  /** Why no evaluator was reserved, by name, when none was. */
  verifier_refusal: string | null;
  allocation_report: CandidateAllocationReport[];
  counts: {
    candidates_considered: number;
    candidates_selected: number;
    duplicates_dropped: number;
    bins_targeted: number;
    bins_covered: number;
    bins_uncovered: string[];
    uncovered_without_candidate: string[];
  };
  privacy: { private_content_included: false; shared: false };
  policy_hash: string;
  created_at: string;
}

export function portfolioPayloadForHash(portfolio: Record<string, unknown>): Record<string, unknown> {
  const { policy_hash: _policyHash, shared_id: _sharedId, ...rest } = portfolio;
  const privacy = (rest.privacy ?? {}) as Record<string, unknown>;
  return { ...rest, privacy: { ...privacy, shared: false } };
}

export function portfolioPolicyHash(portfolio: Record<string, unknown>): string {
  return `sha256:${sha256Hex(stableStringify(portfolioPayloadForHash(portfolio)))}`;
}

export type PortfolioIntegrityCode = 'version_unsupported' | 'schema_invalid' | 'policy_hash_mismatch';

export interface PortfolioIntegrity {
  ok: boolean;
  code: PortfolioIntegrityCode | null;
  reason: string;
}

/** The closed key set of a stored portfolio — an extra key is a hard failure. */
export const PORTFOLIO_KEYS: readonly string[] = [
  'schema_version',
  'portfolio_id',
  'kind',
  'user_id',
  'mission_id',
  'weights',
  'missing_bins',
  'coverage_source',
  'agents',
  'verifier_reservation',
  'verifier_refusal',
  'allocation_report',
  'counts',
  'privacy',
  'policy_hash',
  'created_at',
  // first_pass / synthesis documents share the collection and carry these.
  'pass_id',
  'status',
  'requests',
  'results',
  'team',
  'candidates',
  'exclusions',
  'lineage',
  'sources',
  'promoted',
];

/**
 * Verify a stored portfolio before it is served: the version, the closed key set
 * and the recomputed policy hash. A tampered row is refused by name instead of
 * being handed to a first pass or a synthesis.
 */
export function verifyPortfolio(stored: Record<string, unknown> | null | undefined): PortfolioIntegrity {
  if (!stored) return { ok: false, code: 'schema_invalid', reason: 'no stored portfolio' };
  if (stored.schema_version !== '1.0') {
    return {
      ok: false,
      code: 'version_unsupported',
      reason: `portfolio schema_version ${String(stored.schema_version ?? '(missing)')} is not 1.0`,
    };
  }
  for (const key of Object.keys(stored)) {
    if (!PORTFOLIO_KEYS.includes(key)) {
      return { ok: false, code: 'schema_invalid', reason: `unexpected field '${key}' on a cognitive portfolio` };
    }
  }
  const privacy = (stored.privacy ?? {}) as Record<string, unknown>;
  if (privacy.shared !== false || privacy.private_content_included !== false) {
    return { ok: false, code: 'schema_invalid', reason: 'a cognitive portfolio must attest that it carries no private content and no shared scope' };
  }
  const recomputed = portfolioPolicyHash(stored);
  const declared = nonEmpty(stored.policy_hash);
  if (recomputed !== declared) {
    return {
      ok: false,
      code: 'policy_hash_mismatch',
      reason: `stored policy hash ${declared ?? '(missing)'} does not match the recomputed ${recomputed}`,
    };
  }
  return { ok: true, code: null, reason: 'verified' };
}

// ── Inputs the store already knows ──────────────────────────────────────────

export interface AllocationCandidateInput {
  identity: string;
  mode: CognitiveMode | string;
  emotional_proximity?: number;
  task_skill_fit?: number;
  availability?: number;
  /** Overrides the measured outcome ratio (0..1). */
  recent_success?: number;
  /** The `dimension=bin` labels the candidate can occupy (defaults to the mode's). */
  covered_bins?: readonly string[];
  /** Overrides the measured recent-cycle load (a cycle count). */
  recent_cycles?: number;
}

export interface AllocationArgs {
  userId: string;
  missionId: string;
  candidates: readonly AllocationCandidateInput[];
  /** The missing bins to target; read from the archive when omitted. */
  missingBins?: readonly string[];
  maxAgents?: number;
  caller?: CallerIdentity;
  now?: () => string;
}

interface MeasuredInputs {
  recent_success: { value: number; source: string; useful: number; total: number };
  availability: { value: number; source: string; active_assignments: number };
  load: { cycles_in_window: number; max_cycles: number };
}

/**
 * What the store already knows about one identity on this mission: its recorded
 * candidate outcomes (`recent_success`), its live mode assignments
 * (`availability`) and its recent cycle load (`load_penalty`). Read-only.
 */
export async function measureCandidateInputs(
  db: Db,
  userId: string,
  missionId: string,
  nowMs: number,
): Promise<MeasuredInputs> {
  const outcomes = (await db
    .collection(CREATIVE_BATON_COLLECTIONS.candidateOutcomes)
    .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0, outcome: 1 } })
    .limit(200)
    .toArray()) as unknown as Array<{ outcome?: string }>;
  const useful = outcomes.filter((row) => row.outcome === 'useful_information').length;
  const total = outcomes.length;

  const assignments = await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.modeAssignments)
    .countDocuments({ user_id: userId, mission_id: missionId, status: 'active' });

  const windowMs = cycleBudgetWindowMs();
  const since = new Date(nowMs - windowMs).toISOString();
  const cycles = (await db
    .collection(CREATIVE_BATON_COLLECTIONS.cycles)
    .find({ user_id: userId, mission_id: missionId, created_at: { $gte: since } }, { projection: { _id: 0, cycle_id: 1 } })
    .limit(200)
    .toArray()) as unknown as Array<{ cycle_id?: string }>;

  return {
    recent_success: {
      value: total === 0 ? NEUTRAL_TERM : clamp01(useful / total),
      source: total === 0 ? 'default_neutral (no recorded candidate outcomes)' : 'idea_candidate_outcomes',
      useful,
      total,
    },
    availability: {
      value: clamp01(1 - AVAILABILITY_LOSS_PER_ASSIGNMENT * assignments),
      source: 'thinking_mode_assignments (live modes on this mission)',
      active_assignments: assignments,
    },
    load: { cycles_in_window: cycles.length, max_cycles: maxCyclesPerWindow() },
  };
}

// ── Allocation ──────────────────────────────────────────────────────────────

/** The archive's coverage gaps as `dimension=bin` labels. */
export function missingBinLabels(coverage: CoverageView): string[] {
  const labels: string[] = [];
  for (const gap of coverage.gaps ?? []) {
    for (const bin of gap.unoccupied_bins ?? []) labels.push(`${gap.dimension}=${bin}`);
  }
  return [...new Set(labels)].sort();
}

/** Why a candidate's mode cannot occupy the bins it was asked to cover. */
export function candidateBins(candidate: AllocationCandidateInput): string[] {
  if (candidate.covered_bins && candidate.covered_bins.length > 0) {
    return [...new Set(candidate.covered_bins.map((bin) => String(bin)))].sort();
  }
  const spec = modeSpec(candidate.mode);
  return spec ? modeBinLabels(spec).sort() : [];
}

export interface AllocateResult {
  portfolio: CognitivePortfolio;
  /** True when an identical allocation was already stored (no second write). */
  reused: boolean;
  /** Bins no candidate could have covered, with the reason. */
  uncovered: string[];
}

/**
 * Allocate a PORTFOLIO for a mission: cover the missing bins, reserve an
 * independent evaluator, fill with the best remaining generators, and report
 * every score component with its inputs.
 */
export async function allocatePortfolio(db: Db, args: AllocationArgs): Promise<AllocateResult> {
  const userId = nonEmpty(args.userId);
  const missionId = nonEmpty(args.missionId);
  if (!userId) throw new CognitiveAllocationError('userId is required', 'invalid_args');
  if (!missionId) throw new CognitiveAllocationError('missionId is required', 'invalid_args');
  if (!Array.isArray(args.candidates) || args.candidates.length === 0) {
    throw new CognitiveAllocationError('candidates must be a non-empty list of identities', 'invalid_args');
  }
  if (args.caller && !args.caller.trusted && args.caller.user_id !== userId) {
    throw new CognitiveAllocationError(
      `Caller '${args.caller.user_id}' may not allocate a portfolio for '${userId}'`,
      'forbidden',
    );
  }

  await ensureCognitiveTeamIndexes(db);
  const now = args.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const nowMs = Date.parse(createdAt);

  // 1. The missing approach space: the archive's own coverage gaps (ITER-6/7)
  //    unless the caller supplied the bins.
  let coverage: CoverageView | null = null;
  let missing: string[];
  let coverageSource: CognitivePortfolio['coverage_source'];
  if (args.missingBins) {
    missing = [...new Set(args.missingBins.map((bin) => String(bin)))].sort();
    coverageSource = { source: 'requested', cells_total: 0, bins_missing: missing.length, scan_truncated: false, gaps: [] };
  } else {
    coverage = await new IdeaArchiveService(db).coverage(missionId, userId);
    missing = missingBinLabels(coverage);
    coverageSource = {
      source: 'archive',
      cells_total: coverage.cells_total,
      bins_missing: missing.length,
      scan_truncated: coverage.scan?.truncated === true,
      gaps: (coverage.gaps ?? []).map((gap) => ({ dimension: gap.dimension, unoccupied_bins: [...gap.unoccupied_bins] })),
    };
  }

  // 2. Drop duplicate identities (a row per mode is fine; two rows for one
  //    identity are not — one agent holds one mode in a round).
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const unique: AllocationCandidateInput[] = [];
  for (const candidate of args.candidates) {
    const identity = nonEmpty(candidate?.identity);
    if (!identity) continue;
    if (seen.has(identity)) {
      duplicates.push(identity);
      continue;
    }
    seen.add(identity);
    unique.push({ ...candidate, identity });
  }
  if (unique.length === 0) throw new CognitiveAllocationError('no usable candidate identities', 'invalid_args');

  const measured = new Map<string, MeasuredInputs>();
  for (const candidate of unique) {
    measured.set(candidate.identity, await measureCandidateInputs(db, candidate.identity, missionId, nowMs));
  }

  const modeCount = new Map<string, number>();
  for (const candidate of unique) modeCount.set(candidate.mode, (modeCount.get(candidate.mode) ?? 0) + 1);

  interface Row {
    candidate: AllocationCandidateInput;
    bins: string[];
    targeted: string[];
    metrics: MeasuredInputs;
    staticScore: number;
    components: CandidateAllocationReport['components'];
    selected: boolean;
    role: 'generator' | 'evaluator' | null;
    selectionRank: number | null;
    selectionScore: number;
    duplicatePicks: number;
    reason: string;
  }

  const rows: Row[] = unique.map((candidate) => {
    const metrics = measured.get(candidate.identity)!;
    const bins = candidateBins(candidate);
    const targeted = bins.filter((bin) => missing.includes(bin));
    const spec = modeSpec(candidate.mode);

    const emotional = clamp01(candidate.emotional_proximity);
    const skill = clamp01(candidate.task_skill_fit);
    const coverageValue = missing.length === 0 ? NEUTRAL_TERM : clamp01(targeted.length / missing.length);
    const success = clamp01(candidate.recent_success ?? metrics.recent_success.value);
    const availability = clamp01(candidate.availability ?? metrics.availability.value);

    const peers = Math.max(0, (modeCount.get(candidate.mode) ?? 1) - 1);
    const cyclesInWindow =
      candidate.recent_cycles === undefined ? metrics.load.cycles_in_window : Math.max(0, Math.round(candidate.recent_cycles));
    const maxCycles = Math.max(1, metrics.load.max_cycles);
    const loadRatio = clamp01(cyclesInWindow / maxCycles);
    const loadPenalty = round6(LOAD_PENALTY_WEIGHT * loadRatio);
    const peerPenalty = round6(CONVERGENCE_PENALTY_PER_PEER * peers);

    const components: CandidateAllocationReport['components'] = {
      emotional_proximity: {
        value: emotional,
        weighted: round6(ALLOCATION_WEIGHTS.emotional_proximity * emotional),
        source: candidate.emotional_proximity === undefined ? 'default_neutral (caller input absent)' : 'caller input',
        detail: { weight: ALLOCATION_WEIGHTS.emotional_proximity },
      },
      task_skill_fit: {
        value: skill,
        weighted: round6(ALLOCATION_WEIGHTS.task_skill_fit * skill),
        source: candidate.task_skill_fit === undefined ? 'default_neutral (caller input absent)' : 'caller input',
        detail: { weight: ALLOCATION_WEIGHTS.task_skill_fit, mode: candidate.mode },
      },
      missing_approach_coverage: {
        value: coverageValue,
        weighted: round6(ALLOCATION_WEIGHTS.missing_approach_coverage * coverageValue),
        source: missing.length === 0 ? 'default_neutral (the archive reports no missing bins)' : coverageSource.source === 'archive' ? 'idea_archive_cells coverage gaps' : 'requested missing bins',
        detail: {
          weight: ALLOCATION_WEIGHTS.missing_approach_coverage,
          missing_bins: missing.length,
          targeted_bins: targeted.length,
          covered_bins: bins,
        },
      },
      recent_success: {
        value: success,
        weighted: round6(ALLOCATION_WEIGHTS.recent_success * success),
        source: candidate.recent_success === undefined ? metrics.recent_success.source : 'caller input',
        detail: {
          weight: ALLOCATION_WEIGHTS.recent_success,
          useful_outcomes: metrics.recent_success.useful,
          outcomes_total: metrics.recent_success.total,
        },
      },
      availability: {
        value: availability,
        weighted: round6(ALLOCATION_WEIGHTS.availability * availability),
        source: candidate.availability === undefined ? metrics.availability.source : 'caller input',
        detail: { weight: ALLOCATION_WEIGHTS.availability, active_assignments: metrics.availability.active_assignments },
      },
    };

    const staticScore = round6(
      components.emotional_proximity.weighted +
        components.task_skill_fit.weighted +
        components.missing_approach_coverage.weighted +
        components.recent_success.weighted +
        components.availability.weighted -
        peerPenalty -
        loadPenalty,
    );
    return {
      candidate,
      bins,
      targeted,
      metrics,
      staticScore,
      components,
      selected: false,
      role: null,
      selectionRank: null,
      selectionScore: staticScore,
      duplicatePicks: 0,
      reason: spec ? 'candidate' : `unknown mode '${String(candidate.mode)}': no attention bins, so it covers no missing bin`,
    };
  });

  const selected: Row[] = [];
  const scores = new Map<Row, { penalty: LoadPenaltyReport; peer: number }>();
  for (const row of rows) {
    const cyclesInWindow =
      row.candidate.recent_cycles === undefined ? row.metrics.load.cycles_in_window : Math.max(0, Math.round(row.candidate.recent_cycles));
    const maxCycles = Math.max(1, row.metrics.load.max_cycles);
    scores.set(row, {
      penalty: {
        value: round6(LOAD_PENALTY_WEIGHT * clamp01(cyclesInWindow / maxCycles)),
        cycles_in_window: cyclesInWindow,
        max_cycles: maxCycles,
      },
      peer: CONVERGENCE_PENALTY_PER_PEER * Math.max(0, (modeCount.get(row.candidate.mode) ?? 1) - 1),
    });
  }

  /** See `duplicatePicksIn`: the cost is measured against the LIVE selection. */
  const duplicatePicksIn = (row: Row): number =>
    selected.filter((other) => other.candidate.mode === row.candidate.mode).length;

  /**
   * Selection score at this moment: the static score minus the duplicate-pick
   * cost computed from the selection AS IT STANDS — the peers of this row's mode
   * that are already in the portfolio. Computing it here (rather than reading a
   * field that is only written after a row has won) is what makes the penalty
   * audible to the comparison itself: a second agent of a mode the portfolio
   * already holds loses to a different-mode candidate by exactly
   * `CONVERGENCE_PENALTY_PER_DUPLICATE_PICK`, instead of the penalty only ever
   * appearing in the report of a pick that had already been made.
   */
  const scoreOf = (row: Row): number =>
    round6(row.staticScore - CONVERGENCE_PENALTY_PER_DUPLICATE_PICK * duplicatePicksIn(row));

  const best = (pool: Row[]): Row | null => {
    let pick: Row | null = null;
    for (const row of pool) {
      const score = scoreOf(row);
      if (
        !pick ||
        score > scoreOf(pick) ||
        (score === scoreOf(pick) && row.candidate.identity.localeCompare(pick.candidate.identity) < 0)
      ) {
        pick = row;
      }
    }
    return pick;
  };

  const select = (row: Row, role: 'generator' | 'evaluator', reason: string): void => {
    row.selected = true;
    row.role = role;
    // What the pick cost at its own selection: the same live count `scoreOf`
    // compared with, taken before the row joins the selection.
    row.duplicatePicks = duplicatePicksIn(row);
    row.selectionScore = scoreOf(row);
    row.selectionRank = selected.length + 1;
    row.reason = reason;
    selected.push(row);
  };

  const maxAgents = Math.min(Math.max(Math.floor(Number(args.maxAgents) || MAX_PORTFOLIO_AGENTS), 1), 12);
  const isEvaluatorMode = (row: Row): boolean => EVALUATOR_MODES.includes(String(row.candidate.mode));
  const generatorPool = (): Row[] => rows.filter((row) => !row.selected && !isEvaluatorMode(row));
  const evaluatorPool = (): Row[] => rows.filter((row) => !row.selected && isEvaluatorMode(row));

  // Pass 1 — coverage: one agent per missing bin, when a candidate can take it.
  const uncovered: string[] = [];
  for (const bin of missing) {
    if (selected.some((row) => row.bins.includes(bin))) continue;
    const covering = rows.filter((row) => !row.selected && row.bins.includes(bin));
    // Generator-mode candidates come first — the evaluator modes are held for
    // the reservation pass — but a bin that ONLY an evaluator mode can occupy is
    // still covered rather than reported as uncovered.
    const pick = best(covering.filter((row) => !isEvaluatorMode(row))) ?? best(covering);
    if (!pick) {
      uncovered.push(bin);
      continue;
    }
    select(pick, 'generator', `covers missing bin ${bin}`);
  }

  // Pass 2 — the reserved independent evaluator. It is drawn from candidates
  // that are NOT generators, so it did not produce what it evaluates.
  let reservation: VerifierReservation | null = null;
  let verifierRefusal: string | null = null;
  let reservedRow: Row | null = null;
  const evaluator = best(evaluatorPool());
  if (evaluator) {
    select(evaluator, 'evaluator', 'independent evaluator: reserved from the evaluator modes and not a generator');
    reservedRow = evaluator;
  } else {
    verifierRefusal =
      rows.some(isEvaluatorMode)
        ? 'no independent verifier/critic available: every evaluator-mode candidate already generates in this portfolio'
        : 'no verifier/critic candidate in the team';
  }

  // Pass 3 — fill with the best remaining generators.
  while (selected.length < maxAgents) {
    const pool = generatorPool().length > 0 ? generatorPool() : [];
    const pick = best(pool);
    if (!pick) break;
    select(pick, 'generator', 'fills the portfolio up to the agent cap');
  }

  // The reservation is stated AFTER the portfolio is complete: it names the
  // generators whose candidates this evaluator may not have produced.
  if (reservedRow) {
    reservation = {
      identity: reservedRow.candidate.identity,
      mode: String(reservedRow.candidate.mode),
      reason: 'independent evaluator',
      independent: true,
      selection_score: reservedRow.selectionScore,
      evaluates: selected
        .filter((row) => row.role === 'generator')
        .map((row) => row.candidate.identity),
    };
  }

  const agents: PortfolioAgent[] = selected.map((row) => ({
    identity: row.candidate.identity,
    mode: String(row.candidate.mode),
    role: row.role!,
    selection_rank: row.selectionRank!,
    engine_mode: modeSpec(row.candidate.mode)?.engine_mode ?? null,
    static_score: row.staticScore,
    selection_score: row.selectionScore,
    covered_bins: row.targeted,
  }));

  const allocationReport: CandidateAllocationReport[] = rows
    .map((row) => {
      const penalty = scores.get(row)!.penalty;
      const peer = round6(scores.get(row)!.peer);
      // For a SELECTED candidate this is what it paid at its own selection;
      // for one that stayed out it is what the portfolio's final shape would
      // have charged it — the number a caller has to beat.
      const sameModeSelected = row.selected
        ? row.duplicatePicks
        : selected.filter((other) => other.candidate.mode === row.candidate.mode).length;
      const duplicateComponent = round6(CONVERGENCE_PENALTY_PER_DUPLICATE_PICK * sameModeSelected);
      return {
        identity: row.candidate.identity,
        mode: String(row.candidate.mode),
        engine_mode: modeSpec(row.candidate.mode)?.engine_mode ?? null,
        components: row.components,
        penalties: {
          convergence: {
            peer_component: peer,
            duplicate_pick_component: duplicateComponent,
            value: round6(peer + duplicateComponent),
            same_mode_peers: Math.max(0, (modeCount.get(row.candidate.mode) ?? 1) - 1),
            same_mode_selected: sameModeSelected,
          },
          load: penalty,
        },
        static_score: row.staticScore,
        selection_score: row.selected ? row.selectionScore : round6(row.staticScore - duplicateComponent),
        selection_rank: row.selectionRank,
        selected: row.selected,
        role: row.role,
        reason: row.reason,
        covered_bins: row.bins,
        targeted_bins: row.targeted,
      };
    })
    .sort((left, right) => {
      if (left.selected !== right.selected) return left.selected ? -1 : 1;
      if (left.selection_rank !== null && right.selection_rank !== null && left.selection_rank !== right.selection_rank) {
        return left.selection_rank - right.selection_rank;
      }
      if (left.static_score !== right.static_score) return right.static_score - left.static_score;
      return left.identity.localeCompare(right.identity);
    });

  const coveredBins = missing.filter((bin) => selected.some((row) => row.bins.includes(bin)));
  /**
   * The candidate SET the portfolio id is derived from: normalised to
   * `{identity, mode}` and SORTED by identity (then mode). The id must depend on
   * WHICH candidates were allocated and their modes — never on the ORDER the
   * caller happened to list them in, which would let a shuffled list of the same
   * candidates miss the stored row and write a second, identical portfolio.
   */
  const candidateSet = [...new Map(unique.map((candidate) => [candidate.identity, candidate])).values()]
    .map((candidate) => ({ identity: candidate.identity, mode: String(candidate.mode) }))
    .sort((left, right) => left.identity.localeCompare(right.identity) || left.mode.localeCompare(right.mode));
  const portfolioId = derivedId(
    'cport',
    {
      mission_id: missionId,
      user_id: userId,
      missing_bins: missing,
      max_agents: maxAgents,
      candidates: candidateSet,
      selected: selected.map((row) => ({ identity: row.candidate.identity, mode: row.candidate.mode, role: row.role })),
      reserved: reservation ? reservation.identity : null,
    },
    hashSeed(`cognitive_portfolio:${userId}:${missionId}`),
  );

  const portfolio: CognitivePortfolio = {
    schema_version: '1.0',
    portfolio_id: portfolioId,
    kind: 'allocation',
    user_id: userId,
    mission_id: missionId,
    weights: ALLOCATION_WEIGHTS,
    missing_bins: missing,
    coverage_source: coverageSource,
    agents,
    verifier_reservation: reservation,
    verifier_refusal: verifierRefusal,
    allocation_report: allocationReport,
    counts: {
      candidates_considered: args.candidates.length,
      candidates_selected: selected.length,
      duplicates_dropped: duplicates.length,
      bins_targeted: missing.length,
      bins_covered: coveredBins.length,
      bins_uncovered: missing.filter((bin) => !coveredBins.includes(bin)),
      uncovered_without_candidate: uncovered,
    },
    privacy: { private_content_included: false, shared: false },
    policy_hash: '',
    created_at: createdAt,
  };
  portfolio.policy_hash = portfolioPolicyHash(portfolio as unknown as Record<string, unknown>);

  return storePortfolio(db, portfolio, userId);
}

/**
 * Store a portfolio PRIVATELY (a personal kind: `shared_id: null` by
 * construction, and `stripSharedId`-ed anyway). Idempotent by derived id: the
 * same allocation over the same inputs returns the stored row.
 */
export async function storePortfolio(
  db: Db,
  portfolio: Record<string, any>,
  userId: string,
): Promise<AllocateResult> {
  const scope = resolveWriteScope({ caller: { user_id: userId, trusted: false }, kind: COGNITIVE_PORTFOLIO_KIND });
  if (scope.shared_id !== null || scope.user_id !== userId) {
    throw new CognitiveAllocationError(
      `cognitive_portfolios must be written privately but resolved { user_id: ${scope.user_id}, shared_id: ${scope.shared_id} }`,
      'scope_invalid',
    );
  }
  const document = stripSharedId(portfolio) as Record<string, unknown>;
  const collection = db.collection(COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios);
  const shape = verifyPortfolio(document);
  if (!shape.ok) throw new CognitiveAllocationError(shape.reason, shape.code!);
  const existing = (await collection.findOne({ portfolio_id: portfolio.portfolio_id }, { projection: { _id: 0 } })) as
    | Record<string, unknown>
    | null;
  if (existing) {
    const integrity = verifyPortfolio(existing);
    if (!integrity.ok) throw new CognitiveAllocationError(integrity.reason, integrity.code!);
    return {
      portfolio: existing as unknown as CognitivePortfolio,
      reused: true,
      uncovered: (existing as unknown as CognitivePortfolio).counts?.uncovered_without_candidate ?? [],
    };
  }
  try {
    await collection.insertOne(document as never);
  } catch {
    const winner = (await collection.findOne({ portfolio_id: portfolio.portfolio_id }, { projection: { _id: 0 } })) as
      | Record<string, unknown>
      | null;
    if (!winner) throw new CognitiveAllocationError('the portfolio could not be stored', 'conflict');
    const integrity = verifyPortfolio(winner);
    if (!integrity.ok) throw new CognitiveAllocationError(integrity.reason, integrity.code!);
    return { portfolio: winner as unknown as CognitivePortfolio, reused: true, uncovered: [] };
  }
  return { portfolio: document as unknown as CognitivePortfolio, reused: false, uncovered: portfolio.counts.uncovered_without_candidate ?? [] };
}

/** The caller's own portfolios for a mission (newest first), each verified. */
export async function listPortfolios(
  db: Db,
  args: { userId: string; missionId: string; kind?: string; limit?: number; caller: CallerIdentity },
): Promise<{ portfolios: Array<Record<string, unknown>>; refusals: Array<{ portfolio_id: string; code: PortfolioIntegrityCode; reason: string }> }> {
  const userId = nonEmpty(args.userId);
  const missionId = nonEmpty(args.missionId);
  if (!userId) throw new CognitiveAllocationError('userId is required', 'invalid_args');
  if (!missionId) throw new CognitiveAllocationError('missionId is required', 'invalid_args');
  if (!args.caller.trusted && args.caller.user_id !== userId) {
    throw new CognitiveAllocationError(
      `Caller '${args.caller.user_id}' may not read the cognitive portfolios of '${userId}'`,
      'forbidden',
    );
  }
  const filter: Record<string, unknown> = { user_id: userId, mission_id: missionId };
  if (nonEmpty(args.kind)) filter.kind = nonEmpty(args.kind);
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 10), 1), 50);
  const rows = (await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios)
    .find(filter, { projection: { _id: 0 } })
    .sort({ created_at: -1, portfolio_id: 1 })
    .limit(limit)
    .toArray()) as unknown as Array<Record<string, unknown>>;
  const portfolios: Array<Record<string, unknown>> = [];
  const refusals: Array<{ portfolio_id: string; code: PortfolioIntegrityCode; reason: string }> = [];
  for (const row of rows) {
    const integrity = verifyPortfolio(row);
    if (!integrity.ok) {
      refusals.push({ portfolio_id: String(row.portfolio_id), code: integrity.code!, reason: integrity.reason });
      continue;
    }
    portfolios.push(row);
  }
  return { portfolios, refusals };
}

/** One stored portfolio by id, verified. */
export async function getPortfolio(db: Db, portfolioId: string): Promise<Record<string, unknown> | null> {
  const target = nonEmpty(portfolioId);
  if (!target) return null;
  const row = (await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios)
    .findOne({ portfolio_id: target }, { projection: { _id: 0 } })) as Record<string, unknown> | null;
  if (!row) return null;
  const integrity = verifyPortfolio(row);
  if (!integrity.ok) throw new CognitiveAllocationError(integrity.reason, integrity.code!);
  return row;
}
