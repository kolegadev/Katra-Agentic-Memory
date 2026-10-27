/**
 * ITER-11, WS-5 item 1 (DoD `IdeaVerificationService` + the "Learn" step).
 *
 * Contract: "`idea-verification-service.ts` — `rankCheapTests` (deterministic:
 * expected information gain ÷ cost, with the brief's 'cheapest discriminating
 * test first'), `executePermittedTest` (records a verdict through the existing
 * outcome channel; refuses anything not permitted by the mission's authority
 * gates), `recordFailureSignature` (persisted, bounded) — and wire failure
 * signatures into the imagination service's operator priors (a bounded,
 * deterministic adjustment of operator selection documented in the plan's
 * `reason`)".
 *
 * Every block below fails against the pre-iteration sources: no
 * `idea-verification-service.ts` existed, `planOperators` had no prior input
 * (`score === adjusted_score` always), and nothing read a failure signature.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
import {
  OPERATOR_USER,
  SCENARIO_MISSION,
  defaultResponder,
  seedMission,
  seedScenario,
} from '../helpers/imagination-scenario.js';
import {
  DEFAULT_TEST_COST,
  MAX_FAILURE_SIGNATURES,
  MAX_PRIOR_ADJUSTMENT,
  PRIOR_FAILURE_STEP,
  PRIOR_USEFUL_STEP,
  executePermittedTest,
  listFailureSignatures,
  loadOperatorPriors,
  rankCheapTests,
  recordFailureSignature,
  testCostFor,
} from '../../src/services/processing/idea-verification-service.js';
import { IdeaArchiveService, type IdeaSeed } from '../../src/services/processing/idea-archive-service.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const OWNER: CallerIdentity = { user_id: OPERATOR_USER, trusted: false };
const OTHER: CallerIdentity = { user_id: 'agent-b', trusted: false };
const OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };

let db: FakeDb;
const spies: Array<{ mockRestore: () => void }> = [];

const seed = (overrides: Partial<IdeaSeed> = {}): IdeaSeed =>
  ({
    seed_id: 'seed_00000000000000000000000000000001',
    user_id: OPERATOR_USER,
    mission_id: SCENARIO_MISSION,
    operator: 'assumption_inversion',
    hypothesis: 'a claim',
    mechanism: 'a mechanism',
    descriptor_bins: ['removal', 'prose', 'necessity', 'operational_state', 'cheapest_probe'],
    bins: { mechanism: 'removal', representation: 'prose', violated_assumption: 'necessity', evidence_family: 'operational_state', test_strategy: 'cheapest_probe' },
    evidence_refs: [],
    novelty_score: 0.8,
    coherence_score: 0.7,
    testability_score: 0.6,
    cheapest_test: 'probe the queue head once',
    expected_information_gain: 0.5,
    parent_seed_ids: [],
    lineage_ref: 'lineage_00000000000000000000000000000001',
    cell_key: 'cell',
    quality: 0.6,
    rank: 0,
    state: 'admitted',
    incumbent: true,
    created_at: '2026-09-26T00:00:00.000Z',
    ...overrides,
  }) as unknown as IdeaSeed;

beforeEach(() => {
  db = new FakeDb();
  holder.db = db;
  delete process.env.FOCUSED_IMAGINATION;
  const spy = vi.spyOn(llmService, 'extractJson').mockImplementation((async (system: string, prompt: string) =>
    defaultResponder(system, prompt)) as never);
  spies.push(spy);
  spies.push(
    vi.spyOn(llmService, 'getServiceStatus').mockReturnValue({
      available: true,
      provider: 'stub',
      model: 'test-model',
      providers: ['stub(ready)'],
    } as never),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  delete process.env.FOCUSED_IMAGINATION;
});

describe('rankCheapTests — expected information gain ÷ cost, cheapest first', () => {
  it('ranks a cheap probe above a simulation with the same expected information gain', () => {
    const probe = seed({ seed_id: 'seed_a', bins: { test_strategy: 'cheapest_probe' } as never, expected_information_gain: 0.4 });
    const simulation = seed({ seed_id: 'seed_b', bins: { test_strategy: 'simulation' } as never, expected_information_gain: 0.4 });
    const ranked = rankCheapTests([simulation, probe], { missionAuthority: 'A' });
    expect(ranked.tests.map((row) => row.seed_id)).toEqual(['seed_a', 'seed_b']);
    expect(ranked.tests[0].cost).toBe(1);
    expect(ranked.tests[0].cost_source).toBe('test_strategy_ladder');
    expect(ranked.tests[0].score).toBe(0.4);
    expect(ranked.tests[1].cost).toBe(5);
    expect(ranked.tests[1].score).toBe(0.08);
  });

  it('is deterministic: identical inputs rank identically, and ties break on the seed id', () => {
    const rows = [
      seed({ seed_id: 'seed_b', expected_information_gain: 0.5 }),
      seed({ seed_id: 'seed_a', expected_information_gain: 0.5 }),
    ];
    const first = rankCheapTests(rows, { missionAuthority: 'A' });
    const second = rankCheapTests([...rows].reverse(), { missionAuthority: 'A' });
    expect(first.tests.map((row) => row.seed_id)).toEqual(['seed_a', 'seed_b']);
    expect(JSON.stringify(first.tests)).toBe(JSON.stringify(second.tests));
  });

  it('a MEASURED cost always wins over the documented ladder', () => {
    const probe = seed({ seed_id: 'seed_a', expected_information_gain: 0.4 });
    const measured = rankCheapTests([probe], { missionAuthority: 'A', costs: { seed_a: 8 } });
    expect(measured.tests[0].cost).toBe(8);
    expect(measured.tests[0].cost_source).toBe('measured');
    expect(measured.tests[0].score).toBe(0.05);
    // An unmeasured cost is 1, never 0 (no division by zero, and no free test).
    const zero = rankCheapTests([probe], { missionAuthority: 'A', costs: { seed_a: 0 } });
    expect(zero.tests[0].cost).toBe(DEFAULT_TEST_COST);
    expect(testCostFor(seed({ bins: {} as never })).cost).toBe(DEFAULT_TEST_COST);
  });

  it('counts the tests the mission authority does not permit, and the ones a limit omitted', () => {
    const rows = [
      seed({ seed_id: 'seed_a', bins: { test_strategy: 'ab_test' } as never }),
      seed({ seed_id: 'seed_b', bins: { test_strategy: 'cheapest_probe' } as never }),
      seed({ seed_id: 'seed_c', bins: { test_strategy: 'simulation' } as never }),
    ];
    const asC = rankCheapTests(rows, { missionAuthority: 'C' });
    expect(asC.refused_by_authority).toBe(2);
    // Ranked by expected information gain ÷ cost: the probe leads; the two
    // A-class tests follow (they are ranked, and marked REFUSED by the class).
    expect(asC.tests.map((row) => [row.seed_id, row.permitted])).toEqual([
      ['seed_b', true],
      ['seed_a', false],
      ['seed_c', false],
    ]);
    expect(asC.tests[0].basis).toContain('permitted');
    expect(asC.tests[1].basis).toContain('REFUSED');
    const limited = rankCheapTests(rows, { missionAuthority: 'A', limit: 1 });
    expect(limited.tests).toHaveLength(1);
    expect(limited.considered).toBe(3);
    expect(limited.omitted_by_limit).toBe(2);
    expect(limited.basis).toContain('cheapest discriminating test first');
  });
});

describe('executePermittedTest — records a verdict, refuses what the gates forbid', () => {
  async function admittedFixture(): Promise<{ seedId: string; archive: IdeaArchiveService }> {
    await seedMission(db, { missionId: SCENARIO_MISSION, ownerId: OPERATOR_USER });
    const archive = new IdeaArchiveService(db.asDb());
    const { candidateSeed } = await import('../helpers/imagination-scenario.js');
    const result = await archive.admitOrReplace(
      candidateSeed(0, {
        mission_id: SCENARIO_MISSION,
        user_id: OPERATOR_USER,
        bins: { test_strategy: 'cheapest_probe' } as never,
      }),
    );
    expect(result.decision).toBe('admitted');
    return { seedId: result.seed!.seed_id, archive };
  }

  it('refuses with the flag off, before reading anything (no back door)', async () => {
    const { seedId } = await admittedFixture();
    const result = await executePermittedTest(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      seedId,
      outcome: 'useful_information',
      caller: OWNER,
    });
    expect(result.permitted).toBe(false);
    expect(result.code).toBe('flag_off');
    expect(db.collection('idea_candidate_outcomes').docs).toHaveLength(0);
    expect(db.collection('idea_failure_signatures').docs).toHaveLength(0);
  });

  it('refuses a foreign caller, a missing mission, a terminal mission and a non-admitted candidate', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const { seedId } = await admittedFixture();
    const base = {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      seedId,
      outcome: 'useful_information' as const,
    };

    const foreign = await executePermittedTest(db.asDb(), { ...base, caller: OTHER });
    expect(foreign.code).toBe('untrusted_caller');

    const missing = await executePermittedTest(db.asDb(), { ...base, missionId: 'mission_nope', caller: OWNER });
    expect(missing.code).toBe('mission_not_found');

    (db.collection('mission_states').docs[0] as Record<string, any>).status = 'cancelled';
    const terminal = await executePermittedTest(db.asDb(), { ...base, caller: OWNER });
    expect(terminal.code).toBe('mission_terminal');
    expect(terminal.reason).toContain('cancelled');
    (db.collection('mission_states').docs[0] as Record<string, any>).status = 'active';

    const unknown = await executePermittedTest(db.asDb(), { ...base, seedId: 'seed_not_here', caller: OWNER });
    expect(unknown.code).toBe('candidate_not_found');

    // A rejected seed cannot be verified: only ADMITTED candidates have a plan.
    (db.collection('idea_seeds').docs[0] as Record<string, any>).state = 'rejected';
    const rejected = await executePermittedTest(db.asDb(), { ...base, caller: OWNER });
    expect(rejected.code).toBe('seed_not_admitted');
  });

  it('refuses a test whose authority class the mission does not hold', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const { seedId } = await admittedFixture();
    // The mission's own class is B; an A-class test (ab_test/simulation) is out.
    const result = await executePermittedTest(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      seedId,
      outcome: 'useful_information',
      authorityRequired: 'A',
      caller: OWNER,
    });
    expect(result.permitted).toBe(false);
    expect(result.code).toBe('authority_exceeded');
    expect(result.reason).toContain('generating an idea is not authority to execute its proposed action');
    expect(result.mission_authority).toBe('B');
    expect(db.collection('idea_candidate_outcomes').docs).toHaveLength(0);
  });

  it('records a permitted verdict through the EXISTING outcome channel (telemetry, lineage, novelty)', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const { seedId } = await admittedFixture();
    const result = await executePermittedTest(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      seedId,
      outcome: 'useful_information',
      detail: 'the probe separated the two readings within one cycle',
      caller: OWNER,
    });
    expect(result.permitted).toBe(true);
    expect(result.code).toBeNull();
    expect(result.test?.rank).toBe(1);
    expect(result.outcome?.recorded).toBe(true);
    expect(result.outcome?.novelty_replenished).toBeGreaterThan(0);
    expect(result.outcome?.telemetry_evaluation_id).toBeTruthy();
    // The outcome channel's own row, telemetry row and lineage update.
    expect(db.collection('idea_candidate_outcomes').docs).toHaveLength(1);
    expect(db.collection('trigger_evaluations').docs).toHaveLength(1);
    expect(db.collection('idea_lineages').docs.some((row: any) => (row.results ?? []).length > 0)).toBe(true);
    // A USEFUL verdict is not a failure: no signature row.
    expect(db.collection('idea_failure_signatures').docs).toHaveLength(0);
  });

  it('persists a non-useful verdict as a bounded failure signature', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const { seedId } = await admittedFixture();
    const result = await executePermittedTest(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      seedId,
      outcome: 'unnecessary_cost',
      detail: 'the probe cost a cycle and settled nothing',
      caller: OWNER,
    });
    expect(result.permitted).toBe(true);
    expect(result.failure_signature).toBeTruthy();
    const rows = db.collection('idea_failure_signatures').docs as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].signature).toBe('unnecessary_cost_assumption_inversion');
    expect(rows[0].user_id).toBe(OPERATOR_USER);
    expect(rows[0].count).toBe(1);
    // Personal by construction: the write-scope policy strips every shared id.
    expect(rows[0].shared_id ?? null).toBeNull();
    expect(result.basis).toContain('failure signature');
  });
});

describe('recordFailureSignature — persisted, bounded, and hostile-safe', () => {
  it('counts a repeated signature instead of inserting a second row, and prunes past the bound', async () => {
    await seedMission(db, { missionId: SCENARIO_MISSION, ownerId: OPERATOR_USER });
    const first = await recordFailureSignature(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      signature: 'no_candidate_above_floor',
      seedId: 'seed_x',
      operator: 'causal_reversal',
    });
    expect(first.recorded).toBe(true);
    expect(first.row?.count).toBe(1);
    const second = await recordFailureSignature(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      signature: 'no_candidate_above_floor',
      seedId: 'seed_x',
      operator: 'causal_reversal',
    });
    expect(second.row?.count).toBe(2);
    expect(db.collection('idea_failure_signatures').docs).toHaveLength(1);

    // Fill past the bound: the oldest rows are pruned and COUNTED.
    for (let index = 0; index < MAX_FAILURE_SIGNATURES + 5; index += 1) {
      await recordFailureSignature(db.asDb(), {
        userId: OPERATOR_USER,
        missionId: SCENARIO_MISSION,
        signature: `signature_${index}`,
        seedId: `seed_${index}`,
        operator: 'assumption_inversion',
      });
    }
    const rows = db.collection('idea_failure_signatures').docs as Array<Record<string, any>>;
    expect(rows.length).toBe(MAX_FAILURE_SIGNATURES);
    // The oldest (the very first signature) is the one gone.
    expect(rows.some((row) => row.signature === 'no_candidate_above_floor')).toBe(false);
    const listed = await listFailureSignatures(db.asDb(), OPERATOR_USER, SCENARIO_MISSION);
    expect(listed.length).toBe(MAX_FAILURE_SIGNATURES);
  });

  it('refuses a hostile signature by name and never writes a field outside the shape', async () => {
    await seedMission(db, { missionId: SCENARIO_MISSION, ownerId: OPERATOR_USER });
    const tooLong = await recordFailureSignature(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      signature: `x${'y'.repeat(200)}`,
    });
    expect(tooLong.recorded).toBe(false);
    expect(tooLong.code).toBe('signature_too_long');

    const empty = await recordFailureSignature(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      signature: '!!!',
    });
    expect(empty.recorded).toBe(false);
    expect(empty.code).toBe('invalid_args');

    const foreign = await recordFailureSignature(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      signature: 'ok_slug',
      caller: OTHER,
    });
    expect(foreign.recorded).toBe(false);
    expect(foreign.code).toBe('untrusted_caller');

    const missing = await recordFailureSignature(db.asDb(), {
      userId: '',
      missionId: SCENARIO_MISSION,
      signature: 'ok_slug',
    });
    expect(missing.code).toBe('invalid_args');
    expect(db.collection('idea_failure_signatures').docs).toHaveLength(0);
  });
});

describe('loadOperatorPriors — the bounded Learn input', () => {
  it('turns signatures and useful outcomes into a clamped, deterministic adjustment', async () => {
    await seedMission(db, { missionId: SCENARIO_MISSION, ownerId: OPERATOR_USER });
    for (let index = 0; index < 10; index += 1) {
      await recordFailureSignature(db.asDb(), {
        userId: OPERATOR_USER,
        missionId: SCENARIO_MISSION,
        signature: `failure_${index}`,
        seedId: `seed_${index}`,
        operator: 'causal_reversal',
      });
    }
    // Two useful outcomes (the trigger-telemetry rows the outcome channel writes).
    for (let index = 0; index < 2; index += 1) {
      db.collection('trigger_evaluations').docs.push({
        evaluation_id: `out_${index}`,
        mission_id: SCENARIO_MISSION,
        trigger: 'imagination_candidate',
        outcome: 'useful_information',
        fired_at: '2026-09-26T00:00:00.000Z',
      });
    }

    const priors = await loadOperatorPriors(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(priors.signatures).toHaveLength(10);
    const raw = 2 * PRIOR_USEFUL_STEP - 10 * PRIOR_FAILURE_STEP;
    expect(raw).toBeLessThan(-MAX_PRIOR_ADJUSTMENT);
    expect(priors.adjustments.causal_reversal).toBe(-MAX_PRIOR_ADJUSTMENT); // clamped
    expect(priors.priors[0].failures).toBe(10);
    expect(priors.priors[0].useful).toBe(2);
    expect(priors.priors[0].note).toContain(`±${MAX_PRIOR_ADJUSTMENT} bound`);
    expect(priors.basis).toContain('clamped');

    // Deterministic: the same store yields the same priors.
    const again = await loadOperatorPriors(db.asDb(), { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(JSON.stringify(again)).toBe(JSON.stringify(priors));
  });

  it('is total: a failing read yields NO priors instead of breaking the caller', async () => {
    const broken = {
      collection: () => {
        throw new Error('store unavailable');
      },
    } as never;
    const priors = await loadOperatorPriors(broken, { userId: OPERATOR_USER, missionId: SCENARIO_MISSION });
    expect(priors.adjustments).toEqual({});
    expect(priors.priors).toEqual([]);
    expect(priors.basis).toContain('store unavailable');
    expect(priors.basis).toContain('no adjustment was applied');
  });
});

describe('the priors reach the operator PLAN (the brief’s Learn step)', () => {
  it('planOperators: the adjustment reorders the plan deterministically and is documented on the entry', async () => {
    const { planOperators, SeededRandom } = await import('../../src/services/processing/imagination-operators.js');
    const signals = [{ signal_id: 'sig_1', kind: 'tension' as const, intensity: 1, confidence: 0.9 }];

    const base = planOperators(signals, new SeededRandom('plan-priors'), { maxOperators: 3 });
    const leader = base[0].operator;
    expect(base[0].score).toBe(1);
    expect(base.every((entry) => entry.reason_text === entry.reason)).toBe(true);
    expect(base.every((entry) => entry.prior === undefined)).toBe(true);

    const prior = {
      operator: leader,
      failures: 2,
      useful: 0,
      adjustment: -0.5,
      note: `2 recorded failure signature(s) against 0 useful outcome(s): plan-score adjustment -0.5 (±${MAX_PRIOR_ADJUSTMENT} bound, steps ${PRIOR_FAILURE_STEP}/${PRIOR_USEFUL_STEP})`,
    };
    const demoted = planOperators(signals, new SeededRandom('plan-priors'), {
      maxOperators: 3,
      priors: { adjustments: { [leader]: -0.5 }, priors: [prior], basis: 'test' },
    });
    // Same three operators (the adjustment moved one, it did not drop it)…
    expect([...demoted].map((entry) => entry.operator).sort()).toEqual([...base].map((entry) => entry.operator).sort());
    // …with the demoted one no longer leading, and its number documented.
    expect(demoted[0].operator).not.toBe(leader);
    expect(demoted[2].operator).toBe(leader);
    expect(demoted[2].adjusted_score).toBe(0.5);
    expect(demoted[2].score).toBe(1);
    expect(demoted[2].prior?.failures).toBe(2);
    expect(demoted[2].reason_text).toContain('plan-score adjustment -0.5');
    expect(demoted[2].reason).toBe(base[0].reason); // the machine-readable base is untouched
  });

  it('the engine records the adjustment on the run’s stored operator plan', async () => {
    const { runImaginationCycle } = await import('../../src/services/processing/imagination-service.js');
    await seedScenario(db);

    const plain = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      cycleId: 'cycle_no_priors',
      trigger: 'test',
      seed: 'cycle_no_priors',
    });
    expect(plain.status).toBe('completed');
    expect(plain.operator_plan.every((entry) => entry.adjusted_score === entry.score)).toBe(true);
    expect(plain.operator_plan.every((entry) => entry.reason_text === entry.reason)).toBe(true);

    // The fixture's trace drives `counterfactual_world` hardest (2.4); a
    // bounded demotion keeps it in the plan while moving it down.
    const priors = {
      adjustments: { counterfactual_world: -MAX_PRIOR_ADJUSTMENT },
      priors: [
        {
          operator: 'counterfactual_world',
          failures: 3,
          useful: 0,
          adjustment: -MAX_PRIOR_ADJUSTMENT,
          note: `3 recorded failure signature(s) against 0 useful outcome(s): plan-score adjustment -${MAX_PRIOR_ADJUSTMENT} (±${MAX_PRIOR_ADJUSTMENT} bound, steps ${PRIOR_FAILURE_STEP}/${PRIOR_USEFUL_STEP})`,
        },
      ],
      basis: 'test priors',
    };
    const adjusted = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      cycleId: 'cycle_with_priors',
      trigger: 'test',
      seed: 'cycle_with_priors',
      priors,
    });
    expect(adjusted.status).toBe('completed');
    const moved = adjusted.operator_plan.find((entry) => entry.operator === 'counterfactual_world')!;
    expect(moved.adjusted_score).toBe(Number((moved.score - MAX_PRIOR_ADJUSTMENT).toFixed(6)));
    expect(moved.prior?.failures).toBe(3);
    expect(moved.reason_text).toContain('plan-score adjustment');
    // The persisted run row carries the same plan the caller saw.
    const stored = db
      .collection('imagination_runs')
      .docs.find((row: any) => row.cycle_id === 'cycle_with_priors') as Record<string, any>;
    const storedEntry = (stored.operator_plan as Array<Record<string, any>>).find(
      (entry) => entry.operator === 'counterfactual_world',
    );
    expect(storedEntry!.adjusted_score).toBe(moved.adjusted_score);
    expect(String(storedEntry!.reason_text)).toContain('plan-score adjustment');
    // …and no other operator was moved by evidence it does not have.
    for (const entry of adjusted.operator_plan.filter((row) => row.operator !== 'counterfactual_world')) {
      expect(entry.adjusted_score).toBe(entry.score);
    }
  });

  it('a full CYCLE loads the mission’s own priors — a recorded signature moves the next plan', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const { runImaginationCycle: runCycle } = await import('../../src/services/processing/imagination-cycle-service.js');
    await seedScenario(db);
    // The fixture's trace drives `counterfactual_world` hardest, so a signature
    // against it is visible on the next cycle's plan.
    for (let index = 0; index < 3; index += 1) {
      await recordFailureSignature(db.asDb(), {
        userId: OPERATOR_USER,
        missionId: SCENARIO_MISSION,
        signature: `unnecessary_cost_counterfactual_world_${index}`,
        seedId: `seed_${index}`,
        operator: 'counterfactual_world',
      });
    }
    const cycle = await runCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      actorId: OPERATOR_USER,
      caller: OPERATOR,
    });
    expect(cycle.status).toBe('ran');
    const runRow = db.collection('imagination_runs').docs[0] as Record<string, any>;
    const plan = runRow.operator_plan as Array<Record<string, any>>;
    const moved = plan.find((entry) => entry.operator === 'counterfactual_world');
    expect(moved).toBeTruthy();
    expect(moved!.adjusted_score).toBe(Number((moved!.score - MAX_PRIOR_ADJUSTMENT).toFixed(6)));
    expect(moved!.prior.failures).toBe(3);
    expect(String(moved!.reason_text)).toContain('plan-score adjustment');
    // …and the cycle did not demote anything it has no evidence about.
    for (const entry of plan.filter((row) => row.operator !== 'counterfactual_world')) {
      expect(entry.adjusted_score).toBe(entry.score);
    }
  });
});
