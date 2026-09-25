/**
 * ITER-5 — Focused consolidation + the private Salience Trace (Phase 3).
 * Contract: CONTRACT-iter5-focused-consolidation.md.
 *
 * What is proved here, against the REAL service, the REAL evidence resolver and
 * the REAL MCP dispatch gate (only `llmService.extractJson` is stubbed — no
 * network, no provider):
 *
 *   A. gather + run  — a frozen mission fixture (mission state, an accepted
 *      delta, ledger entries, a deterministic fired trigger, a live baton, a
 *      queued work item, and journal/reflection rows for TWO identities)
 *      yields a schema-valid, evidence-linked, calibrated trace;
 *   B. idempotency   — a replay of the same {missionId, cycleId} returns the
 *      recorded trace with NO model call and NO new documents, and a
 *      concurrent duplicate still produces exactly one call and one trace;
 *   C. fail loudly  — a failed or unusable model output records a `failed` run
 *      with the error and writes ZERO traces; a later cycle succeeds;
 *   D. calibration  — hostile outputs (out of range, NaN, missing fields,
 *      extra keys, wrong types) are clamped, flagged, counted or dropped —
 *      never crashing, never stored out of bounds;
 *   E. determinism  — `problem_state_digest` is identical for identical
 *      gathered state and is not a function of the model output;
 *   F. privacy      — no `shared_id` on either collection, the journal /
 *      reflection / consolidation_runs collections are byte-identical
 *      before and after a run, the model prompt never carries journal text,
 *      and a source-level guard proves the module imports no journal or
 *      reflection writer;
 *   G. the flag     — with FOCUSED_IMAGINATION off the tools are absent and
 *      the dispatch throws the plain unknown-tool error, writing nothing.
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
import { BatonService } from '../../src/services/mission-cognition/baton-service.js';
import { validateAgainst, SCHEMA_IDS } from '../../src/services/mission-cognition/schema-registry.js';
import {
  FocusedConsolidationService,
  computeProblemStateDigest,
  defaultCycleId,
  focusedIdempotencyKey,
  gatherFocusedInputs,
  normalizeSignals,
  runFocusedConsolidation,
  type SalienceSignal,
} from '../../src/services/processing/focused-consolidation-service.js';
import {
  FOCUSED_TOOL_NAMES,
  dispatchFocusedTool,
} from '../../src/services/processing/focused-consolidation-tools.js';
import { FOCUSED_CONSOLIDATION_COLLECTIONS } from '../../src/services/processing/focused-consolidation-collections.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const TRACES = FOCUSED_CONSOLIDATION_COLLECTIONS.salienceTraces;
const RUNS = FOCUSED_CONSOLIDATION_COLLECTIONS.focusedRuns;
const OWNER: CallerIdentity = { user_id: 'agent-a', trusted: false };
const OTHER: CallerIdentity = { user_id: 'agent-b', trusted: false };
/** Collections that must never change because of a focused run. */
const JOURNAL_FAMILY = ['reflective_journals', 'reflection_nodes', 'reflection_edges', 'consolidation_runs'];

let db: FakeDb;
let extractJson: ReturnType<typeof vi.spyOn>;
let serviceStatus: ReturnType<typeof vi.spyOn>;
/** The handler each test installs; the spy records every call. */
let respond: (system: string, prompt: string, maxTokens: number) => Promise<Record<string, unknown>>;
const prompts: string[] = [];

const llmCalls = () => extractJson.mock.calls.length;

function txt(result: { type: string; text: string }[]): string {
  return result.map((r) => r.text).join('\n');
}

function freeze(): string {
  return JSON.stringify(
    Object.fromEntries(JOURNAL_FAMILY.map((name) => [name, db.collection(name).docs])),
  );
}

async function seedFixture(): Promise<{
  missionId: string;
  entryIds: string[];
  deltaIds: string[];
  workItemId: string;
  batonId: string;
}> {
  const forged = db.asDb();
  const missions = new MissionStateService(forged);
  const deltas = new StateDeltaService(forged);
  const batons = new BatonService(forged);
  const missionId = 'mission_focused_fixture';

  await missions.createMissionState({
    schema_version: '1.0',
    mission_id: missionId,
    title: 'Keep the long-horizon loop honest',
    intent: 'Prove the focused consolidation invariants against a frozen fixture.',
    status: 'active',
    owner_id: OWNER.user_id,
    success_criteria: [
      { id: 'c1', description: 'the trace is evidence-linked', status: 'unmet' },
      { id: 'c2', description: 'no journal text leaks', status: 'unmet' },
    ],
    stop_conditions: ['any shared write'],
    constraints: [{ id: 'k1', kind: 'privacy', description: 'never store raw reflections' }],
    authority_class: 'B',
    objectives: [
      { id: 'o1', description: 'gather the real mission state', status: 'completed', owner_id: OWNER.user_id },
      { id: 'o2', description: 'calibrate the trace', status: 'in_progress', owner_id: OWNER.user_id },
    ],
  } as never);

  const first = await deltas.submitDelta(
    {
      schema_version: '1.0',
      idempotency_key: 'fixture_delta_0001',
      mission_id: missionId,
      base_mission_version: 1,
      author_id: OWNER.user_id,
      delta_type: 'HYPOTHESIS_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'h1' }],
      rationale: 'record the working hypothesis',
      confidence: 0.7,
      ledger_entries: [
        {
          schema_version: '1.0',
          mission_id: missionId,
          entry_type: 'hypothesis',
          status: 'accepted',
          author_id: OWNER.user_id,
          confidence: 0.72,
          statement: 'The consolidate path is starved because the trigger never fires.',
          consequence_if_false: 'high',
          alternative_hypotheses: ['the queue is starved', 'the scorer is wrong'],
        } as never,
      ],
    },
    { actorId: OWNER.user_id },
  );

  const second = await deltas.submitDelta(
    {
      schema_version: '1.0',
      idempotency_key: 'fixture_delta_0002',
      mission_id: missionId,
      base_mission_version: 2,
      author_id: OWNER.user_id,
      delta_type: 'UNCERTAINTY_OPENED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'u1' }],
      rationale: 'record what is still open',
      confidence: 0.5,
      ledger_entries: [
        {
          schema_version: '1.0',
          mission_id: missionId,
          entry_type: 'uncertainty',
          status: 'active',
          author_id: OWNER.user_id,
          confidence: 0.4,
          statement: 'Whether a plateau trigger is needed before the queue starves.',
          consequence_if_false: 'high',
        } as never,
        {
          schema_version: '1.0',
          mission_id: missionId,
          entry_type: 'decision',
          status: 'accepted',
          author_id: OWNER.user_id,
          confidence: 0.6,
          statement: 'Keep the manual path until the evidence gate opens.',
          consequence_if_false: 'high',
          depends_on: [first.ledger_entries?.[0]?.entry_id ?? ''],
        } as never,
      ],
    },
    { actorId: OWNER.user_id },
  );

  // Third delta: evidence that structurally contradicts the decision just
  // recorded — this is what makes a deterministic trigger fire in the gather.
  const decisionId = second.ledger_entries?.find((e) => e.entry_type === 'decision')?.entry_id ?? '';
  const third = await deltas.submitDelta(
    {
      schema_version: '1.0',
      idempotency_key: 'fixture_delta_0003',
      mission_id: missionId,
      base_mission_version: 3,
      author_id: OWNER.user_id,
      delta_type: 'EVIDENCE_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'e1' }],
      rationale: 'record the contradicting observation',
      confidence: 0.8,
      ledger_entries: [
        {
          schema_version: '1.0',
          mission_id: missionId,
          entry_type: 'evidence',
          status: 'accepted',
          author_id: OWNER.user_id,
          confidence: 0.8,
          statement: 'Two cycles in a row closed with no new claim.',
          evidence_against: [decisionId],
        } as never,
      ],
    },
    { actorId: OWNER.user_id },
  );

  const current = await missions.getMissionState(missionId);
  const baton = await batons.issueBaton({
    schema_version: '1.0',
    mission_id: missionId,
    mission_version: current!.version,
    recipient_id: OWNER.user_id,
    mode: 'challenge',
    objective: 'Challenge the starvation hypothesis with a blind read.',
    deliverable: 'state delta',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  } as never);

  const workItemId = 'wi_fixture_1';
  db.collection('cognitive_work_items').docs.push({
    schema_version: '1.0',
    work_item_id: workItemId,
    mission_id: missionId,
    description: 'Measure how often the trigger fires without a plateau signal.',
    mode: 'monitor',
    status: 'queued',
    authority_class: 'B',
    features: {},
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  });

  // Journal / reflection rows: one for the caller, several for ANOTHER identity.
  // Only the caller's own rows may ever be counted.
  db.collection('reflective_journals').docs.push({
    user_id: OWNER.user_id,
    period_type: 'daily',
    period_start: new Date('2026-09-20T00:00:00.000Z'),
    period_end: new Date('2026-09-20T23:59:59.000Z'),
    narrative: 'JOURNAL-NARRATIVE-MUST-NEVER-REACH-THE-MODEL',
    unresolved_threads: ['JOURNAL-THREAD-MUST-NEVER-REACH-THE-MODEL'],
    created_at: new Date('2026-09-20T23:00:00.000Z'),
  });
  for (let i = 0; i < 3; i += 1) {
    db.collection('reflective_journals').docs.push({
      user_id: OTHER.user_id,
      period_type: 'daily',
      period_start: new Date('2026-09-19T00:00:00.000Z'),
      narrative: `other-identity narrative ${i}`,
      unresolved_threads: [],
      created_at: new Date('2026-09-19T23:00:00.000Z'),
    });
  }
  db.collection('reflection_nodes').docs.push({
    user_id: OWNER.user_id,
    entity_name: 'the loop',
    emotional_signature: { primary_emotion: 'focus', intensity: 0.6 },
  });
  db.collection('reflection_nodes').docs.push({ user_id: OTHER.user_id, entity_name: 'elsewhere' });
  db.collection('reflection_edges').docs.push({ user_id: OWNER.user_id, source_entity: 'a', target_entity: 'b' });
  db.collection('consolidation_runs').docs.push({ period: 'daily', last_run: 1 });

  const entryIds = [first, second, third]
    .flatMap((d) => (d.ledger_entries ?? []).map((e) => e.entry_id))
    .filter((id): id is string => Boolean(id));
  return { missionId, entryIds, deltaIds: [first.delta_id, second.delta_id, third.delta_id], workItemId, batonId: baton.baton_id };
}

/** Pull the ids the prompt actually offered, so the stub cites real evidence. */
function evidenceIndex(prompt: string): {
  mission: string;
  baton: string | null;
  deltas: string[];
  entries: string[];
  workItems: string[];
} {
  const grab = (label: string): string[] => {
    const line = prompt.split('\n').find((l) => l.startsWith(`- ${label}:`));
    if (!line) return [];
    // The line shape is `- <label>: a, b, c` → drop the `- <label>: ` prefix.
    return line.slice(label.length + 4).split(',').map((s) => s.trim()).filter(Boolean);
  };
  return {
    mission: grab('mission')[0],
    baton: grab('baton')[0] ?? null,
    deltas: grab('delta'),
    entries: grab('entry'),
    workItems: grab('work item'),
  };
}

/** A well-formed model output: 5 signals over all six kinds' vocabulary. */
function goodOutput(prompt: string, opts: { bogusRef?: boolean } = {}) {
  const ids = evidenceIndex(prompt);
  const bogus = 'ref_that_never_existed_deadbeef';
  return {
    signals: [
      {
        kind: 'tension',
        statement: 'The trigger has not fired while the queue starves.',
        why_operationally_relevant: 'If the queue starves the cycle closes with no new claim.',
        intensity: 0.8,
        confidence: 0.7,
        valence: -0.4,
        evidence_refs: [ids.entries[0], ids.deltas[0]],
      },
      {
        kind: 'attraction',
        statement: 'The blind baton is a cheap way to falsify the hypothesis.',
        why_operationally_relevant: 'It produces the independent read the decision is missing.',
        intensity: 0.65,
        confidence: 0.55,
        valence: 0.6,
        evidence_refs: [ids.baton ?? ids.mission],
      },
      {
        kind: 'surprise',
        statement: 'The work item was queued but never allocated.',
        why_operationally_relevant: 'A queued-but-unallocated item is invisible work, not planned work.',
        intensity: 0.5,
        confidence: 0.5,
        valence: -0.1,
        evidence_refs: [ids.workItems[0] ?? ids.mission],
      },
      {
        kind: 'persistent_pull',
        statement: 'The starvation question keeps returning across cycles.',
        why_operationally_relevant: 'Repetition without resolution is where the mission is actually spending its attention.',
        intensity: 0.7,
        confidence: 0.15,
        valence: -0.2,
        evidence_refs: [ids.entries[1] ?? ids.mission, ...(opts.bogusRef ? [bogus] : [])],
      },
      {
        kind: 'absence',
        statement: 'Nothing measures how often the trigger fires.',
        why_operationally_relevant: 'Without a rate the plateau trigger cannot be justified or refuted.',
        intensity: 0.45,
        confidence: 0.35,
        valence: -0.05,
        evidence_refs: [ids.mission],
      },
      {
        kind: 'question',
        statement: 'What would have to be true for the manual path to be enough?',
        why_operationally_relevant: 'It bounds how much machinery this mission actually needs.',
        intensity: 0.3,
        confidence: 0.25,
        valence: 0,
        evidence_refs: [ids.entries[2] ?? ids.mission],
      },
    ],
  };
}

beforeEach(() => {
  db = new FakeDb();
  holder.db = db;
  prompts.length = 0;
  respond = async (system, prompt) => goodOutput(prompt);
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
});

describe('focused consolidation — a full run over the frozen fixture', () => {
  it('produces a schema-valid, evidence-linked, calibrated trace', async () => {
    const fixture = await seedFixture();
    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-fixture-1',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('completed');
    expect(result.reused).toBe(false);
    expect(llmCalls()).toBe(1);
    const trace = result.trace!;
    expect(trace).toBeTruthy();

    // Schema-valid, and valid against the shipped contract schema itself.
    expect(validateAgainst(SCHEMA_IDS.salienceTrace, trace)).toEqual({ valid: true, errors: [] });

    // Every signal carries ≥1 evidence ref, and every ref resolves except the
    // deliberately bogus one of the final test in this block.
    expect(trace.signals.length).toBeGreaterThanOrEqual(3);
    for (const signal of trace.signals) {
      expect(signal.evidence_refs.length).toBeGreaterThanOrEqual(1);
      expect(signal.why_operationally_relevant.length).toBeGreaterThan(0);
      expect(signal.intensity).toBeGreaterThanOrEqual(0);
      expect(signal.intensity).toBeLessThanOrEqual(1);
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
      expect(signal.valence).toBeGreaterThanOrEqual(-1);
      expect(signal.valence).toBeLessThanOrEqual(1);
    }
    expect(trace.evidence.flagged_refs).toEqual([]);
    expect(trace.evidence.unresolved_ref_count).toBe(0);
    expect(trace.evidence.unresolved_evidence_count).toBe(0);
    expect(trace.evidence.total_refs).toBe(
      trace.signals.reduce((sum, s) => sum + s.evidence_refs.length, 0),
    );

    // Privacy attestation travels on the stored trace.
    expect(trace.privacy).toEqual({ raw_reflections_included: false, shared: false });
    expect(trace.problem_state_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(trace.cycle_id).toBe('cycle-fixture-1');
    expect(trace.user_id).toBe(OWNER.user_id);
    expect(trace.trigger).toBe('manual');

    // Both rows landed, and only these two collections were written to.
    expect(db.collection(TRACES).docs).toHaveLength(1);
    expect(db.collection(RUNS).docs).toHaveLength(1);
    expect(db.collection(TRACES).docs[0].trace_id).toBe(result.trace_id);
  });

  it('counts and flags the one deliberately bogus evidence ref', async () => {
    const fixture = await seedFixture();
    respond = async (_system, prompt) => goodOutput(prompt, { bogusRef: true });

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-bogus',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('completed');
    const trace = result.trace!;
    const flagged = trace.signals.filter((s) => s.unresolved_evidence === true);
    expect(flagged).toHaveLength(1);
    // The bogus ref is KEPT (never silently dropped, never fabricated away) …
    expect(flagged[0].evidence_refs).toContain('ref_that_never_existed_deadbeef');
    // … and counted, on the trace and on the run.
    expect(trace.evidence.unresolved_evidence_count).toBe(1);
    expect(trace.evidence.unresolved_ref_count).toBe(1);
    expect(trace.evidence.flagged_refs).toEqual(['ref_that_never_existed_deadbeef']);
    expect(result.run.unresolved_evidence_count).toBe(1);
    expect(result.run.unresolved_ref_count).toBe(1);
    expect(validateAgainst(SCHEMA_IDS.salienceTrace, trace).valid).toBe(true);
  });

  it('records a warning on the run when more than half the signals carry unresolved evidence', async () => {
    const fixture = await seedFixture();
    respond = async (_system, prompt) => {
      const ids = evidenceIndex(prompt);
      return {
        signals: [
          {
            kind: 'tension',
            statement: 'Cites only a ref that cannot resolve.',
            why_operationally_relevant: 'It still has to be reported, not hidden.',
            intensity: 0.6, confidence: 0.5, valence: -0.2,
            evidence_refs: ['ghost_ref_one'],
          },
          {
            kind: 'question',
            statement: 'Cites one good and one unresolvable ref.',
            why_operationally_relevant: 'Partial evidence is weaker evidence.',
            intensity: 0.4, confidence: 0.4, valence: 0,
            evidence_refs: [ids.mission, 'ghost_ref_two'],
          },
          {
            kind: 'attraction',
            statement: 'Fully evidenced.',
            why_operationally_relevant: 'This one is safe to act on.',
            intensity: 0.5, confidence: 0.6, valence: 0.4,
            evidence_refs: [ids.mission],
          },
        ],
      };
    };

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-warning',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('completed');
    // 2 of 3 signals → more than half: recorded with a warning, not silently accepted.
    expect(result.run.unresolved_evidence_count).toBe(2);
    expect(result.run.warning).toContain('2 of 3 signals');
    expect(result.trace!.evidence.warning).toContain('2 of 3 signals');
    const [stored] = db.collection(RUNS).docs;
    expect(stored.warning).toContain('2 of 3 signals');
    // The warning is visible through the read tool too (trace + run summary).
    process.env.FOCUSED_IMAGINATION = '1';
    try {
      const read = await dispatchFocusedTool('get_salience_trace', { trace_id: result.trace_id! }, OWNER);
      expect(txt(read)).toContain('2 of 3 signals cite at least one unresolvable evidence ref');
      expect(txt(read)).toContain('unresolved=2');
    } finally {
      delete process.env.FOCUSED_IMAGINATION;
    }
  });

  it('records the run ledger: model, timings, counts and the privacy audit', async () => {
    const fixture = await seedFixture();
    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-ledger',
      actorId: OWNER.user_id,
    });

    const run = result.run;
    expect(run.status).toBe('completed');
    expect(run.model).toBe('test-model');
    expect(run.llm_calls).toBe(1);
    expect(run.duration_ms).toBeGreaterThanOrEqual(0);
    expect(run.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.error).toBeNull();
    expect(run.trace_id).toBe(result.trace_id);
    expect(run.idempotency_key).toBe(
      focusedIdempotencyKey(OWNER.user_id, fixture.missionId, 'cycle-ledger'),
    );

    // Input counts describe the fixture that was actually gathered.
    expect(run.input_counts.hypotheses).toBe(1);
    expect(run.input_counts.uncertainties).toBe(1);
    expect(run.input_counts.decisions).toBe(1);
    expect(run.input_counts.work_items).toBe(1);
    expect(run.input_counts.accepted_deltas).toBe(3);
    expect(run.input_counts.baton_present).toBe(true);
    expect(run.input_counts.fired_triggers).toBeGreaterThanOrEqual(1);
    // ONLY the caller's own reflection rows are counted (the other identity has three).
    expect(run.input_counts.journal_count).toBe(1);
    expect(run.input_counts.reflection_node_count).toBe(1);
    expect(run.input_counts.latest_journal_period).toBe('daily');

    // Output counts describe the trace that was stored.
    expect(run.output_counts.signals).toBe(result.trace!.signals.length);
    expect(run.output_counts.dropped_signals).toBe(0);
    expect(Object.keys(run.output_counts.by_kind).length).toBeGreaterThanOrEqual(3);

    // The calibration distribution is recorded, on the trace AND on the run.
    const buckets = result.trace!.calibration.confidence_buckets;
    expect(Object.keys(buckets)).toEqual(['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0']);
    expect(Object.values(buckets).reduce((a, b) => a + b, 0)).toBe(result.trace!.signals.length);
    expect(run.confidence_buckets).toEqual(buckets);
    const lowConfidence = result.trace!.signals.filter((s) => s.confidence < 0.2).length;
    expect(buckets['0.0-0.2']).toBe(lowConfidence);

    expect(run.privacy_audit).toEqual({
      raw_reflections_included: false,
      shared: false,
      shared_id_written: false,
      journal_writes: 0,
    });
    // The stored run row is the same document the ledger read path returns.
    const [stored] = await new FocusedConsolidationService(db.asDb()).getRuns(OWNER.user_id, fixture.missionId);
    expect(stored.run_id).toBe(run.run_id);
  });

  it('stores neither a shared_id nor any journal text', async () => {
    const fixture = await seedFixture();
    const before = freeze();
    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-privacy',
      actorId: OWNER.user_id,
    });

    // No shared scope on either collection, ever.
    for (const name of [TRACES, RUNS]) {
      for (const doc of db.collection(name).docs) {
        expect('shared_id' in doc).toBe(false);
      }
    }

    // The model prompt carries COUNTS of the caller's reflection state, never text.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('journal entries recorded: 1');
    expect(prompts[0]).not.toContain('JOURNAL-NARRATIVE-MUST-NEVER-REACH-THE-MODEL');
    expect(prompts[0]).not.toContain('JOURNAL-THREAD-MUST-NEVER-REACH-THE-MODEL');
    expect(prompts[0]).not.toContain('other-identity narrative');

    // The stored trace is free of it too.
    const serialized = JSON.stringify(db.collection(TRACES).docs);
    expect(serialized).not.toContain('JOURNAL-NARRATIVE');
    expect(serialized).not.toContain('other-identity narrative');
    expect(serialized).not.toContain('shared_id');

    // Journal / reflection / consolidation_runs rows are byte-identical.
    expect(freeze()).toBe(before);
    expect(result.status).toBe('completed');
  });
});

describe('focused consolidation — idempotency and single flight', () => {
  it('replays the same cycle with no second model call and no duplicate documents', async () => {
    const fixture = await seedFixture();
    const args = { userId: OWNER.user_id, missionId: fixture.missionId, cycleId: 'cycle-replay', actorId: OWNER.user_id };

    const first = await runFocusedConsolidation(db.asDb(), args);
    expect(first.reused).toBe(false);
    expect(llmCalls()).toBe(1);

    const second = await runFocusedConsolidation(db.asDb(), args);

    expect(second.reused).toBe(true);
    expect(second.status).toBe('completed');
    expect(llmCalls()).toBe(1); // unchanged: no second model call
    expect(second.trace).toEqual(first.trace);
    expect(second.trace_id).toBe(first.trace_id);
    expect(second.run_id).toBe(first.run_id);
    expect(second.problem_state_digest).toBe(first.problem_state_digest);
    expect(db.collection(TRACES).docs).toHaveLength(1);
    expect(db.collection(RUNS).docs).toHaveLength(1);

    // A third replay through a fresh service instance (no in-process state).
    const third = await new FocusedConsolidationService(db.asDb()).run(args);
    expect(third.reused).toBe(true);
    expect(llmCalls()).toBe(1);
    expect(db.collection(RUNS).docs).toHaveLength(1);
  });

  it('runs exactly once under concurrent duplicates', async () => {
    const fixture = await seedFixture();
    respond = async (_system, prompt) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return goodOutput(prompt);
    };
    const args = { userId: OWNER.user_id, missionId: fixture.missionId, cycleId: 'cycle-race', actorId: OWNER.user_id };

    const results = await Promise.all([
      runFocusedConsolidation(db.asDb(), args),
      runFocusedConsolidation(db.asDb(), args),
      runFocusedConsolidation(db.asDb(), args),
    ]);

    expect(llmCalls()).toBe(1);
    expect(db.collection(TRACES).docs).toHaveLength(1);
    expect(db.collection(RUNS).docs).toHaveLength(1);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(new Set(results.map((r) => r.trace_id)).size).toBe(1);
    // Exactly one caller did the work; the duplicates awaited it.
    expect(results.filter((r) => r.reused === false)).toHaveLength(1);
    expect(results.filter((r) => r.reused === true)).toHaveLength(2);
  });

  it('a claim that loses the unique-key race returns the winner instead of double-running', async () => {
    const fixture = await seedFixture();
    // Model a second PROCESS claiming the same cycle between our read and our
    // claim: the fake enforces the unique `idempotency_key`, exactly as the
    // deployment's index does, so the duplicate claim must fail E11000.
    const runs = db.collection(RUNS);
    const originalInsert = runs.insertOne.bind(runs);
    let races = 0;
    (runs as { insertOne: typeof runs.insertOne }).insertOne = async (doc) => {
      if (races === 0 && doc.status === 'running') {
        races += 1;
        await originalInsert({ ...structuredClone(doc), run_id: 'run_other_process' });
      }
      return originalInsert(doc);
    };

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-cross-process',
      actorId: OWNER.user_id,
    });

    expect(races).toBe(1);
    expect(result.run_id).toBe('run_other_process');
    expect(result.status).toBe('in_progress');
    expect(result.reused).toBe(true);
    expect(llmCalls()).toBe(0);
    expect(db.collection(TRACES).docs).toHaveLength(0);
    expect(db.collection(RUNS).docs).toHaveLength(1);
  });

  it('derives a version-scoped default cycle so a cycle_id is optional but still idempotent', async () => {
    const fixture = await seedFixture();
    const args = { userId: OWNER.user_id, missionId: fixture.missionId, actorId: OWNER.user_id };
    const first = await runFocusedConsolidation(db.asDb(), args);
    const second = await runFocusedConsolidation(db.asDb(), args);
    expect(first.cycle_id).toBe(defaultCycleId(first.mission_version));
    expect(second.reused).toBe(true);
    expect(llmCalls()).toBe(1);
    expect(db.collection(RUNS).docs).toHaveLength(1);
  });
});

describe('focused consolidation — fail loudly, never fabricate', () => {
  it('records a failed run with the error and writes no trace when the model call fails', async () => {
    const fixture = await seedFixture();
    respond = async () => {
      throw new Error('provider exploded');
    };

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-failed',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('failed');
    expect(result.trace).toBeNull();
    expect(result.trace_id).toBeNull();
    expect(result.error).toContain('provider exploded');
    expect(db.collection(TRACES).docs).toHaveLength(0);
    const [run] = db.collection(RUNS).docs;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('provider exploded');
    expect(run.trace_id).toBeNull();
    expect(run.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // One bounded call per attempt, at most once retried.
    expect(llmCalls()).toBe(2);
    expect(run.llm_calls).toBe(2);
  });

  it('treats an empty model result as a failure (extractJson fails closed)', async () => {
    const fixture = await seedFixture();
    respond = async () => ({});

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-empty',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('no usable JSON');
    expect(db.collection(TRACES).docs).toHaveLength(0);
  });

  it('lets a later run with a new cycle succeed after a failure', async () => {
    const fixture = await seedFixture();
    respond = async () => {
      throw new Error('first cycle fails');
    };
    const failed = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-1-fails',
      actorId: OWNER.user_id,
    });
    expect(failed.status).toBe('failed');

    respond = async (_system, prompt) => goodOutput(prompt);
    const succeeded = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-2-succeeds',
      actorId: OWNER.user_id,
    });

    expect(succeeded.status).toBe('completed');
    expect(succeeded.trace).toBeTruthy();
    expect(db.collection(TRACES).docs).toHaveLength(1);
    expect(db.collection(RUNS).docs).toHaveLength(2);
    expect(db.collection(RUNS).docs.map((r) => r.status).sort()).toEqual(['completed', 'failed']);
  });

  it('replays a failed cycle instead of silently retrying it in the same cycle', async () => {
    const fixture = await seedFixture();
    respond = async () => {
      throw new Error('stays broken');
    };
    const args = { userId: OWNER.user_id, missionId: fixture.missionId, cycleId: 'cycle-sticky', actorId: OWNER.user_id };
    await runFocusedConsolidation(db.asDb(), args);
    const callsAfterFirst = llmCalls();
    const replay = await runFocusedConsolidation(db.asDb(), args);

    expect(replay.status).toBe('failed');
    expect(replay.reused).toBe(true);
    expect(replay.error).toContain('stays broken');
    expect(llmCalls()).toBe(callsAfterFirst); // no second model call in the same cycle
  });

  it('rejects a malformed output (no signals array) and an output with no usable signal', async () => {
    const fixture = await seedFixture();

    respond = async () => ({ notes: 'I would rather not' });
    const noSignals = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-no-signals',
      actorId: OWNER.user_id,
    });
    expect(noSignals.status).toBe('failed');
    expect(noSignals.error).toContain('no `signals` array');

    respond = async () => ({ signals: [{ kind: 'vibes', statement: 'hmm' }] });
    const unusable = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-unusable',
      actorId: OWNER.user_id,
    });
    expect(unusable.status).toBe('failed');
    expect(unusable.error).toContain('no usable signal');
    expect(unusable.run.output_counts.dropped_by_reason.unknown_kind).toBe(1);
    expect(unusable.run.output_counts.dropped_signals).toBe(1);

    expect(db.collection(TRACES).docs).toHaveLength(0);
  });

  it('marks a stale in-flight claim failed instead of wedging the cycle forever', async () => {
    const fixture = await seedFixture();
    // A claim left behind by a process that died before completing.
    db.collection(RUNS).docs.push({
      schema_version: '1.0',
      run_id: 'run-abandoned',
      idempotency_key: focusedIdempotencyKey(OWNER.user_id, fixture.missionId, 'cycle-crashed'),
      user_id: OWNER.user_id,
      mission_id: fixture.missionId,
      mission_version: 3,
      cycle_id: 'cycle-crashed',
      trigger: 'manual',
      actor_id: OWNER.user_id,
      status: 'running',
      trace_id: null,
      problem_state_digest: 'sha256:' + '0'.repeat(64),
      model: 'test-model',
      llm_calls: 1,
      input_tokens: 0,
      output_tokens: 0,
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      completed_at: null,
      duration_ms: 0,
      input_counts: {},
      output_counts: { signals: 0, by_kind: {}, dropped_signals: 0, dropped_by_reason: {}, trimmed_evidence_refs: 0 },
      unresolved_evidence_count: 0,
      unresolved_ref_count: 0,
      clamped_values: 0,
      low_confidence_count: 0,
      error: null,
      privacy_audit: { raw_reflections_included: false, shared: false, shared_id_written: false, journal_writes: 0 },
    });

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-crashed',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('abandoned run');
    expect(llmCalls()).toBe(0);
    expect(db.collection(RUNS).docs[0].status).toBe('failed');
  });

  it('reports a missing mission instead of writing a run row', async () => {
    const fixture = await seedFixture();
    await expect(
      runFocusedConsolidation(db.asDb(), {
        userId: OWNER.user_id,
        missionId: 'mission_that_does_not_exist',
        cycleId: 'cycle-ghost',
        actorId: OWNER.user_id,
      }),
    ).rejects.toThrow(/mission state not found/);
    expect(db.collection(RUNS).docs).toHaveLength(0);
    expect(db.collection(TRACES).docs).toHaveLength(0);
    expect(llmCalls()).toBe(0);
    expect(fixture.missionId).toBeTruthy();
  });
});

describe('focused consolidation — calibration against hostile model output', () => {
  it('clamps, flags and counts out-of-range, non-finite and missing values', async () => {
    const fixture = await seedFixture();
    respond = async (_system, prompt) => {
      const ids = evidenceIndex(prompt);
      return {
        signals: [
          {
            kind: 'tension',
            statement: 'Intensity far out of range.',
            why_operationally_relevant: 'Still actionable.',
            intensity: 17,
            confidence: -4,
            valence: 9,
            evidence_refs: [ids.mission],
          },
          {
            kind: 'SURPRISE', // kinds are case/format tolerant
            statement: 'NaN and Infinity.',
            why_operationally_relevant: 'Must not reach the store.',
            intensity: Number.NaN,
            confidence: Number.POSITIVE_INFINITY,
            valence: Number.NEGATIVE_INFINITY,
            evidence_refs: [ids.mission],
          },
          {
            kind: 'absence',
            statement: 'Missing calibration fields and a wrong-typed confidence.',
            why_operationally_relevant: 'Defaults must be conservative and counted.',
            confidence: 'very high',
            evidence_refs: [ids.mission],
            extra_key_the_model_invented: { nested: true },
          },
        ],
      };
    };

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-hostile',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('completed');
    const trace = result.trace!;
    expect(trace.signals).toHaveLength(3);
    for (const signal of trace.signals) {
      expect(Number.isFinite(signal.intensity)).toBe(true);
      expect(Number.isFinite(signal.confidence)).toBe(true);
      expect(Number.isFinite(signal.valence)).toBe(true);
      expect(signal.intensity).toBeGreaterThanOrEqual(0);
      expect(signal.intensity).toBeLessThanOrEqual(1);
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
      expect(signal.valence).toBeGreaterThanOrEqual(-1);
      expect(signal.valence).toBeLessThanOrEqual(1);
      // Extra keys the model invented are dropped, never stored.
      expect('extra_key_the_model_invented' in signal).toBe(false);
    }
    expect(trace.signals[0]).toMatchObject({ intensity: 1, confidence: 0, valence: 1 });
    expect(trace.signals[1]).toMatchObject({ intensity: 0, confidence: 0, valence: 0 });
    expect(trace.signals[2]).toMatchObject({ intensity: 0, confidence: 0, valence: 0 });
    expect(trace.signals[1].kind).toBe('surprise');

    // Every adjustment is counted, on the trace's calibration and the run.
    expect(trace.calibration.clamped_values).toBeGreaterThanOrEqual(9);
    expect(result.clamped_values).toBe(trace.calibration.clamped_values);
    expect(result.run.clamped_values).toBe(trace.calibration.clamped_values);
    expect(trace.calibration.clamped_by_field.intensity).toBe(3);
    expect(trace.calibration.clamped_by_field.confidence).toBe(3);
    expect(trace.calibration.clamped_by_field.valence).toBe(3);

    // Below the confidence floor: kept, marked, counted.
    expect(trace.calibration.confidence_floor).toBe(0.2);
    expect(trace.calibration.low_confidence_count).toBe(3);
    for (const signal of trace.signals) expect(signal.low_confidence).toBe(true);
    expect(result.low_confidence_count).toBe(3);

    // The mean distributions are recorded and bounded.
    expect(trace.calibration.intensity_max).toBeLessThanOrEqual(1);
    expect(trace.calibration.intensity_mean).toBeLessThanOrEqual(1);
    expect(trace.calibration.confidence_mean).toBeLessThanOrEqual(1);
    expect(trace.calibration.valence_mean).toBeGreaterThanOrEqual(-1);
    expect(trace.calibration.valence_mean).toBeLessThanOrEqual(1);
    expect(validateAgainst(SCHEMA_IDS.salienceTrace, trace).valid).toBe(true);
  });

  it('drops unusable signals with counted reasons and never crashes on junk', async () => {
    const fixture = await seedFixture();
    respond = async (_system, prompt) => {
      const ids = evidenceIndex(prompt);
      return {
        signals: [
          'not an object',
          { kind: 'tension' }, // no statement
          { kind: 'tension', statement: 'no why', evidence_refs: [ids.mission] },
          { kind: 'tension', statement: 'no evidence', why_operationally_relevant: 'x' },
          { kind: 'tension', statement: 'evidence of the wrong type', why_operationally_relevant: 'x', evidence_refs: 'not-an-array' },
          { kind: 42, statement: 'kind of the wrong type', why_operationally_relevant: 'x', evidence_refs: [ids.mission] },
          { kind: 'question', statement: 'survives', why_operationally_relevant: 'it is the real one', intensity: 0.4, confidence: 0.5, valence: 0.1, evidence_refs: [ids.mission] },
        ],
      };
    };

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-junk',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('completed');
    expect(result.trace!.signals).toHaveLength(1);
    expect(result.run.output_counts.dropped_signals).toBe(6);
    expect(result.run.output_counts.dropped_by_reason).toMatchObject({
      not_an_object: 1,
      missing_statement: 1,
      missing_why_operationally_relevant: 1,
      no_evidence_refs: 2,
      unknown_kind: 1,
    });
  });

  it('normalizes signals without trusting the model for structure', () => {
    const ids = 'entry-1';
    const { signals, clamped_values, dropped_by_reason } = normalizeSignals([
      { kind: 'persistent pull', statement: 's', why_operationally_relevant: 'w', intensity: 0.5, confidence: 0.5, valence: 0, evidence_refs: [ids, ids, ''] },
      { kind: 'question', statement: 's', why_operationally_relevant: 'w', intensity: 0, confidence: 0, valence: 0, evidence_refs: ['entry-2'] },
    ]);
    expect(dropped_by_reason).toEqual({});
    expect(clamped_values).toBe(0);
    expect(signals[0].kind).toBe('persistent_pull');
    expect(signals[0].evidence_refs).toEqual([ids]); // deduped, blanks dropped
    expect(signals[1].low_confidence).toBe(true);
    expect(signals).toHaveLength(2);
  });
});

describe('focused consolidation — determinism of problem_state_digest', () => {
  it('is identical for identical gathered state, and independent of the model output', async () => {
    const fixture = await seedFixture();
    const gatheredA = await gatherFocusedInputs(db.asDb(), (await new MissionStateService(db.asDb()).getMissionState(fixture.missionId))!, OWNER.user_id);
    const gatheredB = await gatherFocusedInputs(db.asDb(), (await new MissionStateService(db.asDb()).getMissionState(fixture.missionId))!, OWNER.user_id);
    expect(gatheredA.problem_state_digest).toBe(gatheredB.problem_state_digest);
    expect(gatheredA.problem_state_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A pure function of the inputs: recomputing over the same inputs matches.
    expect(computeProblemStateDigest(gatheredA)).toBe(gatheredA.problem_state_digest);

    // Two runs over the same state, with DIFFERENT model outputs, agree.
    respond = async (_system, prompt) => goodOutput(prompt);
    const first = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id, missionId: fixture.missionId, cycleId: 'cycle-det-1', actorId: OWNER.user_id,
    });
    respond = async (_system, prompt) => goodOutput(prompt, { bogusRef: true });
    const second = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id, missionId: fixture.missionId, cycleId: 'cycle-det-2', actorId: OWNER.user_id,
    });

    expect(second.problem_state_digest).toBe(first.problem_state_digest);
    expect(second.trace!.problem_state_digest).toBe(first.trace!.problem_state_digest);
    expect(second.trace!.trace_id).not.toBe(first.trace!.trace_id);
    // The digest is a function of the inputs, never of the run's own ids.
    expect(first.trace!.problem_state_digest).not.toContain(first.trace!.trace_id);
    expect(first.trace!.problem_state_digest).not.toContain(first.trace!.created_at);
  });

  it('changes when the gathered state changes', async () => {
    const fixture = await seedFixture();
    const missions = new MissionStateService(db.asDb());
    const before = await gatherFocusedInputs(db.asDb(), (await missions.getMissionState(fixture.missionId))!, OWNER.user_id);
    const version = (await missions.getMissionState(fixture.missionId))!.version;
    await new StateDeltaService(db.asDb()).submitDelta(
      {
        schema_version: '1.0',
        idempotency_key: 'fixture_delta_0004',
        mission_id: fixture.missionId,
        base_mission_version: version,
        author_id: OWNER.user_id,
        delta_type: 'CLAIM_ADDED',
        operations: [{ op: 'add', path: '/ledger_refs/-', value: 'c9' }],
        rationale: 'a new claim changes the problem state',
        confidence: 0.5,
        ledger_entries: [
          {
            schema_version: '1.0',
            mission_id: fixture.missionId,
            entry_type: 'claim',
            status: 'accepted',
            author_id: OWNER.user_id,
            confidence: 0.5,
            statement: 'A new claim.',
          } as never,
        ],
      },
      { actorId: OWNER.user_id },
    );
    const after = await gatherFocusedInputs(db.asDb(), (await new MissionStateService(db.asDb()).getMissionState(fixture.missionId))!, OWNER.user_id);
    expect(after.problem_state_digest).not.toBe(before.problem_state_digest);
  });
});

describe('focused consolidation — the FOCUSED_IMAGINATION gate', () => {
  const previous = process.env.FOCUSED_IMAGINATION;

  afterEach(() => {
    if (previous === undefined) delete process.env.FOCUSED_IMAGINATION;
    else process.env.FOCUSED_IMAGINATION = previous;
  });

  it('flag off: dispatch throws the plain unknown-tool error and nothing is written or called', async () => {
    delete process.env.FOCUSED_IMAGINATION;
    const fixture = await seedFixture();

    for (const name of FOCUSED_TOOL_NAMES) {
      await expect(
        dispatchFocusedTool(name, { mission_id: fixture.missionId }, OWNER),
      ).rejects.toThrow(`Unknown tool: ${name}`);
    }
    expect(llmCalls()).toBe(0);
    // Neither collection was even LOOKED UP (the fake registers a collection on
    // first access), let alone written to.
    expect(db.collections.has(TRACES)).toBe(false);
    expect(db.collections.has(RUNS)).toBe(false);
    expect(db.collection(TRACES).docs).toHaveLength(0);
    expect(db.collection(RUNS).docs).toHaveLength(0);
    // No mission/baton/ledger collection was touched either.
    expect(db.collection('epistemic_entries').docs).toHaveLength(4);
  });

  it('fail-closed truthy parsing: only 1/true/yes (case-insensitive) switch it on', async () => {
    for (const value of ['', '0', 'false', 'no', 'on', 'enabled']) {
      process.env.FOCUSED_IMAGINATION = value;
      await expect(dispatchFocusedTool('get_salience_trace', {}, OWNER)).rejects.toThrow('Unknown tool');
    }
    for (const value of ['1', 'true', 'TRUE', 'Yes', ' yes ']) {
      process.env.FOCUSED_IMAGINATION = value;
      const result = await dispatchFocusedTool('get_salience_trace', {}, OWNER);
      expect(txt(result)).toContain('No salience traces recorded for you.');
    }
    expect(llmCalls()).toBe(0);
  });

  it('flag on: the run tool works end to end through the dispatch layer', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const fixture = await seedFixture();

    const run = await dispatchFocusedTool(
      'run_focused_consolidation',
      { mission_id: fixture.missionId, cycle_id: 'cycle-dispatch' },
      OWNER,
    );
    expect(txt(run)).toContain('Focused consolidation complete');
    expect(txt(run)).toContain('problem_state_digest');
    expect(llmCalls()).toBe(1);

    const read = await dispatchFocusedTool('get_salience_trace', { mission_id: fixture.missionId }, OWNER);
    const text = txt(read);
    expect(text).toContain('"raw_reflections_included": false');
    expect(text).toContain('"shared": false');
    expect(text).toContain('Run `');
    expect(text).toContain('status=completed');
    expect(text).toContain('model=test-model');
  });

  it('an untrusted caller may not run or read another identity\'s mission', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    const fixture = await seedFixture();
    await dispatchFocusedTool('run_focused_consolidation', { mission_id: fixture.missionId, cycle_id: 'cycle-owned' }, OWNER);

    const deniedRun = await dispatchFocusedTool(
      'run_focused_consolidation',
      { mission_id: fixture.missionId, cycle_id: 'cycle-stolen' },
      OTHER,
    );
    expect(txt(deniedRun)).toContain('Not authorized');
    expect(db.collection(RUNS).docs).toHaveLength(1);

    // Reading the owner's trace by id, mission or nothing at all returns nothing.
    const byId = await dispatchFocusedTool(
      'get_salience_trace',
      { trace_id: db.collection(TRACES).docs[0].trace_id },
      OTHER,
    );
    expect(txt(byId)).toContain('No salience trace found');
    const byMission = await dispatchFocusedTool('get_salience_trace', { mission_id: fixture.missionId }, OTHER);
    expect(txt(byMission)).toContain('Not authorized');
    const all = await dispatchFocusedTool('get_salience_trace', {}, OTHER);
    expect(txt(all)).toContain('No salience traces recorded for you.');

    // …and a caller-supplied user_id is ignored for an untrusted caller.
    const spoofed = await dispatchFocusedTool('get_salience_trace', { user_id: OWNER.user_id }, OTHER);
    expect(txt(spoofed)).toContain('No salience traces recorded for you.');
    expect(txt(spoofed)).not.toContain('"trace_id"');
  });
});

describe('focused consolidation — the trace schema: strict where it matters, tolerant of extras', () => {
  it('accepts extra keys but refuses an unevidenced, unbounded or uncalibrated trace', async () => {
    const fixture = await seedFixture();
    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-schema',
      actorId: OWNER.user_id,
    });
    const trace = result.trace!;

    // Tolerant: an extra key must not make an otherwise-sound trace unstorable
    // (the stored document is built field by field, so extras never survive).
    expect(validateAgainst(SCHEMA_IDS.salienceTrace, { ...trace, future_field: { a: 1 } }).valid).toBe(true);
    expect(
      validateAgainst(SCHEMA_IDS.salienceTrace, {
        ...trace,
        signals: [{ ...trace.signals[0], invented: 'x' }, ...trace.signals.slice(1)],
      }).valid,
    ).toBe(true);

    // Strict: no signals, no evidence, no why, out-of-range calibration and a
    // shared privacy attestation are all refused.
    expect(validateAgainst(SCHEMA_IDS.salienceTrace, { ...trace, signals: [] }).valid).toBe(false);
    expect(
      validateAgainst(SCHEMA_IDS.salienceTrace, { ...trace, signals: [{ ...trace.signals[0], evidence_refs: [] }] }).valid,
    ).toBe(false);
    expect(
      validateAgainst(SCHEMA_IDS.salienceTrace, { ...trace, signals: [{ ...trace.signals[0], intensity: 2 }] }).valid,
    ).toBe(false);
    const { why_operationally_relevant: _why, ...withoutWhy } = trace.signals[0];
    expect(validateAgainst(SCHEMA_IDS.salienceTrace, { ...trace, signals: [withoutWhy] }).valid).toBe(false);
    expect(
      validateAgainst(SCHEMA_IDS.salienceTrace, { ...trace, privacy: { raw_reflections_included: true, shared: false } }).valid,
    ).toBe(false);
  });
});

describe('focused consolidation — source-level privacy guard', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = [
    'focused-consolidation-service.ts',
    'focused-consolidation-tools.ts',
    'focused-consolidation-collections.ts',
  ].map((file) => ({
    file,
    text: readFileSync(join(here, '../../src/services/processing', file), 'utf8'),
  }));

  it('never imports a journal, reflection or sleep-consolidation writer', () => {
    for (const { file, text } of sources) {
      const imports = [...text.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(
          /reflection-store|sleep-consolidation|reflection-writer|journal-writer|consolidation-output-bus/.test(specifier),
          `${file} must not import ${specifier}`,
        ).toBe(false);
      }
      expect(text, `${file} must not name a journal writer`).not.toMatch(
        /ReflectionStore|SleepConsolidationService|upsertJournal|consolidationOutputBus/,
      );
      // No write verb may be aimed at a journal-family collection.
      expect(text, `${file} must not write to a journal collection`).not.toMatch(
        /(insertOne|updateOne|updateMany|deleteMany|bulkWrite|replaceOne)\s*\([^)]{0,200}(reflective_journals|reflection_nodes|reflection_edges|consolidation_runs)/s,
      );
      // The write scope is resolved, never asserted: `resolveWriteScope` plus
      // `stripSharedId`, with no literal shared scope anywhere in the module.
      expect(text, `${file} must not set a literal shared_id`).not.toMatch(
        /shared_id\s*:\s*(?:'[^']*'|"[^"]*"|`[^`]*`)/,
      );
    }
  });

  it('routes every write through the personal-kind scope policy', () => {
    const service = sources.find((s) => s.file === 'focused-consolidation-service.ts')!.text;
    expect(service).toContain('resolveWriteScope(');
    expect(service).toContain('stripSharedId(');
    expect(service).toMatch(/privateScope\(SALIENCE_TRACE_KIND/);
    expect(service).toMatch(/privateScope\(FOCUSED_RUN_KIND/);
  });

  it('scopes the reflection read to counts of the caller\'s own rows', () => {
    const service = sources.find((s) => s.file === 'focused-consolidation-service.ts')!.text;
    // The only reads of the journal family are countDocuments and a
    // period_type-only projection — both filtered by user_id.
    const journalReads = [...service.matchAll(/collection\('(reflective_journals|reflection_nodes|reflection_edges|consolidation_runs)'\)/g)]
      .map((m) => m[1]);
    expect(journalReads.length).toBeGreaterThan(0);
    for (const collection of journalReads) {
      const usage = service.slice(service.indexOf(`collection('${collection}')`));
      expect(usage.slice(0, 220)).toMatch(/countDocuments\(\{ user_id: userId \}\)|findOne\(\{ user_id: userId \}/);
    }
    expect(service).toContain("projection: { _id: 0, period_type: 1 }");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. Availability: an over-long model field is TRUNCATED to fit the schema,
//    never fatal. The trace schema bounds `statement` and
//    `why_operationally_relevant` at maxLength 2000; a value one character over
//    that used to be stored as 2001 characters (the ellipsis was appended
//    OUTSIDE the limit), the store rejected the whole document and the run
//    failed with no trace at all. These tests go end to end through the
//    service (and the 2001 case through the MCP dispatch layer too).
// ─────────────────────────────────────────────────────────────────────────────

/** A model output whose statement/why are exactly `n` characters long. */
function oversizedOutput(prompt: string, n: number): Record<string, unknown> {
  const ids = evidenceIndex(prompt);
  return {
    signals: [
      {
        kind: 'tension',
        statement: 'S'.repeat(n),
        why_operationally_relevant: 'W'.repeat(n),
        intensity: 0.5,
        confidence: 0.5,
        valence: 0,
        evidence_refs: [ids.mission],
      },
      {
        kind: 'question',
        statement: 'A short, perfectly ordinary signal.',
        why_operationally_relevant: 'It proves the run kept working, not just that it survived.',
        intensity: 0.4,
        confidence: 0.5,
        valence: 0,
        evidence_refs: [ids.mission],
      },
    ],
  };
}

describe('focused consolidation — availability: over-long fields are truncated, not fatal', () => {
  it('bounds statement and why to the schema maximum INCLUDING the ellipsis (unit)', () => {
    const { signals, truncated_fields } = normalizeSignals([
      {
        kind: 'tension',
        statement: 'S'.repeat(2001),
        why_operationally_relevant: 'W'.repeat(3000),
        intensity: 0.5,
        confidence: 0.5,
        valence: 0,
        evidence_refs: ['entry-1'],
      },
      {
        kind: 'question',
        statement: 'short',
        why_operationally_relevant: 'short',
        intensity: 0.5,
        confidence: 0.5,
        valence: 0,
        evidence_refs: ['entry-1'],
      },
    ]);

    // The schema's bound is the bound: <= 2000 characters, ellipsis included.
    expect(signals[0].statement).toHaveLength(2000);
    expect(signals[0].why_operationally_relevant).toHaveLength(2000);
    expect(signals[0].statement.endsWith('…')).toBe(true);
    expect(signals[0].statement.startsWith('S'.repeat(1999))).toBe(true);
    // Short fields are untouched and counted as untouched.
    expect(signals[1].statement).toBe('short');
    expect(truncated_fields).toBe(2);

    // The boundary itself: exactly 2000 characters is already inside the bound
    // and must NOT be shortened (the old form truncated it to 2001 and failed).
    const atBound = normalizeSignals([
      {
        kind: 'tension',
        statement: 'B'.repeat(2000),
        why_operationally_relevant: 'B'.repeat(2000),
        intensity: 0.5,
        confidence: 0.5,
        valence: 0,
        evidence_refs: ['entry-1'],
      },
    ]);
    expect(atBound.signals[0].statement).toHaveLength(2000);
    expect(atBound.signals[0].statement.endsWith('…')).toBe(false);
    expect(atBound.truncated_fields).toBe(0);
  });

  it('a 2001-character statement completes the run instead of failing schema validation', async () => {
    const fixture = await seedFixture();
    const before = freeze();
    respond = async (_system, prompt) => oversizedOutput(prompt, 2001);

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-long-2001',
      actorId: OWNER.user_id,
    });

    // The whole point: the run COMPLETES (it used to fail with
    // "salience trace failed schema validation … must NOT have more than 2000 characters").
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    const trace = result.trace!;
    expect(trace).toBeTruthy();
    expect(validateAgainst(SCHEMA_IDS.salienceTrace, trace)).toEqual({ valid: true, errors: [] });

    // Both over-long fields fit the bound, ellipsis included.
    expect(trace.signals[0].statement).toHaveLength(2000);
    expect(trace.signals[0].why_operationally_relevant).toHaveLength(2000);
    expect(trace.signals[0].statement.endsWith('…')).toBe(true);
    // The other signal is stored intact — truncation is per field, not a purge.
    expect(trace.signals[1].statement).toBe('A short, perfectly ordinary signal.');

    // The truncation is COUNTED on the run ledger, not silent.
    expect(result.truncated_fields).toBe(2);
    expect(result.run.truncated_fields).toBe(2);
    const [storedRun] = db.collection(RUNS).docs;
    expect(storedRun.truncated_fields).toBe(2);
    expect(storedRun.status).toBe('completed');

    // One trace, stored and readable, and the journal family untouched.
    expect(db.collection(TRACES).docs).toHaveLength(1);
    expect(db.collection(TRACES).docs[0].signals[0].statement).toHaveLength(2000);
    expect(freeze()).toBe(before);

    // …and the truncation reaches the operator through the MCP read path.
    process.env.FOCUSED_IMAGINATION = '1';
    try {
      const read = await dispatchFocusedTool('get_salience_trace', { trace_id: result.trace_id! }, OWNER);
      expect(txt(read)).toContain('truncated=2');
    } finally {
      delete process.env.FOCUSED_IMAGINATION;
    }
  });

  it('a 1 MB statement does not fail the run (end to end through the service)', async () => {
    const fixture = await seedFixture();
    const megabyte = 1024 * 1024;
    respond = async (_system, prompt) => oversizedOutput(prompt, megabyte);

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-long-1mb',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('completed');
    const trace = result.trace!;
    expect(validateAgainst(SCHEMA_IDS.salienceTrace, trace).valid).toBe(true);
    expect(trace.signals[0].statement).toHaveLength(2000);
    expect(trace.signals[0].why_operationally_relevant).toHaveLength(2000);
    expect(result.truncated_fields).toBe(2);
    expect(db.collection(TRACES).docs).toHaveLength(1);
    // The stored document is bounded, not a megabyte of model prose.
    expect(JSON.stringify(db.collection(TRACES).docs[0]).length).toBeLessThan(20_000);
  });

  it('a 2001-character field completes the run through the MCP dispatch layer too', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    try {
      const fixture = await seedFixture();
      respond = async (_system, prompt) => oversizedOutput(prompt, 2001);

      const out = await dispatchFocusedTool(
        'run_focused_consolidation',
        { mission_id: fixture.missionId, cycle_id: 'cycle-long-dispatch' },
        OWNER,
      );

      expect(txt(out)).toContain('Focused consolidation complete');
      expect(txt(out)).not.toContain('FAILED');
      expect(txt(out)).toContain('**truncated fields:** 2');
      expect(db.collection(TRACES).docs).toHaveLength(1);
    } finally {
      delete process.env.FOCUSED_IMAGINATION;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. The orphan-trace window: the trace insert and the run-ledger update that
//    names it are two writes. When the second one fails, the first is
//    COMPENSATED — the trace is deleted (bounded retry) so a failed run leaves
//    no readable trace behind, and if the delete also fails the run row names
//    the surviving trace in `orphan_trace_id` instead of silently disagreeing
//    with it. Both outcomes are asserted against the STORE, not the return value.
// ─────────────────────────────────────────────────────────────────────────────

describe('focused consolidation — the trace/ledger window is compensated', () => {
  it('rolls the trace back when the completed-run ledger write fails', async () => {
    const fixture = await seedFixture();
    const runs = db.collection(RUNS);
    const originalUpdate = runs.updateOne.bind(runs);
    let completedWrites = 0;
    (runs as { updateOne: typeof runs.updateOne }).updateOne = async (filter, update, opts) => {
      if ((update as { $set?: { status?: string } })?.$set?.status === 'completed') {
        completedWrites += 1;
        throw new Error('run-ledger write exploded');
      }
      return originalUpdate(filter, update, opts);
    };

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-orphan-rollback',
      actorId: OWNER.user_id,
    });

    expect(completedWrites).toBe(1); // the ledger write really did fail
    expect(result.status).toBe('failed');
    expect(result.error).toContain('run-ledger write exploded');
    expect(result.error).toContain('rolled back');
    expect(result.trace).toBeNull();

    // Outcome 1 of the two allowed: trace REMOVED and the run failed with no
    // trace_id — so the failed run really did write no trace.
    expect(db.collection(TRACES).docs).toHaveLength(0);
    const [run] = db.collection(RUNS).docs;
    expect(run.status).toBe('failed');
    expect(run.trace_id).toBeNull();
    expect(run.orphan_trace_id).toBeNull();
    expect(db.collection(RUNS).docs).toHaveLength(1);
  });

  it('names the orphan on the run row when the rollback fails too', async () => {
    const fixture = await seedFixture();
    const runs = db.collection(RUNS);
    const traces = db.collection(TRACES);
    const originalUpdate = runs.updateOne.bind(runs);
    (runs as { updateOne: typeof runs.updateOne }).updateOne = async (filter, update, opts) => {
      if ((update as { $set?: { status?: string } })?.$set?.status === 'completed') {
        throw new Error('run-ledger write exploded');
      }
      return originalUpdate(filter, update, opts);
    };
    (traces as unknown as { deleteOne: () => Promise<never> }).deleteOne = async () => {
      throw new Error('rollback delete exploded');
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await runFocusedConsolidation(db.asDb(), {
        userId: OWNER.user_id,
        missionId: fixture.missionId,
        cycleId: 'cycle-orphan-retained',
        actorId: OWNER.user_id,
      });

      // Outcome 2 of the two allowed: the trace is RETAINED and the run row
      // NAMES it. The store is the evidence, not the return value.
      expect(result.status).toBe('failed');
      expect(db.collection(TRACES).docs).toHaveLength(1);
      const orphanId = db.collection(TRACES).docs[0].trace_id;
      const [run] = db.collection(RUNS).docs;
      expect(run.status).toBe('failed');
      expect(run.orphan_trace_id).toBe(orphanId);
      expect(run.trace_id).toBeNull();
      expect(run.error).toContain(orphanId);
      expect(result.orphan_trace_id).toBe(orphanId);
      // …and it is loud: the rollback failure is logged, naming the trace.
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(orphanId);
      expect(logged).toContain('could not be rolled back');
      expect(logged).toContain('rollback delete exploded');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('an ORDINARY completed run names no orphan', async () => {
    const fixture = await seedFixture();
    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-no-orphan',
      actorId: OWNER.user_id,
    });
    expect(result.status).toBe('completed');
    expect(result.orphan_trace_id).toBeNull();
    expect(db.collection(RUNS).docs[0].orphan_trace_id).toBeNull();
    expect(db.collection(TRACES).docs).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J. The wedged claim: a `running` row whose created_at is missing or
//    unparseable can never satisfy an age test, so it used to pin
//    {user, mission, cycle} at `in_progress` forever — unstuck only by
//    inventing a new cycleId. An un-ageable claim is now reclaimed as failed.
// ─────────────────────────────────────────────────────────────────────────────

/** A `running` claim row exactly as the service would have written it. */
function runningClaim(fixture: { missionId: string }, cycleId: string): Record<string, unknown> {
  return {
    schema_version: '1.0',
    run_id: `run_${cycleId}`,
    idempotency_key: focusedIdempotencyKey(OWNER.user_id, fixture.missionId, cycleId),
    user_id: OWNER.user_id,
    mission_id: fixture.missionId,
    mission_version: 4,
    cycle_id: cycleId,
    trigger: 'manual',
    actor_id: OWNER.user_id,
    status: 'running',
    trace_id: null,
    problem_state_digest: `sha256:${'0'.repeat(64)}`,
    model: 'test-model',
    llm_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    created_at: new Date().toISOString(),
    completed_at: null,
    duration_ms: 0,
    input_counts: {},
    output_counts: { signals: 0, by_kind: {}, dropped_signals: 0, dropped_by_reason: {}, trimmed_evidence_refs: 0 },
    unresolved_evidence_count: 0,
    unresolved_ref_count: 0,
    clamped_values: 0,
    coerced_values: 0,
    truncated_fields: 0,
    low_confidence_count: 0,
    orphan_trace_id: null,
    error: null,
    privacy_audit: { raw_reflections_included: false, shared: false, shared_id_written: false, journal_writes: 0 },
  };
}

describe('focused consolidation — an un-ageable claim is reclaimed, not wedged', () => {
  it('reclaims a running claim whose created_at is MISSING', async () => {
    const fixture = await seedFixture();
    const claim = runningClaim(fixture, 'cycle-wedged-missing');
    delete claim.created_at;
    db.collection(RUNS).docs.push(claim);

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-wedged-missing',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('failed');
    expect(result.status).not.toBe('in_progress');
    expect(result.reused).toBe(true);
    expect(result.error).toContain('missing or unparseable');
    expect(result.error).toContain('new cycle_id');
    expect(llmCalls()).toBe(0);
    expect(db.collection(TRACES).docs).toHaveLength(0);
    // The claim is no longer `running`: the cycle is not wedged.
    const [run] = db.collection(RUNS).docs;
    expect(run.status).toBe('failed');
    expect(run.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // …and a second call reports the reclaimed run instead of `in_progress`.
    const again = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-wedged-missing',
      actorId: OWNER.user_id,
    });
    expect(again.status).toBe('failed');
    expect(again.reused).toBe(true);
    expect(db.collection(RUNS).docs).toHaveLength(1);
  });

  it('reclaims a running claim whose created_at is UNPARSEABLE', async () => {
    const fixture = await seedFixture();
    db.collection(RUNS).docs.push(runningClaim(fixture, 'cycle-wedged-garbage'));
    db.collection(RUNS).docs[0].created_at = 'not-a-date';

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-wedged-garbage',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('missing or unparseable');
    expect(llmCalls()).toBe(0);
    expect(db.collection(RUNS).docs[0].status).toBe('failed');
  });

  it('still reports a FRESH running claim as in_progress (no over-reclaiming)', async () => {
    const fixture = await seedFixture();
    db.collection(RUNS).docs.push(runningClaim(fixture, 'cycle-fresh-claim'));

    const result = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-fresh-claim',
      actorId: OWNER.user_id,
    });

    expect(result.status).toBe('in_progress');
    expect(db.collection(RUNS).docs[0].status).toBe('running');
    expect(llmCalls()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K. Minor verifier findings: trigger normalisation, readable argument errors,
//    and a counter that distinguishes a COERCED numeric string from a CLAMPED
//    out-of-range number.
// ─────────────────────────────────────────────────────────────────────────────

describe('focused consolidation — the three smaller findings', () => {
  it('normalises a trigger with no dangling separator', async () => {
    const fixture = await seedFixture();
    const cases: Array<[string, string]> = [
      ['Manual Trigger!', 'manual_trigger'], // used to store 'manual_trigger_'
      ['!!!', 'manual'], // all punctuation → the fallback, not '_'
      ['__weird__', 'weird'],
      ['  Mixed   CASE -- ok  ', 'mixed_case_--_ok'],
      ['A'.repeat(60), 'a'.repeat(40)],
    ];

    for (const [input, expected] of cases) {
      process.env.FOCUSED_IMAGINATION = '1';
      try {
        const out = await dispatchFocusedTool(
          'run_focused_consolidation',
          { mission_id: fixture.missionId, cycle_id: `cycle-trigger-${expected}`, trigger: input },
          OWNER,
        );
        expect(txt(out)).toContain('Focused consolidation complete');
      } finally {
        delete process.env.FOCUSED_IMAGINATION;
      }
      const stored = db
        .collection(TRACES)
        .docs.find((t) => t.cycle_id === `cycle-trigger-${expected}`)!;
      expect(stored.trigger, `trigger "${input}"`).toBe(expected);
      expect(stored.trigger.endsWith('_')).toBe(false);
      expect(stored.trigger.startsWith('_')).toBe(false);
      expect(stored.trigger).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    }
    expect(db.collection(TRACES).docs).toHaveLength(cases.length);
  });

  it('reports wrong-typed arguments as a readable error instead of a raw ZodError', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    try {
      // A raw ZodError escaping here is what the outer catch turns into
      // `❌ Error: [{"code":"invalid_type",…}]` — no tool name, unreadable.
      const run = await dispatchFocusedTool('run_focused_consolidation', { mission_id: 42 }, OWNER);
      expect(txt(run)).toContain('Invalid arguments for run_focused_consolidation');
      expect(txt(run)).toContain('mission_id');

      const read = await dispatchFocusedTool('get_salience_trace', { limit: 'ten' }, OWNER);
      expect(txt(read)).toContain('Invalid arguments for get_salience_trace');
      expect(txt(read)).toContain('limit');

      // A caller error is not a crash and must not touch anything.
      expect(llmCalls()).toBe(0);
      expect(db.collections.has(TRACES)).toBe(false);
      expect(db.collections.has(RUNS)).toBe(false);

      // Valid arguments still behave exactly as before.
      const ok = await dispatchFocusedTool('get_salience_trace', { limit: 5 }, OWNER);
      expect(txt(ok)).toContain('No salience traces recorded for you.');
    } finally {
      delete process.env.FOCUSED_IMAGINATION;
    }
  });

  it('flag off still wins over invalid arguments (plain Unknown tool)', async () => {
    delete process.env.FOCUSED_IMAGINATION;
    await expect(
      dispatchFocusedTool('run_focused_consolidation', { mission_id: 42 }, OWNER),
    ).rejects.toThrow('Unknown tool: run_focused_consolidation');
    expect(db.collections.has(RUNS)).toBe(false);
  });

  it('counts a coerced numeric string separately from a clamped out-of-range number', async () => {
    const fixture = await seedFixture();

    // Cycle 1 — one numeric STRING per calibration field (coerced, in range)
    // plus one genuinely out-of-range NUMBER (clamped, not coerced).
    respond = async (_system, prompt) => {
      const ids = evidenceIndex(prompt);
      return {
        signals: [
          {
            kind: 'tension',
            statement: 'Calibration values arrived as strings.',
            why_operationally_relevant: 'A hostile model quotes numbers.',
            intensity: '0.5',
            confidence: '0.7',
            valence: '0',
            evidence_refs: [ids.mission],
          },
          {
            kind: 'question',
            statement: 'Intensity arrived out of range as a real number.',
            why_operationally_relevant: 'This one is a clamp, not a coercion.',
            intensity: 5,
            confidence: 0.5,
            valence: -0.2,
            evidence_refs: [ids.mission],
          },
        ],
      };
    };

    const coercedRun = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-coerced',
      actorId: OWNER.user_id,
    });

    expect(coercedRun.status).toBe('completed');
    // THREE numeric strings were coerced (intensity, confidence, valence) and
    // the out-of-range number was clamped: `coerced_values` isolates the first
    // group instead of lumping both under `clamped_values`.
    expect(coercedRun.coerced_values).toBe(3);
    expect(coercedRun.run.coerced_values).toBe(3);
    expect(coercedRun.run.clamped_values).toBe(4);
    expect(coercedRun.trace!.calibration.coerced_values).toBe(3);
    expect(coercedRun.trace!.calibration.coerced_by_field).toEqual({ intensity: 1, confidence: 1, valence: 1 });
    // `clamped_by_field` still counts EVERY adjustment, so the two counters
    // describe different things and neither is a lie.
    expect(coercedRun.trace!.calibration.clamped_by_field).toEqual({ intensity: 2, confidence: 1, valence: 1 });
    expect(coercedRun.trace!.calibration.clamped_values).toBe(4);
    const [storedRun] = db.collection(RUNS).docs;
    expect(storedRun.coerced_values).toBe(3);
    expect(storedRun.clamped_values).toBe(4);

    // Cycle 2 — real numbers only: clamping happens, coercion does not.
    respond = async (_system, prompt) => {
      const ids = evidenceIndex(prompt);
      return {
        signals: [
          {
            kind: 'tension',
            statement: 'Only a real out-of-range number.',
            why_operationally_relevant: 'Clamped, never coerced.',
            intensity: 9,
            confidence: 0.5,
            valence: 0.1,
            evidence_refs: [ids.mission],
          },
        ],
      };
    };
    const plainRun = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: fixture.missionId,
      cycleId: 'cycle-not-coerced',
      actorId: OWNER.user_id,
    });
    expect(plainRun.status).toBe('completed');
    expect(plainRun.clamped_values).toBe(1);
    expect(plainRun.coerced_values).toBe(0);
    expect(plainRun.trace!.calibration.coerced_by_field).toEqual({});
  });
});
