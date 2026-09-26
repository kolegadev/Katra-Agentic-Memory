/**
 * ITER-11, WS-4 — the FROZEN CHECKPOINT the baseline harness measures against.
 *
 * The harness (`server/scripts/imagination-baseline.mjs`) is dependency-free
 * plain Node, so it cannot import the services. This test is the generator AND
 * the freshness gate: it rebuilds the checkpoint with the REAL services (the
 * frozen scenario, one imagination cycle, the cognitive team's first pass, the
 * outcome channel), then compares the result, byte for byte, with the committed
 * fixture `tests/fixtures/imagination-baseline-checkpoint.json`.
 *
 *   node scripts/imagination-baseline.mjs --help          # the harness
 *   IMAGINATION_BASELINE_FIXTURE_WRITE=1 npx vitest run tests/unit/imagination-baseline-fixture.test.ts
 *     → rewrites the fixture from the real services (used ONCE, at authoring
 *       time; the harness never writes it)
 *   npx vitest run tests/unit/imagination-baseline-fixture.test.ts
 *     → asserts the committed fixture still equals what the code produces
 *
 * Everything the harness needs to be honest is in the file: the mission's
 * criteria (for the task-quality check), the comparator's own material (the
 * graph the two control arms walk) and every treatment row the real engine
 * produced (bins, cell key, scores, decision, cost, timings and outcomes).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

// The frozen checkpoint must be REPRODUCIBLE. The one thing in the whole
// generation path that is not deterministic is the trace's `randomUUID()`
// (the focused-consolidation ledger mints run and trace ids that way), and the
// trace id is hashed into the signal ids and therefore into every derived seed
// id. Pinning the UUID to a counter keeps the rest of `node:crypto` untouched
// (hashes are real) and makes two runs produce the same file.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  let counter = 0;
  return {
    ...actual,
    randomUUID: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    },
  };
});

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
import {
  CONTROL_MISSION_A,
  CONTROL_MISSION_B,
  FIXED_AT,
  PLATEAU_WINDOW,
  baselineMaterial,
  captureControlArm,
  controlCandidatesA,
  controlCandidatesB,
  outcomesFor,
  plateauEvidence,
  seedRows,
  setCaptureDb,
  taintEvidence,
} from '../helpers/imagination-baseline-capture.js';
import { llmService } from '../../src/services/infrastructure/llm-service.js';
import { usageDeltaSince, usageSnapshot } from '../../src/services/infrastructure/llm-usage-ledger.js';
import {
  OPERATOR_USER,
  SCENARIO_MISSION,
  defaultResponder,
  seedScenario,
} from '../helpers/imagination-scenario.js';
import { runImaginationCycle } from '../../src/services/processing/imagination-cycle-service.js';
import { recordCandidateOutcome } from '../../src/services/processing/imagination-outcome-service.js';
import { planFirstPass, runFirstPass } from '../../src/services/processing/independent-first-pass.js';
import { createInheritanceEnvelope } from '../../src/services/processing/inheritance-envelope.js';
import { runFocusedConsolidation } from '../../src/services/processing/focused-consolidation-service.js';
import { normalizeBins, possibleCellCount } from '../../src/services/processing/idea-archive-service.js';
import { COLLECTIONS } from '../../src/services/mission-cognition/collections.js';
import { CREATIVE_BATON_COLLECTIONS } from '../../src/services/processing/creative-baton-collections.js';
import { COGNITIVE_TEAM_COLLECTIONS } from '../../src/services/processing/cognitive-team-collections.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/imagination-baseline-checkpoint.json', import.meta.url));
const WRITE = process.env.IMAGINATION_BASELINE_FIXTURE_WRITE === '1';

const OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };
const LEAD: CallerIdentity = { user_id: OPERATOR_USER, trusted: false };
const TEAM_MODES: Record<string, string> = {
  'team-philosopher': 'philosopher',
  'team-analyst': 'analyst',
  'team-strategist': 'strategist',
};

/**
 * The predicate each of the frozen mission's success criteria is evaluated by.
 *
 * The criteria are the MISSION's own (`c1` "one cycle per plateau", `c2` "no
 * private text crosses"). Mapping both of them onto one predicate
 * (`portfolio_non_empty`) made the task-quality check decorative: every arm
 * passed it by producing a row, so "no material task-quality regression" was
 * true by construction. Each criterion now gets the predicate that actually
 * tests what it says, over evidence the arm has to carry — and a criterion with
 * no mapping is reported as NOT evaluated rather than counted as met.
 */
const PREDICATE_BY_CRITERION: Record<string, { predicate: string; basis: string }> = {
  c1: {
    predicate: 'cycles_per_plateau_within_limit',
    basis:
      'counts the runs the engine recorded for the plateau window (creative_baton_cycles for the one-identity arm, cognitive_portfolios ' +
      '(kind=first_pass) for the team arm) and requires at most 1 — the mission’s own wording is "one cycle per plateau"',
  },
  c2: {
    predicate: 'no_private_text_in_shared_artefacts',
    basis:
      'reads the taint scan the metrics view runs (privacy_leakage: the shared-scope artefacts scanned for the forbidden private keys and for ' +
      'markers lifted verbatim from this identity’s private stores) and requires zero flags',
  },
};

let db: FakeDb;
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  db = new FakeDb();
  holder.db = db.asDb();
  // The capture/evidence helpers read the SAME store this test installs.
  setCaptureDb(db);
  process.env.FOCUSED_IMAGINATION = '1';
  process.env.CREATIVE_BATON_PROMOTION = '1';
  process.env.COGNITIVE_TEAM_ALLOCATION = '1';
  const spy = vi.spyOn(llmService, 'extractJson').mockImplementation((async (system: string, prompt: string) =>
    defaultResponder(system, prompt)) as never);
  spies.push(spy);
  spies.push(
    vi.spyOn(llmService, 'getServiceStatus').mockReturnValue({
      available: true,
      provider: 'stub',
      model: 'stub(baseline-fixture)',
      providers: ['stub(ready)'],
    } as never),
  );
});

function restore(): void {
  for (const spy of spies.splice(0)) spy.mockRestore();
  delete process.env.FOCUSED_IMAGINATION;
  delete process.env.CREATIVE_BATON_PROMOTION;
  delete process.env.COGNITIVE_TEAM_ALLOCATION;
}

/** Arm C: the focused engine, ONE balanced identity, on the frozen checkpoint. */
async function armC(): Promise<Record<string, unknown>> {
  await seedScenario(db, { ownerId: OPERATOR_USER });
  const usageBefore = usageSnapshot();
  const cycle = await runImaginationCycle(db.asDb(), {
    userId: OPERATOR_USER,
    missionId: SCENARIO_MISSION,
    actorId: OPERATOR_USER,
    caller: OPERATOR,
  });
  if (cycle.status !== 'ran') throw new Error(`arm C cycle did not run: ${cycle.status}/${cycle.reason}`);
  const usage = usageDeltaSince(usageBefore);
  const rows = seedRows(cycle.cycle_id!);

  // The outcome channel records three verdicts so `useful_novelty_rate` and
  // `idea_survival` are measurable from the STORE. (The harness cannot judge an
  // idea without a live model; this file only carries what was recorded.)
  const admitted = rows.filter((row) => row.state === 'admitted');
  const decisions: Array<[string, 'useful_information' | 'unnecessary_cost' | 'mere_variance']> = [
    [admitted[0]?.seed_id, 'useful_information'],
    [admitted[1]?.seed_id ?? admitted[0]?.seed_id, 'useful_information'],
    [admitted[2]?.seed_id ?? admitted[0]?.seed_id, 'unnecessary_cost'],
  ];
  for (const [seedId, outcome] of decisions) {
    if (!seedId) continue;
    const recorded = await recordCandidateOutcome(db.asDb(), {
      userId: OPERATOR_USER,
      seedId,
      outcome,
      batonId: cycle.baton_id,
      detail: `frozen fixture: recorded a ${outcome} verdict for the baseline checkpoint`,
    });
    expect(recorded.recorded).toBe(true);
  }
  const cycleRow = db
    .collection(CREATIVE_BATON_COLLECTIONS.cycles)
    .docs.find((row: any) => row.cycle_id === cycle.cycle_id) as Record<string, any>;
  const coverage = (cycleRow?.coverage ?? {}) as Record<string, any>;

  return {
    label: 'C',
    name: 'focused_engine_balanced',
    kind: 'treatment',
    config: {
      flag: 'FOCUSED_IMAGINATION=1',
      identities: [OPERATOR_USER],
      mode: 'balanced',
      candidate_promotion: 'CREATIVE_BATON_PROMOTION=1',
      cycle_trigger: 'manual (the frozen checkpoint)',
    },
    admission_rule: {
      path: 'shipped_archive',
      service: 'IdeaArchiveService.admitOrReplace',
      decided_by: 'the imagination engine, inside runImaginationCycle on the frozen scenario',
      identity: OPERATOR_USER,
      mission_id: SCENARIO_MISSION,
      same_rule_as: ['A', 'B', 'C', 'D'],
      text_is_scripted: true,
      text_basis: 'the scripted stub model’s output (this fixture’s responder)',
    },
    generation: {
      path: 'real_services',
      captured_from: 'runImaginationCycle + recordCandidateOutcome on the frozen scenario',
      determination: 'store_measured',
      note: 'idea TEXT is the scripted stub model’s; the bins, the archive decision, the cell keys, the cost and the outcomes are the real services’ own rows',
    },
    trigger_at: String(cycleRow?.created_at ?? ''),
    cycle_id: cycle.cycle_id,
    tokens: Number(cycle.budget?.tokens_spent_this_cycle ?? usage.input_tokens + usage.output_tokens ?? 0),
    counts: {
      generated: Number(cycleRow?.counts?.seeds_generated ?? rows.length),
      admitted: Number(cycleRow?.counts?.seeds_admitted ?? admitted.length),
      rejected: Number(cycleRow?.counts?.seeds_rejected ?? rows.filter((row) => row.state === 'rejected').length),
      below_incumbent: Number(cycleRow?.counts?.seeds_below_incumbent ?? 0),
    },
    coverage: {
      cells_total: Number(coverage.cells_total ?? 0),
      new_cells_this_cycle: Number(coverage.new_cells_this_cycle ?? 0),
      possible_cells: Number(coverage.occupancy?.possible ?? 0),
      occupancy_ratio: Number(coverage.occupancy?.ratio ?? 0),
    },
    rows,
    outcomes: outcomesFor(rows.map((row) => String(row.seed_id))),
    plateau: plateauEvidence({
      collection: CREATIVE_BATON_COLLECTIONS.cycles,
      idField: 'cycle_id',
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      measured_from: `${CREATIVE_BATON_COLLECTIONS.cycles} rows for {user_id: '${OPERATOR_USER}', mission_id: '${SCENARIO_MISSION}'} inside the plateau window`,
    }),
    taint: await taintEvidence({ userId: OPERATOR_USER, missionId: SCENARIO_MISSION, rows }),
  };
}

/**
 * Name one seed's descriptor tuple the way the ARCHIVE names it on its own rows.
 *
 * `runFirstPass` hands each seed back in the archive's ORDERED-array form
 * (`FirstPassSeedSummary.descriptor_bins` — the bins positional in the ACTIVE
 * dimensions' order), which JSON-serialises as `{"0":…,"4":…}`: the SAME key
 * arm C's rows answer with a dimension-NAMED record, so a reader (or a harness)
 * doing `descriptor_bins.mechanism` on a team row read `undefined` while the
 * same read worked on a focused-engine row.
 *
 * The names come from the descriptor space itself, through the archive's own
 * conversion of that exact form (`normalizeBins`, the function the archive
 * applies to a seed before it stores it): the ordered array IS the positional
 * projection of the stored `bins`, so this is the stored record, not a second
 * naming scheme. Nothing but the keys changes — the bins keep their values, and
 * the cell key already spells them in this order.
 */
function dimensionNamedBins(ordered: readonly string[]): Record<string, string> {
  return normalizeBins(ordered).bins;
}

/** Arm D: the engine plus the HETEROGENEOUS cognitive team on the same checkpoint. */
async function armD(): Promise<Record<string, unknown>> {
  await seedScenario(db, { ownerId: OPERATOR_USER, missionId: `${SCENARIO_MISSION}_team` });
  const missionId = `${SCENARIO_MISSION}_team`;
  const team: Array<{ identity: string; mode: string; envelope_id?: string }> = [];
  for (const [identity, mode] of Object.entries(TEAM_MODES)) {
    const focused = await runFocusedConsolidation(db.asDb(), {
      userId: identity,
      missionId,
      cycleId: `baseline_team_trace:${missionId}:${identity}`,
      actorId: identity,
    });
    expect(focused.status).toBe('completed');
    const envelope = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OPERATOR_USER,
      missionId,
      childLabel: identity,
      mode,
      caller: LEAD,
      now: () => FIXED_AT,
    });
    team.push({ identity, mode, envelope_id: envelope.envelope.envelope_id });
  }
  const usageBefore = usageSnapshot();
  const planned = await planFirstPass(db.asDb(), { userId: OPERATOR_USER, missionId, team, caller: LEAD, now: () => FIXED_AT });
  const ran = await runFirstPass(db.asDb(), {
    userId: OPERATOR_USER,
    missionId,
    team,
    caller: LEAD,
    now: () => FIXED_AT,
  });
  const usage = usageDeltaSince(usageBefore);
  expect(planned.pass.requests.every((request) => request.status === 'ready')).toBe(true);

  const rows: Array<Record<string, any>> = [];
  const rejections: Array<{ seed_id: string; reason: string }> = [];
  for (const result of ran.results) {
    for (const seed of result.seeds) {
      rows.push({
        seed_id: seed.seed_id,
        agent: result.identity,
        operator: seed.operator,
        hypothesis: seed.hypothesis,
        descriptor_bins: dimensionNamedBins(seed.descriptor_bins),
        cell_key: seed.cell_key,
        novelty_score: seed.novelty_score,
        coherence_score: seed.coherence_score,
        testability_score: seed.testability_score,
        expected_information_gain: seed.expected_information_gain,
        cheapest_test: seed.cheapest_test,
        quality: seed.quality,
        state: 'admitted',
        rejection_reason: null,
        created_at: FIXED_AT,
        privacy_safe: true,
      });
    }
    for (const rejection of result.rejections) {
      rejections.push({ seed_id: rejection.seed_id, reason: rejection.reason });
    }
  }
  rows.sort((left, right) => left.seed_id.localeCompare(right.seed_id));

  return {
    label: 'D',
    name: 'engine_plus_heterogeneous_team',
    kind: 'treatment',
    config: {
      flag: 'FOCUSED_IMAGINATION=1 + COGNITIVE_TEAM_ALLOCATION=1',
      identities: Object.keys(TEAM_MODES),
      modes: TEAM_MODES,
      pass_id: ran.pass.pass_id,
    },
    admission_rule: {
      path: 'shipped_archive',
      service: 'IdeaArchiveService.admitOrReplace',
      decided_by: 'the imagination engine, inside runFirstPass on the frozen scenario',
      identity: OPERATOR_USER,
      mission_id: missionId,
      same_rule_as: ['A', 'B', 'C', 'D'],
      text_is_scripted: true,
      text_basis: 'the scripted stub model’s output (this fixture’s responder)',
    },
    generation: {
      path: 'real_services',
      captured_from: 'planFirstPass + runFirstPass over the frozen scenario with three modes',
      determination: 'store_measured',
      note: 'per-agent portfolios with their own modes; idea TEXT is the scripted stub model’s',
    },
    trigger_at: FIXED_AT,
    cycle_id: ran.pass.pass_id,
    tokens: Number(usage.input_tokens + usage.output_tokens ?? 0),
    counts: {
      generated: ran.results.reduce((sum, result) => sum + result.seeds_generated, 0),
      admitted: rows.length,
      rejected: ran.results.reduce((sum, result) => sum + result.seeds_rejected, 0),
      below_incumbent: 0,
    },
    coverage: {
      // The team runs per identity, so the coverage number is the union of the
      // cells the three portfolios addressed (counted from their own cell keys).
      cells_total: new Set(rows.map((row) => row.cell_key)).size,
      new_cells_this_cycle: new Set(rows.map((row) => row.cell_key)).size,
      possible_cells: possibleCellCount(),
      occupancy_ratio: Number(
        (new Set(rows.map((row) => row.cell_key)).size / Math.max(1, possibleCellCount())).toFixed(9),
      ),
    },
    rows,
    rejections,
    outcomes: { recorded: 0, useful_information: 0, mere_variance: 0, unnecessary_cost: 0, decisions: [] },
    plateau: plateauEvidence({
      collection: COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios,
      idField: 'portfolio_id',
      kind: 'first_pass',
      userId: OPERATOR_USER,
      missionId,
      measured_from:
        `${COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios} rows of kind 'first_pass' for {user_id: '${OPERATOR_USER}', mission_id: '${missionId}'} ` +
        'inside the plateau window',
    }),
    taint: await taintEvidence({ userId: OPERATOR_USER, missionId, rows }),
  };
}

async function buildFixture(): Promise<Record<string, unknown>> {
  const armCRows = await armC();
  // Arm D runs on its own mission in the same store; the arm-C rows are already
  // captured above, so a second scenario seed does not disturb them.
  const armDRows = await armD();
  const mission = db
    .collection(COLLECTIONS.missionStates)
    .docs.find((row: any) => row.mission_id === `${SCENARIO_MISSION}_team`) as Record<string, any>;
  const material = baselineMaterial();

  // The two comparators. They need the mission's graph, so they run AFTER the
  // scenario is seeded; they write to a THROWAWAY identity and mission, so they
  // cannot collide with, exclude or contaminate a treatment row.
  const armARows = await captureControlArm({
    label: 'A',
    name: 'control_dreamer_retrieval',
    path: 'pre-engine dreamer-style retrieval',
    retrieval: 'concepts ranked by graph degree (prominence)',
    missionId: CONTROL_MISSION_A,
    candidates: controlCandidatesA(material),
  });
  const armBRows = await captureControlArm({
    label: 'B',
    name: 'control_mind_wander',
    path: 'pre-engine mind-wander over the graph',
    retrieval: 'walk steps from the mission’s edges; both directions of every step are emitted, exactly as an undeduped wander does',
    missionId: CONTROL_MISSION_B,
    candidates: controlCandidatesB(material),
  });

  return {
    fixture_version: '1.0',
    frozen_at: FIXED_AT,
    mission: {
      mission_id: String(mission.mission_id),
      title: String(mission.title),
      intent: String(mission.intent),
      version: Number(mission.version),
      authority_class: String(mission.authority_class),
      owner_id: String(mission.owner_id),
      success_criteria: (mission.success_criteria ?? []).map((criterion: any) => ({
        id: String(criterion.id),
        description: String(criterion.description),
        status: String(criterion.status),
      })),
    },
    checkpoint: {
      scenario: 'tests/helpers/imagination-scenario.ts (the frozen scripted-model scenario)',
      cycle_id: armCRows.cycle_id,
      pass_id: armDRows.cycle_id,
      trace_id: String((db.collection('salience_traces').docs[0] as any)?.trace_id ?? ''),
    },
    baseline_material: material,
    task_checker: {
      criteria: (mission.success_criteria ?? []).map((criterion: any) => {
        const mapping = PREDICATE_BY_CRITERION[String(criterion.id)];
        return {
          id: String(criterion.id),
          description: String(criterion.description),
          predicate: mapping?.predicate ?? 'unmapped_criterion',
          basis:
            mapping?.basis ??
            'no predicate is mapped for this criterion: the harness reports it as NOT evaluated (insufficient_data for the whole check) rather than counting it as met',
          ...(mapping?.predicate === 'cycles_per_plateau_within_limit' ? { plateau_cycle_limit: 1 } : {}),
        };
      }),
      basis:
        'the frozen mission’s own success criteria, each mapped to a DISTINCT documented predicate over evidence the arm has to carry (a plateau ' +
        'run count for "one cycle per plateau", the taint scan for "no private text crosses"); the task-quality check evaluates every arm with the ' +
        'predicate its criterion names, records the evidence, and refuses a verdict when an evaluation is missing',
    },
    arms: [armARows, armBRows, armCRows, armDRows],
    provenance: {
      generator: 'server/tests/unit/imagination-baseline-fixture.test.ts',
      regenerate:
        'IMAGINATION_BASELINE_FIXTURE_WRITE=1 npx vitest run tests/unit/imagination-baseline-fixture.test.ts',
      services:
        'runImaginationCycle, recordCandidateOutcome, planFirstPass/runFirstPass, createInheritanceEnvelope, ' +
        'runFocusedConsolidation, IdeaArchiveService.admitOrReplace (the two comparator arms’ admission) — on ' +
        'tests/helpers/imagination-scenario.ts (FakeDb + a scripted model)',
      not_verified: 'no live MongoDB, no real model, no real mission: every row here comes from the frozen fixture',
    },
  };
}

describe('the frozen baseline checkpoint', () => {
  it('is exactly what the real services produce from the frozen scenario', async () => {
    let fixture: Record<string, unknown>;
    try {
      fixture = await buildFixture();
    } finally {
      restore();
    }

    if (WRITE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    }

    const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

    // The one VOLATILE part of the fixture is wall-clock: the archive stamps the
    // seed rows with the moment they were written, so a regeneration writes new
    // timestamps. Everything else — the mission, the criteria, the material, the
    // bins, the cell keys, the decisions, the counts, the coverage, the cost and
    // the outcomes — is compared byte for byte, and the timestamps' own shape
    // and ORDER are asserted separately below.
    const volatile = (arm: Record<string, any>) => ({
      ...arm,
      trigger_at: '(volatile)',
      rows: (arm.rows ?? []).map((row: Record<string, any>) => ({ ...row, created_at: '(volatile)' })),
    });
    const committedArms = committed.arms as Array<Record<string, any>>;
    const freshArms = fixture.arms as Array<Record<string, any>>;
    const arm = (label: string) => committedArms.find((row) => row.label === label)!;

    expect(Object.keys(committed).sort()).toEqual(Object.keys(fixture).sort());
    expect(committed.mission).toEqual(fixture.mission);
    expect(committed.task_checker).toEqual(fixture.task_checker);
    expect(committed.baseline_material).toEqual(fixture.baseline_material);
    expect(committedArms.map((row) => row.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(committedArms.map(volatile)).toEqual(freshArms.map(volatile));
    expect(committed.checkpoint).toEqual(fixture.checkpoint);

    // The timestamps are real ISO instants, ordered: the trigger is not after
    // the first admitted candidate it produced.
    for (const row of committedArms) {
      if (row.trigger_at) expect(Number.isFinite(Date.parse(row.trigger_at))).toBe(true);
      for (const candidate of row.rows) expect(Number.isFinite(Date.parse(candidate.created_at))).toBe(true);
    }
    const trigger = Date.parse(arm('C').trigger_at);
    const firstAdmitted = Math.min(
      ...arm('C').rows
        .filter((row: Record<string, any>) => row.state === 'admitted')
        .map((row: Record<string, any>) => Date.parse(row.created_at)),
    );
    expect(firstAdmitted).toBeGreaterThanOrEqual(trigger);
    // The fixture is not empty: the two treatment arms really produced rows.
    expect(arm('C').rows.length).toBeGreaterThan(0);
    expect(arm('C').coverage.cells_total).toBeGreaterThan(0);
    expect(arm('C').outcomes.recorded).toBe(3);
    expect(arm('C').outcomes.useful_information).toBe(2);
    expect(arm('D').rows.length).toBeGreaterThan(0);
    expect(new Set(arm('D').rows.map((row: any) => row.agent)).size).toBe(3);

    // ── The LIKE-FOR-LIKE admission rule (ITER-11 refinement) ───────────────
    // The reviewer's finding: the comparators' rejections were produced by the
    // harness's own re-implementation of the archive's containment rule while
    // the treatments ran the shipped archive, so the cross-arm false-novelty
    // comparison was not like-for-like. Every arm now declares the SAME shipped
    // rule, and the comparator rows carry THAT rule's own decisions.
    for (const label of ['A', 'B', 'C', 'D']) {
      expect(arm(label).admission_rule, `${label} has no admission_rule`).toBeTruthy();
      expect(arm(label).admission_rule.path).toBe('shipped_archive');
      expect(arm(label).admission_rule.service).toBe('IdeaArchiveService.admitOrReplace');
      expect(arm(label).admission_rule.same_rule_as).toEqual(['A', 'B', 'C', 'D']);
      // The counts reconcile for the comparators too.
      expect(arm(label).counts.generated).toBe(arm(label).counts.admitted + arm(label).counts.rejected);
    }
    // Arm A: four restatements of one template in ONE descriptor cell — the
    // archive admits the first and rejects the rest; nothing is schema-invalid
    // (the fixture's candidates satisfy the shipped seed schema, or the archive
    // would have stored nothing for them).
    const controlA = arm('A');
    expect(controlA.rows).toHaveLength(4);
    expect(controlA.rows.filter((row: any) => row.state === 'admitted')).toHaveLength(1);
    expect(controlA.rows.every((row: any) => row.rejection_reason !== 'schema_invalid')).toBe(true);
    expect(controlA.rejections.length).toBeGreaterThan(0);
    expect(controlA.rows.filter((row: any) => row.state === 'admitted')[0].cell_key).toBe(
      Object.entries(controlA.rows[0].descriptor_bins)
        .map(([dimension, bin]) => `${dimension}=${bin}`)
        .join('|'),
    );
    // Arm B: both directions of every walk step — the pathology the archive was
    // built to reject.
    const controlB = arm('B');
    expect(controlB.rows).toHaveLength(8);
    expect(controlB.rows.filter((row: any) => row.state === 'admitted')).toHaveLength(1);
    expect(controlB.rejections.length).toBeGreaterThan(controlA.rejections.length);
    // Every rejection is a reason from the ARCHIVE's own enum (the seen-before
    // set the false-novelty metric counts, or a schema refusal which the check
    // above excludes) — never a string this test file invented.
    for (const rejection of [...controlA.rejections, ...controlB.rejections]) {
      expect(['duplicate_of', 'paraphrase_of', 'excluded_region']).toContain(rejection.reason);
    }
    // The comparators' task-quality evidence is DECLARED (not measured), and
    // says so — it is not store_measured, unlike the treatment arms'.
    expect(controlA.plateau.determination).toBe('stub_determined');
    expect(controlA.plateau.cycles_in_window).toBe(0);
    expect(controlA.taint.shared_artefacts_scanned).toBe(0);
    expect(controlB.taint.determination).toBe('stub_determined');

    // ── The task-quality evidence (ITER-11 refinement) ──────────────────────
    // The two criteria are DISTINCT predicates, and each arm carries the
    // evidence its own criterion needs. Both used to be `portfolio_non_empty`,
    // which made the check un-failable.
    const criteria = committed.task_checker.criteria as Array<Record<string, any>>;
    expect(criteria.map((row) => row.predicate)).toEqual([
      'cycles_per_plateau_within_limit',
      'no_private_text_in_shared_artefacts',
    ]);
    expect(criteria[0].plateau_cycle_limit).toBe(1);
    expect(criteria[1].plateau_cycle_limit).toBeUndefined();
    for (const criterion of criteria) expect(criterion.basis).toBeTruthy();

    // c1: the run count for the plateau window, named — the mission's own
    // wording ("one cycle per plateau") measured from the store.
    expect(arm('C').plateau.cycles_in_window).toBe(1);
    expect(arm('C').plateau.run_ids).toEqual([committed.checkpoint.cycle_id]);
    expect(arm('C').plateau.determination).toBe('store_measured');
    expect(arm('D').plateau.cycles_in_window).toBe(1);
    expect(arm('D').plateau.run_ids).toEqual([committed.checkpoint.pass_id]);

    // c2: the taint scan's OWN numbers, verbatim, plus the attribution. The
    // promoted baton reproduces the candidates' own allow-listed text (the
    // compiler copies it deliberately) and the scripted scenario emitted the
    // same sentence for a candidate the archive rejected as a duplicate, so the
    // audit flags it — the flag is attributed, not hidden and not spun.
    const taint = arm('C').taint as Record<string, any>;
    expect(taint.flagged).toBe(1);
    expect(taint.shared_artefacts_scanned).toBe(2);
    expect(taint.private_text_crossed).toBe(0);
    expect(taint.flags).toHaveLength(2);
    for (const flag of taint.flags) {
      expect(flag.reason).toBe('marker_reproduced');
      expect(flag.field).toMatch(/^candidate_portfolio\[\d+\]\.(hypothesis|mechanism|cheapest_test)$/);
      expect(flag.allowed_field_reproduction, JSON.stringify(flag)).toBe(true);
      expect(flag.marker_sha256).toMatch(/^[0-9a-f]{32}$/);
      // The text it reproduced really is this arm's own candidate text: the
      // flag is only excused because the reproduction is of that field.
      const index = Number(flag.field.match(/\[(\d+)\]/)![1]);
      const field = flag.field.split('.').pop()!;
      const baton = (db.collection('creative_batons').docs as Array<Record<string, any>>).find(
        (row) => row.baton_id === flag.id,
      )!;
      const text = String(baton.candidate_portfolio[index][field]);
      const ownText = (arm('C').rows as Array<Record<string, any>>)
        .filter((row) => row.state === 'admitted')
        .some((row) => row[field] === text);
      expect(ownText, `${flag.field} is not this arm's own candidate text`).toBe(true);
    }
    // Arm D promotes nothing, so its scan is VACUOUS — recorded as such.
    expect(arm('D').taint.shared_artefacts_scanned).toBe(0);
    expect(arm('D').taint.flagged).toBe(0);
    expect(arm('D').taint.flags).toEqual([]);
  }, 120000);
});
