/**
 * ITER-9 — the imagination metrics service.
 * Contract: CONTRACT-iter9-observability.md §A + success criterion 3.
 *
 * Every number here is HAND-COMPUTED from a seeded fixture and asserted
 * against the service's own output, so a metric that quietly changes its
 * denominator fails. Beyond the numbers, two properties are pinned explicitly:
 *
 *   - EVERY metric carries a `basis` (window, n, sources, minimum, the sentence
 *     that says what was counted) — a metric without one fails;
 *   - a metric below its documented minimum reports `insufficient_data` rather
 *     than a fabricated rate, and cost-of-novelty with a zero denominator is
 *     `insufficient_data`, never `0`.
 *
 * The privacy metric is exercised as an AUDIT: a marker planted in a private
 * store and copied into a shared artefact is FOUND (flagged = 1), and the
 * report says how many artefacts and markers it checked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => null,
  is_database_connected: () => false,
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import {
  DEFAULT_METRICS_WINDOW_DAYS,
  MIN_GENERATED_SAMPLES,
  MIN_OUTCOME_SAMPLES,
  FORBIDDEN_SHARED_KEYS,
  computeImaginationMetrics,
  metricsWindowDays,
} from '../../src/services/processing/imagination-metrics-service.js';
import {
  EXPERIMENT_IMPROVEMENT_TARGETS,
  compareExperiment,
  experimentIdFor,
  getExperiment,
  listObservations,
  observationKeyFor,
  recordExperimentObservation,
  registerExperiment,
} from '../../src/services/processing/imagination-experiments.js';
import { focusedImaginationEnabled } from '../../src/services/processing/focused-consolidation-service.js';
import { IMAGINATION_EXPERIMENTS_COLLECTION } from '../../src/services/processing/imagination-experiments.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const USER = 'metric-owner';
const OTHER = 'metric-other';
const MISSION = 'm_metrics';
const NOW = '2026-09-26T12:00:00.000Z';

const TRUSTED: CallerIdentity = { user_id: USER, trusted: true };
const UNTRUSTED: CallerIdentity = { user_id: USER, trusted: false };

const CYCLES = 'imagination_cycles';
const OUTCOMES = 'idea_candidate_outcomes';
const SEEDS = 'idea_seeds';
const CELLS = 'idea_archive_cells';
const LINEAGES = 'idea_lineages';
const TRACES = 'salience_traces';
const PORTFOLIOS = 'cognitive_portfolios';
const BATONS = 'creative_batons';
const PROMOTIONS = 'creative_baton_promotions';

const MARKER_HYPOTHESIS = 'PRIVATE-REJECTED-HYPOTHESIS-DO-NOT-LEAK';
const MARKER_PREMISE = 'PRIVATE-CHANGED-PREMISE-DO-NOT-LEAK';
const MARKER_STATEMENT = 'PRIVATE-TRACE-STATEMENT-DO-NOT-LEAK';

function iso(daysAgo: number, hours = 0, minutes = 0): string {
  const base = Date.parse(NOW) - daysAgo * 24 * 60 * 60 * 1000 - hours * 3600 * 1000 - minutes * 60 * 1000;
  return new Date(base).toISOString();
}

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  delete process.env.IMAGINATION_METRICS_WINDOW_DAYS;
});

/**
 * The hand-computed fixture:
 *
 *   cycles     3 in the window (new cells 2, 1, 3 → mean 2; tokens 100+50+25 = 175)
 *   cells      5 rows
 *   seeds      7 generated: 4 admitted, 3 rejected (duplicate_of, paraphrase_of,
 *              missing_changed_premise → 2 of the 7 count as false novelty)
 *   outcomes   5 rows, 3 of them useful_information over 3 distinct seeds
 *   gaps       c1: 5 min to its first admitted candidate, c2: 10 min, c3: 60 min
 *              → median 10 min = 600000 ms
 */
function seedMetricsFixture(): void {
  const cycles = [
    { cycle_id: 'cyc_1', counts: { new_cells: 2, cells_total: 4 }, tokens: 100, gaps: [{ dimension: 'mechanism', unoccupied_bins: ['bridge', 'inversion'] }] },
    { cycle_id: 'cyc_2', counts: { new_cells: 1, cells_total: 4 }, tokens: 50, gaps: [{ dimension: 'mechanism', unoccupied_bins: ['bridge'] }] },
    { cycle_id: 'cyc_3', counts: { new_cells: 3, cells_total: 5 }, tokens: 25, gaps: [{ dimension: 'mechanism', unoccupied_bins: ['inversion'] }] },
  ];
  cycles.forEach((cycle, index) => {
    db.collection(CYCLES).docs.push({
      schema_version: '1.0',
      cycle_id: cycle.cycle_id,
      user_id: USER,
      mission_id: MISSION,
      mission_version: 3,
      trigger: 'plateau',
      actor_id: USER,
      forced: false,
      status: 'completed',
      stop_reason: 'completed',
      stop_conditions: [],
      plateau: [{ name: 'archive_coverage_below_floor', met: true, evidence: { cells_total: 4, floor: 6 } }],
      counts: {
        seeds_generated: 3,
        seeds_admitted: 2,
        seeds_below_incumbent: 0,
        seeds_rejected: 1,
        candidates_considered: 2,
        candidates_eligible: 2,
        new_cells: cycle.counts.new_cells,
        cells_total: cycle.counts.cells_total,
      },
      budget: { window_ms: 1000, max_cycles: 3, max_tokens: 20000, tokens_spent_this_cycle: cycle.tokens },
      coverage: { gaps: cycle.gaps, cells_total: cycle.counts.cells_total, scan: { truncated: false } },
      created_at: iso(3 - index),
      completed_at: iso(3 - index),
    });
  });

  for (let index = 0; index < 5; index += 1) {
    db.collection(CELLS).docs.push({
      schema_version: '1.0',
      user_id: USER,
      mission_id: MISSION,
      cell_key: `cell_${index}`,
      bins: { mechanism: 'removal' },
      incumbent_seed_id: `seed_a${index}`,
      quality: 0.7,
      history: [],
      seed_count: 1,
      created_cycle_id: 'cyc_1',
      last_cycle_id: 'cyc_3',
      coverage_date: '2026-09-26',
    });
  }

  const admitted = [
    { seed_id: 'seed_a1', cycle_id: 'cyc_1', created_at: iso(3, 0, -5) },
    { seed_id: 'seed_a2', cycle_id: 'cyc_2', created_at: iso(2, 0, -10) },
    // Cycle 3's trigger is at NOW-24h; these are 60/90/120 minutes AFTER it, so
    // the cycle's gap is 60 minutes (seed_a3 is the earliest admitted one).
    { seed_id: 'seed_a3', cycle_id: 'cyc_3', created_at: iso(1, 0, -60) },
    { seed_id: 'seed_a4', cycle_id: 'cyc_3', created_at: iso(1, 0, -90) },
    // Admitted, never judged: it makes idea survival a PARTIAL rate.
    { seed_id: 'seed_a5', cycle_id: 'cyc_3', created_at: iso(1, 0, -120) },
  ];
  for (const seed of admitted) {
    db.collection(SEEDS).docs.push({
      schema_version: '1.0',
      ...seed,
      user_id: USER,
      mission_id: MISSION,
      operator: 'assumption_inversion',
      hypothesis: `admitted ${seed.seed_id}`,
      mechanism: 'a mechanism',
      state: 'admitted',
      quality: 0.7,
      novelty_score: 0.8,
      coherence_score: 0.7,
      rank: 1,
    });
  }
  db.collection(SEEDS).docs.push(
    {
      schema_version: '1.0',
      seed_id: 'seed_r1',
      user_id: USER,
      mission_id: MISSION,
      cycle_id: 'cyc_1',
      operator: 'assumption_inversion',
      hypothesis: MARKER_HYPOTHESIS,
      mechanism: 'the rejected mechanism',
      state: 'rejected',
      quality: 0,
      novelty_score: 0.1,
      coherence_score: 0.1,
      rank: 1,
      rejection: { reason: 'duplicate_of', detail: 'same as seed_a1', duplicate_of: 'seed_a1', at: iso(3) },
      created_at: iso(3),
    },
    {
      schema_version: '1.0',
      seed_id: 'seed_r2',
      user_id: USER,
      mission_id: MISSION,
      cycle_id: 'cyc_1',
      operator: 'representation_shift',
      hypothesis: 'a paraphrase of something already known',
      mechanism: 'the paraphrasing mechanism',
      state: 'rejected',
      quality: 0,
      novelty_score: 0.2,
      coherence_score: 0.2,
      rank: 2,
      rejection: { reason: 'paraphrase_of', detail: 'too close', duplicate_of: 'seed_a1', at: iso(3) },
      created_at: iso(3),
    },
    {
      schema_version: '1.0',
      seed_id: 'seed_r3',
      user_id: USER,
      mission_id: MISSION,
      cycle_id: 'cyc_2',
      operator: 'boundary_extreme',
      hypothesis: 'a schema-invalid seed',
      mechanism: 'no premise stated',
      state: 'rejected',
      quality: 0,
      novelty_score: 0.3,
      coherence_score: 0.3,
      rank: 1,
      rejection: { reason: 'missing_changed_premise', detail: 'no premise', duplicate_of: null, at: iso(2) },
      created_at: iso(2),
    },
  );

  const outcomeRows = [
    { seed_id: 'seed_a1', outcome: 'useful_information' },
    { seed_id: 'seed_a2', outcome: 'useful_information' },
    { seed_id: 'seed_a4', outcome: 'useful_information' },
    { seed_id: 'seed_a3', outcome: 'mere_variance' },
    { seed_id: 'seed_a3', outcome: 'unnecessary_cost' },
  ];
  outcomeRows.forEach((row, index) => {
    db.collection(OUTCOMES).docs.push({
      schema_version: '1.0',
      outcome_id: `outcome_${index}`,
      user_id: USER,
      mission_id: MISSION,
      seed_id: row.seed_id,
      baton_id: null,
      outcome: row.outcome,
      detail: null,
      recorded_at: iso(2, 0, index),
    });
  });

  db.collection(LINEAGES).docs.push({
    schema_version: '1.0',
    lineage_id: 'lineage_1',
    seed_id: 'seed_a1',
    user_id: USER,
    mission_id: MISSION,
    cycle_id: 'cyc_1',
    operator: 'assumption_inversion',
    parent_seed_ids: [],
    transformations: [],
    tests: [],
    results: [],
    failure_signatures: [],
    changed_premise: MARKER_PREMISE,
    created_at: iso(3),
  });

  db.collection(TRACES).docs.push({
    schema_version: '1.0',
    trace_id: 'trace_1',
    user_id: USER,
    mission_id: MISSION,
    cycle_id: 'cyc_1',
    signals: [
      { kind: 'tension', statement: MARKER_STATEMENT, why_operationally_relevant: 'because', intensity: 0.8, confidence: 0.7, valence: -0.4, evidence_refs: ['ent_1'], low_confidence: false },
    ],
    created_at: iso(3),
  });
}

/** The control-vs-treatment divergence fixture (hand-computed below). */
function seedDivergenceFixture(): void {
  const same = { hypothesis: 'the drain becomes countable once the probe sits on the queue head', mechanism: 'instrumentation makes the outflow visible' };
  // Zero shared content tokens by construction, so the archive's own metric
  // returns exactly 0 for this pair (asserted below before the mean is checked).
  const other = { hypothesis: 'quixotic zephyr marmalade tumbler', mechanism: 'brindled copse vexation yonder' };
  db.collection(PORTFOLIOS).docs.push(
    {
      schema_version: '1.0',
      kind: 'first_pass',
      portfolio_id: 'port_mixed',
      pass_id: 'pass_mixed',
      user_id: USER,
      mission_id: MISSION,
      status: 'ran',
      team: [
        { identity: USER, mode: 'creative', envelope_id: null },
        { identity: OTHER, mode: 'analyst', envelope_id: null },
      ],
      results: [
        { identity: USER, mode: 'creative', status: 'completed', seeds: [{ ...same }], seeds_admitted: 1, seeds_rejected: 0, llm_calls: 1 },
        { identity: OTHER, mode: 'analyst', status: 'completed', seeds: [{ ...same }], seeds_admitted: 1, seeds_rejected: 0, llm_calls: 1 },
      ],
      created_at: iso(1),
    },
    {
      schema_version: '1.0',
      kind: 'first_pass',
      portfolio_id: 'port_samemode',
      pass_id: 'pass_samemode',
      user_id: USER,
      mission_id: MISSION,
      status: 'ran',
      team: [
        { identity: USER, mode: 'creative', envelope_id: null },
        { identity: OTHER, mode: 'creative', envelope_id: null },
      ],
      results: [
        { identity: USER, mode: 'creative', status: 'completed', seeds: [{ ...same }], seeds_admitted: 1, seeds_rejected: 0, llm_calls: 1 },
        { identity: OTHER, mode: 'creative', status: 'completed', seeds: [{ ...other }], seeds_admitted: 1, seeds_rejected: 0, llm_calls: 1 },
      ],
      created_at: iso(1),
    },
  );
}

describe('imagination metrics — hand-computed values with their bases', () => {
  it('computes every metric from the seeded fixture and states what each number is', async () => {
    seedMetricsFixture();
    const metrics = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });

    // ── Window and minimums ──────────────────────────────────────────────
    expect(metrics.window.days).toBe(DEFAULT_METRICS_WINDOW_DAYS);
    expect(metrics.window.to).toBe(NOW);
    expect(metrics.window.from).toBe('2026-09-12T12:00:00.000Z');
    expect(metrics.minimum_samples).toEqual({ outcomes: 5, generated: 5, cycles: 1, agents: 2 });

    // ── 1. useful novelty rate: 3 of 5 outcomes, n = 5 (at the minimum) ──
    expect(metrics.useful_novelty_rate.status).toBe('ok');
    expect(metrics.useful_novelty_rate.value).toEqual({ rate: 0.6, useful_outcomes: 3 });
    expect(metrics.useful_novelty_rate.basis.n).toBe(5);
    expect(metrics.useful_novelty_rate.basis.minimum).toBe(MIN_OUTCOME_SAMPLES);
    expect(metrics.useful_novelty_rate.basis.sources).toEqual([OUTCOMES]);
    expect(metrics.useful_novelty_rate.basis.measurement).toContain('useful_information');
    expect(metrics.useful_novelty_rate.reason).toBeNull();

    // ── 2. coverage gain: (2 + 1 + 3) / 3 = 2, last cycle 3, 5 live cells ─
    expect(metrics.archive_coverage_gain.status).toBe('ok');
    expect(metrics.archive_coverage_gain.value).toEqual({
      mean_new_cells_per_cycle: 2,
      last_cycle_new_cells: 3,
      cells_total: 5,
      gap_dimensions: 1,
      unoccupied_bins: 1,
    });
    expect(metrics.archive_coverage_gain.basis.n).toBe(3);
    expect(metrics.archive_coverage_gain.basis.sources).toEqual([CYCLES, CELLS]);

    // ── 3. idea survival (proxy): 4 of 5 admitted carry an outcome ───────
    expect(metrics.idea_survival.status).toBe('ok');
    expect(metrics.idea_survival.value).toEqual({ rate: 0.8, admitted_with_outcome: 4, admitted: 5 });
    expect(metrics.idea_survival.basis.measurement).toContain('PROXY');

    // ── 4. time to next viable direction: median of 5 / 10 / 60 min ──────
    expect(metrics.time_to_next_viable_direction.status).toBe('ok');
    expect(metrics.time_to_next_viable_direction.value).toEqual({
      median_ms: 600_000,
      samples: [300_000, 600_000, 3_600_000],
    });
    expect(metrics.time_to_next_viable_direction.basis.n).toBe(3);
    expect(metrics.time_to_next_viable_direction.basis.measurement).toContain('median gap');

    // ── 5. false novelty: 2 of 8 generated (duplicate_of + paraphrase_of) ─
    expect(metrics.false_novelty.status).toBe('ok');
    expect(metrics.false_novelty.value).toEqual({ rate: 0.25, rejected_as_seen: 2, generated: 8 });
    expect(metrics.false_novelty.basis.n).toBe(8);
    expect(metrics.false_novelty.basis.minimum).toBe(MIN_GENERATED_SAMPLES);

    // ── 6. cost of novelty: 175 tokens / 3 distinct useful candidates ────
    expect(metrics.cost_of_novelty.status).toBe('ok');
    expect(metrics.cost_of_novelty.value).toEqual({ tokens_per_useful_candidate: 58.33, tokens: 175, useful_candidates: 3 });
    expect(metrics.cost_of_novelty.basis.measurement).toContain('usage ledger');

    // ── 7. privacy: nothing shared exists yet, and the audit says so ─────
    expect(metrics.privacy_leakage.flagged).toBe(0);
    expect(metrics.privacy_leakage.shared_artefacts_scanned).toBe(0);
    // Markers: 3 rejected seeds × (hypothesis + mechanism) + 1 changed premise
    // + 1 trace statement = 8.
    expect(metrics.privacy_leakage.markers_checked).toBe(8);
    expect(metrics.privacy_leakage.basis.measurement).toContain('audit over the shared-scope rows');

    // ── 9. personality stability: nothing stored, nothing violated ───────
    expect(metrics.personality_stability).toMatchObject({ violations: 0, envelopes_checked: 0, assignments_checked: 0, by_code: {} });
    expect(metrics.personality_stability.basis.measurement).toContain('Expected 0');

    // ── Every metric present, every one with a basis ─────────────────────
    for (const key of [
      'useful_novelty_rate',
      'archive_coverage_gain',
      'idea_survival',
      'time_to_next_viable_direction',
      'false_novelty',
      'agent_divergence',
      'agent_divergence_same_mode_control',
      'cost_of_novelty',
    ]) {
      const metric = (metrics as unknown as Record<string, any>)[key];
      expect(metric, `${key} missing`).toBeTruthy();
      expect(metric.basis, `${key} has no basis`).toBeTruthy();
      expect(metric.basis.window).toBeTruthy();
      expect(typeof metric.basis.n).toBe('number');
      expect(Array.isArray(metric.basis.sources) && metric.basis.sources.length > 0).toBe(true);
      expect(typeof metric.basis.measurement).toBe('string');
      expect(metric.basis.measurement.length).toBeGreaterThan(10);
    }
  });

  it('reports insufficient_data below every documented minimum rather than a rate', async () => {
    // Four outcomes (one short of five) and four generated candidates.
    db.collection(OUTCOMES).docs.push(
      ...Array.from({ length: 4 }, (_v, index) => ({
        outcome_id: `o${index}`,
        user_id: USER,
        mission_id: MISSION,
        seed_id: `seed_x${index}`,
        outcome: index < 2 ? 'useful_information' : 'mere_variance',
        recorded_at: iso(1),
      })),
    );
    db.collection(SEEDS).docs.push(
      ...Array.from({ length: 4 }, (_v, index) => ({
        seed_id: `seed_x${index}`,
        user_id: USER,
        mission_id: MISSION,
        cycle_id: 'cyc_none',
        state: 'rejected',
        rejection: { reason: 'duplicate_of' },
        created_at: iso(1),
      })),
    );
    const metrics = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });

    expect(metrics.useful_novelty_rate.status).toBe('insufficient_data');
    expect(metrics.useful_novelty_rate.value).toBeNull();
    expect(metrics.useful_novelty_rate.reason).toContain('at least 5');
    expect(metrics.false_novelty.status).toBe('insufficient_data');
    expect(metrics.false_novelty.reason).toContain('at least 5');
    // Nothing ran: no cycle, no admitted candidate, no gap to measure, no team.
    expect(metrics.archive_coverage_gain.status).toBe('insufficient_data');
    expect(metrics.idea_survival.status).toBe('insufficient_data');
    expect(metrics.time_to_next_viable_direction.status).toBe('insufficient_data');
    expect(metrics.agent_divergence.status).toBe('insufficient_data');
    // …and the bases are still there, reporting the n that was too small.
    expect(metrics.useful_novelty_rate.basis.n).toBe(4);
    expect(metrics.false_novelty.basis.n).toBe(4);
  });

  it('cost of novelty with a zero denominator is insufficient_data, NOT 0', async () => {
    seedMetricsFixture();
    // Strip every outcome row: the denominator becomes 0 while tokens remain.
    db.collection(OUTCOMES).docs = [];
    const metrics = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });

    expect(metrics.cost_of_novelty.status).toBe('insufficient_data');
    expect(metrics.cost_of_novelty.value).toBeNull();
    expect(metrics.cost_of_novelty.reason).toContain('insufficient data, not a cost of 0');
    expect(metrics.useful_novelty_rate.status).toBe('insufficient_data');
  });

  it('the privacy metric is an audit: a marker copied into a shared artefact is FOUND', async () => {
    seedMetricsFixture();
    db.collection(BATONS).docs.push(
      {
        baton_id: 'cbaton_clean',
        user_id: USER,
        mission_id: MISSION,
        shared_id: 'my-team',
        payload_hash: 'sha256:clean',
        candidate_portfolio: [{ seed_id: 'seed_a1', hypothesis: 'an admitted candidate', mechanism: 'its mechanism' }],
        attention_targets: [{ cue: 'derive:mechanism', why_operationally_relevant: 'derived', operator_families: ['representation_shift'] }],
        created_at: iso(1),
      },
      {
        baton_id: 'cbaton_leaky',
        user_id: USER,
        mission_id: MISSION,
        shared_id: 'my-team',
        payload_hash: 'sha256:leaky',
        attention_targets: [{ cue: MARKER_STATEMENT, why_operationally_relevant: 'derived', operator_families: [] }],
        created_at: iso(1),
      },
      {
        baton_id: 'cbaton_forbidden_key',
        user_id: USER,
        mission_id: MISSION,
        shared_id: 'my-team',
        payload_hash: 'sha256:key',
        changed_premise: 'a premise that should never be shared',
        created_at: iso(1),
      },
    );
    db.collection(PROMOTIONS).docs.push({
      promotion_id: 'promo_1',
      user_id: USER,
      mission_id: MISSION,
      baton_id: 'cbaton_clean',
      promoted_by: USER,
      promoted_at: iso(1),
      payload_hash: 'sha256:clean',
    });

    const metrics = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });

    // 3 shared batons + 1 promotion row = 4 artefacts scanned; 2 flagged (one by
    // a private marker, one by a forbidden key).
    expect(metrics.privacy_leakage.shared_artefacts_scanned).toBe(4);
    expect(metrics.privacy_leakage.flagged).toBe(2);
    expect(metrics.privacy_leakage.markers_checked).toBe(8);
    expect(metrics.privacy_leakage.keys_checked).toEqual([...FORBIDDEN_SHARED_KEYS]);
  });

  it('divergence reuses the archive metric, and the same-mode control is reported separately', async () => {
    seedMetricsFixture();
    seedDivergenceFixture();
    const metrics = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });

    // Treatment: one pair of identical statements (1.0) and one pair of
    // disjoint statements (0.0) → mean 0.5 over 2 comparisons, 4 agents.
    expect(metrics.agent_divergence.status).toBe('ok');
    expect(metrics.agent_divergence.value).toEqual({ mean_pairwise_similarity: 0.5, comparisons: 2, agents: 4 });
    expect(metrics.agent_divergence.basis.measurement).toContain('statementSimilarity');

    // Control: only the record whose agents all took one mode → 0.0 over 1 pair.
    expect(metrics.agent_divergence_same_mode_control.status).toBe('ok');
    expect(metrics.agent_divergence_same_mode_control.value).toEqual({ mean_pairwise_similarity: 0, comparisons: 1, agents: 2 });
    expect(metrics.agent_divergence_same_mode_control.basis.measurement).toContain('control');
  });

  it('a tampered inheritance envelope is counted as a personality-stability violation, by code', async () => {
    db.collection('inheritance_envelopes').docs.push(
      {
        envelope_id: 'env_weakened',
        parent_identity_id: USER,
        mission_id: MISSION,
        envelope_version: '1.0',
        bounds: { message_priority: 5 },
        created_at: iso(1),
      },
      {
        envelope_id: 'env_no_version',
        parent_identity_id: USER,
        mission_id: MISSION,
        created_at: iso(1),
      },
    );
    db.collection('thinking_mode_assignments').docs.push({
      assignment_id: 'assign_1',
      user_id: USER,
      mission_id: MISSION,
      mode: 'analyst',
      status: 'active',
      schema_version: '1.0',
      unexpected_field: true,
      created_at: iso(1),
    });

    const metrics = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });
    expect(metrics.personality_stability.envelopes_checked).toBe(2);
    expect(metrics.personality_stability.assignments_checked).toBe(1);
    // The weakened priority is refused as an INVARIANT violation (the value
    // re-check runs before the schema check on purpose); the version-less row
    // is refused by name; the assignment with an extra key is schema_invalid.
    expect(metrics.personality_stability.by_code).toEqual({
      invariant_violation: 1,
      version_unsupported: 1,
      schema_invalid: 1,
    });
    expect(metrics.personality_stability.violations).toBe(3);
  });

  it('the window is overridable per call and by environment, and only windowed rows count', async () => {
    seedMetricsFixture();
    expect(metricsWindowDays()).toBe(DEFAULT_METRICS_WINDOW_DAYS);
    process.env.IMAGINATION_METRICS_WINDOW_DAYS = '30';
    expect(metricsWindowDays()).toBe(30);
    process.env.IMAGINATION_METRICS_WINDOW_DAYS = 'not-a-number';
    expect(metricsWindowDays()).toBe(DEFAULT_METRICS_WINDOW_DAYS);

    // ONE day: only the newest cycle falls inside the window, and neither the
    // outcomes (2 days back) nor the seeds (≥ 23 h 40 m back) reach the minimum.
    const narrow = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, windowDays: 1, now: () => NOW });
    expect(narrow.window.days).toBe(1);
    expect(narrow.useful_novelty_rate.status).toBe('insufficient_data');
    expect(narrow.useful_novelty_rate.basis.n).toBe(0);
    expect(narrow.false_novelty.status).toBe('insufficient_data');
    expect(narrow.false_novelty.basis.n).toBe(3);
    expect(narrow.archive_coverage_gain.status).toBe('ok');
    expect(narrow.archive_coverage_gain.basis.n).toBe(1);
    expect(narrow.archive_coverage_gain.value.last_cycle_new_cells).toBe(3);
    // The gap metric reads the mission's ADMITTED candidates (not the windowed
    // ones), so one cycle is enough to measure it.
    expect(narrow.time_to_next_viable_direction.status).toBe('ok');
    expect(narrow.time_to_next_viable_direction.basis.n).toBe(1);
    expect(narrow.time_to_next_viable_direction.value.median_ms).toBe(3_600_000);
  });
});

describe('cost of novelty — a recorded spend is a cost, an unrecorded one is not zero (ITER-10 F3)', () => {
  /**
   * A window holding `useful` judged candidates and cycles whose ledger either
   * recorded a token count or recorded nothing at all (`null` = no budget
   * field, as an older or partially written cycle row has).
   */
  function seedCostFixture(args: { tokens: Array<number | null>; useful: number }): void {
    args.tokens.forEach((tokens, index) => {
      db.collection(CYCLES).docs.push({
        schema_version: '1.0',
        cycle_id: `cyc_cost_${index}`,
        user_id: USER,
        mission_id: MISSION,
        mission_version: 1,
        trigger: 'plateau',
        status: 'completed',
        stop_reason: 'completed',
        counts: { seeds_generated: 1, seeds_admitted: 1, seeds_rejected: 0, new_cells: 1, cells_total: 1 },
        ...(tokens === null ? {} : { budget: { window_ms: 1000, max_tokens: 20000, tokens_spent_this_cycle: tokens } }),
        created_at: iso(1),
      });
    });
    for (let index = 0; index < args.useful; index += 1) {
      db.collection(SEEDS).docs.push({
        schema_version: '1.0',
        seed_id: `seed_cost_${index}`,
        user_id: USER,
        mission_id: MISSION,
        cycle_id: 'cyc_cost_0',
        state: 'admitted',
        created_at: iso(1, 0, -5),
      });
      db.collection(OUTCOMES).docs.push({
        schema_version: '1.0',
        outcome_id: `o_cost_${index}`,
        user_id: USER,
        mission_id: MISSION,
        seed_id: `seed_cost_${index}`,
        outcome: 'useful_information',
        recorded_at: iso(1),
      });
    }
  }

  it('with a useful candidate but no recorded token spend it is insufficient_data, NOT a free 0', async () => {
    seedCostFixture({ tokens: [0], useful: 1 });
    const unrecorded = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });

    expect(unrecorded.cost_of_novelty.status).toBe('insufficient_data');
    expect(unrecorded.cost_of_novelty.value).toBeNull();
    // The SAMPLE behind the metric is reported; what is missing is the spend.
    expect(unrecorded.cost_of_novelty.basis.n).toBe(1);
    expect(unrecorded.cost_of_novelty.basis.sources).toEqual([CYCLES, OUTCOMES]);
    // The basis states that the spend was UNRECORDED rather than genuinely 0.
    expect(unrecorded.cost_of_novelty.basis.measurement.toLowerCase()).toContain('unrecorded');
    expect(unrecorded.cost_of_novelty.reason.toLowerCase()).toContain('unrecorded');
    expect(unrecorded.cost_of_novelty.reason).toContain('not zero');

    // …and the zero-denominator case keeps its own, different, stated reason.
    db.collection(OUTCOMES).docs = [];
    const noCandidates = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });
    expect(noCandidates.cost_of_novelty.status).toBe('insufficient_data');
    expect(noCandidates.cost_of_novelty.reason).toContain('zero denominator is insufficient data, not a cost of 0');
  });

  it('is ok — with the token count — once ONE included cycle recorded a non-zero spend', async () => {
    seedCostFixture({ tokens: [40], useful: 1 });
    const recorded = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });
    expect(recorded.cost_of_novelty.status).toBe('ok');
    expect(recorded.cost_of_novelty.value).toEqual({ tokens_per_useful_candidate: 40, tokens: 40, useful_candidates: 1 });
    expect(recorded.cost_of_novelty.basis.n).toBe(1);

    // A window whose cycles recorded 0 AND 40 is still a recorded spend: the
    // sum is what the ledger holds, and the mean is over the useful candidates.
    db.collection(CYCLES).docs.push({
      schema_version: '1.0',
      cycle_id: 'cyc_cost_extra',
      user_id: USER,
      mission_id: MISSION,
      mission_version: 1,
      trigger: 'plateau',
      status: 'completed',
      stop_reason: 'completed',
      counts: { seeds_generated: 1, seeds_admitted: 1, seeds_rejected: 0, new_cells: 1, cells_total: 1 },
      budget: { window_ms: 1000, max_tokens: 20000, tokens_spent_this_cycle: 60 },
      created_at: iso(1),
    });
    const summed = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });
    expect(summed.cost_of_novelty.status).toBe('ok');
    expect(summed.cost_of_novelty.value).toEqual({ tokens_per_useful_candidate: 100, tokens: 100, useful_candidates: 1 });
  });

  it('treats a window with no cycle (and a cycle with no budget field) as unrecorded, never as free', async () => {
    // A useful candidate judged with NO cycle row in the window at all.
    seedCostFixture({ tokens: [], useful: 1 });
    const noCycles = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });
    expect(noCycles.cost_of_novelty.status).toBe('insufficient_data');
    expect(noCycles.cost_of_novelty.reason.toLowerCase()).toContain('unrecorded');

    // A cycle row that carries no budget at all is unrecorded too.
    db.collection(CYCLES).docs.push({
      schema_version: '1.0',
      cycle_id: 'cyc_no_budget',
      user_id: USER,
      mission_id: MISSION,
      mission_version: 1,
      trigger: 'plateau',
      status: 'completed',
      stop_reason: 'completed',
      counts: { seeds_generated: 1, seeds_admitted: 1, seeds_rejected: 0, new_cells: 1, cells_total: 1 },
      created_at: iso(1),
    });
    const noBudget = await computeImaginationMetrics(db.asDb(), { userId: USER, missionId: MISSION, now: () => NOW });
    expect(noBudget.cost_of_novelty.status).toBe('insufficient_data');
    expect(noBudget.cost_of_novelty.basis.n).toBe(1);
  });
});

describe('imagination experiments — the gated write and the comparison', () => {
  const EXPERIMENT = {
    userId: USER,
    name: 'Useful novelty: mixed modes vs one mode',
    hypothesis: 'A mixed-mode team produces more useful novelty than a single-mode team.',
    checkpoints: ['cycle-1', 'cycle-2'],
    arms: [
      { label: 'control', config: { team: 'single-mode' } },
      { label: 'treatment', config: { team: 'mixed-mode' } },
    ],
  };

  it('registers idempotently by a derived id', async () => {
    const first = await registerExperiment(db.asDb(), EXPERIMENT);
    const second = await registerExperiment(db.asDb(), EXPERIMENT);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.experiment.experiment_id).toBe(first.experiment.experiment_id);
    expect(first.experiment.experiment_id).toBe(experimentIdFor({ ...EXPERIMENT }));
    expect(db.collection(IMAGINATION_EXPERIMENTS_COLLECTION).docs).toHaveLength(1);
  });

  it('the one write is gated: flag off and untrusted callers are refused before anything is touched', async () => {
    const { experiment } = await registerExperiment(db.asDb(), EXPERIMENT);
    const args = { experiment_id: experiment.experiment_id, arm: 'control', metric: 'useful_novelty_rate', value: 0.4, n: 10 };

    delete process.env.FOCUSED_IMAGINATION;
    expect(focusedImaginationEnabled()).toBe(false);
    const flagOff = await recordExperimentObservation(db.asDb(), args, TRUSTED);
    expect(flagOff).toMatchObject({ recorded: false, code: 'flag_off' });

    process.env.FOCUSED_IMAGINATION = '1';
    const untrusted = await recordExperimentObservation(db.asDb(), args, UNTRUSTED);
    expect(untrusted).toMatchObject({ recorded: false, code: 'untrusted_caller' });

    // A closed shape: an unknown key is refused by name.
    const extra = await recordExperimentObservation(db.asDb(), { ...args, user_id: 'somebody-else' } as never, TRUSTED);
    expect(extra).toMatchObject({ recorded: false, code: 'invalid_args' });
    expect(extra.reason).toContain('user_id');

    // Unknown experiment / arm / checkpoint are each refused by name.
    const missing = await recordExperimentObservation(db.asDb(), { ...args, experiment_id: 'impexp_nope' }, TRUSTED);
    expect(missing.code).toBe('experiment_not_found');
    const badArm = await recordExperimentObservation(db.asDb(), { ...args, arm: 'arm-z' }, TRUSTED);
    expect(badArm.code).toBe('unknown_arm');
    const badCheckpoint = await recordExperimentObservation(db.asDb(), { ...args, checkpoint: 'cycle-99' }, TRUSTED);
    expect(badCheckpoint.code).toBe('unknown_checkpoint');

    // Nothing was written by any refusal.
    await expect(listObservations(db.asDb(), USER, experiment.experiment_id)).resolves.toHaveLength(0);
    delete process.env.FOCUSED_IMAGINATION;
  });

  it('is idempotent per {experiment, arm, metric, checkpoint}: same key updates, same numbers write nothing', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const { experiment } = await registerExperiment(db.asDb(), EXPERIMENT);

    const first = await recordExperimentObservation(
      db.asDb(),
      { experiment_id: experiment.experiment_id, arm: 'control', metric: 'useful_novelty_rate', value: 0.4, n: 10, note: 'cycle one' },
      TRUSTED,
    );
    expect(first).toMatchObject({ recorded: true, updated: false, unchanged: false });
    const rows = db.collection(IMAGINATION_EXPERIMENTS_COLLECTION).docs.filter((row) => row.kind === 'observation');
    expect(rows).toHaveLength(1);
    expect(rows[0].observation_key).toBe(
      observationKeyFor({
        userId: USER,
        experimentId: experiment.experiment_id,
        arm: 'control',
        metric: 'useful_novelty_rate',
        checkpoint: 'cycle-1',
      }),
    );
    expect(rows[0].user_id).toBe(USER);

    // The SAME numbers: nothing is written at all.
    const snapshot = JSON.stringify(db.collection(IMAGINATION_EXPERIMENTS_COLLECTION).docs);
    const repeat = await recordExperimentObservation(
      db.asDb(),
      { experiment_id: experiment.experiment_id, arm: 'control', metric: 'useful_novelty_rate', value: 0.4, n: 10, note: 'cycle one' },
      TRUSTED,
    );
    expect(repeat).toMatchObject({ recorded: true, updated: false, unchanged: true });
    expect(JSON.stringify(db.collection(IMAGINATION_EXPERIMENTS_COLLECTION).docs)).toBe(snapshot);

    // New numbers on the same key: the row is UPDATED in place, not duplicated.
    const updated = await recordExperimentObservation(
      db.asDb(),
      { experiment_id: experiment.experiment_id, arm: 'control', metric: 'useful_novelty_rate', value: 0.5, n: 12, checkpoint: 'cycle-2' },
      TRUSTED,
    );
    expect(updated).toMatchObject({ recorded: true, updated: false, unchanged: false });
    const after = db.collection(IMAGINATION_EXPERIMENTS_COLLECTION).docs.filter((row) => row.kind === 'observation');
    expect(after).toHaveLength(2);
    const again = await recordExperimentObservation(
      db.asDb(),
      { experiment_id: experiment.experiment_id, arm: 'control', metric: 'useful_novelty_rate', value: 0.9, n: 12, checkpoint: 'cycle-1' },
      TRUSTED,
    );
    expect(again).toMatchObject({ recorded: true, updated: true, unchanged: false });
    const rewritten = db.collection(IMAGINATION_EXPERIMENTS_COLLECTION).docs.filter((row) => row.kind === 'observation');
    expect(rewritten).toHaveLength(2);
    expect(rewritten.find((row) => row.checkpoint === 'cycle-1').value).toBe(0.9);
    delete process.env.FOCUSED_IMAGINATION;
  });

  it('reaches improved / not_improved / insufficient_data with the n and the threshold used', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const { experiment } = await registerExperiment(db.asDb(), EXPERIMENT);
    const id = experiment.experiment_id;
    const observe = (arm: string, metric: string, value: number, n: number) =>
      recordExperimentObservation(db.asDb(), { experiment_id: id, arm, metric, value, n }, TRUSTED);

    // 1. improved — control 0.4, treatment 0.6 with n = 10 each → +50% > 30%.
    await observe('control', 'useful_novelty_rate', 0.4, 10);
    await observe('treatment', 'useful_novelty_rate', 0.6, 10);
    //     …and the same for a metric where LOWER is better: cost 100 → 60.
    await observe('control', 'cost_of_novelty', 100, 10);
    await observe('treatment', 'cost_of_novelty', 60, 10);

    const improved = await compareExperiment(db.asDb(), USER, id);
    expect(improved).toBeTruthy();
    const novelty = improved!.metrics.find((row) => row.metric === 'useful_novelty_rate')!;
    expect(novelty.verdict).toBe('improved');
    // The DIRECTION each metric is judged in is part of correctness: a faster
    // plateau response and a smaller false-novelty share are improvements.
    expect(EXPERIMENT_IMPROVEMENT_TARGETS.time_to_next_viable_direction.direction).toBe('lower');
    expect(EXPERIMENT_IMPROVEMENT_TARGETS.false_novelty.direction).toBe('lower');
    expect(EXPERIMENT_IMPROVEMENT_TARGETS.cost_of_novelty.direction).toBe('lower');
    expect(novelty.delta).toBe(0.2);
    expect(novelty.relative_gain).toBe(0.5);
    expect(novelty.direction).toBe('higher');
    expect(novelty.target).toEqual({ direction: 'higher', min_relative_gain: 0.3, min_samples: 3, source: 'named-target' });
    expect(novelty.n).toEqual({ baseline: 10, treatment: 10, minimum: 3 });
    expect(novelty.baseline.checkpoints).toEqual([{ checkpoint: 'cycle-1', value: 0.4, n: 10 }]);
    const cost = improved!.metrics.find((row) => row.metric === 'cost_of_novelty')!;
    expect(cost.verdict).toBe('improved');
    expect(cost.direction).toBe('lower');
    expect(cost.relative_gain).toBe(0.4);
    expect(improved!.verdict).toBe('improved');
    expect(improved!.counts).toEqual({ improved: 2, not_improved: 0, insufficient_data: 0 });
    expect(improved!.basis).toContain('observation');

    // 2. not_improved — the treatment is WORSE than the baseline.
    await observe('treatment', 'idea_survival_rate', 0.2, 10);
    await observe('control', 'idea_survival_rate', 0.5, 10);
    const worse = await compareExperiment(db.asDb(), USER, id);
    const survival = worse!.metrics.find((row) => row.metric === 'idea_survival_rate')!;
    expect(survival.verdict).toBe('not_improved');
    expect(survival.relative_gain).toBeCloseTo(-0.6, 6);
    expect(worse!.verdict).toBe('not_improved'); // one regression blocks "improved"

    // 3. insufficient_data — n below the (default) minimum, and a zero baseline.
    await observe('control', 'median_plateau_length', 5, 2);
    await observe('treatment', 'median_plateau_length', 9, 2);
    await observe('control', 'false_novelty_rate', 0, 10);
    await observe('treatment', 'false_novelty_rate', 0.1, 10);
    const thin = await compareExperiment(db.asDb(), USER, id);
    const plateau = thin!.metrics.find((row) => row.metric === 'median_plateau_length')!;
    expect(plateau.verdict).toBe('insufficient_data');
    expect(plateau.target.source).toBe('default-target');
    expect(plateau.n).toEqual({ baseline: 2, treatment: 2, minimum: 3 });
    expect(plateau.reason).toContain('below the minimum');
    const falseNovelty = thin!.metrics.find((row) => row.metric === 'false_novelty_rate')!;
    expect(falseNovelty.verdict).toBe('insufficient_data');
    expect(falseNovelty.reason).toContain('reads 0');

    // An unknown experiment is null, not a fabricated comparison.
    expect(await compareExperiment(db.asDb(), USER, 'impexp_absent')).toBeNull();
    expect(await compareExperiment(db.asDb(), OTHER, id)).toBeNull(); // another identity's experiment
    delete process.env.FOCUSED_IMAGINATION;
  });

  it("supports the brief's §7.4 shape: Control A/B pooled against Treatment C/D", async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const { experiment } = await registerExperiment(db.asDb(), {
      userId: USER,
      name: 'Four-arm comparison',
      hypothesis: 'The treatment arms beat the control arms.',
      checkpoints: ['cycle-1'],
      arms: [
        { label: 'A', config: { role: 'control' } },
        { label: 'B', config: { role: 'control' } },
        { label: 'C', config: { role: 'treatment' } },
        { label: 'D', config: { role: 'treatment' } },
      ],
    });
    const id = experiment.experiment_id;
    const observe = (arm: string, value: number, n: number) =>
      recordExperimentObservation(db.asDb(), { experiment_id: id, arm, metric: 'useful_novelty_rate', value, n }, TRUSTED);
    await observe('A', 0.2, 10);
    await observe('B', 0.4, 10); // pooled control mean = 0.3 over n = 20
    await observe('C', 0.6, 10);
    await observe('D', 0.8, 10); // pooled treatment mean = 0.7 over n = 20

    const comparison = await compareExperiment(db.asDb(), USER, id, {
      baselineArms: ['A', 'B'],
      treatmentArms: ['C', 'D'],
    });
    expect(comparison!.baseline_arms).toEqual(['A', 'B']);
    expect(comparison!.treatment_arms).toEqual(['C', 'D']);
    const row = comparison!.metrics[0];
    expect(row.baseline).toMatchObject({ arm: 'A+B', weighted_mean: 0.3, n: 20 });
    expect(row.treatment).toMatchObject({ arm: 'C+D', weighted_mean: 0.7, n: 20 });
    expect(row.relative_gain).toBeCloseTo(1.333333, 5);
    expect(row.verdict).toBe('improved');
    expect(row.n).toEqual({ baseline: 20, treatment: 20, minimum: 3 });
    expect(row.basis).toContain('A+B');

    // Without the pool the default is first-vs-last, and the answer is honest
    // about which two arms it compared.
    const single = await compareExperiment(db.asDb(), USER, id);
    expect(single!.baseline_arms).toEqual(['A']);
    expect(single!.treatment_arms).toEqual(['D']);
    delete process.env.FOCUSED_IMAGINATION;
  });

  it('a target override is named as such, and the named brief target is the default', () => {
    expect(EXPERIMENT_IMPROVEMENT_TARGETS.useful_novelty_rate).toEqual({ direction: 'higher', min_relative_gain: 0.3, min_samples: 3 });

    return (async () => {
      process.env.FOCUSED_IMAGINATION = '1';
      const { experiment } = await registerExperiment(db.asDb(), EXPERIMENT);
      const id = experiment.experiment_id;
      await recordExperimentObservation(db.asDb(), { experiment_id: id, arm: 'control', metric: 'archive_coverage_gain', value: 2, n: 3 }, TRUSTED);
      await recordExperimentObservation(db.asDb(), { experiment_id: id, arm: 'treatment', metric: 'archive_coverage_gain', value: 2.5, n: 3 }, TRUSTED);
      // The named target for this metric needs only +10%; the override demands +50%.
      const byDefault = await compareExperiment(db.asDb(), USER, id);
      expect(byDefault!.metrics[0].verdict).toBe('improved');
      expect(byDefault!.metrics[0].target.source).toBe('named-target');
      const overridden = await compareExperiment(db.asDb(), USER, id, { targets: { archive_coverage_gain: { min_relative_gain: 0.5 } } });
      expect(overridden!.metrics[0].verdict).toBe('not_improved');
      expect(overridden!.metrics[0].target).toMatchObject({ source: 'override', min_relative_gain: 0.5, direction: 'higher' });
      expect(overridden!.metrics[0].reason).toContain('0.5');
      delete process.env.FOCUSED_IMAGINATION;
    })();
  });

  it('an experiment belongs to its identity: another identity cannot see or write to it', async () => {
    const { experiment } = await registerExperiment(db.asDb(), { ...EXPERIMENT, userId: OTHER });
    expect(await getExperiment(db.asDb(), USER, experiment.experiment_id)).toBeNull();
    expect(await getExperiment(db.asDb(), OTHER, experiment.experiment_id)).toBeTruthy();

    process.env.FOCUSED_IMAGINATION = '1';
    const refused = await recordExperimentObservation(
      db.asDb(),
      { experiment_id: experiment.experiment_id, arm: 'control', metric: 'useful_novelty_rate', value: 1, n: 5 },
      TRUSTED, // even a TRUSTED caller writes only its OWN identity's experiments
    );
    expect(refused).toMatchObject({ recorded: false, code: 'experiment_not_found' });
    expect(db.collection(IMAGINATION_EXPERIMENTS_COLLECTION).docs.filter((row) => row.kind === 'observation')).toHaveLength(0);
    delete process.env.FOCUSED_IMAGINATION;
  });

  it('refuses an oversized note BY NAME at the service layer, and a note at the limit still records', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const { experiment } = await registerExperiment(db.asDb(), EXPERIMENT);
    const args = { experiment_id: experiment.experiment_id, arm: 'control', metric: 'useful_novelty_rate', value: 0.4, n: 10 };

    // The MCP surface capped this at 2000; the service accepted it (ITER-10 F2).
    const overLimit = await recordExperimentObservation(db.asDb(), { ...args, note: 'n'.repeat(2001) }, TRUSTED);
    expect(overLimit).toMatchObject({ recorded: false, code: 'note_too_long' });
    expect(overLimit.reason).toContain('2000');
    expect(overLimit.experiment_id).toBeNull();

    const huge = await recordExperimentObservation(db.asDb(), { ...args, note: 'n'.repeat(1_048_595) }, TRUSTED);
    expect(huge).toMatchObject({ recorded: false, code: 'note_too_long' });

    // Nothing was written by either refusal.
    expect(await listObservations(db.asDb(), USER, experiment.experiment_id)).toHaveLength(0);

    // A note AT the limit records, and is stored exactly as sent.
    const atLimit = 'n'.repeat(2000);
    const accepted = await recordExperimentObservation(db.asDb(), { ...args, note: atLimit }, TRUSTED);
    expect(accepted).toMatchObject({ recorded: true, updated: false, code: null });
    expect(accepted.observation?.note).toBe(atLimit);
    expect(await listObservations(db.asDb(), USER, experiment.experiment_id)).toHaveLength(1);
    delete process.env.FOCUSED_IMAGINATION;
  });

  it('shares ONE note limit between the MCP schema and the service, so the two cannot drift', async () => {
    const service = await import('../../src/services/processing/imagination-experiments.js');
    const tools = await import('../../src/services/processing/imagination-observability-tools.js');

    const limit = (service as unknown as Record<string, unknown>).EXPERIMENT_NOTE_MAX_LENGTH;
    expect(limit, 'the service must export the note limit the MCP schema caps with').toBe(2000);

    const def = tools.IMAGINATION_OBSERVABILITY_TOOL_DEFS.find((tool) => tool.name === 'record_experiment_observation');
    expect(def, 'the observation tool is not registered').toBeTruthy();
    const note = (def!.inputSchema as any).properties.note;
    // The MCP schema caps with the SAME constant — not a second literal.
    expect(note.maxLength).toBe(limit);
  });
});
