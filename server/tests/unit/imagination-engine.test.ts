/**
 * ITER-6 — the imagination engine + its quality-diversity archive (Phase 4).
 * Contract: CONTRACT-iter6-imagination-engine.md.
 *
 * What is proved here, against the REAL services and the REAL MCP dispatch
 * gate (only `llmService.extractJson` is stubbed — no network, no provider):
 *
 *   A. the run      — a frozen fixture (mission, ledger with a REJECTED
 *      hypothesis, work queue, a knowledge graph and a REAL ITER-5 salience
 *      trace) yields schema-valid, evidence-linked seeds admitted into cells;
 *   B. determinism  — the same seed over the same inputs produces a
 *      byte-identical portfolio (ids are DERIVED, and the payload is compared
 *      with the volatile fields stripped, across an advanced clock); a
 *      different seed produces a different, still schema-valid portfolio;
 *   C. operators    — the plan is trace-driven and deterministic, all ten
 *      families are implemented and selectable, and the distant-association
 *      walk is bounded, seeded, cycle-safe and RETURNS THE PATH;
 *   D. diversity    — a 6-seed cycle spans ≥3 descriptor dimensions and yields
 *      ≥3 new cells, while a near-duplicate pair in one cycle collapses;
 *   E. dedupe       — exact duplicates, paraphrases and excluded regions are
 *      rejected WITH REASONS (duplicate_of / paraphrase_of / excluded_region);
 *   F. re-entry     — a changed premise plus a lineage link re-opens a ruled-out
 *      idea and is recorded in the cell's history; without either it stays out;
 *   G. lineage      — every admitted seed has a lineage row, a mutated child
 *      links to its parent, and a replacement records the previous incumbent;
 *   H. bounds       — seed / operator / model-call caps hold even when the
 *      caller asks for more, and the run records planned vs actual;
 *   I. hostile model output — junk seeds are dropped with counted reasons and a
 *      wholly unusable output fails the run cleanly;
 *   J. privacy      — no `shared_id` anywhere, the coverage view carries no
 *      seed text, the journal family is byte-identical, and the new modules
 *      import no journal writer, use no `randomUUID` and no `Math.random`;
 *   K. the flag     — off: both tools are `Unknown tool`, nothing is written and
 *      no model is called; untrusted callers cannot reach another identity;
 *   L. the pre-existing goal-directed mind-wander defect — real edges (stored
 *      as `from_id`/`to_id`) are actually traversed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
import { MissionStateService } from '../../src/services/mission-cognition/mission-state-service.js';
import { StateDeltaService } from '../../src/services/mission-cognition/state-delta-service.js';
import { validateAgainst, SCHEMA_IDS } from '../../src/services/mission-cognition/schema-registry.js';
import {
  FocusedConsolidationService,
  runFocusedConsolidation,
} from '../../src/services/processing/focused-consolidation-service.js';
import {
  DEFAULT_MAX_LLM_CALLS,
  DEFAULT_MAX_OPERATORS,
  DEFAULT_MAX_SEEDS,
  IMAGINATION_SYSTEM_PROMPT,
  ImaginationService,
  OPERATORS_PER_CALL,
  buildImaginationInputs,
  environmentBudget,
  generateImaginationSeeds,
  resolveBudget,
  runImaginationCycle,
  stripVolatile,
  portfolioDigest,
  walkDistantAssociations,
  type GeneratedPortfolio,
  type ImaginationInventory,
} from '../../src/services/processing/imagination-service.js';
import {
  OPERATOR_FAMILIES,
  OPERATOR_SPECS,
  OPERATOR_TRACE_MAP,
  SeededRandom,
  hashSeed,
  planOperators,
  signalsForPlan,
  traceSignalId,
} from '../../src/services/processing/imagination-operators.js';
import {
  CONTAINMENT_THRESHOLD,
  DESCRIPTOR_BINS,
  DESCRIPTOR_DIMENSIONS,
  IdeaArchiveService,
  LENGTH_GUARD_RATIO,
  MIN_CHANGED_PREMISE_TOKENS,
  MIN_CONTAINMENT_OVERLAP,
  MIN_PREMISE_TOKEN_CHARS,
  NO_CHANGE_PHRASES,
  PARAPHRASE_THRESHOLD,
  QUALITY_WEIGHTS,
  cellKeyFor,
  comparableText,
  containmentMeasure,
  contentTokens,
  isCompletePremise,
  isVacuousPremise,
  newContentTokens,
  normalizeBins,
  normalizeStatement,
  qualityOf,
  seedSimilarity,
  statementContainment,
  statementSimilarity,
  vacuousPremisePhrase,
  type ExclusionRegion,
  type IdeaSeedInput,
} from '../../src/services/processing/idea-archive-service.js';
import {
  IMAGINATION_COLLECTIONS,
  ensureImaginationIndexes,
} from '../../src/services/processing/imagination-collections.js';
import {
  IMAGINATION_TOOL_NAMES,
  dispatchImaginationTool,
} from '../../src/services/processing/imagination-tools.js';
import { PERSONAL_KINDS, resolveWriteScope } from '../../src/services/memory/write-scope-policy.js';
import { SelfModelService } from '../../src/services/processing/self-model-service.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const SEEDS = IMAGINATION_COLLECTIONS.ideaSeeds;
const LINEAGES = IMAGINATION_COLLECTIONS.ideaLineages;
const CELLS = IMAGINATION_COLLECTIONS.ideaArchiveCells;
const RUNS = IMAGINATION_COLLECTIONS.imaginationRuns;
const ALL_IMAGINATION_COLLECTIONS = [SEEDS, LINEAGES, CELLS, RUNS];

const OWNER: CallerIdentity = { user_id: 'agent-a', trusted: false };
const OTHER: CallerIdentity = { user_id: 'agent-b', trusted: false };
const OPERATOR_IDENTITY: CallerIdentity = { user_id: 'operator', trusted: true };
/** Collections that must never change because of an imagination run. */
const JOURNAL_FAMILY = ['reflective_journals', 'reflection_nodes', 'reflection_edges', 'consolidation_runs'];
const MISSION = 'mission_imagination_fixture';

let db: FakeDb;
let extractJson: ReturnType<typeof vi.spyOn>;
let serviceStatus: ReturnType<typeof vi.spyOn>;
let respond: (system: string, prompt: string, maxTokens: number) => Promise<Record<string, unknown>>;
const prompts: string[] = [];

/**
 * A key the GENERATED portfolio payload must never carry: the generator's
 * output is content, so nothing in it may be time-derived. (`stripVolatile`
 * also drops identity and bookkeeping keys, which the run-level comparison
 * exercises.)
 */
const TIME_DERIVED_KEY = /(^|_)(at|created_at|updated_at|completed_at|coverage_date|duration_ms)$/;

const llmCalls = () => extractJson.mock.calls.length;

function txt(result: Array<{ type: string; text: string }>): string {
  return result.map((r) => r.text).join('\n');
}

/** A byte-for-byte snapshot of the journal / reflection families. */
function freezeJournalFamily(): string {
  return JSON.stringify(
    Object.fromEntries(JOURNAL_FAMILY.map((name) => [name, db.collection(name).docs])),
  );
}

/** All docs of the four collections this feature owns. */
function imaginationDocs(): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(
    ALL_IMAGINATION_COLLECTIONS.map((name) => [name, db.collection(name).docs as Array<Record<string, unknown>>]),
  );
}

// ── The stub model ──────────────────────────────────────────────────────────

/** The trace-signal ids the imagination prompt actually offered. */
function offeredSignalIds(prompt: string): string[] {
  return [...prompt.matchAll(/^- \[(sig_[0-9a-f]+)\]/gm)].map((match) => match[1]);
}

/** The operator families the prompt asked for in this batch. */
function requestedOperators(prompt: string): string[] {
  const match = prompt.match(/Produce the seeds for \[([^\]]+)\] now/);
  if (!match) return [];
  return match[1].split(',').map((name) => name.trim()).filter(Boolean);
}

/** Distinct descriptor bins per operator, so a plan of six spans six cells. */
const OPERATOR_BINS: Record<string, Record<string, string>> = {
  assumption_inversion: { mechanism: 'removal', representation: 'prose', violated_assumption: 'necessity', evidence_family: 'epistemic_ledger', test_strategy: 'kill_criterion' },
  representation_shift: { mechanism: 'relocation', representation: 'table', violated_assumption: 'sufficiency', evidence_family: 'operational_state', test_strategy: 'instrumentation' },
  distant_analogy: { mechanism: 'composition', representation: 'graph', violated_assumption: 'independence', evidence_family: 'external_observation', test_strategy: 'observation_study' },
  constraint_mutation: { mechanism: 'substitution', representation: 'list', violated_assumption: 'scarcity', evidence_family: 'work_queue', test_strategy: 'ab_test' },
  boundary_extreme: { mechanism: 'amplification', representation: 'numeric', violated_assumption: 'stability', evidence_family: 'temporal_series', test_strategy: 'simulation' },
  causal_reversal: { mechanism: 'reversal', representation: 'protocol', violated_assumption: 'identity', evidence_family: 'trace_absence', test_strategy: 'cheapest_probe' },
  contradiction_preservation: { mechanism: 'composition', representation: 'graph', violated_assumption: 'sufficiency', evidence_family: 'epistemic_ledger', test_strategy: 'instrumentation' },
  tool_invention: { mechanism: 'removal', representation: 'protocol', violated_assumption: 'scarcity', evidence_family: 'work_queue', test_strategy: 'cheapest_probe' },
  random_semantic_bridge: { mechanism: 'relocation', representation: 'graph', violated_assumption: 'independence', evidence_family: 'external_observation', test_strategy: 'observation_study' },
  counterfactual_world: { mechanism: 'reversal', representation: 'numeric', violated_assumption: 'stability', evidence_family: 'temporal_series', test_strategy: 'simulation' },
};

/**
 * What each operator claims in the stub — genuinely DIFFERENT ideas, not one
 * sentence with the operator name swapped in. That distinction matters: the
 * archive rejects paraphrases, so a lazy stub would collapse its own portfolio
 * and the run would (correctly) admit almost nothing.
 */
const OPERATOR_TEXT: Record<string, { hypothesis: string; mechanism: string; test: string }> = {
  assumption_inversion: {
    hypothesis: 'The trigger is not what ends the plateau: the plateau clears once the drain is measured.',
    mechanism: 'Inverting "the trigger is necessary" predicts the plateau clears without it as soon as the drain becomes visible.',
    test: 'Disable the trigger for one cycle with the drain measured and compare the plateau length.',
  },
  representation_shift: {
    hypothesis: 'Drawn as a per-cycle queue-length table, the plateau looks like a reporting artefact of averaging.',
    mechanism: 'A tabular read exposes a bimodal split that the mean hides, so the plateau is where the split sits.',
    test: 'Render the last five cycles as a table and check whether the distribution is bimodal.',
  },
  distant_analogy: {
    hypothesis: 'The plateau behaves like a reservoir whose outflow was never measured.',
    mechanism: 'Reservoir dynamics say an unmeasured outflow is indistinguishable from a stalled inflow while the level holds.',
    test: 'Fit the level series to a two-parameter reservoir and see whether the outflow is non-zero.',
  },
  constraint_mutation: {
    hypothesis: 'Loosening the manual-approval constraint removes the plateau entirely.',
    mechanism: 'Approval latency, not the queue itself, is what accumulates during the plateau window.',
    test: 'Raise the approval concurrency for one cycle and measure the plateau length.',
  },
  boundary_extreme: {
    hypothesis: 'At zero drain capacity the queue never recovers, and at one drain per cycle it never plateaus.',
    mechanism: 'The two extremes bracket the regime change, so walking the boundary locates it.',
    test: 'Run one cycle at the boundary value and record whether the queue recovers.',
  },
  causal_reversal: {
    hypothesis: 'The plateau causes the missing claims rather than the missing claims causing the plateau.',
    mechanism: 'Reversing the arrow predicts claims stop BEFORE lengths rise, not after.',
    test: 'Order the two event streams by timestamp and check which one leads.',
  },
  contradiction_preservation: {
    hypothesis: 'The starvation and the artefact explanations are both true, at different timescales.',
    mechanism: 'Holding both predicts a crossover point that either explanation alone forbids.',
    test: 'Look for a crossover in the residual series and estimate where it falls.',
  },
  tool_invention: {
    hypothesis: 'A one-line drain counter settles the argument within a single cycle.',
    mechanism: 'Instrumentation converts an unmeasurable quantity into a countable row.',
    test: 'Add the counter and read it after one cycle.',
  },
  random_semantic_bridge: {
    hypothesis: 'The plateau and the nightly compaction are two views of one rewrite storm.',
    mechanism: 'The bridged mechanism predicts that suppressing rewrites flattens both curves at once.',
    test: 'Suppress one rewrite pass and compare the two curves.',
  },
  counterfactual_world: {
    hypothesis: 'Had the trigger been manual from the start, no plateau would have been recorded at all.',
    mechanism: 'The counterfactual isolates the trigger as the only difference between the two worlds.',
    test: 'Replay the last five cycles with the manual path forced and diff the plateau markers.',
  },
};

/**
 * The default imagination stub: one seed per requested operator, each with the
 * operator's own descriptor tuple, an evidence ref the prompt really offered,
 * and its own claim (see `OPERATOR_TEXT`).
 */
function seedForOperator(operator: string, signalId: string, index: number, overrides: Record<string, unknown> = {}) {
  const text = OPERATOR_TEXT[operator] ?? OPERATOR_TEXT.causal_reversal;
  return {
    operator,
    hypothesis: text.hypothesis,
    mechanism: text.mechanism,
    descriptor_bins: OPERATOR_BINS[operator] ?? OPERATOR_BINS.causal_reversal,
    evidence_refs: [signalId],
    novelty: 0.8,
    coherence: 0.7,
    testability: 0.6,
    expected_information_gain: 0.5,
    cheapest_test: text.test,
    parent_seed_ids: [],
    ...overrides,
  };
}

/** The bridge fields a bridge operator must state, taken from the prompt. */
function bridgeFields(prompt: string, operator: string, seed: Record<string, unknown>): Record<string, unknown> {
  if (operator !== 'distant_analogy' && operator !== 'random_semantic_bridge') return seed;
  const path = [...prompt.matchAll(/^- (bridge_[0-9a-f]+) \(\d+ hops\): (.+)$/gm)].map((match) => match[2].split(' → '))[0];
  return {
    ...seed,
    bridge_path: path ?? ['unknown'],
    bridge: `Both ends are queues that starve the same way (${(path ?? ['unknown']).join(' → ')}).`,
  };
}

function imaginationOutput(prompt: string): Record<string, unknown> {
  const signalId = offeredSignalIds(prompt)[0] ?? '';
  return {
    seeds: requestedOperators(prompt).map((operator, index) =>
      bridgeFields(prompt, operator, seedForOperator(operator, signalId, index)),
    ),
  };
}

/** The ITER-5 focused-consolidation stub: one signal per kind. */
function focusedOutput(prompt: string): Record<string, unknown> {
  const missionId = prompt.match(/^- id: (\S+)/m)?.[1] ?? MISSION;
  const entryIds = [...prompt.matchAll(/^- (ent_[A-Za-z0-9_-]+) \[/gm)].map((match) => match[1]);
  const kinds: Array<[string, string]> = [
    ['attraction', 'The mission is drawn toward the queue-starving hypothesis and wants to test it.'],
    ['tension', 'The accepted decision and the contradicting evidence pull in opposite directions.'],
    ['surprise', 'The trigger fired earlier than the model of the plateau predicted.'],
    ['absence', 'Nobody has measured the drain that the queue is starving behind.'],
    ['persistent_pull', 'Every cycle returns to the same unresolved plateau question.'],
    ['question', 'What would have to be true for the plateau to be an artefact of the measurement?'],
  ];
  return {
    signals: kinds.map(([kind, statement], index) => ({
      kind,
      statement,
      why_operationally_relevant: `It changes which next action the mission should take (${kind}).`,
      intensity: 0.8,
      confidence: index === 3 ? 0.15 : 0.7,
      valence: index === 1 ? -0.4 : 0.3,
      evidence_refs: [entryIds[index % Math.max(1, entryIds.length)] ?? missionId],
    })),
  };
}

// ── The fixture ─────────────────────────────────────────────────────────────

interface Fixture {
  missionId: string;
  rejectedEntryId: string;
  traceId: string;
}

/**
 * The frozen fixture: a mission with a rejected hypothesis (an exclusion), a
 * live hypothesis, an uncertainty, a decision, a work item, a small knowledge
 * graph, and a REAL salience trace produced by the ITER-5 service.
 */
async function seedFixture(options: { graph?: boolean } = {}): Promise<Fixture> {
  const forged = db.asDb();
  const missions = new MissionStateService(forged);
  const deltas = new StateDeltaService(forged);

  await missions.createMissionState({
    schema_version: '1.0',
    mission_id: MISSION,
    title: 'Prove the imagination invariants',
    intent: 'Turn a salience trace into a diverse, reproducible portfolio of testable seeds.',
    status: 'active',
    owner_id: OWNER.user_id,
    success_criteria: [
      { id: 'c1', description: 'the portfolio is reproducible', status: 'unmet' },
      { id: 'c2', description: 'the archive rejects paraphrases', status: 'unmet' },
    ],
    stop_conditions: ['any shared write'],
    constraints: [{ id: 'k1', kind: 'privacy', description: 'never write a shared scope' }],
    authority_class: 'B',
    objectives: [{ id: 'o1', description: 'plan the operators from the trace', status: 'in_progress', owner_id: OWNER.user_id }],
  } as never);

  const first = await deltas.submitDelta(
    {
      schema_version: '1.0',
      idempotency_key: 'imagination_fixture_0001',
      mission_id: MISSION,
      base_mission_version: 1,
      author_id: OWNER.user_id,
      delta_type: 'HYPOTHESIS_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'h1' }],
      rationale: 'record the working hypothesis',
      confidence: 0.7,
      ledger_entries: [
        {
          schema_version: '1.0',
          mission_id: MISSION,
          entry_type: 'hypothesis',
          status: 'active',
          author_id: OWNER.user_id,
          confidence: 0.7,
          statement: 'The queue starves because the plateau trigger never fires.',
          consequence_if_false: 'high',
        } as never,
      ],
    },
    { actorId: OWNER.user_id },
  );

  const second = await deltas.submitDelta(
    {
      schema_version: '1.0',
      idempotency_key: 'imagination_fixture_0002',
      mission_id: MISSION,
      base_mission_version: 2,
      author_id: OWNER.user_id,
      delta_type: 'HYPOTHESIS_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'h2' }],
      rationale: 'record the hypothesis that was ruled out',
      confidence: 0.3,
      ledger_entries: [
        {
          schema_version: '1.0',
          mission_id: MISSION,
          entry_type: 'hypothesis',
          status: 'rejected',
          author_id: OWNER.user_id,
          confidence: 0.2,
          statement: 'The plateau is caused by the nightly compaction job.',
          consequence_if_false: 'moderate',
        } as never,
        {
          schema_version: '1.0',
          mission_id: MISSION,
          entry_type: 'uncertainty',
          status: 'active',
          author_id: OWNER.user_id,
          confidence: 0.4,
          statement: 'Whether the drain can be measured without a new instrument.',
          consequence_if_false: 'high',
        } as never,
        {
          schema_version: '1.0',
          mission_id: MISSION,
          entry_type: 'decision',
          status: 'accepted',
          author_id: OWNER.user_id,
          confidence: 0.6,
          statement: 'Keep the manual trigger until the drain is measured.',
          consequence_if_false: 'high',
        } as never,
      ],
    },
    { actorId: OWNER.user_id },
  );

  const third = await deltas.submitDelta(
    {
      schema_version: '1.0',
      idempotency_key: 'imagination_fixture_0003',
      mission_id: MISSION,
      base_mission_version: 3,
      author_id: OWNER.user_id,
      delta_type: 'EVIDENCE_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'e1' }],
      rationale: 'record the contradicting observation',
      confidence: 0.8,
      ledger_entries: [
        {
          schema_version: '1.0',
          mission_id: MISSION,
          entry_type: 'evidence',
          status: 'accepted',
          author_id: OWNER.user_id,
          confidence: 0.8,
          statement: 'Two cycles in a row closed with no new claim.',
        } as never,
      ],
    },
    { actorId: OWNER.user_id },
  );

  db.collection('cognitive_work_items').docs.push({
    schema_version: '1.0',
    work_item_id: 'wi_imagination_1',
    mission_id: MISSION,
    description: 'Measure the drain the queue is starving behind.',
    mode: 'monitor',
    status: 'queued',
    authority_class: 'B',
    features: {},
    created_at: new Date('2026-09-20T00:00:00.000Z').toISOString(),
    updated_at: new Date('2026-09-20T00:00:00.000Z').toISOString(),
  });

  if (options.graph !== false) {
    // A small graph: two chains with a low-degree bridge between them, so the
    // walk has somewhere to go and can prove it returns a path.
    const nodes = [
      { id: 'node_a', properties: { name: 'Queue health' } },
      { id: 'node_b', properties: { name: 'Drain measurement' } },
      { id: 'node_c', properties: { name: 'Plateau detector' } },
      { id: 'node_d', properties: { name: 'Nightly compaction' } },
    ];
    for (const node of nodes) {
      db.collection('knowledge_nodes').docs.push({ ...node, user_id: OWNER.user_id, node_type: 'concept' });
    }
    const edges = [
      { id: 'edge_ab', from_id: 'node_a', to_id: 'node_b' },
      { id: 'edge_bc', from_id: 'node_b', to_id: 'node_c' },
      { id: 'edge_cd', from_id: 'node_c', to_id: 'node_d' },
      { id: 'edge_da', from_id: 'node_d', to_id: 'node_a' },
    ];
    for (const edge of edges) {
      db.collection('knowledge_relationships').docs.push({
        ...edge,
        user_id: OWNER.user_id,
        relationship_type: 'relates',
        strength: 1,
      });
    }
  }

  // The REAL ITER-5 trace, produced through the ITER-5 service.
  const focused = await runFocusedConsolidation(forged, {
    userId: OWNER.user_id,
    missionId: MISSION,
    cycleId: 'fixture_trace_cycle',
    actorId: OWNER.user_id,
  });
  if (focused.status !== 'completed') {
    throw new Error(`fixture trace failed: ${focused.error ?? 'unknown'}`);
  }

  const rejectedEntryId = second.ledger_entries?.find((entry) => entry.status === 'rejected')?.entry_id ?? '';
  void first;
  void third;
  return { missionId: MISSION, rejectedEntryId, traceId: focused.trace_id! };
}

async function loadFixtureForGeneration(fixture: Fixture): Promise<{
  trace: Awaited<ReturnType<FocusedConsolidationService['getTraces']>>[number];
  inventory: ImaginationInventory;
  exclusions: ExclusionRegion[];
}> {
  const forged = db.asDb();
  const traces = await new FocusedConsolidationService(forged).getTraces(OWNER.user_id, {
    missionId: fixture.missionId,
    limit: 1,
  });
  const trace = traces[0];
  const inputs = await buildImaginationInputs(
    forged,
    (await new MissionStateService(forged).getMissionState(fixture.missionId))!,
    trace,
  );
  return { trace, inventory: inputs.inventory, exclusions: inputs.exclusions };
}

beforeEach(() => {
  db = new FakeDb();
  holder.db = db;
  prompts.length = 0;
  respond = async (system, prompt) =>
    system.includes('focused-consolidation faculty') ? focusedOutput(prompt) : imaginationOutput(prompt);
  extractJson = vi.spyOn(llmService, 'extractJson').mockImplementation((async (
    system: string,
    prompt: string,
    maxTokens: number,
  ) => {
    prompts.push(prompt);
    return respond(system, prompt, maxTokens);
  }) as never);
  serviceStatus = vi
    .spyOn(llmService, 'getServiceStatus')
    .mockReturnValue({ available: true, provider: 'stub', model: 'test-model', providers: ['stub(ready)'] });
});

afterEach(() => {
  extractJson.mockRestore();
  serviceStatus.mockRestore();
  delete process.env.FOCUSED_IMAGINATION;
  for (const key of [
    'FOCUSED_IMAGINATION_MAX_SEEDS',
    'FOCUSED_IMAGINATION_MAX_OPERATORS',
    'FOCUSED_IMAGINATION_MAX_LLM_CALLS',
    'FOCUSED_IMAGINATION_MAX_TOKENS',
    'FOCUSED_IMAGINATION_TIMEOUT_MS',
  ]) {
    delete process.env[key];
  }
  vi.useRealTimers();
});

// ── A. the run ──────────────────────────────────────────────────────────────

describe('imagination engine — a full cycle over the frozen fixture', () => {
  it('produces schema-valid, evidence-linked seeds and admits them into cells', async () => {
    const fixture = await seedFixture();
    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-one',
      actorId: OWNER.user_id,
      seed: 'cycle-one-seed',
    });

    expect(result.status).toBe('completed');
    expect(result.reused).toBe(false);
    expect(result.seeds_generated).toBeGreaterThanOrEqual(3);
    expect(result.seeds_admitted).toBe(result.seeds_generated);
    expect(result.new_cells).toBe(result.seeds_generated);
    expect(result.cells_total).toBe(result.seeds_generated);

    // Every stored seed satisfies the registered schema…
    for (const seed of db.collection(SEEDS).docs as Array<Record<string, unknown>>) {
      const check = validateAgainst(SCHEMA_IDS.ideaSeed, seed);
      expect(check.errors).toEqual([]);
      expect(check.valid).toBe(true);
      // …and cites evidence that really resolves to the trace or the mission.
      expect(seed.evidence_refs.length).toBeGreaterThan(0);
      expect(seed.cheapest_test).toBeTruthy();
      expect(seed.quality).toBeCloseTo(
        qualityOf({
          novelty_score: seed.novelty_score as number,
          coherence_score: seed.coherence_score as number,
          testability_score: seed.testability_score as number,
          expected_information_gain: seed.expected_information_gain as number,
        }),
        6,
      );
    }

    // The seeds cite the trace's DERIVED signal ids — never an invented ref.
    const traceId = fixture.traceId;
    const validSignalIds = new Set(
      (db.collection('salience_traces').docs[0].signals as Array<unknown>).map((_signal, index) =>
        traceSignalId(traceId, index),
      ),
    );
    for (const seed of result.seeds) {
      expect(seed.evidence_refs.some((ref) => validSignalIds.has(ref))).toBe(true);
    }

    // The run ledger records the effective budget and planned vs actual.
    expect(result.run.budget.max_seeds).toBe(DEFAULT_MAX_SEEDS);
    expect(result.operators_planned).toBeLessThanOrEqual(DEFAULT_MAX_OPERATORS);
    expect(result.operators_run).toBeGreaterThan(0);
    expect(result.llm_calls_planned).toBeLessThanOrEqual(DEFAULT_MAX_LLM_CALLS);
    expect(result.llm_calls_actual).toBeLessThanOrEqual(DEFAULT_MAX_LLM_CALLS);
    expect(result.run.llm_calls_actual).toBe(llmCalls() - 1); // the fixture's own trace call
    expect(result.portfolio_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('replays the same cycle instead of calling the model twice', async () => {
    const fixture = await seedFixture();
    const first = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-replay',
      actorId: OWNER.user_id,
      seed: 'replay-seed',
    });
    const seedsBefore = db.collection(SEEDS).docs.length;
    const callsBefore = llmCalls();

    const second = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-replay',
      actorId: OWNER.user_id,
      seed: 'replay-seed',
    });

    expect(second.status).toBe('completed');
    expect(second.reused).toBe(true);
    expect(second.portfolio_digest).toBe(first.portfolio_digest);
    expect(second.seeds.map((seed) => seed.seed_id)).toEqual(first.seeds.map((seed) => seed.seed_id));
    expect(llmCalls()).toBe(callsBefore);
    expect(db.collection(SEEDS).docs.length).toBe(seedsBefore);
    expect(db.collection(RUNS).docs).toHaveLength(1);
  });

  it('does not run at all when there is no salience trace to read', async () => {
    await seedFixture({ graph: true });
    db.collection('salience_traces').docs.length = 0;
    await expect(
      runImaginationCycle(db.asDb(), {
        userId: OTHER.user_id,
        missionId: MISSION,
        cycleId: 'cycle-no-trace',
        actorId: OTHER.user_id,
        seed: 'x',
      }),
    ).rejects.toThrow(/no salience trace/i);
    expect(db.collection(RUNS).docs).toHaveLength(0);
  });
});

// ── B. determinism ──────────────────────────────────────────────────────────

describe('imagination engine — reproducibility', () => {
  it('is byte-identical for the same seed and inputs, across an advanced clock', async () => {
    const fixture = await seedFixture();
    const { trace, inventory, exclusions } = await loadFixtureForGeneration(fixture);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    const first = await generateImaginationSeeds(db.asDb(), {
      trace,
      inventory,
      exclusions,
      seed: 'determinism-seed',
    });

    vi.setSystemTime(new Date('2027-03-01T12:34:56.000Z'));
    const second = await generateImaginationSeeds(db.asDb(), {
      trace,
      inventory,
      exclusions,
      seed: 'determinism-seed',
    });

    // The payload has no TIME in it at all: no seed carries a time-derived
    // key, and stripping the plan is a no-op…
    for (const seed of first.seeds) {
      for (const key of Object.keys(seed)) expect(TIME_DERIVED_KEY.test(key), `${seed.seed_id}.${key}`).toBe(false);
    }
    expect(stripVolatile(first.plan)).toEqual(first.plan);
    // …and the two runs are identical byte for byte.
    expect(JSON.stringify(second.seeds)).toBe(JSON.stringify(first.seeds));
    expect(JSON.stringify(second.plan)).toBe(JSON.stringify(first.plan));
    expect(second.seeds.map((seed) => seed.seed_id)).toEqual(first.seeds.map((seed) => seed.seed_id));
    expect(portfolioDigest(second)).toBe(portfolioDigest(first));
  });

  it('produces a different (but still schema-valid) portfolio for a different seed', async () => {
    const fixture = await seedFixture();
    const { trace, inventory, exclusions } = await loadFixtureForGeneration(fixture);
    const first = await generateImaginationSeeds(db.asDb(), { trace, inventory, exclusions, seed: 'seed-alpha' });
    const second = await generateImaginationSeeds(db.asDb(), { trace, inventory, exclusions, seed: 'seed-beta' });

    expect(second.seeds.map((seed) => seed.seed_id)).not.toEqual(first.seeds.map((seed) => seed.seed_id));
    expect(portfolioDigest(second)).not.toBe(portfolioDigest(first));
    expect(first.seeds.length).toBeGreaterThan(0);

    // Both are schema-valid once admitted: the schema is validated BEFORE the
    // store, so a seed that could not satisfy it is never written.
    const archive = new IdeaArchiveService(db.asDb(), { exclusions });
    const storedRows: Array<Record<string, unknown>> = [];
    for (const seed of [first.seeds[0], second.seeds[0]]) {
      const admission = await archive.admitOrReplace(seed, { exclusions });
      expect(['admitted', 'replaced', 'below_incumbent', 'rejected']).toContain(admission.decision);
      expect(admission.rejection?.reason).not.toBe('schema_invalid');
      if (admission.seed) storedRows.push(admission.seed as unknown as Record<string, unknown>);
    }
    expect(storedRows.length).toBeGreaterThan(0);
    for (const row of storedRows) expect(validateAgainst(SCHEMA_IDS.ideaSeed, row).valid).toBe(true);
  });

  it('a full run is byte-identical when the archive starts from the same state', async () => {
    const fixture = await seedFixture();
    const options = {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-determinism',
      actorId: OWNER.user_id,
      seed: 'run-seed',
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    const first = await runImaginationCycle(db.asDb(), options);

    // Reset the feature's own collections — the archive is an INPUT to a run,
    // so holding it constant is what makes the two runs comparable.
    for (const name of ALL_IMAGINATION_COLLECTIONS) db.collection(name).docs.length = 0;
    vi.setSystemTime(new Date('2026-12-24T23:59:59.000Z'));
    const second = await runImaginationCycle(db.asDb(), options);

    const payload = (result: typeof first) => ({
      digest: result.portfolio_digest,
      seeds: stripVolatile(result.seeds),
      rejections: result.rejections,
      plan: result.operator_plan,
      coverage: stripVolatile(result.coverage),
    });
    expect(JSON.stringify(payload(second))).toBe(JSON.stringify(payload(first)));
    expect(second.seeds_generated).toBe(first.seeds_generated);
    expect(second.new_cells).toBe(first.new_cells);
  });
});

// ── C. operators ────────────────────────────────────────────────────────────

describe('imagination operators — the plan', () => {
  it('implements all ten families, each with a required output shape', () => {
    expect(OPERATOR_FAMILIES).toHaveLength(10);
    for (const family of OPERATOR_FAMILIES) {
      const spec = OPERATOR_SPECS[family];
      expect(spec.intent.length).toBeGreaterThan(10);
      expect(spec.required_output).toContain('hypothesis');
      expect(spec.required_output).toContain('mechanism');
      expect(spec.required_output).toContain('cheapest_test');
      expect(spec.required_output).toContain('evidence_refs');
      if (family === 'distant_analogy' || family === 'random_semantic_bridge') {
        expect(spec.required_output).toContain('bridge_path');
        expect(spec.required_output).toContain('bridge');
      }
    }
    // Every family is reachable from some trace kind — the documented mapping.
    const reachable = new Set(Object.values(OPERATOR_TRACE_MAP).flat());
    for (const family of OPERATOR_FAMILIES) expect(reachable).toContain(family);
  });

  it('is trace-driven: the kinds present decide the families that run', () => {
    const signals = (kinds: Array<[string, number]>) =>
      kinds.map(([kind, intensity], index) => ({
        signal_id: `sig_${index}`,
        kind: kind as never,
        intensity,
        confidence: 0.7,
      }));
    const triggered = (kind: string) =>
      planOperators(signals([[kind, 0.9]]), new SeededRandom('tie'), { maxOperators: 10 })
        .filter((entry) => entry.reason === 'trace_triggered')
        .map((entry) => entry.operator)
        .sort();

    // The documented mapping, read back out of the plan itself: a trace with
    // ONE kind triggers exactly the families that kind maps to. The seeded
    // tie-break decides their ORDER, never their membership.
    for (const kind of Object.keys(OPERATOR_TRACE_MAP) as Array<keyof typeof OPERATOR_TRACE_MAP>) {
      expect(triggered(kind), `kind ${kind}`).toEqual([...OPERATOR_TRACE_MAP[kind]].sort());
    }

    const absencePlan = planOperators(signals([['absence', 0.9]]), new SeededRandom('tie'), { maxOperators: 3 });
    expect(absencePlan.map((entry) => entry.operator).sort()).toEqual(
      [...OPERATOR_TRACE_MAP.absence].sort(),
    );
    expect(absencePlan.every((entry) => entry.triggered_by.length === 1)).toBe(true);
    expect(absencePlan[0].triggered_by).toEqual(['sig_0']);

    // A different trace yields a different plan — this is what "trace-driven"
    // means: it is NOT a fixed list of operators.
    const surprisePlan = planOperators(signals([['surprise', 0.9]]), new SeededRandom('tie'), { maxOperators: 3 });
    expect(surprisePlan.map((entry) => entry.operator).sort()).not.toEqual(
      absencePlan.map((entry) => entry.operator).sort(),
    );

    // Intensity decides the ORDER: the strongest kind's families come first.
    const mixed = planOperators(
      signals([
        ['tension', 0.1],
        ['surprise', 0.9],
      ]),
      new SeededRandom('tie'),
      { maxOperators: 10 },
    );
    expect(mixed.slice(0, 3).map((entry) => entry.operator).sort()).toEqual(
      [...OPERATOR_TRACE_MAP.surprise].sort(),
    );
  });

  it('is deterministic: same signals + same seed → the same plan, seed changes the tie-breaks', () => {
    const signals = [
      { signal_id: 'sig_0', kind: 'tension' as const, intensity: 0.5, confidence: 0.5 },
      { signal_id: 'sig_1', kind: 'surprise' as const, intensity: 0.5, confidence: 0.5 },
      { signal_id: 'sig_2', kind: 'absence' as const, intensity: 0.5, confidence: 0.5 },
    ];
    const one = planOperators(signals, new SeededRandom('same'), { maxOperators: 6 });
    const two = planOperators(signals, new SeededRandom('same'), { maxOperators: 6 });
    const three = planOperators(signals, new SeededRandom('different'), { maxOperators: 6 });

    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(three.map((entry) => entry.operator)).not.toEqual(one.map((entry) => entry.operator));
    // …and a plan never exceeds the budget it was given.
    expect(planOperators(signals, new SeededRandom('same'), { maxOperators: 2 })).toHaveLength(2);
  });

  it('honours the run mode and records the disposition without treating it as evidence', async () => {
    const fixture = await seedFixture();
    const { trace, inventory, exclusions } = await loadFixtureForGeneration(fixture);
    const balanced = await generateImaginationSeeds(db.asDb(), { trace, inventory, exclusions, seed: 'mode-seed' });
    const explore = await generateImaginationSeeds(db.asDb(), {
      trace,
      inventory,
      exclusions,
      seed: 'mode-seed',
      mode: 'explore',
    });

    // Explore spreads the plan across families instead of following the score
    // order — a different plan, with the reason recorded per operator.
    expect(explore.plan.map((entry) => entry.operator)).not.toEqual(balanced.plan.map((entry) => entry.operator));
    expect(explore.plan.some((entry) => entry.reason === 'mode_explore' || entry.reason === 'seeded_fill')).toBe(true);
    // …and it is still deterministic for the same seed.
    const again = await generateImaginationSeeds(db.asDb(), {
      trace,
      inventory,
      exclusions,
      seed: 'mode-seed',
      mode: 'explore',
    });
    expect(JSON.stringify(again.plan)).toBe(JSON.stringify(explore.plan));

    // The disposition is recorded on the run, and it never becomes evidence.
    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-disposition',
      actorId: OWNER.user_id,
      seed: 'disposition-seed',
      disposition: 'hypothesis-first',
      budget: { max_llm_calls: 1 },
    });
    expect(result.run.disposition).toBe('hypothesis-first');
    for (const seed of result.seeds) {
      expect(seed.evidence_refs).not.toContain('hypothesis-first');
    }
  });

  it('records why each operator ran, and never invents a trace signal id', async () => {
    const fixture = await seedFixture();
    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-plan',
      actorId: OWNER.user_id,
      seed: 'plan-seed',
    });
    expect(result.operator_plan.length).toBeGreaterThan(0);
    const signalIds = new Set(
      (db.collection('salience_traces').docs[0].signals as Array<unknown>).map((_s, index) =>
        traceSignalId(fixture.traceId, index),
      ),
    );
    for (const entry of result.operator_plan) {
      expect(entry.reason).toBeTruthy();
      for (const id of entry.triggered_by) expect(signalIds).toContain(id);
      for (const kind of entry.signal_kinds) expect(OPERATOR_TRACE_MAP).toHaveProperty(kind);
    }
  });

  it('skips a bridge operator (and says so) when the graph has no bridges', async () => {
    const fixture = await seedFixture({ graph: false });
    const { trace, inventory, exclusions } = await loadFixtureForGeneration(fixture);
    const generated = await generateImaginationSeeds(db.asDb(), {
      trace,
      inventory,
      exclusions,
      seed: 'no-graph',
      budget: { max_operators: 10 },
    });
    const bridgeEntries = generated.plan.filter(
      (entry) => entry.operator === 'distant_analogy' || entry.operator === 'random_semantic_bridge',
    );
    for (const entry of bridgeEntries) {
      expect(entry.skipped).toBe(true);
      expect(entry.skip_reason).toBe('no_bridge_path');
    }
  });
});

// ── C2. the distant-association walk ────────────────────────────────────────

describe('imagination engine — the distant-association walk', () => {
  it('is seeded, bounded, cycle-safe and returns the path', async () => {
    const fixture = await seedFixture();
    void fixture;
    const one = await walkDistantAssociations(db.asDb(), { userId: OWNER.user_id, rng: new SeededRandom('walk') });
    const two = await walkDistantAssociations(db.asDb(), { userId: OWNER.user_id, rng: new SeededRandom('walk') });
    const three = await walkDistantAssociations(db.asDb(), { userId: OTHER.user_id, rng: new SeededRandom('walk') });

    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.paths.length).toBeGreaterThan(0);
    for (const path of one.paths) {
      expect(path.path.length).toBeGreaterThanOrEqual(2);
      expect(path.node_ids.length).toBe(path.path.length);
      expect(path.hops).toBeGreaterThanOrEqual(1);
      expect(path.hops).toBeLessThanOrEqual(one.depth_bound);
      // Cycle safety: no node appears twice on one path.
      expect(new Set(path.node_ids).size).toBe(path.node_ids.length);
      expect(path.bridge_id).toMatch(/^bridge_[0-9a-f]{32}$/);
    }
    expect(one.depth_bound).toBeGreaterThanOrEqual(2);
    expect(one.depth_bound).toBeLessThanOrEqual(3);
    // The walk is identity-scoped: another identity's graph is empty.
    expect(three.paths).toEqual([]);
    expect(three.nodes_scanned).toBe(0);
  });

  it('reports how many cycle-closing steps it refused, and tolerates both edge shapes', async () => {
    const fixture = await seedFixture();
    void fixture;
    // A `source`/`target`-shaped edge is still an edge.
    db.collection('knowledge_relationships').docs.push({
      user_id: OWNER.user_id,
      source: 'node_a',
      target: 'node_d',
      relationship_type: 'relates',
    });
    const walk = await walkDistantAssociations(db.asDb(), { userId: OWNER.user_id, rng: new SeededRandom('cycle') });
    expect(walk.edges_scanned).toBeGreaterThanOrEqual(4);
    expect(walk.cycles_avoided).toBeGreaterThanOrEqual(0);
    for (const path of walk.paths) {
      expect(new Set(path.node_ids).size).toBe(path.node_ids.length);
    }
  });
});

// ── D. diversity ────────────────────────────────────────────────────────────

describe('imagination engine — diversity and dedupe inside one cycle', () => {
  it('a 6-seed portfolio spans ≥3 descriptor dimensions and yields ≥3 new cells', async () => {
    const fixture = await seedFixture();
    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-diversity',
      actorId: OWNER.user_id,
      seed: 'diversity-seed',
      budget: { max_seeds: 6 },
    });

    expect(result.seeds_generated).toBe(6);
    expect(result.new_cells).toBeGreaterThanOrEqual(3);

    const coverage = result.coverage!;
    const dimensionsSpanned = coverage.descriptor_dimensions.filter(
      (dimension) => Object.keys(coverage.cells_by_dimension[dimension] ?? {}).length >= 2,
    );
    expect(dimensionsSpanned.length).toBeGreaterThanOrEqual(3);
    expect(coverage.cells_total).toBeGreaterThanOrEqual(3);
    // The cells really are distinct tuples.
    const cellKeys = new Set((db.collection(CELLS).docs as Array<{ cell_key: string }>).map((cell) => cell.cell_key));
    expect(cellKeys.size).toBe(db.collection(CELLS).docs.length);
  });

  it('collapses a near-duplicate pair generated in the same cycle', async () => {
    const fixture = await seedFixture();
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return focusedOutput(prompt);
      const signalId = offeredSignalIds(prompt)[0] ?? '';
      const operators = requestedOperators(prompt);
      const seeds: Array<Record<string, unknown>> = [];
      for (const [index, operator] of operators.entries()) {
        const seed = bridgeFields(prompt, operator, {
          ...seedForOperator(operator, signalId, index),
          descriptor_bins: OPERATOR_BINS[operator],
        });
        seeds.push(seed);
        if (index === 0) {
          // The same idea in neighbouring words, placed in a DIFFERENT cell so
          // it cannot be caught by cell identity alone. One word changes, so it
          // is a paraphrase and not an exact duplicate.
          const variantBins = { ...(seed.descriptor_bins as Record<string, string>) };
          variantBins.representation = variantBins.representation === 'prose' ? 'table' : 'prose';
          seeds.push({
            ...seed,
            hypothesis: seed.hypothesis.replace(/\bthe\b/, 'a'),
            descriptor_bins: variantBins,
          });
        }
      }
      return { seeds };
    };

    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-collapse',
      actorId: OWNER.user_id,
      seed: 'collapse-seed',
    });

    const paraphrase = result.rejections.filter((rejection) => rejection.reason === 'paraphrase_of');
    expect(paraphrase.length).toBeGreaterThanOrEqual(1);
    expect(paraphrase[0].duplicate_of).toBeTruthy();

    // The reason the archive gave is the reason the documented metric implies:
    // the pair really is a PARAPHRASE — above the threshold, short of identical
    // — and the rejected row carries it durably as an exclusion.
    const rows = db.collection(SEEDS).docs as Array<Record<string, unknown>>;
    const rejected = rows.find((row) => row.seed_id === paraphrase[0].seed_id)!;
    const incumbent = rows.find((row) => row.seed_id === paraphrase[0].duplicate_of)!;
    const similarity = seedSimilarity(rejected, incumbent);
    expect(similarity).toBeGreaterThanOrEqual(PARAPHRASE_THRESHOLD);
    // The pair is short of IDENTICAL — that is what makes it a paraphrase and
    // not a duplicate. With containment in the metric the score saturates at 1
    // whenever one statement's content sits inside the other's (which is the
    // point of the measurement), so exactness is read from the normalised text
    // and from the reason the archive recorded, never from the number.
    expect(normalizeStatement(String(rejected.hypothesis))).not.toBe(normalizeStatement(String(incumbent.hypothesis)));
    expect(similarity).toBeLessThanOrEqual(1);
    expect(rejected.state).toBe('rejected');
    expect((rejected.rejection as { reason: string }).reason).toBe('paraphrase_of');
    expect(incumbent.state).toBe('admitted');
    // The two live in different cells — so dedupe, not cell identity, caught it.
    expect(rejected.cell_key).not.toBe(incumbent.cell_key);
    // …and the rest of the portfolio survived.
    expect(result.seeds_generated).toBeGreaterThan(1);
    expect(result.seeds_admitted).toBe(result.seeds.length);
  });
});

// ── E. dedupe + exclusions ──────────────────────────────────────────────────

describe('imagination archive — dedupe, exclusions and reasons', () => {
  const seedInput = (overrides: Partial<IdeaSeedInput> & { seed_id: string }): IdeaSeedInput => ({
    user_id: OWNER.user_id,
    mission_id: MISSION,
    cycle_id: 'cycle-archive',
    prng_seed: 1,
    operator: 'assumption_inversion',
    hypothesis: 'The plateau is caused by the nightly compaction job.',
    mechanism: 'Compaction rewrites the queue head and hides the drain for one cycle.',
    evidence_refs: ['sig_x'],
    novelty_score: 0.5,
    coherence_score: 0.5,
    testability_score: 0.5,
    cheapest_test: 'Count the queue head rewrites in one nightly window.',
    expected_information_gain: 0.5,
    parent_seed_ids: [],
    lineage_ref: `lineage_${overrides.seed_id}`,
    ...overrides,
  });

  it('rejects an exact duplicate with duplicate_of', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    const first = seedInput({ seed_id: 'seed_exact_1' });
    const second = seedInput({ seed_id: 'seed_exact_2', lineage_ref: 'lineage_2', mechanism: first.mechanism });
    const admitted = await archive.admitOrReplace(first);
    expect(admitted.decision).toBe('admitted');

    const duplicate = await archive.admitOrReplace(second);
    expect(duplicate.decision).toBe('rejected');
    expect(duplicate.rejection?.reason).toBe('duplicate_of');
    expect(duplicate.rejection?.duplicate_of).toBe('seed_exact_1');
  });

  it('rejects a paraphrase (above the documented threshold) and admits a genuinely different idea', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    await archive.admitOrReplace(
      seedInput({
        seed_id: 'seed_base',
        hypothesis: 'The plateau is caused by the nightly compaction job that rewrites the queue head.',
        mechanism: 'Compaction rewrites the queue head and hides the drain for one cycle.',
      }),
    );
    const near = await archive.admitOrReplace(
      seedInput({
        seed_id: 'seed_near',
        lineage_ref: 'lineage_near',
        hypothesis: 'The plateau is caused by the nightly compaction job that rewrites the queue head!',
        mechanism: 'Compaction rewrites the queue head and hides the drain for one cycle.',
      }),
    );
    expect(near.decision).toBe('rejected');
    expect(near.rejection?.reason).toBe('duplicate_of');

    const paraphrased = await archive.admitOrReplace(
      seedInput({
        seed_id: 'seed_paraphrase',
        lineage_ref: 'lineage_paraphrase',
        hypothesis: 'The plateau is caused by the nightly compaction job rewriting the queue head.',
        mechanism: 'The compaction rewrites the queue head and hides the drain for one cycle.',
      }),
    );
    expect(paraphrased.decision).toBe('rejected');
    expect(['paraphrase_of', 'duplicate_of']).toContain(paraphrased.rejection?.reason);

    const different = await archive.admitOrReplace(
      seedInput({
        seed_id: 'seed_different',
        lineage_ref: 'lineage_different',
        hypothesis: 'A second worker drains the pipeline whenever the queue head is rewritten.',
        mechanism: 'Two writers race, and the loser silently drops its claim.',
        descriptor_bins: ['substitution', 'list', 'scarcity', 'work_queue', 'ab_test'],
      }),
    );
    expect(different.decision).toBe('admitted');
  });

  it('rejects a match against the mission exclusion list with excluded_region', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    const exclusions: ExclusionRegion[] = [
      {
        kind: 'rejected_hypothesis',
        text: 'The plateau is caused by the nightly compaction job.',
        ref: 'ent_rejected_1',
      },
    ];
    // The excluded idea comes back in the model's own words: a different
    // mechanism, the same claim — still an excluded region, and it says which
    // region it collided with.
    const result = await archive.admitOrReplace(
      seedInput({
        seed_id: 'seed_excluded',
        hypothesis: 'The plateau is caused by the nightly compaction job',
        mechanism: 'Whatever the timing, the rewrite is what hides the drain.',
      }),
      { exclusions },
    );
    expect(result.decision).toBe('rejected');
    expect(result.rejection?.reason).toBe('excluded_region');
    expect(result.rejection?.duplicate_of).toBe('ent_rejected_1');
    // A genuinely new claim is not swept up by the exclusion list.
    const fresh = await archive.admitOrReplace(
      seedInput({
        seed_id: 'seed_not_excluded',
        lineage_ref: 'lineage_not_excluded',
        hypothesis: 'Two writers race for the queue head and the loser drops its claim silently.',
        mechanism: 'The dropped claim is the missing drain.',
        descriptor_bins: ['substitution', 'list', 'scarcity', 'work_queue', 'ab_test'],
      }),
      { exclusions },
    );
    expect(fresh.decision).toBe('admitted');
  });

  it('is deterministic and documented: the similarity metric and its guards are explicit', () => {
    expect(PARAPHRASE_THRESHOLD).toBe(0.72);
    expect(LENGTH_GUARD_RATIO).toBe(0.5);
    // ITER-7 residual F1: ONE effective threshold. The containment branch fires
    // at the gate the archive compares against, so there is no band in which the
    // documented containment rule and the operative gate disagree.
    expect(CONTAINMENT_THRESHOLD).toBe(PARAPHRASE_THRESHOLD);
    expect(CONTAINMENT_THRESHOLD).toBe(0.72);
    expect(MIN_CONTAINMENT_OVERLAP).toBe(2);
    // Identical after normalisation.
    expect(statementSimilarity('The Queue, starves!', 'the queue starves')).toBe(1);
    // The 0.72 flip: a pair whose content is fully contained in the other is a
    // paraphrase whatever its length — one word swapped for a synonym leaves the
    // content set intact, and normalised equality is what says "exact", never
    // the score (which saturates at 1 for a contained pair).
    const flipBase = {
      hypothesis: 'The plateau is caused by the nightly compaction job that rewrites the queue head.',
      mechanism: 'Compaction rewrites the queue head and hides the drain for one cycle.',
    };
    const flipPara = {
      hypothesis: 'The plateau is caused by the nightly compaction job rewriting the queue head.',
      mechanism: 'The compaction rewrites the queue head and hides the drain for one cycle.',
    };
    expect(seedSimilarity(flipBase, flipPara)).toBeGreaterThanOrEqual(PARAPHRASE_THRESHOLD);
    expect(normalizeStatement(flipBase.hypothesis)).not.toBe(normalizeStatement(flipPara.hypothesis));
    // CONTAINMENT survives PADDING: 60 filler words drive Jaccard to zero (the
    // length guard bites), while every content token of the claim is still
    // there — so the pair is a paraphrase and the gate holds.
    const paddedFiller = `the queue starves ${'because '.repeat(60)}the drain is real`;
    expect(statementSimilarity('the queue starves', paddedFiller)).toBe(1);
    expect(containmentMeasure('the queue starves', paddedFiller).shared).toEqual(['queue', 'starves']);
    expect(statementContainment('the queue starves', paddedFiller)).toBe(1);
    // …and the length guard still refuses to compare a haiku with a paragraph
    // whose CONTENT is genuinely different: containment is low, so "not
    // comparable" is the honest answer and no content is shared by accident.
    expect(
      statementSimilarity('the queue starves', `the archive compacts silently ${'and the ledger stays unchanged '.repeat(20)}`),
    ).toBe(0);
    expect(statementContainment('the queue starves', `the archive compacts silently ${'and the ledger stays unchanged '.repeat(20)}`)).toBe(0);
    // Below the threshold is NOT a duplicate.
    expect(seedSimilarity({ hypothesis: 'alpha beta gamma' }, { hypothesis: 'delta epsilon zeta' })).toBe(0);
    expect(normalizeStatement('  Mixed   CASE!!  ')).toBe('mixed case');
    // The stoplist keeps function words out of the content measurement.
    expect([...contentTokens('the queue starves because the drain')].sort()).toEqual(['drain', 'queue', 'starves']);
    // Quality is the documented fixed-weight mean.
    expect(QUALITY_WEIGHTS.novelty + QUALITY_WEIGHTS.coherence + QUALITY_WEIGHTS.testability + QUALITY_WEIGHTS.information_gain).toBeCloseTo(1, 9);
    expect(
      qualityOf({ novelty_score: 1, coherence_score: 1, testability_score: 1, expected_information_gain: 1 }),
    ).toBe(1);
  });

  it('routes the ledger rejection and the low-confidence trace signal into the run exclusions', async () => {
    const fixture = await seedFixture();
    const { exclusions } = await loadFixtureForGeneration(fixture);
    expect(exclusions.some((region) => region.kind === 'rejected_hypothesis')).toBe(true);
    expect(exclusions.some((region) => region.ref === fixture.rejectedEntryId)).toBe(true);
    // The ITER-5 fixture marks one signal low-confidence: an excluded region.
    expect(exclusions.some((region) => region.kind === 'excluded_region')).toBe(true);
  });
});

// ── F. changed-premise re-entry ─────────────────────────────────────────────

describe('imagination archive — changed-premise re-entry', () => {
  const baseSeed: IdeaSeedInput = {
    seed_id: 'seed_reentry',
    user_id: OWNER.user_id,
    mission_id: MISSION,
    cycle_id: 'cycle-reentry',
    prng_seed: 7,
    operator: 'assumption_inversion',
    hypothesis: 'The plateau is caused by the nightly compaction job.',
    mechanism: 'Compaction rewrites the queue head and hides the drain for one cycle.',
    evidence_refs: ['sig_x'],
    novelty_score: 0.6,
    coherence_score: 0.6,
    testability_score: 0.6,
    cheapest_test: 'Count the rewrites.',
    expected_information_gain: 0.4,
    parent_seed_ids: [],
    lineage_ref: 'lineage_reentry',
  };
  const exclusions: ExclusionRegion[] = [
    {
      kind: 'excluded_region',
      text: 'The plateau is caused by the nightly compaction job.',
      ref: 'ent_excluded',
    },
  ];
  const premise = 'The compaction window moved to the afternoon, so it no longer overlaps the plateau.';

  it('requires a complete premise (a fragment is refused)', () => {
    expect(isCompletePremise(premise)).toBe(true);
    expect(isCompletePremise('changed')).toBe(false);
    expect(isCompletePremise('it moved.')).toBe(false); // too short to be a sentence
    expect(isCompletePremise('   ')).toBe(false);
  });

  it('rejects a re-entry with no changed premise at all', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    const result = await archive.admitOrReplace({ ...baseSeed }, { exclusions });
    expect(result.decision).toBe('rejected');
    expect(result.rejection?.reason).toBe('excluded_region');
    expect(result.rejection?.detail).toMatch(/no changed_premise/);
    expect(db.collection(SEEDS).docs[0].state).toBe('rejected');
  });

  it('rejects a premise without a lineage link, then accepts it with one', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    const unlinked = await archive.admitOrReplace(
      { ...baseSeed, changed_premise: premise },
      { exclusions, premise },
    );
    expect(unlinked.decision).toBe('rejected');
    expect(unlinked.rejection?.reason).toBe('missing_lineage_link');
    expect(unlinked.rejection?.detail).toMatch(/ent_excluded/);

    const linked = await archive.changedPremiseReentry(
      { ...baseSeed, seed_id: 'seed_reentry_linked', lineage_ref: 'lineage_reentry_linked', parent_seed_ids: ['ent_excluded'] },
      premise,
      { exclusions },
    );
    expect(linked.decision).toBe('admitted');
    expect(linked.reentry).toEqual({ prior_rejection_id: 'ent_excluded', premise });
    expect(linked.seed?.changed_premise).toBe(premise);
    expect(linked.history?.event).toBe('changed_premise_reentry');
    expect(linked.history?.premise).toBe(premise);

    // The re-entry is recorded in the CELL's history, where it is durable.
    const cell = db.collection(CELLS).docs[0] as unknown as { history: Array<{ event: string }> };
    expect(cell.history.map((entry) => entry.event)).toContain('changed_premise_reentry');
    // …and the lineage row carries the premise too.
    const lineage = db.collection(LINEAGES).docs.find(
      (row) => (row as { seed_id: string }).seed_id === 'seed_reentry_linked',
    ) as unknown as { changed_premise?: string; parent_seed_ids: string[] };

    expect(lineage.changed_premise).toBe(premise);
    expect(lineage.parent_seed_ids).toContain('ent_excluded');
  });

  it('rejects a short premise as an incomplete sentence', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    const result = await archive.admitOrReplace(
      { ...baseSeed, changed_premise: 'the window moved', parent_seed_ids: ['ent_excluded'] },
      { exclusions, premise: 'the window moved' },
    );
    expect(result.decision).toBe('rejected');
    expect(result.rejection?.reason).toBe('missing_changed_premise');
  });

  it('gates re-entry end to end through a run: the bare idea is rejected, the changed-premise one is admitted', async () => {
    const fixture = await seedFixture();
    // The stub proposes the idea the mission already ruled out (the ledger's
    // rejected hypothesis) twice: bare, and then with a stated changed premise
    // plus a lineage link to the excluded region the prompt printed. The bare
    // one is weighted to rank FIRST, which is what makes the two decisions
    // comparable: the gate, not the order, is what changes the outcome.
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return focusedOutput(prompt);
      const signalId = offeredSignalIds(prompt)[0] ?? '';
      const excludedRef = [...prompt.matchAll(/^- \[([A-Za-z0-9_.:-]+)\] \((rejected_hypothesis|excluded_region)\)/gm)].map(
        (match) => match[1],
      )[0];
      const operators = requestedOperators(prompt);
      const operational = (operator: string, index: number, scores: Record<string, number> = {}) =>
        bridgeFields(prompt, operator, {
          ...seedForOperator(operator, signalId, index),
          descriptor_bins: OPERATOR_BINS[operator],
          ...scores,
        });
      if (operators.length > 0 && excludedRef) {
        const bare = {
          ...operational(operators[0], 0, {
            novelty: 0.9,
            coherence: 0.9,
            testability: 0.9,
            expected_information_gain: 0.9,
          }),
          hypothesis: 'The plateau is caused by the nightly compaction job.',
          mechanism: 'Compaction rewrites the queue head and hides the drain for one cycle, whatever the timing.',
        };
        return {
          seeds: [
            bare,
            {
              ...operational(operators[0], 1),
              hypothesis: bare.hypothesis,
              mechanism: bare.mechanism,
              changed_premise:
                'The compaction window moved to the afternoon, so it no longer overlaps the plateau window.',
              parent_seed_ids: [excludedRef],
            },
          ],
        };
      }
      return { seeds: operators.map((operator, index) => operational(operator, index)) };
    };

    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-reentry-run',
      actorId: OWNER.user_id,
      seed: 'reentry-seed',
      budget: { max_llm_calls: 1 },
    });

    expect(result.status).toBe('completed');
    expect(result.seeds_generated).toBe(2);

    // WITHOUT a changed premise the excluded idea stays out — and the reason
    // names the region it collided with (the mission's own rejected hypothesis,
    // whose id the prompt printed for exactly this purpose).
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].reason).toBe('excluded_region');
    expect(result.rejections[0].duplicate_of).toBe(fixture.rejectedEntryId);
    const rejectedRow = (db.collection(SEEDS).docs as Array<Record<string, unknown>>).find(
      (row) => row.seed_id === result.rejections[0].seed_id,
    )!;
    expect(rejectedRow.state).toBe('rejected');
    expect(rejectedRow.changed_premise).toBeUndefined();

    // WITH the premise AND the lineage link it comes back — and the re-entry is
    // recorded on the seed, in its lineage and in the cell's history.
    expect(result.seeds).toHaveLength(1);
    const reentered = result.seeds[0];
    expect(reentered.changed_premise).toContain('compaction window moved');
    expect(reentered.parent_seed_ids).toEqual([fixture.rejectedEntryId]);
    expect(reentered.incumbent).toBe(true);
    expect(validateAgainst(SCHEMA_IDS.ideaSeed, reentered).valid).toBe(true);

    const cell = (db.collection(CELLS).docs as Array<Record<string, unknown>>).find(
      (row) => row.incumbent_seed_id === reentered.seed_id,
    )!;
    const history = cell.history as Array<{ event: string; premise?: string; prior_rejection_id?: string }>;
    const reentry = history.find((entry) => entry.event === 'changed_premise_reentry')!;
    expect(reentry.prior_rejection_id).toBe(fixture.rejectedEntryId);
    expect(reentry.premise).toBe(reentered.changed_premise);
    const lineage = db.collection(LINEAGES).docs.find(
      (row) => (row as { seed_id: string }).seed_id === reentered.seed_id,
    ) as unknown as { changed_premise?: string; parent_seed_ids: string[] };
    expect(lineage.changed_premise).toBe(reentered.changed_premise);
    expect(lineage.parent_seed_ids).toEqual([fixture.rejectedEntryId]);
  });

  it('re-opens an idea the ARCHIVE itself rejected in an earlier cycle', async () => {
    const fixture = await seedFixture();
    const archive = new IdeaArchiveService(db.asDb());

    // Cycle 1: the model proposes the ruled-out compaction idea → rejected.
    const firstPass = await archive.admitOrReplace(
      {
        ...baseSeed,
        seed_id: 'seed_archive_rejection',
        lineage_ref: 'lineage_archive_rejection',
      },
      { exclusions },
    );
    expect(firstPass.decision).toBe('rejected');

    // Cycle 2: the same idea with a stated changed premise and a link to the
    // prior rejection → admitted.
    const secondPass = await archive.changedPremiseReentry(
      {
        ...baseSeed,
        seed_id: 'seed_archive_reentry',
        lineage_ref: 'lineage_archive_reentry',
        parent_seed_ids: ['seed_archive_rejection'],
      },
      premise,
      { exclusions },
    );
    expect(secondPass.decision).toBe('admitted');
    expect(secondPass.reentry?.prior_rejection_id).toBe('seed_archive_rejection');
    void fixture;
  });
});

// ── G. lineage ──────────────────────────────────────────────────────────────

describe('imagination lineage', () => {
  it('gives every admitted seed a lineage row, and links a mutated child to its parent', async () => {
    const fixture = await seedFixture();
    const first = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-lineage-1',
      actorId: OWNER.user_id,
      seed: 'lineage-seed-1',
    });
    expect(first.seeds.length).toBeGreaterThan(0);
    for (const seed of first.seeds) {
      const lineage = db.collection(LINEAGES).docs.find(
        (row) => (row as { lineage_id: string }).lineage_id === seed.lineage_ref,
      ) as unknown as { seed_id: string; parent_seed_ids: string[]; transformations: Array<{ type: string }> };
      expect(lineage).toBeTruthy();
      expect(lineage.seed_id).toBe(seed.seed_id);
      expect(lineage.transformations[0].type).toBe(`operator:${seed.operator}`);
    }

    // Cycle 2: the model mutates one of cycle 1's seeds (the prompt offered the
    // ids), and the child's lineage records the parent link.
    const parent = first.seeds[0];
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return focusedOutput(prompt);
      const signalId = offeredSignalIds(prompt)[0] ?? '';
      if (prompt.includes(parent.seed_id)) {
        return {
          seeds: requestedOperators(prompt).map((operator, index) =>
            bridgeFields(prompt, operator, {
              ...seedForOperator(operator, signalId, index),
              parent_seed_ids: [parent.seed_id],
              hypothesis: `Mutating ${parent.seed_id}: the drain is measured, not assumed, at step ${index}.`,
              mechanism: 'A measured drain removes the assumption the parent rested on.',
            }),
          ),
        };
      }
      return imaginationOutput(prompt);
    };

    const second = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-lineage-2',
      actorId: OWNER.user_id,
      seed: 'lineage-seed-2',
    });
    const child = second.seeds.find((seed) => seed.parent_seed_ids.includes(parent.seed_id));
    expect(child).toBeTruthy();
    const childLineage = db.collection(LINEAGES).docs.find(
      (row) => (row as { seed_id: string }).seed_id === child!.seed_id,
    ) as unknown as { parent_seed_ids: string[] };
    expect(childLineage.parent_seed_ids).toEqual([parent.seed_id]);
    // A parent id that is not in the archive is dropped, never invented.
    expect(second.seeds.every((seed) => seed.parent_seed_ids.every((id) => /^seed_/.test(id)))).toBe(true);
  });

  it('records the previous incumbent when a cell is replaced, and keeps the highest quality', async () => {
    const fixture = await seedFixture();
    const archive = new IdeaArchiveService(db.asDb());
    // Three GENUINELY different claims (no shared content tokens) that land in
    // ONE cell, so this test exercises the incumbent rule — replacement,
    // history, the below-incumbent challenger — and not the dedupe gate. (The
    // original fixture stated one claim three ways; with the containment-aware
    // metric that is exactly the paraphrase the archive is supposed to reject,
    // so the claims had to become distinct for the cell rule to be reachable.)
    const make = (seedId: string, testability: number, hypothesis: string, mechanism: string): IdeaSeedInput => ({
      seed_id: seedId,
      user_id: OWNER.user_id,
      mission_id: fixture.missionId,
      cycle_id: 'cycle-cells',
      prng_seed: 3,
      operator: 'tool_invention',
      hypothesis,
      mechanism,
      evidence_refs: ['sig_x'],
      novelty_score: 0.9,
      coherence_score: 0.9,
      testability_score: testability,
      cheapest_test: 'Count the drain rows.',
      expected_information_gain: 0.9,
      parent_seed_ids: [],
      lineage_ref: `lineage_${seedId}`,
      descriptor_bins: ['removal', 'protocol', 'scarcity', 'work_queue', 'cheapest_probe'],
    });

    const weak = await archive.admitOrReplace(
      make(
        'seed_weak',
        0.1,
        'Installing the drain counter ends the plateau.',
        'A counter turns an unmeasured loss into a countable row.',
      ),
    );
    expect(weak.decision).toBe('admitted');
    expect(weak.seed?.incumbent).toBe(true);

    const strong = await archive.admitOrReplace(
      make(
        'seed_strong',
        1,
        'Queue latency is a reporting artefact of averaging two regimes.',
        'Averaging hides a bimodal split, so the curve looks flat.',
      ),
    );
    expect(strong.decision).toBe('replaced');
    expect(strong.previous_incumbent_id).toBe('seed_weak');
    expect(strong.history?.event).toBe('replaced');
    expect(strong.history?.previous_quality).toBe(weak.quality);

    const cell = db.collection(CELLS).docs[0] as unknown as { incumbent_seed_id: string; history: unknown[]; seed_count: number };
    expect(cell.incumbent_seed_id).toBe('seed_strong');
    expect(cell.history).toHaveLength(2);
    expect(cell.seed_count).toBe(2);

    // A challenger that does NOT beat the incumbent is admitted but does not
    // take the cell — the incumbent stays the highest quality.
    const middling = await archive.admitOrReplace(
      make(
        'seed_middling',
        0.5,
        'Two writers race for the claim and the loser drops it silently.',
        'Racing writers leave a gap where the ledger expected a row.',
      ),
    );
    expect(middling.decision).toBe('below_incumbent');
    expect(middling.seed?.incumbent).toBe(false);
    expect((db.collection(CELLS).docs[0] as unknown as { incumbent_seed_id: string }).incumbent_seed_id).toBe('seed_strong');
    expect((db.collection(CELLS).docs[0] as unknown as { history: Array<{ event: string }> }).history.map((h) => h.event)).toContain(
      'challenger_below_incumbent',
    );
  });

  it('records outcomes and failure signatures on the lineage', async () => {
    const fixture = await seedFixture();
    void fixture;
    const archive = new IdeaArchiveService(db.asDb());
    const seed: IdeaSeedInput = {
      seed_id: 'seed_outcome',
      user_id: OWNER.user_id,
      mission_id: MISSION,
      cycle_id: 'cycle-outcome',
      prng_seed: 5,
      operator: 'boundary_extreme',
      hypothesis: 'At the extreme the queue never drains and the plateau is permanent.',
      mechanism: 'The extreme removes the drain entirely.',
      evidence_refs: ['sig_x'],
      novelty_score: 0.7,
      coherence_score: 0.7,
      testability_score: 0.7,
      cheapest_test: 'Run the queue at its boundary for one cycle.',
      expected_information_gain: 0.7,
      parent_seed_ids: [],
      lineage_ref: 'lineage_outcome',
    };
    await archive.admitOrReplace(seed);
    const lineage = await archive.recordOutcome('seed_outcome', {
      verdict: 'refuted',
      detail: 'the queue drained at the boundary too',
      test: 'boundary run',
      failure_signature: 'no plateau at the boundary',
    }, OWNER.user_id);

    expect(lineage?.results).toHaveLength(1);
    expect(lineage?.results[0].verdict).toBe('refuted');
    expect(lineage?.tests).toHaveLength(1);
    expect(lineage?.failure_signatures).toHaveLength(1);
    expect(lineage?.failure_signatures[0].signature).toBe('no plateau at the boundary');
    // A second outcome appends instead of overwriting.
    const again = await archive.recordOutcome('seed_outcome', { verdict: 'inconclusive' }, OWNER.user_id);
    expect(again?.results).toHaveLength(2);
    expect(again?.failure_signatures).toHaveLength(1);
    // An unknown seed is not an error, it is an absent record.
    expect(await archive.recordOutcome('seed_missing', { verdict: 'confirmed' }, OWNER.user_id)).toBeNull();
  });
});

// ── H. cheap tests + deterministic ranking ──────────────────────────────────

describe('imagination engine — cheap tests and deterministic ranking', () => {
  it('every admitted seed carries a cheapest test and a bounded information gain, ranked deterministically', async () => {
    const fixture = await seedFixture();
    const options = {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-ranking',
      actorId: OWNER.user_id,
      seed: 'ranking-seed',
    };
    const first = await runImaginationCycle(db.asDb(), options);
    for (const seed of first.seeds) {
      expect(seed.cheapest_test.length).toBeGreaterThan(0);
      expect(seed.expected_information_gain).toBeGreaterThanOrEqual(0);
      expect(seed.expected_information_gain).toBeLessThanOrEqual(1);
      expect(seed.rank).toBeGreaterThanOrEqual(0);
    }
    // Sorted by quality desc, ties by testability desc, then by id.
    const qualities = first.seeds.map((seed) => seed.quality);
    for (let index = 1; index < qualities.length; index += 1) {
      expect(qualities[index - 1]).toBeGreaterThanOrEqual(qualities[index]);
    }
    expect(first.seeds.map((seed) => seed.rank)).toEqual(first.seeds.map((_seed, index) => index));

    const { trace, inventory, exclusions } = await loadFixtureForGeneration(fixture);
    const one = await generateImaginationSeeds(db.asDb(), { trace, inventory, exclusions, seed: 'ranking-seed' });
    const two = await generateImaginationSeeds(db.asDb(), { trace, inventory, exclusions, seed: 'ranking-seed' });
    expect(one.seeds.map((seed) => seed.seed_id)).toEqual(two.seeds.map((seed) => seed.seed_id));
  });

  it('measures novelty against the archive, not the model\'s self-report', async () => {
    const fixture = await seedFixture();
    const { trace, inventory, exclusions } = await loadFixtureForGeneration(fixture);

    // The archive already holds the exact idea the model is about to claim as
    // novel (same claim, same mechanism).
    const archive = new IdeaArchiveService(db.asDb());
    const known = await archive.admitOrReplace(
      {
        seed_id: 'seed_known_idea',
        user_id: OWNER.user_id,
        mission_id: fixture.missionId,
        cycle_id: 'cycle-before',
        prng_seed: 1,
        operator: 'tool_invention',
        hypothesis: OPERATOR_TEXT.tool_invention.hypothesis,
        mechanism: OPERATOR_TEXT.tool_invention.mechanism,
        evidence_refs: ['sig_x'],
        novelty_score: 0.8,
        novelty_self_reported: 0.8,
        coherence_score: 0.7,
        testability_score: 0.6,
        cheapest_test: OPERATOR_TEXT.tool_invention.test,
        expected_information_gain: 0.5,
        parent_seed_ids: [],
        lineage_ref: 'lineage_known_idea',
      },
      { exclusions },
    );
    expect(known.decision).toBe('admitted');

    const generated = await generateImaginationSeeds(db.asDb(), {
      trace,
      inventory,
      exclusions,
      seed: 'novelty-probe',
      budget: { max_operators: 10, max_seeds: 10 },
    });

    const collision = generated.seeds.find(
      (seed) => seed.hypothesis === OPERATOR_TEXT.tool_invention.hypothesis,
    );
    if (collision) {
      // The model still claims 0.8; the archive says there is nothing new here.
      expect(collision.novelty_self_reported).toBe(0.8);
      expect(collision.novelty_score).toBe(0);
    }
    // Universally: novelty is at most the self-report, and at most what the
    // archive left unexplored.
    for (const seed of generated.seeds) {
      expect(seed.novelty_score).toBeLessThanOrEqual(seed.novelty_self_reported ?? 1);
      expect(seed.novelty_score).toBeLessThanOrEqual(1);
    }
  });
});

// ── I. budget ───────────────────────────────────────────────────────────────

describe('imagination engine — budgets', () => {
  it('caps seeds, operators and model calls even when the caller asks for more', async () => {
    const fixture = await seedFixture();
    process.env.FOCUSED_IMAGINATION_MAX_SEEDS = '3';
    process.env.FOCUSED_IMAGINATION_MAX_OPERATORS = '4';
    process.env.FOCUSED_IMAGINATION_MAX_LLM_CALLS = '1';

    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-budget',
      actorId: OWNER.user_id,
      seed: 'budget-seed',
      budget: { max_seeds: 100, max_operators: 100, max_llm_calls: 100 },
    });

    expect(result.run.budget.max_seeds).toBe(3);
    expect(result.run.budget.max_operators).toBe(4);
    expect(result.run.budget.max_llm_calls).toBe(1);
    expect(result.seeds.length).toBeLessThanOrEqual(3);
    expect(result.seeds_generated).toBeLessThanOrEqual(3);
    expect(result.operators_run).toBeLessThanOrEqual(4);
    expect(result.operators_run).toBeLessThanOrEqual(OPERATORS_PER_CALL);
    expect(result.llm_calls_actual).toBeLessThanOrEqual(1);
    expect(result.dropped_by_reason.over_seed_cap ?? 0).toBeGreaterThanOrEqual(0);
    // Planned vs actual are both on the record.
    expect(result.llm_calls_planned).toBeLessThanOrEqual(1);
    expect(result.run.operators_planned).toBeLessThanOrEqual(4);
  });

  it('lets a caller ask for LESS than the environment allows, and never for a disabled cap', () => {
    const env = environmentBudget();
    expect(env.max_seeds).toBe(DEFAULT_MAX_SEEDS);
    const smaller = resolveBudget({ max_seeds: 2, max_operators: 1, max_llm_calls: 1 });
    expect(smaller.max_seeds).toBe(2);
    expect(smaller.max_operators).toBe(1);
    expect(smaller.max_llm_calls).toBe(1);
    const nonsense = resolveBudget({ max_seeds: 0, max_operators: -5, max_llm_calls: Number.NaN });
    expect(nonsense.max_seeds).toBe(env.max_seeds);
    expect(nonsense.max_operators).toBe(env.max_operators);
    expect(nonsense.max_llm_calls).toBe(env.max_llm_calls);
    process.env.FOCUSED_IMAGINATION_MAX_SEEDS = '4';
    expect(environmentBudget().max_seeds).toBe(4);
    expect(resolveBudget({ max_seeds: 99 }).max_seeds).toBe(4);
  });

  it('marks the operators it could not afford instead of pretending they ran', async () => {
    const fixture = await seedFixture();
    process.env.FOCUSED_IMAGINATION_MAX_OPERATORS = '6';
    process.env.FOCUSED_IMAGINATION_MAX_LLM_CALLS = '1';
    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-afford',
      actorId: OWNER.user_id,
      seed: 'afford-seed',
    });
    const overflow = result.operator_plan.filter((entry) => entry.skip_reason === 'llm_call_budget');
    expect(overflow.length).toBeGreaterThan(0);
    expect(result.operators_run + overflow.length).toBe(
      result.operator_plan.filter((entry) => !entry.skipped || entry.skip_reason === 'llm_call_budget').length,
    );
  });
});

// ── J. hostile model output ─────────────────────────────────────────────────

describe('imagination engine — hostile model output', () => {
  it('drops junk seeds with counted reasons and keeps the usable ones', async () => {
    const fixture = await seedFixture();
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return focusedOutput(prompt);
      const signalId = offeredSignalIds(prompt)[0] ?? '';
      const operators = requestedOperators(prompt);
      const seeds: unknown[] = [
        null,
        'not an object',
        { operator: 'not_an_operator', hypothesis: 'x', mechanism: 'y', cheapest_test: 'z', evidence_refs: [signalId] },
        { operator: operators[0], mechanism: 'no hypothesis', cheapest_test: 'z', evidence_refs: [signalId] },
        { operator: operators[0], hypothesis: 'no mechanism', cheapest_test: 'z', evidence_refs: [signalId] },
        { operator: operators[0], hypothesis: 'no test', mechanism: 'y', evidence_refs: [signalId] },
        { operator: operators[0], hypothesis: 'no evidence', mechanism: 'y', cheapest_test: 'z' },
        { operator: operators[0], hypothesis: 'fabricated evidence', mechanism: 'y', cheapest_test: 'z', evidence_refs: ['sig_deadbeefdeadbeef'] },
        { operator: 'causal_reversal', hypothesis: 'wrong batch', mechanism: 'y', cheapest_test: 'z', evidence_refs: [signalId] },
        {
          ...bridgeFields(prompt, operators[0], seedForOperator(operators[0], signalId, 0)),
          novelty: 'nonsense',
          coherence: 42,
          testability: -1,
          expected_information_gain: '0.4',
        },
      ];
      return { seeds };
    };

    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-hostile',
      actorId: OWNER.user_id,
      seed: 'hostile-seed',
    });

    expect(result.status).toBe('completed');
    // The stub returns the same junk list for every batch it is asked about, so
    // the counts scale with the batches that actually ran — and each junk
    // category is accounted for, exactly.
    const batches = result.llm_calls_actual;
    expect(batches).toBeGreaterThan(0);
    expect(result.seeds_generated).toBe(batches);
    expect(result.dropped_by_reason.not_an_object).toBe(2 * batches);
    expect(result.dropped_by_reason.unknown_operator).toBe(batches);
    expect(result.dropped_by_reason.missing_hypothesis).toBe(batches);
    expect(result.dropped_by_reason.missing_mechanism).toBe(batches);
    expect(result.dropped_by_reason.missing_cheapest_test).toBe(batches);
    expect(result.dropped_by_reason.no_evidence_refs).toBe(batches);
    expect(result.dropped_by_reason.no_resolvable_evidence_refs).toBe(batches);
    expect(result.run.clamped_values).toBeGreaterThan(0);
    // The one usable seed was clamped into range, not stored out of bounds.
    const stored = result.seeds[0];
    expect(stored.novelty_score).toBeGreaterThanOrEqual(0);
    expect(stored.novelty_score).toBeLessThanOrEqual(1);
    expect(stored.coherence_score).toBe(1);
    expect(stored.testability_score).toBe(0);
    expect(stored.expected_information_gain).toBeCloseTo(0.4, 6);
  });

  it('fails the run cleanly when the output is wholly unusable', async () => {
    const fixture = await seedFixture();
    const callsBefore = llmCalls();
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return focusedOutput(prompt);
      void prompt;
      return { seeds: [] };
    };

    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-unusable',
      actorId: OWNER.user_id,
      seed: 'unusable-seed',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no usable seed/i);
    expect(result.seeds).toEqual([]);
    expect(db.collection(SEEDS).docs).toHaveLength(0);
    expect(db.collection(CELLS).docs).toHaveLength(0);
    expect(db.collection(LINEAGES).docs).toHaveLength(0);
    const run = db.collection(RUNS).docs[0] as unknown as { status: string; error: string };
    expect(run.status).toBe('failed');
    expect(run.error).toBeTruthy();
    expect(llmCalls()).toBeGreaterThan(callsBefore);
  });

  it('fails the run cleanly when the model itself fails', async () => {
    const fixture = await seedFixture();
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return focusedOutput(prompt);
      void prompt;
      throw new Error('provider exploded');
    };
    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-provider-fail',
      actorId: OWNER.user_id,
      seed: 'provider-seed',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/provider exploded/);
    expect(db.collection(SEEDS).docs).toHaveLength(0);
  });

  it('drops a bridge seed that does not state its bridge', async () => {
    const fixture = await seedFixture();
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return focusedOutput(prompt);
      const signalId = offeredSignalIds(prompt)[0] ?? '';
      const operators = requestedOperators(prompt);
      const seeds = operators.map((operator, index) => {
        const seed = seedForOperator(operator, signalId, index);
        if (operator === 'distant_analogy' || operator === 'random_semantic_bridge') {
          return { ...seed, bridge_path: [] }; // no path stated
        }
        return seed;
      });
      return { seeds };
    };
    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-bridge-junk',
      actorId: OWNER.user_id,
      seed: 'bridge-junk',
      budget: { max_operators: 2, max_llm_calls: 1 },
    });
    const dropped = result.dropped_by_reason.missing_bridge_path ?? 0;
    if (result.operators_run > 0 && dropped === 0) {
      // The two operators that ran were not bridge operators — then nothing to
      // assert beyond the run completing with schema-valid seeds.
      expect(result.seeds.every((seed) => seed.bridge_path === undefined)).toBe(true);
    } else {
      expect(dropped).toBeGreaterThan(0);
    }
  });
});

// ── K. privacy ──────────────────────────────────────────────────────────────

describe('imagination engine — privacy', () => {
  it('never writes a shared_id, and never even imports a journal writer', async () => {
    const fixture = await seedFixture();
    await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-privacy',
      actorId: OWNER.user_id,
      seed: 'privacy-seed',
    });

    const docs = imaginationDocs();
    for (const name of ALL_IMAGINATION_COLLECTIONS) {
      expect(docs[name].length).toBeGreaterThan(0);
      for (const doc of docs[name]) {
        expect('shared_id' in doc).toBe(false);
      }
      expect(db.collection(name).createdIndexes.length).toBeGreaterThan(0);
    }
    // The two PRIVATE kinds resolve private even against a shared request, and
    // the identity-owned archive kind is written through the policy's opt-out.
    for (const kind of [SEEDS, LINEAGES, RUNS]) {
      expect(PERSONAL_KINDS).toContain(kind);
      expect(
        resolveWriteScope({
          caller: { user_id: OWNER.user_id, trusted: true },
          kind,
          requested: { shared_id: 'my-team', private: false },
        }),
      ).toEqual({ user_id: OWNER.user_id, shared_id: null });
    }
    expect(PERSONAL_KINDS).not.toContain(CELLS);
    expect(
      resolveWriteScope({
        caller: { user_id: OWNER.user_id, trusted: true },
        kind: CELLS,
        requested: { private: true },
      }),
    ).toEqual({ user_id: OWNER.user_id, shared_id: null });
  });

  it('leaves the journal family byte-identical', async () => {
    const fixture = await seedFixture();
    db.collection('reflective_journals').docs.push({
      user_id: OWNER.user_id,
      period_type: 'weekly',
      narrative: 'private narrative',
      unresolved_threads: ['private thread'],
      created_at: new Date('2026-09-19T00:00:00.000Z'),
    });
    db.collection('reflection_nodes').docs.push({ user_id: OWNER.user_id, entity_name: 'x' });
    db.collection('consolidation_runs').docs.push({ period: 'weekly', last_run: 42 });
    const before = freezeJournalFamily();

    await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-journal',
      actorId: OWNER.user_id,
      seed: 'journal-seed',
    });

    expect(freezeJournalFamily()).toBe(before);
  });

  it('the coverage view carries no seed statement, mechanism or why text', async () => {
    const fixture = await seedFixture();
    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-coverage',
      actorId: OWNER.user_id,
      seed: 'coverage-seed',
    });
    const rendered = JSON.stringify(result.coverage);
    for (const seed of result.seeds) {
      expect(rendered).not.toContain(seed.hypothesis);
      expect(rendered).not.toContain(seed.mechanism);
      expect(rendered).not.toContain(seed.cheapest_test);
    }
    const trace = db.collection('salience_traces').docs[0] as unknown as { signals: Array<{ statement: string }> };
    for (const signal of trace.signals) {
      expect(rendered).not.toContain(signal.statement);
    }
    // …and the archive's shareable listing is ids/bins/quality only.
    const archive = new IdeaArchiveService(db.asDb());
    const incumbents = await archive.listIncumbents(MISSION, OWNER.user_id);
    const listing = JSON.stringify(incumbents);
    for (const seed of result.seeds) {
      expect(listing).not.toContain(seed.hypothesis);
      expect(listing).not.toContain(seed.mechanism);
      expect(listing).not.toContain(seed.cheapest_test);
    }
    for (const cell of incumbents) {
      expect(cell.incumbent_seed_id).toMatch(/^seed_/);
      expect(Object.keys(cell.bins).sort()).toEqual([...DESCRIPTOR_DIMENSIONS].sort());
      // The summary carries ids, bins, quality and counts — nothing else.
      expect(Object.keys(cell).sort()).toEqual(
        ['bins', 'cell_key', 'created_cycle_id', 'history_count', 'incumbent_seed_id', 'last_cycle_id', 'quality', 'seed_count'].sort(),
      );
    }
  });

  it('the new modules import no journal writer, use no randomUUID and no Math.random', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      'imagination-service.ts',
      'imagination-tools.ts',
      'imagination-operators.ts',
      'imagination-collections.ts',
      'idea-archive-service.ts',
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
      expect(source, `${file} must not set a literal shared_id`).not.toMatch(
        /shared_id\s*:\s*(?:'[^']*'|"[^"]*"|`[^`]*`)/,
      );
      // No global RNG and no random identifiers: every draw comes from the
      // seeded stream and every id is derived. Mentions inside comments are how
      // the modules DOCUMENT that rule, so they are not violations.
      for (const pattern of [/Math\.random\(\)/g, /randomUUID\(\)/g]) {
        for (const match of source.matchAll(pattern)) {
          const lineStart = source.lastIndexOf('\n', match.index ?? 0) + 1;
          const line = source.slice(lineStart, (match.index ?? 0) + match[0].length);
          expect(
            /^\s*(\/\/|\*|\/\*)/.test(line),
            `${file} calls ${match[0]} outside a comment: ${line.trim()}`,
          ).toBe(true);
        }
      }
      expect(source, `${file} must not promote into shared memory`).not.toMatch(
        /promote_to_shared|contextBaton|promoteToShared/,
      );
    }
  });
});

// ── L. flag + caller pinning ────────────────────────────────────────────────

describe('imagination engine — the FOCUSED_IMAGINATION gate and caller pinning', () => {
  it('flag off: both tools are Unknown tool, nothing is written and no model is called', async () => {
    const fixture = await seedFixture();
    const callsBefore = llmCalls();
    delete process.env.FOCUSED_IMAGINATION;

    for (const tool of IMAGINATION_TOOL_NAMES) {
      await expect(
        dispatchImaginationTool(tool, { mission_id: fixture.missionId }, OWNER),
      ).rejects.toThrow(`Unknown tool: ${tool}`);
    }
    expect(llmCalls()).toBe(callsBefore);
    expect(db.collection(SEEDS).docs).toHaveLength(0);
    expect(db.collection(CELLS).docs).toHaveLength(0);
    expect(db.collection(LINEAGES).docs).toHaveLength(0);
    expect(db.collection(RUNS).docs).toHaveLength(0);
  });

  it('flag on: the generate tool runs end to end and the archive tool stays sanitized', async () => {
    const fixture = await seedFixture();
    process.env.FOCUSED_IMAGINATION = '1';

    const generated = await dispatchImaginationTool(
      'generate_imagination_seeds',
      { mission_id: fixture.missionId, cycle_id: 'cycle-tool', seed: 'tool-seed', max_llm_calls: 1 },
      OWNER,
    );
    const body = txt(generated);
    expect(body).toContain('Imagination cycle complete');
    expect(body).toContain('Rejections');
    expect(db.collection(SEEDS).docs.length).toBeGreaterThan(0);

    const archive = await dispatchImaginationTool('get_idea_archive', { mission_id: fixture.missionId }, OWNER);
    const archiveBody = txt(archive);
    expect(archiveBody).toContain('Idea archive');
    expect(archiveBody).toContain('Incumbents');
    expect(archiveBody).not.toContain('hypothesis:');
    // No promotion path exists: the tool says so, and nothing outside the
    // feature's own collections was touched (no shared memory, no baton).
    expect(body.toLowerCase()).toContain('nothing is promoted');
    for (const untouched of ['semantic_facts', 'cognitive_batons', 'episodic_events', 'reflective_journals']) {
      expect(db.collection(untouched).docs).toHaveLength(0);
    }
  });

  it('an untrusted caller cannot run or read another identity\'s mission', async () => {
    const fixture = await seedFixture();
    process.env.FOCUSED_IMAGINATION = '1';

    const denied = await dispatchImaginationTool(
      'generate_imagination_seeds',
      { mission_id: fixture.missionId, cycle_id: 'cycle-security', seed: 'security-seed' },
      OTHER,
    );
    expect(txt(denied)).toContain('Not authorized');
    expect(db.collection(RUNS).docs).toHaveLength(0);
    expect(db.collection(SEEDS).docs).toHaveLength(0);

    const deniedArchive = await dispatchImaginationTool('get_idea_archive', { mission_id: fixture.missionId }, OTHER);
    expect(txt(deniedArchive)).toContain('Not authorized');
  });

  it('a supplied user_id cannot re-attribute an untrusted caller\'s own run', async () => {
    const fixture = await seedFixture();
    process.env.FOCUSED_IMAGINATION = '1';
    const result = await dispatchImaginationTool(
      'generate_imagination_seeds',
      { mission_id: fixture.missionId, cycle_id: 'cycle-spoof', seed: 'spoof-seed', user_id: OTHER.user_id, max_llm_calls: 1 },
      OWNER,
    );
    expect(txt(result)).toContain('Imagination cycle complete');
    for (const doc of db.collection(SEEDS).docs as Array<{ user_id: string }>) {
      expect(doc.user_id).toBe(OWNER.user_id);
    }
    // …and the other identity still sees nothing.
    const service = new ImaginationService(db.asDb());
    expect(await service.getSeeds(OTHER.user_id, fixture.missionId)).toEqual([]);
    expect(await new IdeaArchiveService(db.asDb()).listIncumbents(fixture.missionId, OTHER.user_id)).toEqual([]);
  });

  it('a trusted caller may name another identity, and the rows are attributed to it', async () => {
    const fixture = await seedFixture();
    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-trusted',
      actorId: OPERATOR_IDENTITY.user_id,
      seed: 'trusted-seed',
    });
    expect(result.seeds.every((seed) => seed.user_id === OWNER.user_id)).toBe(true);
    expect(result.run.actor_id).toBe(OPERATOR_IDENTITY.user_id);
    const service = new ImaginationService(db.asDb());
    expect((await service.getSeeds(OWNER.user_id, fixture.missionId)).length).toBeGreaterThan(0);
    expect(await service.getSeeds(OTHER.user_id, fixture.missionId)).toEqual([]);
  });

  it('the flag fails closed: only 1/true/yes (case-insensitive) switch it on', async () => {
    const { focusedImaginationEnabled } = await import('../../src/services/processing/imagination-tools.js');
    for (const value of ['', 'off', 'TRUE-ish', 'nope']) {
      process.env.FOCUSED_IMAGINATION = value;
      expect(focusedImaginationEnabled()).toBe(false);
    }
    for (const value of ['1', 'true', 'TRUE', 'Yes']) {
      process.env.FOCUSED_IMAGINATION = value;
      expect(focusedImaginationEnabled()).toBe(true);
    }
  });

  it('reports wrong-typed arguments as a readable error instead of a raw ZodError', async () => {
    const fixture = await seedFixture();
    process.env.FOCUSED_IMAGINATION = '1';
    const result = await dispatchImaginationTool(
      'generate_imagination_seeds',
      { mission_id: fixture.missionId, max_seeds: 'lots' },
      OWNER,
    );
    expect(txt(result)).toContain('❌ Invalid arguments for generate_imagination_seeds');
    expect(db.collection(RUNS).docs).toHaveLength(0);
  });
});

// ── M. the mind-wander edge fix ─────────────────────────────────────────────

describe('self-model — the goal-directed mind-wander reads the real edge schema', () => {
  /** Load the service the way the security suite does (fresh module + store). */
  async function loadSelfModel(store: FakeDb): Promise<SelfModelService> {
    holder.db = store;
    vi.resetModules();
    const module = await import('../../src/services/processing/self-model-service.js');
    return module.SelfModelService.get_instance();
  }

  /** A chain of nodes with `from_id`/`to_id` edges between them. */
  function seedChain(store: FakeDb, shape: 'from_id' | 'source' = 'from_id'): void {
    for (const [id, name] of [['n1', 'Queue health'], ['n2', 'Drain measurement'], ['n3', 'Plateau detector']]) {
      store.collection('knowledge_nodes').docs.push({ id, user_id: OWNER.user_id, properties: { name } });
    }
    const edges =
      shape === 'from_id'
        ? [
            { id: 'e1', from_id: 'n1', to_id: 'n2' },
            { id: 'e2', from_id: 'n2', to_id: 'n3' },
          ]
        : [
            { id: 'e1', source: 'n1', target: 'n2' },
            { id: 'e2', source: 'n2', target: 'n3' },
          ];
    for (const edge of edges) {
      store.collection('knowledge_relationships').docs.push({
        ...edge,
        user_id: OWNER.user_id,
        relationship_type: 'relates',
        strength: 1,
      });
    }
  }

  it('traverses edges stored as from_id/to_id instead of ending after one node', async () => {
    const store = new FakeDb();
    const service = await loadSelfModel(store);
    seedChain(store);

    // The walk was undirected (`$or` on both endpoints), so it may turn around
    // in a two-way chain; what the defect destroyed was the traversal ITSELF:
    // the old query asked for `source`/`target` and found no edges at all, so
    // every wander ended after exactly one node.
    const result = await service.generateGoalDirectedMindWander(OWNER.user_id);
    // TRAVERSAL IS THE POINT: the old query found no edges at all, so every
    // wander ended after exactly one node.
    expect(result.path.length).toBeGreaterThan(1);
    expect(result.narrative).toContain('This led me through');
    // …and every step is a real hop along one of the seeded edges, never an
    // invented node.
    const undirectedEdges = new Set(
      [
        ['Queue health', 'Drain measurement'],
        ['Drain measurement', 'Plateau detector'],
      ].map((pair) => [...pair].sort().join('|')),
    );
    for (let index = 1; index < result.path.length; index += 1) {
      const pair = [result.path[index - 1], result.path[index]].sort().join('|');
      expect(undirectedEdges, `step ${index}: ${result.path[index - 1]} → ${result.path[index]}`).toContain(pair);
    }
    expect(store.collection('knowledge_nodes').docs.every((doc) => doc.user_id === OWNER.user_id)).toBe(true);
  });

  it('tolerates source/target edges too', async () => {
    const store = new FakeDb();
    const service = await loadSelfModel(store);
    seedChain(store, 'source');
    const result = await service.generateGoalDirectedMindWander(OWNER.user_id);
    expect(result.path.length).toBeGreaterThan(1);
    expect(result.path).toContain('Drain measurement');
  });

  it('walks a forward chain deterministically in the non-goal mind wander', async () => {
    const store = new FakeDb();
    const service = await loadSelfModel(store);
    seedChain(store);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // That walk only follows OUTGOING edges, so a forward chain advances one
      // node per step: with Math.random fixed it is a three-node path.
      const result = await service.generateMindWander(OWNER.user_id);
      expect(result.path).toEqual(['Queue health', 'Drain measurement', 'Plateau detector']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('still returns a single-node path when the graph really has no edges', async () => {
    const store = new FakeDb();
    const service = await loadSelfModel(store);
    store.collection('knowledge_nodes').docs.push({ id: 'n1', user_id: OWNER.user_id, properties: { name: 'Lonely' } });
    const result = await service.generateGoalDirectedMindWander(OWNER.user_id);
    expect(result.path).toEqual(['Lonely']);
    expect(result.narrative).toContain('stayed there');
  });
});

// ── N. archive surface ──────────────────────────────────────────────────────

describe('imagination archive — coverage', () => {
  it('reports cells, dimensions, occupancy and gaps without any private text', async () => {
    const fixture = await seedFixture();
    void fixture;
    const archive = new IdeaArchiveService(db.asDb());
    expect((await archive.coverage(MISSION, OWNER.user_id)).cells_total).toBe(0);

    for (const [index, bins] of [
      ['removal', 'prose', 'necessity', 'epistemic_ledger', 'kill_criterion'],
      ['relocation', 'table', 'sufficiency', 'operational_state', 'instrumentation'],
      ['composition', 'graph', 'independence', 'external_observation', 'observation_study'],
    ].entries()) {
      await archive.admitOrReplace({
        seed_id: `seed_cov_${index}`,
        user_id: OWNER.user_id,
        mission_id: MISSION,
        cycle_id: 'cycle-coverage-unit',
        prng_seed: index,
        operator: 'representation_shift',
        hypothesis: [
          'The trigger is not what ends the plateau: the drain measurement is.',
          'Drawn as a per-cycle table, the plateau is an artefact of averaging.',
          'The plateau behaves like a reservoir with an unmeasured outflow.',
        ][index],
        mechanism: [
          'Inverting the necessity of the trigger predicts the plateau clears without it.',
          'A tabular read exposes a bimodal split that the mean hides.',
          'Reservoir dynamics make an unmeasured outflow look like a stalled inflow.',
        ][index],
        descriptor_bins: bins as string[],
        evidence_refs: ['sig_x'],
        novelty_score: 0.5,
        coherence_score: 0.5,
        testability_score: 0.5,
        cheapest_test: 'Count the rows.',
        expected_information_gain: 0.5,
        parent_seed_ids: [],
        lineage_ref: `lineage_cov_${index}`,
      });
    }

    const coverage = await archive.coverage(MISSION, OWNER.user_id, { cycleId: 'cycle-coverage-unit' });
    expect(coverage.cells_total).toBe(3);
    expect(coverage.new_cells_this_cycle).toBe(3);
    expect(coverage.cycle_id).toBe('cycle-coverage-unit');
    expect(coverage.occupancy.occupied).toBe(3);
    expect(coverage.occupancy.possible).toBe(
      DESCRIPTOR_DIMENSIONS.reduce((product, dimension) => product * (DESCRIPTOR_BINS[dimension].length + 1), 1),
    );
    expect(coverage.coverage_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const dimension of DESCRIPTOR_DIMENSIONS) {
      expect(coverage.cells_by_dimension[dimension]).toBeTruthy();
    }
    // Gaps name the unoccupied bins per dimension.
    const mechanismGap = coverage.gaps.find((gap) => gap.dimension === 'mechanism')!;
    expect(mechanismGap.unoccupied_bins).not.toContain('removal');
    expect(mechanismGap.unoccupied_bins).toContain('substitution');

    // A second cycle adds no new cells when the same tuple repeats.
    await archive.admitOrReplace({
      seed_id: 'seed_cov_repeat',
      user_id: OWNER.user_id,
      mission_id: MISSION,
      cycle_id: 'cycle-coverage-second',
      prng_seed: 9,
      operator: 'representation_shift',
      hypothesis: 'A fourth seed lands in an occupied cell.',
      mechanism: 'It re-uses the removal/prose/necessity tuple deliberately.',
      descriptor_bins: ['removal', 'prose', 'necessity', 'epistemic_ledger', 'kill_criterion'],
      evidence_refs: ['sig_x'],
      novelty_score: 0.5,
      coherence_score: 0.5,
      testability_score: 0.5,
      cheapest_test: 'Count the rows.',
      expected_information_gain: 0.5,
      parent_seed_ids: [],
      lineage_ref: 'lineage_cov_repeat',
    });
    const second = await archive.coverage(MISSION, OWNER.user_id, { cycleId: 'cycle-coverage-second' });
    expect(second.cells_total).toBe(3);
    expect(second.new_cells_this_cycle).toBe(0);
  });

  it('uses the newest cycle when the caller does not name one', async () => {
    const fixture = await seedFixture();
    void fixture;
    const archive = new IdeaArchiveService(db.asDb());
    await archive.admitOrReplace({
      seed_id: 'seed_latest',
      user_id: OWNER.user_id,
      mission_id: MISSION,
      cycle_id: 'cycle-latest',
      prng_seed: 1,
      operator: 'tool_invention',
      hypothesis: 'A probe makes the drain countable within one cycle.',
      mechanism: 'Instrumentation turns the drain into a row.',
      evidence_refs: ['sig_x'],
      novelty_score: 0.5,
      coherence_score: 0.5,
      testability_score: 0.5,
      cheapest_test: 'Add the probe.',
      expected_information_gain: 0.5,
      parent_seed_ids: [],
      lineage_ref: 'lineage_latest',
    });
    const coverage = await archive.coverage(MISSION, OWNER.user_id);
    expect(coverage.cycle_id).toBe('cycle-latest');
    expect(coverage.new_cells_this_cycle).toBe(1);
  });

  it('exposes every derived id and both descriptor forms consistently', () => {
    const { bins, descriptor_bins } = normalizeBins({ mechanism: 'removal', representation: 'not_a_bin' });
    expect(bins.mechanism).toBe('removal');
    expect(bins.representation).toBe('unclassified');
    expect(descriptor_bins).toEqual(DESCRIPTOR_DIMENSIONS.map((dimension) => bins[dimension]));
    expect(cellKeyFor(bins)).toContain('representation=unclassified');
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'));
  });
});

// ── M. the refinement pass ──────────────────────────────────────────────────

/**
 * The four weaknesses an independent verifier proved on the first ITER-6
 * revision, each pinned here by the test that FAILS against that revision:
 *
 *   1. PADDING DEFEATED THE DEDUPE GATE. Similarity was Jaccard behind
 *      `LENGTH_GUARD_RATIO = 0.5`, which returned 0 whenever one statement was
 *      more than twice the other's length — so a stored statement padded with
 *      800+ characters of filler was ADMITTED as new, and because novelty is
 *      `1 - max similarity` it also kept its model self-report. Containment
 *      over content tokens closes it: a padded restatement still contains every
 *      content token of the original.
 *   2. A SAME-CYCLE DUPLICATE WAS INVISIBLE. Two candidates with identical
 *      content derive the same seed id, so the second was "unchanged", counted
 *      as below incumbent, and `seeds_rejected` stayed 0 with no reason.
 *   3. `recordOutcome` MATCHED BY SEED ID ALONE when the identity was omitted
 *      (or empty), so it could append to another identity's lineage. The
 *      identity is now required and part of the lookup.
 *   4. THE CHANGED-PREMISE GATE WAS SHAPE-ONLY. "Nothing has changed here at
 *      all." is six words with a terminator, so it re-opened a ruled-out idea.
 */
describe('imagination archive — the refinement pass (padding, duplicates, identity, premises)', () => {
  /** Pure length: glue words around a restatement, nothing the claim lacked. */
  const PADDING = [
    'In addition to the above, and to state the same point at greater length in case it was not yet clear,',
    'the mission should keep in mind that the observations collected so far do not contradict the claim',
    'that has just been restated, that they remain compatible with it, that no measurement taken since',
    'then has separated it from the alternative reading, and that a longer statement of the same idea is',
    'still the same idea however much extra wording is wrapped around it at the end of the day. The same',
    'reading also holds for every neighbouring cycle, for the whole of the recorded window, and for each',
    'of the operational summaries the team has produced, none of which reports a quantity that would',
    'overturn the reading above, so the shorter and the longer statement still say the same thing.',
    'None of which is a measurement, and none of which makes the claim any newer than it already was.',
  ].join(' ');

  const seedInput = (overrides: Partial<IdeaSeedInput> & { seed_id: string }): IdeaSeedInput => ({
    user_id: OWNER.user_id,
    mission_id: MISSION,
    cycle_id: 'cycle-refinement',
    prng_seed: 1,
    operator: 'assumption_inversion',
    hypothesis: 'The plateau is caused by the nightly compaction job.',
    mechanism: 'Compaction rewrites the queue head and hides the drain for one cycle.',
    evidence_refs: ['sig_x'],
    novelty_score: 0.5,
    coherence_score: 0.5,
    testability_score: 0.5,
    cheapest_test: 'Count the queue head rewrites in one nightly window.',
    expected_information_gain: 0.5,
    parent_seed_ids: [],
    lineage_ref: `lineage_${overrides.seed_id}`,
    ...overrides,
  });

  const cellsOf = (): Array<Record<string, unknown>> => db.collection(CELLS).docs as Array<Record<string, unknown>>;
  const rowsOf = (): Array<Record<string, unknown>> => db.collection(SEEDS).docs as Array<Record<string, unknown>>;
  const rowFor = (seedId: string): Record<string, unknown> => {
    const row = rowsOf().find((candidate) => candidate.seed_id === seedId);
    expect(row, `no stored row for ${seedId}`).toBeTruthy();
    return row!;
  };

  // ── 1. padding ────────────────────────────────────────────────────────────

  it('rejects a padded restatement of a stored seed (containment survives padding)', async () => {
    // 800+ characters of padding — and still a row the schema accepts, so the
    // construction is one the real pipeline can produce (the batch normaliser
    // truncates a hypothesis at 1000 characters, the schema at 1000 too).
    expect(PADDING.length).toBeGreaterThan(800);
    const archive = new IdeaArchiveService(db.asDb());
    const base = seedInput({ seed_id: 'seed_padding_base' });
    expect((await archive.admitOrReplace(base)).decision).toBe('admitted');

    const padded = seedInput({
      seed_id: 'seed_padding_verbose',
      // The claim, verbatim, then 800+ characters of glue.
      hypothesis: `${base.hypothesis} ${PADDING}`,
      mechanism: `${base.mechanism} ${PADDING}`,
      // A DIFFERENT cell, so cell identity cannot be what catches this.
      descriptor_bins: ['removal', 'table', 'necessity', 'epistemic_ledger', 'kill_criterion'],
      novelty_score: 0.95,
      novelty_self_reported: 0.95,
    });
    expect(padded.hypothesis.length - base.hypothesis.length).toBeGreaterThan(800);
    expect(padded.hypothesis.length).toBeLessThanOrEqual(1000);

    // The measurement itself, reported on BOTH sides of the fix: the padded
    // pair shares every content token of the stored claim (containment 1), and
    // the archive's similarity is at or above the threshold — where the
    // length-guarded Jaccard reported 0 and admitted it.
    const measured = containmentMeasure(comparableText(base), comparableText(padded));
    expect(measured.value).toBe(1);
    expect(measured.shared.length).toBeGreaterThanOrEqual(8);
    expect(statementContainment(comparableText(base), comparableText(padded))).toBe(1);
    expect(statementSimilarity(comparableText(base), comparableText(padded))).toBe(1);
    expect(seedSimilarity(padded, base)).toBeGreaterThanOrEqual(PARAPHRASE_THRESHOLD);

    const result = await archive.admitOrReplace(padded);
    expect(result.decision).toBe('rejected');
    expect(['paraphrase_of', 'duplicate_of']).toContain(result.rejection?.reason);
    expect(result.rejection?.duplicate_of).toBe('seed_padding_base');
    // The rejection is durable: the padded row is stored as an exclusion, and
    // it still satisfies its own schema.
    expect(rowFor('seed_padding_verbose').state).toBe('rejected');
    expect(validateAgainst(SCHEMA_IDS.ideaSeed, rowFor('seed_padding_verbose')).valid).toBe(true);
    // …and it is stored with the version of the metric the archive documents:
    // a second, differently padded restatement collides with the first.
    const paddedAgain = seedInput({
      seed_id: 'seed_padding_verbose_2',
      hypothesis: `${base.hypothesis}${PADDING}`,
      mechanism: `${PADDING} ${base.mechanism}`,
      descriptor_bins: ['removal', 'list', 'necessity', 'epistemic_ledger', 'kill_criterion'],
    });
    expect((await archive.admitOrReplace(paddedAgain)).decision).toBe('rejected');
    // The library of cells is untouched by any of it: no admission happened.
    expect(cellsOf()).toHaveLength(1);
  });

  it('rejects a padded restatement of an exclusion region too', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    const exclusions: ExclusionRegion[] = [
      { kind: 'rejected_hypothesis', text: 'The plateau is caused by the nightly compaction job.', ref: 'ent_padding_region' },
    ];
    const padded = seedInput({
      seed_id: 'seed_padding_region',
      hypothesis: `The plateau is caused by the nightly compaction job. ${PADDING}`,
      mechanism: 'Stating the ruled-out claim at length adds no measurement the ruling lacked.',
      descriptor_bins: ['removal', 'list', 'necessity', 'epistemic_ledger', 'kill_criterion'],
    });
    const result = await archive.admitOrReplace(padded, { exclusions });
    expect(result.decision).toBe('rejected');
    expect(result.rejection?.reason).toBe('excluded_region');
    expect(result.rejection?.duplicate_of).toBe('ent_padding_region');
    expect(rowFor('seed_padding_region').state).toBe('rejected');
  });

  it('still admits a genuinely different long text (the fix does not over-block)', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    const base = seedInput({ seed_id: 'seed_contrast_base' });
    expect((await archive.admitOrReplace(base)).decision).toBe('admitted');

    const different = seedInput({
      seed_id: 'seed_contrast_long',
      hypothesis:
        'Paper dust on the filing-cabinet runner jams the drawer every time the humidity in the records room climbs above the monthly threshold recorded by the building log.',
      mechanism:
        'Dust agglutinates into a waxy film whose friction coefficient rises with moisture, so the drawer binds exactly when the air is damp and releases again as it dries out overnight; the jam is therefore a property of the room and not of the cabinet.',
      descriptor_bins: ['substitution', 'prose', 'scarcity', 'external_observation', 'observation_study'],
    });

    const baseText = comparableText(base);
    const otherText = comparableText(different);
    // The construction really is the haiku-versus-paragraph shape the length
    // guard was written for (the texts differ by more than half the longer one)
    // — but the CONTENT is different, which is the case the guard may refuse.
    expect(Math.abs(baseText.length - otherText.length)).toBeGreaterThan(
      LENGTH_GUARD_RATIO * Math.max(baseText.length, otherText.length),
    );
    expect(containmentMeasure(baseText, otherText).shared).toEqual([]);
    expect(statementContainment(baseText, otherText)).toBe(0);
    expect(seedSimilarity(different, base)).toBeLessThan(PARAPHRASE_THRESHOLD);

    const result = await archive.admitOrReplace(different);
    expect(result.decision).toBe('admitted');
    expect(result.seed?.state).toBe('admitted');
    expect((await archive.getSeeds(OWNER.user_id, MISSION)).map((seed) => seed.seed_id).sort()).toEqual([
      'seed_contrast_base',
      'seed_contrast_long',
    ]);
  });

  it('measures a padded restatement against the archive, not against its self-report', async () => {
    const fixture = await seedFixture();
    const { trace, inventory, exclusions } = await loadFixtureForGeneration(fixture);
    process.env.FOCUSED_IMAGINATION_MAX_OPERATORS = '10';
    process.env.FOCUSED_IMAGINATION_MAX_LLM_CALLS = '5';

    // The archive already holds the idea — under its own text, nothing padded.
    const archive = new IdeaArchiveService(db.asDb());
    const knownText = OPERATOR_TEXT.tool_invention;
    const known = await archive.admitOrReplace(
      {
        seed_id: 'seed_padding_known',
        user_id: OWNER.user_id,
        mission_id: fixture.missionId,
        cycle_id: 'cycle-before-padding',
        prng_seed: 1,
        operator: 'tool_invention',
        hypothesis: knownText.hypothesis,
        mechanism: knownText.mechanism,
        evidence_refs: ['sig_x'],
        novelty_score: 0.8,
        novelty_self_reported: 0.8,
        coherence_score: 0.7,
        testability_score: 0.6,
        cheapest_test: knownText.test,
        expected_information_gain: 0.5,
        parent_seed_ids: [],
        lineage_ref: 'lineage_padding_known',
      },
      { exclusions },
    );
    expect(known.decision).toBe('admitted');

    // The model restates it and pads it — and reports novelty 0.95.
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return focusedOutput(prompt);
      const signalId = offeredSignalIds(prompt)[0] ?? '';
      return {
        seeds: requestedOperators(prompt).map((operator, index) => {
          const seed = bridgeFields(prompt, operator, seedForOperator(operator, signalId, index));
          if (operator !== 'tool_invention') return seed;
          return {
            ...seed,
            hypothesis: `${knownText.hypothesis} ${PADDING}`,
            mechanism: `${knownText.mechanism} ${PADDING}`,
            novelty: 0.95,
            coherence: 0.7,
            testability: 0.6,
          };
        }),
      };
    };

    const generated = await generateImaginationSeeds(db.asDb(), {
      trace,
      inventory,
      exclusions,
      seed: 'padding-novelty-probe',
      budget: { max_operators: 10, max_seeds: 10, max_llm_calls: 5 },
    });
    expect(generated.operators_run).toContain('tool_invention');
    const padded = generated.seeds.find((seed) => seed.hypothesis.includes('In addition to the above'));
    expect(padded).toBeTruthy();
    expect(padded!.novelty_self_reported).toBe(0.95);
    // The archive measured the restatement: nothing is left unexplored, so the
    // novelty is 0 rather than the 0.95 the model claimed. Before the fix the
    // padded pair scored 0 similarity and the self-report survived intact.
    expect(padded!.novelty_score).toBe(0);

    const admission = await archive.admitOrReplace(padded!, { exclusions });
    expect(admission.decision).toBe('rejected');
    const row = rowFor(padded!.seed_id);
    expect(row.state).toBe('rejected');
    expect(row.novelty_score).toBe(0);
    expect(row.novelty_self_reported).toBe(0.95);
  });

  // ── 2. identical-content duplicates inside one cycle ──────────────────────

  it('reports a same-content duplicate inside one cycle instead of hiding it', async () => {
    const fixture = await seedFixture();
    respond = async (system, prompt) => {
      if (system.includes('focused-consolidation faculty')) return focusedOutput(prompt);
      const signalId = offeredSignalIds(prompt)[0] ?? '';
      const operator = requestedOperators(prompt)[0];
      const seed = bridgeFields(prompt, operator, seedForOperator(operator, signalId, 0));
      // The same content twice. Every id here is DERIVED from the content, so
      // both candidates are one seed — which is what makes this the case the
      // old revision counted as "below incumbent" with no reason at all.
      return { seeds: [seed, { ...seed }] };
    };

    const result = await runImaginationCycle(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-same-content',
      actorId: OWNER.user_id,
      seed: 'same-content-seed',
      budget: { max_llm_calls: 1 },
    });

    expect(result.status).toBe('completed');
    expect(result.seeds_generated).toBe(2);
    // One seed exists, one row is stored…
    expect(result.seeds).toHaveLength(1);
    expect(rowsOf()).toHaveLength(1);
    // …and the dedupe that really happened is REPORTED, with a reason and the
    // id it collided with (its own: the id is the content).
    expect(result.rejections).toHaveLength(1);
    const [rejection] = result.rejections;
    expect(rejection.seed_id).toBe(result.seeds[0].seed_id);
    expect(rejection.reason).toBe('duplicate_of');
    expect(rejection.duplicate_of).toBe(result.seeds[0].seed_id);
    expect(rejection.detail).toMatch(/identical content/);
    expect(result.seeds_rejected).toBe(1);
    expect(result.run.seeds_rejected).toBe(1);
    // Nothing is left hiding in the "below incumbent" bucket, which is where a
    // duplicate used to disappear.
    expect(result.seeds_below_incumbent).toBe(0);
    expect(result.run.seeds_below_incumbent).toBe(0);
  });

  // ── 3. the identity on recordOutcome ─────────────────────────────────────

  it('requires the identity on recordOutcome and refuses another identity’s lineage', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    await archive.admitOrReplace(seedInput({ seed_id: 'seed_identity' }));

    // The identity is REQUIRED. "No identity" is a caller error — it must never
    // mean "match whatever identity owns this id" and append to its lineage.
    await expect(archive.recordOutcome('seed_identity', { verdict: 'refuted' }, '')).rejects.toThrow(
      /userId is required/,
    );
    await expect(archive.recordOutcome('seed_identity', { verdict: 'refuted' }, '   ')).rejects.toThrow(
      /userId is required/,
    );

    // A cross-identity attempt finds no seed, writes nothing, and leaves the
    // owner's lineage byte-identical.
    const lineagesBefore = JSON.stringify(db.collection(LINEAGES).docs);
    const seedsBefore = JSON.stringify(rowsOf());
    expect(
      await archive.recordOutcome('seed_identity', { verdict: 'refuted', failure_signature: 'stolen' }, OTHER.user_id),
    ).toBeNull();
    expect(JSON.stringify(db.collection(LINEAGES).docs)).toBe(lineagesBefore);
    expect(JSON.stringify(rowsOf())).toBe(seedsBefore);

    // The owner's own call works, and lands on the owner's lineage only.
    const lineage = await archive.recordOutcome('seed_identity', { verdict: 'refuted' }, OWNER.user_id);
    expect(lineage?.user_id).toBe(OWNER.user_id);
    expect(lineage?.results).toHaveLength(1);
    expect(lineage?.failure_signatures).toHaveLength(1);
    expect(JSON.stringify(db.collection(LINEAGES).docs)).not.toBe(lineagesBefore);
    // A missing seed is still an absent record, not an error.
    expect(await archive.recordOutcome('seed_identity_missing', { verdict: 'confirmed' }, OWNER.user_id)).toBeNull();
  });

  // ── 4. the changed-premise gate ──────────────────────────────────────────

  it('refuses a vacuous changed premise and a premise that only restates the rejected text', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    const exclusions: ExclusionRegion[] = [
      { kind: 'excluded_region', text: 'The plateau is caused by the nightly compaction job.', ref: 'ent_excluded' },
    ];
    const base = seedInput({
      seed_id: 'seed_premise_vacuous',
      hypothesis: 'The plateau is caused by the nightly compaction job.',
      mechanism: 'Compaction rewrites the queue head and hides the drain for one cycle.',
    });

    // "Nothing has changed here at all." is six words and a terminator: shape
    // alone is satisfied, which is exactly why shape alone used to open it.
    const vacuous = 'Nothing has changed here at all.';
    expect(isCompletePremise(vacuous)).toBe(true);
    expect(isVacuousPremise(vacuous)).toBe(true);
    expect(vacuousPremisePhrase(vacuous)).toBe('nothing has changed');
    expect(NO_CHANGE_PHRASES).toContain('nothing has changed');

    const vacuousResult = await archive.admitOrReplace(
      { ...base, changed_premise: vacuous, parent_seed_ids: ['ent_excluded'] },
      { exclusions, premise: vacuous },
    );
    expect(vacuousResult.decision).toBe('rejected');
    expect(vacuousResult.rejection?.reason).toBe('vacuous_changed_premise');
    expect(vacuousResult.rejection?.detail).toMatch(/nothing has changed/);
    expect(rowFor('seed_premise_vacuous').state).toBe('rejected');

    // The edge case: a premise that is a complete sentence but only restates
    // the text it is re-opening introduces no change at all.
    const restatement = 'The plateau is caused by the nightly compaction job.';
    expect(isCompletePremise(restatement)).toBe(true);
    expect(isVacuousPremise(restatement)).toBe(false);
    expect(newContentTokens(restatement, [exclusions[0].text])).toEqual([]);

    const restatedResult = await archive.admitOrReplace(
      { ...base, seed_id: 'seed_premise_restated', changed_premise: restatement, parent_seed_ids: ['ent_excluded'] },
      { exclusions, premise: restatement },
    );
    expect(restatedResult.decision).toBe('rejected');
    expect(restatedResult.rejection?.reason).toBe('premise_restates_exclusion');
    expect(restatedResult.rejection?.detail).toMatch(/introduces 0 content token/);
    expect(rowFor('seed_premise_restated').state).toBe('rejected');
    // Neither rejection is an admission: the cell was never created.
    expect(cellsOf()).toHaveLength(0);
  });

  it('admits a genuine changed premise that names what changed', async () => {
    const archive = new IdeaArchiveService(db.asDb());
    const exclusions: ExclusionRegion[] = [
      { kind: 'excluded_region', text: 'The plateau is caused by the nightly compaction job.', ref: 'ent_excluded' },
    ];
    const genuine = 'The compaction window moved to Saturday, and the drain is now instrumented every cycle.';
    expect(isCompletePremise(genuine)).toBe(true);
    expect(isVacuousPremise(genuine)).toBe(false);
    const introduced = newContentTokens(genuine, [exclusions[0].text]);
    expect(introduced).toContain('saturday');
    expect(introduced).toContain('instrumented');
    expect(introduced.length).toBeGreaterThanOrEqual(MIN_CHANGED_PREMISE_TOKENS);
    // The excluded text's own words are not "new", whatever their length.
    expect(introduced).not.toContain('compaction');
    expect([...contentTokens(genuine, MIN_PREMISE_TOKEN_CHARS)]).toContain('compaction');

    const result = await archive.changedPremiseReentry(
      {
        ...seedInput({ seed_id: 'seed_premise_genuine' }),
        hypothesis: 'The plateau is caused by the nightly compaction job.',
        mechanism: 'Compaction rewrites the queue head and hides the drain for one cycle.',
        parent_seed_ids: ['ent_excluded'],
      },
      genuine,
      { exclusions },
    );
    expect(result.decision).toBe('admitted');
    expect(result.seed?.changed_premise).toBe(genuine);
    expect(result.history?.event).toBe('changed_premise_reentry');
    expect(result.history?.prior_rejection_id).toBe('ent_excluded');
    expect(rowFor('seed_premise_genuine').state).toBe('admitted');
  });
});
