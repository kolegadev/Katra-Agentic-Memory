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
import { possibleCellCount } from '../../src/services/processing/idea-archive-service.js';
import {
  FORBIDDEN_SHARED_KEYS,
  MIN_MARKER_LENGTH,
  computeImaginationMetrics,
} from '../../src/services/processing/imagination-metrics-service.js';
import { COLLECTIONS } from '../../src/services/mission-cognition/collections.js';
import { CREATIVE_BATON_COLLECTIONS } from '../../src/services/processing/creative-baton-collections.js';
import { COGNITIVE_TEAM_COLLECTIONS } from '../../src/services/processing/cognitive-team-collections.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/imagination-baseline-checkpoint.json', import.meta.url));
const FIXED_AT = '2026-09-26T12:00:00.000Z';
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

/** The plateau window the frozen checkpoint belongs to. */
const PLATEAU_WINDOW = { from: '2026-09-26T00:00:00.000Z', to: FIXED_AT };

let db: FakeDb;
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  db = new FakeDb();
  holder.db = db.asDb();
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

/** The mission's graph, as the control comparator walks it (degree-ranked). */
function baselineMaterial(): Record<string, unknown> {
  // The store holds TWO missions' graphs by the time this runs (the cycle
  // mission and the team mission), so both lists are de-duplicated by identity:
  // the material is one graph, not two copies of it.
  const nodesById = new Map<string, Record<string, any>>();
  for (const node of db.collection('knowledge_nodes').docs as Array<Record<string, any>>) {
    const id = String(node.id);
    if (!nodesById.has(id)) nodesById.set(id, node);
  }
  const edgeKeys = new Set<string>();
  const edges: Array<Record<string, any>> = [];
  for (const edge of db.collection('knowledge_relationships').docs as Array<Record<string, any>>) {
    const key = `${String(edge.from_id)}->${String(edge.to_id)}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push(edge);
  }
  const nodes = [...nodesById.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const degree = new Map<string, number>();
  for (const edge of edges) {
    const from = String(edge.from_id);
    const to = String(edge.to_id);
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }
  const maxDegree = Math.max(1, ...degree.values());
  return {
    concepts: nodes
      .map((node) => ({
        id: String(node.id),
        name: String(node.properties?.name ?? node.id),
        degree: degree.get(String(node.id)) ?? 0,
        prominence: Number(((degree.get(String(node.id)) ?? 0) / maxDegree).toFixed(6)),
      }))
      .sort((left, right) => right.prominence - left.prominence || left.id.localeCompare(right.id)),
    edges: edges
      .map((edge) => [String(edge.from_id), String(edge.to_id)])
      .sort((left, right) => `${left[0]}->${left[1]}`.localeCompare(`${right[0]}->${right[1]}`)),
    basis:
      'knowledge_nodes + knowledge_relationships of the frozen scenario mission; prominence is the node degree ' +
      'divided by the maximum degree (a deterministic, text-free measure the harness re-derives itself)',
  };
}

function seedRows(cycleId: string): Array<Record<string, any>> {
  return (db.collection('idea_seeds').docs as Array<Record<string, any>>)
    .filter((row) => row.cycle_id === cycleId)
    .map((row) => ({
      seed_id: String(row.seed_id),
      agent: String(row.user_id),
      operator: String(row.operator),
      hypothesis: String(row.hypothesis),
      // `mechanism` is the candidate's own second field (the baton's
      // candidate_portfolio carries it), so the taint attribution can tell the
      // packet's own material from text lifted out of the private stores.
      mechanism: String(row.mechanism ?? ''),
      descriptor_bins: { ...(row.bins ?? {}) },
      cell_key: String(row.cell_key),
      novelty_score: Number(row.novelty_score),
      coherence_score: Number(row.coherence_score),
      testability_score: Number(row.testability_score),
      expected_information_gain: Number(row.expected_information_gain),
      cheapest_test: String(row.cheapest_test),
      quality: Number(row.quality),
      state: String(row.state),
      rejection_reason: row.rejection?.reason ? String(row.rejection.reason) : null,
      created_at: String(row.created_at),
      privacy_safe: true,
    }))
    .sort((left, right) => left.seed_id.localeCompare(right.seed_id));
}

function outcomesFor(seedIds: readonly string[]): Record<string, unknown> {
  const rows = (db.collection('idea_candidate_outcomes').docs as Array<Record<string, any>>).filter((row) =>
    seedIds.includes(String(row.seed_id)),
  );
  const byOutcome: Record<string, number> = {};
  for (const row of rows) byOutcome[String(row.outcome)] = (byOutcome[String(row.outcome)] ?? 0) + 1;
  return {
    recorded: rows.length,
    useful_information: byOutcome.useful_information ?? 0,
    mere_variance: byOutcome.mere_variance ?? 0,
    unnecessary_cost: byOutcome.unnecessary_cost ?? 0,
    decisions: rows
      .map((row) => ({ seed_id: String(row.seed_id), outcome: String(row.outcome) }))
      .sort((left, right) => left.seed_id.localeCompare(right.seed_id)),
  };
}

/**
 * c1's evidence: how many runs the engine recorded for this plateau window.
 * Counted from the collection the arm's own path writes (`imagination_cycles`
 * for a focused cycle, `cognitive_portfolios` (kind=first_pass) for a team
 * pass), inside the window, for this identity and mission — a store read, not a
 * claim.
 */
function plateauEvidence(args: {
  collection: string;
  idField: string;
  userId: string;
  missionId: string;
  kind?: string;
  measured_from: string;
}): Record<string, unknown> {
  const rows = (db.collection(args.collection).docs as Array<Record<string, any>>).filter((row) => {
    if (row.user_id !== args.userId || row.mission_id !== args.missionId) return false;
    if (args.kind !== undefined && row.kind !== args.kind) return false;
    const at = Date.parse(String(row.created_at ?? ''));
    return Number.isFinite(at) && at >= Date.parse(PLATEAU_WINDOW.from) && at <= Date.parse(PLATEAU_WINDOW.to);
  });
  return {
    window_id: `${args.missionId}@${PLATEAU_WINDOW.from}..${PLATEAU_WINDOW.to}`,
    window: { ...PLATEAU_WINDOW },
    cycles_in_window: rows.length,
    run_ids: rows.map((row) => String(row[args.idField])).sort(),
    measured_from: args.measured_from,
    determination: 'store_measured',
  };
}

/**
 * c2's evidence: the taint scan the metrics view itself runs, ATTRIBUTED.
 *
 * `privacy_leakage` reads back every SHARED-scope artefact this identity
 * produced and flags an artefact when it carries a forbidden private key OR
 * when one of its strings reproduces a marker lifted verbatim from the
 * identity's private stores. The audit returns the COUNT of flags — and in this
 * fixture the count is not zero, for a reason worth stating precisely: the
 * promoted baton carries `candidate_portfolio[i].hypothesis`, which is the
 * packet's own allow-listed candidate material (the compiler copies the
 * candidate's text deliberately), and the scripted scenario emitted the SAME
 * sentence for a candidate the archive rejected as a duplicate. The marker
 * rule cannot tell "the packet's own field, the text the candidate produced"
 * from "private material lifted into the packet", so it flags the
 * reproduction.
 *
 * This helper therefore reports BOTH numbers, so neither is hidden:
 *
 *   flagged              — the audit's own count, verbatim (1 here);
 *   private_text_crossed — the flags that are NOT a verbatim reproduction of
 *                          the candidate's own allow-listed field text (0
 *                          here). A flag on a forbidden private key, or on a
 *                          marker reproduced anywhere else, counts.
 *
 * The cross-check is not a hand-wave: an `allowed_field_reproduction` flag must
 * point at one of the baton's candidate fields AND the text it reproduced must
 * be the text THIS ARM's own admitted candidates produced (`candidate_portfolio[
 * i].hypothesis` must equal an admitted seed's hypothesis, and so on). The
 * c2 predicate in the harness reads exactly the two numbers above, and the
 * task-quality tests attack it with a baton that reproduces a TRACE STATEMENT,
 * which must mark the criterion unmet.
 */
async function taintEvidence(args: {
  userId: string;
  missionId: string;
  rows: ReadonlyArray<Record<string, any>>;
}): Promise<Record<string, unknown>> {
  const metrics = await computeImaginationMetrics(db.asDb(), {
    userId: args.userId,
    missionId: args.missionId,
    now: () => FIXED_AT,
  });
  const audit = metrics.privacy_leakage;
  const scope = { user_id: args.userId, mission_id: args.missionId };

  // The marker lift and the artefact set mirror `auditSharedArtefacts`, so the
  // attribution is over the same inputs the audit used.
  const markers = new Set<string>();
  for (const row of db.collection('idea_seeds').docs as Array<Record<string, any>>) {
    if (row.user_id !== scope.user_id || row.mission_id !== scope.mission_id || row.state !== 'rejected') continue;
    for (const text of [row.hypothesis, row.mechanism]) {
      if (typeof text === 'string' && text.length >= MIN_MARKER_LENGTH) markers.add(text);
    }
  }
  for (const row of db.collection('idea_lineages').docs as Array<Record<string, any>>) {
    if (row.user_id !== scope.user_id || row.mission_id !== scope.mission_id) continue;
    if (typeof row.changed_premise === 'string' && row.changed_premise.length >= MIN_MARKER_LENGTH) markers.add(row.changed_premise);
  }
  for (const row of db.collection('salience_traces').docs as Array<Record<string, any>>) {
    if (row.user_id !== scope.user_id || row.mission_id !== scope.mission_id) continue;
    for (const signal of row.signals ?? []) {
      for (const text of [signal?.statement, signal?.why_operationally_relevant]) {
        if (typeof text === 'string' && text.length >= MIN_MARKER_LENGTH) markers.add(text);
      }
    }
  }

  const artefacts: Array<{ collection: string; row: Record<string, any> }> = [
    ...(db.collection('creative_batons').docs as Array<Record<string, any>>)
      .filter((row) => row.user_id === scope.user_id && row.mission_id === scope.mission_id && row.shared_id != null)
      .map((row) => ({ collection: 'creative_batons', row })),
    ...(db.collection('creative_baton_promotions').docs as Array<Record<string, any>>)
      .filter((row) => row.user_id === scope.user_id && row.mission_id === scope.mission_id)
      .map((row) => ({ collection: 'creative_baton_promotions', row })),
  ];

  /** Every string in a value, with its JSON path. */
  const stringsOf = (value: unknown, path = '', out: Array<{ path: string; text: string }> = []): Array<{ path: string; text: string }> => {
    if (typeof value === 'string') out.push({ path, text: value });
    else if (Array.isArray(value)) value.forEach((item, index) => stringsOf(item, `${path}[${index}]`, out));
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) stringsOf(child, path ? `${path}.${key}` : key, out);
    }
    return out;
  };
  const keysOf = (value: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) for (const item of value) keysOf(item, out);
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        out.add(key);
        keysOf(child, out);
      }
    }
    return out;
  };

  /** The arm's OWN candidate text per allow-listed field (admitted rows only). */
  const ownCandidateText: Record<string, Set<string>> = {
    hypothesis: new Set(),
    mechanism: new Set(),
    cheapest_test: new Set(),
  };
  for (const row of args.rows) {
    if (row.state !== 'admitted') continue;
    for (const [field, set] of Object.entries(ownCandidateText)) {
      if (typeof row[field] === 'string') set.add(row[field]);
    }
  }
  const CANDIDATE_FIELD = /^candidate_portfolio\[\d+\]\.(hypothesis|mechanism|cheapest_test)$/;

  const flags: Array<Record<string, unknown>> = [];
  for (const artefact of artefacts) {
    const forbidden = FORBIDDEN_SHARED_KEYS.filter((key) => keysOf(artefact.row).has(key));
    if (forbidden.length > 0) {
      flags.push({
        artefact: artefact.collection,
        id: String(artefact.row.baton_id ?? artefact.row.promotion_id ?? 'unknown'),
        field: null,
        reason: 'forbidden_private_key',
        forbidden_keys: [...forbidden],
        allowed_field_reproduction: false,
      });
      continue;
    }
    for (const { path, text } of stringsOf(artefact.row)) {
      for (const marker of markers) {
        if (!text.includes(marker)) continue;
        const match = CANDIDATE_FIELD.exec(path);
        const ownText = match ? ownCandidateText[match[1]].has(text) : false;
        flags.push({
          artefact: artefact.collection,
          id: String(artefact.row.baton_id ?? artefact.row.promotion_id ?? 'unknown'),
          field: path,
          reason: 'marker_reproduced',
          marker_sha256: createHash('sha256').update(marker).digest('hex').slice(0, 32),
          marker_length: marker.length,
          allowed_field_reproduction: match !== null && ownText,
        });
      }
    }
  }
  const crossed = flags.filter((flag) => flag.allowed_field_reproduction !== true).length;

  return {
    shared_artefacts_scanned: audit.shared_artefacts_scanned,
    flagged: audit.flagged,
    private_text_crossed: crossed,
    markers_checked: audit.markers_checked,
    keys_checked: audit.keys_checked,
    flags,
    attributed_by:
      'this fixture test, over the same artefacts and markers the audit uses: a flag is an allowed-field reproduction only when the reproducing field is one of the ' +
      'baton’s candidate fields (candidate_portfolio[i].hypothesis|mechanism|cheapest_test) AND the text is the text this arm’s own admitted candidates produced',
    measured_from:
      `computeImaginationMetrics({ user_id: '${args.userId}', mission_id: '${args.missionId}' }).privacy_leakage — the same audit the ` +
      'metrics view runs over the shared-scope artefacts',
    determination: 'store_measured',
  };
}

/** Arm C: the focused engine, ONE balanced identity, on the frozen checkpoint. */async function armC(): Promise<Record<string, unknown>> {
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
        descriptor_bins: { ...(seed.descriptor_bins as unknown as Record<string, string>) },
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
    arms: [armCRows, armDRows],
    provenance: {
      generator: 'server/tests/unit/imagination-baseline-fixture.test.ts',
      regenerate:
        'IMAGINATION_BASELINE_FIXTURE_WRITE=1 npx vitest run tests/unit/imagination-baseline-fixture.test.ts',
      services:
        'runImaginationCycle, recordCandidateOutcome, planFirstPass/runFirstPass, createInheritanceEnvelope, ' +
        'runFocusedConsolidation — on tests/helpers/imagination-scenario.ts (FakeDb + a scripted model)',
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

    expect(Object.keys(committed).sort()).toEqual(Object.keys(fixture).sort());
    expect(committed.mission).toEqual(fixture.mission);
    expect(committed.task_checker).toEqual(fixture.task_checker);
    expect(committed.baseline_material).toEqual(fixture.baseline_material);
    expect(committedArms.map((arm) => arm.label)).toEqual(['C', 'D']);
    expect(committedArms.map(volatile)).toEqual(freshArms.map(volatile));
    expect(committed.checkpoint).toEqual(fixture.checkpoint);

    // The timestamps are real ISO instants, ordered: the trigger is not after
    // the first admitted candidate it produced.
    for (const arm of committedArms) {
      if (arm.trigger_at) expect(Number.isFinite(Date.parse(arm.trigger_at))).toBe(true);
      for (const row of arm.rows) expect(Number.isFinite(Date.parse(row.created_at))).toBe(true);
    }
    const trigger = Date.parse(committedArms[0].trigger_at);
    const firstAdmitted = Math.min(
      ...committedArms[0].rows
        .filter((row: Record<string, any>) => row.state === 'admitted')
        .map((row: Record<string, any>) => Date.parse(row.created_at)),
    );
    expect(firstAdmitted).toBeGreaterThanOrEqual(trigger);
    // The fixture is not empty: the two treatment arms really produced rows.
    expect(committedArms[0].rows.length).toBeGreaterThan(0);
    expect(committedArms[0].coverage.cells_total).toBeGreaterThan(0);
    expect(committedArms[0].outcomes.recorded).toBe(3);
    expect(committedArms[0].outcomes.useful_information).toBe(2);
    expect(committedArms[1].rows.length).toBeGreaterThan(0);
    expect(new Set(committedArms[1].rows.map((row: any) => row.agent)).size).toBe(3);

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
    expect(committedArms[0].plateau.cycles_in_window).toBe(1);
    expect(committedArms[0].plateau.run_ids).toEqual([committed.checkpoint.cycle_id]);
    expect(committedArms[0].plateau.determination).toBe('store_measured');
    expect(committedArms[1].plateau.cycles_in_window).toBe(1);
    expect(committedArms[1].plateau.run_ids).toEqual([committed.checkpoint.pass_id]);

    // c2: the taint scan's OWN numbers, verbatim, plus the attribution. The
    // promoted baton reproduces the candidates' own allow-listed text (the
    // compiler copies it deliberately) and the scripted scenario emitted the
    // same sentence for a candidate the archive rejected as a duplicate, so the
    // audit flags it — the flag is attributed, not hidden and not spun.
    const taint = committedArms[0].taint as Record<string, any>;
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
      const ownText = (committedArms[0].rows as Array<Record<string, any>>)
        .filter((row) => row.state === 'admitted')
        .some((row) => row[field] === text);
      expect(ownText, `${flag.field} is not this arm's own candidate text`).toBe(true);
    }
    // Arm D promotes nothing, so its scan is VACUOUS — recorded as such.
    expect(committedArms[1].taint.shared_artefacts_scanned).toBe(0);
    expect(committedArms[1].taint.flagged).toBe(0);
    expect(committedArms[1].taint.flags).toEqual([]);
  }, 120000);
});
