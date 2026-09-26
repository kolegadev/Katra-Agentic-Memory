/**
 * ITER-9 — the imagination dashboard routes.
 * Contract: CONTRACT-iter9-observability.md §C/§F and success criteria 1, 2, 4, 5, 6.
 *
 * The fixture runs a REAL imagination cycle through the production services
 * (only `llmService.extractJson` is stubbed — no network, no provider): the
 * mission is genuinely on a plateau (contradiction pressure), the cycle
 * generates seeds through the ITER-6 engine, FOUR of them collide with
 * pre-filled candidates and are REJECTED BY THE ARCHIVE with `duplicate_of`,
 * and two are admitted. The routes are then exercised as a trusted operator and
 * as an untrusted client key.
 *
 * What is proved:
 *   - the exit criterion end to end: conditions+evidence, the stop reason, the
 *     generated/admitted list, the rejections WITH REASONS, the tokens/budget
 *     and a metrics payload whose comparison states its verdict, its n and the
 *     threshold it used;
 *   - every GET leaves the store byte-identical (no view runs a cycle, promotes
 *     or changes a mode);
 *   - flag gating: each view states WHY it is empty;
 *   - caller pinning: an untrusted caller reads nothing of another identity —
 *     with no existence leak — and markers planted in private stores never
 *     appear in any payload;
 *   - the ONE gated write (trusted, flag on, idempotent) and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';

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
  OPERATOR_BINS,
  OPERATOR_TEXT,
  SCENARIO_MISSION,
  candidateSeed,
  defaultResponder,
  derivedShapedId,
  seedScenario,
} from '../helpers/imagination-scenario.js';
import { IdeaArchiveService, type RejectionReason } from '../../src/services/processing/idea-archive-service.js';
import { runImaginationCycle } from '../../src/services/processing/imagination-cycle-service.js';
import { STOP_CONDITIONS, PLATEAU_CONDITIONS } from '../../src/services/processing/imagination-cycle-config.js';
import { recordCandidateOutcome } from '../../src/services/processing/imagination-outcome-service.js';
import { registerExperiment } from '../../src/services/processing/imagination-experiments.js';
import { createImaginationDashboardRoutes } from '../../src/routes/imagination-dashboard-routes.js';
import { runWithCaller } from '../../src/utils/caller-identity.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const OWNER = 'agent-a'; // the scenario's operator identity
const INTRUDER = 'client-agent';
const TRUSTED: CallerIdentity = { user_id: 'operator', trusted: true };
const UNTRUSTED: CallerIdentity = { user_id: INTRUDER, trusted: false };

const SEEDS = 'idea_seeds';
const LINEAGES = 'idea_lineages';
const CYCLES = 'imagination_cycles';
const OUTCOMES = 'idea_candidate_outcomes';
const TRACES = 'salience_traces';
const BATONS = 'creative_batons';
const PROMOTIONS = 'creative_baton_promotions';

const MARKER_REJECTED = 'PRIVATE-REJECTED-HYPOTHESIS-DO-NOT-LEAK';
const MARKER_PREMISE = 'PRIVATE-CHANGED-PREMISE-DO-NOT-LEAK';
const MARKER_STATEMENT = 'PRIVATE-TRACE-STATEMENT-DO-NOT-LEAK';
const MARKER_SEED_TEXT = 'PRIVATE-ADMITTED-SEED-TEXT-DO-NOT-LEAK';

/** How many of the cycle's seeds are deliberately made to collide. */
const COLLIDING_PREFILL = 4;

let db: FakeDb;
const spies: Array<{ mockRestore: () => void }> = [];

function app() {
  return new Hono().route('/api/v1/imagination', createImaginationDashboardRoutes());
}

async function get(path: string, caller: CallerIdentity = TRUSTED): Promise<{ status: number; body: any }> {
  const res = await runWithCaller(caller, () => app().request(`http://x/api/v1/imagination${path}`));
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown, caller: CallerIdentity = TRUSTED): Promise<{ status: number; body: any }> {
  const res = await runWithCaller(caller, () =>
    app().request(`http://x/api/v1/imagination${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

interface Fixture {
  cycleId: string;
  admitted: string[];
  rejected: string[];
}

/**
 * Seed the mission, pre-fill four candidates whose claims are exactly the ones
 * the cycle's operators will produce (so the archive rejects those four for
 * `duplicate_of`), run ONE real cycle, then record outcomes for the admitted
 * candidates through the real outcome service.
 */
async function seedCycleFixture(): Promise<Fixture> {
  await seedScenario(db, { contradictions: 2 });
  const archive = new IdeaArchiveService(db.asDb());
  const operators = Object.keys(OPERATOR_TEXT).slice(0, COLLIDING_PREFILL);
  for (let index = 0; index < operators.length; index += 1) {
    const operator = operators[index];
    const text = OPERATOR_TEXT[operator];
    const result = await archive.admitOrReplace(
      candidateSeed(index, {
        seed_id: derivedShapedId('seed', 100 + index),
        hypothesis: text.hypothesis,
        mechanism: text.mechanism,
        descriptor_bins: OPERATOR_BINS[operator] as never,
        lineage_ref: derivedShapedId('lineage', 100 + index),
      }),
    );
    if (result.decision === 'rejected') throw new Error(`prefill ${operator} was rejected: ${result.rejection?.reason}`);
  }

  const run = await runImaginationCycle(db.asDb(), { userId: OWNER, missionId: SCENARIO_MISSION });
  if (run.status !== 'ran' || !run.cycle_id) throw new Error(`fixture cycle did not run: ${run.status}/${run.reason}`);

  const seeds = db.collection(SEEDS).docs as Array<Record<string, any>>;
  // The CYCLE's own admitted candidates (the pre-filled ones are admitted too,
  // but they were never generated by this cycle and never judged).
  const admitted = seeds
    .filter((seed) => seed.state !== 'rejected' && seed.cycle_id === run.cycle_id)
    .map((seed) => String(seed.seed_id));
  const rejected = seeds.filter((seed) => seed.state === 'rejected').map((seed) => String(seed.seed_id));

  // Outcomes through the real service: the two admitted cycle candidates get
  // three verdicts each, which is six rows — above the five-outcome minimum.
  for (const seedId of admitted) {
    await recordCandidateOutcome(db.asDb(), { userId: OWNER, seedId, outcome: 'useful_information' });
    await recordCandidateOutcome(db.asDb(), { userId: OWNER, seedId, outcome: 'mere_variance' });
    await recordCandidateOutcome(db.asDb(), { userId: OWNER, seedId, outcome: 'unnecessary_cost' });
  }

  // Private material that must never reach a payload a non-owner can read.
  const admittedRow = seeds.find((seed) => seed.seed_id === admitted[0])!;
  db.collection(SEEDS).docs.push({
    schema_version: '1.0',
    seed_id: derivedShapedId('seed', 200),
    user_id: OWNER,
    mission_id: SCENARIO_MISSION,
    cycle_id: 'cycle_other_marker',
    operator: 'assumption_inversion',
    hypothesis: MARKER_REJECTED,
    mechanism: MARKER_PREMISE,
    state: 'rejected',
    quality: 0,
    novelty_score: 0.1,
    coherence_score: 0.1,
    rank: 1,
    rejection: { reason: 'excluded_region', detail: 'a region this mission already ruled out', duplicate_of: 'ent_ruled_out', at: new Date().toISOString() },
    created_at: new Date().toISOString(),
  });
  db.collection(LINEAGES).docs.push({
    schema_version: '1.0',
    lineage_id: derivedShapedId('lineage', 200),
    seed_id: admitted[0],
    user_id: OWNER,
    mission_id: SCENARIO_MISSION,
    cycle_id: 'cycle_other_marker',
    operator: 'assumption_inversion',
    parent_seed_ids: [],
    transformations: [],
    tests: [],
    results: [],
    failure_signatures: [],
    changed_premise: MARKER_PREMISE,
    created_at: new Date().toISOString(),
  });
  db.collection(TRACES).docs.push({
    schema_version: '1.0',
    trace_id: 'trace_marker',
    run_id: 'run_marker',
    mission_id: SCENARIO_MISSION,
    mission_version: 1,
    cycle_id: 'cycle_other_marker',
    user_id: OWNER,
    trigger: 'plateau',
    problem_state_digest: `sha256:${'a'.repeat(64)}`,
    created_at: new Date().toISOString(),
    signals: [
      {
        kind: 'tension',
        statement: MARKER_STATEMENT,
        why_operationally_relevant: MARKER_PREMISE,
        intensity: 0.9,
        confidence: 0.8,
        valence: -0.5,
        evidence_refs: ['ent_marker'],
        low_confidence: false,
      },
    ],
    calibration: { signal_count: 1, intensity_max: 0.9, intensity_mean: 0.9, confidence_mean: 0.8, valence_mean: -0.5, low_confidence_count: 0, confidence_floor: 0.3, clamped_values: 0, clamped_by_field: {}, coerced_values: 0, coerced_by_field: {}, by_kind: { tension: 1 }, confidence_buckets: { '0.8-1.0': 1 } },
    evidence: { total_refs: 1, resolved_refs: 1, unresolved_ref_count: 0, unresolved_evidence_count: 0, flagged_refs: [], resolvable_collections: [] },
    input_counts: {},
    privacy: { raw_reflections_included: false, shared: false },
  });
  // A marker inside an ADMITTED candidate's own text: it is the one thing the
  // baton's allow-list legitimately shares, so it is checked separately.
  admittedRow.mechanism = MARKER_SEED_TEXT;

  return { cycleId: run.cycle_id, admitted, rejected };
}

const EMPTY_VIEWS = [
  '/overview',
  '/cycles',
  '/traces',
  '/batons',
  '/experiments',
];

beforeEach(async () => {
  db = new FakeDb();
  holder.db = db;
  delete process.env.CREATIVE_BATON_PROMOTION;
  delete process.env.COGNITIVE_TEAM_ALLOCATION;
  delete process.env.COGNITIVE_CONTROL_ENABLED;
  process.env.FOCUSED_IMAGINATION = '1';
  spies.push(
    vi.spyOn(llmService, 'extractJson').mockImplementation((async (system: string, prompt: string) =>
      defaultResponder(system, prompt)) as never),
  );
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
  delete process.env.FOCUSED_IMAGINATION;
  delete process.env.CREATIVE_BATON_PROMOTION;
  delete process.env.COGNITIVE_TEAM_ALLOCATION;
  delete process.env.COGNITIVE_CONTROL_ENABLED;
});

// ── The exit criterion, end to end ─────────────────────────────────────────

describe('exit criterion — why it triggered, what it generated, what it rejected', () => {
  it('serves the cycle detail with conditions+evidence, the stop reason, the admitted and rejected lists with reasons, and the tokens', async () => {
    const fixture = await seedCycleFixture();
    // ITER-10 (F4): a trusted caller's DEFAULT scope is its own identity, so a
    // read of another identity's cycle names it explicitly.
    const { status, body } = await get(`/cycles/${fixture.cycleId}?user_id=${OWNER}`);

    expect(status).toBe(200);
    expect(body.cycle).toBeTruthy();
    expect(body.cycle.status).toBe('completed');
    expect(body.cycle.mission_id).toBe(SCENARIO_MISSION);

    // (a) WHY it triggered — all five plateau conditions, each with evidence.
    expect(body.conditions.plateau).toHaveLength(PLATEAU_CONDITIONS.length);
    expect(body.conditions.plateau.map((condition: any) => condition.name).sort()).toEqual([...PLATEAU_CONDITIONS].sort());
    for (const condition of body.conditions.plateau) {
      expect(typeof condition.met).toBe('boolean');
      expect(Object.keys(condition.evidence).length).toBeGreaterThan(0);
    }
    const contradiction = body.conditions.plateau.find((condition: any) => condition.name === 'contradiction_pressure_above_threshold');
    expect(contradiction.met).toBe(true);
    expect(contradiction.evidence.contradictions).toBeGreaterThanOrEqual(contradiction.evidence.threshold);
    expect(body.conditions.basis).toContain('recorded ON the cycle row');

    // …and the stop reason is one of the documented conditions, with every
    // stop condition reported either way.
    expect(STOP_CONDITIONS).toContain(body.cycle.stop_reason);
    expect(body.conditions.stop.map((condition: any) => condition.name)).toEqual([...STOP_CONDITIONS]);
    const metStop = body.conditions.stop.filter((condition: any) => condition.met);
    expect(metStop).toHaveLength(1);

    // (b) WHAT was generated: admitted candidates, and the rejections WITH REASONS.
    expect(body.generated.count).toBeGreaterThan(0);
    expect(body.rejected.count).toBeGreaterThan(0);
    expect(body.generated.count + body.rejected.count).toBe(body.cycle.counts.seeds_generated);
    for (const seed of body.generated.admitted) {
      expect(seed.state).toBe('admitted');
      expect(typeof seed.quality).toBe('number');
      expect(seed.cell_key).toBeTruthy();
    }
    const allowed: RejectionReason[] = [
      'duplicate_of',
      'paraphrase_of',
      'excluded_region',
      'schema_invalid',
      'missing_changed_premise',
      'vacuous_changed_premise',
      'premise_restates_exclusion',
      'missing_lineage_link',
    ];
    for (const rejection of body.rejected.rows) {
      expect(allowed).toContain(rejection.reason);
      expect(rejection.seed_id).toBeTruthy();
    }
    // The four colliding candidates were rejected BY NAME for a duplicate.
    expect(body.rejected.rows.filter((row: any) => row.reason === 'duplicate_of').length).toBeGreaterThanOrEqual(1);
    expect(body.rejected.rows.map((row: any) => row.seed_id).sort()).toEqual([...fixture.rejected].sort());

    // Tokens/budget and the privacy audit come from the stored row.
    expect(body.tokens.spent_this_cycle).toBeGreaterThanOrEqual(0);
    expect(body.tokens.basis).toContain('usage ledger');
    expect(body.cycle.privacy_audit.journal_reads).toBe(0);
    expect(body.cycle.privacy_audit.raw_reflections_included).toBe(false);
    expect(body.basis).toContain('idea_seeds');

    // The seed TEXT stays in its private store: the detail carries ids, bins,
    // numbers and reasons only.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(MARKER_REJECTED);
    expect(serialized).not.toContain(MARKER_SEED_TEXT);
    expect(serialized).not.toContain('The drain becomes countable'); // an admitted candidate's claim
  });

  it('serves the metrics payload with its basis, its n and its verdict vocabulary', async () => {
    await seedCycleFixture();
    const { status, body } = await get(`/metrics?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`);

    expect(status).toBe(200);
    expect(body.identity).toBe(OWNER);
    const metrics = body.metrics;
    // Six recorded outcomes (three verdicts for each of the two admitted cycle
    // candidates), two of them useful_information.
    expect(metrics.useful_novelty_rate.status).toBe('ok');
    expect(metrics.useful_novelty_rate.value).toEqual({ rate: 0.3333, useful_outcomes: 2 });
    expect(metrics.useful_novelty_rate.basis.n).toBe(6);
    expect(metrics.useful_novelty_rate.basis.minimum).toBe(body.minimums.outcomes);
    expect(metrics.useful_novelty_rate.basis.window.days).toBe(14);

    // Coverage gain and the false-novelty share are measured off the same cycle.
    expect(metrics.archive_coverage_gain.status).toBe('ok');
    expect(metrics.archive_coverage_gain.basis.n).toBe(1);
    // Eleven seed rows exist: four pre-filled candidates, the cycle's six
    // generated seeds and the planted rejected marker row — five were rejected
    // as something already seen (four duplicate_of, one excluded_region).
    expect(metrics.false_novelty.status).toBe('ok');
    expect(metrics.false_novelty.value).toEqual({ rate: 0.4545, rejected_as_seen: 5, generated: 11 });
    // Six admitted candidates (four pre-filled + the cycle's two), two judged.
    expect(metrics.idea_survival.value).toEqual({ rate: 0.3333, admitted_with_outcome: 2, admitted: 6 });

    // (c) value versus baseline: an explicit verdict with its n and threshold.
    expect(body.comparison).toBeTruthy();
    expect(['improved', 'not_improved', 'insufficient_data']).toContain(body.comparison.verdict);
    expect(body.comparison.verdict).toBe('insufficient_data'); // nothing ran in the previous window
    expect(body.comparison.metrics.length).toBeGreaterThanOrEqual(5);
    for (const row of body.comparison.metrics) {
      expect(['improved', 'not_improved', 'insufficient_data']).toContain(row.verdict);
      expect(typeof row.n.baseline).toBe('number');
      expect(typeof row.n.minimum).toBe('number');
      expect(row.target.min_relative_gain).toBeGreaterThan(0);
      expect(row.basis).toContain('window over window');
    }
    const novelty = body.comparison.metrics.find((row: any) => row.metric === 'useful_novelty_rate');
    expect(novelty.n).toEqual({ baseline: 0, treatment: 6, minimum: 3 });
    expect(novelty.baseline.value).toBeNull();
    expect(novelty.target.source).toBe('named-target');
    expect(novelty.reason).toContain('previous window');
    expect(metrics.privacy_leakage.flagged).toBe(0);
    expect(metrics.privacy_leakage.basis.measurement).toContain('audit');

    // Every metric the payload exposes carries a basis.
    for (const key of Object.keys(metrics)) {
      const metric = metrics[key];
      if (!metric || typeof metric !== 'object' || !('status' in metric)) continue;
      expect(metric.basis, `${key} has no basis`).toBeTruthy();
      expect(typeof metric.basis.n).toBe('number');
      expect(metric.basis.sources.length).toBeGreaterThan(0);
    }
  });

  it('verdicts the window against the previous one: improved, with the n, the direction and the threshold', async () => {
    await seedCycleFixture();
    // A PRIOR window (20 days back): a worse useful-novelty rate, a worse
    // false-novelty share, more tokens per useful candidate and a slower first
    // candidate — so the comparison has real baseline values to judge against.
    const before = new Date(Date.now() - 20 * 86400_000).toISOString();
    db.collection(CYCLES).docs.push({
      cycle_id: 'cyc_prior', user_id: OWNER, mission_id: SCENARIO_MISSION, mission_version: 1, trigger: 'plateau',
      actor_id: OWNER, forced: false, status: 'completed', stop_reason: 'no_new_cells_two_rounds', stop_conditions: [], plateau: [],
      counts: { seeds_generated: 6, seeds_admitted: 1, seeds_below_incumbent: 0, seeds_rejected: 5, candidates_considered: 1, candidates_eligible: 1, new_cells: 0, cells_total: 0 },
      budget: { tokens_spent_this_cycle: 500 }, created_at: before,
    });
    db.collection(SEEDS).docs.push({
      seed_id: derivedShapedId('seed', 300), user_id: OWNER, mission_id: SCENARIO_MISSION, cycle_id: 'cyc_prior',
      operator: 'assumption_inversion', hypothesis: 'a prior candidate', mechanism: 'prior', state: 'admitted', quality: 0.5,
      novelty_score: 0.5, coherence_score: 0.5, rank: 1, created_at: new Date(Date.parse(before) + 600_000).toISOString(),
    });
    for (let index = 0; index < 5; index += 1) {
      db.collection(SEEDS).docs.push({
        seed_id: derivedShapedId('seedx', index), user_id: OWNER, mission_id: SCENARIO_MISSION, cycle_id: 'cyc_prior',
        operator: 'representation_shift', hypothesis: `prior rejected ${index}`, mechanism: 'prior', state: 'rejected', quality: 0,
        novelty_score: 0, coherence_score: 0, rejection: { reason: 'duplicate_of' }, created_at: before,
      });
      db.collection(OUTCOMES).docs.push({
        outcome_id: `prior_o${index}`, user_id: OWNER, mission_id: SCENARIO_MISSION, seed_id: derivedShapedId('seedx', index),
        outcome: index === 0 ? 'useful_information' : 'mere_variance', recorded_at: before,
      });
    }

    const { body } = await get(`/metrics?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`);
    const comparison = body.comparison;
    expect(comparison.verdict).toBe('improved');
    expect(comparison.counts.not_improved).toBe(0);
    expect(comparison.baseline_window.to).toBe(body.metrics.window.from);
    expect(comparison.basis).toContain('preceding window of equal length');

    const novelty = comparison.metrics.find((row: any) => row.metric === 'useful_novelty_rate');
    expect(novelty.verdict).toBe('improved');
    expect(novelty.baseline).toMatchObject({ value: 0.2, n: 5 });
    expect(novelty.treatment).toMatchObject({ value: 0.3333, n: 6 });
    expect(novelty.target).toEqual({ direction: 'higher', min_relative_gain: 0.3, min_samples: 3, source: 'named-target' });
    expect(novelty.relative_gain).toBeCloseTo(0.6665, 3);
    expect(novelty.n).toEqual({ baseline: 5, treatment: 6, minimum: 3 });
    expect(novelty.basis).toContain('window over window');

    // A lower-is-better metric is judged in ITS OWN direction.
    const falseNovelty = comparison.metrics.find((row: any) => row.metric === 'false_novelty');
    expect(falseNovelty.direction).toBe('lower');
    expect(falseNovelty.verdict).toBe('improved');
    const cost = comparison.metrics.find((row: any) => row.metric === 'cost_of_novelty');
    expect(cost.direction).toBe('lower');
    // Too small a sample on either side is insufficient data, not a gain: the
    // previous window holds a single admitted candidate, below the minimum.
    const survival = comparison.metrics.find((row: any) => row.metric === 'idea_survival');
    expect(survival.verdict).toBe('insufficient_data');
    expect(survival.n).toEqual({ baseline: 1, treatment: 6, minimum: 3 });
    expect(survival.reason).toContain('below the minimum');
    expect(comparison.counts.insufficient_data).toBeGreaterThan(0);
  });

  it('the whole history is reachable: overview, cycles list, archive and traces', async () => {
    const fixture = await seedCycleFixture();
    const overview = await get(`/overview?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`);
    expect(overview.body.missions).toHaveLength(1);
    expect(overview.body.missions[0]).toMatchObject({ mission_id: SCENARIO_MISSION, cycles: 1, rejected_total: 4 });
    expect(overview.body.counts.basis).toContain('imagination_cycles');

    const cycles = await get(`/cycles?user_id=${OWNER}`);
    expect(cycles.body.cycles.map((cycle: any) => cycle.cycle_id)).toEqual([fixture.cycleId]);
    expect(cycles.body.cycles[0].counts.seeds_generated).toBe(6);

    const archive = await get(`/archive?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`);
    expect(archive.body.coverage.cells_total).toBeGreaterThan(0);
    expect(archive.body.coverage.scan.cells_limit).toBeGreaterThan(0);
    expect(archive.body.incumbents.length).toBeGreaterThan(0);
    expect(JSON.stringify(archive.body)).not.toContain('The drain becomes countable');

    const traces = await get(`/traces?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`);
    expect(traces.body.traces.length).toBeGreaterThanOrEqual(2); // the fixture trace + the marker trace
    for (const trace of traces.body.traces) {
      for (const signal of trace.signals) {
        // Signal SHAPES only: no statement, no why-text, no evidence refs.
        expect(Object.keys(signal).sort()).toEqual(
          ['confidence', 'evidence_ref_count', 'index', 'intensity', 'kind', 'low_confidence', 'unresolved_evidence', 'valence'],
        );
      }
      expect(trace.evidence.total_refs).toBeGreaterThanOrEqual(0);
    }
    // ITER-10 (F1): the traces VIEW carries a basis of the house shape too —
    // the same key set the metrics view's per-metric bases carry.
    const metricsBasis = (await get(`/metrics?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`)).body.metrics.useful_novelty_rate.basis;
    expect(traces.body.basis, '/traces has no view-level basis').toBeTruthy();
    expect(Object.keys(traces.body.basis).sort()).toEqual(Object.keys(metricsBasis).sort());
    expect(traces.body.basis.window).toEqual({ from: null, to: expect.any(String), days: null }); // a live listing, not a windowed rate
    expect(traces.body.basis.n).toBe(traces.body.traces.length);
    expect(traces.body.basis.sources).toEqual([TRACES]);
    expect(traces.body.basis.measurement).toContain('salience_traces');
  });

  it('every number-carrying view states a basis, and the traces basis is a measurement with its n', async () => {
    const fixture = await seedCycleFixture();
    const traces = await get(`/traces?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`);
    const basis = traces.body.basis;
    expect(basis).toBeTruthy();
    expect(basis.window).toBeTruthy();
    expect(Array.isArray(basis.sources) && basis.sources.length > 0).toBe(true);
    expect(typeof basis.n).toBe('number');
    expect(typeof basis.measurement).toBe('string');
    expect(basis.measurement.length).toBeGreaterThan(20);
    expect(basis.n).toBeGreaterThanOrEqual(2);
    // The per-trace calibration and evidence data is unchanged by the addition.
    for (const trace of traces.body.traces) {
      expect(trace.calibration).toBeTruthy();
      expect(trace.calibration.signal_count).toBeGreaterThanOrEqual(1);
      expect(Object.keys(trace.evidence).sort()).toEqual([
        'resolvable_collections',
        'resolved_refs',
        'total_refs',
        'unresolved_evidence_count',
        'unresolved_ref_count',
      ]);
    }

    // Every other view that carries numbers states a basis as well (the views
    // that carry a string basis keep it; /traces now carries the house object).
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    const paths = [
      `/overview?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`,
      `/cycles?user_id=${OWNER}`,
      `/cycles/${fixture.cycleId}?user_id=${OWNER}`,
      `/traces?user_id=${OWNER}`,
      `/archive?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`,
      '/batons',
      '/team',
      `/metrics?user_id=${OWNER}`,
      '/experiments',
      '/rollout',
    ];
    for (const path of paths) {
      const { body } = await get(path);
      const stated = typeof body.basis === 'string' ? body.basis : body.basis?.measurement;
      expect(typeof stated, `${path} has no stated basis`).toBe('string');
      expect(stated.length, `${path} states an empty basis`).toBeGreaterThan(20);
    }
    // A payload that cannot serve numbers states WHY instead of a basis.
    delete process.env.COGNITIVE_TEAM_ALLOCATION;
    const noId = await get('/experiments/compare');
    expect(noId.status).toBe(400);
    expect(noId.body.basis).toBeUndefined();
    expect(noId.body.reason).toContain('experiment_id is required');

    // Source level: the /traces handler itself declares the basis fields rather
    // than relying on a default.
    const source = readFileSync(new URL('../../src/routes/imagination-dashboard-routes.ts', import.meta.url), 'utf8');
    const start = source.indexOf("router.get('/traces'");
    const end = source.indexOf('router.get(', start + 1);
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, end);
    for (const field of ['window:', 'n:', 'sources:', 'measurement:']) {
      expect(handler, `/traces does not declare ${field}`).toContain(field);
    }
  });
});

// ── Read-only property ─────────────────────────────────────────────────────

describe('read-only property', () => {
  it('no GET view mutates any collection', async () => {
    const fixture = await seedCycleFixture();
    process.env.CREATIVE_BATON_PROMOTION = '1';
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    const { experiment } = await registerExperiment(db.asDb(), {
      userId: 'operator',
      name: 'read-only probe',
      hypothesis: 'nothing on a GET path writes',
      checkpoints: ['cycle-1'],
      arms: [{ label: 'control', config: {} }, { label: 'treatment', config: {} }],
    });
    const snapshot = () =>
      Object.fromEntries([...db.collections.entries()].map(([name, collection]) => [name, { docs: collection.docs, indexes: collection.createdIndexes }]));
    const before = snapshot();
    const paths = [
      '/overview',
      '/cycles',
      `/cycles/${fixture.cycleId}`,
      '/traces',
      '/archive?mission_id=' + SCENARIO_MISSION,
      '/batons',
      '/team',
      '/metrics',
      '/experiments',
      `/experiments/compare?experiment_id=${experiment.experiment_id}`,
      `/experiments/${experiment.experiment_id}/compare`,
      '/rollout',
    ];
    for (const path of paths) {
      const { status } = await get(path);
      expect(status, path).toBe(200);
    }
    const after = snapshot();
    for (const [name, value] of Object.entries(before)) {
      // Every collection that existed before the reads is byte-identical…
      expect(after[name], `${name} changed under a GET`).toEqual(value);
    }
    // …and reading a collection that did not exist yet may only add an EMPTY
    // one (the fake materialises the handle; nothing was written into it).
    for (const [name, value] of Object.entries(after)) {
      if (name in before) continue;
      expect(value.docs, `${name} was written by a GET`).toEqual([]);
      expect(value.indexes, `${name} had an index created by a GET`).toEqual([]);
    }
  });

  it('the route module contains no write call on a GET path', () => {
    const source = readFileSync(new URL('../../src/routes/imagination-dashboard-routes.ts', import.meta.url), 'utf8');
    // The only mutations in the file are the gated experiment write and its
    // audit row — both inside the POST handler.
    const postStart = source.indexOf('router.post(');
    expect(postStart).toBeGreaterThan(-1);
    const beforePost = source.slice(0, postStart);
    for (const forbidden of ['insertOne(', 'updateOne(', 'deleteOne(', 'updateMany(', 'deleteMany(', 'promoteCreativeBaton(', 'runImaginationCycle(', 'assignMode(', 'recordExperimentObservation(', 'registerExperiment(']) {
      expect(beforePost, `${forbidden} appears on a GET path`).not.toContain(forbidden);
    }
  });
});

// ── Flag gating ────────────────────────────────────────────────────────────

describe('flag gating — every view states why it is empty', () => {
  it('with FOCUSED_IMAGINATION off each view says so, and /rollout still reports the flags', async () => {
    await seedCycleFixture();
    delete process.env.FOCUSED_IMAGINATION;
    for (const path of EMPTY_VIEWS) {
      const { status, body } = await get(path);
      expect(status, path).toBe(200);
      expect(body.plane, path).toBe('off');
      expect(body.reason, path).toContain('FOCUSED_IMAGINATION=off');
      // …and the view's own list is empty rather than silently absent.
      const list = Object.entries(body).find(([, value]) => Array.isArray(value));
      expect(list, `${path} has no list`).toBeTruthy();
      expect((list![1] as unknown[]).length).toBe(0);
    }
    const detail = await get('/cycles/whatever');
    expect(detail.body.reason).toContain('FOCUSED_IMAGINATION=off');
    const rollout = await get('/rollout');
    expect(rollout.status).toBe(200);
    expect(rollout.body.flags.find((flag: any) => flag.name === 'FOCUSED_IMAGINATION').on).toBe(false);
  });

  it('with FOCUSED_IMAGINATION on the same views serve real data', async () => {
    const fixture = await seedCycleFixture();
    const cycles = await get(`/cycles?user_id=${OWNER}`);
    expect(cycles.body.plane).toBe('on');
    expect(cycles.body.cycles).toHaveLength(1);
    expect(cycles.body.reason).toBeNull();
    const detail = await get(`/cycles/${fixture.cycleId}?user_id=${OWNER}`);
    expect(detail.body.rejected.count).toBe(4);
    const metrics = await get('/metrics');
    expect(metrics.body.plane).toBe('on');
  });

  it('the team view is gated on its OWN flag and states the reason', async () => {
    await seedCycleFixture();
    const off = await get('/team');
    expect(off.body.plane).toBe('off');
    expect(off.body.reason).toContain('COGNITIVE_TEAM_ALLOCATION=off');
    expect(off.body.modes).toEqual([]);
    expect(off.body.envelopes).toEqual([]);

    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    db.collection('thinking_mode_assignments').docs.push({
      schema_version: '1.0',
      assignment_id: 'assign_dashboard',
      user_id: OWNER,
      mission_id: SCENARIO_MISSION,
      mode: 'analyst',
      status: 'active',
      reason: 'the plateau needs a measurement-first pass',
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const on = await get(`/team?user_id=${OWNER}`);
    expect(on.body.plane).toBe('on');
    expect(on.body.modes).toHaveLength(1);
    expect(on.body.modes[0].mode).toBe('analyst');
    expect(on.body.modes[0].reason).toContain('measurement-first');
    expect(on.body.basis).toContain('thinking_mode_assignments');
  });

  it('every view carries a privacy indicator with a basis', async () => {
    await seedCycleFixture();
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    for (const path of ['/traces', '/archive?mission_id=' + SCENARIO_MISSION, '/batons', '/team', '/cycles']) {
      const { body } = await get(path);
      expect(body.privacy, path).toBeTruthy();
      expect(['private', 'shared', 'private+shared'], path).toContain(body.privacy.scope);
      expect(body.privacy.raw_reflections_included, path).toBe(false);
      expect(typeof body.privacy.basis, path).toBe('string');
      expect(body.privacy.basis.length, path).toBeGreaterThan(20);
    }
  });

  it('a mission-scoped view without a mission_id says why it cannot show anything', async () => {
    await seedCycleFixture();
    const archive = await get('/archive');
    expect(archive.body.coverage).toBeNull();
    expect(archive.body.incumbents).toEqual([]);
    expect(archive.body.reason).toContain('mission_id is required');
  });

  it('an empty store says "no data", not nothing', async () => {
    const overview = await get('/overview');
    expect(overview.body.missions).toEqual([]);
    expect(overview.body.reason).toContain('no data exists');
    const cycles = await get('/cycles');
    expect(cycles.body.cycles).toEqual([]);
    expect(cycles.body.reason).toContain('no data exists');
    const traces = await get('/traces');
    expect(traces.body.traces).toEqual([]);
    expect(traces.body.reason).toBeTruthy();
    const batons = await get('/batons');
    expect(batons.body.batons).toEqual([]);
    expect(batons.body.reason).toBeTruthy();
    const experiments = await get('/experiments');
    expect(experiments.body.experiments).toEqual([]);
    expect(experiments.body.reason).toContain('no experiment is registered');
    const archive = await get(`/archive?mission_id=${SCENARIO_MISSION}`);
    expect(archive.body.reason).toContain('no cell');
  });
});

// ── Caller pinning + zero leakage ──────────────────────────────────────────

describe('caller pinning and privacy', () => {
  it('an untrusted caller reads nothing of another identity, with no existence leak', async () => {
    const fixture = await seedCycleFixture();

    // Every artefact view, asked explicitly for the owner's identity: pinned
    // to the CALLER, so the answer is empty — never the owner's rows.
    const traces = await get(`/traces?user_id=${OWNER}`, UNTRUSTED);
    expect(traces.body.identity).toBe(INTRUDER);
    expect(traces.body.traces).toEqual([]);
    expect(traces.body.caller_pinned).toBe(true);

    const cycles = await get(`/cycles?user_id=${OWNER}`, UNTRUSTED);
    expect(cycles.body.identity).toBe(INTRUDER);
    expect(cycles.body.cycles).toEqual([]);

    const batons = await get(`/batons?user_id=${OWNER}`, UNTRUSTED);
    expect(batons.body.batons).toEqual([]);

    const archive = await get(`/archive?user_id=${OWNER}&mission_id=${SCENARIO_MISSION}`, UNTRUSTED);
    expect(archive.body.coverage.cells_total).toBe(0);
    expect(archive.body.incumbents).toEqual([]);

    // Costs are per identity too: the metrics are measured for the CALLER.
    const metrics = await get(`/metrics?user_id=${OWNER}`, UNTRUSTED);
    expect(metrics.body.identity).toBe(INTRUDER);
    expect(metrics.body.metrics.useful_novelty_rate.status).toBe('insufficient_data');
    expect(metrics.body.metrics.cost_of_novelty.status).toBe('insufficient_data');

    // No existence leak: another identity's cycle is reported byte-for-byte
    // like a cycle that does not exist.
    const other = await get(`/cycles/${fixture.cycleId}`, UNTRUSTED);
    const missing = await get('/cycles/imagination_cycle_0000000000000000_v1_c1', UNTRUSTED);
    expect(other.body).toEqual(missing.body);
    expect(JSON.stringify(other.body)).not.toContain('agent-a');
  });

  it('markers planted in private stores never appear in any payload', async () => {
    await seedCycleFixture();
    process.env.CREATIVE_BATON_PROMOTION = '1';
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    const paths = [
      '/overview',
      '/cycles',
      '/traces',
      '/archive?mission_id=' + SCENARIO_MISSION,
      '/batons',
      '/team',
      '/metrics',
      '/experiments',
      '/rollout',
    ];
    for (const path of paths) {
      for (const caller of [TRUSTED, UNTRUSTED, { user_id: OWNER, trusted: false } as CallerIdentity]) {
        const { body } = await get(path, caller);
        const serialized = JSON.stringify(body);
        expect(serialized, `${path} leaked the rejected hypothesis`).not.toContain(MARKER_REJECTED);
        expect(serialized, `${path} leaked the changed premise`).not.toContain(MARKER_PREMISE);
        expect(serialized, `${path} leaked the trace statement`).not.toContain(MARKER_STATEMENT);
        expect(serialized, `${path} leaked an admitted seed's mechanism`).not.toContain(MARKER_SEED_TEXT);
        if (path === '/traces') {
          // The trace projection names no private store either: the run's
          // input counts (journal_count, reflection_node_count) are not part of
          // a signals + calibration + evidence-counts view.
          expect(serialized).not.toContain('journal_count');
          expect(serialized).not.toContain('reflection_node_count');
        }
      }
    }
  });

  it('the promoted baton is the one shareable artefact, and it is sanitised', async () => {
    const fixture = await seedCycleFixture();
    process.env.CREATIVE_BATON_PROMOTION = '1';
    const baton = (db.collection(BATONS).docs as Array<Record<string, any>>)[0];
    expect(baton).toBeTruthy();
    // Promote it the way the cycle would with the flag on.
    const { promoteCreativeBaton } = await import('../../src/services/processing/creative-baton-promotion.js');
    const promotion = await promoteCreativeBaton(db.asDb(), {
      userId: OWNER,
      batonId: String(baton.baton_id),
      caller: { user_id: 'operator', trusted: true },
    });
    expect(promotion.promoted).toBe(true);

    const { body } = await get('/batons');
    expect(body.promotion_flag).toBe(true);
    expect(body.batons.length).toBe(1);
    expect(body.batons[0].scope).toBe('shared');
    expect(body.promotions.length).toBe(1);
    expect(body.promotions[0].payload_hash).toBe(body.batons[0].payload_hash);
    expect(body.batons[0].baton_id).toBe(String(baton.baton_id));
    expect(body.privacy.scope).toBe('shared');

    // The stored payload is an allow-list: none of the private keys appear.
    const serialized = JSON.stringify(body);
    for (const forbidden of ['evidence_refs', 'changed_premise', 'parent_seed_ids', 'bridge_path', 'cell_key']) {
      expect(serialized, `${forbidden} reached the shared payload`).not.toContain(`"${forbidden}"`);
    }
    expect(serialized).not.toContain(MARKER_REJECTED);
    expect(serialized).not.toContain(MARKER_STATEMENT);
    // A PROMOTED baton is the one shareable artefact: an untrusted non-owner
    // sees it (that is the point of promotion) and sees it as shared scope.
    const shared = await get('/batons', UNTRUSTED);
    expect(shared.body.batons.map((row: any) => row.scope)).toEqual(['shared']);
    expect(shared.body.promotions).toHaveLength(1);

    // …but an UNPROMOTED one is invisible to the same caller, while the owner
    // still sees it. (Dropping the stamp is a fixture action, not a code path.)
    delete baton.shared_id;
    delete baton.promotion_id;
    delete baton.promoted_at;
    delete baton.promoted_by;
    const privateAgain = await get('/batons', UNTRUSTED);
    expect(privateAgain.body.batons).toEqual([]);
    expect(privateAgain.body.promotions).toEqual([]);
    const own = await get(`/batons?user_id=${OWNER}`, { user_id: OWNER, trusted: false } as CallerIdentity);
    expect(own.body.batons).toHaveLength(1);
    expect(own.body.batons[0].scope).toBe('private');
  });

  it('a tampered baton is refused by name rather than rendered', async () => {
    await seedCycleFixture();
    const baton = (db.collection(BATONS).docs as Array<Record<string, any>>)[0];
    baton.candidate_portfolio[0].hypothesis = 'tampered after compile';
    // ITER-10 (F4): the private baton belongs to OWNER, so the read names it —
    // a trusted caller no longer sees another identity's private row by default.
    const { body } = await get(`/batons?user_id=${OWNER}`);
    expect(body.batons).toEqual([]);
    expect(body.refusals).toHaveLength(1);
    expect(body.refusals[0].code).toBe('payload_hash_mismatch');
    expect(body.refusals[0].baton_id).toBe(String(baton.baton_id));
  });
});

// ── View scope: the caller by default, cross-identity only on request ──────

describe('view scope — the caller by default, cross-identity only on request (ITER-10 F4)', () => {
  const OTHER_TRACE = 'trace_other_identity';

  /** A SECOND identity's trace, so a cross-identity read is observable. */
  function plantOtherIdentityTrace(): void {
    db.collection(TRACES).docs.push({
      schema_version: '1.0',
      trace_id: OTHER_TRACE,
      run_id: 'run_other',
      mission_id: SCENARIO_MISSION,
      mission_version: 1,
      cycle_id: 'cycle_other',
      user_id: 'agent-b',
      trigger: 'plateau',
      problem_state_digest: `sha256:${'b'.repeat(64)}`,
      created_at: new Date().toISOString(),
      signals: [],
      calibration: { signal_count: 0 },
      evidence: { total_refs: 0, resolved_refs: 0, unresolved_ref_count: 0, unresolved_evidence_count: 0, resolvable_collections: [] },
      input_counts: {},
      privacy: { raw_reflections_included: false, shared: false },
    });
  }

  it("pins EVERY view to the caller's own identity by default — trusted callers included", async () => {
    const fixture = await seedCycleFixture();
    plantOtherIdentityTrace();

    // The trusted caller (`operator`) owns none of the fixture's rows: with no
    // identity named, every view answers for `operator` and nothing else.
    const overview = await get('/overview');
    expect(overview.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(overview.body.identity).toBe('operator');
    expect(overview.body.missions).toEqual([]);

    const cycles = await get('/cycles');
    expect(cycles.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(cycles.body.identity).toBe('operator');
    expect(cycles.body.cycles).toEqual([]);

    const detail = await get(`/cycles/${fixture.cycleId}`);
    expect(detail.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(detail.body.cycle).toBeNull();

    const traces = await get('/traces');
    expect(traces.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(traces.body.traces).toEqual([]);
    expect(traces.body.caller_pinned).toBe(true);

    const batons = await get('/batons');
    expect(batons.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(batons.body.batons, "another identity's PRIVATE baton is not in scope").toEqual([]);
    expect(batons.body.promotions).toEqual([]);

    const metrics = await get('/metrics');
    expect(metrics.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(metrics.body.identity).toBe('operator');
    expect(metrics.body.metrics.useful_novelty_rate.status).toBe('insufficient_data');

    // An untrusted caller is pinned in exactly the same way.
    const untrusted = await get('/traces', UNTRUSTED);
    expect(untrusted.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(untrusted.body.identity).toBe(INTRUDER);
  });

  it('a trusted caller may NAME one identity, and the payload states which', async () => {
    await seedCycleFixture();
    plantOtherIdentityTrace();

    const cycles = await get(`/cycles?user_id=${OWNER}`);
    expect(cycles.body.scope).toEqual({ kind: 'named', identities: 1 });
    expect(cycles.body.identity).toBe(OWNER);
    expect(cycles.body.cycles).toHaveLength(1);

    const traces = await get(`/traces?user_id=${OWNER}`);
    expect(traces.body.scope).toEqual({ kind: 'named', identities: 1 });
    expect(traces.body.traces.length).toBeGreaterThanOrEqual(2);
    expect(traces.body.traces.map((trace: any) => trace.trace_id)).not.toContain(OTHER_TRACE);

    const batons = await get(`/batons?user_id=${OWNER}`);
    expect(batons.body.scope).toEqual({ kind: 'named', identities: 1 });
    expect(batons.body.batons).toHaveLength(1);

    // The per-identity views name the identity too, and compute for it.
    const metrics = await get(`/metrics?user_id=${OWNER}`);
    expect(metrics.body.scope).toEqual({ kind: 'named', identities: 1 });
    expect(metrics.body.identity).toBe(OWNER);
    expect(metrics.body.metrics.useful_novelty_rate.status).toBe('ok');
    const experiments = await get(`/experiments?user_id=${OWNER}`);
    expect(experiments.body.scope).toEqual({ kind: 'named', identities: 1 });
    expect(experiments.body.identity).toBe(OWNER);

    // An untrusted caller naming another identity is IGNORED, never honoured.
    const ignored = await get(`/traces?user_id=${OWNER}`, UNTRUSTED);
    expect(ignored.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(ignored.body.traces).toEqual([]);
    const ignoredMetrics = await get(`/metrics?user_id=${OWNER}`, UNTRUSTED);
    expect(ignoredMetrics.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(ignoredMetrics.body.identity).toBe(INTRUDER);
  });

  it('the cross-identity read is an explicit, trusted-only opt-in that states its scope', async () => {
    await seedCycleFixture();
    plantOtherIdentityTrace();

    // Untrusted: `all_identities` is ignored — the read stays pinned.
    const refused = await get('/traces?all_identities=1', UNTRUSTED);
    expect(refused.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(refused.body.traces).toEqual([]);
    const namedToo = await get(`/cycles?user_id=${OWNER}&all_identities=1`, UNTRUSTED);
    expect(namedToo.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(namedToo.body.cycles).toEqual([]);

    // Trusted opt-in: the payload spans BOTH identities and says so.
    const all = await get('/traces?all_identities=1');
    expect(all.body.scope).toEqual({ kind: 'all', identities: 2 });
    expect(all.body.identity).toBe('all');
    expect(all.body.traces.map((trace: any) => trace.trace_id)).toContain(OTHER_TRACE);

    const cycles = await get('/cycles?all_identities=1');
    expect(cycles.body.scope).toEqual({ kind: 'all', identities: 1 });
    expect(cycles.body.cycles).toHaveLength(1);

    // `user_id` is the narrower instruction: given both, it wins (a narrower
    // read can never widen by accident).
    const narrower = await get(`/traces?user_id=${OWNER}&all_identities=1`);
    expect(narrower.body.scope).toEqual({ kind: 'named', identities: 1 });
    expect(narrower.body.traces.map((trace: any) => trace.trace_id)).not.toContain(OTHER_TRACE);

    // The per-identity views cannot span identities: `all_identities` is not
    // offered there, and the payload says which ONE identity it covers.
    const metrics = await get('/metrics?all_identities=1');
    expect(metrics.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(metrics.body.identity).toBe('operator');
    const team = await get('/team?all_identities=1');
    expect(team.body.scope).toEqual({ kind: 'caller', identities: 1 });
  });

  it('every view payload states its scope — including the flag-off payloads', async () => {
    const fixture = await seedCycleFixture();
    const paths = [
      '/overview',
      '/cycles',
      `/cycles/${fixture.cycleId}`,
      '/traces',
      `/archive?mission_id=${SCENARIO_MISSION}`,
      '/batons',
      '/team',
      '/metrics',
      '/experiments',
      '/experiments/compare',
    ];
    for (const path of paths) {
      const { body } = await get(path);
      expect(body.scope, `${path} states no scope`).toBeTruthy();
      expect(['caller', 'named', 'all'], `${path} scope kind`).toContain(body.scope.kind);
      expect(typeof body.scope.identities, `${path} scope identities`).toBe('number');
    }

    // Flag off: the view still says what its scope would be.
    delete process.env.FOCUSED_IMAGINATION;
    const off = await get('/traces');
    expect(off.body.plane).toBe('off');
    expect(off.body.scope).toEqual({ kind: 'caller', identities: 1 });
  });
});

// ── The experiment comparison + the ONE write ──────────────────────────────

describe('experiments — comparison verdicts and the gated write', () => {
  // Written and read by the CALLER's own identity (the trusted `operator`):
  // an experiment belongs to one identity, and the gated write is caller-owned.
  const EXPERIMENT = {
    userId: 'operator',
    name: 'Useful novelty: mixed modes vs one mode',
    hypothesis: 'A mixed-mode team produces more useful novelty than a single-mode team.',
    checkpoints: ['cycle-1', 'cycle-2'],
    arms: [
      { label: 'control', config: { team: 'single-mode' } },
      { label: 'treatment', config: { team: 'mixed-mode' } },
    ],
  };

  it('serves improved, not_improved and insufficient_data with the n and the threshold', async () => {
    const { experiment } = await registerExperiment(db.asDb(), EXPERIMENT);
    const id = experiment.experiment_id;

    const observe = (arm: string, metric: string, value: number, n: number) =>
      post('/experiments/observations', { experiment_id: id, arm, metric, value, n });
    expect((await observe('control', 'useful_novelty_rate', 0.4, 10)).status).toBe(200);
    expect((await observe('treatment', 'useful_novelty_rate', 0.7, 10)).status).toBe(200);

    const list = await get('/experiments');
    expect(list.body.experiments).toHaveLength(1);
    expect(list.body.experiments[0].observations).toBe(2);
    expect(list.body.experiments[0].metrics_recorded).toEqual(['useful_novelty_rate']);
    expect(list.body.write_path).toContain('/experiments/observations');

    const improved = await get(`/experiments/compare?experiment_id=${id}`);
    expect(improved.status).toBe(200);
    expect(improved.body.comparison.verdict).toBe('improved');
    const metric = improved.body.comparison.metrics[0];
    expect(metric.verdict).toBe('improved');
    expect(metric.relative_gain).toBeCloseTo(0.75, 6);
    expect(metric.target).toEqual({ direction: 'higher', min_relative_gain: 0.3, min_samples: 3, source: 'named-target' });
    expect(metric.n).toEqual({ baseline: 10, treatment: 10, minimum: 3 });
    expect(metric.basis).toContain('useful_novelty_rate');

    // The parameterised path reaches the same comparison.
    const viaPath = await get(`/experiments/${id}/compare`);
    expect(viaPath.body.comparison.verdict).toBe('improved');
    // …and a comma-separated side pools several arms (§7.4's Control A/B vs
    // Treatment C/D shape); pooling the two arms here keeps the same verdict.
    const pooled = await get(`/experiments/compare?experiment_id=${id}&baseline=control&treatment=treatment`);
    expect(pooled.body.comparison.baseline_arms).toEqual(['control']);
    expect(pooled.body.comparison.treatment_arms).toEqual(['treatment']);
    expect(pooled.body.comparison.metrics[0].baseline.arm).toBe('control');

    // not_improved
    await observe('control', 'idea_survival_rate', 0.8, 5);
    await observe('treatment', 'idea_survival_rate', 0.5, 5);
    const worse = await get(`/experiments/compare?experiment_id=${id}`);
    expect(worse.body.comparison.verdict).toBe('not_improved');
    expect(worse.body.comparison.metrics.find((row: any) => row.metric === 'idea_survival_rate').verdict).toBe('not_improved');

    // insufficient_data (n below the minimum)
    await observe('control', 'median_plateau_length', 5, 2);
    await observe('treatment', 'median_plateau_length', 9, 2);
    const thin = await get(`/experiments/compare?experiment_id=${id}`);
    const plateau = thin.body.comparison.metrics.find((row: any) => row.metric === 'median_plateau_length');
    expect(plateau.verdict).toBe('insufficient_data');
    expect(plateau.n.minimum).toBe(3);
    expect(plateau.reason).toContain('minimum');

    // An unknown experiment is a stated refusal, not an invented comparison.
    const missing = await get('/experiments/compare?experiment_id=impexp_absent');
    expect(missing.status).toBe(404);
    expect(missing.body.reason).toContain('no experiment');
    const noId = await get('/experiments/compare');
    expect(noId.status).toBe(400);
  });

  it('the write is trusted-only, flag-gated, closed, caller-owned and idempotent', async () => {
    const { experiment } = await registerExperiment(db.asDb(), EXPERIMENT);
    const body = { experiment_id: experiment.experiment_id, arm: 'control', metric: 'useful_novelty_rate', value: 0.4, n: 10 };

    const untrusted = await post('/experiments/observations', body, UNTRUSTED);
    expect(untrusted.status).toBe(403);
    expect(untrusted.body.code).toBe('untrusted_caller');

    const extraKey = await post('/experiments/observations', { ...body, user_id: OWNER });
    expect(extraKey.status).toBe(400);
    expect(extraKey.body.reason).toContain('user_id');

    const first = await post('/experiments/observations', body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ recorded: true, updated: false, unchanged: false });
    expect(first.body.observation.user_id).toBe('operator'); // the CALLER, never a supplied id

    const snapshot = JSON.stringify(db.collection('imagination_experiments').docs);
    const repeat = await post('/experiments/observations', body);
    expect(repeat.body).toMatchObject({ recorded: true, updated: false, unchanged: true });
    expect(JSON.stringify(db.collection('imagination_experiments').docs)).toBe(snapshot);

    const changed = await post('/experiments/observations', { ...body, value: 0.6 });
    expect(changed.body).toMatchObject({ recorded: true, updated: true, unchanged: false });
    const rows = db.collection('imagination_experiments').docs.filter((row: any) => row.kind === 'observation');
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(0.6);

    // Every successful call is audited with its outcome — including the one
    // that changed nothing, so a no-op is on record as a no-op.
    const audit = db.collection('custodian_audit').docs as Array<Record<string, any>>;
    expect(audit).toHaveLength(3);
    expect(audit.map((row) => row.action)).toEqual(['experiment_observation', 'experiment_observation', 'experiment_observation']);
    expect(audit[0].actor_id).toBe('operator');
    expect(audit.map((row) => row.detail.outcome)).toEqual(['recorded', 'unchanged', 'updated']);

    // With the flag off the write is disabled (no back door).
    delete process.env.FOCUSED_IMAGINATION;
    const gated = await post('/experiments/observations', { ...body, arm: 'treatment' });
    expect(gated.status).toBe(403);
    expect(gated.body.code).toBe('flag_off');
  });

  it('refuses an oversized note by name at the route, and a note at the limit still records', async () => {
    const { experiment } = await registerExperiment(db.asDb(), EXPERIMENT);
    const observation = {
      experiment_id: experiment.experiment_id,
      arm: 'control',
      metric: 'useful_novelty_rate',
      value: 0.4,
      n: 10,
    };

    // ITER-10 (F2): the MCP zod capped the note at 2000; the ROUTE accepted a
    // 1,048,595-character note because the service had no bound at all.
    const { status, body } = await post('/experiments/observations', { ...observation, note: 'n'.repeat(1_048_595) });
    expect(status).toBe(400);
    expect(body.recorded).toBe(false);
    expect(body.code).toBe('note_too_long');
    expect(body.reason).toContain('2000');
    // The refusal happens BEFORE a row is touched, and before the audit row.
    expect(db.collection('imagination_experiments').docs.filter((row: any) => row.kind === 'observation')).toHaveLength(0);
    expect(db.collection('custodian_audit').docs).toHaveLength(0);

    // …and the write is caller-owned, so its payload states that scope too.
    expect(body.scope).toEqual({ kind: 'caller', identities: 1 });

    const atLimit = 'n'.repeat(2000);
    const accepted = await post('/experiments/observations', { ...observation, note: atLimit });
    expect(accepted.status).toBe(200);
    expect(accepted.body.observation.note).toBe(atLimit);
    expect(accepted.body.scope).toEqual({ kind: 'caller', identities: 1 });
  });
});

// ── The rollout view ───────────────────────────────────────────────────────

describe('rollout view and the runbook it points at', () => {
  /**
   * Plant one deprecation counter row per identity (the shape the telemetry
   * service writes: one row per {identity, kind, UTC day}, TTL'd 30 days).
   */
  function plantDeprecationCounters(): void {
    const rows = [
      { user_id: OWNER, kind: 'legacy_read', count: 3 },
      { user_id: INTRUDER, kind: 'legacy_read', count: 1 },
    ];
    for (const row of rows) {
      db.collection('personality_deprecation_events').docs.push({
        event_key: `deprecation:${row.kind}:${row.user_id}:2026-09-26`,
        user_id: row.user_id,
        kind: row.kind,
        count: row.count,
        first_seen_at: '2026-09-26T10:00:00.000Z',
        last_seen_at: '2026-09-26T10:00:00.000Z',
        expires_at: '2026-10-26T10:00:00.000Z',
      });
    }
  }

  it('pins the deprecation counters to the caller, and only a trusted caller can widen that read', async () => {
    plantDeprecationCounters();

    // An UNTRUSTED caller sees its OWN counts — and cannot reach the other
    // identity's, not even by naming it or asking for everything.
    const own = await get('/rollout', UNTRUSTED);
    expect(own.body.deprecation_telemetry.events).toBe(1);
    expect(own.body.deprecation_telemetry.identities).toEqual([INTRUDER]);
    expect(own.body.scope).toEqual({ kind: 'caller', identities: 1 });
    expect(own.body.deprecation_telemetry.scope).toEqual({ kind: 'caller', identities: 1 });

    const named = await get(`/rollout?user_id=${OWNER}`, UNTRUSTED);
    expect(named.body.deprecation_telemetry.events).toBe(1);
    expect(named.body.deprecation_telemetry.identities).toEqual([INTRUDER]);
    expect(named.body.scope).toEqual({ kind: 'caller', identities: 1 });

    const greedy = await get('/rollout?all_identities=1', UNTRUSTED);
    expect(greedy.body.deprecation_telemetry.events).toBe(1);
    expect(greedy.body.deprecation_telemetry.identities).toEqual([INTRUDER]);
    expect(greedy.body.scope.kind).toBe('caller');

    // A TRUSTED caller's default is still its own identity…
    const trusted = await get('/rollout');
    expect(trusted.body.deprecation_telemetry.events).toBe(0);
    expect(trusted.body.deprecation_telemetry.identities).toEqual([TRUSTED.user_id]);
    expect(trusted.body.scope).toEqual({ kind: 'caller', identities: 1 });

    // …it may name ONE identity…
    const one = await get(`/rollout?user_id=${OWNER}`);
    expect(one.body.deprecation_telemetry.events).toBe(3);
    expect(one.body.deprecation_telemetry.identities).toEqual([OWNER]);
    expect(one.body.scope).toEqual({ kind: 'named', identities: 1 });

    // …and it may OPT IN to the cross-identity view, which says so.
    const all = await get('/rollout?all_identities=1');
    expect(all.body.deprecation_telemetry.events).toBe(4);
    expect(all.body.deprecation_telemetry.identities).toEqual([INTRUDER, OWNER].sort());
    expect(all.body.scope).toEqual({ kind: 'all', identities: 2 });
    expect(all.body.deprecation_telemetry.basis).toContain('across every identity');

    // `user_id` wins over `all_identities`: a read never widens by accident.
    const both = await get(`/rollout?all_identities=1&user_id=${INTRUDER}`);
    expect(both.body.deprecation_telemetry.events).toBe(1);
    expect(both.body.scope).toEqual({ kind: 'named', identities: 1 });
    // The payload's basis states the pinning rule.
    expect(trusted.body.basis).toContain('SCOPED LIKE EVERY OTHER VIEW');
  });

  it('derives every flag and kill-switch state from the environment', async () => {
    delete process.env.FOCUSED_IMAGINATION;
    const off = await get('/rollout');
    expect(off.body.flags.map((flag: any) => flag.name).sort()).toEqual([
      'COGNITIVE_TEAM_ALLOCATION',
      'CREATIVE_BATON_PROMOTION',
      'FOCUSED_IMAGINATION',
      'PER_IDENTITY_PERSONALITY',
    ]);
    expect(off.body.flags.every((flag: any) => flag.on === false)).toBe(true);
    expect(off.body.kill_switch_active).toBe(false);

    process.env.FOCUSED_IMAGINATION = '1';
    process.env.CREATIVE_BATON_PROMOTION = 'true';
    process.env.COGNITIVE_TEAM_ALLOCATION = 'yes';
    process.env.PER_IDENTITY_PERSONALITY = '1';
    process.env.COGNITIVE_ACTIVATION_KILL_SWITCH = '1';
    process.env.COGNITIVE_CONTROL_ENABLED = 'read';

    const on = await get('/rollout');
    const state = (name: string) => on.body.flags.find((flag: any) => flag.name === name).on;
    expect(state('FOCUSED_IMAGINATION')).toBe(true);
    expect(state('CREATIVE_BATON_PROMOTION')).toBe(true);
    expect(state('COGNITIVE_TEAM_ALLOCATION')).toBe(true);
    expect(state('PER_IDENTITY_PERSONALITY')).toBe(true);
    expect(on.body.kill_switch_active).toBe(true);
    const kill = on.body.kill_switches.find((row: any) => row.name === 'COGNITIVE_ACTIVATION_KILL_SWITCH');
    expect(kill.armed).toBe(true);
    expect(kill.env_var).toBe('COGNITIVE_ACTIVATION_KILL_SWITCH');
    expect(on.body.basis).toContain('never from constants');

    // The stages carry the metric gates and are marked with the MEASURED state.
    expect(on.body.stages.map((stage: any) => stage.flag)).toEqual([
      'PER_IDENTITY_PERSONALITY',
      'FOCUSED_IMAGINATION',
      'CREATIVE_BATON_PROMOTION',
      'COGNITIVE_TEAM_ALLOCATION',
    ]);
    for (const stage of on.body.stages) {
      expect(stage.flag_on).toBe(true);
      expect(stage.state).toBe('on');
      expect(stage.gates.length).toBeGreaterThan(0);
      expect(stage.watched.length).toBeGreaterThan(0);
    }

    // A flag that is not literally `1` is off — the flags fail closed.
    process.env.CREATIVE_BATON_PROMOTION = 'definitely-on';
    const strict = await get('/rollout');
    expect(strict.body.flags.find((flag: any) => flag.name === 'CREATIVE_BATON_PROMOTION').on).toBe(false);
  });

  it('docs/IMAGINATION-ROLLOUT.md names exactly the flags, kill switches and commands the code uses', async () => {
    const doc = readFileSync(new URL('../../../docs/IMAGINATION-ROLLOUT.md', import.meta.url), 'utf8');
    const routeSource = readFileSync(new URL('../../src/routes/imagination-dashboard-routes.ts', import.meta.url), 'utf8');
    const flagSource = [
      readFileSync(new URL('../../src/services/processing/focused-consolidation-service.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../src/services/processing/creative-baton-compiler.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../src/services/processing/cognitive-mode-service.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../src/services/integration/personality-config-service.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../src/services/mission-cognition/scheduler-mode.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../src/services/mission-cognition/index.ts', import.meta.url), 'utf8'),
    ].join('\n');

    const { body } = await get('/rollout');
    const envNames = [
      ...body.flags.map((flag: any) => flag.env_var),
      ...body.kill_switches.map((row: any) => row.env_var),
    ];
    // Every environment variable the rollout VIEW reports is named in the doc,
    // and the code really reads it.
    for (const name of envNames) {
      expect(doc, `${name} is not documented`).toContain(name);
      expect(flagSource, `${name} is not read by the flag code`).toContain(name);
    }
    // The five kill switches the contract names are all in the doc, and each is
    // read where it is defined.
    for (const name of [
      'PER_IDENTITY_PERSONALITY',
      'FOCUSED_IMAGINATION',
      'CREATIVE_BATON_PROMOTION',
      'COGNITIVE_TEAM_ALLOCATION',
      'COGNITIVE_ACTIVATION_KILL_SWITCH',
    ]) {
      expect(doc, `${name} missing from the runbook`).toContain(name);
      expect(flagSource, `${name} is not read by the code`).toContain(name);
    }
    // The rollback commands in the doc are the commands the code hands out.
    for (const command of [
      body.rollback.kill_switch_command,
      body.rollback.flag_off_command,
      body.rollback.code_rollback_command,
    ]) {
      expect(doc, `the runbook does not contain: ${command}`).toContain(command);
    }
    // …and the doc points at the view and the runbook path the code names.
    expect(doc).toContain('docs/IMAGINATION-ROLLOUT.md');
    expect(doc).toContain('/api/v1/imagination/rollout');
    // The deployment precondition inherited from ITER-2 is stated.
    expect(doc).toContain('bridge');
    expect(doc.toLowerCase()).toContain('deploy the bridge with');
    // No absolute home paths or machine names sneak into the new doc.
    expect(doc).not.toMatch(/\/Users\/|\/home\//);
    // The route module is where the rollout view is derived from the env.
    expect(routeSource).toContain("router.get('/rollout'");
    expect(routeSource).toContain('env_var');
  });
});

// ── Reference: the placeholder id used by the "no existence leak" check ────

describe('fixture sanity', () => {
  it('the seeded cycle really did reject candidates through the archive', async () => {
    const fixture = await seedCycleFixture();
    expect(fixture.rejected.length).toBe(COLLIDING_PREFILL);
    expect(fixture.admitted.length).toBeGreaterThanOrEqual(2);
    const cycle = db.collection(CYCLES).docs[0] as Record<string, any>;
    expect(cycle.counts.seeds_rejected).toBe(COLLIDING_PREFILL);
    expect(cycle.stop_reason).toBe('completed');
  });
});
