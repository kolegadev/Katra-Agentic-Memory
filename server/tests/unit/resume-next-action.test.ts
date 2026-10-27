/**
 * Unit tests — resume next-action must reflect the success criteria.
 *
 * Regression cover: the 'complete' branch emitted the same line, "verify success
 * criteria before closing the mission", whether every criterion was met or none
 * had been examined. On the live research mission (all four criteria `met`) the
 * report still told the reader to go and verify them, which is misleading in
 * exactly the case a reader wants clarity: a finished mission.
 *
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect } from 'vitest';
import { computeNextAction } from '../../src/services/mission-cognition/resume.js';
import type { MissionState } from '../../src/types/cognitive-control.js';

function state(overrides: Partial<MissionState> = {}): MissionState {
  return {
    schema_version: '1.0',
    mission_id: 'm1',
    version: 1,
    title: 't',
    intent: 'i',
    status: 'active',
    owner_id: 'agent-a',
    success_criteria: [],
    authority_class: 'B',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const done = (id: string, status: string) => ({ id, description: `criterion ${id}`, status: status as never });
const obj = (id: string, status: string) => ({ id, description: `objective ${id}`, status: status as never, owner_id: 'agent-a' });

describe('resume next-action reflects success criteria', () => {
  it('says READY TO CLOSE when all objectives and all criteria are satisfied', () => {
    const na = computeNextAction(state({
      objectives: [obj('o1', 'completed'), obj('o2', 'completed')],
      success_criteria: [done('c1', 'met'), done('c2', 'met')],
    }));
    expect(na.kind).toBe('complete');
    expect(na.rationale).toMatch(/ready to close/i);
    expect(na.rationale).not.toMatch(/verify them/i);
    expect(na.rationale).toContain('2 objective');
    expect(na.rationale).toContain('2 success criteria');
  });

  it('treats a WAIVED criterion as satisfied', () => {
    const na = computeNextAction(state({
      objectives: [obj('o1', 'completed')],
      success_criteria: [done('c1', 'met'), done('c2', 'waived')],
    }));
    expect(na.rationale).toMatch(/ready to close/i);
  });

  it('NAMES the open criteria when some are still unmet', () => {
    const na = computeNextAction(state({
      objectives: [obj('o1', 'completed')],
      success_criteria: [done('c1', 'met'), done('c2', 'unmet'), done('c3', 'partial')],
    }));
    expect(na.kind).toBe('complete');
    expect(na.rationale).toMatch(/2 of 3 success criteria still open/);
    expect(na.rationale).toContain('c2');
    expect(na.rationale).toContain('c3');
    expect(na.rationale).not.toContain('c1,'); // c1 is met, not listed
  });

  it('states plainly when no criteria are declared, rather than asking for verification', () => {
    const na = computeNextAction(state({ objectives: [obj('o1', 'completed')], success_criteria: [] }));
    expect(na.rationale).toMatch(/no success criteria are declared/i);
    expect(na.rationale).not.toMatch(/verify them/i);
  });

  it('still prioritises outstanding work over criteria', () => {
    const actionable = computeNextAction(state({
      objectives: [obj('o1', 'pending')],
      success_criteria: [done('c1', 'met')],
    }));
    expect(actionable.kind).toBe('objective');
    expect(actionable.objective_id).toBe('o1');

    const blocked = computeNextAction(state({
      objectives: [obj('o1', 'blocked')],
      success_criteria: [done('c1', 'met')],
    }));
    expect(blocked.kind).toBe('blocked');
  });
});
