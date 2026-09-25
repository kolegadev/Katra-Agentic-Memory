/**
 * The ITER-7 test scenario: a real mission (state, ledger, work queue, a small
 * knowledge graph) plus REAL ITER-5 and ITER-6 stub model outputs, so the
 * cycle / baton / adapter / outcome suites all run the production code paths
 * (only `llmService.extractJson` is stubbed — no network, no provider).
 *
 * It is a helper module rather than a copy per suite because ITER-7 has three
 * suites that must agree on the fixture: if the mission the cycle test calls
 * "stalled" were built differently in the security suite, neither would prove
 * anything about the other.
 */
import { FakeDb } from './fake-mongo.js';
import { MissionStateService } from '../../src/services/mission-cognition/mission-state-service.js';
import { StateDeltaService } from '../../src/services/mission-cognition/state-delta-service.js';
import { FocusedConsolidationService, runFocusedConsolidation } from '../../src/services/processing/focused-consolidation-service.js';
import { IdeaArchiveService, type IdeaSeedInput } from '../../src/services/processing/idea-archive-service.js';

export const SCENARIO_MISSION = 'mission_creative_baton';
export const OPERATOR_USER = 'agent-a';
export const OTHER_USER = 'agent-b';

export interface Scenario {
  missionId: string;
  rejectedEntryId: string;
  traceId: string;
}

// ── The stub model ──────────────────────────────────────────────────────────

/** The trace-signal ids the prompt actually offered. */
export function offeredSignalIds(prompt: string): string[] {
  return [...prompt.matchAll(/^- \[(sig_[0-9a-f]+)\]/gm)].map((match) => match[1]);
}

/** The operator families a prompt asked for in this batch. */
export function requestedOperators(prompt: string): string[] {
  const match = prompt.match(/Produce the seeds for \[([^\]]+)\] now/);
  if (!match) return [];
  return match[1].split(',').map((name) => name.trim()).filter(Boolean);
}

/** Distinct descriptor bins per operator, so a plan of six spans six cells. */
export const OPERATOR_BINS: Record<string, Record<string, string>> = {
  assumption_inversion: { mechanism: 'removal', representation: 'prose', violated_assumption: 'necessity', evidence_family: 'epistemic_ledger', test_strategy: 'kill_criterion' },
  representation_shift: { mechanism: 'relocation', representation: 'table', violated_assumption: 'sufficiency', evidence_family: 'operational_state', test_strategy: 'instrumentation' },
  distant_analogy: { mechanism: 'composition', representation: 'graph', violated_assumption: 'independence', evidence_family: 'external_observation', test_strategy: 'observation_study' },
  constraint_mutation: { mechanism: 'substitution', representation: 'list', violated_assumption: 'scarcity', evidence_family: 'work_queue', test_strategy: 'ab_test' },
  boundary_extreme: { mechanism: 'amplification', representation: 'numeric', violated_assumption: 'stability', evidence_family: 'temporal_series', test_strategy: 'simulation' },
  causal_reversal: { mechanism: 'reversal', representation: 'protocol', violated_assumption: 'identity', evidence_family: 'trace_absence', test_strategy: 'cheapest_probe' },
};

/** What each operator claims — genuinely different ideas, not one restated. */
export const OPERATOR_TEXT: Record<string, { hypothesis: string; mechanism: string; test: string }> = {
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
};

/** One stub seed for an operator, with its own claim and descriptor tuple. */
export function seedForOperator(operator: string, signalId: string, overrides: Record<string, unknown> = {}) {
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
export function bridgeFields(prompt: string, operator: string, seed: Record<string, unknown>): Record<string, unknown> {
  if (operator !== 'distant_analogy' && operator !== 'random_semantic_bridge') return seed;
  const path = [...prompt.matchAll(/^- (bridge_[0-9a-f]+) \(\d+ hops\): (.+)$/gm)].map((match) => match[2].split(' → '))[0];
  return {
    ...seed,
    bridge_path: path ?? ['unknown'],
    bridge: `Both ends are queues that starve the same way (${(path ?? ['unknown']).join(' → ')}).`,
  };
}

/** The default imagination stub: one seed per requested operator. */
export function imaginationOutput(prompt: string): Record<string, unknown> {
  const signalId = offeredSignalIds(prompt)[0] ?? '';
  return {
    seeds: requestedOperators(prompt).map((operator) =>
      bridgeFields(prompt, operator, seedForOperator(operator, signalId)),
    ),
  };
}

/** The ITER-5 focused-consolidation stub: one signal per kind. */
export function focusedOutput(prompt: string): Record<string, unknown> {
  const missionId = prompt.match(/^- id: (\S+)/m)?.[1] ?? SCENARIO_MISSION;
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

/** The default router: focused-consolidation prompts get the ITER-5 stub. */
export function defaultResponder(system: string, prompt: string): Record<string, unknown> {
  return system.includes('focused-consolidation faculty') ? focusedOutput(prompt) : imaginationOutput(prompt);
}

// ── The fixture ─────────────────────────────────────────────────────────────

export interface SeedOptions {
  graph?: boolean;
  /**
   * The mission to build. Defaults to `SCENARIO_MISSION`; a suite that needs a
   * SECOND mission over the same store (the ITER-7 cycle-id collision, which
   * needs two missions sharing a mission version and a cycle ordinal) passes its
   * own id, and every row this helper writes carries it.
   */
  missionId?: string;
  /** Mission status to create it with (a terminal mission is a stop condition). */
  status?: 'active' | 'paused' | 'completed' | 'cancelled';
  /** Admitted candidates to pre-fill (each in its own descriptor cell). */
  candidates?: number;
  /** Live contradictions to pre-fill. */
  contradictions?: number;
}

/** Distinct bins per pre-filled candidate, so each one owns a cell. */
const CANDIDATE_BINS: Record<string, string>[] = [
  { mechanism: 'removal', representation: 'prose', violated_assumption: 'necessity', evidence_family: 'epistemic_ledger', test_strategy: 'kill_criterion' },
  { mechanism: 'substitution', representation: 'list', violated_assumption: 'scarcity', evidence_family: 'work_queue', test_strategy: 'ab_test' },
  { mechanism: 'reversal', representation: 'protocol', violated_assumption: 'identity', evidence_family: 'trace_absence', test_strategy: 'cheapest_probe' },
  { mechanism: 'amplification', representation: 'numeric', violated_assumption: 'stability', evidence_family: 'temporal_series', test_strategy: 'simulation' },
  { mechanism: 'relocation', representation: 'table', violated_assumption: 'sufficiency', evidence_family: 'operational_state', test_strategy: 'instrumentation' },
  { mechanism: 'composition', representation: 'graph', violated_assumption: 'independence', evidence_family: 'external_observation', test_strategy: 'observation_study' },
  { mechanism: 'removal', representation: 'table', violated_assumption: 'independence', evidence_family: 'work_queue', test_strategy: 'simulation' },
  { mechanism: 'composition', representation: 'numeric', violated_assumption: 'scarcity', evidence_family: 'operational_state', test_strategy: 'cheapest_probe' },
];

/**
 * A DERIVED-ID-SHAPED seed id (`<kind>_<32 hex>`) — the shape every id this
 * repo writes has, and the shape the baton compiler requires before it will
 * carry an id into a shared packet.
 */
export function derivedShapedId(kind: string, index: number): string {
  return `${kind}_${String(index + 1)
    .padStart(2, '0')
    .repeat(16)
    .slice(0, 32)}`;
}

export function prefilledSeedId(index: number): string {
  return derivedShapedId('seed', index);
}

/**
 * Distinct claims: the archive rejects paraphrases, so pre-filled candidates
 * that differed only by a digit would collapse into one cell and one rejection.
 */
const CANDIDATE_TEXT: Array<{ hypothesis: string; mechanism: string; test: string }> = [
  {
    hypothesis: 'The drain becomes countable once the probe is on the queue head.',
    mechanism: 'A counter on the queue head turns an unmeasured outflow into a row the plateau rule can compare.',
    test: 'Read the probe after one cycle and compare it with the plateau marker.',
  },
  {
    hypothesis: 'Two writers race for the queue head and the loser drops its claim silently.',
    mechanism: 'The dropped claim is the missing drain, so the queue starves while nothing reports it.',
    test: 'Log both writers for one cycle and count the claims that never landed.',
  },
  {
    hypothesis: 'The plateau is a reporting artefact of averaging over an unequal set of cycles.',
    mechanism: 'A bimodal distribution under a mean looks flat, so the plateau is where the split sits.',
    test: 'Plot the last five cycles as a table and look for the bimodal split.',
  },
  {
    hypothesis: 'Loosening the approval constraint removes the plateau entirely.',
    mechanism: 'Approval latency, not the queue itself, accumulates during the plateau window.',
    test: 'Raise the approval concurrency for one cycle and measure the plateau length.',
  },
  {
    hypothesis: 'At zero drain capacity the queue never recovers, and above one drain per cycle it never plateaus.',
    mechanism: 'The two extremes bracket the regime change, so walking the boundary locates it.',
    test: 'Run one cycle at the boundary value and record whether the queue recovers.',
  },
  {
    hypothesis: 'The plateau causes the missing claims rather than the missing claims causing the plateau.',
    mechanism: 'Reversing the arrow predicts claims stop BEFORE lengths rise, not after.',
    test: 'Order the two event streams by timestamp and check which one leads.',
  },
  {
    hypothesis: 'Paper dust on the filing-cabinet runner jams the drawer when the records room is damp.',
    mechanism: 'Dust agglutinates into a waxy film whose friction rises with moisture, so the drawer binds exactly when the air is wet.',
    test: 'Log the room humidity against the jam timestamps for one week.',
  },
  {
    hypothesis: 'The nightly rewrite storm and the plateau are two views of one compaction pass.',
    mechanism: 'Suppressing one rewrite pass flattens both curves at once if they share a cause.',
    test: 'Suppress one rewrite pass and compare the two curves.',
  },
];

export function candidateSeed(index: number, overrides: Partial<IdeaSeedInput> = {}): IdeaSeedInput {
  const text = CANDIDATE_TEXT[index % CANDIDATE_TEXT.length];
  return {
    seed_id: prefilledSeedId(index),
    user_id: OPERATOR_USER,
    mission_id: SCENARIO_MISSION,
    cycle_id: 'cycle_prefilled',
    prng_seed: 7,
    operator: 'assumption_inversion',
    hypothesis: text.hypothesis,
    mechanism: text.mechanism,
    descriptor_bins: CANDIDATE_BINS[index % CANDIDATE_BINS.length] as unknown as string[],
    evidence_refs: ['sig_prefilled'],
    novelty_score: 0.8,
    coherence_score: 0.7,
    testability_score: 0.6,
    cheapest_test: text.test,
    expected_information_gain: 0.5,
    parent_seed_ids: [],
    lineage_ref: derivedShapedId('lineage', index),
    ...overrides,
  };
}

/**
 * Seed the mission: state, a ledger with one REJECTED hypothesis (an
 * exclusion), a work queue, a small knowledge graph, optional pre-filled
 * candidates and contradictions. NO model call — callers that need a trace use
 * `seedScenario`, which adds one.
 */
export async function seedMission(
  db: FakeDb,
  options: SeedOptions & { ownerId?: string } = {},
): Promise<Scenario> {
  const ownerId = options.ownerId ?? OPERATOR_USER;
  const missionId = options.missionId ?? SCENARIO_MISSION;
  const forged = db.asDb();
  const missions = new MissionStateService(forged);
  const deltas = new StateDeltaService(forged);

  await missions.createMissionState({
    schema_version: '1.0',
    mission_id: missionId,
    title: 'Prove the creative baton invariants',
    intent: 'Turn a stalled mission into exactly one cycle, a sanitised baton and controller work.',
    status: options.status ?? 'active',
    owner_id: ownerId,
    success_criteria: [
      { id: 'c1', description: 'one cycle per plateau', status: 'unmet' },
      { id: 'c2', description: 'no private text crosses', status: 'unmet' },
    ],
    stop_conditions: ['any shared write before promotion'],
    constraints: [{ id: 'k1', kind: 'privacy', description: 'never write a shared scope before promotion' }],
    authority_class: 'B',
    objectives: [{ id: 'o1', description: 'plan the operators from the trace', status: 'in_progress', owner_id: ownerId }],
  } as never);

  const first = await deltas.submitDelta(
    {
      schema_version: '1.0',
      idempotency_key: `${missionId}_creative_baton_fixture_0001`,
      mission_id: missionId,
      base_mission_version: 1,
      author_id: ownerId,
      delta_type: 'HYPOTHESIS_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'h1' }],
      rationale: 'record the working hypothesis',
      confidence: 0.7,
      ledger_entries: [
        {
          schema_version: '1.0',
          mission_id: missionId,
          entry_type: 'hypothesis',
          status: 'active',
          author_id: ownerId,
          confidence: 0.7,
          statement: 'The queue starves because the plateau trigger never fires.',
          consequence_if_false: 'high',
        } as never,
      ],
    },
    { actorId: ownerId },
  );

  const second = await deltas.submitDelta(
    {
      schema_version: '1.0',
      idempotency_key: `${missionId}_creative_baton_fixture_0002`,
      mission_id: missionId,
      base_mission_version: 2,
      author_id: ownerId,
      delta_type: 'HYPOTHESIS_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'h2' }],
      rationale: 'record the hypothesis that was ruled out',
      confidence: 0.3,
      ledger_entries: [
        {
          schema_version: '1.0',
          mission_id: missionId,
          entry_type: 'hypothesis',
          status: 'rejected',
          author_id: ownerId,
          confidence: 0.2,
          statement: 'The plateau is caused by the nightly compaction job.',
          consequence_if_false: 'moderate',
        } as never,
        {
          schema_version: '1.0',
          mission_id: missionId,
          entry_type: 'decision',
          status: 'accepted',
          author_id: ownerId,
          confidence: 0.6,
          statement: 'Keep the manual trigger until the drain is measured.',
          consequence_if_false: 'high',
        } as never,
      ],
    },
    { actorId: ownerId },
  );

  for (let index = 0; index < (options.contradictions ?? 0); index += 1) {
    const delta = await deltas.submitDelta(
      {
        schema_version: '1.0',
        idempotency_key: `${missionId}_creative_baton_fixture_contradiction_${index}`,
        mission_id: missionId,
        base_mission_version: 3 + index,
        author_id: ownerId,
        delta_type: 'EVIDENCE_ADDED',
        operations: [{ op: 'add', path: '/ledger_refs/-', value: `c${index}` }],
        rationale: 'record the contradicting evidence',
        confidence: 0.5,
        ledger_entries: [
          {
            schema_version: '1.0',
            mission_id: missionId,
            entry_type: 'contradiction',
            status: 'active',
            author_id: ownerId,
            confidence: 0.5,
            statement: `Observation ${index} contradicts the accepted decision.`,
          } as never,
        ],
      },
      { actorId: ownerId },
    );
    void delta;
  }

  db.collection('cognitive_work_items').docs.push({
    schema_version: '1.0',
    work_item_id: `wi_creative_baton_${missionId}`,
    mission_id: missionId,
    description: 'Measure the drain the queue is starving behind.',
    mode: 'monitor',
    status: 'queued',
    authority_class: 'B',
    trigger: 'manual',
    features: { mission_impact: 1, uncertainty: 0, information_value: 1, dependency_centrality: 0, urgency: 1, cognitive_cost: 1, cost_basis: 'measured-tokens-zero-observed' },
    created_at: new Date('2026-09-20T00:00:00.000Z').toISOString(),
    updated_at: new Date('2026-09-20T00:00:00.000Z').toISOString(),
  });

  if (options.graph !== false) {
    const nodes = [
      { id: 'node_a', properties: { name: 'Queue health' } },
      { id: 'node_b', properties: { name: 'Drain measurement' } },
      { id: 'node_c', properties: { name: 'Plateau detector' } },
      { id: 'node_d', properties: { name: 'Nightly compaction' } },
    ];
    for (const node of nodes) {
      db.collection('knowledge_nodes').docs.push({ ...node, user_id: ownerId, node_type: 'concept' });
    }
    for (const edge of [
      { id: 'edge_ab', from_id: 'node_a', to_id: 'node_b' },
      { id: 'edge_bc', from_id: 'node_b', to_id: 'node_c' },
      { id: 'edge_cd', from_id: 'node_c', to_id: 'node_d' },
      { id: 'edge_da', from_id: 'node_d', to_id: 'node_a' },
    ]) {
      db.collection('knowledge_relationships').docs.push({
        ...edge,
        user_id: ownerId,
        relationship_type: 'relates',
        strength: 1,
      });
    }
  }

  if ((options.candidates ?? 0) > 0) {
    const archive = new IdeaArchiveService(forged);
    for (let index = 0; index < options.candidates!; index += 1) {
      const result = await archive.admitOrReplace(candidateSeed(index, { mission_id: missionId }));
      if (result.decision === 'rejected') {
        throw new Error(`prefilled candidate ${index} was rejected: ${result.rejection?.reason}`);
      }
    }
  }

  const rejectedEntryId = second.ledger_entries?.find((entry) => entry.status === 'rejected')?.entry_id ?? '';
  void first;
  return { missionId, rejectedEntryId, traceId: '' };
}

/**
 * `seedMission` plus a REAL ITER-5 trace through the service (so the fixture's
 * cycle input is the production artifact, not a hand-built object).
 */
export async function seedScenario(
  db: FakeDb,
  options: SeedOptions & { ownerId?: string } = {},
): Promise<Scenario> {
  const seeded = await seedMission(db, options);
  const ownerId = options.ownerId ?? OPERATOR_USER;
  const missionId = options.missionId ?? SCENARIO_MISSION;
  const focused = await runFocusedConsolidation(db.asDb(), {
    userId: ownerId,
    missionId,
    cycleId: `fixture_trace_cycle:${missionId}`,
    actorId: ownerId,
  });
  if (focused.status !== 'completed') {
    throw new Error(`fixture trace failed: ${focused.error ?? 'unknown'}`);
  }
  return { ...seeded, traceId: focused.trace_id! };
}

/** The newest trace of the mission, as the cycle's baton compiler would read it. */
export async function newestTrace(db: FakeDb, userId = OPERATOR_USER, missionId = SCENARIO_MISSION) {
  const traces = await new FocusedConsolidationService(db.asDb()).getTraces(userId, { missionId, limit: 1 });
  return traces[0] ?? null;
}

/** A path that exists on disk for the source-level guard. */
export function sourcePath(file: string): string {
  return new URL(`../../src/services/processing/${file}`, import.meta.url).pathname;
}
