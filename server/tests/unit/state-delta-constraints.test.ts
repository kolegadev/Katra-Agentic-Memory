/**
 * Unit tests — constraint addition via state delta, and the class guard that
 * stops ANY operation from riding along unapplied.
 *
 * TWO defects are covered here, and they are not the same defect.
 *
 * (1) CONSTRAINT ADDITION WAS NEVER IMPLEMENTED. `MissionState.constraints`
 *     exists, the mission-state schema defines its shape, and `add /constraints/-`
 *     is a structurally valid JSON-Patch operation — but no branch of
 *     `applyDeltaToState` wrote to `constraints`, and no branch of
 *     `assertTargetsResolve` knew the path existed. So the operation was accepted,
 *     the version advanced, the ledger entries landed, and the constraint vanished.
 *
 *     Reproduced SEVEN times by the P vs NP long-horizon mission
 *     (ms_1789916674515_sz2pzc) on 2026-09-20/21, which submitted the operation
 *     with markers PVNP-LOOP-MARKER-C2 … C7 and found `constraints` still reading
 *     C1–C4 every time. The mission's own tooling note concluded the mission
 *     "cannot be amended by any delta type" — which was true, and was a missing
 *     feature rather than a policy.
 *
 * (2) THE SILENCE WAS THE REAL BUG. Cases 1–3 in this service's header were each
 *     fixed by repairing one applier branch, which is exactly why a fourth
 *     appeared. The class guard at the foot of `assertTargetsResolve` does not
 *     enumerate paths: it rejects any operation that reaches it, because reaching
 *     it at all means the delta type takes its effect from ledger_entries and the
 *     applier's `default:` branch will ignore the operation.
 *
 * The contract these tests pin:
 *   - CONSTRAINT_ADDED applies, and the constraint is readable from state;
 *   - an incomplete CONSTRAINT_ADDED is rejected before any write;
 *   - an operation on an unappliable path is REJECTED, not silently discarded;
 *   - `/ledger_refs/...` remains an accepted inert audit marker (invalidation.ts
 *     emits one, and the delta schema requires >= 1 operation).
 *
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
import {
  StateDeltaService,
  applyDeltaToState,
} from '../../src/services/mission-cognition/state-delta-service.js';
import type {
  MissionState,
  StateDelta,
  StateDeltaDraft,
} from '../../src/types/cognitive-control.js';

const db = FAKE_DB.asDb();
const missions = new MissionStateService(db);
const deltas = new StateDeltaService(db);

const C1 = { id: 'C1', kind: 'time' as const, description: 'Six hours wall clock.' };

function baseMission(overrides: Partial<MissionState> = {}): MissionState {
  return {
    schema_version: '1.0',
    mission_id: 'test_mission_constraints',
    version: 1,
    title: 'Constraint addition',
    intent: 'Prove a constraint operation either lands or is refused.',
    status: 'active',
    owner_id: 'satori',
    success_criteria: [{ id: 'c1', description: 'first criterion', status: 'unmet' }],
    objectives: [
      { id: 'o1', description: 'first objective', status: 'in_progress', owner_id: 'satori', dependency_ids: [] },
    ],
    constraints: [C1],
    authority_class: 'B',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function delta(
  base: number,
  idemKey: string,
  delta_type: StateDeltaDraft['delta_type'],
  operations: Array<Record<string, unknown>>,
  ledger_entries?: StateDeltaDraft['ledger_entries'],
): StateDeltaDraft {
  return {
    schema_version: '1.0',
    idempotency_key: idemKey,
    mission_id: 'test_mission_constraints',
    base_mission_version: base,
    author_id: 'satori',
    delta_type,
    operations: operations as StateDeltaDraft['operations'],
    ledger_entries,
    rationale: 'unit test',
    confidence: 0.9,
  };
}

const C5 = {
  id: 'C5',
  kind: 'time',
  description: 'Window extended to 00:04 local 2026-09-21 (granted by the operator).',
};

async function fresh(): Promise<void> {
  FAKE_DB.reset();
  await missions.createMissionState(baseMission());
}

describe('constraint addition is a real, applicable effect', () => {
  it('CONSTRAINT_ADDED appends the constraint and it is readable from state', async () => {
    await fresh();
    const d = await deltas.submitDelta(
      delta(1, 'cadd-ok-0001', 'CONSTRAINT_ADDED', [{ op: 'add', path: '/constraints/-', value: C5 }]),
      { actorId: 'satori' },
    );
    expect(d.status).toBe('accepted');

    const s = await missions.getMissionState('test_mission_constraints');
    expect(s!.version).toBe(2);
    // The assertion the mission loop could never make:
    expect(s!.constraints!.map(c => c.id)).toEqual(['C1', 'C5']);
    expect(s!.constraints!.find(c => c.id === 'C5')!.description).toContain('00:04');
  });

  it('accepts the bare /constraints path as well as /constraints/-', async () => {
    await fresh();
    const d = await deltas.submitDelta(
      delta(1, 'cadd-bare-0001', 'CONSTRAINT_ADDED', [{ op: 'add', path: '/constraints', value: C5 }]),
      { actorId: 'satori' },
    );
    expect(d.status).toBe('accepted');
    expect((await missions.getMissionState('test_mission_constraints'))!.constraints!.map(c => c.id))
      .toEqual(['C1', 'C5']);
  });

  it('does not double-add a constraint whose id is already present', async () => {
    await fresh();
    await deltas.submitDelta(
      delta(1, 'cadd-dup-0001', 'CONSTRAINT_ADDED', [{ op: 'add', path: '/constraints/-', value: C5 }]),
      { actorId: 'satori' },
    );
    await deltas.submitDelta(
      delta(2, 'cadd-dup-0002', 'CONSTRAINT_ADDED', [{ op: 'add', path: '/constraints/-', value: { ...C5, description: 'restated' } }]),
      { actorId: 'satori' },
    );
    const s = await missions.getMissionState('test_mission_constraints');
    expect(s!.constraints!.map(c => c.id)).toEqual(['C1', 'C5']);
    expect(s!.constraints!).toHaveLength(2);
  });

  it('rejects an incomplete CONSTRAINT_ADDED before any write', async () => {
    await fresh();
    const bad = [
      { ...C5, id: undefined },                       // no id
      { ...C5, id: '   ' },                           // blank id
      { ...C5, kind: 'not-a-kind' },                  // kind outside the enum
      { ...C5, description: '' },                     // no description
      {},                                             // nothing at all
    ];
    for (const [i, value] of bad.entries()) {
      await expect(
        deltas.submitDelta(
          delta(1, `cadd-bad-000${i}`, 'CONSTRAINT_ADDED', [{ op: 'add', path: '/constraints/-', value }]),
          { actorId: 'satori' },
        ),
      ).rejects.toThrow(/CONSTRAINT_ADDED requires/);
    }
    const s = await missions.getMissionState('test_mission_constraints');
    expect(s!.version).toBe(1);                    // never advanced
    expect(s!.constraints!.map(c => c.id)).toEqual(['C1']);
  });

  it('rejects a CONSTRAINT_ADDED pointing at a path that is not /constraints', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(
        delta(1, 'cadd-path-0001', 'CONSTRAINT_ADDED', [{ op: 'add', path: '/objectives/o1/status', value: C5 }]),
        { actorId: 'satori' },
      ),
    ).rejects.toThrow(/requires path \/constraints/);
    expect((await missions.getMissionState('test_mission_constraints'))!.version).toBe(1);
  });

  it('applyDeltaToState is pure for CONSTRAINT_ADDED', () => {
    const state = baseMission();
    const before = JSON.stringify(state);
    const next = applyDeltaToState(
      state,
      {
        delta_id: 'pure-1',
        delta_type: 'CONSTRAINT_ADDED',
        operations: [{ op: 'add', path: '/constraints/-', value: C5 }],
        ledger_entries: [],
      } as unknown as StateDelta,
      '2026-09-21T00:00:00.000Z',
    );
    expect(next.constraints!.map(c => c.id)).toEqual(['C1', 'C5']);
    expect(JSON.stringify(state)).toBe(before);     // the input was not mutated
  });
});

describe('the class guard: no operation rides along unapplied', () => {
  it('REJECTS the exact production shape — /constraints/- riding on an EVIDENCE_ADDED delta', async () => {
    // This is what the P vs NP mission submitted, seven times, and was told
    // `accepted` each time. It must now be refused, loudly, before any write.
    await fresh();
    await expect(
      deltas.submitDelta(
        delta(
          1,
          'guard-evid-0001',
          'EVIDENCE_ADDED',
          [{ op: 'add', path: '/constraints/-', value: C5 }],
          [{
            schema_version: '1.0',
            mission_id: 'test_mission_constraints',
            entry_type: 'evidence',
            statement: 'PVNP-LOOP-MARKER-C8 — must not be silently dropped.',
            status: 'accepted',
            author_id: 'satori',
            confidence: 0.9,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }] as StateDeltaDraft['ledger_entries'],
        ),
        { actorId: 'satori' },
      ),
    ).rejects.toThrow(/no applier\s+branch can apply that path|no applier branch can apply that path/);

    const s = await missions.getMissionState('test_mission_constraints');
    expect(s!.version).toBe(1);                     // no silent advance
    expect(s!.constraints!.map(c => c.id)).toEqual(['C1']);
    expect(s!.ledger_refs ?? []).toHaveLength(0);   // and no ledger refs either
  });

  it('guards the whole class, not just /constraints — an arbitrary unknown path is refused', async () => {
    await fresh();
    await expect(
      deltas.submitDelta(
        delta(
          1,
          'guard-arb-0001',
          'PLAN_CHANGE_PROPOSED',
          [{ op: 'replace', path: '/stop_conditions/-', value: 'never' }],
          [{
            schema_version: '1.0',
            mission_id: 'test_mission_constraints',
            entry_type: 'decision',
            statement: 'arbitrary path must not be silently accepted',
            status: 'accepted',
            author_id: 'satori',
            confidence: 0.9,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }] as StateDeltaDraft['ledger_entries'],
        ),
        { actorId: 'satori' },
      ),
    ).rejects.toThrow(/no applier branch can apply that path/);
    expect((await missions.getMissionState('test_mission_constraints'))!.version).toBe(1);
  });

  it('still accepts /ledger_refs/... as an inert audit marker (invalidation path preserved)', async () => {
    await fresh();
    const d = await deltas.submitDelta(
      delta(
        1,
        'guard-audit-0001',
        'DECISION_INVALIDATED',
        [{ op: 'replace', path: '/ledger_refs/dec-1', value: 'invalidated' }],
        [{
          schema_version: '1.0',
          mission_id: 'test_mission_constraints',
          entry_type: 'contradiction',
          statement: 'decision invalidated for the test',
          status: 'active',
          author_id: 'satori',
          confidence: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }] as StateDeltaDraft['ledger_entries'],
      ),
      { actorId: 'satori' },
    );
    expect(d.status).toBe('accepted');
    // The marker is NOT applied to state — documented, not accidental.
    const s = await missions.getMissionState('test_mission_constraints');
    expect(s!.version).toBe(2);
    expect(s!.ledger_refs!.length).toBe(1);         // from the ledger entry, not the marker
  });

  it('a ledger-reference delta with NO operation now works — the MCP layer\'s own default was invalid', async () => {
    // `submit_state_delta`'s MCP input schema declares
    //     operations: z.array(z.record(z.string(), z.unknown())).default([])
    // so a caller that OMITS operations has `[]` sent for it — and the JSON schema
    // then rejected it with "/operations must NOT have fewer than 1 items".
    // The tool rejected its own default. Since a ledger-reference delta takes its
    // entire effect from ledger_entries, requiring a dummy operation was forcing
    // callers to write a no-op purely to satisfy a validator — which is how the
    // inert `/ledger_refs/` marker idiom arose in the first place. `minItems` is
    // now 0 and ledger-only deltas are legitimate.
    await fresh();
    const d = await deltas.submitDelta(
      delta(
        1,
        'guard-noop-0001',
        'EVIDENCE_ADDED',
        [],
        [{
          schema_version: '1.0',
          mission_id: 'test_mission_constraints',
          entry_type: 'evidence',
          statement: 'ledger-only delta',
          status: 'accepted',
          author_id: 'satori',
          confidence: 0.9,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }] as StateDeltaDraft['ledger_entries'],
      ),
      { actorId: 'satori' },
    );
    expect(d.status).toBe('accepted');
    const s = await missions.getMissionState('test_mission_constraints');
    expect(s!.version).toBe(2);
    expect(s!.ledger_refs!.length).toBe(1);        // the ledger entry IS the effect
  });
});
