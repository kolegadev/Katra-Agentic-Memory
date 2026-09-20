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
    owner_id: 'satori',
    success_criteria: [
      { id: 'c1', description: 'first criterion', status: 'unmet' },
      { id: 'c2', description: 'second criterion', status: 'unmet' },
    ],
    objectives: [
      { id: 'o1', description: 'first objective', status: 'in_progress', owner_id: 'satori', dependency_ids: [] },
      { id: 'o2', description: 'second objective', status: 'pending', owner_id: 'satori', dependency_ids: [] },
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
    author_id: 'satori',
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
      deltas.submitDelta(targetDelta(1, 'idx-key-1', 'OBJECTIVE_COMPLETED', '/objectives/0/status'), { actorId: 'satori' }),
    ).rejects.toThrow(/unknown objective id "0"/);

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1); // no advance
    expect(s!.objectives!.map(o => o.status)).toEqual(['in_progress', 'pending']); // unchanged
  });

  it('rejects an OBJECTIVE_COMPLETED path naming an objective that does not exist', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(targetDelta(1, 'unknown-key-1', 'OBJECTIVE_COMPLETED', '/objectives/o99/status'), { actorId: 'satori' }),
    ).rejects.toThrow(/unknown objective id "o99"/);

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1);
  });

  it('rejects an objective-targeted delta whose path is not under /objectives/', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(targetDelta(1, 'badpath-key-1', 'OBJECTIVE_COMPLETED', '/success_criteria/c1'), { actorId: 'satori' }),
    ).rejects.toThrow(/requires an objective path/);

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1);
  });

  it('still accepts a correctly-addressed objective completion, and the status actually changes', async () => {
    await fresh();
    const d = await deltas.submitDelta(
      targetDelta(1, 'good-key-1', 'OBJECTIVE_COMPLETED', '/objectives/o1/status'),
      { actorId: 'satori' },
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
      { actorId: 'satori' },
    );
    expect(d.status).toBe('accepted');

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(2);
    const c1 = s!.success_criteria.find(c => c.id === 'c1')!;
    expect(c1.status).toBe('met');
    expect(c1.evidence_refs).toEqual(['https://example.test/evidence']);
    expect(s!.success_criteria.find(c => c.id === 'c2')!.status).toBe('unmet');
  });

  it('rejects a SUCCESS_CRITERION_UPDATED path naming an unknown criterion', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(
        targetDelta(1, 'crit-key-2', 'SUCCESS_CRITERION_UPDATED', '/success_criteria/c9', { status: 'met' }),
        { actorId: 'satori' },
      ),
    ).rejects.toThrow(/unknown success criterion id "c9"/);

    const s = await missions.getMissionState('test_mission_targets');
    expect(s!.version).toBe(1);
  });

  it('leaves non-targeted deltas unaffected (no false rejections)', async () => {
    await fresh();
    const d = await deltas.submitDelta(
      {
        schema_version: '1.0',
        idempotency_key: 'ledger-key-1',
        mission_id: 'test_mission_targets',
        base_mission_version: 1,
        author_id: 'satori',
        delta_type: 'EVIDENCE_ADDED',
        operations: [{ op: 'add', path: '/ledger_refs/-', value: { entry_type: 'evidence', statement: 'x' } }],
        rationale: 'unit test',
        confidence: 0.5,
      },
      { actorId: 'satori' },
    );
    expect(d.status).toBe('accepted');
    expect((await missions.getMissionState('test_mission_targets'))!.version).toBe(2);
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
