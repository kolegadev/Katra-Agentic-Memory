/**
 * Unit tests: executive allocation set (F3 — three identities everywhere)
 *
 * Asserts the allocation candidate set is exactly ['satori','shoshin','zanshin']
 * (gas-law-watcher stays out — tool actor), that the exported constant feeds
 * allocateTask(), that allocation results never leave the candidate set, and
 * that the fallback cursor wraps around the three ids.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  edges: [] as Array<Record<string, unknown>>,
  counts: {} as Record<string, number>,
}));

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
      // semantic_facts (isConcernResolved) and anything else: no data.
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

import {
  ALLOCATION_CANDIDATES,
  AutonomousExecutive,
} from '../../src/services/processing/autonomous-executive.js';

describe('AutonomousExecutive — allocation candidates (F3)', () => {
  beforeEach(() => {
    state.edges = [];
    state.counts = {};
  });

  it('the allocation set equals exactly the three identities', () => {
    expect([...ALLOCATION_CANDIDATES]).toEqual(['satori', 'shoshin', 'zanshin']);
  });

  it('keeps gas-law-watcher and the legacy ids out of allocation', () => {
    expect(ALLOCATION_CANDIDATES).not.toContain('gas-law-watcher');
    expect(ALLOCATION_CANDIDATES).not.toContain('kolega-agent');
    expect(ALLOCATION_CANDIDATES).not.toContain('opencode-agent');
  });

  it('allocates to the strongest candidate among the three ids', async () => {
    // Reflection edge: zanshin feels excited about the entity (3.6 points).
    state.edges = [
      {
        source_entity: 'zanshin workspace',
        target_entity: 'memory',
        edge_type: 'excited',
        intensity: 2,
      },
    ];
    // Event history: shoshin mentions the entity most (2 mentions → 1.0).
    state.counts = { satori: 0, shoshin: 2, zanshin: 0 };

    const executive = AutonomousExecutive.get_instance();
    const allocation = await (executive as any).allocateTask('memory');

    expect(allocation.agent).toBe('zanshin');
    expect(allocation.confidence).toBeGreaterThan(0.5);
    expect(allocation.rationale).toContain('zanshin');
    expect(allocation.rationale).toContain('shoshin');
  });

  it('never allocates to gas-law-watcher even with watcher activity', async () => {
    state.edges = [
      { source_entity: 'gas-law-watcher scan', target_entity: 'memory', edge_type: 'anxious', intensity: 5 },
    ];
    state.counts = { satori: 0, shoshin: 0, zanshin: 0, 'gas-law-watcher': 50 };

    const executive = AutonomousExecutive.get_instance();
    const allocation = await (executive as any).allocateTask('memory');

    expect(ALLOCATION_CANDIDATES).toContain(allocation.agent);
    expect(allocation.agent).not.toBe('gas-law-watcher');
  });

  it('the fallback cursor wraps around the three ids', () => {
    const executive = AutonomousExecutive.get_instance();
    const next = (agent: string) => (executive as any).nextAllocationCandidate(agent);
    expect(next('satori')).toBe('shoshin');
    expect(next('shoshin')).toBe('zanshin');
    expect(next('zanshin')).toBe('satori');
    // Unknown ids fall back to the first candidate, never a legacy id.
    expect(next('gas-law-watcher')).toBe('satori');
    expect(next('kolega-agent')).toBe('satori');
  });
});
