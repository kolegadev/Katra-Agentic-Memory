/**
 * Unit tests — fail-closed target resolution for state deltas (Phase 1 hardening).
 *
 * Regression cover for an accepted-but-ineffective write found in production:
 * `applyDeltaToState` writes every targeted branch as `if (obj)` / `if (criterion)`,
 * so a delta naming a target that does not exist was recorded `accepted`, advanced
 * the mission version, and changed nothing. The plane reported success for a write
 * that had no effect.
 *
 * Observed live: three `OBJECTIVE_COMPLETED` deltas carrying paths of the form
 * `/objectives/0/status` (array index) rather than `/objectives/<objective_id>/status`
 * were accepted, took the mission from v14 to v17, and left every objective untouched.
 * The JSON Schema only requires `path` to start with `/`, so index-shaped paths passed
 * validation cleanly.
 *
 * The contract these tests pin: a targeted delta whose path does not resolve to a real
 * target is REJECTED before any write, leaving version and state unchanged.
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, vi } from 'vitest';

// Hermetic: point the advisory event rail at a dead port.
process.env.REDIS_URL = 'redis://127.0.0.1:6399';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';

const FAKE_DB = new FakeDb();

import { MissionStateService } from '../../src/services/mission-cognition/mission-state-service.js';
import { StateDeltaService, assertTargetsResolve } from '../../src/services/mission-cognition/state-delta-service.js';
import type { MissionState, StateDeltaDraft } from '../../src/types/cognitive-control.js';

const db = FAKE_DB.asDb();
const missions = new MissionStateService(db);
const deltas = new StateDeltaService(db);

function baseMission(overrides: Partial<MissionState> = {}): MissionState {
  return {
    schema_version: '1.0',
    mission_id: 'test_mission_targets',
    version: 1,
    title: 'Target resolution',
    intent: 'Prove targeted deltas fail closed.',
    status: 'active',
    owner_id: 'agent-a',
    success_criteria: [
      { id: 'c1', description: 'first criterion', status: 'unmet' },
      { id: 'c2', description: 'second criterion', status: 'unmet' },
    ],
    objectives: [
      { id: 'o1', description: 'first objective', status: 'in_progress', owner_id: 'agent-a', dependency_ids: [] },
      { id: 'o2', description: 'second objective', status: 'pending', owner_id: 'agent-a', dependency_ids: [] },
    ],
    authority_class: 'B',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function targetDelta(
  base: number,
  idemKey: string,
  delta_type: StateDeltaDraft['delta_type'],
  path: string,
  value?: unknown,
): StateDeltaDraft {
  return {
    schema_version: '1.0',
    idempotency_key: idemKey,
    mission_id: 'test_mission_targets',
    base_mission_version: base,
    author_id: 'agent-a',
    delta_type,
    operations: [{ op: 'replace', path, ...(value === undefined ? {} : { value }) }],
    rationale: 'unit test',
    confidence: 0.9,
  };
}

async function fresh(): Promise<void> {
  FAKE_DB.reset();
  await missions.createMissionState(baseMission());
}

describe('state-delta target resolution fails closed', () => {
  it('rejects an OBJECTIVE_COMPLETED path that uses an array index instead of an objective id', async () => {
    // The exact shape that silently no-opped in production.
    await fresh();
    await expect(
      deltas.submitDelta(targetDelta(1, 'idx-key-1', 'OBJECTIVE_COMPLETED', '/objectives/0/status'), { actorId: 'agent-a' }),
    ).rejects.toThrow(/unknown objective id "0"/);

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1); // no advance
    expect(s!.objectives!.map(o => o.status)).toEqual(['in_progress', 'pending']); // unchanged
  });

  it('rejects an OBJECTIVE_COMPLETED path naming an objective that does not exist', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(targetDelta(1, 'unknown-key-1', 'OBJECTIVE_COMPLETED', '/objectives/o99/status'), { actorId: 'agent-a' }),
    ).rejects.toThrow(/unknown objective id "o99"/);

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1);
  });

  it('rejects an objective-targeted delta whose path is not under /objectives/', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(targetDelta(1, 'badpath-key-1', 'OBJECTIVE_COMPLETED', '/success_criteria/c1'), { actorId: 'agent-a' }),
    ).rejects.toThrow(/requires an objective path/);

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1);
  });

  it('still accepts a correctly-addressed objective completion, and the status actually changes', async () => {
    await fresh();
    const d = await deltas.submitDelta(
      targetDelta(1, 'good-key-1', 'OBJECTIVE_COMPLETED', '/objectives/o1/status'),
      { actorId: 'agent-a' },
    );
    expect(d.status).toBe('accepted');

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(2);
    expect(s!.objectives!.find(o => o.id === 'o1')!.status).toBe('completed');
    expect(s!.objectives!.find(o => o.id === 'o2')!.status).toBe('pending'); // sibling untouched
  });

  it('accepts a SUCCESS_CRITERION_UPDATED delta and mutates only the named criterion', async () => {
    await fresh();
    const d = await deltas.submitDelta(
      targetDelta(1, 'crit-key-1', 'SUCCESS_CRITERION_UPDATED', '/success_criteria/c1', {
        status: 'met',
        evidence_refs: ['https://example.test/evidence'],
      }),
      { actorId: 'agent-a' },
    );
    expect(d.status).toBe('accepted');

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(2);
    const c1 = s!.success_criteria.find(c => c.id === 'c1')!;
    expect(c1.status).toBe('met');
    expect(c1.evidence_refs).toEqual(['https://example.test/evidence']);
    expect(s!.success_criteria.find(c => c.id === 'c2')!.status).toBe('unmet');
  });

  it('accepts a RAW-STRING value on a /status path \u2014 the form a caller naturally sends', async () => {
    // Regression: the applier originally read op0.value.status, which is
    // undefined when value is the raw string 'met'. The delta was ACCEPTED,
    // the version advanced, and the criterion did not change: the same
    // accepted-but-ineffective class this file exists to catch. Every other
    // test here passed while this was broken, because they all used the
    // {status: ...} object form and real callers use the string form.
    await fresh();
    const d = await deltas.submitDelta(
      targetDelta(1, 'crit-raw-1', 'SUCCESS_CRITERION_UPDATED', '/success_criteria/c1/status', 'met'),
      { actorId: 'agent-a' },
    );
    expect(d.status).toBe('accepted');
    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.success_criteria.find(c => c.id === 'c1')!.status).toBe('met');
    expect(s!.success_criteria.find(c => c.id === 'c2')!.status).toBe('unmet');
  });

  it('accepts the {status} object form too, and does not blank a status when the value is absent', async () => {
    await fresh();
    await deltas.submitDelta(
      targetDelta(1, 'crit-obj-1', 'SUCCESS_CRITERION_UPDATED', '/success_criteria/c1/status', { status: 'partial' }),
      { actorId: 'agent-a' },
    );
    let s = await missions.getMissionState('test_mission_targets');
    expect(s!.success_criteria.find(c => c.id === 'c1')!.status).toBe('partial');

    // A value-less update is now REFUSED rather than accepted as a no-op
    // (Verifier break-attempt: it used to pass the assertion, change nothing,
    // and still advance the version).
    await expect(
      deltas.submitDelta(
        targetDelta(2, 'crit-noop-1', 'SUCCESS_CRITERION_UPDATED', '/success_criteria/c1/status'),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/requires operations\[0\]\.value/);
    s = await missions.getMissionState('test_mission_targets');
    expect(s!.success_criteria.find(c => c.id === 'c1')!.status).toBe('partial');
    expect(s!.version).toBe(2); // the refusal wrote nothing
  });

  it('rejects a SUCCESS_CRITERION_UPDATED path naming an unknown criterion', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'crit-key-2', 'SUCCESS_CRITERION_UPDATED', '/success_criteria/c9', { status: 'met' }),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/unknown success criterion id "c9"/);

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1);
  });

  it('leaves well-formed non-targeted deltas unaffected (no false rejections)', async () => {
    // NB: this test previously submitted EVIDENCE_ADDED with the statement in
    // operations[].value and NO ledger_entries, and asserted it was accepted —
    // i.e. it pinned the very no-op that later ate the research findings. It now
    // submits a complete delta.
    await fresh();
    const d = await deltas.submitDelta(
      {
        schema_version: '1.0',
        idempotency_key: 'ledger-key-1',
        mission_id: 'test_mission_targets',
        base_mission_version: 1,
        author_id: 'agent-a',
        delta_type: 'EVIDENCE_ADDED',
        operations: [{ op: 'add', path: '/ledger_refs/-', value: null }],
        ledger_entries: [{
          schema_version: '1.0', mission_id: 'test_mission_targets', entry_type: 'evidence',
          statement: 'a complete finding', status: 'accepted', author_id: 'agent-a', confidence: 0.7,
        }],
        rationale: 'unit test',
        confidence: 0.5,
      } as StateDeltaDraft,
      { actorId: 'agent-a' },
    );
    expect(d.status).toBe('accepted');
    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(2);
    expect((s!.ledger_refs ?? []).length).toBe(1);
  });

  it('OBJECTIVE_CREATED in operations[].value ACTUALLY creates the objective', async () => {
    // Regression: the applier read op0.objective, which the operation schema
    // (additionalProperties:false, only op/path/value/from) can never produce,
    // so every OBJECTIVE_CREATED was a silent no-op.
    await fresh();
    const d = await deltas.submitDelta(
      {
        ...targetDelta(1, 'obj-create-1', 'OBJECTIVE_CREATED', '/objectives/o3', {
          id: 'o3', description: 'third objective', status: 'pending', owner_id: 'agent-a',
        }),
      } as StateDeltaDraft,
      { actorId: 'agent-a' },
    );
    expect(d.status).toBe('accepted');
    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(2);
    expect(s!.objectives!.map(o => o.id)).toEqual(['o1', 'o2', 'o3']);
  });

  it('rejects MISSION_STATUS_CHANGED with no status — the applier would no-op', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'status-bad-1', 'MISSION_STATUS_CHANGED', '/status'),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/requires operations\[0\]\.value/);
    expect((await missions.getMissionState('test_mission_targets'))!.version).toBe(1);
  });

  it('applies MISSION_STATUS_CHANGED carried in value — the only form the operation contract allows', async () => {
    // The regression: the guard required `operations[0].status`, a field the
    // operation contract (op/path/value/from) forbids, so the delta could not
    // be expressed at all. Found by the generator on 2026-10-21 while exercising the
    // long-horizon feature — the test mission could not be closed.
    await fresh();
    const d = await deltas.submitDelta(
      targetDelta(1, 'status-value-1', 'MISSION_STATUS_CHANGED', '/status', 'completed'),
      { actorId: 'agent-a' },
    );
    expect(d.status).toBe('accepted');

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(2);
    expect(s!.status).toBe('completed');
  });

  it('names the allowed delta_types when it refuses an unknown one', async () => {
    // The enum IS enforced (JSON schema), but the refusal used to read "must be
    // equal to one of the allowed values" and name none of them, so the caller
    // had to open the schema to discover the set. Reported by the generator 2026-10-21.
    await fresh();
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'unknown-type-1', 'NOT_A_DELTA' as never, '/status', 'completed'),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/allowed: .*MISSION_STATUS_CHANGED/);
    expect((await missions.getMissionState('test_mission_targets'))!.version).toBe(1);
  });

  it('refuses a MISSION_STATUS_CHANGED status the state schema would reject', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'status-junk-1', 'MISSION_STATUS_CHANGED', '/status', 'finished'),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/is not a mission status/);
    expect((await missions.getMissionState('test_mission_targets'))!.version).toBe(1);
  });

  it('rejects OBJECTIVE_CREATED with an incomplete objective — the applier would no-op', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(
        {
          ...targetDelta(1, 'obj-bad-1', 'OBJECTIVE_CREATED', '/objectives/o3'),
          // id present but no description: the applier guard would skip it, so the
          // delta must be refused rather than accepted as a no-op.
          operations: [{ op: 'add', path: '/objectives/o3', value: { id: 'o3' } }],
        } as StateDeltaDraft,
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/requires operations\[0\]\.value with a string id/);
    expect((await missions.getMissionState('test_mission_targets'))!.objectives!.length).toBe(2);
  });

  it('rejects a ledger-reference delta with NO ledger_entries — content would be discarded', async () => {
    // The failure that silently ate the research mission findings: the statement
    // sat in operations[].value, the ledger stayed empty, and the version advanced.
    await fresh();
    await expect(
      deltas.submitDelta(
        {
          ...targetDelta(1, 'noledger-1', 'EVIDENCE_ADDED', '/ledger_refs/-', {
            entry_type: 'evidence',
            statement: 'content that would have been thrown away',
          }),
        },
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/carries no ledger_entries/);
    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1);
    expect(s!.ledger_refs ?? []).toEqual([]);
  });

  it('accepts a ledger-reference delta WITH a ledger entry, and the ref actually lands', async () => {
    await fresh();
    const d = await deltas.submitDelta(
      {
        ...targetDelta(1, 'ledger-ok-1', 'EVIDENCE_ADDED', '/ledger_refs/-'),
        ledger_entries: [
          {
            schema_version: '1.0',
            mission_id: 'test_mission_targets',
            entry_type: 'evidence',
            statement: 'a real finding',
            status: 'accepted',
            author_id: 'agent-a',
            confidence: 0.9,
          },
        ],
      } as StateDeltaDraft,
      { actorId: 'agent-a' },
    );
    expect(d.status).toBe('accepted');
    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(2);
    expect((s!.ledger_refs ?? []).length).toBe(1);
  });

  it('refuses OBJECTIVE_UPDATED with no value and with value={} (Verifier break-attempt)', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'objupd-noval-1', 'OBJECTIVE_UPDATED', '/objectives/o1/status'),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/requires operations\[0\]\.value/);
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'objupd-empty-1', 'OBJECTIVE_UPDATED', '/objectives/o1/status', {}),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/requires operations\[0\]\.value/);
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'objupd-blank-1', 'OBJECTIVE_UPDATED', '/objectives/o1/status', { description: '   ' }),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/non-empty string/);
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'objupd-badstatus-1', 'OBJECTIVE_UPDATED', '/objectives/o1/status', { status: 'banana' }),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/valid status/);

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1); // nothing accepted
    expect(s!.objectives!.find(o => o.id === 'o1')!.status).toBe('in_progress');
  });

  it('accepts a RAW-STRING status on a /status path, in parity with SUCCESS_CRITERION_UPDATED', async () => {
    // Regression: the criterion path accepted the raw string and the objective path
    // did not, so the two siblings disagreed. A `replace` on a /status path carrying
    // the raw string is the natural caller form.
    await fresh();
    const d = await deltas.submitDelta(
      targetDelta(1, 'objupd-raw-1', 'OBJECTIVE_UPDATED', '/objectives/o1/status', 'in_progress'),
      { actorId: 'agent-a' },
    );
    expect(d.status).toBe('accepted');
    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(2);
    expect(s!.objectives!.find(o => o.id === 'o1')!.status).toBe('in_progress');
  });

  it('the two /status siblings accept the SAME forms — parity check', async () => {
    await fresh();
    // same raw-string shape, one on each type; both must be accepted
    const a = await deltas.submitDelta(
      targetDelta(1, 'parity-obj-1', 'OBJECTIVE_UPDATED', '/objectives/o2/status', 'ready'),
      { actorId: 'agent-a' },
    );
    const b = await deltas.submitDelta(
      targetDelta(2, 'parity-crit-1', 'SUCCESS_CRITERION_UPDATED', '/success_criteria/c1/status', 'met'),
      { actorId: 'agent-a' },
    );
    expect(a.status).toBe('accepted');
    expect(b.status).toBe('accepted');
    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.objectives!.find(o => o.id === 'o2')!.status).toBe('ready');
    expect(s!.success_criteria.find(c => c.id === 'c1')!.status).toBe('met');
  });

  it('still accepts a real OBJECTIVE_UPDATED value', async () => {
    await fresh();
    const d = await deltas.submitDelta(
      targetDelta(1, 'objupd-ok-1', 'OBJECTIVE_UPDATED', '/objectives/o1/status', { status: 'ready' }),
      { actorId: 'agent-a' },
    );
    expect(d.status).toBe('accepted');
    expect((await missions.getMissionState('test_mission_targets'))!.objectives!.find(o => o.id === 'o1')!.status).toBe('ready');
  });

  it('refuses SUCCESS_CRITERION_UPDATED with value={} and with a junk status', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'crit-empty-1', 'SUCCESS_CRITERION_UPDATED', '/success_criteria/c1/status', {}),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/requires operations\[0\]\.value/);
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'crit-junk-1', 'SUCCESS_CRITERION_UPDATED', '/success_criteria/c1/status', 'done'),
        { actorId: 'agent-a' },
      ),
    ).rejects.toThrow(/requires operations\[0\]\.value/);
    expect((await missions.getMissionState('test_mission_targets'))!.version).toBe(1);
  });

  it('assertTargetsResolve is a pure predicate — it throws without touching state', () => {
    const state = baseMission();
    expect(() =>
      assertTargetsResolve(state, targetDelta(1, 'pure-key-1', 'OBJECTIVE_COMPLETED', '/objectives/0/status')),
    ).toThrow();
    expect(state.version).toBe(1);
    expect(state.objectives!.map(o => o.status)).toEqual(['in_progress', 'pending']);
  });
});
