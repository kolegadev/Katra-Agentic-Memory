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
