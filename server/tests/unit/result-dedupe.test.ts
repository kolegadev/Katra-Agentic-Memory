import { describe, it, expect } from 'vitest';
import {
  collapseNearDuplicates,
  nearDuplicateKey,
  contentPrefixKey,
} from '../../src/services/memory/result-dedupe.js';

describe('result dedupe (Stage 4 retrieval hygiene)', () => {
  it('collapses rows that share a proposition key, keeping the first', () => {
    const rows = [
      { id: 'best', proposition_norm: 'ka:abc', content: 'first wording' },
      { id: 'dup', proposition_norm: 'ka:abc', content: 'second wording' },
      { id: 'other', proposition_norm: 'ka:def', content: 'different' },
    ];
    const out = collapseNearDuplicates(rows, 10);
    expect(out.map((r) => r.id)).toEqual(['best', 'other']);
  });

  it('collapses paraphrases by normalised content when there is no proposition key', () => {
    const rows = [
      { content: 'The mesh is candidate generation only.' },
      { content: 'the mesh is CANDIDATE generation only' },
      { content: 'Something else entirely about the mesh' },
    ];
    const out = collapseNearDuplicates(rows, 10);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain('candidate generation only');
  });

  it('keeps distinct propositions apart', () => {
    const rows = [
      { content: 'Upgrade kolega-code from 0.42.0 to 0.45.0 on thebrick' },
      { content: 'Uninstall kolega-code from 0.42.0 to 0.45.0 on thebrick' },
    ];
    expect(collapseNearDuplicates(rows, 10)).toHaveLength(2);
  });

  it('stops at the limit after collapsing, so a page can still fill', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ content: `distinct fact number ${i}` }));
    expect(collapseNearDuplicates(rows, 5)).toHaveLength(5);
  });

  it('backfills past a collapsed run to fill the page', () => {
    const rows = [
      { content: 'same sentence here' },
      { content: 'same sentence here' },
      { content: 'same sentence here' },
      { content: 'a different sentence here' },
    ];
    const out = collapseNearDuplicates(rows, 2);
    expect(out).toHaveLength(2);
    expect(out[1].content).toBe('a different sentence here');
  });

  it('treats the proposition key as stronger than the content', () => {
    expect(nearDuplicateKey({ proposition_norm: 'p1', content: 'x' })).toBe('p:p1');
    expect(nearDuplicateKey({ content: 'X' })).toBe('c:x');
  });

  it('normalises punctuation and whitespace in the content key', () => {
    expect(contentPrefixKey('Hello,   world!')).toBe('hello world');
  });

  it('collapses rows with no content rather than flooding the page', () => {
    const rows = [{}, {}, { content: 'real content' }];
    expect(collapseNearDuplicates(rows, 10)).toHaveLength(2);
  });
});
