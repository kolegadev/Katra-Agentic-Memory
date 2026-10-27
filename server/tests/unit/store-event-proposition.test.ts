/**
 * Write-path coverage for MemoryManager.store_event.
 *
 * dispatch-service stores extracted description events through store_event, not
 * through EpisodicEventManager.createEvent. Before the proposition repair those
 * rows never received a proposition_key and never merged. These tests exercise
 * the method itself (with a fake collection) so the call site is covered, not
 * just the pure builders.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prior: null as any,
  semanticPrior: null as any,
  conflictPrior: null as any,
  conflictSemantic: null as any,
  insertConflict: false,
  semanticUpsertConflict: false,
  finds: [] as any[],
  inserts: [] as any[],
  updates: [] as any[],
}));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        state.finds.push({ name, filter });
        return name === 'semantic_facts' ? state.semanticPrior : state.prior;
      },
      insertOne: async (document: any) => {
        state.inserts.push(document);
        if (state.insertConflict) {
          state.insertConflict = false;
          state.prior = state.conflictPrior;
          throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        }
        return { insertedId: { toString: () => 'mongo-inserted-1' } };
      },
      findOneAndUpdate: async () => {
        if (state.semanticUpsertConflict) {
          state.semanticUpsertConflict = false;
          state.semanticPrior = state.conflictSemantic;
          throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        }
        return { _id: 'mongo-inserted-1' };
      },
      updateOne: async (filter: any, update: any) => {
        state.updates.push({ filter, update });
        return { modifiedCount: 1 };
      },
    }),
  }),
}));

import { MemoryManager } from '../../src/services/memory/memory-manager.js';

const EVENT = {
  id: 'event-incoming',
  user_id: 'u1',
  shared_id: 'team-a',
  session_id: 's2',
  event_type: 'goal',
  timestamp: new Date('2026-10-27T14:00:00Z'),
  content: { description: 'Get the reflection root cause from Satori' },
  metadata: { source: 'extraction' },
} as any;

describe('MemoryManager.store_event — proposition write path', () => {
  const manager = MemoryManager.get_instance();

  beforeEach(() => {
    state.prior = null;
    state.semanticPrior = null;
    state.conflictPrior = null;
    state.conflictSemantic = null;
    state.insertConflict = false;
    state.semanticUpsertConflict = false;
    state.finds.length = 0;
    state.inserts.length = 0;
    state.updates.length = 0;
  });

  it('writes the proposition key and occurrence fields on first sight', async () => {
    await manager.store_event(EVENT);

    expect(state.finds).toHaveLength(1);
    expect(state.finds[0].filter).toMatchObject({
      user_id: 'u1',
      event_type: 'goal',
      shared_id: 'team-a',
    });
    expect(typeof state.finds[0].filter.proposition_key).toBe('string');

    expect(state.inserts).toHaveLength(1);
    const document = state.inserts[0];
    expect(document.proposition_key).toBe(state.finds[0].filter.proposition_key);
    expect(document.occurrences).toBe(1);
    expect(document.first_seen_at).toEqual(EVENT.timestamp);
    expect(document.last_seen_at).toEqual(EVENT.timestamp);
    expect(document.variants).toEqual([]);
    expect(document.metadata.processed).toBe(false);
  });

  it('merges a repeat into the prior row without inserting a clone', async () => {
    state.prior = {
      _id: 'prior-id',
      id: 'event-prior',
      user_id: 'u1',
      shared_id: 'team-a',
      session_id: 's1',
      event_type: 'goal',
      content: { description: 'Get the reflection root cause from Satori' },
      occurrences: 2,
      variants: [],
      metadata: { processed: true },
    };

    const result = await manager.store_event(EVENT);

    expect(result).toBe('event-prior');
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(1);

    const update = state.updates[0].update;
    expect(Array.isArray(update)).toBe(true);
    expect(update[0].$set.occurrences).toEqual({
      $add: [{ $ifNull: ['$occurrences', 1] }, 1],
    });
    expect(update[0].$set.session_id).toEqual({ $ifNull: ['s2', '$session_id'] });
    expect(update[0].$set.last_seen_at).toEqual(EVENT.timestamp);
  });

  it('merges when the unique proposition index rejects a concurrent insert', async () => {
    state.insertConflict = true;
    state.conflictPrior = {
      _id: 'race-id',
      id: 'event-race-winner',
      user_id: 'u1',
      shared_id: 'team-a',
      session_id: 's1',
      event_type: 'goal',
      content: { description: 'Get the reflection root cause from Satori' },
      occurrences: 0,
      variants: [],
      metadata: { processed: true },
    };

    const result = await manager.store_event(EVENT);

    expect(result).toBe('event-race-winner');
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].filter).toEqual({ _id: 'race-id' });
  });

  it('scopes a private event to the rows without a shared scope', async () => {
    await manager.store_event({ ...EVENT, shared_id: undefined });

    expect(state.finds[0].filter.shared_id).toBeNull();
  });

  it('never keys raw observation types', async () => {
    await manager.store_event({
      ...EVENT,
      event_type: 'conversation',
      content: { description: 'conversation transcript goes here again' },
    });

    expect(state.finds).toHaveLength(0);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].proposition_key).toBeUndefined();
    expect(state.inserts[0].occurrences).toBeUndefined();
  });

  it('refreshes hash/idempotency/processed for a latest-strategy decision', async () => {
    state.prior = {
      _id: 'prior-id',
      id: 'event-prior',
      user_id: 'u1',
      shared_id: 'team-a',
      session_id: 's1',
      event_type: 'gas_law_train_decision',
      content: { cell_id: 701, action: 'flip', rationale: 'old evidence' },
      occurrences: 1,
      variants: [],
      metadata: { processed: true },
    };

    await manager.store_event({
      ...EVENT,
      event_type: 'gas_law_train_decision',
      content: { cell_id: 701, action: 'flip', rationale: 'new evidence' },
    });

    expect(state.inserts).toHaveLength(0);
    const update = state.updates[0].update;
    expect(update[1].$set).toMatchObject({
      'metadata.processed': false,
    });
    expect(typeof update[1].$set.content_hash).toBe('string');
    expect(typeof update[1].$set.idempotency_key).toBe('string');
  });
});

describe('MemoryManager.add_semantic_fact — proposition merge', () => {
  const manager = MemoryManager.get_instance();

  beforeEach(() => {
    state.prior = null;
    state.semanticPrior = null;
    state.conflictPrior = null;
    state.conflictSemantic = null;
    state.insertConflict = false;
    state.semanticUpsertConflict = false;
    state.finds.length = 0;
    state.inserts.length = 0;
    state.updates.length = 0;
  });

  it('merges into the shared-scope row, preserves fields and records lineage', async () => {
    state.semanticPrior = {
      _id: 'fact-1',
      user_id: 'u1',
      shared_id: 'team-a',
      proposition_key: 'the reflection root cause resolved thebrick',
      content: 'The reflection root cause is resolved on thebrick.',
      confidence: 0.4,
      source: 'unknown',
      tags: ['old'],
      metadata: { first: true },
      extraction_count: 2,
    };

    const id = await manager.add_semantic_fact({
      user_id: 'u1',
      shared_id: 'team-a',
      content: 'The reflection root cause is resolved on thebrick again',
      source: 'extraction',
      confidence: 0.9,
      tags: ['new'],
      metadata: { extraction_context: { source_event_id: 'event-src' } },
      created_at: new Date('2026-10-27T14:00:00Z'),
    } as any);

    expect(id).toBe('fact-1');

    const find = state.finds.find(entry => entry.name === 'semantic_facts');
    expect(find.filter).toMatchObject({
      user_id: 'u1',
      shared_id: 'team-a',
    });
    expect(typeof find.filter.$or[0].proposition_key).toBe('string');
    expect(find.filter.$or[1].proposition_norm).toBe(find.filter.$or[0].proposition_key);

    const merge = state.updates.find(entry => entry.filter?._id === 'fact-1');
    expect(merge).toBeDefined();
    const set = merge.update[0].$set;
    expect(set.confidence.$cond).toBeDefined();
    expect(set.source.$cond).toBeDefined();
    expect(set.tags.$setUnion[1]).toEqual(['new']);
    expect(set.metadata.$mergeObjects[1]).toEqual({
      extraction_context: { source_event_id: 'event-src' },
    });
    expect(set.variants.$setUnion[1]).toEqual([
      'The reflection root cause is resolved on thebrick again',
    ]);

    const lineage = state.updates.find(entry => entry.filter?.id === 'event-src');
    expect(lineage.update.$addToSet['metadata.derived_facts']).toBe('fact-1');
  });

  it('retries into the proposition row when the unique index rejects the exact upsert', async () => {
    state.semanticUpsertConflict = true;
    state.conflictSemantic = {
      _id: 'fact-race',
      user_id: 'u1',
      shared_id: 'team-a',
      proposition_key: 'the reflection root cause resolved thebrick',
      content: 'The reflection root cause is resolved on thebrick.',
      confidence: 0.4,
      source: 'unknown',
      tags: [],
      metadata: {},
      extraction_count: 1,
    };

    const id = await manager.add_semantic_fact({
      user_id: 'u1',
      shared_id: 'team-a',
      content: 'The reflection root cause is resolved on thebrick',
      source: 'extraction',
      confidence: 0.9,
      metadata: {},
      created_at: new Date('2026-10-27T14:00:00Z'),
    } as any);

    expect(id).toBe('fact-race');
    const merge = state.updates.find(entry => entry.filter?._id === 'fact-race');
    expect(merge).toBeDefined();
    expect(merge.update[0].$set.confidence.$cond).toBeDefined();
  });
});
