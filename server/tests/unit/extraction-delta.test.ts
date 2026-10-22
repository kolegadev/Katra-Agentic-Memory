import { describe, it, expect } from 'vitest';
import {
  planExtractionDelta,
  nextCursor,
  prefixHash,
} from '../../src/services/processing/extraction-delta.js';

const transcript = (n: number) =>
  Array.from({ length: n }, (_, i) => `Message ${i}: the agent is doing work number ${i}.`).join('\n');

describe('extraction deltas — the session cursor', () => {
  it('extracts everything when the session has no cursor', () => {
    const text = transcript(3);
    const plan = planExtractionDelta(text, null);
    expect(plan.mode).toBe('full');
    expect(plan.text).toBe(text);
  });

  it('extracts only the suffix when the transcript grew', () => {
    const first = transcript(3);
    const grown = transcript(6);
    const cursor = nextCursor(first);
    const plan = planExtractionDelta(grown, cursor);
    expect(plan.mode).toBe('delta');
    expect(grown.startsWith(plan.text) === false).toBe(true);
    expect(grown.endsWith(plan.text)).toBe(true);
    // The suffix is exactly the new messages, not a re-detailing of the old ones.
    expect(plan.text.includes('Message 3')).toBe(true);
    expect(plan.text.includes('Message 0')).toBe(false);
  });

  it('skips a transcript that has not changed', () => {
    const text = transcript(4);
    const plan = planExtractionDelta(text, nextCursor(text));
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toBe('already_extracted');
  });

  it('re-extracts when the text shrank, rather than guessing it was covered', () => {
    // A shorter text cannot be verified as a prefix of what was consumed
    // without storing the text itself, so the safe answer is a full pass: it
    // costs one extraction and can never lose a fact.
    const big = transcript(8);
    const small = transcript(2);
    const plan = planExtractionDelta(small, nextCursor(big));
    expect(plan.mode).toBe('full');
    expect(plan.reason).toBe('prefix_changed');
  });

  it('re-extracts in full when the opening text changed', () => {
    const a = 'Alpha report. ' + transcript(3);
    const b = 'Beta report. ' + transcript(3);
    const plan = planExtractionDelta(b, nextCursor(a));
    expect(plan.mode).toBe('full');
    expect(plan.reason).toBe('prefix_changed');
  });

  it('does not spend a call on a trivial append', () => {
    const text = transcript(3);
    const plan = planExtractionDelta(text + '\nok', nextCursor(text));
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toBe('delta_too_small');
  });

  it('treats empty content as nothing to do', () => {
    expect(planExtractionDelta('', null).mode).toBe('skip');
    expect(planExtractionDelta('   ', nextCursor('x')).mode).toBe('skip');
  });

  it('keys the prefix by content, not by length', () => {
    const a = 'A'.repeat(3000);
    const b = 'B'.repeat(3000);
    expect(prefixHash(a)).not.toBe(prefixHash(b));
    expect(prefixHash(a)).toBe(prefixHash(a + 'more'));
  });
});
