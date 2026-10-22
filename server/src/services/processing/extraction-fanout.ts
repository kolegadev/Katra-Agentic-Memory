/**
 * Fan-out caps for a single extraction.
 *
 * Why (2026-10-22): one 7.5k-character inter-agent message was measured
 * producing 136 semantic facts, and a nested derivation loop produced 106
 * copies of one sentence in an hour. Nothing in the pipeline bounded how much
 * one event could add to the store, so a dense message (or a re-imported
 * transcript) inflated the store without any error being raised.
 *
 * The cap turns an unbounded fan-out into a logged truncation: the run still
 * succeeds, the store grows by a bounded amount, and the dropped count is
 * reported so the truncation is visible rather than silent.
 */
export interface FanOutCaps {
  maxFacts: number;
  maxEvents: number;
}

export const DEFAULT_FANOUT_CAPS: FanOutCaps = { maxFacts: 25, maxEvents: 10 };

export interface FanOutOutcome<T> {
  result: T;
  factsDropped: number;
  eventsDropped: number;
  capped: boolean;
}

export function capExtractionFanOut<
  T extends { semantic_facts?: unknown[]; events?: unknown[] },
>(extraction: T, caps: FanOutCaps = DEFAULT_FANOUT_CAPS): FanOutOutcome<T> {
  const facts = Array.isArray(extraction.semantic_facts) ? extraction.semantic_facts : [];
  const events = Array.isArray(extraction.events) ? extraction.events : [];

  const factsDropped = Math.max(0, facts.length - caps.maxFacts);
  const eventsDropped = Math.max(0, events.length - caps.maxEvents);

  if (factsDropped === 0 && eventsDropped === 0) {
    return { result: extraction, factsDropped: 0, eventsDropped: 0, capped: false };
  }

  return {
    result: {
      ...extraction,
      semantic_facts: facts.slice(0, caps.maxFacts),
      events: events.slice(0, caps.maxEvents),
    } as T,
    factsDropped,
    eventsDropped,
    capped: true,
  };
}
