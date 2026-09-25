/**
 * Imagination cycle orchestrator — plateau trigger, gates, Creative Baton
 * (ITER-7, Phase 5).
 *
 * Contract: CONTRACT-iter7-creative-baton.md §A. A STALLED mission runs exactly
 * ONE imagination cycle; the cycle composes the two previous iterations
 * (focused consolidation → seeds → coverage), compiles a Creative Baton from
 * the result, and — only when `CREATIVE_BATON_PROMOTION` is on AND the caller is
 * trusted — promotes it. Nothing here generates ids, reads a clock more than
 * once per cycle, or writes a shared scope.
 *
 * WHAT MAKES IT SAFE ACROSS RESTARTS AND CONCURRENT CALLERS IS THE STORE, not
 * the in-process map:
 *
 *   - `imagination_cycle_states` holds one row per `{user_id, mission_id}` with
 *     the cooldown deadline, the window budget counters, the last cycle's
 *     numbers and the novelty-gain history. A fresh module graph reads that row
 *     and cannot re-trigger early, and the budget accounting CONTINUES from it
 *     instead of resetting — a process that never ran a cycle still sees the
 *     ones that did.
 *   - `imagination_cycles` holds one row per claimed cycle, unique per
 *     `{user_id, mission_id, cycle_id}`. The id is DERIVED from the mission's
 *     SCOPE (identity + mission id), its version and its cycle ordinal, so two
 *     concurrent callers of ONE mission compute the SAME id and the unique index
 *     lets exactly one run — while two DIFFERENT missions that happen to share
 *     (version, ordinal) derive different ids and each run their own cycle. The
 *     claim LOOKUP is scoped to `{user_id, mission_id, cycle_id}` for the same
 *     reason: an id-only lookup would hand the second mission the first one's
 *     recorded trace, baton and counts. A crashed attempt leaves a
 *     `running`/`failed` row behind and the next attempt moves to the next
 *     ordinal rather than wedging the mission.
 *
 * THE RETURNED STATUS AGREES WITH THE STORED ROW (contract §A.2): a cycle that
 * ran to a completed row is `ran`; one whose row is `failed` — an upstream
 * failure, a privacy-validation failure, a cancelled/superseded mission — is
 * `failed` with the same `reason`/`stop_reason`, so a caller that reads only
 * `status` is not told a failed cycle ran.
 *
 * THE GATE ORDER IS FIXED AND OBSERVABLE (contract §A.2): single-flight →
 * persisted cooldown → per-mission window budget (cycles, then measured tokens)
 * → plateau evaluation. `force` (a human/tool override) bypasses the PLATEAU
 * gate only: it can start a cycle on a healthy mission and can never shortcut
 * the cooldown or the budget. Every gate reports the numbers that decided it,
 * and a skipped cycle writes NOTHING — no row, no state change, no model call.
 *
 * STOP CONDITIONS (brief §8) are ALL evaluated and reported; `stop_reason` is
 * the first met in the documented precedence order of `STOP_CONDITIONS`
 * (`imagination-cycle-config.ts`), so "which one fired" is never inferred from a
 * missing field.
 *
 * BUDGET: the window caps cycles AND measured tokens (ITER-5's call and ITER-6's
 * calls together, from the usage ledger's snapshot delta). The measurement is
 * the ledger's process-wide delta between the cycle's start and its end, which
 * can only over-count (another writer settling in the same window), never
 * under-count — a conservative reading, which is the one a budget wants.
 */
import type { Db } from 'mongodb';
import { usageDeltaSince, usageSnapshot } from '../infrastructure/llm-usage-ledger.js';
import { MissionStateService } from '../mission-cognition/mission-state-service.js';
import { COLLECTIONS } from '../mission-cognition/collections.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import {
  STOP_CONDITIONS,
  candidateFloor,
  coverageTarget,
  cycleBudgetWindowMs,
  cycleCooldownMs,
  maxCyclesPerWindow,
  maxTokensPerWindow,
  plateauContradictionThreshold,
  plateauCoverageFloor,
  plateauMinCandidates,
  plateauNoveltyEpsilon,
  plateauNoveltyRounds,
  promotionMinQuality,
  type PlateauConditionName,
  type StopConditionName,
} from './imagination-cycle-config.js';
import {
  CREATIVE_BATON_COLLECTIONS,
  IMAGINATION_CYCLE_KIND,
  IMAGINATION_CYCLE_STATE_KIND,
  ensureCreativeBatonIndexes,
} from './creative-baton-collections.js';
import { sha256Hex } from './imagination-operators.js';
import {
  CreativeBatonError,
  CreativeBatonService,
  creativeBatonPromotionEnabled,
  type CreativeBaton,
} from './creative-baton-compiler.js';
import { promoteCreativeBaton } from './creative-baton-promotion.js';
import { IdeaArchiveService, privateDoc, type CoverageView } from './idea-archive-service.js';
import {
  buildImaginationInputs,
  focusedImaginationEnabled,
  runImaginationCycle as runImaginationEngineCycle,
  type ImaginationResult,
} from './imagination-service.js';
import {
  runFocusedConsolidation,
  type FocusedConsolidationResult,
  type SalienceTrace,
} from './focused-consolidation-service.js';

export { focusedImaginationEnabled, creativeBatonPromotionEnabled };

// ── Types ───────────────────────────────────────────────────────────────────

export interface PlateauCondition {
  name: PlateauConditionName;
  met: boolean;
  /** The numbers, ids and labels that decided it — never private text. */
  evidence: Record<string, unknown>;
}

export interface PlateauEvaluation {
  user_id: string;
  mission_id: string;
  plateau: boolean;
  conditions: PlateauCondition[];
  cooldown_remaining_ms: number;
  evaluated_at: string;
}

export interface CycleState {
  schema_version: '1.0';
  user_id: string;
  mission_id: string;
  /** Cycles that reached a terminal record for this mission — cumulative. */
  cycle_count: number;
  /** Highest cycle ordinal claimed, so a crashed attempt is never reused. */
  last_ordinal: number;
  window_started_at: string;
  cycles_in_window: number;
  tokens_in_window: number;
  cooldown_until: string | null;
  last_run_at: string | null;
  last_cycle_id: string | null;
  last_baton_id: string | null;
  last_stop_reason: string | null;
  last_new_cells: number;
  consecutive_no_new_cells: number;
  /**
   * The MEAN admitted-candidate novelty of the most recent cycles, oldest
   * first (bounded). Gains are derived from it (`noveltyGains`), so the
   * persisted row stores measurements rather than a difference that a restart
   * could re-derive wrongly.
   */
  novelty_history: number[];
  updated_at: string;
}

export interface CycleStopCondition {
  name: StopConditionName;
  met: boolean;
  evidence: Record<string, unknown>;
}

export interface CycleBudgetRecord {
  window_ms: number;
  max_cycles: number;
  max_tokens: number;
  cycles_in_window_before: number;
  cycles_in_window_after: number;
  tokens_in_window_before: number;
  tokens_in_window_after: number;
  tokens_spent_this_cycle: number;
}

export interface ImaginationCycleRun {
  schema_version: '1.0';
  cycle_id: string;
  user_id: string;
  mission_id: string;
  mission_version: number;
  trigger: string;
  actor_id: string;
  forced: boolean;
  status: 'running' | 'completed' | 'failed';
  /** The first stop condition that was met, in precedence order. */
  stop_reason: StopConditionName;
  stop_conditions: CycleStopCondition[];
  plateau: PlateauCondition[];
  cooldown_remaining_ms: number;
  trace_id: string | null;
  imagination_run_id: string | null;
  portfolio_digest: string | null;
  baton_id: string | null;
  baton_reused: boolean;
  promoted: boolean;
  promotion_id: string | null;
  promotion_skipped: string | null;
  coverage: CoverageView | null;
  counts: {
    seeds_generated: number;
    seeds_admitted: number;
    seeds_below_incumbent: number;
    seeds_rejected: number;
    candidates_considered: number;
    candidates_eligible: number;
    new_cells: number;
    cells_total: number;
  };
  budget: CycleBudgetRecord;
  novelty: { mean_this_cycle: number | null; previous_mean: number | null; gain: number };
  error: string | null;
  created_at: string;
  completed_at: string | null;
  duration_ms: number;
  privacy_audit: {
    shared_id_written: boolean;
    journal_reads: 0;
    promotions: number;
    raw_reflections_included: false;
  };
}

export interface CyclePortfolio {
  imagination_run_id: string | null;
  reused: boolean;
  seeds_generated: number;
  seeds_admitted: number;
  seeds_below_incumbent: number;
  seeds_rejected: number;
  candidates_considered: number;
  candidates_eligible: number;
  new_cells: number;
  cells_total: number;
  portfolio_digest: string | null;
}

export interface ImaginationCycleResult {
  /**
   * `ran` — the cycle ran to a COMPLETED terminal row (a baton may or may not
   * carry candidates, but the cycle itself did its work). `failed` — the cycle
   * attempted and did NOT complete: the stored row is `failed`, there is no
   * baton, and `reason`/`stop_reason` name why (`upstream_failure`,
   * `privacy_validation_failed`, `mission_cancelled_or_superseded`). A caller
   * that reads ONLY `status` is never told a failed cycle ran.
   */
  status: 'ran' | 'failed' | 'skipped' | 'replayed';
  /** A machine-readable label: 'completed', 'cooldown', 'budget_cycles', … */
  reason: string;
  cycle_id: string | null;
  trace_id: string | null;
  portfolio: CyclePortfolio | null;
  baton_id: string | null;
  baton: CreativeBaton | null;
  stop_reason: StopConditionName | null;
  stop_conditions: CycleStopCondition[];
  plateau: PlateauEvaluation | null;
  cooldown_remaining_ms: number;
  promoted: boolean;
  promotion_skipped: string | null;
  budget: CycleBudgetRecord | null;
  error: string | null;
}

export interface RunCycleArgs {
  userId: string;
  missionId: string;
  cycleId?: string;
  trigger?: string;
  /** A human/tool override of the PLATEAU gate only. */
  force?: boolean;
  actorId?: string;
  /** Who is running this: the promotion step needs a trusted caller. */
  caller?: CallerIdentity;
  /** Test seam: the current time, so a cycle never reads the clock twice. */
  now?: () => string;
}

export class ImaginationCycleError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ImaginationCycleError';
  }
}

const NOVELTY_HISTORY_LIMIT = 8;
/** Stop reasons that count as a repeated FAILURE signature. */
const FAILURE_SIGNATURES: readonly string[] = [
  'upstream_failure',
  'no_candidate_above_floor',
  'no_new_cells_two_rounds',
  'privacy_validation_failed',
];
const MAX_SIGNATURE_ROWS = 5;
/** A `running` cycle row older than this is abandoned (the process died). */
const CYCLE_CLAIM_GRACE_MS = 5 * 60 * 1000;
/** How many ordinals a single attempt may step over before giving up. */
const MAX_ORDINAL_PROBES = 5;

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error);
}

/** The same label sanitiser the ITER-6 run uses for its trigger. */
export function sanitizeCycleLabel(trigger: unknown): string {
  const raw = nonEmpty(trigger) ?? 'plateau';
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40)
    .replace(/[-_]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'plateau';
}

/**
 * The derived cycle id: the MISSION SCOPE + the mission version + the ordinal.
 *
 * The scope is part of the id because the id is also the CLAIM KEY. Mission
 * versions and cycle ordinals are per mission, so `v3_c1` is the ordinary
 * spelling of "the first cycle of a mission sitting at version 3" for EVERY
 * mission — two missions sharing (version, ordinal) would otherwise derive the
 * SAME id, and whichever claimed it first would serve the other the first
 * mission's trace, baton and counts while writing no row of its own. The scope
 * digest includes the identity as well, so two identities cannot share a claim
 * either. Derived (never random), so two concurrent callers asking for "the
 * next cycle" still agree on an id and the unique index settles who owns it.
 *
 * The scope digest is 16 hex characters (64 bits) of a sha256 — far past where
 * a birthday collision could matter — and the CLAIM KEY carries `user_id` and
 * `mission_id` beside the id, so even a digest collision could not serve one
 * mission's row to another.
 */
export function cycleIdFor(
  scope: { userId: string; missionId: string },
  missionVersion: number,
  ordinal: number,
): string {
  const scopeDigest = sha256Hex(`cycle_scope:${String(scope.userId)}:${String(scope.missionId)}`).slice(0, 16);
  return `imagination_cycle_${scopeDigest}_v${Number.isFinite(missionVersion) ? missionVersion : 1}_c${ordinal}`;
}

/** The ordinal a cycle id names (`imagination_cycle_<scope>_v3_c1` → 1). */
export function cycleOrdinalFromId(cycleId: string): number | null {
  const match = /^imagination_cycle_[0-9a-f]{16}_v\d+_c(\d+)$/.exec(cycleId);
  return match ? Number(match[1]) : null;
}

/**
 * The novelty GAINS of a history of per-cycle means: `gain[i] = means[i] -
 * means[i-1]`, oldest first. One definition, used by the plateau condition and
 * by the cycle's own record, so "the novelty gain was below ε" means the same
 * thing wherever it is reported.
 */
export function noveltyGains(means: readonly number[]): number[] {
  const gains: number[] = [];
  for (let index = 1; index < means.length; index += 1) {
    const previous = Number(means[index - 1]);
    const current = Number(means[index]);
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    gains.push(Number((current - previous).toFixed(6)));
  }
  return gains;
}

// ── Persisted state ─────────────────────────────────────────────────────────

function stateCollection(db: Db) {
  return db.collection<CycleState>(CREATIVE_BATON_COLLECTIONS.cycleStates);
}

function cycleCollection(db: Db) {
  return db.collection<ImaginationCycleRun>(CREATIVE_BATON_COLLECTIONS.cycles);
}

export async function readCycleState(db: Db, userId: string, missionId: string): Promise<CycleState | null> {
  return (await stateCollection(db).findOne({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })) as
    | unknown as CycleState
    | null;
}

function emptyState(userId: string, missionId: string, at: string): CycleState {
  return {
    schema_version: '1.0',
    user_id: userId,
    mission_id: missionId,
    cycle_count: 0,
    last_ordinal: 0,
    window_started_at: at,
    cycles_in_window: 0,
    tokens_in_window: 0,
    cooldown_until: null,
    last_run_at: null,
    last_cycle_id: null,
    last_baton_id: null,
    last_stop_reason: null,
    last_new_cells: 0,
    consecutive_no_new_cells: 0,
    novelty_history: [],
    updated_at: at,
  };
}

/**
 * The cooldown that is actually in force, in milliseconds.
 *
 * TWO bounds are honoured, and this is the ONE place that decides it: the
 * PERSISTED deadline (`cooldown_until`, written when the last cycle ran) and the
 * deadline the CURRENT setting implies (`last_run_at + IMAGINATION_CYCLE_
 * COOLDOWN_MS`). The effective deadline is the EARLIER of the two, so
 *   - a restart cannot re-trigger early — whatever process memory says, the
 *     stored row still holds the cycle off — and
 *   - shrinking the cooldown window takes effect immediately, while lengthening
 *     it never retroactively blocks a cycle the deployment's own setting allowed.
 */
export function cooldownRemainingMs(state: CycleState | null, nowMs: number): number {
  const lastRun = nonEmpty(state?.last_run_at);
  if (!lastRun) return 0;
  const lastMs = Date.parse(lastRun);
  if (!Number.isFinite(lastMs)) return 0;
  const persisted = Date.parse(String(state?.cooldown_until ?? ''));
  const current = lastMs + cycleCooldownMs();
  const deadline = Math.min(Number.isFinite(persisted) ? persisted : current, current);
  return Math.max(0, deadline - nowMs);
}

/** The window counters as they apply at `nowMs` (an expired window starts fresh). */
export function windowAt(
  state: CycleState | null,
  nowMs: number,
  at: string,
): { cycles: number; tokens: number; startedAt: string } {
  const startedMs = Date.parse(String(state?.window_started_at ?? ''));
  const fresh =
    !state || !Number.isFinite(startedMs) || nowMs - startedMs >= cycleBudgetWindowMs() || nowMs < startedMs;
  if (fresh) return { cycles: 0, tokens: 0, startedAt: at };
  return {
    cycles: Number(state!.cycles_in_window ?? 0),
    tokens: Number(state!.tokens_in_window ?? 0),
    startedAt: String(state!.window_started_at),
  };
}

// ── Plateau evaluation ──────────────────────────────────────────────────────

/**
 * `evaluatePlateau(db, { userId, missionId })` — the brief's §4.1 conditions,
 * each with the evidence that decided it. `plateau` is true when ANY condition
 * is met; every condition is reported either way, so "not a plateau" comes with
 * five evidences rather than with silence.
 */
export async function evaluatePlateau(
  db: Db,
  args: { userId: string; missionId: string; now?: () => string },
): Promise<PlateauEvaluation> {
  const userId = nonEmpty(args.userId);
  const missionId = nonEmpty(args.missionId);
  if (!userId) throw new ImaginationCycleError('userId is required', 'invalid_args');
  if (!missionId) throw new ImaginationCycleError('missionId is required', 'invalid_args');
  const now = args.now ?? (() => new Date().toISOString());
  const evaluatedAt = now();
  const nowMs = Date.parse(evaluatedAt);

  await ensureCreativeBatonIndexes(db);
  const mission = await new MissionStateService(db).getMissionState(missionId);
  if (!mission) throw new ImaginationCycleError(`mission state not found: ${missionId}`, 'mission_not_found');

  const archive = new IdeaArchiveService(db);
  const state = await readCycleState(db, userId, missionId);
  const conditions: PlateauCondition[] = [];

  // 1. below-minimum active candidates — an exact count, so there is no bound
  //    to report here (the coverage view carries the archive's bounds).
  const activeCandidates = await db
    .collection('idea_seeds')
    .countDocuments({ user_id: userId, mission_id: missionId, state: 'admitted' });
  const minCandidates = plateauMinCandidates();
  conditions.push({
    name: 'below_minimum_active_candidates',
    met: activeCandidates < minCandidates,
    evidence: { active_candidates: activeCandidates, minimum: minCandidates, measurement: 'exact count' },
  });

  // 2. novelty gain below ε over N rounds — from the PERSISTED history, so it
  //    survives a restart like every other fact this evaluation uses.
  const rounds = plateauNoveltyRounds();
  const epsilon = plateauNoveltyEpsilon();
  const means = state?.novelty_history ?? [];
  const gains = noveltyGains(means).slice(-rounds);
  const gainMet = gains.length >= rounds && gains.every((gain) => gain < epsilon);
  conditions.push({
    name: 'novelty_gain_below_epsilon',
    met: gainMet,
    evidence: {
      epsilon,
      rounds,
      rounds_observed: gains.length,
      gains,
      novelty_means: means.slice(-(rounds + 1)),
      cycles_recorded: means.length,
    },
  });

  // 3. repeated failure signature — either the same failure stop reason on two
  //    recent cycles, or two candidates that cost without value.
  const recent = (await cycleCollection(db)
    .find(
      { user_id: userId, mission_id: missionId },
      { projection: { _id: 0, cycle_id: 1, stop_reason: 1 } },
    )
    .sort({ created_at: -1 })
    .limit(MAX_SIGNATURE_ROWS)
    .toArray()) as unknown as Array<{ cycle_id: string; stop_reason?: string }>;
  const signatures = recent
    .map((row) => String(row.stop_reason ?? ''))
    .filter((signature) => FAILURE_SIGNATURES.includes(signature));
  const counts = new Map<string, number>();
  for (const signature of signatures) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  let repeatedSignature: string | null = null;
  let repeats = 0;
  for (const [signature, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (count >= 2) {
      repeatedSignature = signature;
      repeats = count;
      break;
    }
  }
  const unnecessaryCostOutcomes = await db
    .collection(CREATIVE_BATON_COLLECTIONS.candidateOutcomes)
    .countDocuments({ user_id: userId, mission_id: missionId, outcome: 'unnecessary_cost' });
  conditions.push({
    name: 'repeated_failure_signature',
    met: repeats >= 2 || unnecessaryCostOutcomes >= 2,
    evidence: {
      repeated_signature: repeatedSignature,
      occurrences: repeats,
      recent_stop_reasons: signatures,
      rows_scanned: recent.length,
      rows_limit: MAX_SIGNATURE_ROWS,
      unnecessary_cost_outcomes: unnecessaryCostOutcomes,
    },
  });

  // 4. archive coverage below a floor (the coverage view reports its own bounds)
  const coverage = await archive.coverage(missionId, userId);
  const floor = plateauCoverageFloor();
  conditions.push({
    name: 'archive_coverage_below_floor',
    met: coverage.cells_total < floor,
    evidence: {
      cells_total: coverage.cells_total,
      floor,
      occupancy_ratio: coverage.occupancy.ratio,
      scan: coverage.scan,
      truncated: coverage.scan?.truncated ?? false,
    },
  });

  // 5. contradiction pressure above a threshold
  const contradictions = await db.collection(COLLECTIONS.epistemicEntries).countDocuments({
    mission_id: missionId,
    entry_type: 'contradiction',
    status: { $in: ['active', 'accepted', 'challenged'] },
  });
  const threshold = plateauContradictionThreshold();
  conditions.push({
    name: 'contradiction_pressure_above_threshold',
    met: contradictions >= threshold,
    evidence: { contradictions, threshold, statuses: ['active', 'accepted', 'challenged'] },
  });

  return {
    user_id: userId,
    mission_id: missionId,
    plateau: conditions.some((condition) => condition.met),
    conditions,
    cooldown_remaining_ms: cooldownRemainingMs(state, nowMs),
    evaluated_at: evaluatedAt,
  };
}

// ── The cycle ───────────────────────────────────────────────────────────────

/** One in-process single-flight slot per `{user, mission}`. */
const inFlight = new Map<string, Promise<ImaginationCycleResult>>();

function skippedResult(reason: string, extra: Partial<ImaginationCycleResult> = {}): ImaginationCycleResult {
  return {
    status: 'skipped',
    reason,
    cycle_id: null,
    trace_id: null,
    portfolio: null,
    baton_id: null,
    baton: null,
    stop_reason: null,
    stop_conditions: [],
    plateau: null,
    cooldown_remaining_ms: 0,
    promoted: false,
    promotion_skipped: null,
    budget: null,
    error: null,
    ...extra,
  };
}

function budgetRecord(
  before: { cycles: number; tokens: number },
  after: { cycles: number; tokens: number },
  spentTokens: number,
): CycleBudgetRecord {
  return {
    window_ms: cycleBudgetWindowMs(),
    max_cycles: maxCyclesPerWindow(),
    max_tokens: maxTokensPerWindow(),
    cycles_in_window_before: before.cycles,
    cycles_in_window_after: after.cycles,
    tokens_in_window_before: before.tokens,
    tokens_in_window_after: after.tokens,
    tokens_spent_this_cycle: Math.max(0, Math.floor(spentTokens)),
  };
}

/**
 * Run (or refuse) one imagination cycle for a mission.
 *
 * The gates are checked in the contract's order and a refusal writes NOTHING:
 * no cycle row, no state change, no baton and no model call.
 */
export async function runImaginationCycle(db: Db, args: RunCycleArgs): Promise<ImaginationCycleResult> {
  const userId = nonEmpty(args.userId);
  const missionId = nonEmpty(args.missionId);
  if (!userId) throw new ImaginationCycleError('userId is required', 'invalid_args');
  if (!missionId) throw new ImaginationCycleError('missionId is required', 'invalid_args');

  const key = `${userId}:${missionId}`;
  const pending = inFlight.get(key);
  if (pending) {
    // Gate 1 — single-flight: a concurrent caller joins the running cycle
    // instead of starting a second one, and does not count as a cycle itself.
    const shared = await pending;
    return { ...shared, status: 'replayed', reason: 'single_flight_join' };
  }

  const work = executeCycle(db, {
    userId,
    missionId,
    cycleId: nonEmpty(args.cycleId) ?? undefined,
    trigger: sanitizeCycleLabel(args.trigger),
    force: args.force === true,
    actorId: nonEmpty(args.actorId) ?? userId,
    caller: args.caller ?? { user_id: userId, trusted: false },
    now: args.now ?? (() => new Date().toISOString()),
  });
  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

async function executeCycle(
  db: Db,
  args: {
    userId: string;
    missionId: string;
    cycleId?: string;
    trigger: string;
    force: boolean;
    actorId: string;
    caller: CallerIdentity;
    now: () => string;
  },
): Promise<ImaginationCycleResult> {
  const { userId, missionId, force, trigger, actorId, caller } = args;
  const startedIso = args.now();
  const startedMs = Date.now();
  const nowMs = Date.parse(startedIso);

  await ensureCreativeBatonIndexes(db);
  const mission = await new MissionStateService(db).getMissionState(missionId);
  if (!mission) throw new ImaginationCycleError(`mission state not found: ${missionId}`, 'mission_not_found');
  const state = await readCycleState(db, userId, missionId);

  // Gate 2 — the PERSISTED cooldown.
  const cooldown = cooldownRemainingMs(state, nowMs);
  if (cooldown > 0) return skippedResult('cooldown', { cooldown_remaining_ms: cooldown });

  // Gate 3 — the per-mission window budget (cycles first, then measured tokens).
  const window = windowAt(state, nowMs, startedIso);
  if (window.cycles >= maxCyclesPerWindow()) {
    return skippedResult('budget_cycles', { budget: budgetRecord(window, window, 0) });
  }
  if (window.tokens >= maxTokensPerWindow()) {
    return skippedResult('budget_tokens', { budget: budgetRecord(window, window, 0) });
  }

  // Gate 4 — the plateau (bypassed ONLY by an explicit `force`).
  const plateau = await evaluatePlateau(db, { userId, missionId, now: () => startedIso });
  if (!plateau.plateau && !force) return skippedResult('no_plateau', { plateau });

  // Claim the cycle. The id is derived from the mission version + ordinal, so a
  // concurrent caller computes the same id and the unique index decides;
  // a completed row replays, an in-flight one is reported, an abandoned one is
  // stepped over (its ordinal is never reused).
  const claim = await claimCycle(db, {
    userId,
    missionId,
    missionVersion: mission.version,
    requestedCycleId: args.cycleId,
    baseOrdinal: Math.max(Number(state?.last_ordinal ?? 0), Number(state?.cycle_count ?? 0)) + 1,
    trigger,
    actorId,
    forced: force,
    plateau: plateau.conditions,
    cooldownRemainingMs: cooldown,
    startedIso,
  });
  if (!claim.claimed) return claim.result;
  const cycleId = claim.cycleId;

  const record: ImaginationCycleRun = {
    schema_version: '1.0',
    cycle_id: cycleId,
    user_id: userId,
    mission_id: missionId,
    mission_version: mission.version,
    trigger,
    actor_id: actorId,
    forced: force,
    status: 'running',
    stop_reason: 'completed',
    stop_conditions: [],
    plateau: plateau.conditions,
    cooldown_remaining_ms: cooldown,
    trace_id: null,
    imagination_run_id: null,
    portfolio_digest: null,
    baton_id: null,
    baton_reused: false,
    promoted: false,
    promotion_id: null,
    promotion_skipped: null,
    coverage: null,
    counts: {
      seeds_generated: 0,
      seeds_admitted: 0,
      seeds_below_incumbent: 0,
      seeds_rejected: 0,
      candidates_considered: 0,
      candidates_eligible: 0,
      new_cells: 0,
      cells_total: 0,
    },
    budget: budgetRecord(window, window, 0),
    novelty: { mean_this_cycle: null, previous_mean: null, gain: 0 },
    error: null,
    created_at: startedIso,
    completed_at: null,
    duration_ms: 0,
    privacy_audit: { shared_id_written: false, journal_reads: 0, promotions: 0, raw_reflections_included: false },
  };
  await cycleCollection(db).updateOne(
    { user_id: userId, mission_id: missionId, cycle_id: cycleId },
    { $set: privateCycle(record) },
  );

  interface StopMeasures {
    privacy?: { failed: boolean; code?: string; detail?: string };
    missionTerminal?: boolean;
    upstreamError?: string | null;
    candidatesConsidered?: number;
    candidatesEligible?: number;
    newCells?: number;
    consecutiveNoNewCells?: number;
    budgetAfter?: CycleBudgetRecord;
    cellsTotal?: number;
    promotedHighValue?: boolean;
    promotedDetail?: Record<string, unknown>;
  }

  /** Every stop condition, evaluated — the first MET one becomes the reason. */
  const conditionsOf = (measures: StopMeasures): CycleStopCondition[] => {
    const eligible = measures.candidatesEligible ?? 0;
    const budgetAfter = measures.budgetAfter ?? budgetRecord(window, window, 0);
    const cellsTotal = measures.cellsTotal ?? 0;
    const met: Record<StopConditionName, { met: boolean; evidence: Record<string, unknown> }> = {
      privacy_validation_failed: {
        met: measures.privacy?.failed === true,
        evidence: { code: measures.privacy?.code ?? null, detail: measures.privacy?.detail ?? null },
      },
      mission_cancelled_or_superseded: {
        met: measures.missionTerminal === true,
        evidence: { mission_status: mission.status },
      },
      upstream_failure: {
        met: Boolean(measures.upstreamError),
        evidence: { error: measures.upstreamError ?? null },
      },
      no_candidate_above_floor: {
        met: (measures.candidatesConsidered ?? 0) > 0 && eligible === 0,
        evidence: {
          candidates_considered: measures.candidatesConsidered ?? 0,
          candidates_eligible: eligible,
          floor: candidateFloor(),
        },
      },
      budget_exhausted: {
        met:
          budgetAfter.cycles_in_window_after >= budgetAfter.max_cycles ||
          budgetAfter.tokens_in_window_after >= budgetAfter.max_tokens,
        evidence: {
          cycles_in_window: budgetAfter.cycles_in_window_after,
          max_cycles: budgetAfter.max_cycles,
          tokens_in_window: budgetAfter.tokens_in_window_after,
          max_tokens: budgetAfter.max_tokens,
          window_ms: budgetAfter.window_ms,
        },
      },
      coverage_target_reached: {
        met: cellsTotal >= coverageTarget(),
        evidence: { cells_total: cellsTotal, coverage_target: coverageTarget() },
      },
      no_new_cells_two_rounds: {
        met: (measures.consecutiveNoNewCells ?? 0) >= 2,
        evidence: {
          consecutive_cycles_without_new_cells: measures.consecutiveNoNewCells ?? 0,
          new_cells_this_cycle: measures.newCells ?? 0,
        },
      },
      promoted_inventory_restored: {
        met: measures.promotedHighValue === true && eligible >= plateauMinCandidates(),
        evidence: {
          promoted_high_value: measures.promotedHighValue === true,
          candidates_eligible: eligible,
          minimum: plateauMinCandidates(),
          ...(measures.promotedDetail ?? {}),
        },
      },
      completed: { met: false, evidence: { note: 'set below when nothing else fired' } },
    };
    const ordered: CycleStopCondition[] = STOP_CONDITIONS.map((name) => ({
      name,
      met: met[name].met,
      evidence: met[name].evidence,
    }));
    if (!ordered.some((condition) => condition.met && condition.name !== 'completed')) {
      const completed = ordered.find((condition) => condition.name === 'completed')!;
      completed.met = true;
      completed.evidence = { note: 'no stop condition fired — the cycle ran to its end' };
    }
    return ordered;
  };

  /**
   * Close the cycle: write the terminal row AND the persisted state (cooldown,
   * budget, novelty history, no-new-cells streak) in one place, so no exit path
   * can forget the state a restart depends on.
   */
  const finish = async (
    stopReason: StopConditionName,
    conditions: CycleStopCondition[],
    patch: Partial<ImaginationCycleRun>,
    terminal: { status: 'completed' | 'failed'; error?: string | null },
    compiledBaton?: CreativeBaton | null,
  ): Promise<ImaginationCycleResult> => {
    const completedIso = args.now();
    const budget = patch.budget ?? record.budget;
    const final: ImaginationCycleRun = {
      ...record,
      ...patch,
      status: terminal.status,
      stop_reason: stopReason,
      stop_conditions: conditions,
      completed_at: completedIso,
      duration_ms: Date.now() - startedMs,
      error: terminal.error ?? patch.error ?? null,
    };
    // The novelty record, closed over the PERSISTED history: the mean this cycle
    // measured, the mean the previous cycle left behind, and the gain between
    // them (the same gain the plateau condition reads, derived in one place).
    const previousMean =
      (state?.novelty_history ?? []).length > 0 &&
      Number.isFinite(state!.novelty_history[state!.novelty_history.length - 1])
        ? Number(state!.novelty_history[state!.novelty_history.length - 1])
        : null;
    const meanThisCycle = final.novelty.mean_this_cycle;
    const gain =
      meanThisCycle === null || previousMean === null ? 0 : Number((meanThisCycle - previousMean).toFixed(6));
    final.novelty = { mean_this_cycle: meanThisCycle, previous_mean: previousMean, gain };
    await cycleCollection(db).updateOne(
      { user_id: userId, mission_id: missionId, cycle_id: cycleId },
      { $set: privateCycle(final) },
    );

    const history =
      meanThisCycle === null
        ? state?.novelty_history ?? []
        : [...(state?.novelty_history ?? []), meanThisCycle].slice(-NOVELTY_HISTORY_LIMIT);
    const nextState: CycleState = {
      ...emptyState(userId, missionId, startedIso),
      ...(state ?? {}),
      cycle_count: Number(state?.cycle_count ?? 0) + 1,
      last_ordinal: Math.max(Number(state?.last_ordinal ?? 0), claim.ordinal),
      window_started_at: window.startedAt,
      cycles_in_window: budget.cycles_in_window_after,
      tokens_in_window: budget.tokens_in_window_after,
      cooldown_until: new Date(nowMs + cycleCooldownMs()).toISOString(),
      last_run_at: completedIso,
      last_cycle_id: cycleId,
      last_baton_id: final.baton_id,
      last_stop_reason: stopReason,
      last_new_cells: final.counts.new_cells,
      consecutive_no_new_cells:
        final.counts.new_cells === 0 ? Number(state?.consecutive_no_new_cells ?? 0) + 1 : 0,
      novelty_history: history,
      updated_at: completedIso,
    };
    await stateCollection(db).updateOne(
      { user_id: userId, mission_id: missionId },
      { $set: privateState(nextState) },
      { upsert: true },
    );

    return {
      // The returned status AGREES with the stored row: a failed cycle (no
      // trace, no baton) is reported as `failed`, never as `ran`.
      status: terminal.status === 'completed' ? 'ran' : 'failed',
      reason: stopReason,
      cycle_id: cycleId,
      trace_id: final.trace_id,
      portfolio: {
        imagination_run_id: final.imagination_run_id,
        reused: final.baton_reused,
        seeds_generated: final.counts.seeds_generated,
        seeds_admitted: final.counts.seeds_admitted,
        seeds_below_incumbent: final.counts.seeds_below_incumbent,
        seeds_rejected: final.counts.seeds_rejected,
        candidates_considered: final.counts.candidates_considered,
        candidates_eligible: final.counts.candidates_eligible,
        new_cells: final.counts.new_cells,
        cells_total: final.counts.cells_total,
        portfolio_digest: final.portfolio_digest,
      },
      baton_id: final.baton_id,
      baton: compiledBaton ?? null,
      stop_reason: stopReason,
      stop_conditions: conditions,
      plateau,
      cooldown_remaining_ms: 0,
      promoted: final.promoted,
      promotion_skipped: final.promotion_skipped,
      budget,
      error: final.error,
    };
  };

  // ── A finished or cancelled mission stops here (still recorded) ───────────
  if (mission.status === 'completed' || mission.status === 'cancelled') {
    const conditions = conditionsOf({ missionTerminal: true });
    return finish(
      'mission_cancelled_or_superseded',
      conditions,
      {},
      { status: 'failed', error: `mission is ${mission.status}` },
    );
  }

  const usageBefore = usageSnapshot();
  const spent = (): number => {
    const delta = usageDeltaSince(usageBefore);
    return delta.input_tokens + delta.output_tokens;
  };

  // ── Step 1: focused consolidation (ITER-5) ────────────────────────────────
  let focused: FocusedConsolidationResult;
  try {
    focused = await runFocusedConsolidation(db, {
      userId,
      missionId,
      cycleId: `${cycleId}:trace`,
      trigger,
      actorId,
    });
  } catch (error) {
    const tokensSpent = spent();
    const budgetAfter = budgetRecord(
      window,
      { cycles: window.cycles + 1, tokens: window.tokens + tokensSpent },
      tokensSpent,
    );
    return finish(
      'upstream_failure',
      conditionsOf({ upstreamError: errorMessage(error), budgetAfter }),
      { budget: budgetAfter },
      { status: 'failed', error: errorMessage(error) },
    );
  }
  if (focused.status !== 'completed' || !focused.trace) {
    const detail = focused.error ?? `focused consolidation reported ${focused.status}`;
    const tokensSpent = spent();
    const budgetAfter = budgetRecord(
      window,
      { cycles: window.cycles + 1, tokens: window.tokens + tokensSpent },
      tokensSpent,
    );
    return finish(
      'upstream_failure',
      conditionsOf({ upstreamError: detail, budgetAfter }),
      { trace_id: focused.trace_id, budget: budgetAfter },
      { status: 'failed', error: detail },
    );
  }
  const trace: SalienceTrace = focused.trace;

  // ── Step 2: seed generation + archive admission (ITER-6) ─────────────────
  let imagination: ImaginationResult;
  try {
    imagination = await runImaginationEngineCycle(db, {
      userId,
      missionId,
      cycleId,
      trigger,
      actorId,
      // The run's PRNG seed is the cycle id: the cycle is the unit a replay
      // restarts, so the same cycle over the same mission is reproducible.
      seed: cycleId,
    });
  } catch (error) {
    const tokensSpent = spent();
    const budgetAfter = budgetRecord(
      window,
      { cycles: window.cycles + 1, tokens: window.tokens + tokensSpent },
      tokensSpent,
    );
    return finish(
      'upstream_failure',
      conditionsOf({ upstreamError: errorMessage(error), budgetAfter }),
      { trace_id: trace.trace_id, budget: budgetAfter },
      { status: 'failed', error: errorMessage(error) },
    );
  }
  if (imagination.status === 'failed') {
    const detail = imagination.error ?? 'the imagination engine failed';
    const tokensSpent = spent();
    const budgetAfter = budgetRecord(
      window,
      { cycles: window.cycles + 1, tokens: window.tokens + tokensSpent },
      tokensSpent,
    );
    return finish(
      'upstream_failure',
      conditionsOf({ upstreamError: detail, budgetAfter }),
      { trace_id: trace.trace_id, imagination_run_id: imagination.run_id, budget: budgetAfter },
      { status: 'failed', error: detail },
    );
  }

  // ── Step 3: coverage (sanitized, with the scan's bounds) ─────────────────
  const archive = new IdeaArchiveService(db);
  const coverage = await archive.coverage(missionId, userId, { cycleId });
  const inputs = await buildImaginationInputs(db, mission, trace);
  const admitted = imagination.seeds.filter((seed) => seed.state !== 'rejected');
  const eligible = admitted.filter(
    (seed) => Number(seed.novelty_score) >= candidateFloor() && Number(seed.coherence_score) >= candidateFloor(),
  );

  // ── Step 4: compile the Creative Baton (the compiler never promotes) ─────
  let baton: CreativeBaton;
  let batonReused = false;
  const triggerEvidence = [
    ...plateau.conditions.filter((condition) => condition.met).map((condition) => `plateau:${condition.name}`),
    ...(force ? ['force:caller_override'] : []),
  ];
  try {
    const compiled = await new CreativeBatonService(db).compileAndStore({
      userId,
      missionId,
      cycleId,
      trace,
      seeds: imagination.seeds,
      exclusions: inputs.exclusions,
      coverage,
      trigger: { type: trigger, evidence: triggerEvidence },
      stopReason: null,
      now: () => startedIso,
    });
    baton = compiled.baton;
    batonReused = compiled.reused;
  } catch (error) {
    const tokensSpent = spent();
    const budgetAfter = budgetRecord(
      window,
      { cycles: window.cycles + 1, tokens: window.tokens + tokensSpent },
      tokensSpent,
    );
    // The refusal code is carried through BY NAME: a stored baton refused for
    // `payload_hash_mismatch` (or `schema_invalid`, `secret_material`,
    // `version_unsupported`) is reported as that, not as a generic failure.
    const refusalCode = error instanceof CreativeBatonError ? error.code : 'creative_baton_invalid';
    return finish(
      'privacy_validation_failed',
      conditionsOf({
        privacy: { failed: true, code: refusalCode, detail: errorMessage(error) },
        budgetAfter,
      }),
      { trace_id: trace.trace_id, imagination_run_id: imagination.run_id, budget: budgetAfter },
      { status: 'failed', error: errorMessage(error) },
    );
  }

  // ── Step 5: promote (only with the flag on, only for a trusted caller) ───
  let promoted = false;
  let promotionId: string | null = null;
  let promotionSkipped: string | null = null;
  let promotionFailed: { code: string; detail: string } | null = null;
  if (creativeBatonPromotionEnabled() && focusedImaginationEnabled()) {
    const promotion = await promoteCreativeBaton(db, {
      userId,
      batonId: baton.baton_id,
      caller,
      now: () => startedIso,
    });
    promoted = promotion.promoted;
    promotionId = promotion.promotion?.promotion_id ?? null;
    if (!promotion.promoted) {
      promotionSkipped = promotion.code ?? 'refused';
      if (
        promotion.code === 'schema_invalid' ||
        promotion.code === 'secret_material' ||
        promotion.code === 'payload_hash_mismatch'
      ) {
        promotionFailed = { code: promotion.code, detail: promotion.reason };
      }
    }
  } else {
    promotionSkipped = 'flag_off';
  }

  // ── Step 6: stop conditions ──────────────────────────────────────────────
  const tokensSpent = spent();
  const budgetAfter = budgetRecord(
    window,
    { cycles: window.cycles + 1, tokens: window.tokens + tokensSpent },
    tokensSpent,
  );
  const highValuePromoted =
    promoted && admitted.some((seed) => Number(seed.quality) >= promotionMinQuality());
  const meanThisCycle =
    admitted.length === 0
      ? null
      : Number((admitted.reduce((sum, seed) => sum + Number(seed.novelty_score), 0) / admitted.length).toFixed(6));
  const consecutiveNoNew =
    coverage.new_cells_this_cycle === 0 ? Number(state?.consecutive_no_new_cells ?? 0) + 1 : 0;

  const conditions = conditionsOf({
    privacy: promotionFailed
      ? { failed: true, code: promotionFailed.code, detail: promotionFailed.detail }
      : undefined,
    upstreamError: null,
    candidatesConsidered: admitted.length,
    candidatesEligible: eligible.length,
    newCells: coverage.new_cells_this_cycle,
    consecutiveNoNewCells: consecutiveNoNew,
    budgetAfter,
    cellsTotal: coverage.cells_total,
    promotedHighValue: highValuePromoted,
    promotedDetail: { baton_id: baton.baton_id, promotion_id: promotionId },
  });
  const stopReason = conditions.find((condition) => condition.met)!.name;

  return finish(
    stopReason,
    conditions,
    {
      trace_id: trace.trace_id,
      imagination_run_id: imagination.run_id,
      portfolio_digest: imagination.portfolio_digest,
      baton_id: baton.baton_id,
      baton_reused: batonReused,
      promoted,
      promotion_id: promotionId,
      promotion_skipped: promotionSkipped,
      coverage,
      counts: {
        seeds_generated: imagination.seeds_generated,
        seeds_admitted: imagination.seeds_admitted,
        seeds_below_incumbent: imagination.seeds_below_incumbent,
        seeds_rejected: imagination.seeds_rejected,
        candidates_considered: admitted.length,
        candidates_eligible: eligible.length,
        new_cells: coverage.new_cells_this_cycle,
        cells_total: coverage.cells_total,
      },
      budget: budgetAfter,
      novelty: { mean_this_cycle: meanThisCycle, previous_mean: null, gain: 0 },
      privacy_audit: {
        shared_id_written: promoted,
        journal_reads: 0,
        promotions: promoted ? 1 : 0,
        raw_reflections_included: false,
      },
    },
    { status: 'completed', error: null },
    baton,
  );
}

// ── The claim ───────────────────────────────────────────────────────────────

function privateCycle(run: ImaginationCycleRun): ImaginationCycleRun {
  return privateDoc(IMAGINATION_CYCLE_KIND, run.user_id, run);
}

function privateState(state: CycleState): CycleState {
  return privateDoc(IMAGINATION_CYCLE_STATE_KIND, state.user_id, state);
}

interface ClaimResult {
  claimed: boolean;
  cycleId: string;
  ordinal: number;
  result: ImaginationCycleResult;
}

/**
 * Claim a cycle row for ONE mission and ONE identity: the first ordinal whose
 * row is free for that scope, or the recorded / in-flight row that already owns
 * the id.
 *
 * THE LOOKUP IS SCOPED (`{user_id, mission_id, cycle_id}`), which is the same
 * granularity as the unique index the claim relies on. A `cycle_id`-only lookup
 * would let a second mission whose (version, ordinal) coincides read — and
 * replay — the first mission's row.
 */
async function claimCycle(
  db: Db,
  args: {
    userId: string;
    missionId: string;
    missionVersion: number;
    requestedCycleId?: string;
    baseOrdinal: number;
    trigger: string;
    actorId: string;
    forced: boolean;
    plateau: PlateauCondition[];
    cooldownRemainingMs: number;
    startedIso: string;
  },
): Promise<ClaimResult> {
  const cycles = cycleCollection(db);
  const scope = { user_id: args.userId, mission_id: args.missionId };
  const requested = nonEmpty(args.requestedCycleId);
  const candidates = requested
    ? [requested]
    : Array.from({ length: MAX_ORDINAL_PROBES }, (_value, step) =>
        cycleIdFor(
          { userId: args.userId, missionId: args.missionId },
          args.missionVersion,
          args.baseOrdinal + step,
        ),
      );

  for (const cycleId of candidates) {
    const ordinal = cycleOrdinalFromId(cycleId) ?? args.baseOrdinal;
    const existing = (await cycles.findOne({ ...scope, cycle_id: cycleId }, { projection: { _id: 0 } })) as
      | unknown as ImaginationCycleRun
      | null;

    if (existing && existing.status === 'completed') {
      // A replay of the SAME cycle: report what was recorded, write nothing.
      return {
        claimed: false,
        cycleId,
        ordinal,
        result: {
          ...skippedResult('recorded_cycle'),
          status: 'replayed',
          cycle_id: cycleId,
          trace_id: existing.trace_id,
          baton_id: existing.baton_id,
          stop_reason: existing.stop_reason,
          stop_conditions: existing.stop_conditions ?? [],
          promoted: existing.promoted,
          promotion_skipped: existing.promotion_skipped,
          budget: existing.budget ?? null,
          portfolio: {
            imagination_run_id: existing.imagination_run_id,
            reused: true,
            seeds_generated: existing.counts?.seeds_generated ?? 0,
            seeds_admitted: existing.counts?.seeds_admitted ?? 0,
            seeds_below_incumbent: existing.counts?.seeds_below_incumbent ?? 0,
            seeds_rejected: existing.counts?.seeds_rejected ?? 0,
            candidates_considered: existing.counts?.candidates_considered ?? 0,
            candidates_eligible: existing.counts?.candidates_eligible ?? 0,
            new_cells: existing.counts?.new_cells ?? 0,
            cells_total: existing.counts?.cells_total ?? 0,
            portfolio_digest: existing.portfolio_digest ?? null,
          },
        },
      };
    }

    if (existing && existing.status === 'running') {
      const startedAt = Date.parse(String(existing.created_at ?? ''));
      if (Number.isFinite(startedAt) && Date.now() - startedAt < CYCLE_CLAIM_GRACE_MS) {
        // Another caller — another process, most likely — is running this cycle.
        return {
          claimed: false,
          cycleId,
          ordinal,
          result: { ...skippedResult('cycle_in_progress'), status: 'replayed', cycle_id: cycleId },
        };
      }
      // Abandoned: record it and step to the next ordinal. The attempt stays on
      // record — a crashed cycle is never silently reused.
      await cycles.updateOne(
        { ...scope, cycle_id: cycleId, status: 'running' },
        {
          $set: {
            status: 'failed',
            error: 'abandoned cycle — no completion recorded within the grace window',
            completed_at: args.startedIso,
          },
        },
      );
      continue;
    }

    if (existing) {
      // A failed row from an earlier attempt: an explicitly requested id is
      // reported as such, a derived one steps to the next ordinal.
      if (requested) {
        return {
          claimed: false,
          cycleId,
          ordinal,
          result: {
            ...skippedResult('cycle_failed_on_record'),
            status: 'replayed',
            cycle_id: cycleId,
            stop_reason: existing.stop_reason,
            error: existing.error ?? null,
          },
        };
      }
      continue;
    }

    const row: ImaginationCycleRun = {
      schema_version: '1.0',
      cycle_id: cycleId,
      user_id: args.userId,
      mission_id: args.missionId,
      mission_version: args.missionVersion,
      trigger: args.trigger,
      actor_id: args.actorId,
      forced: args.forced,
      status: 'running',
      stop_reason: 'completed',
      stop_conditions: [],
      plateau: args.plateau,
      cooldown_remaining_ms: args.cooldownRemainingMs,
      trace_id: null,
      imagination_run_id: null,
      portfolio_digest: null,
      baton_id: null,
      baton_reused: false,
      promoted: false,
      promotion_id: null,
      promotion_skipped: null,
      coverage: null,
      counts: {
        seeds_generated: 0,
        seeds_admitted: 0,
        seeds_below_incumbent: 0,
        seeds_rejected: 0,
        candidates_considered: 0,
        candidates_eligible: 0,
        new_cells: 0,
        cells_total: 0,
      },
      budget: budgetRecord({ cycles: 0, tokens: 0 }, { cycles: 0, tokens: 0 }, 0),
      novelty: { mean_this_cycle: null, previous_mean: null, gain: 0 },
      error: null,
      created_at: args.startedIso,
      completed_at: null,
      duration_ms: 0,
      privacy_audit: { shared_id_written: false, journal_reads: 0, promotions: 0, raw_reflections_included: false },
    };
    try {
      await cycles.insertOne(privateCycle(row));
      return { claimed: true, cycleId, ordinal, result: skippedResult('claimed') };
    } catch (error) {
      if (!/E11000|duplicate key/i.test(errorMessage(error))) throw error;
      continue; // lost the race: the winner's row is picked up on the next pass
    }
  }

  return {
    claimed: false,
    cycleId: candidates[candidates.length - 1],
    ordinal: args.baseOrdinal,
    result: { ...skippedResult('cycle_claim_exhausted'), status: 'replayed' },
  };
}

/** The caller's own cycle rows for a mission, newest first. */
export async function listCycleRuns(
  db: Db,
  userId: string,
  missionId: string,
  limit = 10,
): Promise<ImaginationCycleRun[]> {
  return (await cycleCollection(db)
    .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })
    .sort({ created_at: -1, cycle_id: 1 })
    .limit(Math.min(Math.max(Math.floor(limit) || 1, 1), 50))
    .toArray()) as unknown as ImaginationCycleRun[];
}
