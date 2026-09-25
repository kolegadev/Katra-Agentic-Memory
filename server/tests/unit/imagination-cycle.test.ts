/**
 * ITER-7 — the imagination cycle orchestrator (Phase 5).
 * Contract: CONTRACT-iter7-creative-baton.md §A/§E.
 *
 * What is proved here, against the REAL services (only `llmService.extractJson`
 * is stubbed — no network, no provider):
 *
 *   A. the plateau — all five §4.1 conditions fire with the evidence that
 *      decided them, including the near-misses at each boundary;
 *   B. the gates   — single-flight → PERSISTED cooldown → window budget
 *      (cycles, then measured tokens) → plateau (bypassed only by `force`), in
 *      that order, with a refusal writing NOTHING and calling no model;
 *   B2. the claim  — SCOPED to `{user, mission}`: two missions that share a
 *      (version, ordinal), of the same identity and of different ones, each run
 *      their own cycle with their own trace, baton and rows, and a caller can
 *      never claim a row that belongs to another mission;
 *   C. stop conditions — every one of the brief's §8 conditions is recorded,
 *      with the one that fired named and all of them reported — and the
 *      RETURNED status agrees with the stored row (`ran` vs `failed`);
 *   D. the bounds  — coverage reports what it scanned, the limits and whether a
 *      limit bit;
 *   E. resume      — a FRESH module graph over the same store honours the
 *      persisted cooldown, sees the recorded state and continues the budget;
 *   F. the exit criterion — stalled mission → exactly one cycle → a versioned,
 *      schema-valid, sanitised Creative Baton → ≥1 candidate becomes a
 *      controller work item with provenance → the outcome is recorded (archive
 *      + telemetry + bounded novelty) → after a restart the baton is readable,
 *      the outcome is present and the cooldown still holds;
 *   G. the flags   — off ⇒ the tools are absent, nothing is written and no
 *      model is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

const holder = vi.hoisted(() => ({ db: null as any }));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => holder.db,
  is_database_connected: () => holder.db !== null,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { llmService } from '../../src/services/infrastructure/llm-service.js';
import { beginUsageCall, recordUsageResponse } from '../../src/services/infrastructure/llm-usage-ledger.js';
import {
  OPERATOR_USER,
  OTHER_USER,
  SCENARIO_MISSION,
  defaultResponder,
  offeredSignalIds,
  requestedOperators,
  seedScenario,
} from '../helpers/imagination-scenario.js';
import {
  cooldownRemainingMs,
  cycleIdFor,
  evaluatePlateau,
  listCycleRuns,
  noveltyGains,
  readCycleState,
  runImaginationCycle,
  windowAt,
} from '../../src/services/processing/imagination-cycle-service.js';
import {
  CREATIVE_BATON_COLLECTIONS,
  ensureCreativeBatonIndexes,
} from '../../src/services/processing/creative-baton-collections.js';
import {
  CREATIVE_BATON_TOOL_NAMES,
  dispatchCreativeBatonTool,
} from '../../src/services/processing/creative-baton-tools.js';
import { batonCandidatesToWorkItems, recordCandidateOutcome } from '../../src/services/processing/imagination-outcome-service.js';
import { validateAgainst, SCHEMA_IDS } from '../../src/services/mission-cognition/schema-registry.js';
import { COLLECTIONS } from '../../src/services/mission-cognition/collections.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const OWNER: CallerIdentity = { user_id: OPERATOR_USER, trusted: false };
const OTHER: CallerIdentity = { user_id: 'agent-b', trusted: false };
const OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };

const CYCLES = CREATIVE_BATON_COLLECTIONS.cycles;
/** The fixture submits three deltas, so its mission state sits at version 3. */
const FIXTURE_MISSION_VERSION = 3;
/**
 * The cycle scope the fixture mission runs under. A cycle id is derived from the
 * SCOPE (identity + mission), the mission version and the ordinal, so the same
 * scope+version+ordinal always derives the same id.
 */
const CYCLE_SCOPE = { userId: OPERATOR_USER, missionId: SCENARIO_MISSION };
const STATES = CREATIVE_BATON_COLLECTIONS.cycleStates;
const BATONS = CREATIVE_BATON_COLLECTIONS.creativeBatons;
const OUTCOMES = CREATIVE_BATON_COLLECTIONS.candidateOutcomes;
const SEEDS = 'idea_seeds';
const WORK_ITEMS = COLLECTIONS.cognitiveWorkItems;

/** Every knob this suite sets; cleared before and after each test. */
const KNOBS = [
  'FOCUSED_IMAGINATION',
  'CREATIVE_BATON_PROMOTION',
  'IMAGINATION_CYCLE_COOLDOWN_MS',
  'IMAGINATION_CYCLE_WINDOW_MS',
  'IMAGINATION_CYCLE_MAX_PER_WINDOW',
  'IMAGINATION_CYCLE_MAX_TOKENS_PER_WINDOW',
  'IMAGINATION_PLATEAU_MIN_CANDIDATES',
  'IMAGINATION_PLATEAU_NOVELTY_EPSILON',
  'IMAGINATION_PLATEAU_NOVELTY_ROUNDS',
  'IMAGINATION_PLATEAU_COVERAGE_FLOOR',
  'IMAGINATION_PLATEAU_CONTRADICTION_THRESHOLD',
  'IMAGINATION_COVERAGE_TARGET',
  'IMAGINATION_CANDIDATE_FLOOR',
  'IMAGINATION_PROMOTION_MIN_QUALITY',
];

let db: FakeDb;
const spies: Array<{ mockRestore: () => void }> = [];
let respond: (system: string, prompt: string) => Promise<Record<string, unknown>>;
let prompts: string[] = [];
let tokensPerCall = { input: 0, output: 0 };
const llmCalls = () => prompts.length;

const cycles = () => db.collection(CYCLES).docs as Array<Record<string, any>>;
const batons = () => db.collection(BATONS).docs as Array<Record<string, any>>;
const states = () => db.collection(STATES).docs as Array<Record<string, any>>;
const workItems = () => db.collection(WORK_ITEMS).docs as Array<Record<string, any>>;

function txt(result: Array<{ type: string; text: string }>): string {
  return result.map((row) => row.text).join('\n');
}

/** Re-install the model stub on a module instance (used after `resetModules`). */
function installStub(service: { extractJson: (...args: any[]) => Promise<any> }) {
  const spy = vi.spyOn(service, 'extractJson').mockImplementation((async (
    system: string,
    prompt: string,
  ) => {
    prompts.push(prompt);
    if (tokensPerCall.input > 0 || tokensPerCall.output > 0) {
      const requestId = beginUsageCall('stub', 'test-model');
      recordUsageResponse(requestId, { input_tokens: tokensPerCall.input, output_tokens: tokensPerCall.output });
    }
    return respond(system, prompt);
  }) as never);
  spies.push(spy);
}

beforeEach(() => {
  db = new FakeDb();
  holder.db = db;
  prompts = [];
  tokensPerCall = { input: 0, output: 0 };
  respond = async (system, prompt) => defaultResponder(system, prompt);
  for (const key of KNOBS) delete process.env[key];
  process.env.FOCUSED_IMAGINATION = '1';
  installStub(llmService);
  spies.push(
    vi.spyOn(llmService, 'getServiceStatus').mockReturnValue({
      available: true,
      provider: 'stub',
      model: 'test-model',
      providers: ['stub(ready)'],
    }),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const key of KNOBS) delete process.env[key];
  vi.useRealTimers();
});

// ── A. the plateau ──────────────────────────────────────────────────────────

describe('imagination cycle — the plateau conditions (evidence, not silence)', () => {
  it('reports the firing conditions with their evidence on a stalled mission', async () => {
    await seedScenario(db, { candidates: 0 });
    const evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });

    expect(evaluation.plateau).toBe(true);
    const byName = Object.fromEntries(evaluation.conditions.map((condition) => [condition.name, condition]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        'archive_coverage_below_floor',
        'below_minimum_active_candidates',
        'contradiction_pressure_above_threshold',
        'novelty_gain_below_epsilon',
        'repeated_failure_signature',
      ].sort(),
    );

    // 1. no candidates at all, against a floor of 3
    expect(byName.below_minimum_active_candidates.met).toBe(true);
    expect(byName.below_minimum_active_candidates.evidence).toMatchObject({
      active_candidates: 0,
      minimum: 3,
    });

    // 4. no cells at all, against a floor of 6 — and the coverage SCAN comes with it
    expect(byName.archive_coverage_below_floor.met).toBe(true);
    expect(byName.archive_coverage_below_floor.evidence).toMatchObject({ cells_total: 0, floor: 6 });
    expect(byName.archive_coverage_below_floor.evidence.scan).toMatchObject({
      cells_limit: 500,
      seeds_dedupe_limit: 200,
      truncated: false,
    });

    // 5. no contradiction: the condition is REPORTED and not met (evidence, not silence)
    expect(byName.contradiction_pressure_above_threshold.met).toBe(false);
    expect(byName.contradiction_pressure_above_threshold.evidence).toMatchObject({
      contradictions: 0,
      threshold: 2,
    });

    // 2/3. no history yet: an honest absence, not a plateau claim
    expect(byName.novelty_gain_below_epsilon.met).toBe(false);
    expect(byName.novelty_gain_below_epsilon.evidence).toMatchObject({ rounds: 2, rounds_observed: 0 });
    expect(byName.repeated_failure_signature.met).toBe(false);
    expect(byName.repeated_failure_signature.evidence).toMatchObject({ occurrences: 0, unnecessary_cost_outcomes: 0 });
  });

  it('reports plateau false on a healthy mission, with the five evidences that decided it', async () => {
    await seedScenario(db, { candidates: 6, contradictions: 0 });
    const evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });

    expect(evaluation.plateau).toBe(false);
    for (const condition of evaluation.conditions) {
      expect(condition.met, `${condition.name} should not fire`).toBe(false);
    }
    const coverage = evaluation.conditions.find((c) => c.name === 'archive_coverage_below_floor')!.evidence;
    expect(coverage).toMatchObject({ cells_total: 6, floor: 6 });
    const candidates = evaluation.conditions.find((c) => c.name === 'below_minimum_active_candidates')!.evidence;
    expect(candidates).toMatchObject({ active_candidates: 6, minimum: 3 });
  });

  it('fires each condition exactly at its boundary, and reports the near-miss', async () => {
    await seedScenario(db, { candidates: 3 });
    process.env.IMAGINATION_PLATEAU_MIN_CANDIDATES = '4';
    let evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(evaluation.conditions.find((c) => c.name === 'below_minimum_active_candidates')!.met).toBe(true);
    process.env.IMAGINATION_PLATEAU_MIN_CANDIDATES = '3';
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(evaluation.conditions.find((c) => c.name === 'below_minimum_active_candidates')!.met).toBe(false);

    // Coverage: the three prefilled candidates own three cells, so a floor of 4
    // fires and a floor of 3 (the exact count) does not.
    process.env.IMAGINATION_PLATEAU_COVERAGE_FLOOR = '4';
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    const coverage = evaluation.conditions.find((c) => c.name === 'archive_coverage_below_floor')!;
    expect(coverage.met).toBe(true);
    expect(coverage.evidence).toMatchObject({ cells_total: 3, floor: 4 });
    process.env.IMAGINATION_PLATEAU_COVERAGE_FLOOR = '3';
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(evaluation.conditions.find((c) => c.name === 'archive_coverage_below_floor')!.met).toBe(false);

    // Contradictions: 1 is below the threshold of 2; 2 meets it.
    db.collection(COLLECTIONS.epistemicEntries).docs.push({
      entry_id: 'ent_contradiction_1',
      mission_id: SCENARIO_MISSION,
      entry_type: 'contradiction',
      status: 'active',
    });
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(evaluation.conditions.find((c) => c.name === 'contradiction_pressure_above_threshold')!.met).toBe(false);
    db.collection(COLLECTIONS.epistemicEntries).docs.push({
      entry_id: 'ent_contradiction_2',
      mission_id: SCENARIO_MISSION,
      entry_type: 'contradiction',
      status: 'challenged',
    });
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    const contradiction = evaluation.conditions.find((c) => c.name === 'contradiction_pressure_above_threshold')!;
    expect(contradiction.met).toBe(true);
    expect(contradiction.evidence).toMatchObject({ contradictions: 2, threshold: 2 });

    // Novelty: a gain of 0.02 is below ε=0.05; 0.06 is not; one round is not enough.
    const gated = db.collection(STATES);
    gated.docs.push({
      schema_version: '1.0',
      user_id: OPERATOR_USER,
      mission_id: SCENARIO_MISSION,
      cycle_count: 2,
      last_ordinal: 2,
      window_started_at: new Date().toISOString(),
      cycles_in_window: 2,
      tokens_in_window: 0,
      cooldown_until: null,
      last_run_at: null,
      last_cycle_id: null,
      last_baton_id: null,
      last_stop_reason: null,
      last_new_cells: 0,
      consecutive_no_new_cells: 0,
      novelty_history: [0.9],
      updated_at: new Date().toISOString(),
    });
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(evaluation.conditions.find((c) => c.name === 'novelty_gain_below_epsilon')!.met).toBe(false);

    gated.docs[0].novelty_history = [0.9, 0.96];
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    let novelty = evaluation.conditions.find((c) => c.name === 'novelty_gain_below_epsilon')!;
    expect(novelty.met).toBe(false);
    expect(novelty.evidence).toMatchObject({ gains: [0.06], rounds_observed: 1 });

    gated.docs[0].novelty_history = [0.9, 0.92, 0.93];
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    novelty = evaluation.conditions.find((c) => c.name === 'novelty_gain_below_epsilon')!;
    expect(novelty.met).toBe(true);
    expect(novelty.evidence).toMatchObject({ gains: [0.02, 0.01], rounds_observed: 2 });

    // Repeated failure signature: one failure is an incident, two are a signature.
    db.collection(CYCLES).docs.push({
      cycle_id: 'imagination_cycle_0011223344556677_v3_c9',
      user_id: OPERATOR_USER,
      mission_id: SCENARIO_MISSION,
      status: 'failed',
      stop_reason: 'no_candidate_above_floor',
      created_at: new Date().toISOString(),
    });
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(evaluation.conditions.find((c) => c.name === 'repeated_failure_signature')!.met).toBe(false);
    db.collection(CYCLES).docs.push({
      cycle_id: 'imagination_cycle_0011223344556677_v3_c10',
      user_id: OPERATOR_USER,
      mission_id: SCENARIO_MISSION,
      status: 'failed',
      stop_reason: 'no_candidate_above_floor',
      created_at: new Date().toISOString(),
    });
    evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    const repeated = evaluation.conditions.find((c) => c.name === 'repeated_failure_signature')!;
    expect(repeated.met).toBe(true);
    expect(repeated.evidence).toMatchObject({ repeated_signature: 'no_candidate_above_floor', occurrences: 2 });
  });

  it('treats two candidates that cost without value as a failure signature', async () => {
    await seedScenario(db, { candidates: 6 });
    for (const index of [0, 1]) {
      db.collection(OUTCOMES).docs.push({
        schema_version: '1.0',
        outcome_id: `outcome_${index}`,
        user_id: OPERATOR_USER,
        mission_id: SCENARIO_MISSION,
        seed_id: `seed_prefilled_${index}`,
        outcome: 'unnecessary_cost',
        novelty_replenished: 0,
        recorded_at: new Date().toISOString(),
      });
    }
    const evaluation = await evaluatePlateau(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    const repeated = evaluation.conditions.find((c) => c.name === 'repeated_failure_signature')!;
    expect(repeated.met).toBe(true);
    expect(repeated.evidence).toMatchObject({ unnecessary_cost_outcomes: 2 });
  });

  it('derives gains from persisted means in one place', () => {
    expect(noveltyGains([0.5, 0.55, 0.5])).toEqual([0.05, -0.05]);
    expect(noveltyGains([0.5])).toEqual([]);
    expect(noveltyGains([])).toEqual([]);
    expect(noveltyGains([Number.NaN, 0.5])).toEqual([]);
  });
});

// ── B. the gates ────────────────────────────────────────────────────────────

describe('imagination cycle — the gates, in the contract’s order', () => {
  it('runs exactly one cycle, then skips the next by the PERSISTED cooldown', async () => {
    await seedScenario(db);
    const first = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      actorId: OPERATOR_USER,
      caller: OWNER,
    });
    expect(first.status).toBe('ran');
    expect(first.reason).toBe('completed');
    expect(first.stop_reason).toBe('completed');
    expect(first.cycle_id).toBe(cycleIdFor(CYCLE_SCOPE, FIXTURE_MISSION_VERSION, 1));
    expect(first.baton_id).toMatch(/^cbaton_/);
    const cycleRows = cycles().length;
    const batonRows = batons().length;
    const callsAfterFirst = llmCalls();
    expect(cycleRows).toBe(1);

    const second = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      actorId: OPERATOR_USER,
      caller: OWNER,
    });
    expect(second.status).toBe('skipped');
    expect(second.reason).toBe('cooldown');
    expect(second.cooldown_remaining_ms).toBeGreaterThan(0);
    // NOTHING was written and NO second model call was made.
    expect(cycles()).toHaveLength(cycleRows);
    expect(batons()).toHaveLength(batonRows);
    expect(llmCalls()).toBe(callsAfterFirst);

    // …and the cooldown is the PERSISTED state, not module memory.
    const state = await readCycleState(db.asDb(), OPERATOR_USER, SCENARIO_MISSION);
    expect(state?.last_cycle_id).toBe(first.cycle_id);
    expect(cooldownRemainingMs(state, Date.parse(state!.last_run_at!))).toBeGreaterThan(0);
  });

  it('checks the cooldown BEFORE the budget, and the budget once the cooldown is shrunk', async () => {
    process.env.IMAGINATION_CYCLE_MAX_PER_WINDOW = '1';
    await seedScenario(db);
    const first = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(first.status).toBe('ran');

    const blocked = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(blocked.reason).toBe('cooldown');

    // Shrinking the window takes effect immediately; the budget then refuses.
    process.env.IMAGINATION_CYCLE_COOLDOWN_MS = '1';
    await new Promise((resolve) => setTimeout(resolve, 5));
    const budgeted = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(budgeted.status).toBe('skipped');
    expect(budgeted.reason).toBe('budget_cycles');
    expect(budgeted.budget).toMatchObject({
      max_cycles: 1,
      cycles_in_window_before: 1,
      cycles_in_window_after: 1,
    });
  });

  it('skips on the TOKEN budget with the numbers from the persisted state', async () => {
    await seedScenario(db);
    db.collection(STATES).docs.push({
      schema_version: '1.0',
      user_id: OPERATOR_USER,
      mission_id: SCENARIO_MISSION,
      cycle_count: 1,
      last_ordinal: 1,
      window_started_at: new Date().toISOString(),
      cycles_in_window: 1,
      tokens_in_window: 5000,
      cooldown_until: null,
      last_run_at: null,
      last_cycle_id: cycleIdFor(CYCLE_SCOPE, 1, 1),
      last_baton_id: null,
      last_stop_reason: 'completed',
      last_new_cells: 0,
      consecutive_no_new_cells: 0,
      novelty_history: [],
      updated_at: new Date().toISOString(),
    });
    process.env.IMAGINATION_CYCLE_MAX_TOKENS_PER_WINDOW = '1000';

    const callsBefore = llmCalls();
    const result = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('budget_tokens');
    expect(result.budget).toMatchObject({ max_tokens: 1000, tokens_in_window_before: 5000 });
    expect(llmCalls()).toBe(callsBefore);
  });

  it('skips a healthy mission with no_plateau — and force runs it anyway', async () => {
    await seedScenario(db, { candidates: 6 });
    const callsBefore = llmCalls();
    const skipped = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toBe('no_plateau');
    expect(skipped.plateau?.plateau).toBe(false);
    expect(skipped.plateau?.conditions).toHaveLength(5);
    expect(cycles()).toHaveLength(0);
    expect(llmCalls()).toBe(callsBefore);

    const forced = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      force: true,
      trigger: 'operator_request',
    });
    expect(forced.status).toBe('ran');
    expect(forced.cycle_id).toBe(cycleIdFor(CYCLE_SCOPE, FIXTURE_MISSION_VERSION, 1));
    expect(cycles()[0].forced).toBe(true);
    expect(cycles()[0].trigger).toBe('operator_request');
  });

  it('joins a concurrent caller instead of starting a second cycle (single-flight)', async () => {
    await seedScenario(db);
    const [first, second] = await Promise.all([
      runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION }),
      runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['ran', 'replayed']);
    const joined = [first, second].find((result) => result.status === 'replayed')!;
    expect(joined.reason).toBe('single_flight_join');
    expect(joined.cycle_id).toBe(first.cycle_id === joined.cycle_id ? first.cycle_id : second.cycle_id);
    expect(cycles()).toHaveLength(1);
    expect(batons()).toHaveLength(1);
    // ONE run happened: a single trace run for the cycle and a single
    // imagination run, whatever the two callers did in parallel.
    const traceRuns = db
      .collection('focused_consolidation_runs')
      .docs.filter((row) => String(row.cycle_id).startsWith('imagination_cycle_'));
    expect(traceRuns).toHaveLength(1);
    expect(db.collection('imagination_runs').docs).toHaveLength(1);
  });
});

// ── B2. the claim is scoped to {user, mission} ──────────────────────────────

describe('imagination cycle — a cycle belongs to ONE mission and ONE identity', () => {
  const SECOND_MISSION = 'mission_creative_baton_second';
  const THIRD_MISSION = 'mission_creative_baton_third';

  /**
   * Two missions over the same store, at the SAME mission version — mission
   * versions are per mission, so two active missions sitting at v3 is the
   * ordinary case, not a contrived one. A mission-scoped claim must therefore
   * give each of them its own cycle, trace and baton; a claim keyed on the
   * version + ordinal alone hands the second mission the first one's row.
   */
  const SHARED_MISSION_VERSION = FIXTURE_MISSION_VERSION;

  it('gives two missions of the SAME identity that share (version, ordinal) their own cycle, trace and baton', async () => {
    await seedScenario(db);
    await seedScenario(db, { missionId: SECOND_MISSION, candidates: 0 });

    const a = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      caller: OWNER,
    });
    const b = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SECOND_MISSION,
      caller: OWNER,
    });

    // BOTH missions run their OWN cycle — the second is not a replay of the
    // first.
    expect(a.status).toBe('ran');
    expect(b.status).toBe('ran');

    // …with their own ids. Nothing of A's may appear in B's result.
    expect(b.cycle_id).toBeTruthy();
    expect(b.cycle_id).not.toBe(a.cycle_id);
    expect(b.trace_id).toBeTruthy();
    expect(b.trace_id).not.toBe(a.trace_id);
    expect(b.baton_id).toBeTruthy();
    expect(b.baton_id).not.toBe(a.baton_id);
    expect(b.portfolio?.portfolio_digest).not.toBe(a.portfolio?.portfolio_digest);

    // …and their own ROWS: one cycle row, one baton and one trace per mission.
    const aRows = cycles().filter((row) => row.mission_id === SCENARIO_MISSION);
    const bRows = cycles().filter((row) => row.mission_id === SECOND_MISSION);
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].cycle_id).toBe(b.cycle_id);
    expect(bRows[0].user_id).toBe(OPERATOR_USER);
    expect(bRows[0].trace_id).toBe(b.trace_id);
    expect(bRows[0].baton_id).toBe(b.baton_id);
    expect(aRows[0].trace_id).not.toBe(b.trace_id);

    const bBatons = batons().filter((row) => row.mission_id === SECOND_MISSION);
    expect(bBatons).toHaveLength(1);
    expect(bBatons[0].baton_id).toBe(b.baton_id);
    expect(bBatons[0].user_id).toBe(OPERATOR_USER);
    expect(batons().filter((row) => row.mission_id === SCENARIO_MISSION)).toHaveLength(1);

    // The second mission's cycle wrote the trace it used (the fixture's own
    // trace is a separate row, so the cycle's trace is asserted by id).
    const bTraces = db.collection('salience_traces').docs.filter((row) => row.mission_id === SECOND_MISSION);
    expect(bTraces.some((row) => row.trace_id === b.trace_id)).toBe(true);
    expect(bTraces.every((row) => row.user_id === OPERATOR_USER)).toBe(true);
    expect(db.collection('salience_traces').docs.filter((row) => row.trace_id === a.trace_id)).toHaveLength(1);

    // The derived id itself names the mission and the identity, so the two
    // cannot collide by construction — and the same scope+version+ordinal
    // always derives the same id (which is what makes the claim idempotent).
    const scopeA = { userId: OPERATOR_USER, missionId: SCENARIO_MISSION };
    const scopeB = { userId: OPERATOR_USER, missionId: SECOND_MISSION };
    expect(cycleIdFor(scopeA, SHARED_MISSION_VERSION, 1)).toBe(a.cycle_id);
    expect(cycleIdFor(scopeB, SHARED_MISSION_VERSION, 1)).toBe(b.cycle_id);
    expect(cycleIdFor(scopeA, SHARED_MISSION_VERSION, 1)).not.toBe(
      cycleIdFor(scopeB, SHARED_MISSION_VERSION, 1),
    );
    expect(cycleIdFor(scopeA, SHARED_MISSION_VERSION, 1)).toBe(cycleIdFor(scopeA, SHARED_MISSION_VERSION, 1));
  });

  it('gives a second mission owned by ANOTHER identity its own cycle, never the first mission’s ids', async () => {
    await seedScenario(db);
    await seedScenario(db, { missionId: THIRD_MISSION, ownerId: OTHER_USER, candidates: 0 });

    const a = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      caller: OWNER,
    });
    const c = await runImaginationCycle(db.asDb(), {
      userId: OTHER_USER,
      missionId: THIRD_MISSION,
      caller: OTHER,
    });

    expect(a.status).toBe('ran');
    expect(c.status).toBe('ran'); // ← observed pre-fix as 'replayed'/'recorded_cycle'
    expect(c.cycle_id).not.toBe(a.cycle_id);
    expect(c.trace_id).toBeTruthy();
    expect(c.trace_id).not.toBe(a.trace_id);
    expect(c.baton_id).not.toBe(a.baton_id);

    const cRows = cycles().filter((row) => row.mission_id === THIRD_MISSION);
    expect(cRows).toHaveLength(1);
    expect(cRows[0].user_id).toBe(OTHER_USER);
    expect(cRows[0].cycle_id).toBe(c.cycle_id);
    expect(cRows[0].trace_id).toBe(c.trace_id);
    expect(cRows[0].baton_id).toBe(c.baton_id);
    // The second identity got exactly ONE row — the first mission's cycle was
    // not attributed to it, and it never saw the first mission's ids.
    expect(cycles().filter((row) => row.user_id === OTHER_USER)).toHaveLength(1);

    const cBatons = batons().filter((row) => row.mission_id === THIRD_MISSION);
    expect(cBatons).toHaveLength(1);
    expect(cBatons[0].user_id).toBe(OTHER_USER);
    expect(cBatons[0].baton_id).toBe(c.baton_id);
    expect(batons().filter((row) => row.mission_id === SCENARIO_MISSION)).toHaveLength(1);

    const cTraces = db.collection('salience_traces').docs.filter((row) => row.mission_id === THIRD_MISSION);
    expect(cTraces.some((row) => row.trace_id === c.trace_id)).toBe(true);
    expect(cTraces.every((row) => row.user_id === OTHER_USER)).toBe(true);
    expect(db.collection('salience_traces').docs.filter((row) => row.trace_id === a.trace_id)).toHaveLength(1);
  });

  it('never lets a caller claim another mission’s cycle row by naming its id', async () => {
    await seedScenario(db);
    await seedScenario(db, { missionId: SECOND_MISSION, candidates: 0 });
    const a = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      caller: OWNER,
    });
    expect(a.status).toBe('ran');

    // An explicitly requested id that already belongs to ANOTHER mission is a
    // free id for this mission: the claim keys on {user, mission, cycle_id}, so
    // B runs its own cycle instead of replaying A's row (which is what a
    // cycle_id-only claim did — see the header of the claim).
    const b = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SECOND_MISSION,
      cycleId: a.cycle_id!,
      force: true,
      caller: OWNER,
    });
    expect(b.status).toBe('ran');
    expect(b.trace_id).not.toBe(a.trace_id);
    expect(b.baton_id).not.toBe(a.baton_id);
    const bRows = cycles().filter((row) => row.mission_id === SECOND_MISSION);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].cycle_id).toBe(a.cycle_id);
    expect(bRows[0].user_id).toBe(OPERATOR_USER);
    // The first mission's row is untouched (its own trace/baton are still its).
    const aRows = cycles().filter((row) => row.mission_id === SCENARIO_MISSION);
    expect(aRows).toHaveLength(1);
    expect(aRows[0].trace_id).toBe(a.trace_id);
    expect(aRows[0].baton_id).toBe(a.baton_id);
  });
});

// ── C. stop conditions ──────────────────────────────────────────────────────

describe('imagination cycle — stop conditions are recorded, with the one that fired', () => {
  it('records budget_exhausted with the window numbers', async () => {
    process.env.IMAGINATION_CYCLE_MAX_PER_WINDOW = '1';
    await seedScenario(db);
    const result = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(result.status).toBe('ran');
    expect(result.stop_reason).toBe('budget_exhausted');
    const condition = result.stop_conditions.find((c) => c.name === 'budget_exhausted')!;
    expect(condition.met).toBe(true);
    expect(condition.evidence).toMatchObject({ max_cycles: 1, cycles_in_window: 1 });
    // All of them reported, not just the winner.
    expect(result.stop_conditions.map((c) => c.name)).toHaveLength(9);
    expect(result.stop_conditions.filter((c) => c.met)).toHaveLength(1);
    expect(cycles()[0].stop_reason).toBe('budget_exhausted');
  });

  it('records coverage_target_reached', async () => {
    process.env.IMAGINATION_COVERAGE_TARGET = '2';
    process.env.IMAGINATION_CYCLE_MAX_PER_WINDOW = '5';
    await seedScenario(db);
    const result = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(result.stop_reason).toBe('coverage_target_reached');
    const condition = result.stop_conditions.find((c) => c.name === 'coverage_target_reached')!;
    expect(condition.met).toBe(true);
    expect(Number(condition.evidence.cells_total)).toBeGreaterThanOrEqual(2);
    expect(condition.evidence.coverage_target).toBe(2);
  });

  it('records no_candidate_above_floor when nothing clears the floor', async () => {
    process.env.IMAGINATION_CANDIDATE_FLOOR = '0.99';
    await seedScenario(db);
    const result = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(result.stop_reason).toBe('no_candidate_above_floor');
    const condition = result.stop_conditions.find((c) => c.name === 'no_candidate_above_floor')!;
    expect(condition.met).toBe(true);
    expect(condition.evidence).toMatchObject({ candidates_eligible: 0, floor: 0.99 });
    expect(Number(condition.evidence.candidates_considered)).toBeGreaterThan(0);
    // The baton exists and says the portfolio is empty rather than hiding it.
    expect(result.baton?.candidate_portfolio).toEqual([]);
    expect(result.baton?.counts.candidates_considered).toBeGreaterThan(0);
  });

  it('records no_new_cells_two_rounds after two rounds without a new cell', async () => {
    process.env.IMAGINATION_CYCLE_MAX_PER_WINDOW = '5';
    process.env.IMAGINATION_CYCLE_COOLDOWN_MS = '1';
    await seedScenario(db);
    const first = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(first.portfolio!.new_cells).toBeGreaterThan(0);
    expect(first.stop_reason).toBe('completed');
    expect((await readCycleState(db.asDb(), OPERATOR_USER, SCENARIO_MISSION))?.consecutive_no_new_cells).toBe(0);

    // From here the model restates what the archive already holds (each round's
    // PRNG seed differs, so this is a RESTATEMENT, not a repeat of the same id):
    // every candidate is rejected as a duplicate and the round adds no cell.
    const archived = db
      .collection('idea_seeds')
      .docs.filter((row) => row.state === 'admitted')[0];
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return defaultResponder(system, prompt);
      const signalId = offeredSignalIds(prompt)[0] ?? '';
      return {
        seeds: requestedOperators(prompt).map((operator) => ({
          operator,
          hypothesis: String(archived.hypothesis),
          mechanism: String(archived.mechanism),
          descriptor_bins: archived.bins,
          evidence_refs: [signalId],
          novelty: 0.95,
          coherence: 0.7,
          testability: 0.6,
          expected_information_gain: 0.5,
          cheapest_test: String(archived.cheapest_test),
          parent_seed_ids: [],
        })),
      };
    };
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(second.status).toBe('ran');
    expect(second.portfolio!.new_cells).toBe(0);
    expect(second.stop_reason).toBe('completed');
    expect(second.stop_conditions.find((c) => c.name === 'no_new_cells_two_rounds')!.met).toBe(false);
    expect((await readCycleState(db.asDb(), OPERATOR_USER, SCENARIO_MISSION))?.consecutive_no_new_cells).toBe(1);

    // The SECOND consecutive empty round is the plateau's "no new cell" signal.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(third.status).toBe('ran');
    expect(third.portfolio!.new_cells).toBe(0);
    expect(third.stop_reason).toBe('no_new_cells_two_rounds');
    const condition = third.stop_conditions.find((c) => c.name === 'no_new_cells_two_rounds')!;
    expect(condition.met).toBe(true);
    expect(condition.evidence).toMatchObject({ consecutive_cycles_without_new_cells: 2, new_cells_this_cycle: 0 });
    expect((await readCycleState(db.asDb(), OPERATOR_USER, SCENARIO_MISSION))?.consecutive_no_new_cells).toBe(2);
  });

  it('records promoted_inventory_restored when a high-value candidate is promoted', async () => {
    process.env.CREATIVE_BATON_PROMOTION = '1';
    await seedScenario(db);
    const result = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      caller: OPERATOR,
    });
    expect(result.promoted).toBe(true);
    expect(result.stop_reason).toBe('promoted_inventory_restored');
    const condition = result.stop_conditions.find((c) => c.name === 'promoted_inventory_restored')!;
    expect(condition.met).toBe(true);
    expect(condition.evidence).toMatchObject({ promoted_high_value: true, minimum: 3 });
    expect(batons()[0].shared_id).toBeTruthy();
    expect(cycles()[0].privacy_audit).toMatchObject({ shared_id_written: true, promotions: 1 });
  });

  it('records mission_cancelled_or_superseded without inventing candidates', async () => {
    await seedScenario(db, { status: 'cancelled' });
    const callsBefore = llmCalls();
    const result = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('mission_cancelled_or_superseded');
    expect(result.stop_reason).toBe('mission_cancelled_or_superseded');
    expect(result.error).toMatch(/cancelled/);
    expect(result.trace_id).toBeNull();
    expect(batons()).toHaveLength(0);
    expect(llmCalls()).toBe(callsBefore);
    expect(cycles()).toHaveLength(1);
    expect(cycles()[0].status).toBe('failed');
  });

  it('reports a cycle that failed upstream as `failed`, never as `ran`', async () => {
    await seedScenario(db);
    // The model call dies before the cycle can compile anything.
    respond = async () => {
      throw new Error('provider unavailable');
    };
    const failed = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      caller: OWNER,
    });
    // A caller that reads ONLY `status` must not be told the cycle ran: the
    // stored row is failed, there is no trace and no baton.
    expect(failed.status).toBe('failed');
    expect(failed.reason).toBe('upstream_failure');
    expect(failed.stop_reason).toBe('upstream_failure');
    expect(failed.error).toMatch(/provider unavailable/);
    expect(failed.trace_id).toBeNull();
    expect(failed.portfolio?.imagination_run_id).toBeNull();
    expect(failed.portfolio?.seeds_generated).toBe(0);
    expect(failed.portfolio?.candidates_considered).toBe(0);
    expect(failed.baton_id).toBeNull();
    expect(failed.baton).toBeNull();
    expect(batons()).toHaveLength(0);
    expect(cycles()).toHaveLength(1);
    expect(cycles()[0].status).toBe('failed');
    expect(cycles()[0].stop_reason).toBe('upstream_failure');
    // The attempt is still recorded honestly in the persisted state (it counts
    // against the budget and holds the cooldown), so the status is the only
    // thing that changed — and it now agrees with the row.
    const state = await readCycleState(db.asDb(), OPERATOR_USER, SCENARIO_MISSION);
    expect(state?.cycle_count).toBe(1);
    expect(state?.last_stop_reason).toBe('upstream_failure');
  });

  it('still reports `ran` for a cycle that completed, so the honest status is not a blanket failure', async () => {
    await seedScenario(db);
    const ok = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(ok.status).toBe('ran');
    expect(ok.error).toBeNull();
    expect(ok.baton_id).toBeTruthy();
    expect(ok.stop_reason).not.toBe('upstream_failure');
    expect(ok.stop_reason).not.toBe('privacy_validation_failed');
  });

  it('records privacy_validation_failed when the stored baton was tampered with', async () => {
    await seedScenario(db);
    const first = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(first.baton_id).toBeTruthy();

    // Tamper with the stored baton, then re-run the SAME cycle with promotion
    // on. The compiler would reuse the stored row by `baton_id` — so the reuse
    // path is a read FOR USE and refuses the tampered row by name instead of
    // serving it (and the promoter's own re-validation is the second layer).
    const stored = batons()[0];
    stored.candidate_portfolio[0].hypothesis = 'A hypothesis nobody compiled.';
    process.env.CREATIVE_BATON_PROMOTION = '1';
    process.env.IMAGINATION_CYCLE_COOLDOWN_MS = '1';
    db.collection(CYCLES).deleteMany({});
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      cycleId: first.cycle_id!,
      caller: OPERATOR,
    });
    expect(second.status).toBe('failed');
    expect(second.reason).toBe('privacy_validation_failed');
    expect(second.stop_reason).toBe('privacy_validation_failed');
    expect(second.baton).toBeNull();
    expect(second.promotion_skipped).toBeNull(); // the cycle never reached promotion
    const condition = second.stop_conditions.find((c) => c.name === 'privacy_validation_failed')!;
    expect(condition.met).toBe(true);
    expect(condition.evidence).toMatchObject({ code: 'payload_hash_mismatch' });
    expect(db.collection(CREATIVE_BATON_COLLECTIONS.batonPromotions).docs).toHaveLength(0);
  });
});

// ── D. bounds ───────────────────────────────────────────────────────────────

describe('imagination cycle — a bounded scan is never silent', () => {
  it('reports the coverage scan bounds and a truncated flag, in the view and the baton', async () => {
    await seedScenario(db);
    // The dedupe scan reads at most 200 seeds; 200 rows make that bound BITE.
    for (let index = 0; index < 200; index += 1) {
      db.collection(SEEDS).docs.push({
        seed_id: `seed_bulk_${index}`,
        user_id: OPERATOR_USER,
        mission_id: SCENARIO_MISSION,
        state: 'admitted',
        cycle_id: 'cycle_bulk',
      });
    }
    const result = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    const scan = result.baton!.coverage_summary.scan;
    expect(scan.seeds_dedupe_limit).toBe(200);
    expect(scan.seeds_scanned).toBeGreaterThanOrEqual(200);
    expect(scan.seeds_truncated).toBe(true);
    expect(scan.truncated).toBe(true);
    expect(scan.cells_limit).toBe(500);
    expect(scan.cells_truncated).toBe(false);
    expect(result.baton!.coverage_summary.scan).toEqual(scan);
    const condition = result.stop_conditions.find((c) => c.name === 'coverage_target_reached')!;
    expect(condition.met).toBe(false);
    // The plateau evidence carries the same scan.
    const coverageEvidence = result.plateau!.conditions.find((c) => c.name === 'archive_coverage_below_floor')!.evidence;
    expect(coverageEvidence).toMatchObject({ truncated: true });
  });
});

// ── E. resume ───────────────────────────────────────────────────────────────

describe('imagination cycle — resume semantics (a fresh module graph)', () => {
  /** Re-import the cycle service with a FRESH module registry over the same store. */
  async function freshCycleModule() {
    vi.resetModules();
    const freshLlm = await import('../../src/services/infrastructure/llm-service.js');
    installStub(freshLlm.llmService);
    spies.push(
      vi.spyOn(freshLlm.llmService, 'getServiceStatus').mockReturnValue({
        available: true,
        provider: 'stub',
        model: 'test-model',
        providers: ['stub(ready)'],
      }),
    );
    return import('../../src/services/processing/imagination-cycle-service.js');
  }

  it('honours the persisted cooldown after a restart and continues the budget', async () => {
    await seedScenario(db);
    const first = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(first.status).toBe('ran');
    const callsAfterFirst = llmCalls();
    const cyclesAfterFirst = cycles().length;
    const batonsAfterFirst = batons().length;

    // ── a FRESH module graph: new module state, same store ──────────────────
    const fresh = await freshCycleModule();
    const reread = await fresh.readCycleState(db.asDb(), OPERATOR_USER, SCENARIO_MISSION);
    expect(reread?.cycle_count).toBe(1);
    expect(reread?.last_cycle_id).toBe(first.cycle_id);

    const blocked = await fresh.runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
    });
    expect(blocked.status).toBe('skipped');
    expect(blocked.reason).toBe('cooldown');
    expect(blocked.cooldown_remaining_ms).toBeGreaterThan(0);
    expect(cycles()).toHaveLength(cyclesAfterFirst);
    expect(batons()).toHaveLength(batonsAfterFirst);
    expect(llmCalls()).toBe(callsAfterFirst);

    // Shrinking the cooldown window lets the NEXT cycle run — and the budget
    // accounting CONTINUES from the stored row rather than restarting.
    process.env.IMAGINATION_CYCLE_COOLDOWN_MS = '1';
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await fresh.runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
    });
    expect(second.status).toBe('ran');
    expect(second.cycle_id).toBe(cycleIdFor(CYCLE_SCOPE, FIXTURE_MISSION_VERSION, 2));
    expect(second.budget).toMatchObject({ cycles_in_window_before: 1, cycles_in_window_after: 2 });

    const stateAfter = await fresh.readCycleState(db.asDb(), OPERATOR_USER, SCENARIO_MISSION);
    expect(stateAfter?.cycle_count).toBe(2);
    expect(stateAfter?.cycles_in_window).toBe(2);
    expect(stateAfter?.novelty_history.length).toBe(2);
    expect(cycles()).toHaveLength(cyclesAfterFirst + 1);
  });

  it('replays a recorded cycle instead of running a second one', async () => {
    await seedScenario(db);
    const first = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      cycleId: 'cycle_explicit',
    });
    expect(first.status).toBe('ran');
    const callsAfterFirst = llmCalls();

    // The cooldown is a GATE and it is checked before the claim — so a repeat
    // inside the cooldown is `cooldown`, and the replay happens once the window
    // allows a cycle at all (which is exactly what a restart sees).
    const fresh = await freshCycleModule();
    const blocked = await fresh.runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      cycleId: 'cycle_explicit',
      force: true,
    });
    expect(blocked.status).toBe('skipped');
    expect(blocked.reason).toBe('cooldown');
    process.env.IMAGINATION_CYCLE_COOLDOWN_MS = '1';
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await fresh.runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      cycleId: 'cycle_explicit',
      force: true,
    });
    expect(replay.status).toBe('replayed');
    expect(replay.reason).toBe('recorded_cycle');
    expect(replay.baton_id).toBe(first.baton_id);
    expect(replay.stop_reason).toBe(first.stop_reason);
    expect(llmCalls()).toBe(callsAfterFirst);
    expect(cycles()).toHaveLength(1);
  });

  it('steps over an abandoned cycle row instead of wedging the mission', async () => {
    await seedScenario(db);
    // A crashed attempt: a running row, old enough that it cannot be live.
    db.collection(CYCLES).docs.push({
      schema_version: '1.0',
      cycle_id: cycleIdFor(CYCLE_SCOPE, FIXTURE_MISSION_VERSION, 1),
      user_id: OPERATOR_USER,
      mission_id: SCENARIO_MISSION,
      status: 'running',
      stop_reason: 'completed',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      counts: {},
    });
    const result = await runImaginationCycle(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(result.status).toBe('ran');
    expect(result.cycle_id).toBe(cycleIdFor(CYCLE_SCOPE, FIXTURE_MISSION_VERSION, 2));
    const abandoned = cycles().find((row) => row.cycle_id === cycleIdFor(CYCLE_SCOPE, FIXTURE_MISSION_VERSION, 1))!;
    expect(abandoned.status).toBe('failed');
    expect(abandoned.error).toMatch(/abandoned/);
  });
});

// ── F. the exit criterion ───────────────────────────────────────────────────

describe('imagination cycle — the exit criterion, end to end', () => {
  it('stalled mission → one cycle → baton → work item → outcome → restart', async () => {
    process.env.CREATIVE_BATON_PROMOTION = '1';
    await seedScenario(db);

    // 1. the stalled mission runs EXACTLY ONE cycle
    const cycle = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      actorId: OPERATOR_USER,
      caller: OPERATOR,
    });
    expect(cycle.status).toBe('ran');
    expect(cycles()).toHaveLength(1);

    // 2. a versioned, schema-valid, sanitised baton exists (and is promoted)
    const baton = batons()[0];
    expect(baton.creative_baton_version).toBe('1.0');
    expect(validateAgainst(SCHEMA_IDS.creativeBaton, baton).valid).toBe(true);
    expect(baton.shared_id).toBeTruthy();
    expect(baton.privacy).toEqual({ raw_reflections_included: false, shared: true });
    expect(baton.candidate_portfolio.length).toBeGreaterThan(0);
    expect(Object.keys(baton)).not.toContain('evidence_refs');

    // 3. ≥1 candidate becomes a controller work item, with provenance
    const adapted = await batonCandidatesToWorkItems(db.asDb(), {
      userId: OPERATOR_USER,
      batonId: baton.baton_id,
      caller: OWNER,
    });
    expect(adapted.created).toBeGreaterThan(0);
    const item = workItems().find((row) => row.provenance?.source === 'creative_baton')!;
    expect(item.provenance).toMatchObject({ baton_id: baton.baton_id, source: 'creative_baton' });
    expect(item.mission_id).toBe(SCENARIO_MISSION);
    expect(item.trigger).toBe('manual');
    expect(item.mode).toBe('explore');
    expect(item.status).toBe('queued');
    expect(item.description).toContain(baton.baton_id);
    expect(item.provenance.seed_id).toMatch(/^seed_/);
    // Idempotent: a second call inserts nothing.
    const again = await batonCandidatesToWorkItems(db.asDb(), {
      userId: OPERATOR_USER,
      batonId: baton.baton_id,
      caller: OWNER,
    });
    expect(again.created).toBe(0);
    expect(again.reused).toBe(adapted.created);
    expect(workItems().filter((row) => row.provenance?.source === 'creative_baton')).toHaveLength(adapted.created);

    // 4. the outcome is recorded: archive + telemetry + bounded novelty
    const seedId = String(item.provenance.seed_id);
    const outcome = await recordCandidateOutcome(db.asDb(), {
      userId: OPERATOR_USER,
      seedId,
      batonId: baton.baton_id,
      outcome: 'useful_information',
      detail: 'the cheapest test separated the two readings within one cycle',
    });
    expect(outcome.recorded).toBe(true);
    expect(outcome.novelty_replenished).toBe(0.05);
    expect(outcome.novelty_cap_remaining).toBeCloseTo(0.15, 6);
    expect(outcome.lineage_updated).toBe(true);
    expect(outcome.telemetry_evaluation_id).toBeTruthy();
    expect(db.collection('idea_lineages').docs.some((row) => (row.results ?? []).length > 0)).toBe(true);
    expect(db.collection(COLLECTIONS.triggerEvaluations).docs).toHaveLength(1);
    expect(db.collection(COLLECTIONS.triggerEvaluations).docs[0]).toMatchObject({
      trigger: 'imagination_candidate',
      outcome: 'useful_information',
    });

    // 5. a RESTART: the baton is readable, the outcome is present and the
    //    cooldown still holds.
    const callsBefore = llmCalls();
    vi.resetModules();
    const freshLlm = await import('../../src/services/infrastructure/llm-service.js');
    installStub(freshLlm.llmService);
    spies.push(
      vi.spyOn(freshLlm.llmService, 'getServiceStatus').mockReturnValue({
        available: true,
        provider: 'stub',
        model: 'test-model',
        providers: ['stub(ready)'],
      }),
    );
    const freshTools = await import('../../src/services/processing/creative-baton-tools.js');
    const freshCycle = await import('../../src/services/processing/imagination-cycle-service.js');
    const freshOutcomes = await import('../../src/services/processing/imagination-outcome-service.js');

    const readBack = await freshTools.dispatchCreativeBatonTool('get_creative_baton', { baton_id: baton.baton_id }, OWNER);
    expect(txt(readBack)).toContain(baton.baton_id);
    expect(txt(readBack)).toContain('useful_information');

    const recorded = await freshOutcomes.listCandidateOutcomes(db.asDb(), OPERATOR_USER, SCENARIO_MISSION);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ seed_id: seedId, outcome: 'useful_information' });

    const blocked = await freshCycle.runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
    });
    expect(blocked.status).toBe('skipped');
    expect(blocked.reason).toBe('cooldown');
    expect(blocked.cooldown_remaining_ms).toBeGreaterThan(0);
    expect(llmCalls()).toBe(callsBefore);
    expect(cycles()).toHaveLength(1);
  });
});

// ── G. the flags ────────────────────────────────────────────────────────────

describe('imagination cycle — the flags fail closed', () => {
  it('with FOCUSED_IMAGINATION off the whole ITER-7 surface is Unknown tool', async () => {
    await seedScenario(db);
    delete process.env.FOCUSED_IMAGINATION;
    const callsBefore = llmCalls();
    const cyclesBefore = JSON.stringify(cycles());
    const batonsBefore = JSON.stringify(batons());

    for (const name of CREATIVE_BATON_TOOL_NAMES) {
      await expect(
        dispatchCreativeBatonTool(name, { mission_id: SCENARIO_MISSION, baton_id: 'cbaton_x' }, OWNER),
      ).rejects.toThrow(`Unknown tool: ${name}`);
    }
    expect(cycles()).toEqual(JSON.parse(cyclesBefore));
    expect(batons()).toEqual(JSON.parse(batonsBefore));
    expect(llmCalls()).toBe(callsBefore);
    expect(db.collection(COLLECTIONS.triggerEvaluations).docs).toHaveLength(0);
  });

  it('with the promotion flag off, promotion is Unknown tool and the cycle writes no shared scope', async () => {
    await seedScenario(db);
    await expect(
      dispatchCreativeBatonTool('promote_creative_baton', { baton_id: 'cbaton_x' }, OPERATOR),
    ).rejects.toThrow('Unknown tool: promote_creative_baton');
    process.env.CREATIVE_BATON_PROMOTION = '1';
    // Registered again with both flags on.
    const promoted = await dispatchCreativeBatonTool(
      'promote_creative_baton',
      { baton_id: 'cbaton_missing' },
      OPERATOR,
    );
    expect(txt(promoted)).toContain('baton_not_found');

    delete process.env.CREATIVE_BATON_PROMOTION;
    const cycle = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      caller: OPERATOR,
    });
    expect(cycle.status).toBe('ran');
    expect(cycle.promoted).toBe(false);
    expect(cycle.promotion_skipped).toBe('flag_off');
    expect(batons()[0].shared_id).toBeUndefined();
    expect(db.collection(CREATIVE_BATON_COLLECTIONS.batonPromotions).docs).toHaveLength(0);
    expect(batons()[0].privacy.shared).toBe(false);
  });

  it('the tools surface the plateau and the persisted gates without writing (evaluate_only)', async () => {
    await seedScenario(db);
    process.env.IMAGINATION_CYCLE_MAX_PER_WINDOW = '1';
    db.collection(STATES).docs.push({
      schema_version: '1.0',
      user_id: OPERATOR_USER,
      mission_id: SCENARIO_MISSION,
      cycle_count: 1,
      last_ordinal: 1,
      window_started_at: new Date().toISOString(),
      cycles_in_window: 1,
      tokens_in_window: 10,
      cooldown_until: null,
      last_run_at: null,
      last_cycle_id: null,
      last_baton_id: null,
      last_stop_reason: null,
      last_new_cells: 0,
      consecutive_no_new_cells: 0,
      novelty_history: [],
      updated_at: new Date().toISOString(),
    });
    const callsBefore = llmCalls();
    const rowsBefore = JSON.stringify({ cycles: cycles(), batons: batons(), states: states() });

    const evaluated = await dispatchCreativeBatonTool(
      'run_imagination_cycle',
      { mission_id: SCENARIO_MISSION, mode: 'evaluate_only' },
      OWNER,
    );
    const rendered = txt(evaluated);
    expect(rendered).toContain('Evaluate-only');
    expect(rendered).toContain('below_minimum_active_candidates');
    expect(rendered).toContain('**Window budget:** cycles 1/1');
    expect(rendered).toContain('**Cooldown remaining:** 0ms');

    // The `dry_run` alias behaves identically, and neither writes anything.
    const dryRun = await dispatchCreativeBatonTool(
      'run_imagination_cycle',
      { mission_id: SCENARIO_MISSION, dry_run: true },
      OWNER,
    );
    expect(txt(dryRun)).toContain('Evaluate-only');
    expect(llmCalls()).toBe(callsBefore);
    expect(JSON.stringify({ cycles: cycles(), batons: batons(), states: states() })).toBe(rowsBefore);
  });

  it('reports a promotion refusal as a readable line, and a run as a cycle summary', async () => {
    await seedScenario(db);
    process.env.CREATIVE_BATON_PROMOTION = '1';
    const run = await dispatchCreativeBatonTool('run_imagination_cycle', { mission_id: SCENARIO_MISSION }, OWNER);
    const rendered = txt(run);
    expect(rendered).toContain('`ran`');
    expect(rendered).toContain('**Stop conditions evaluated**');
    expect(rendered).toContain('**Promotion:** skipped (`untrusted_caller`)');
    const batonId = batons()[0].baton_id as string;

    const refused = await dispatchCreativeBatonTool('promote_creative_baton', { baton_id: batonId }, OWNER);
    expect(txt(refused)).toContain('untrusted_caller');
    // A trusted caller names the identity the baton belongs to (its own id
    // would be `not_owner`, which the security suite pins as well).
    const promoted = await dispatchCreativeBatonTool(
      'promote_creative_baton',
      { baton_id: batonId, user_id: OPERATOR_USER },
      OPERATOR,
    );
    expect(txt(promoted)).toContain('Promoted');
    expect(txt(promoted)).toContain('my-team');

    const read = await dispatchCreativeBatonTool('get_creative_baton', { baton_id: batonId }, OTHER);
    expect(txt(read)).toContain(batonId);

    const adapted = await dispatchCreativeBatonTool('baton_candidates_to_work_items', { baton_id: batonId }, OTHER);
    expect(txt(adapted)).toContain('controller queue');
    const seedId = String(workItems().find((row) => row.provenance)?.provenance?.seed_id);
    const outcome = await dispatchCreativeBatonTool(
      'record_candidate_outcome',
      { seed_id: seedId, baton_id: batonId, outcome: 'useful_information' },
      OWNER,
    );
    expect(txt(outcome)).toContain('Recorded `useful_information`');
    const repeated = await dispatchCreativeBatonTool(
      'record_candidate_outcome',
      { seed_id: seedId, baton_id: batonId, outcome: 'useful_information' },
      OWNER,
    );
    expect(txt(repeated)).toContain('Repeat');
  });

  it('the ITER-7 modules import no journal writer, use no randomUUID and no Math.random', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      'imagination-cycle-service.ts',
      'imagination-cycle-config.ts',
      'creative-baton-collections.ts',
      'creative-baton-compiler.ts',
      'creative-baton-promotion.ts',
      'creative-baton-tools.ts',
      'imagination-outcome-service.ts',
    ];
    for (const file of files) {
      const source = readFileSync(join(here, '../../src/services/processing', file), 'utf8');
      const imports = [...source.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gms)].map((match) => match[1]);
      for (const specifier of imports) {
        expect(
          /reflection-store|sleep-consolidation|reflection-writer|journal-writer|consolidation-output-bus/.test(specifier),
          `${file} must not import ${specifier}`,
        ).toBe(false);
      }
      expect(source, `${file} must not name a journal writer`).not.toMatch(
        /ReflectionStore|SleepConsolidationService|upsertJournal|consolidationOutputBus/,
      );
      expect(source, `${file} must not write to a journal collection`).not.toMatch(
        /(insertOne|updateOne|updateMany|deleteMany|bulkWrite|replaceOne)\s*\([^)]{0,200}(reflective_journals|reflection_nodes|reflection_edges|consolidation_runs)/s,
      );
      // The one shared scope this feature writes goes through the policy — no
      // module asserts a literal shared_id of its own.
      expect(source, `${file} must not set a literal shared_id`).not.toMatch(
        /shared_id\s*:\s*(?:'[^']*'|"[^"]*"|`[^`]*`)/,
      );
      for (const pattern of [/Math\.random\(\)/g, /randomUUID\(\)/g]) {
        for (const match of source.matchAll(pattern)) {
          const lineStart = source.lastIndexOf('\n', match.index ?? 0) + 1;
          const line = source.slice(lineStart, (match.index ?? 0) + match[0].length);
          expect(/^\s*(\/\/|\*|\/\*)/.test(line), `${file} calls ${match[0]} outside a comment`).toBe(true);
        }
      }
    }
  });

  it('keeps the unlisted surfaces private (no shared scope on the cycle rows or the outcomes)', async () => {
    process.env.CREATIVE_BATON_PROMOTION = '1';
    await seedScenario(db);
    const cycle = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      caller: OPERATOR,
    });
    const seedId = batons()[0].candidate_portfolio[0].seed_id;
    await recordCandidateOutcome(db.asDb(), { userId: OPERATOR_USER, seedId, outcome: 'mere_variance' });
    for (const name of [CYCLES, STATES, OUTCOMES, SEEDS]) {
      for (const row of db.collection(name).docs) {
        expect(row, `${name} row must carry no shared scope`).not.toHaveProperty('shared_id');
      }
    }
    expect(cycle.promoted).toBe(true);
    expect(batons()[0].shared_id).toBe('my-team');
  });
});
