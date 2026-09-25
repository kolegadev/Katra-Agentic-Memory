/**
 * Security: the focused Salience Trace is private.
 *
 * ITER-5 (CONTRACT-iter5-focused-consolidation.md) makes two personal kinds —
 * `salience_traces` and `focused_consolidation_runs` — and this suite is the
 * security boundary for them:
 *
 *   1. an untrusted caller cannot run a consolidation for, or read a trace of,
 *      another identity — even when it names that identity's `user_id`;
 *   2. a trusted caller may name another identity explicitly, and the trace it
 *      produces is attributed to the NAMED identity (never to the operator);
 *   3. neither collection ever carries a `shared_id`, and the write-scope
 *      policy resolves both kinds as personal even against an explicit shared
 *      request;
 *   4. the run leaves the journal / reflection / consolidation_runs
 *      collections untouched.
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
import { MissionStateService } from '../../src/services/mission-cognition/mission-state-service.js';
import { PERSONAL_KINDS, resolveWriteScope } from '../../src/services/memory/write-scope-policy.js';
import {
  FocusedConsolidationService,
  runFocusedConsolidation,
} from '../../src/services/processing/focused-consolidation-service.js';
import { dispatchFocusedTool } from '../../src/services/processing/focused-consolidation-tools.js';
import { FOCUSED_CONSOLIDATION_COLLECTIONS } from '../../src/services/processing/focused-consolidation-collections.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const TRACES = FOCUSED_CONSOLIDATION_COLLECTIONS.salienceTraces;
const RUNS = FOCUSED_CONSOLIDATION_COLLECTIONS.focusedRuns;

const AGENT_A: CallerIdentity = { user_id: 'agent-a', trusted: false };
const AGENT_B: CallerIdentity = { user_id: 'agent-b', trusted: false };
const OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };

const MISSION = 'mission_private_trace';

let db: FakeDb;
let extractJson: ReturnType<typeof vi.spyOn>;

function txt(result: { type: string; text: string }[]): string {
  return result.map((r) => r.text).join('\n');
}

/** A minimal mission owned by `ownerId`, with one ledger entry to cite. */
async function seedMission(ownerId: string): Promise<void> {
  const missions = new MissionStateService(db.asDb());
  await missions.createMissionState({
    schema_version: '1.0',
    mission_id: MISSION,
    title: 'Private by construction',
    intent: 'Prove the privacy boundary of the salience trace.',
    status: 'active',
    owner_id: ownerId,
    success_criteria: [{ id: 'c1', description: 'nothing shared', status: 'unmet' }],
    authority_class: 'B',
    created_at: '',
    updated_at: '',
  } as never);
  db.collection('epistemic_entries').docs.push({
    schema_version: '1.0',
    entry_id: 'entry_seed_1',
    mission_id: MISSION,
    entry_type: 'uncertainty',
    status: 'active',
    author_id: ownerId,
    confidence: 0.4,
    statement: 'Whether the boundary holds under concurrency.',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

beforeEach(() => {
  db = new FakeDb();
  holder.db = db;
  extractJson = vi.spyOn(llmService, 'extractJson').mockImplementation((async (_system: string, prompt: string) => ({
    signals: [
      {
        kind: 'tension',
        statement: 'The boundary is only as strong as its weakest read path.',
        why_operationally_relevant: 'A single unscoped read leaks the whole trace.',
        intensity: 0.7,
        confidence: 0.6,
        valence: -0.3,
        evidence_refs: [MISSION, 'entry_seed_1'],
      },
    ],
  })) as never);
  vi.spyOn(llmService, 'getServiceStatus').mockReturnValue({
    available: true,
    provider: 'stub',
    model: 'test-model',
    providers: ['stub(ready)'],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FOCUSED_IMAGINATION;
});

describe('Security: focused consolidation is caller-pinned', () => {
  it('an untrusted caller cannot run another identity\'s mission', async () => {
    await seedMission(AGENT_A.user_id);
    process.env.FOCUSED_IMAGINATION = '1';

    const denied = await dispatchFocusedTool(
      'run_focused_consolidation',
      { mission_id: MISSION, cycle_id: 'security-cycle' },
      AGENT_B,
    );

    expect(txt(denied)).toContain('Not authorized');
    expect(db.collection(RUNS).docs).toHaveLength(0);
    expect(db.collection(TRACES).docs).toHaveLength(0);
    expect(extractJson).not.toHaveBeenCalled();
  });

  it('an untrusted caller cannot read another identity\'s trace, by id or by mission', async () => {
    await seedMission(AGENT_A.user_id);
    const owner = await runFocusedConsolidation(db.asDb(), {
      userId: AGENT_A.user_id,
      missionId: MISSION,
      cycleId: 'security-owner',
      actorId: AGENT_A.user_id,
    });
    expect(owner.status).toBe('completed');
    process.env.FOCUSED_IMAGINATION = '1';

    const byId = await dispatchFocusedTool('get_salience_trace', { trace_id: owner.trace_id! }, AGENT_B);
    expect(txt(byId)).toContain('No salience trace found');
    expect(txt(byId)).not.toContain('tension');

    const byMission = await dispatchFocusedTool('get_salience_trace', { mission_id: MISSION }, AGENT_B);
    expect(txt(byMission)).toContain('Not authorized');

    // Naming the owner's identity does not widen an untrusted caller's scope.
    const spoofed = await dispatchFocusedTool(
      'get_salience_trace',
      { mission_id: MISSION, user_id: AGENT_A.user_id },
      AGENT_B,
    );
    expect(txt(spoofed)).toContain('Not authorized');

    const unscoped = new FocusedConsolidationService(db.asDb());
    expect(await unscoped.getTraces(AGENT_B.user_id, { missionId: MISSION })).toEqual([]);
    expect(await unscoped.getTraces(AGENT_A.user_id, { missionId: MISSION })).toHaveLength(1);
  });

  it('a supplied user_id cannot re-attribute an untrusted caller\'s own run', async () => {
    await seedMission(AGENT_A.user_id);
    process.env.FOCUSED_IMAGINATION = '1';

    const result = await dispatchFocusedTool(
      'run_focused_consolidation',
      { mission_id: MISSION, cycle_id: 'security-spoof', user_id: AGENT_B.user_id },
      AGENT_A,
    );

    expect(txt(result)).toContain('Focused consolidation complete');
    const [run] = db.collection(RUNS).docs;
    expect(run.user_id).toBe(AGENT_A.user_id);
    expect(db.collection(TRACES).docs[0].user_id).toBe(AGENT_A.user_id);
    // …so agent-b still cannot read it.
    const service = new FocusedConsolidationService(db.asDb());
    expect(await service.getTraces(AGENT_B.user_id, {})).toEqual([]);
  });

  it('a trusted caller may name another identity, and the trace is attributed to it', async () => {
    await seedMission(OPERATOR.user_id);
    const result = await runFocusedConsolidation(db.asDb(), {
      userId: AGENT_A.user_id, // trusted operator acting for agent-a
      missionId: MISSION,
      cycleId: 'security-trusted',
      actorId: OPERATOR.user_id,
    });

    expect(result.status).toBe('completed');
    expect(result.trace!.user_id).toBe(AGENT_A.user_id);
    expect(result.run.user_id).toBe(AGENT_A.user_id);
    expect(result.run.actor_id).toBe(OPERATOR.user_id);
    // …and agent-a can read it, while agent-b cannot.
    const service = new FocusedConsolidationService(db.asDb());
    expect(await service.getTraces(AGENT_A.user_id, {})).toHaveLength(1);
    expect(await service.getTraces(AGENT_B.user_id, {})).toEqual([]);
  });

  it('never writes a shared_id and resolves both collections as personal kinds', async () => {
    await seedMission(AGENT_A.user_id);
    await runFocusedConsolidation(db.asDb(), {
      userId: AGENT_A.user_id,
      missionId: MISSION,
      cycleId: 'security-scope',
      actorId: AGENT_A.user_id,
    });

    expect(PERSONAL_KINDS).toContain(TRACES);
    expect(PERSONAL_KINDS).toContain(RUNS);
    for (const kind of [TRACES, RUNS]) {
      expect(
        resolveWriteScope({
          caller: { user_id: AGENT_A.user_id, trusted: true },
          kind,
          requested: { shared_id: 'my-team', private: false },
        }),
      ).toEqual({ user_id: AGENT_A.user_id, shared_id: null });
    }
    for (const name of [TRACES, RUNS]) {
      expect(db.collection(name).docs.length).toBeGreaterThan(0);
      for (const doc of db.collection(name).docs) {
        expect('shared_id' in doc).toBe(false);
      }
      const registrations = db.collection(name).createdIndexes.map((index) => index.name);
      expect(registrations.length).toBeGreaterThan(0);
    }
  });

  it('leaves the journal, reflection and consolidation_runs collections untouched', async () => {
    await seedMission(AGENT_A.user_id);
    db.collection('reflective_journals').docs.push({
      user_id: AGENT_A.user_id,
      period_type: 'weekly',
      narrative: 'private narrative',
      unresolved_threads: ['private thread'],
      created_at: new Date('2026-09-19T00:00:00.000Z'),
    });
    db.collection('reflection_nodes').docs.push({ user_id: AGENT_A.user_id, entity_name: 'x' });
    db.collection('consolidation_runs').docs.push({ period: 'weekly', last_run: 42 });
    const before = JSON.stringify(
      ['reflective_journals', 'reflection_nodes', 'reflection_edges', 'consolidation_runs'].map((name) => [
        name,
        db.collection(name).docs,
      ]),
    );

    await runFocusedConsolidation(db.asDb(), {
      userId: AGENT_A.user_id,
      missionId: MISSION,
      cycleId: 'security-untouched',
      actorId: AGENT_A.user_id,
    });

    const after = JSON.stringify(
      ['reflective_journals', 'reflection_nodes', 'reflection_edges', 'consolidation_runs'].map((name) => [
        name,
        db.collection(name).docs,
      ]),
    );
    expect(after).toBe(before);
  });
});
