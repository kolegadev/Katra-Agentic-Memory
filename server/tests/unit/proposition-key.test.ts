import { describe, it, expect } from 'vitest';
import {
  normalizeProposition,
  propositionOf,
  descriptionOf,
  isMergeableEventType,
} from '../../src/services/memory/proposition-key.js';

describe('proposition keys — delta capture for distilled events', () => {
  it('ignores word order, case and punctuation', () => {
    expect(normalizeProposition('Get from Satori the root cause!'))
      .toBe(normalizeProposition('ROOT cause: get the Satori from'));
  });

  it('keeps different propositions apart', () => {
    const a = propositionOf('goal', { description: 'Get the reflection root cause from Satori' });
    const b = propositionOf('goal', { description: 'Delete the reflection root cause from Satori' });
    expect(a && a.key).not.toBe(b && b.key);
  });

  it('keys the same proposition identically regardless of volatile fields', () => {
    const a = propositionOf('goal', {
      description: 'Get the reflection root cause from Satori',
      extracted_at: '2026-10-21T20:00:00Z',
    });
    const b = propositionOf('goal', {
      description: 'Get the reflection root cause from Satori',
      extracted_at: '2026-10-21T21:30:00Z',
      confidence: 0.4,
    });
    expect(a?.key).toBe(b?.key);
  });

  it('never collapses raw observation types', () => {
    expect(propositionOf('conversation', 'the same message again')).toBeNull();
    expect(propositionOf('machine_health', { description: 'thebrick ok noswap' })).toBeNull();
    expect(isMergeableEventType('conversation')).toBe(false);
    expect(isMergeableEventType('goal')).toBe(true);
  });

  it('refuses to merge descriptions too short or too generic to identify a proposition', () => {
    expect(propositionOf('goal', { description: 'done' })).toBeNull();
    expect(propositionOf('goal', { description: 'retry later' })).toBeNull();
  });

  it('keys a structured decision by subject and action, keeping the latest', () => {
    const a = propositionOf('gas_law_train_decision', {
      cell_id: 701, cell_name: 'R7×G0×OFI1', action: 'flip',
      rationale: 'CONFIRMED_LOSER n=270 CI [37.20,48.93]', confidence: 0.6,
    });
    const b = propositionOf('gas_law_train_decision', {
      cell_id: 701, cell_name: 'R7×G0×OFI1', action: 'flip',
      rationale: 'CONFIRMED_LOSER n=267 CI [36.55,48.32]', confidence: 0.6,
    });
    expect(a?.key).toBe(b?.key);                 // same decision, new evidence
    expect(a?.strategy).toBe('latest');

    const other = propositionOf('gas_law_train_decision', {
      cell_id: 701, cell_name: 'R7×G0×OFI1', action: 'hold',
    });
    expect(other?.key).not.toBe(a?.key);         // a different decision
  });

  it('reads the description out of object content', () => {
    expect(descriptionOf({ description: '  a proposition  ', confidence: 0.9 })).toBe('a proposition');
    expect(descriptionOf({ message: 'fallback text' })).toBe('fallback text');
    expect(descriptionOf({ confidence: 0.9 })).toBeNull();
  });
});
