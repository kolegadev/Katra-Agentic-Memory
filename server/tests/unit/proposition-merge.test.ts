import { describe, it, expect } from 'vitest';
import {
  episodicPropositionFilter,
  buildEpisodicMergeUpdate,
  semanticPropositionFilter,
  buildSemanticMergeUpdate,
} from '../../src/services/memory/proposition-merge.js';

const prior = {
  _id: 'p1',
  id: 'e1',
  user_id: 'u1',
  shared_id: 'team-a',
  session_id: 's1',
  event_type: 'goal',
  content: { description: 'Get the reflection root cause from Satori' },
  occurrences: 2,
  variants: [],
  metadata: { processed: true },
};
const proposition = {
  key: 'k1',
  normalized: 'get reflection root cause satori',
  tokens: 4,
  strategy: 'first' as const,
};

describe('episodic proposition merge', () => {
  it('scopes the merge by shared_id', () => {
    expect(episodicPropositionFilter(prior, 'k1')).toMatchObject({
      user_id: 'u1',
      event_type: 'goal',
      proposition_key: 'k1',
      shared_id: 'team-a',
    });
    expect(episodicPropositionFilter({ ...prior, shared_id: undefined }, 'k1').shared_id).toBeNull();
  });

  it('keeps session/shared/time and caps variants at five', () => {
    const variants = Array.from({ length: 5 }, (_, i) => ({
      text: `old wording ${i}`,
      seen_at: new Date('2026-10-20T00:00:00Z'),
    }));
    const event = {
      user_id: 'u1',
      event_type: 'goal',
      session_id: 's2',
      shared_id: 'team-a',
      content: { description: 'Get the reflection root cause from Satori again' },
      timestamp: new Date('2026-10-27T14:00:00Z'),
    };
    const { update, merged } = buildEpisodicMergeUpdate(
      { ...prior, variants },
      event,
      proposition,
      'hash2',
      'idem2',
      new Date('2026-10-27T14:01:00Z'),
    );

    const set = update[0].$set;
    expect(set.last_seen_at).toEqual(event.timestamp);
    expect(set.session_id).toEqual({ $ifNull: ['s2', '$session_id'] });
    expect(set.shared_id).toEqual({ $ifNull: ['$shared_id', 'team-a'] });

    const variantSet = update[1].$set.variants;
    expect(variantSet.$slice[1]).toBe(-5);
    expect(variantSet.$slice[0].$concatArrays[1][0]).toMatchObject({
      text: 'Get the reflection root cause from Satori again',
      session_id: 's2',
      shared_id: 'team-a',
      seen_at: event.timestamp,
    });

    expect(merged.session_id).toBe('s2');
    expect(merged.shared_id).toBe('team-a');
    expect(merged.occurrences).toBe(3);
  });

  it('refreshes hash/idempotency/processed on the latest strategy', () => {
    const event = {
      user_id: 'u1',
      event_type: 'gas_law_train_decision',
      session_id: 's2',
      shared_id: 'team-a',
      content: { cell_id: 1, action: 'flip', rationale: 'new evidence' },
      timestamp: new Date('2026-10-27T14:00:00Z'),
    };
    const latest = { ...proposition, strategy: 'latest' as const };
    const { update, merged } = buildEpisodicMergeUpdate(
      prior,
      event,
      latest,
      'hash-new',
      'idem-new',
      new Date('2026-10-27T14:01:00Z'),
    );

    expect(update[1].$set).toMatchObject({
      content_hash: 'hash-new',
      idempotency_key: 'idem-new',
      'metadata.processed': false,
    });
    expect(merged.content).toEqual(event.content);
    expect(merged.content_hash).toBe('hash-new');
    expect(merged.metadata.processed).toBe(false);
  });
});

describe('semantic proposition merge', () => {
  it('scopes the merge by shared_id', () => {
    expect(semanticPropositionFilter({ shared_id: 'team-a' }, 'u1', 'k1')).toMatchObject({
      user_id: 'u1',
      proposition_key: 'k1',
      shared_id: 'team-a',
    });
    expect(semanticPropositionFilter({}, 'u1', 'k1').shared_id).toBeNull();
  });

  it('preserves confidence, source, tags and metadata', () => {
    const update = buildSemanticMergeUpdate({
      content: 'a new wording of the fact',
      source: 'extraction',
      confidence: 0.9,
      tags: ['a'],
      metadata: { extraction_context: { source_event_id: 'e9' } },
    });
    const set = update[0].$set;
    expect(set.tags.$setUnion[1]).toEqual(['a']);
    expect(set.metadata.$mergeObjects[1]).toEqual({
      extraction_context: { source_event_id: 'e9' },
    });
    expect(set.confidence.$cond).toBeDefined();
    expect(set.source.$cond).toBeDefined();
    expect(set.variants.$setUnion[1]).toEqual(['a new wording of the fact']);
  });
});
