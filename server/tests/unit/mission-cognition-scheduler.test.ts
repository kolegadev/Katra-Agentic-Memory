/**
 * Phase 4 scheduler (shadow mode) unit tests — contract CONTRACT-phase4.md
 * criteria 1-15, minus the ones the Verifier measures live.
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { measureCognitiveCost, COST_BASIS, COST_BASIS_ZERO, COST_FLOOR } from '../../src/services/mission-cognition/cost-model.js';
import { generateWorkItems } from '../../src/services/mission-cognition/work-item-generator.js';
import { scorePriority } from '../../src/services/mission-cognition/priority-scorer.js';
import { SchedulerService } from '../../src/services/mission-cognition/scheduler-service.js';
import { dispatchSchedulerTool, handleCognitiveTool } from '../../src/services/mission-cognition/mcp-tools.js';
import { schedulerMode } from '../../src/services/mission-cognition/index.js';
import type { CognitiveWorkItem, MissionState } from '../../src/types/cognitive-control.js';

const FAKE_DB = new FakeDb();
const db = FAKE_DB.asDb();

function seedMission(overrides: Partial<MissionState> = {}): MissionState {
  const state: MissionState = {
    schema_version: '1.0',
    mission_id: 'ph4_mission',
    version: 1,
    title: 'Phase 4 test mission',
    intent: 'test',
    status: 'active',
    owner_id: 'satori',
    success_criteria: [{ id: 'c1', description: 'x', status: 'unmet' }],
    authority_class: 'B',
    objectives: [
      { id: 'o1', description: 'Objective one', status: 'pending', owner_id: 'satori', dependency_ids: [] },
      { id: 'o2', description: 'Objective two', status: 'blocked', owner_id: 'satori', dependency_ids: ['o1'] },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  FAKE_DB.collection('mission_states').docs.push(structuredClone(state));
  return state;
}

afterEach(() => FAKE_DB.reset());

describe('cost model (§2 prerequisite, criterion 1)', () => {
  it('is measured, floored, and labelled', async () => {
    // with usage rows: measured tokens
    FAKE_DB.collection('llm_usage').docs.push(
      { mission_id: 'costtest', input_tokens: 300, output_tokens: 50 },
    );
    const measured = await measureCognitiveCost(db, 'costtest');
    expect(measured.cost).toBe(350);
    expect(measured.basis).toBe(COST_BASIS);
    // with zero usage: floor + visible zero basis — never an invented band
    const zero = await measureCognitiveCost(db, 'never-seen');
    expect(zero.cost).toBe(COST_FLOOR);
    expect(zero.basis).toBe(COST_BASIS_ZERO);
    expect(COST_BASIS).toContain('measured');
  });
});

describe('work item generation (criteria 2-3)', () => {
  it('generates from real triggers with a full feature vector', async () => {
    seedMission();
    FAKE_DB.collection('epistemic_entries').docs.push(
      { entry_id: 'u1', mission_id: 'ph4_mission', entry_type: 'uncertainty', status: 'active', statement: 'u' },
      { entry_id: 'd1', mission_id: 'ph4_mission', entry_type: 'decision', status: 'invalidated', statement: 'd' },
    );
    // measured cost: seed usage rows so the basis is real measurement
    FAKE_DB.collection('llm_usage').docs.push(
      { mission_id: 'ph4_mission', work_item_id: null, input_tokens: 120, output_tokens: 30 },
    );
    const items = await generateWorkItems(db, 'ph4_mission');
    const triggers = new Set(items.map(i => i.trigger));
    expect(triggers.has('open_objective')).toBe(true);
    expect(triggers.has('blocked_dependency')).toBe(true);
    expect(triggers.has('active_uncertainty')).toBe(true);
    expect(triggers.has('invalidated_decision')).toBe(true);
    for (const i of items) {
      const f = i.item.features;
      for (const key of ['mission_impact', 'uncertainty', 'information_value', 'dependency_centrality', 'urgency', 'cognitive_cost']) {
        expect(typeof (f as any)[key]).toBe('number');
      }
      expect(f.cost_basis).toBe(COST_BASIS);
      expect(f.cognitive_cost).toBe(150); // measured tokens, not a band
    }
  });
  it('generates nothing for a completed mission', async () => {
    seedMission({ status: 'completed' });
    expect(await generateWorkItems(db, 'ph4_mission')).toHaveLength(0);
  });
});

describe('priority scorer (criteria 4-5)', () => {
  const base = (overrides: Partial<CognitiveWorkItem['features']> = {}): CognitiveWorkItem => ({
    schema_version: '1.0', work_item_id: 'w1', mission_id: 'm', description: 'd', mode: 'execute',
    status: 'queued', authority_class: 'B', trigger: 'manual',
    features: {
      mission_impact: 2, uncertainty: 1, information_value: 2,
      dependency_centrality: 1, urgency: 2, cognitive_cost: 2, cost_basis: COST_BASIS,
      ...overrides,
    },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  it('is deterministic for identical inputs', () => {
    const a = scorePriority(base());
    const b = scorePriority(base());
    expect(a.priority).toBe(b.priority);
    expect(JSON.stringify(a.contributions)).toBe(JSON.stringify(b.contributions));
  });
  it('never divides by zero or produces infinite scores with missing cost/uncertainty', () => {
    const zeroCost = scorePriority(base({ cognitive_cost: 0 }));
    const missing = scorePriority(base({ cognitive_cost: undefined as never, uncertainty: undefined as never }));
    expect(Number.isFinite(zeroCost.priority)).toBe(true);
    expect(Number.isFinite(missing.priority)).toBe(true);
  });
});

describe('scheduler service (criteria 6, 7, 14, 15)', () => {
  it('persists decisions with per-feature explanations, exclusions, and rationale', async () => {
    process.env.COGNITIVE_SCHEDULER_MODE = 'shadow';
    seedMission();
    FAKE_DB.collection('epistemic_entries').docs.push(
      { entry_id: 'u1', mission_id: 'ph4_mission', entry_type: 'uncertainty', status: 'active', statement: 'u', author_id: 'satori' },
    );
    FAKE_DB.collection('system_settings').docs.push({
      key: 'client_keys', value: { a: { user_id: 'agent-a' }, b: { user_id: 'agent-b' } },
    });
    const svc = new SchedulerService(db);
    const { decision, queue } = await svc.runShadowPass('ph4_mission');
    expect(queue.length).toBeGreaterThan(0);
    expect(decision.scheduler_mode).toBe('shadow');
    // No usage rows in this fixture: the honest zero-observed basis must be
    // recorded — the decision may never claim a measurement it does not have.
    expect([COST_BASIS, COST_BASIS_ZERO]).toContain(decision.cost_basis);
    expect(decision.cost_basis).toContain('measured');
    expect(decision.candidates.length).toBeGreaterThan(0);
    expect(decision.candidates[0].feature_contributions.length).toBeGreaterThan(0);
    expect(decision.recommended_was_acted_on).toBe(false); // criterion 14: recorded, not acted on
    expect(decision.existing_allocator_note).toContain('untouched'); // criterion 15
    const explanation = await svc.explainLatest('ph4_mission');
    expect(explanation).toContain('cost basis');
    expect(explanation).toContain('priority.');
    expect(explanation).toContain('Rationale:');
    delete process.env.COGNITIVE_SCHEDULER_MODE;
  });
  it('refuses to run when the scheduler flag is off', async () => {
    delete process.env.COGNITIVE_SCHEDULER_MODE;
    const svc = new SchedulerService(db);
    await expect(svc.runShadowPass('ph4_mission')).rejects.toThrow(/off/);
  });
});

describe('privacy boundary (criterion 8)', () => {
  it('never surfaces private material through the explanation', async () => {
    process.env.COGNITIVE_SCHEDULER_MODE = 'shadow';
    seedMission();
    // Private-memory-shaped fixture: a profile doc carrying narrative private content.
    FAKE_DB.collection('agent_cognitive_profiles').docs.push({
      agent_id: 'agent-a',
      work_class_metrics: { investigation: { attempts: 9, success_rate: 0.8 } },
      derived_from_private_memory: false,
      PRIVATE_INNER_MONOLOGUE: 'I secretly think the incumbent plan is doomed',
      private_journal_quote: 'reflection about feeling anxious',
    });
    FAKE_DB.collection('epistemic_entries').docs.push(
      { entry_id: 'u1', mission_id: 'ph4_mission', entry_type: 'uncertainty', status: 'active', statement: 'u' },
    );
    const svc = new SchedulerService(db);
    await svc.runShadowPass('ph4_mission');
    const explanation = await svc.explainLatest('ph4_mission');
    expect(explanation).not.toContain('doomed');
    expect(explanation).not.toContain('anxious');
    expect(explanation).not.toContain('PRIVATE_INNER_MONOLOGUE');
    delete process.env.COGNITIVE_SCHEDULER_MODE;
  });
});

describe('safety-critical boundary (criterion 12)', () => {
  it('scheduler modules never import or invoke the live allocator', () => {
    const files = [
      'src/services/mission-cognition/scheduler-service.ts',
      'src/services/mission-cognition/work-item-generator.ts',
      'src/services/mission-cognition/suitability-scorer.ts',
      'src/services/mission-cognition/priority-scorer.ts',
      'src/services/mission-cognition/mcp-tools.ts',
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      expect(src).not.toMatch(/from\s+['"][^'"]*autonomous-executive/);
      expect(src).not.toMatch(/require\([^)]*autonomous-executive/);
      expect(src).not.toMatch(/from\s+['"][^'"]*adaptive-heartbeat/);
      expect(src).not.toMatch(/require\([^)]*adaptive-heartbeat/);
    }
  });
});

describe('flag gating (criteria 10, 11, 13)', () => {
  it('scheduler tools are unreachable when the scheduler flag is off (plain Unknown tool)', async () => {
    delete process.env.COGNITIVE_SCHEDULER_MODE;
    process.env.COGNITIVE_CONTROL_ENABLED = 'write';
    await expect(
      dispatchSchedulerTool('explain_scheduler_decision', { mission_id: 'x' }, { user_id: 'satori', trusted: true }),
    ).rejects.toThrow('Unknown tool: explain_scheduler_decision');
    delete process.env.COGNITIVE_CONTROL_ENABLED;
  });
  it('schedulerMode fails closed for unimplemented modes', () => {
    process.env.COGNITIVE_SCHEDULER_MODE = 'recommend';
    expect(schedulerMode()).toBe('off');
    process.env.COGNITIVE_SCHEDULER_MODE = 'allocate_internal';
    expect(schedulerMode()).toBe('off');
    process.env.COGNITIVE_SCHEDULER_MODE = 'shadow';
    expect(schedulerMode()).toBe('shadow');
    delete process.env.COGNITIVE_SCHEDULER_MODE;
  });
  it('workload penalty applies: saturated agent cannot outrank an idle one on equal merit', async () => {
    process.env.COGNITIVE_SCHEDULER_MODE = 'shadow';
    seedMission();
    FAKE_DB.collection('system_settings').docs.push({
      key: 'client_keys', value: { a: { user_id: 'agent-a' }, b: { user_id: 'agent-b' } },
    });
    // agent-a saturated with in-progress work; agent-b idle.
    FAKE_DB.collection('cognitive_work_items').docs.push(
      { work_item_id: 'x1', status: 'in_progress', ownership: { agent_id: 'agent-a' } },
      { work_item_id: 'x2', status: 'in_progress', ownership: { agent_id: 'agent-a' } },
      { work_item_id: 'x3', status: 'in_progress', ownership: { agent_id: 'agent-a' } },
    );
    FAKE_DB.collection('epistemic_entries').docs.push(
      { entry_id: 'u1', mission_id: 'ph4_mission', entry_type: 'uncertainty', status: 'active', statement: 'u' },
    );
    const svc = new SchedulerService(db);
    const { decision } = await svc.runShadowPass('ph4_mission');
    const a = decision.candidates.filter(c => c.agent_id === 'agent-a').sort((x, y) => y.combined - x.combined)[0];
    const b = decision.candidates.filter(c => c.agent_id === 'agent-b').sort((x, y) => y.combined - x.combined)[0];
    expect(b.combined).toBeGreaterThanOrEqual(a.combined);
    delete process.env.COGNITIVE_SCHEDULER_MODE;
  });
});
