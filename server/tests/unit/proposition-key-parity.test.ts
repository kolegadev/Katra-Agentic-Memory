import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('compaction writes the runtime key, not a SHA-256 of it', () => {
    const semantic = readFileSync(
      new URL('../../../scripts/python/compact-semantic.mjs', import.meta.url),
      'utf8',
    );
    const episodic = readFileSync(
      new URL('../../../scripts/python/compact-episodic.mjs', import.meta.url),
      'utf8',
    );

    expect(semantic).toContain("from './proposition-key.mjs'");
    expect(semantic).toContain('semanticPropositionKey');
    expect(semantic).toContain('proposition_key: g.key');
    expect(semantic).toContain('proposition_norm: g.key');
    expect(semantic).not.toMatch(/proposition_key:\s*createHash/);
    expect(semantic).toContain('shared_id: 1');
    expect(semantic).toContain('${sharedId}');
    expect(semantic).toContain('semantic_proposition_scoped');
    expect(semantic).toContain('semantic_proposition_norm_scoped');
    expect(semantic).toContain('unique: true');
    expect(semantic).toContain('partialFilterExpression');

    expect(episodic).toContain("from './proposition-key.mjs'");
    expect(episodic).toContain('episodicPropositionKey');
    expect(episodic).toContain('proposition_key: survivor.key');
    expect(episodic).toContain('shared_id: 1');
    expect(episodic).toContain("${d.shared_id || ''}");
    expect(episodic).toContain('proposition_lookup');
    expect(episodic).toContain('unique: true');
    expect(episodic).toContain('partialFilterExpression');
  });
});
