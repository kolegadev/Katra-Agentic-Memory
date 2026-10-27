import { describe, it, expect } from 'vitest';
import {
  PROPOSITION_STOPWORDS,
  normalizeProposition,
  propositionKeyOf,
} from '../../src/services/memory/proposition-key.js';

describe('proposition key parity — runtime and compaction scripts', () => {
  it('uses the same stopwords, normal form and semantic key', async () => {
    // @ts-ignore - the .mjs module has no TypeScript declaration
    const scriptKey: any = await import('../../../scripts/python/proposition-key.mjs');
    expect([...scriptKey.STOPWORDS].sort()).toEqual([...PROPOSITION_STOPWORDS].sort());

    const samples = [
      'Get from Satori the root cause!',
      'The check did not fail on thebrick server',
      'Version 1 shipped on thebrick server',
      'Upgrade kolega-code from 0.42.0 to 0.45.0 on thebrick',
    ];
    for (const s of samples) {
      expect(scriptKey.normalizeProposition(s)).toBe(normalizeProposition(s));
      expect(scriptKey.semanticPropositionKey(s)).toBe(propositionKeyOf(s));
    }
  });
});
