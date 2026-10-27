/**
 * ITER-11, WS-4 items 1-3 (DoD #8) — the baseline harness, end to end.
 *
 * This suite RUNS the harness (`node scripts/imagination-baseline.mjs`) and
 * then feeds what it wrote back through the REAL code:
 *
 *   - the four arms (A/B/C/D) are registered with their configs;
 *   - every number carries a basis, and the determinations are honest
 *     (`store_measured` vs `stub_determined` vs `insufficient_data` with a
 *     stated reason);
 *   - the store's rows are loaded into the in-memory store and the REAL
 *     `compareExperiment` is run over them — and its per-metric verdicts must
 *     equal the harness's own, which is what proves the harness's rule mirror
 *     and its derived ids agree with `imagination-experiments.ts`;
 *   - replaying one of the harness's observations through the REAL gated write
 *     finds it UNCHANGED (same `observation_key`, same numbers) — the key
 *     derivation is the codebase's, not a lookalike;
 *   - `--grade` records an operator's blind grades, and a hostile grade file is
 *     refused without touching the store;
 *   - `--target` overrides a named threshold;
 *   - `docs/IMAGINATION-BASELINE.md` quotes this run's numbers, and
 *     `docs/IMAGINATION-ROLLOUT.md`'s stage-2 gate references the recorded
 *     baseline by experiment id AND metric keys.
 *
 * Fails against the pre-iteration tree: `server/scripts/imagination-baseline.mjs`
 * did not exist, so every spawn failed, and there was no recorded baseline for
 * the rollout doc to reference.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeDb } from '../helpers/fake-mongo.js';
import {
  compareExperiment,
  getExperiment,
  recordExperimentObservation,
} from '../../src/services/processing/imagination-experiments.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const HARNESS = path.join(SERVER_ROOT, 'scripts/imagination-baseline.mjs');
const STORE = path.join(REPO_ROOT, 'docs/IMAGINATION-BASELINE.json');
const FIXTURE = path.join(SERVER_ROOT, 'tests/fixtures/imagination-baseline-checkpoint.json');
const BASELINE_DOC = path.join(REPO_ROOT, 'docs/IMAGINATION-BASELINE.md');
const ROLLOUT_DOC = path.join(REPO_ROOT, 'docs/IMAGINATION-ROLLOUT.md');

const USER = 'katra';
// The gated write is CALLER-OWNED: the row's user_id is the caller's own, so
// the replay must come from the identity the store is recorded for (the same
// `KATRA_USER_ID` the harness was run with).
const OPERATOR: CallerIdentity = { user_id: USER, trusted: true };

process.env.FOCUSED_IMAGINATION = '1';

interface Report {
  experiment_id: string;
  arms: Array<{ label: string; name: string; kind: string; config: Record<string, unknown>; rows: number; tokens: number }>;
  metrics: Array<{ arm: string; metrics: Array<Record<string, any>> }>;
  task_quality: Record<string, any>;
  comparisons: Array<Record<string, any>>;
  observations: number;
  store: string | null;
}

function runHarness(args: string[] = []): { report: Report; stdout: string } {
  const stdout = execFileSync('node', [HARNESS, '--json', '--no-write', ...args], {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    env: { ...process.env, KATRA_USER_ID: USER },
  });
  return { report: JSON.parse(stdout) as Report, stdout };
}

function loadStoreRows(): Array<Record<string, any>> {
  return JSON.parse(readFileSync(STORE, 'utf8')).rows as Array<Record<string, any>>;
}

function storeIntoFakeDb(rows: Array<Record<string, any>>): FakeDb {
  const db = new FakeDb();
  for (const row of rows) db.collection('imagination_experiments').docs.push(structuredClone(row));
  return db;
}

/** The metric keys the harness measured for one arm. */
function metricsOf(report: Report, arm: string): Record<string, Record<string, any>> {
  const entry = report.metrics.find((row) => row.arm === arm)!;
  return Object.fromEntries(entry.metrics.map((metric) => [metric.metric, metric]));
}

describe('the baseline harness — the four arms, every number with its basis', () => {
  it('runs on the frozen checkpoint and registers A/B/C/D with their configs', () => {
    const { report } = runHarness();
    expect(report.arms.map((arm) => arm.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(report.arms.map((arm) => arm.kind)).toEqual(['control', 'control', 'treatment', 'treatment']);
    expect(report.arms[0].name).toBe('control_dreamer_retrieval');
    expect(report.arms[1].name).toBe('control_mind_wander');
    expect(report.arms[2].name).toBe('focused_engine_balanced');
    expect(report.arms[3].name).toBe('engine_plus_heterogeneous_team');
    // ITER-11 refinement: ALL FOUR arms are captured in the fixture, and the two
    // comparators' candidates were admitted through the SHIPPED archive there
    // (the fixture generator is the only place that can import the services), so
    // the harness holds no rule of its own.
    const generation = report.arms.map((arm) => (arm.config as any).generation?.path ?? (arm as any).generation?.path);
    expect(report.arms.every((arm) => arm.rows > 0)).toBe(true);
    expect(generation[0]).toBe('fixture_capture');
    expect(generation[1]).toBe('fixture_capture');
    expect(generation[3]).toBe('real_services');
    // Every arm names the rule that decided its candidates, and it is ONE rule.
    for (const arm of report.arms) {
      expect((arm as any).admission_rule.path).toBe('shipped_archive');
      expect((arm as any).admission_rule.service).toBe('IdeaArchiveService.admitOrReplace');
      expect((arm as any).admission_rule.same_rule_as).toEqual(['A', 'B', 'C', 'D']);
    }
    // No arm DECIDES anything here: the harness re-implements no admission rule
    // (source-level, so a future edit cannot quietly put one back).
    expect(readFileSync(HARNESS, 'utf8')).not.toContain('isParaphrase');
    expect(readFileSync(HARNESS, 'utf8')).not.toContain('PARAPHRASE_THRESHOLD');
    expect(readFileSync(HARNESS, 'utf8')).not.toContain('CONTROL_BINS');
    // The frozen checkpoint really produced rows on both treatment arms.
    expect(report.arms[2].rows).toBeGreaterThan(0);
    expect(report.arms[3].rows).toBeGreaterThan(0);
  });

  it('marks every number with a basis and an honest determination', () => {
    const { report } = runHarness();
    const all = report.metrics.flatMap((entry) => entry.metrics);
    for (const metric of all) {
      expect(metric.basis, `${metric.metric} has no basis`).toBeTruthy();
      expect(['store_measured', 'stub_determined', 'insufficient_data']).toContain(metric.determination);
      if (metric.status === 'insufficient_data') expect(metric.reason).toBeTruthy();
      else expect(metric.value).not.toBeNull();
    }
    // The honest spread: at least three STORE-measured numbers, at least three
    // stub-determined ones, and the metrics that need a live model say so.
    const determinations = all.map((metric) => metric.determination);
    expect(determinations.filter((value) => value === 'store_measured').length).toBeGreaterThanOrEqual(3);
    expect(determinations.filter((value) => value === 'stub_determined').length).toBeGreaterThanOrEqual(3);
    expect(determinations.filter((value) => value === 'insufficient_data').length).toBeGreaterThanOrEqual(3);

    // Spot-check the three numbers a verifier can re-derive by hand.
    const armC = metricsOf(report, 'C');
    const generated = armC.arm_generated_candidates.value;
    const seen = armC.false_novelty.rejected_as_seen;
    expect(armC.false_novelty.value).toBe(Number((seen / generated).toFixed(6)));
    expect(armC.useful_novelty_rate.value).toBe(
      Number((armC.useful_novelty_rate.useful_outcomes / armC.useful_novelty_rate.recorded_outcomes).toFixed(6)),
    );
    expect(armC.useful_novelty_rate.determination).toBe('store_measured');
    // `cost_of_novelty` is NOT reported as free when the spend is 0.
    expect(armC.cost_of_novelty.status).toBe('insufficient_data');
    expect(armC.cost_of_novelty.reason).toContain('NOT a cost of zero');
    // …and the arms without outcomes say so rather than reporting a rate.
    expect(metricsOf(report, 'A').useful_novelty_rate.status).toBe('insufficient_data');
    expect(metricsOf(report, 'A').useful_novelty_rate.reason).toContain('no candidate outcome was ever recorded');
    // The control arms' numbers remain STUB-determined (the candidate text is
    // the comparator's scripted template), but the BASIS now names the rule that
    // produced the decisions — the shipped archive, the same one the treatment
    // arms ran — instead of this harness's own dedupe.
    expect(metricsOf(report, 'B').false_novelty.determination).toBe('stub_determined');
    expect(metricsOf(report, 'B').false_novelty.basis).toContain('SHIPPED archive');
    expect(metricsOf(report, 'B').false_novelty.basis).toContain('IdeaArchiveService.admitOrReplace');
    expect(metricsOf(report, 'B').false_novelty.basis).toContain('SAME rule every arm in this experiment ran through');
    expect(metricsOf(report, 'B').false_novelty.rejection_rule).toBe('shipped_archive');
    // …and the treatment arms say the same thing about their own rule, so the
    // two sides are described in one vocabulary.
    expect(metricsOf(report, 'C').false_novelty.basis).toContain('SHIPPED archive');
    expect(metricsOf(report, 'D').false_novelty.basis).toContain('SHIPPED archive');
    // Arm D carries three agents, so divergence is measurable there.
    expect(metricsOf(report, 'D').agent_divergence.value).not.toBeNull();
    expect(metricsOf(report, 'D').agent_divergence.determination).toBe('stub_determined');
    expect(metricsOf(report, 'C').agent_divergence.status).toBe('insufficient_data');
    // Every arm's counts RECONCILE (generated = admitted + rejected) and the
    // reconciliation is a number in the report, not an assumption.
    for (const label of ['A', 'B', 'C', 'D']) {
      const row = metricsOf(report, label).arm_count_reconciliation;
      expect(row.value, `${label} does not reconcile: ${row.basis}`).toBe(0);
      expect(row.mismatches).toBe(0);
    }
  });

  it('derives every per-arm number from what its basis claims — re-derived by hand', () => {
    // The defect this pins: `false_novelty` and `arm_generated_candidates` were
    // divided by / read from `rows.length`, but a TREATMENT arm's rows hold only
    // the seeds it ADMITTED — arm D's three rejected candidates live in the
    // fixture's `rejections`. The numbers below are re-derived here from the
    // FIXTURE (not from the harness), printed, and compared with the report.
    const { report } = runHarness();
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, any>;
    const arm = (label: string) => fixture.arms.find((row: any) => row.label === label);
    const c = arm('C');
    const d = arm('D');
    const rederived: Record<string, number> = {};
    // 1. arm C: two rejected rows with a seen-before reason over six generated.
    rederived['C.false_novelty'] = Number(
      (c.rows.filter((row: any) => row.state === 'rejected' && row.rejection_reason === 'duplicate_of').length / c.counts.generated).toFixed(6),
    );
    // 2. arm C: two useful verdicts out of three recorded outcomes.
    rederived['C.useful_novelty_rate'] = Number(
      (c.outcomes.useful_information / c.outcomes.recorded).toFixed(6),
    );
    // 3. arm D: SIX admitted rows but NINE generated candidates (3 recorded
    //    rejections have no row) — dividing by rows.length is the defect.
    expect(d.rows.length).toBe(6);
    expect(d.rejections.length).toBe(3);
    rederived['D.generated'] = d.rows.length + d.rejections.length;
    rederived['D.false_novelty'] = Number((d.rejections.length / rederived['D.generated']).toFixed(6));
    // 4. the pooled baseline: (3/4 × 4 + 7/8 × 8) ÷ 12 = 10/12, re-derived from
    //    the FIXTURE (ITER-11 refinement): the comparators are captured there
    //    now, admitted through the shipped archive, so their decisions are rows
    //    a verifier can read rather than numbers this harness produced.
    const a = arm('A');
    const b = arm('B');
    const seenRows = (fixtureArm: Record<string, any>): number =>
      fixtureArm.rows.filter(
        (row: any) => row.state === 'rejected' && ['duplicate_of', 'paraphrase_of', 'excluded_region'].includes(row.rejection_reason),
      ).length;
    expect(a.rows).toHaveLength(4);
    expect(b.rows).toHaveLength(8);
    rederived['A.false_novelty'] = Number((seenRows(a) / a.counts.generated).toFixed(6));
    rederived['B.false_novelty'] = Number((seenRows(b) / b.counts.generated).toFixed(6));
    expect(metricsOf(report, 'A').false_novelty.value).toBe(rederived['A.false_novelty']);
    expect(metricsOf(report, 'B').false_novelty.value).toBe(rederived['B.false_novelty']);
    const seenA = metricsOf(report, 'A').false_novelty.rejected_as_seen;
    const seenB = metricsOf(report, 'B').false_novelty.rejected_as_seen;
    const genA = metricsOf(report, 'A').arm_generated_candidates.value;
    const genB = metricsOf(report, 'B').arm_generated_candidates.value;
    // The archive's own decisions, on this fixture: the retrieval comparator
    // restates ONE template four times and the wander emits both directions of
    // every edge, so almost every candidate is a restatement of one already
    // stored. (The values are re-derived below, not asserted here.)
    expect([seenA, genA, seenB, genB]).toEqual([seenRows(a), a.counts.generated, seenRows(b), b.counts.generated]);
    const pooledBaseline = Number(((seenA + seenB) / (genA + genB)).toFixed(6));
    rederived['pooled_baseline.false_novelty'] = pooledBaseline;
    // 5. the pooled treatment, with the CORRECTED denominators: (2/6 × 6 + 3/9 × 9) ÷ 15 = 5/15.
    const pooledTreatment = Number(
      (((rederived['C.false_novelty'] * c.counts.generated) + (rederived['D.false_novelty'] * rederived['D.generated'])) /
        (c.counts.generated + rederived['D.generated'])).toFixed(6),
    );
    rederived['pooled_treatment.false_novelty'] = pooledTreatment;

    for (const [key, value] of Object.entries(rederived)) console.log(`  hand-derived ${key} = ${value}`);
    // The basis claim behind arm D's number, asserted directly: its generated
    // count is its admitted rows PLUS the rejections it recorded without a row.
    expect(d.rows.filter((row: any) => row.state === 'admitted')).toHaveLength(d.counts.admitted);
    expect(d.counts.generated).toBe(d.rows.length + d.rejections.length);
    expect(rederived['D.generated']).toBe(d.counts.generated);
    // …and every arm's counts reconcile, comparators included.
    for (const fixtureArm of [a, b, c, d]) {
      expect(fixtureArm.counts.generated).toBe(fixtureArm.counts.admitted + fixtureArm.counts.rejected);
    }

    expect(metricsOf(report, 'C').false_novelty.value).toBe(rederived['C.false_novelty']);
    expect(metricsOf(report, 'C').useful_novelty_rate.value).toBe(rederived['C.useful_novelty_rate']);
    expect(metricsOf(report, 'D').arm_generated_candidates.value).toBe(rederived['D.generated']);
    expect(metricsOf(report, 'D').arm_generated_candidates.basis).toContain('counts.generated');
    expect(metricsOf(report, 'D').false_novelty.value).toBe(rederived['D.false_novelty']);
    const byMetric = Object.fromEntries(report.comparisons.map((row) => [row.metric, row]));
    expect(byMetric.false_novelty.baseline.value).toBe(rederived['pooled_baseline.false_novelty']);
    expect(byMetric.false_novelty.baseline.n).toBe(12);
    expect(byMetric.false_novelty.treatment.value).toBe(rederived['pooled_treatment.false_novelty']);
    expect(byMetric.false_novelty.treatment.n).toBe(15);
    // …and the relative gain is the pooled reading the brief's target is applied to.
    expect(byMetric.false_novelty.relative_gain).toBe(
      Number(((pooledBaseline - pooledTreatment) / Math.abs(pooledBaseline)).toFixed(6)),
    );
    // With ONE rule on both sides the gain is 0.6 (ten of the comparators'
    // twelve candidates are restatements against five of the treatment's
    // fifteen), which clears the brief's 0.3 target. That is a statement about
    // the archive's rule applied to SCRIPTED text on both sides — the magnitude
    // stays stub_determined and both arms say so.
    expect(byMetric.false_novelty.relative_gain).toBeCloseTo(0.6, 5);
    expect(byMetric.false_novelty.verdict).toBe('improved');
    expect(byMetric.false_novelty.comparability).toBe('like_for_like');
  });

  it('reports EQUAL as equal: no delta for two exactly-equal sides, and the reason says so', () => {
    // The rounding defect this pins: equal pooled means produced `delta: 0`
    // with a 0 relative gain and a `not_improved` verdict, which reads as
    // "measured, no improvement" for two readings nothing distinguishes.
    const { report } = runHarness();
    const row = report.comparisons.find((entry) => entry.metric === 'task_quality_regression')!;
    expect(row.baseline.value).toBe(row.treatment.value); // exactly equal
    expect(row.verdict).toBe('equal');
    expect(row.delta).toBeNull();
    expect(row.relative_gain).toBeNull();
    expect(row.reason).toContain('EXACTLY equal');
    // The task-quality metric is not the only one that can be equal: the rule is
    // the shared one, so `compareExperiment` (the REAL code) says `equal` too —
    // asserted against the live store in the comparison test below.
  });

  it('evaluates every success criterion with its OWN predicate, evidence attached', () => {
    // The defect this pins: both of the frozen mission's criteria were mapped to
    // ONE predicate (`portfolio_non_empty`), so every arm passed the check by
    // producing a row and "no material task-quality regression" was true by
    // construction. Each criterion now names a distinct predicate over evidence
    // the arm must carry.
    const { report } = runHarness();
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, any>;
    const predicates = fixture.task_checker.criteria.map((row: any) => row.predicate);
    expect(predicates).toEqual(['cycles_per_plateau_within_limit', 'no_private_text_in_shared_artefacts']);
    expect(new Set(predicates).size).toBe(2);
    expect(predicates).not.toContain('portfolio_non_empty');

    const perArm = report.task_quality.per_arm;
    expect(Object.keys(perArm).sort()).toEqual(['A', 'B', 'C', 'D']);
    for (const label of ['A', 'B', 'C', 'D']) {
      expect(perArm[label].of).toBe(2); // the frozen mission declares two criteria
      expect(perArm[label].evaluated).toBe(2); // …and both were evaluated here
      expect(perArm[label].evidence).toHaveLength(2);
      for (const item of perArm[label].evidence) {
        expect(item.basis, `${label}/${item.criterion} has no basis`).toBeTruthy();
        expect(item.evaluated).toBe(true);
        expect(typeof item.met).toBe('boolean');
        expect(typeof item.vacuous).toBe('boolean');
      }
    }

    // c1 — the run count for the plateau window, per arm, with the run ids.
    const c1 = (label: string) => perArm[label].evidence.find((row: any) => row.criterion === 'c1');
    expect(c1('C').evidence.cycles_in_window).toBe(1);
    expect(c1('C').evidence.run_ids).toEqual([fixture.checkpoint.cycle_id]);
    expect(c1('C').evidence.limit).toBe(1);
    expect(c1('D').evidence.cycles_in_window).toBe(1);
    expect(c1('D').evidence.run_ids).toEqual([fixture.checkpoint.pass_id]);
    // …and the comparators' zero is DECLARED (and marked vacuous) rather than
    // measured: the pre-engine path has no cycle service to count.
    expect(c1('A').evidence.cycles_in_window).toBe(0);
    expect(c1('A').vacuous).toBe(true);
    expect(c1('A').basis).toContain('VACUOUSLY');

    // c2 — the taint scan, with the audit's OWN flag count beside the
    // attributed crossing count (the fixture's promoted baton reproduces the
    // candidates' own allow-listed text; the rejected duplicates carry the same
    // sentence, so the audit flags it).
    const c2 = (label: string) => perArm[label].evidence.find((row: any) => row.criterion === 'c2');
    expect(c2('C').evidence.shared_artefacts_scanned).toBeGreaterThan(0);
    expect(c2('C').evidence.flagged).toBe(1);
    expect(c2('C').evidence.private_text_crossed).toBe(0);
    expect(c2('C').evidence.attributed).toBe(true);
    expect(c2('C').basis).toContain('allow-listed candidate material');
    expect(c2('C').basis).toContain('candidate_portfolio[0].hypothesis=allowed-field');
    expect(c2('D').evidence.shared_artefacts_scanned).toBe(0);
    expect(c2('D').vacuous).toBe(true);
    // The comparators record NO attribution, so their reading is the
    // conservative one (the raw flag count) — and the report says so.
    expect(c2('A').evidence.attributed).toBe(false);
    expect(c2('A').basis).toContain('conservative reading');

    // The verdict itself, with its counted criteria named.
    expect(report.task_quality.counted_criteria).toEqual(['c1', 'c2']);
    expect(report.task_quality.excluded_criteria).toEqual([]);
    expect(report.task_quality.missing_evaluations).toEqual([]);
    expect(report.task_quality.regression).toBe(false);
    expect(report.task_quality.verdict).toBe('no_regression');
    expect(report.task_quality.basis).toContain('cycles_per_plateau_within_limit');
    expect(report.task_quality.basis).toContain('no_private_text_in_shared_artefacts');
  });

  it('CAN fail: a plateau that ran twice, or a shared artefact that crossed, is a REGRESSION', () => {
    // The proof that the check is no longer decorative: with the same fixture,
    // changing only the evidence the treatment side declares flips the verdict.
    const dir = mkdtempSync(path.join(tmpdir(), 'iter11-task-quality-'));
    try {
      const write = (name: string, mutate: (fixture: Record<string, any>) => void): string => {
        const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, any>;
        mutate(fixture);
        const file = path.join(dir, name);
        writeFileSync(file, JSON.stringify(fixture));
        return file;
      };
      const run = (file: string): Report => {
        const stdout = execFileSync('node', [HARNESS, '--json', '--no-write', '--fixture', file], {
          cwd: SERVER_ROOT,
          encoding: 'utf8',
          env: { ...process.env, KATRA_USER_ID: USER },
        });
        return JSON.parse(stdout) as Report;
      };
      const c = (fixture: Record<string, any>) => fixture.arms.find((row: any) => row.label === 'C');

      // (a) TWO cycles for one plateau → c1 unmet on the treatment side.
      const twice = run(
        write('twice.json', (fixture) => {
          c(fixture).plateau.cycles_in_window = 2;
          c(fixture).plateau.run_ids.push('imagination_cycle_a_second_run');
        }),
      );
      expect(twice.task_quality.per_arm.C.evidence.find((row: any) => row.criterion === 'c1').met).toBe(false);
      expect(twice.task_quality.treatment_criteria_met).toBe(1);
      expect(twice.task_quality.baseline_criteria_met).toBe(2);
      expect(twice.task_quality.regression).toBe(true);
      expect(twice.task_quality.verdict).toBe('regression');

      // (b) private text that CROSSED (a flag the attribution does not excuse)
      // → c2 unmet on the treatment side.
      const leaked = run(
        write('leaked.json', (fixture) => {
          c(fixture).taint.private_text_crossed = 1;
          c(fixture).taint.flags = [
            {
              artefact: 'creative_batons',
              id: 'cbaton_leaky',
              field: 'attention_targets[0].cue',
              reason: 'marker_reproduced',
              allowed_field_reproduction: false,
            },
          ];
        }),
      );
      expect(leaked.task_quality.per_arm.C.evidence.find((row: any) => row.criterion === 'c2').met).toBe(false);
      expect(leaked.task_quality.regression).toBe(true);
      expect(leaked.task_quality.verdict).toBe('regression');

      // (c) an UNATTRIBUTED flag is read conservatively: the raw count is
      //     enough to mark the criterion unmet when nothing excuses it.
      const unattributed = run(
        write('unattributed.json', (fixture) => {
          c(fixture).taint.private_text_crossed = undefined;
          delete c(fixture).taint.private_text_crossed;
        }),
      );
      expect(unattributed.task_quality.per_arm.C.evidence.find((row: any) => row.criterion === 'c2').met).toBe(false);
      expect(unattributed.task_quality.regression).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES a verdict it cannot form: a missing evaluation, or an unimplemented predicate', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'iter11-task-quality-refusal-'));
    try {
      const write = (name: string, mutate: (fixture: Record<string, any>) => void): string => {
        const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, any>;
        mutate(fixture);
        const file = path.join(dir, name);
        writeFileSync(file, JSON.stringify(fixture));
        return file;
      };
      const run = (file: string): Report => {
        const stdout = execFileSync('node', [HARNESS, '--json', '--no-write', '--fixture', file], {
          cwd: SERVER_ROOT,
          encoding: 'utf8',
          env: { ...process.env, KATRA_USER_ID: USER },
        });
        return JSON.parse(stdout) as Report;
      };

      // (a) one arm carries no plateau evidence at all → the criterion is not
      //     evaluated for that arm, so NO verdict is reported.
      const missingPlateau = run(
        write('missing-plateau.json', (fixture) => {
          delete fixture.arms.find((row: any) => row.label === 'C').plateau;
        }),
      );
      expect(missingPlateau.task_quality.regression).toBeNull();
      expect(missingPlateau.task_quality.verdict).toBe('insufficient_data');
      expect(missingPlateau.task_quality.reason).toContain('could not be evaluated on every arm');
      expect(missingPlateau.task_quality.missing_evaluations).toEqual([{ criterion: 'c1', arms: ['C'] }]);
      expect(missingPlateau.task_quality.per_arm.C.evidence.find((row: any) => row.criterion === 'c1').evaluated).toBe(false);
      // …and the arm's `met` count is over the criteria it COULD answer, with
      // the count of what it answered recorded beside it.
      expect(missingPlateau.task_quality.per_arm.C.evaluated).toBe(1);
      expect(missingPlateau.task_quality.per_arm.C.of).toBe(2);

      // (b) a predicate this harness does not implement (what "needs a live
      //     model" looks like) → the criterion is EXCLUDED, and if nothing else
      //     is evaluable the whole check reports insufficient_data.
      const unmapped = run(
        write('unmapped.json', (fixture) => {
          fixture.task_checker.criteria = [
            {
              id: 'c3',
              description: 'judged novelty of the idea text',
              predicate: 'judged_novelty_of_idea_text',
              basis: 'needs a live model, or an operator’s blind grade',
            },
          ];
        }),
      );
      expect(unmapped.task_quality.counted_criteria).toEqual([]);
      expect(unmapped.task_quality.excluded_criteria).toHaveLength(1);
      expect(unmapped.task_quality.excluded_criteria[0]).toMatchObject({
        criterion: 'c3',
        predicate: 'judged_novelty_of_idea_text',
      });
      expect(unmapped.task_quality.excluded_criteria[0].reason).toContain('no arm could evaluate it');
      expect(unmapped.task_quality.regression).toBeNull();
      expect(unmapped.task_quality.verdict).toBe('insufficient_data');
      // A criterion nobody evaluated is NOT counted as met anywhere.
      for (const label of ['A', 'B', 'C', 'D']) {
        expect(unmapped.task_quality.per_arm[label].criteria).toEqual([]);
        expect(unmapped.task_quality.per_arm[label].of).toBe(0);
      }

      // (c) a refused verdict is NOT recorded as a number in the store.
      const storePath = path.join(dir, 'refused-store.json');
      execFileSync('node', [HARNESS, '--store', storePath, '--fixture', write('unmapped-2.json', (fixture) => {
        fixture.task_checker.criteria = [
          { id: 'c3', description: 'judged novelty of the idea text', predicate: 'judged_novelty_of_idea_text' },
        ];
      })], { cwd: SERVER_ROOT, encoding: 'utf8', env: { ...process.env, KATRA_USER_ID: USER } });
      const rows = JSON.parse(readFileSync(storePath, 'utf8')).rows as Array<Record<string, any>>;
      expect(rows.filter((row) => row.metric === 'task_quality_regression')).toEqual([]);
      expect(rows.filter((row) => row.metric === 'useful_novelty_rate').length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the comparison applies the brief’s named target and reports a verdict per metric', () => {
    const { report } = runHarness();
    const byMetric = Object.fromEntries(report.comparisons.map((row) => [row.metric, row]));
    expect(Object.keys(byMetric).sort()).toEqual([
      'false_novelty',
      'task_quality_regression',
      'time_to_next_viable_direction',
      'useful_novelty_rate',
    ]);
    // The named target is the brief's "≥30% better useful novelty", and its
    // direction/source are stated.
    expect(byMetric.useful_novelty_rate.target).toMatchObject({
      direction: 'higher',
      min_relative_gain: 0.3,
      source: 'named-target',
    });
    expect(byMetric.false_novelty.target).toMatchObject({ direction: 'lower', min_relative_gain: 0.3 });
    for (const row of report.comparisons) {
      expect(['improved', 'not_improved', 'equal', 'insufficient_data', 'not_comparable']).toContain(row.verdict);
      expect(row.reason).toBeTruthy();
      expect(row.basis).toBeTruthy();
      // Every comparison says what it is: the arms on each side, the rule that
      // decided both, and whether they are comparable at all.
      expect(['like_for_like', 'not_comparable']).toContain(row.comparability);
      expect(row.comparability_basis).toBeTruthy();
    }
    // The baseline side has no recorded outcomes, so useful novelty is
    // insufficient_data rather than an invented number.
    expect(byMetric.useful_novelty_rate.verdict).toBe('insufficient_data');
    expect(byMetric.useful_novelty_rate.reason).toContain('no measured value');
    // `false_novelty` is a REAL reading on both sides, and — since the ITER-11
    // refinement — it is decided by ONE rule on both sides: the comparators'
    // candidates are admitted through the shipped archive in the fixture, so the
    // baseline is 10/12 (the retrieval template restated four times and the
    // wander's both-direction restatements), the treatment 5/15, and the 0.6
    // relative gain clears the 0.3 target. The LABEL stays honest: the candidate
    // text is scripted on both sides, so the magnitude is stub_determined.
    expect(byMetric.false_novelty.verdict).toBe('improved');
    expect(byMetric.false_novelty.baseline.value).toBe(Number((10 / 12).toFixed(6)));
    expect(byMetric.false_novelty.treatment.value).toBe(Number((5 / 15).toFixed(6)));
    expect(byMetric.false_novelty.relative_gain).toBeCloseTo(0.6, 5);
    expect(byMetric.false_novelty.comparability).toBe('like_for_like');
    // The task-quality metric is EXACTLY equal on both sides, so it states
    // equality rather than reporting a 0 delta as "not improved".
    expect(byMetric.task_quality_regression.verdict).toBe('equal');
    expect(byMetric.task_quality_regression.delta).toBeNull();
    // N3 (the reviewer's residual): arm D's "0 ms" was a SELF-STAMPED window —
    // its trigger and its first admitted candidate carry the same instant — and
    // reporting it as a measurement invited the wrong reading. The metric is now
    // refused BY NAME on that arm while arm C's real (non-zero) window keeps its
    // reading, and the comparison carries the metric so the refusal is visible
    // where the rollout gate reads.
    const armCTiming = metricsOf(report, 'C').time_to_next_viable_direction;
    expect(armCTiming.status).toBe('ok');
    expect(armCTiming.value).toBeGreaterThan(0);
    const armDTiming = metricsOf(report, 'D').time_to_next_viable_direction;
    expect(armDTiming.status).toBe('insufficient_data');
    expect(armDTiming.reason).toContain('SAME instant');
    expect(armDTiming.reason).toContain('self-stamped');
    expect(byMetric.time_to_next_viable_direction.verdict).toBe('insufficient_data');
    expect(byMetric.time_to_next_viable_direction.reason).toContain('no measured value');

    // An override is honoured and reported as such.
    const overridden = runHarness(['--target', 'false_novelty=0.05']).report;
    const target = overridden.comparisons.find((row) => row.metric === 'false_novelty')!.target;
    expect(target).toMatchObject({ source: 'override', min_relative_gain: 0.05 });
  });

  it('REFUSES a cross-arm verdict when the sides did not run one rule (not_comparable)', () => {
    // The reviewer's finding in test form: an arm whose candidates were decided
    // by something other than the shipped archive makes the cross-arm comparison
    // incomparable — and then NO delta and NO relative gain are formed, whatever
    // the two readings happen to be. The per-arm numbers are what remains.
    const dir = mkdtempSync(path.join(tmpdir(), 'iter11-comparability-'));
    try {
      const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, any>;
      const baselineArm = fixture.arms.find((row: any) => row.label === 'A');
      baselineArm.admission_rule = {
        path: 'harness_reimplementation',
        service: null,
        decided_by: 'a copy of the rule inside whatever computed this arm',
        same_rule_as: ['A', 'B'],
        text_is_scripted: true,
        text_basis: 'the comparator template',
      };
      const file = path.join(dir, 'reimplemented.json');
      writeFileSync(file, JSON.stringify(fixture));
      const stdout = execFileSync('node', [HARNESS, '--json', '--no-write', '--fixture', file], {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        env: { ...process.env, KATRA_USER_ID: USER },
      });
      const report = JSON.parse(stdout) as Report;
      const row = report.comparisons.find((entry) => entry.metric === 'false_novelty')!;
      expect(row.verdict).toBe('not_comparable');
      expect(row.comparability).toBe('not_comparable');
      expect(row.comparability_basis).toContain('did not have its candidates decided by the shipped archive');
      // No cross-arm number is formed…
      expect(row.delta).toBeNull();
      expect(row.relative_gain).toBeNull();
      // …while the two sides' own readings stay visible.
      expect(row.baseline.value).toBe(Number((10 / 12).toFixed(6)));
      expect(row.treatment.value).toBe(Number((5 / 15).toFixed(6)));
      // An arm that declares NO rule at all is refused the same way.
      delete baselineArm.admission_rule;
      const bare = path.join(dir, 'bare.json');
      writeFileSync(bare, JSON.stringify(fixture));
      const bareReport = JSON.parse(
        execFileSync('node', [HARNESS, '--json', '--no-write', '--fixture', bare], {
          cwd: SERVER_ROOT,
          encoding: 'utf8',
          env: { ...process.env, KATRA_USER_ID: USER },
        }),
      ) as Report;
      const bareRow = bareReport.comparisons.find((entry) => entry.metric === 'false_novelty')!;
      expect(bareRow.verdict).toBe('not_comparable');
      expect(bareRow.comparability_basis).toContain('undeclared');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the comparison block in the artefact the rollout gate reads', () => {
    const { report } = runHarness();
    const store = JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, any>;
    expect(store.comparison, 'the artefact carries no comparison block').toBeTruthy();
    expect(store.comparison.baseline_arms).toEqual(['A', 'B']);
    expect(store.comparison.treatment_arms).toEqual(['C', 'D']);
    expect(store.comparison.what_is_compared).toContain('pre-engine comparators');
    expect(Object.keys(store.comparison.admission_rule_per_arm).sort()).toEqual(['A', 'B', 'C', 'D']);
    for (const label of ['A', 'B', 'C', 'D']) {
      expect(store.comparison.admission_rule_per_arm[label].path).toBe('shipped_archive');
    }
    // The verdict field, metric by metric — the same object the report prints.
    // The brief names useful novelty AND time-to-next-viable-direction, so the
    // coverage residual (a comparison over three metrics while the brief names
    // four) is pinned here: the timing metric is present even when it is refused.
    expect(store.comparison.metrics.map((row: any) => row.metric)).toEqual([
      'useful_novelty_rate',
      'false_novelty',
      'time_to_next_viable_direction',
      'task_quality_regression',
    ]);
    for (const row of store.comparison.metrics) {
      const printed = report.comparisons.find((entry) => entry.metric === row.metric)!;
      expect(row.verdict, `${row.metric} verdict`).toBe(printed.verdict);
      expect(row.comparability).toBe(printed.comparability);
      expect(row.comparability_basis).toBeTruthy();
      expect(row.relative_gain).toBe(printed.relative_gain);
    }
    const falseNovelty = store.comparison.metrics.find((row: any) => row.metric === 'false_novelty');
    expect(falseNovelty.verdict).toBe('improved');
    expect(falseNovelty.comparability).toBe('like_for_like');
    expect(falseNovelty.relative_gain).toBeCloseTo(0.6, 5);
  });

  it('the store is in the collection’s own shape, and the REAL compareExperiment agrees with the harness', async () => {
    const { report } = runHarness();
    const rows = loadStoreRows();
    const experimentRow = rows.find((row) => row.kind === 'experiment')!;
    expect(experimentRow.experiment_id).toBe(report.experiment_id);
    expect(experimentRow.arms.map((arm: any) => arm.label)).toEqual(['A', 'B', 'C', 'D']);

    const db = storeIntoFakeDb(rows);
    const stored = await getExperiment(db.asDb(), USER, report.experiment_id);
    expect(stored).toBeTruthy();
    expect(stored!.arms).toHaveLength(4);

    const comparison = await compareExperiment(db.asDb(), USER, report.experiment_id, {
      baselineArms: ['A', 'B'],
      treatmentArms: ['C', 'D'],
    });
    expect(comparison).toBeTruthy();
    // The REAL code's verdicts, metric by metric, equal the harness's own.
    for (const row of report.comparisons) {
      const measured = comparison!.metrics.find((metric) => metric.metric === row.metric);
      expect(measured, `${row.metric} is missing from the real comparison`).toBeTruthy();
      expect(measured!.verdict).toBe(row.verdict);
      expect(measured!.direction).toBe(row.target.direction);
      expect(measured!.target.min_relative_gain).toBe(row.target.min_relative_gain);
      if (row.baseline) expect(measured!.baseline.weighted_mean).toBe(row.baseline.value);
      if (row.treatment) expect(measured!.treatment.weighted_mean).toBe(row.treatment.value);
      // The EQUALITY rule agrees too, not just the verdict word: the same delta
      // (null when the sides are equal at the reported precision) and the same
      // relative gain, from the two independent implementations.
      expect(measured!.delta, `${row.metric} delta`).toBe(row.delta);
      expect(measured!.relative_gain, `${row.metric} relative gain`).toBe(row.relative_gain);
    }
    const equalRow = report.comparisons.find((row) => row.verdict === 'equal');
    expect(equalRow, 'no metric read equal — the mirror check would not exercise the rule').toBeTruthy();
    expect(equalRow!.delta).toBeNull();
    // The comparison's own honesty block: no shared row, no reflection text.
    expect(comparison!.privacy.shared_rows).toBe(0);
    expect(comparison!.privacy.raw_reflections_included).toBe(false);

    // Replaying an observation through the GATED write finds the harness's row
    // unchanged: same derived observation_key, same numbers.
    const observation = rows.find((row) => row.kind === 'observation' && row.n > 0)!;
    const replay = await recordExperimentObservation(
      db.asDb(),
      {
        experiment_id: report.experiment_id,
        arm: observation.arm,
        metric: observation.metric,
        value: observation.value,
        n: observation.n,
        note: observation.note,
      },
      OPERATOR,
    );
    expect(replay.recorded, `replay refused with ${replay.code}: ${replay.reason}`).toBe(true);
    expect(replay.unchanged, `replay was not unchanged: ${replay.reason}`).toBe(true);
    expect(replay.observation!.observation_key).toBe(observation.observation_key);
    // Exactly one row per key: the replay did not add a second one.
    const matching = db
      .collection('imagination_experiments')
      .docs.filter((row: any) => row.observation_key === observation.observation_key);
    expect(matching).toHaveLength(1);
  });

  it('records an operator’s blind grades with --grade, and refuses a hostile grade file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'iter11-grades-'));
    try {
      const gradePath = path.join(dir, 'grades.json');
      writeFileSync(
        gradePath,
        JSON.stringify({
          grades: [
            { arm: 'C', novelty: 0.8, coherence: 0.7, testability: 0.6, information_gain: 0.5, n: 3, note: 'blind pass 1' },
            { arm: 'D', novelty: 0.6, coherence: 0.5, testability: 0.7, information_gain: 0.4, n: 3 },
          ],
        }),
      );
      const stdout = execFileSync('node', [HARNESS, '--json', '--no-write', '--grade', gradePath], {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        env: { ...process.env, KATRA_USER_ID: USER },
      });
      const report = JSON.parse(stdout) as Report;
      expect(report.blind_grades.supplied).toBe(8); // 2 arms × 4 fields
      expect(report.blind_grades.error).toBeNull();

      // The graded rows reach the store: run WITH the default store target in a
      // temporary directory to observe them without touching the committed file.
      const storePath = path.join(dir, 'store.json');
      execFileSync('node', [HARNESS, '--store', storePath, '--grade', gradePath], {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        env: { ...process.env, KATRA_USER_ID: USER },
      });
      const stored = JSON.parse(readFileSync(storePath, 'utf8')).rows as Array<Record<string, any>>;
      const blind = stored.filter((row) => String(row.metric).startsWith('blind_'));
      expect(blind.filter((row) => row.arm === 'C' && row.n === 3)).toHaveLength(4);
      expect(blind.filter((row) => row.arm === 'C').every((row) => row.note === 'blind pass 1' || row.note.includes('blind'))).toBe(true);
      // The arms that were NOT graded keep their n = 0 placeholders.
      expect(blind.filter((row) => row.arm === 'A').every((row) => row.n === 0)).toBe(true);
      expect(blind.filter((row) => row.arm === 'A')[0].note).toContain('PLACEHOLDER');

      // A hostile grade file is refused and NOTHING is written from it.
      const hostile = path.join(dir, 'hostile.json');
      writeFileSync(hostile, JSON.stringify({ grades: [{ arm: 'Z', novelty: 5 }] }));
      const hostileOut = execFileSync('node', [HARNESS, '--json', '--no-write', '--grade', hostile], {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        env: { ...process.env, KATRA_USER_ID: USER },
      });
      const hostileReport = JSON.parse(hostileOut) as Report;
      expect(hostileReport.blind_grades.supplied).toBe(0);
      expect(hostileReport.blind_grades.error).toContain("unknown arm 'Z'");

      const badNumber = path.join(dir, 'bad.json');
      writeFileSync(badNumber, JSON.stringify({ grades: [{ arm: 'C', novelty: 9 }] }));
      const badOut = execFileSync('node', [HARNESS, '--json', '--no-write', '--grade', badNumber], {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        env: { ...process.env, KATRA_USER_ID: USER },
      });
      expect((JSON.parse(badOut) as Report).blind_grades.error).toContain('must be a number in 0..1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--no-write writes nothing, --help documents the surface, and a bad option exits 2', () => {
    const before = readFileSync(STORE, 'utf8');
    runHarness(); // --no-write is baked into the helper
    expect(readFileSync(STORE, 'utf8')).toBe(before);

    const help = execFileSync('node', [HARNESS, '--help'], { cwd: SERVER_ROOT, encoding: 'utf8' });
    for (const flag of ['--fixture', '--store', '--grade', '--target', '--json', '--no-write']) {
      expect(help).toContain(flag);
    }
    expect(help).toContain('store_measured');
    expect(help).toContain('stub_determined');
    expect(help).toContain('insufficient_data');

    let failed = false;
    try {
      execFileSync('node', [HARNESS, '--nope'], { cwd: SERVER_ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failed = true;
      expect(String((error as any).stderr)).toContain("unknown option '--nope'");
    }
    expect(failed).toBe(true);
  });

  it('the committed store is exactly what the harness produces for the committed fixture', () => {
    const { report } = runHarness();
    const rows = loadStoreRows();
    expect(rows.length).toBe(report.observations + 1);
    expect(rows[0].kind).toBe('experiment');
    expect(readFileSync(STORE, 'utf8')).toContain(report.experiment_id);
    // Every observation row is private by construction (no shared_id) and
    // private-scoped in the comparison.
    expect(rows.filter((row) => row.kind === 'observation').every((row) => row.shared_id === undefined)).toBe(true);
  });

  it('docs/IMAGINATION-BASELINE.md quotes this run, and the rollout gate references it by experiment + metric keys', () => {
    const { report } = runHarness();
    expect(existsSync(BASELINE_DOC)).toBe(true);
    const doc = readFileSync(BASELINE_DOC, 'utf8');
    const store = JSON.parse(readFileSync(STORE, 'utf8'));
    const experimentId: string = report.experiment_id;
    expect(store.experiment_id).toBe(experimentId);

    // The report doc names the experiment, the checkpoint, the arms and the
    // per-metric numbers — including the ones that are insufficient_data.
    expect(doc).toContain(experimentId);
    expect(doc).toContain('frozen_checkpoint_alpha');
    for (const label of ['A', 'B', 'C', 'D']) expect(doc).toContain(`\`${label}\``);
    expect(doc).toContain('useful_novelty_rate');
    expect(doc).toContain('false_novelty');
    expect(doc).toContain('store_measured');
    expect(doc).toContain('stub_determined');
    expect(doc).toContain('insufficient_data');
    expect(doc).toContain('task_quality_regression');

    // The rollout doc's stage-2 gate references the RECORDED baseline by
    // experiment AND by the metric keys it gates on.
    const rollout = readFileSync(ROLLOUT_DOC, 'utf8');
    expect(rollout).toContain(experimentId);
    expect(rollout).toContain('IMAGINATION-BASELINE');
    const stage2 = rollout.slice(rollout.indexOf('| 2 |'), rollout.indexOf('| 3 |'));
    expect(stage2).toContain('useful_novelty_rate');
    expect(stage2).toContain('false_novelty');
    expect(stage2).toContain(experimentId);
    // No absolute home paths or machine names in either doc.
    for (const text of [doc, rollout]) expect(text).not.toMatch(/\/Users\/|\/home\//);
  });
});
