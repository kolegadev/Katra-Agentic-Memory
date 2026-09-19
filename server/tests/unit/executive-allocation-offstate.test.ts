/**
 * Phase 6 criterion 16 — off-state equivalence, written BEFORE any allocator
 * change (the contract requires the test first; the pinned baseline below was
 * captured from the unmodified pre-Phase-6 allocator at 5292da3).
 *
 * Fixed input fixture -> the allocator's allocation decision, serialized with
 * JSON.stringify, must stay BYTE-IDENTICAL to the pre-Phase-6 baseline while
 * COGNITIVE_SCHEDULER_MODE is off (the pre-activation default). The Phase-6
 * influence hook is exercised in part 2 once it exists; with flags off it must
 * return the allocation unchanged, byte for byte.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  edges: [] as Array<Record<string, unknown>>,
  counts: {} as Record<string, number>,
}));

vi.hoisted(() => {
  process.env.KATRA_ALLOCATION_CANDIDATES = 'katra,agent-a,agent-b';
  // Pre-activation default: scheduler mode off.
  delete process.env.COGNITIVE_SCHEDULER_MODE;
  delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
});

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => ({
    collection: (name: string) => {
      if (name === 'reflection_edges') {
        return { find: () => ({ toArray: async () => state.edges }) };
      }
      if (name === 'episodic_events') {
        return {
          countDocuments: async (q: { user_id?: string }) =>
            state.counts[q?.user_id ?? ''] ?? 0,
        };
      }
      return {
        find: () => ({ toArray: async () => [] }),
        findOne: async () => null,
        countDocuments: async () => 0,
      };
    },
  }),
  is_database_connected: () => true,
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
}));

import { AutonomousExecutive } from '../../src/services/processing/autonomous-executive.js';

/**
 * Captured from the pre-Phase-6 allocator (branch feat/cognitive-control-local
 * @ 5292da3, file server/src/services/processing/autonomous-executive.ts
 * unmodified) for the fixed fixture below. This constant is the baseline the
 * contract's "byte-identical" refers to.
 */
const PRE_PHASE6_ALLOCATION_BASELINE =
  '{"agent":"agent-b","score":3.6,"confidence":0.78,"rationale":"agent-b has stronger emotional proximity to \'memory\' (3.60 vs agent-a 1.00)"}';

describe('Phase 6 criterion 16 — off-state allocator equivalence', () => {
  beforeEach(() => {
    state.edges = [
      { source_entity: 'agent-b workspace', target_entity: 'memory', edge_type: 'excited', intensity: 2 },
    ];
    state.counts = { katra: 0, 'agent-a': 2, 'agent-b': 0 };
  });

  it('allocateTask output is byte-identical to the pre-Phase-6 baseline with flags off', async () => {
    const executive = AutonomousExecutive.get_instance();
    const allocation = await (executive as any).allocateTask('memory');
    const actual = JSON.stringify(allocation);
    expect(actual).toBe(PRE_PHASE6_ALLOCATION_BASELINE);
  });
});
