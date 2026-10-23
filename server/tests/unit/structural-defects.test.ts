import { describe, it, expect } from 'vitest';
import {
  applyDeltaToState,
  assertTargetsResolve,
  DELTA_TYPES,
} from '../../src/services/mission-cognition/state-delta-service.js';
import { normaliseHumanGate } from '../../src/services/mission-cognition/human-gate.js';
import type { MissionState, StateDelta } from '../../src/types/cognitive-control.js';

const baseState = (): MissionState => ({
  schema_version: '1.0',
  mission_id: 'ms_test',
  title: 'stop-condition defect',
  intent: 'prove stop_conditions can change after intake',
  status: 'active',
  owner_id: 'tester',
  success_criteria: [],
  stop_conditions: ['owner intervention'],
  constraints: [],
  authority_class: 'B',
  objectives: [],
  created_at: '2026-10-23T00:00:00.000Z',
  updated_at: '2026-10-23T00:00:00.000Z',
  version: 1,
  ledger_refs: [],
} as unknown as MissionState);

const delta = (value: unknown): StateDelta => ({
  schema_version: '1.0',
  delta_id: 'd1',
  idempotency_key: 'idem-12345678',
  mission_id: 'ms_test',
  base_mission_version: 1,
  author_id: 'tester',
  delta_type: 'STOP_CONDITIONS_CHANGED',
  operations: [{ op: 'replace', path: '/stop_conditions', value }],
  rationale: 'the set has to be storable to govern the mission',
  confidence: 0.9,
  created_at: '2026-10-23T00:00:00.000Z',
} as unknown as StateDelta);

describe('STOP_CONDITIONS_CHANGED (defect 1)', () => {
  it('is a declared delta type', () => {
    expect(DELTA_TYPES).toContain('STOP_CONDITIONS_CHANGED');
  });

  it('applies a new set to mission state', () => {
    const next = applyDeltaToState(baseState(), delta(['success', 'exhaustion', 'invalidation']));
    expect(next.stop_conditions).toEqual(['success', 'exhaustion', 'invalidation']);
  });

  it('accepts the wrapped object form', () => {
    const next = applyDeltaToState(baseState(), delta({ stop_conditions: ['saturation'] }));
    expect(next.stop_conditions).toEqual(['saturation']);
  });

  it('drops blank entries instead of storing them', () => {
    const next = applyDeltaToState(baseState(), delta(['success', '  ', 'abort']));
    expect(next.stop_conditions).toEqual(['success', 'abort']);
  });

  it('leaves the replaced set visible in the state a caller reads', () => {
    const next = applyDeltaToState(baseState(), delta(['success', 'exhaustion']));
    expect(next.stop_conditions).toEqual(['success', 'exhaustion']);
    // The point of the custody argument: a reader of current state must be able
    // to see that the mission was once governed by something else.
    expect(next.stop_conditions_history).toHaveLength(1);
    expect(next.stop_conditions_history?.[0].from).toEqual(['owner intervention']);
    expect(next.stop_conditions_history?.[0].delta_id).toBe('d1');
  });

  it('appends to the history rather than overwriting it on a second replan', () => {
    const once = applyDeltaToState(baseState(), delta(['success']));
    const twice = applyDeltaToState(once, delta(['success', 'abort']));
    expect(twice.stop_conditions_history).toHaveLength(2);
    expect(twice.stop_conditions_history?.[0].from).toEqual(['owner intervention']);
    expect(twice.stop_conditions_history?.[1].from).toEqual(['success']);
  });

  it('does not record history when there was no prior set to replace', () => {
    const empty = { ...baseState(), stop_conditions: [] } as MissionState;
    const next = applyDeltaToState(empty, delta(['success']));
    expect(next.stop_conditions).toEqual(['success']);
    expect(next.stop_conditions_history).toBeUndefined();
  });

  it('passes fail-closed validation for a valid delta', () => {
    expect(() => assertTargetsResolve(baseState(), {
      delta_type: 'STOP_CONDITIONS_CHANGED',
      operations: [{ op: 'replace', path: '/stop_conditions', value: ['success'] }],
      ledger_entries: [],
    } as never)).not.toThrow();
  });

  it('refuses the wrong path', () => {
    expect(() => assertTargetsResolve(baseState(), {
      delta_type: 'STOP_CONDITIONS_CHANGED',
      operations: [{ op: 'replace', path: '/objectives/o1/status', value: ['success'] }],
      ledger_entries: [],
    } as never)).toThrow(/requires path \/stop_conditions/);
  });

  it('refuses an empty array, which would leave the mission governed by nothing', () => {
    expect(() => assertTargetsResolve(baseState(), {
      delta_type: 'STOP_CONDITIONS_CHANGED',
      operations: [{ op: 'replace', path: '/stop_conditions', value: [] }],
      ledger_entries: [],
    } as never)).toThrow(/non-empty array/);
  });

  it('refuses non-string entries', () => {
    expect(() => assertTargetsResolve(baseState(), {
      delta_type: 'STOP_CONDITIONS_CHANGED',
      operations: [{ op: 'replace', path: '/stop_conditions', value: ['ok', 42] }],
      ledger_entries: [],
    } as never)).toThrow(/non-empty strings/);
  });
});

describe('human_gate vocabulary (defect 2)', () => {
  it('maps the legacy surface values onto the schema set', () => {
    expect(normaliseHumanGate('approval')).toBe('required_before_merge');
    expect(normaliseHumanGate('review')).toBe('required_before_effect');
    expect(normaliseHumanGate('none')).toBe('none');
  });

  it('passes canonical values through unchanged', () => {
    expect(normaliseHumanGate('required_before_merge')).toBe('required_before_merge');
    expect(normaliseHumanGate('required_before_effect')).toBe('required_before_effect');
  });

  it('tolerates case and whitespace', () => {
    expect(normaliseHumanGate('  APPROVAL ')).toBe('required_before_merge');
  });

  it('treats absence as absence', () => {
    expect(normaliseHumanGate(undefined)).toBeUndefined();
    expect(normaliseHumanGate(null)).toBeUndefined();
    expect(normaliseHumanGate('')).toBeUndefined();
  });

  it('refuses an unknown gate by name rather than storing it', () => {
    expect(() => normaliseHumanGate('maybe')).toThrow(/unknown human_gate/);
  });
});

// ---------------------------------------------------------------------------
// Defect 3 (2026-10-23): success criteria were frozen at intake, exactly as
// stop_conditions were before defect 1. The owner asked to re-baseline a
// mission's targets and to add criteria, and the applier could not represent
// it: the guard refused an unknown id and the branch did nothing without one.
// Found while re-freezing a benchmark that had gone stale.
// ---------------------------------------------------------------------------
const criterionDelta = (criterionId: string, value: unknown): StateDelta => ({
  schema_version: '1.0',
  delta_id: 'd2',
  idempotency_key: 'idem-87654321',
  mission_id: 'ms_test',
  base_mission_version: 1,
  author_id: 'tester',
  delta_type: 'SUCCESS_CRITERION_UPDATED',
  operations: [{ op: 'add', path: `/success_criteria/${criterionId}`, value }],
  rationale: 'a target that cannot be added cannot be re-baselined',
  confidence: 0.9,
  created_at: '2026-10-23T00:00:00.000Z',
} as unknown as StateDelta);

describe('SUCCESS_CRITERION_UPDATED — adding after intake (defect 3)', () => {
  it('adds a criterion carried in full, with status defaulting to unmet', () => {
    const next = applyDeltaToState(
      { ...baseState(), success_criteria: [] } as MissionState,
      criterionDelta('sc13', { description: 'AGMT cost per 1k retrievals <= 50% of Katra' }),
    );
    expect(next.success_criteria).toHaveLength(1);
    expect(next.success_criteria?.[0]).toMatchObject({
      id: 'sc13',
      description: 'AGMT cost per 1k retrievals <= 50% of Katra',
      status: 'unmet',
    });
  });

  it('keeps an explicit status when one is supplied', () => {
    const next = applyDeltaToState(
      { ...baseState(), success_criteria: [] } as MissionState,
      criterionDelta('sc14', { description: 'restore verified', status: 'partial' }),
    );
    expect(next.success_criteria?.[0].status).toBe('partial');
  });

  it('does not duplicate an id that already exists, and updates it instead', () => {
    const existing = { ...baseState(), success_criteria: [{ id: 'sc1', description: 'old', status: 'unmet' }] } as MissionState;
    const next = applyDeltaToState(existing, criterionDelta('sc1', { status: 'met' }));
    expect(next.success_criteria).toHaveLength(1);
    expect(next.success_criteria?.[0].status).toBe('met');
    expect(next.success_criteria?.[0].description).toBe('old');
  });

  it('refuses an unknown id with no criterion to add', () => {
    expect(() => assertTargetsResolve(
      { ...baseState(), success_criteria: [] } as MissionState,
      criterionDelta('sc99', 'met') as never,
    )).toThrow(/carries no complete criterion to add/);
  });

  it('refuses an addition whose description is blank', () => {
    expect(() => assertTargetsResolve(
      { ...baseState(), success_criteria: [] } as MissionState,
      criterionDelta('sc99', { description: '   ' }) as never,
    )).toThrow(/carries no complete criterion to add/);
  });

  it('still refuses a valueless update to an existing criterion', () => {
    const existing = { ...baseState(), success_criteria: [{ id: 'sc1', description: 'x', status: 'unmet' }] } as MissionState;
    expect(() => assertTargetsResolve(existing, criterionDelta('sc1', {}) as never))
      .toThrow(/a valueless update changes no state/);
  });
});
