import { describe, it, expect } from 'vitest';
import { capExtractionFanOut, DEFAULT_FANOUT_CAPS } from '../../src/services/processing/extraction-fanout.js';

const facts = (n: number) => Array.from({ length: n }, (_, i) => ({ fact_key: 'fact', fact_value: `v${i}` }));
const events = (n: number) => Array.from({ length: n }, (_, i) => ({ event_type: 'goal', description: `e${i}` }));

describe('extraction fan-out caps', () => {
  it('leaves an extraction under the caps untouched', () => {
    const input = { semantic_facts: facts(3), events: events(2) };
    const out = capExtractionFanOut(input);
    expect(out.capped).toBe(false);
    expect(out.factsDropped).toBe(0);
    expect(out.eventsDropped).toBe(0);
    expect(out.result).toBe(input);
  });

  it('truncates an over-cap extraction and reports what it dropped', () => {
    const out = capExtractionFanOut({ semantic_facts: facts(136), events: events(40) });
    expect(out.capped).toBe(true);
    expect(out.result.semantic_facts).toHaveLength(DEFAULT_FANOUT_CAPS.maxFacts);
    expect(out.result.events).toHaveLength(DEFAULT_FANOUT_CAPS.maxEvents);
    expect(out.factsDropped).toBe(136 - DEFAULT_FANOUT_CAPS.maxFacts);
    expect(out.eventsDropped).toBe(40 - DEFAULT_FANOUT_CAPS.maxEvents);
  });

  it('keeps the first N in order, so the drop is deterministic', () => {
    const out = capExtractionFanOut({ semantic_facts: facts(30) });
    expect((out.result.semantic_facts as any[])[0].fact_value).toBe('v0');
    expect((out.result.semantic_facts as any[])[24].fact_value).toBe('v24');
  });

  it('tolerates a result with no arrays at all', () => {
    const out = capExtractionFanOut({} as { semantic_facts?: unknown[]; events?: unknown[] });
    expect(out.capped).toBe(false);
    expect(out.result).toEqual({});
  });

  it('honours custom caps', () => {
    const out = capExtractionFanOut(
      { semantic_facts: facts(5), events: events(5) },
      { maxFacts: 2, maxEvents: 3 },
    );
    expect(out.result.semantic_facts).toHaveLength(2);
    expect(out.result.events).toHaveLength(3);
    expect(out.factsDropped).toBe(3);
    expect(out.eventsDropped).toBe(2);
  });

  it('does not mutate the input arrays', () => {
    const input = { semantic_facts: facts(30), events: events(20) };
    capExtractionFanOut(input);
    expect(input.semantic_facts).toHaveLength(30);
    expect(input.events).toHaveLength(20);
  });
});
