/**
 * Phase 6 criterion 16 — off-state equivalence, written BEFORE any allocator
 * change (the contract requires the test first; the pinned baseline below was
 * captured from the unmodified pre-Phase-6 allocator at 5292da3).
 *
 * Fixed input fixture -> the allocator's allocation decision, serialized with
 * JSON.stringify, must stay BYTE-IDENTICAL to the pre-Phase-6 baseline while
 * COGNITIVE_SCHEDULER_MODE is off (the pre-activation default). Part 2 covers
 * the Phase-6 influence hook: with flags off it returns the allocation
 * unchanged byte for byte, and a full gated override records the counterfactual.
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

vi.mock('../../src/database/connection.js', async () => {
  // Everything except reflection_edges/episodic_events goes to the in-memory
  // fake (activation ledger, opt-ins, scheduler decisions, counterfactuals…).
  const { FakeDb } = await import('../helpers/fake-mongo.js');
  const activationDb = new FakeDb();
  return {
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
        return activationDb.collection(name);
      },
    }),
    is_database_connected: () => true,
  };
});

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

async function seedGateAndCycle(): Promise<void> {
  // Evidence gate: 50 evidenced decisions + human-read acknowledgement, all
  // shaped exactly as the production code stores them. The mock factory owns
  // the FakeDb instance; route through the mocked get_database.
  const getDb = (await import('../../src/database/connection.js')).get_database;
  const mdb = getDb() as any;
  mdb.collection('mission_states').docs.push({ mission_id: 'm_ev', owner_id: 'katra' });
  for (let i = 0; i < 50; i++) {
    mdb.collection('scheduler_decisions').docs.push({
      schema_version: '1.0',
      decision_id: `ev${i}`,
      mission_id: 'm_ev',
      scheduler_mode: 'shadow',
      created_at: new Date().toISOString(),
      candidates: [{ work_item_id: 'w', agent_id: 'agent-a', priority: 1, suitability: 1, combined: 2, feature_contributions: [] }],
      exclusions: [],
      rationale: 'seed',
      existing_allocator_note: 'seed',
      recommended: { work_item_id: 'w', agent_id: 'agent-a' },
      recommended_was_acted_on: false,
      allocator_observation: { agent_id: 'agent-a', observed_at: new Date().toISOString(), source: 'manual' },
    });
  }
  mdb.collection('activation_ledger').docs.push({
    ledger_id: 'ack1',
    kind: 'evidence_acknowledged',
    actor_id: 'operator',
    created_at: new Date().toISOString(),
    reason: 'seed ack',
    detail: { decision_count: 50, observed_decisions: 50, agreement_rate: 1.0 },
  });
  mdb.collection('activation_ledger').docs.push({
    ledger_id: 'cyc1',
    kind: 'cycle_start',
    actor_id: 'operator',
    created_at: new Date().toISOString(),
    cycle_id: 'cycle-1',
    reason: 'seed cycle',
    detail: { hard_bound: 3 },
  });
}

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

  it('maybeInfluenceAllocation returns the allocation byte-identical with flags off', async () => {
    const executive = AutonomousExecutive.get_instance();
    const allocation = await (executive as any).allocateTask('memory');
    const influenced = await (executive as any).maybeInfluenceAllocation(allocation, 'memory');
    expect(JSON.stringify(influenced)).toBe(JSON.stringify(allocation));
    expect(JSON.stringify(influenced)).toBe(PRE_PHASE6_ALLOCATION_BASELINE);
  });

  it('no influence in recommend mode — advisories never touch allocation (criterion 4)', async () => {
    process.env.COGNITIVE_SCHEDULER_MODE = 'recommend';
    try {
      const executive = AutonomousExecutive.get_instance();
      const allocation = await (executive as any).allocateTask('memory');
      const influenced = await (executive as any).maybeInfluenceAllocation(allocation, 'memory');
      expect(JSON.stringify(influenced)).toBe(JSON.stringify(allocation));
    } finally {
      delete process.env.COGNITIVE_SCHEDULER_MODE;
    }
  });
});

describe('Phase 6 — gated override end-to-end (allocator + bridge + counterfactual)', () => {
  beforeEach(() => {
    state.edges = [
      { source_entity: 'agent-b workspace', target_entity: 'memory', edge_type: 'excited', intensity: 2 },
    ];
    state.counts = { katra: 0, 'agent-a': 2, 'agent-b': 0 };
  });

  it('applies the scheduler choice when every gate holds and records the counterfactual', async () => {
    await seedGateAndCycle();
    const getDb = (await import('../../src/database/connection.js')).get_database;
    const mdb = getDb() as any;
    mdb.collection('mission_states').docs.push({ mission_id: 'm_act', owner_id: 'katra' });
    mdb.collection('mission_opt_ins').docs.push({
      opt_in_id: 'oi1', mission_id: 'm_act', owner_id: 'katra', opted_in_by: 'operator',
      reason: 'test', created_at: new Date().toISOString(),
    });
    mdb.collection('scheduler_decisions').docs.push({
      schema_version: '1.0',
      decision_id: 'd_act',
      mission_id: 'm_act',
      scheduler_mode: 'recommend',
      created_at: new Date().toISOString(),
      candidates: [],
      exclusions: [],
      rationale: 'seed',
      existing_allocator_note: 'seed',
      recommended: { work_item_id: 'w_act', agent_id: 'agent-a' },
      recommended_was_acted_on: false,
    });

    process.env.COGNITIVE_SCHEDULER_MODE = 'allocate_internal';
    try {
      const executive = AutonomousExecutive.get_instance();
      const allocation = await (executive as any).allocateTask('memory');
      expect(allocation.agent).toBe('agent-b'); // the existing allocator's own choice

      const influenced = await (executive as any).maybeInfluenceAllocation(allocation, 'memory');
      expect(influenced.agent).toBe('agent-a'); // the scheduler's choice, taken
      expect(influenced.rationale).toContain('SCHEDULER OVERRIDE');

      const counterfactuals = mdb.collection('allocation_counterfactuals').docs;
      expect(counterfactuals.length).toBe(1);
      expect(counterfactuals[0].influenced).toBe(true);
      expect(counterfactuals[0].chosen_agent_id).toBe('agent-a');
      expect(counterfactuals[0].existing_allocator_agent_id).toBe('agent-b'); // what would have happened
      expect(counterfactuals[0].reason).toContain('emotional-proximity');
      // Ledger records the influence with who/when.
      expect(mdb.collection('activation_ledger').docs.some(
        (r: any) => r.kind === 'influence_applied' && r.detail.decision_id === 'd_act',
      )).toBe(true);
      // One decision influences at most one allocation.
      const second = await (executive as any).maybeInfluenceAllocation(allocation, 'memory');
      expect(JSON.stringify(second)).toBe(JSON.stringify(allocation));
    } finally {
      delete process.env.COGNITIVE_SCHEDULER_MODE;
    }
  });

  it('does NOT apply the override when the counterfactual cannot be recorded (§4.12 fail closed)', async () => {
    await seedGateAndCycle();
    const getDb = (await import('../../src/database/connection.js')).get_database;
    const mdb = getDb() as any;
    mdb.collection('mission_states').docs.push({ mission_id: 'm_act', owner_id: 'katra' });
    mdb.collection('mission_opt_ins').docs.push({
      opt_in_id: 'oi2', mission_id: 'm_act', owner_id: 'katra', opted_in_by: 'operator',
      reason: 'test', created_at: new Date().toISOString(),
    });
    mdb.collection('scheduler_decisions').docs.push({
      schema_version: '1.0',
      decision_id: 'd_act2',
      mission_id: 'm_act',
      scheduler_mode: 'recommend',
      created_at: new Date().toISOString(),
      candidates: [], exclusions: [], rationale: 'seed', existing_allocator_note: 'seed',
      recommended: { work_item_id: 'w_act', agent_id: 'agent-a' },
      recommended_was_acted_on: false,
    });
    // Force the counterfactual insert to fail: unique index on decision_id
    // already occupied by a different record.
    mdb.collection('allocation_counterfactuals').docs.push({
      counterfactual_id: 'cf_clash',
      decision_id: 'd_act2',
      cycle_id: 'cycle-1',
      mission_id: 'm_act',
      work_item_id: 'w_act',
      influenced: false,
      chosen_agent_id: 'agent-b',
      existing_allocator_agent_id: 'agent-b',
      recorded_at: new Date().toISOString(),
      reason: 'clash',
    });

    process.env.COGNITIVE_SCHEDULER_MODE = 'allocate_internal';
    try {
      const executive = AutonomousExecutive.get_instance();
      const allocation = await (executive as any).allocateTask('memory');
      const influenced = await (executive as any).maybeInfluenceAllocation(allocation, 'memory');
      // Fail closed: the existing allocator's choice stands, byte-identical.
      expect(JSON.stringify(influenced)).toBe(JSON.stringify(allocation));
      expect(influenced.agent).toBe('agent-b');
    } finally {
      delete process.env.COGNITIVE_SCHEDULER_MODE;
    }
  });
});
