/**
 * Idea Verification Service — the falsification half of the imagination loop
 * (ITER-11, WS-5 item 1 · brief §5.2 + §3.2 "run the cheapest discriminating
 * test first", the "Learn" step of §3.2).
 *
 * Before this iteration the cheap test was a STRING on every seed: nothing
 * ranked it, nothing checked that executing it was permitted, and the failure
 * signatures the brief asks to feed back into operator selection were stored on
 * the lineage and read by nothing. This module supplies the three missing
 * pieces and nothing else:
 *
 *   - `rankCheapTests` — deterministic ranking of the admitted candidates'
 *     cheap tests by EXPECTED INFORMATION GAIN ÷ COST, so the cheapest
 *     discriminating test runs first. Cost is the seed's test-strategy class
 *     (a documented relative ladder) unless the caller supplies a MEASURED
 *     cost, which always wins; an unmeasured cost is 1, never 0 — an
 *     unmeasured test is not assumed free. Ties break deterministically on the
 *     seed id, so two callers with the same store always agree on the order.
 *
 *   - `executePermittedTest` — records the verdict of ONE ranked test through
 *     the EXISTING outcome channel (`recordCandidateOutcome`, which owns the
 *     novelty replenishment, the telemetry row and the lineage update) and
 *     refuses, BY NAME, anything the mission's authority gates do not permit:
 *     the flag, the caller, a missing/terminal mission, a candidate that is not
 *     this mission's admitted seed, a test that is not on the ranked plan, and
 *     a required authority class above the mission's own. Authority to GENERATE
 *     an idea is not authority to EXECUTE its proposed action (invariant 5):
 *     this service RECORDS a verdict — it never runs the action the test
 *     describes, and a test requiring an authority class the mission does not
 *     hold is refused rather than downgraded.
 *
 *   - `recordFailureSignature` — a persisted, BOUNDED per-identity/mission
 *     record of why a candidate failed, which `imagination-service`'s operator
 *     plan reads back as a bounded, deterministic PRIOR (see
 *     `loadOperatorPriors`): operators whose tests keep failing are demoted on
 *     the plan's own score, operators with useful outcomes get a smaller
 *     bounded boost, and the adjustment is documented on the plan entry's
 *     `reason`/`prior` fields — the brief's "feed outcomes back into operator
 *     priors".
 */
import type { Db } from 'mongodb';
import {
  CANDIDATE_OUTCOMES,
  recordCandidateOutcome,
  type CandidateOutcome,
  type CandidateOutcomeResult,
} from './imagination-outcome-service.js';
import { focusedImaginationEnabled } from './focused-consolidation-service.js';
import { IdeaArchiveService, privateDoc, type IdeaSeed } from './idea-archive-service.js';
import type { OperatorPriorAdjustment, OperatorPriorInput } from './imagination-operators.js';
import { COLLECTIONS } from '../mission-cognition/collections.js';
import { MissionStateService } from '../mission-cognition/mission-state-service.js';
import type { AuthorityClass } from '../../types/cognitive-control.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';

// ── The test-cost ladder ────────────────────────────────────────────────────

/**
 * The relative cost of a test, by the seed's `test_strategy` bin. A CHEAP test
 * is not a short one: the ladder says what it costs to RUN the class of test,
 * and the ranking divides the expected information gain by it. Measured costs
 * supplied by a caller replace the ladder value for that candidate — a
 * measured number is always better than a documented assumption.
 */
export const TEST_STRATEGY_COST: Record<string, number> = {
  cheapest_probe: 1,
  kill_criterion: 1,
  observation_study: 2,
  instrumentation: 3,
  ab_test: 4,
  simulation: 5,
};

/** An unmeasured cost is 1: never 0, so a rank is never a division by zero. */
export const DEFAULT_TEST_COST = 1;

/**
 * The authority class a test needs before it may be executed at all. Only the
 * two probe classes are open at the lowest authority; a study, an experiment or
 * a simulation needs the mission to hold the corresponding class.
 */
export const TEST_STRATEGY_AUTHORITY: Record<string, AuthorityClass> = {
  cheapest_probe: 'C',
  kill_criterion: 'C',
  observation_study: 'B',
  instrumentation: 'B',
  ab_test: 'A',
  simulation: 'A',
};

/** A, B, C — A is the widest authority (see `AuthorityClass`). */
export const AUTHORITY_RANK: Record<string, number> = { A: 3, B: 2, C: 1 };

/** The mission authority that an unclassified test requires by default. */
export const DEFAULT_TEST_AUTHORITY: AuthorityClass = 'B';

export function authorityRank(value: unknown): number {
  return AUTHORITY_RANK[String(value ?? '')] ?? 0;
}

/** True when `missionAuthority` may execute a test that needs `required`. */
export function authorityPermits(missionAuthority: unknown, required: unknown): boolean {
  const have = authorityRank(missionAuthority);
  const need = authorityRank(required);
  return need > 0 && have >= need;
}

// ── Ranking ────────────────────────────────────────────────────────────────

export interface RankCheapTestsOptions {
  /** Measured costs by seed id (tokens or any consistent unit) — they WIN. */
  costs?: Record<string, number>;
  /** The mission's authority class, stamped on every ranked test. */
  missionAuthority?: AuthorityClass | string | null;
  /** How many ranked tests to return (the rest are counted, never dropped). */
  limit?: number;
}

export interface RankedCheapTest {
  rank: number;
  seed_id: string;
  operator: string;
  cheapest_test: string;
  expected_information_gain: number;
  /** The cost the rank divided by, and where it came from. */
  cost: number;
  cost_source: 'measured' | 'test_strategy_ladder' | 'default';
  test_strategy: string | null;
  /** expected information gain ÷ cost, to 6 decimals. */
  score: number;
  authority_required: AuthorityClass;
  /** True when the mission's own authority class permits this test. */
  permitted: boolean;
  basis: string;
}

export interface RankCheapTestsResult {
  tests: RankedCheapTest[];
  considered: number;
  /** Ranked but beyond `limit` (counted, so a bound is never silent). */
  omitted_by_limit: number;
  /** Refused by the mission's own authority gates (counted, never hidden). */
  refused_by_authority: number;
  basis: string;
}

/** The cost of one candidate's test, and where the number came from. */
export function testCostFor(
  seed: Pick<IdeaSeed, 'seed_id' | 'bins'>,
  measured?: Record<string, number>,
): { cost: number; source: RankedCheapTest['cost_source']; strategy: string | null } {
  const supplied = Number(measured?.[seed.seed_id]);
  if (Number.isFinite(supplied) && supplied > 0) {
    return { cost: Math.max(supplied, DEFAULT_TEST_COST), source: 'measured', strategy: null };
  }
  const strategy = (seed.bins as Record<string, unknown> | undefined)?.['test_strategy'];
  const name = typeof strategy === 'string' && strategy.length > 0 ? strategy : null;
  const ladder = name ? TEST_STRATEGY_COST[name] : undefined;
  if (ladder !== undefined) return { cost: ladder, source: 'test_strategy_ladder', strategy: name };
  return { cost: DEFAULT_TEST_COST, source: 'default', strategy: name };
}

/**
 * Rank the cheap tests of a set of admitted candidates: highest expected
 * information gain per unit cost first ("the cheapest discriminating test
 * first"), ties broken on the seed id so the order is a function of the store
 * alone.
 */
export function rankCheapTests(
  candidates: readonly IdeaSeed[],
  options: RankCheapTestsOptions = {},
): RankCheapTestsResult {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : candidates.length;
  const rows: Array<Omit<RankedCheapTest, 'rank' | 'permitted' | 'basis'> & { _permitted: boolean }> = [];
  let refusedByAuthority = 0;

  for (const seed of candidates) {
    const test = String(seed.cheapest_test ?? '').trim();
    if (test.length === 0) continue;
    const { cost, source, strategy } = testCostFor(seed, options.costs);
    const eig = Number.isFinite(Number(seed.expected_information_gain))
      ? Math.min(1, Math.max(0, Number(seed.expected_information_gain)))
      : 0;
    const required = (strategy ? TEST_STRATEGY_AUTHORITY[strategy] : undefined) ?? DEFAULT_TEST_AUTHORITY;
    const permitted = authorityPermits(options.missionAuthority, required);
    if (!permitted) refusedByAuthority += 1;
    rows.push({
      seed_id: String(seed.seed_id),
      operator: String(seed.operator ?? ''),
      cheapest_test: test,
      expected_information_gain: eig,
      cost,
      cost_source: source,
      test_strategy: strategy,
      score: Number((eig / cost).toFixed(6)),
      authority_required: required,
      _permitted: permitted,
    });
  }

  rows.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.seed_id.localeCompare(right.seed_id);
  });
  const kept = rows.slice(0, limit);
  const tests: RankedCheapTest[] = kept.map((row, index) => {
    const { _permitted, ...rest } = row;
    return {
      rank: index + 1,
      ...rest,
      permitted: _permitted,
      basis:
        `expected_information_gain ${rest.expected_information_gain} ÷ cost ${rest.cost} ` +
        `(${rest.cost_source}${rest.test_strategy ? `, test_strategy ${rest.test_strategy}` : ''}) = ${rest.score}; ` +
        `authority ${rest.authority_required} ${_permitted ? 'permitted' : 'REFUSED'} by the mission's own class`,
    };
  });

  return {
    tests,
    considered: rows.length,
    omitted_by_limit: Math.max(0, rows.length - kept.length),
    refused_by_authority: refusedByAuthority,
    basis:
      `${rows.length} admitted candidate(s) with a cheap test ranked by expected information gain ÷ cost ` +
      '(cheapest discriminating test first), ties on seed id; cost is the measured value when supplied, else the ' +
      'documented test-strategy ladder, else 1',
  };
}

// ── Failure signatures (persisted, bounded) ─────────────────────────────────

/** The collection the signatures live in (private, identity-scoped). */
export const FAILURE_SIGNATURE_COLLECTION = 'idea_failure_signatures';
/** How many signature rows one {identity, mission} keeps. */
export const MAX_FAILURE_SIGNATURES = 48;

export interface FailureSignatureRow {
  schema_version: '1.0';
  kind: 'failure_signature';
  signature_id: string;
  user_id: string;
  mission_id: string;
  seed_id: string | null;
  operator: string | null;
  /** The stable, comparable reason — a slug, never free text. */
  signature: string;
  detail: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface RecordFailureSignatureArgs {
  userId: string;
  missionId: string;
  signature: string;
  seedId?: string | null;
  operator?: string | null;
  detail?: string | null;
  caller?: CallerIdentity;
  now?: () => string;
}

export interface RecordFailureSignatureResult {
  recorded: boolean;
  code: FailureSignatureRefusal | null;
  reason: string;
  row: FailureSignatureRow | null;
  /** Bounded totals for the {identity, mission} after this write. */
  rows: number;
  pruned: number;
}

export type FailureSignatureRefusal = 'invalid_args' | 'untrusted_caller' | 'signature_too_long';

/** A signature is a slug: stable, comparable, and never a carrier for text. */
const SIGNATURE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function normalizeSignature(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Record one failure signature for a candidate. The row is keyed by
 * {identity, mission, signature, seed} and BOUNDED: once the mission holds
 * `MAX_FAILURE_SIGNATURES` distinct rows the oldest are pruned, so a hostile
 * loop cannot grow the collection without limit. Repeating a signature
 * increments its `count` instead of inserting a second row.
 */
export async function recordFailureSignature(
  db: Db,
  args: RecordFailureSignatureArgs,
): Promise<RecordFailureSignatureResult> {
  const refuse = (code: FailureSignatureRefusal, reason: string): RecordFailureSignatureResult => ({
    recorded: false,
    code,
    reason,
    row: null,
    rows: 0,
    pruned: 0,
  });
  const userId = typeof args?.userId === 'string' ? args.userId.trim() : '';
  const missionId = typeof args?.missionId === 'string' ? args.missionId.trim() : '';
  if (!userId || !missionId) return refuse('invalid_args', 'userId and missionId are required');
  if (args.caller && !args.caller.trusted && args.caller.user_id !== userId) {
    return refuse('untrusted_caller', `caller '${args.caller.user_id}' may not record a signature for '${userId}'`);
  }
  const raw = typeof args.signature === 'string' ? args.signature : '';
  if (raw.length > 128) {
    return refuse('signature_too_long', `signature is ${raw.length} characters — the limit is 128`);
  }
  const signature = normalizeSignature(raw);
  if (!signature || !SIGNATURE_PATTERN.test(signature)) {
    return refuse('invalid_args', 'signature must be a non-empty slug (letters, digits, underscore)');
  }
  const seedId = typeof args.seedId === 'string' && args.seedId.trim().length > 0 ? args.seedId.trim() : null;
  const operator = typeof args.operator === 'string' && args.operator.trim().length > 0 ? args.operator.trim() : null;
  const now = args.now ?? (() => new Date().toISOString());
  const at = now();

  const collection = db.collection(FAILURE_SIGNATURE_COLLECTION);
  const existing = (await collection.findOne({
    user_id: userId,
    mission_id: missionId,
    signature,
    seed_id: seedId,
  })) as unknown as FailureSignatureRow | null;

  if (existing) {
    const updated: FailureSignatureRow = {
      ...existing,
      count: Number(existing.count ?? 0) + 1,
      last_seen_at: at,
      detail: typeof args.detail === 'string' && args.detail.length > 0 ? args.detail.slice(0, 500) : existing.detail ?? null,
      operator: operator ?? existing.operator ?? null,
    };
    await collection.updateOne(
      { user_id: userId, mission_id: missionId, signature, seed_id: seedId },
      { $set: privateDoc(FAILURE_SIGNATURE_COLLECTION, userId, updated) },
    );
    return {
      recorded: true,
      code: null,
      reason: `signature '${signature}' counted again (${updated.count}×)`,
      row: updated,
      rows: await collection.countDocuments({ user_id: userId, mission_id: missionId }),
      pruned: 0,
    };
  }

  const row: FailureSignatureRow = {
    schema_version: '1.0',
    kind: 'failure_signature',
    signature_id: `fsig_${signature.slice(0, 24)}_${(seedId ?? 'mission').slice(-8)}`,
    user_id: userId,
    mission_id: missionId,
    seed_id: seedId,
    operator,
    signature,
    detail: typeof args.detail === 'string' && args.detail.length > 0 ? args.detail.slice(0, 500) : null,
    count: 1,
    first_seen_at: at,
    last_seen_at: at,
  };
  await collection.updateOne(
    { user_id: userId, mission_id: missionId, signature, seed_id: seedId },
    { $set: privateDoc(FAILURE_SIGNATURE_COLLECTION, userId, row) },
    { upsert: true },
  );

  // BOUNDED: keep the newest MAX_FAILURE_SIGNATURES rows for this
  // {identity, mission}; the oldest are pruned and counted. The order is
  // (last_seen_at desc, signature_id desc): rows written in the SAME
  // millisecond still prune deterministically, so "which row was dropped" is a
  // function of the store and not of the store's sort stability.
  const all = (await collection
    .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0, signature_id: 1, last_seen_at: 1 } })
    .limit(MAX_FAILURE_SIGNATURES * 4)
    .toArray()) as unknown as Array<{ signature_id: string; last_seen_at: string }>;
  const ordered = [...all].sort((left, right) => {
    const byTime = String(right.last_seen_at ?? '').localeCompare(String(left.last_seen_at ?? ''));
    if (byTime !== 0) return byTime;
    return String(right.signature_id ?? '').localeCompare(String(left.signature_id ?? ''));
  });
  const doomed = ordered.slice(MAX_FAILURE_SIGNATURES);
  for (const victim of doomed) {
    await collection.deleteOne({ user_id: userId, mission_id: missionId, signature_id: victim.signature_id });
  }
  return {
    recorded: true,
    code: null,
    reason: `signature '${signature}' recorded${doomed.length > 0 ? ` (${doomed.length} older row(s) pruned to stay within ${MAX_FAILURE_SIGNATURES})` : ''}`,
    row,
    rows: ordered.length - doomed.length,
    pruned: doomed.length,
  };
}

/** The mission's signature rows, newest first (bounded read, deterministic ties). */
export async function listFailureSignatures(
  db: Db,
  userId: string,
  missionId: string,
  limit = MAX_FAILURE_SIGNATURES,
): Promise<FailureSignatureRow[]> {
  const rows = (await db
    .collection(FAILURE_SIGNATURE_COLLECTION)
    .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })
    .limit(Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_FAILURE_SIGNATURES * 2))
    .toArray()) as unknown as FailureSignatureRow[];
  return [...rows].sort((left, right) => {
    const byTime = String(right.last_seen_at ?? '').localeCompare(String(left.last_seen_at ?? ''));
    if (byTime !== 0) return byTime;
    return String(right.signature_id ?? '').localeCompare(String(left.signature_id ?? ''));
  });
}

// ── Operator priors (the "Learn" step) ──────────────────────────────────────

/** The bonus per useful outcome (smaller than the failure penalty). */
export const PRIOR_USEFUL_STEP = 0.05;
/** The demotion per signature occurrence. */
export const PRIOR_FAILURE_STEP = 0.08;
/** The bound on any single operator's adjustment, in either direction. */
export const MAX_PRIOR_ADJUSTMENT = 0.24;

export interface OperatorPrior {
  operator: string;
  failures: number;
  useful: number;
  /** The bounded adjustment applied to the operator's plan score. */
  adjustment: number;
  note: string;
}

export interface OperatorPriors extends OperatorPriorInput {
  /** The signatures behind them (counts only — never candidate text). */
  signatures: Array<{ signature: string; operator: string | null; count: number }>;
  basis: string;
}

/**
 * Read the persisted failure signatures and useful outcomes of one mission and
 * turn them into BOUNDED, deterministic operator priors. The adjustment is
 * `useful × 0.05 − failures × 0.08`, clamped to ±0.24 — one recorded outcome can
 * nudge the plan, but nothing can order it around, and the same store always
 * produces the same priors.
 *
 * TOTAL by construction: a read that fails yields NO priors (the plan is then
 * exactly the pre-iteration plan) with the failure named in `basis`, because
 * the LEARN step must never be able to break a cycle.
 */
export async function loadOperatorPriors(
  db: Db,
  args: { userId: string; missionId: string },
): Promise<OperatorPriors> {
  const userId = String(args?.userId ?? '').trim();
  const missionId = String(args?.missionId ?? '').trim();
  if (!userId || !missionId) {
    return { adjustments: {}, priors: [], signatures: [], basis: 'no identity/mission supplied — no priors were read' };
  }
  try {
    return await readOperatorPriors(db, userId, missionId);
  } catch (error) {
    return {
      adjustments: {},
      priors: [],
      signatures: [],
      basis:
        `the prior read failed (${String((error as Error)?.message ?? error)}) — no adjustment was applied, so the ` +
        'plan is the unadjusted one',
    };
  }
}

async function readOperatorPriors(db: Db, userId: string, missionId: string): Promise<OperatorPriors> {
  const signatures = await listFailureSignatures(db, userId, missionId);
  const byOperator = new Map<string, { failures: number; signatures: string[] }>();
  for (const row of signatures) {
    const operator = row.operator ? String(row.operator) : null;
    if (!operator) continue;
    const entry = byOperator.get(operator) ?? { failures: 0, signatures: [] };
    entry.failures += Math.max(1, Number(row.count ?? 1));
    entry.signatures.push(String(row.signature));
    byOperator.set(operator, entry);
  }

  const usefulRows = (await db
    .collection(COLLECTIONS.triggerEvaluations)
    .find(
      { mission_id: missionId, trigger: 'imagination_candidate', outcome: 'useful_information' },
      { projection: { _id: 0, evaluation_id: 1 } },
    )
    .limit(200)
    .toArray()
    .catch(() => [] as unknown[])) as unknown[];
  const usefulTotal = usefulRows.length;

  const priors: OperatorPriorAdjustment[] = [];
  const adjustments: Record<string, number> = {};
  for (const [operator, entry] of [...byOperator.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const useful = usefulTotal;
    const raw = useful * PRIOR_USEFUL_STEP - entry.failures * PRIOR_FAILURE_STEP;
    const adjustment = Number(Math.max(-MAX_PRIOR_ADJUSTMENT, Math.min(MAX_PRIOR_ADJUSTMENT, raw)).toFixed(6));
    adjustments[operator] = adjustment;
    priors.push({
      operator,
      failures: entry.failures,
      useful,
      adjustment,
      note:
        `${entry.failures} recorded failure signature(s) against ${useful} useful outcome(s): ` +
        `plan-score adjustment ${adjustment >= 0 ? '+' : ''}${adjustment} ` +
        `(±${MAX_PRIOR_ADJUSTMENT} bound, steps ${PRIOR_FAILURE_STEP}/${PRIOR_USEFUL_STEP})`,
    });
  }

  return {
    adjustments,
    priors,
    signatures: signatures.map((row) => ({
      signature: String(row.signature),
      operator: row.operator ? String(row.operator) : null,
      count: Number(row.count ?? 1),
    })),
    basis:
      `${signatures.length} persisted failure-signature row(s) and ${usefulTotal} useful outcome row(s) for this ` +
      `mission; each operator's adjustment is useful×${PRIOR_USEFUL_STEP} − failures×${PRIOR_FAILURE_STEP}, ` +
      `clamped to ±${MAX_PRIOR_ADJUSTMENT}`,
  };
}

// ── Executing a permitted test ──────────────────────────────────────────────

export type TestExecutionRefusal =
  | 'flag_off'
  | 'untrusted_caller'
  | 'invalid_args'
  | 'mission_not_found'
  | 'mission_terminal'
  | 'candidate_not_found'
  | 'seed_not_admitted'
  | 'test_not_ranked'
  | 'authority_exceeded';

export interface ExecutePermittedTestArgs {
  userId: string;
  missionId: string;
  seedId: string;
  /** The verdict the operator/harness observed. */
  outcome: CandidateOutcome;
  batonId?: string | null;
  detail?: string | null;
  /** The test's required authority class (defaults to the candidate's own). */
  authorityRequired?: AuthorityClass;
  /** A measured cost for the ranking (tokens or any consistent unit). */
  measuredCost?: number | null;
  caller: CallerIdentity;
  now?: () => string;
}

export interface ExecutePermittedTestResult {
  permitted: boolean;
  code: TestExecutionRefusal | null;
  reason: string;
  /** The ranked test this verdict was recorded for. */
  test: RankedCheapTest | null;
  outcome: CandidateOutcomeResult | null;
  failure_signature: FailureSignatureRow | null;
  ranked: RankCheapTestsResult | null;
  mission_authority: string | null;
  basis: string;
}

/**
 * Record the verdict of ONE ranked cheap test, through the existing outcome
 * channel, refusing everything the mission's authority gates do not permit.
 * Nothing is executed here: the caller brings back what the test showed, and
 * this function decides whether the mission was allowed to run it at all and
 * records the result.
 */
export async function executePermittedTest(
  db: Db,
  args: ExecutePermittedTestArgs,
): Promise<ExecutePermittedTestResult> {
  const refuse = (
    code: TestExecutionRefusal,
    reason: string,
    extra: Partial<ExecutePermittedTestResult> = {},
  ): ExecutePermittedTestResult => ({
    permitted: false,
    code,
    reason,
    test: null,
    outcome: null,
    failure_signature: null,
    ranked: null,
    mission_authority: extra.mission_authority ?? null,
    basis: reason,
    ...extra,
  });

  if (!focusedImaginationEnabled()) {
    return refuse(
      'flag_off',
      'FOCUSED_IMAGINATION is off — the verification surface is disabled (no back door)',
    );
  }
  const userId = typeof args?.userId === 'string' ? args.userId.trim() : '';
  const missionId = typeof args?.missionId === 'string' ? args.missionId.trim() : '';
  const seedId = typeof args?.seedId === 'string' ? args.seedId.trim() : '';
  if (!userId || !missionId || !seedId) {
    return refuse('invalid_args', 'userId, missionId and seedId are required');
  }
  if (!args.caller || (!args.caller.trusted && args.caller.user_id !== userId)) {
    return refuse(
      'untrusted_caller',
      `caller '${args?.caller?.user_id ?? '(none)'}' may not verify a candidate of '${userId}'`,
    );
  }
  if (!(CANDIDATE_OUTCOMES as readonly string[]).includes(String(args.outcome))) {
    return refuse('invalid_args', `outcome must be one of ${CANDIDATE_OUTCOMES.join(' | ')}`);
  }

  const mission = await new MissionStateService(db).getMissionState(missionId);
  if (!mission) return refuse('mission_not_found', `mission state not found: ${missionId}`);
  if (mission.status === 'cancelled' || mission.status === 'completed') {
    return refuse(
      'mission_terminal',
      `mission ${missionId} is ${mission.status}: no test may be executed for it`,
      { mission_authority: String(mission.authority_class ?? '') || null },
    );
  }
  if (mission.owner_id !== userId) {
    return refuse(
      'untrusted_caller',
      `mission ${missionId} is owned by '${mission.owner_id}', not '${userId}'`,
      { mission_authority: String(mission.authority_class ?? '') || null },
    );
  }

  const archive = new IdeaArchiveService(db);
  const seeds = await archive.getSeeds(userId, missionId);
  const seed = seeds.find((row) => row.seed_id === seedId) ?? null;
  if (!seed) return refuse('candidate_not_found', `no candidate ${seedId} in the archive of ${missionId}`);
  if (seed.state !== 'admitted') {
    return refuse('seed_not_admitted', `candidate ${seedId} is ${seed.state}, not admitted — nothing to test`);
  }

  const costs = Number.isFinite(Number(args.measuredCost)) && Number(args.measuredCost) > 0
    ? { [seedId]: Number(args.measuredCost) }
    : undefined;
  const ranked = rankCheapTests(seeds.filter((row) => row.state === 'admitted'), {
    costs,
    missionAuthority: mission.authority_class,
  });
  const test = ranked.tests.find((row) => row.seed_id === seedId) ?? null;
  if (!test) {
    return refuse(
      'test_not_ranked',
      `candidate ${seedId} offers no ranked cheap test (its cheapest_test is empty) — nothing may be executed`,
      { mission_authority: String(mission.authority_class ?? '') || null, ranked },
    );
  }
  const required = args.authorityRequired ?? test.authority_required;
  if (!authorityPermits(mission.authority_class, required)) {
    return refuse(
      'authority_exceeded',
      `the test needs authority ${required} and mission ${missionId} holds ${mission.authority_class}: ` +
        'generating an idea is not authority to execute its proposed action',
      { test, mission_authority: String(mission.authority_class ?? '') || null, ranked },
    );
  }

  const outcome = await recordCandidateOutcome(db, {
    userId,
    seedId,
    outcome: args.outcome,
    batonId: args.batonId ?? null,
    detail: args.detail ?? null,
    now: args.now,
  });
  if (!outcome.recorded) {
    // The channel is the authority on whether a verdict landed: reporting
    // "permitted" over a verdict that was not recorded would be a lie.
    return refuse(
      'candidate_not_found',
      `the outcome channel did not record the verdict: ${outcome.reason}`,
      { test, mission_authority: String(mission.authority_class ?? '') || null, ranked },
    );
  }

  // The verdict is also a SIGNATURE when it failed: the "Learn" input.
  let signature: FailureSignatureRow | null = null;
  if (args.outcome !== 'useful_information') {
    const recorded = await recordFailureSignature(db, {
      userId,
      missionId,
      signature: `${args.outcome}_${String(seed.operator ?? 'unknown')}`,
      seedId,
      operator: String(seed.operator ?? '') || null,
      detail: args.detail ?? `verdict recorded by ${args.caller.user_id}`,
      caller: args.caller,
      now: args.now,
    });
    signature = recorded.row;
  }

  return {
    permitted: true,
    code: null,
    reason:
      `test rank ${test.rank} executed and its verdict recorded through the outcome channel ` +
      `(${args.outcome}); mission authority ${mission.authority_class} permits ${required}`,
    test,
    outcome,
    failure_signature: signature,
    ranked,
    mission_authority: String(mission.authority_class ?? '') || null,
    basis:
      `${seeds.length} archived candidate(s) ranked by expected information gain ÷ cost; the verdict went through ` +
      'recordCandidateOutcome (novelty replenishment, telemetry and lineage stay in that one channel)' +
      (signature ? '; the non-useful verdict was persisted as a bounded failure signature' : ''),
  };
}
