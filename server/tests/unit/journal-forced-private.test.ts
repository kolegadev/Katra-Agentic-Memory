/**
 * Unit tests: forced-private reflection/journal writes (F2)
 *
 * A journal / reflection / insight write path can NEVER carry a shared_id —
 * even when a shared_id is smuggled into the input object. The database is
 * mocked so we assert exactly what would be written.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  inserts: [] as Array<{ collection: string; doc: Record<string, unknown> }>,
  updates: [] as Array<{ collection: string; filter: Record<string, unknown>; update: Record<string, unknown> }>,
}));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: (name: string) => ({
      insertOne: async (doc: Record<string, unknown>) => {
        state.inserts.push({ collection: name, doc });
        return { acknowledged: true, insertedId: 'test-id' };
      },
      updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        state.updates.push({ collection: name, filter, update });
        return { acknowledged: true };
      },
      findOne: async () => null,
    }),
  }),
}));

import { ReflectionStore } from '../../src/services/infrastructure/reflection-store.js';

const store = ReflectionStore.get_instance();

describe('ReflectionStore — forced-private writes (F2)', () => {
  beforeEach(() => {
    state.inserts = [];
    state.updates = [];
  });

  it('upsertJournal never writes shared_id, even when the journal carries one', async () => {
    await store.upsertJournal({
      user_id: 'shoshin',
      period_type: 'daily',
      period_start: new Date('2026-08-21T00:00:00Z'),
      period_end: new Date('2026-08-21T23:59:59Z'),
      narrative: 'private reflection',
      unresolved_threads: [],
      source_events: [],
      source_sessions: [],
      // A caller smuggling a shared scope into the journal must be ignored.
      shared_id: 'my-team',
    } as any);

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].collection).toBe('reflective_journals');
    expect(state.inserts[0].doc.user_id).toBe('shoshin');
    expect(state.inserts[0].doc).not.toHaveProperty('shared_id');
    expect(state.inserts[0].doc.narrative).toBe('private reflection');
  });

  it('upsertInsight never writes shared_id on insert', async () => {
    await store.upsertInsight({
      user_id: 'shoshin',
      insight_text: 'private realization',
      domain: 'self',
      confidence: 0.7,
      evidence_count: 0,
      first_observed: new Date(),
      last_reinforced: new Date(),
      source_journal_ids: [],
      status: 'emerging',
      created_at: new Date(),
      shared_id: 'my-team',
    } as any);

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].collection).toBe('philosophical_insights');
    expect(state.inserts[0].doc).not.toHaveProperty('shared_id');
    expect(state.inserts[0].doc.insight_text).toBe('private realization');
  });

  it('upsertReflectionNode unsets shared_id on the reflection_nodes doc', async () => {
    await store.upsertReflectionNode({
      user_id: 'shoshin',
      entity_name: 'katra',
      entity_type: 'project',
      emotional_signature: { primary_emotion: 'curious', intensity: 0.5 },
      reflection_context: 'reflection',
      first_observed: new Date(),
      last_updated: new Date(),
      observation_count: 0,
      created_at: new Date(),
      shared_id: 'my-team',
    } as any);

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].collection).toBe('reflection_nodes');
    expect(state.updates[0].update).toMatchObject({ $unset: { shared_id: '' } });
  });

  it('upsertReflectionEdge unsets shared_id on the reflection_edges doc', async () => {
    await store.upsertReflectionEdge({
      user_id: 'shoshin',
      source_entity: 'a',
      target_entity: 'b',
      edge_type: 'emotional',
      intensity: 0.5,
      valence: 0.2,
      narrative: 'narrative',
      first_observed: new Date(),
      last_updated: new Date(),
      source_journal_id: 'jid',
      created_at: new Date(),
      shared_id: 'my-team',
    } as any);

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].collection).toBe('reflection_edges');
    expect(state.updates[0].update).toMatchObject({ $unset: { shared_id: '' } });
  });
});
