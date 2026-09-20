/**
 * Phase 7 dashboard API tests — CONTRACT-phase7.md criteria 3-15 (read-only,
 * privacy, redaction, gates, visibility, custodian controls, basis labels).
 * Against the in-memory fake; every GET is pinned to leave the store untouched.
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { createCognitionDashboardRoutes } from '../../src/routes/cognition-dashboard-routes.js';
import { runWithCaller } from '../../src/utils/caller-identity.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const FAKE_DB = new FakeDb();
const trusted: CallerIdentity = { user_id: 'operator', trusted: true };
const untrusted: CallerIdentity = { user_id: 'client-agent', trusted: false };

function app() {
  return new Hono().route('/api/v1/cognition', createCognitionDashboardRoutes());
}

async function get(path: string, caller: CallerIdentity = trusted): Promise<{ status: number; body: any }> {
  const res = await runWithCaller(caller, () => app().request(`http://x/api/v1/cognition${path}`));
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown, caller: CallerIdentity = trusted): Promise<{ status: number; body: any }> {
  const res = await runWithCaller(caller, () =>
    app().request(`http://x/api/v1/cognition${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const PRIVATE_MARKER = 'PRIVATE-JOURNAL-THOUGHT-DO-NOT-LEAK';
const EMOTION_MARKER = 'EMOTIONAL-VALENCE-DO-NOT-LEAK';

function seedDemoMission(missionId = 'm_demo', ownerId = 'operator'): void {
  FAKE_DB.collection('mission_states').docs.push({
    mission_id: missionId,
    title: 'Demo Mission',
    intent: 'demo',
    status: 'active',
    version: 3,
    authority_class: 'B',
    owner_id: ownerId,
    success_criteria: [],
    stop_conditions: [],
    objectives: [
      { id: 'o1', description: 'first objective', status: 'in_progress', owner_id: ownerId, dependency_ids: ['o2'] },
      { id: 'o2', description: 'second objective', status: 'pending', owner_id: ownerId },
    ],
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:10:00.000Z',
  });
  FAKE_DB.collection('epistemic_entries').docs.push(
    { entry_id: 'e1', mission_id: missionId, entry_type: 'claim', statement: 'a claim', status: 'accepted', confidence: 0.8, author_id: ownerId, depends_on: [], created_at: '2026-09-20T00:01:00.000Z', updated_at: '2026-09-20T00:01:00.000Z' },
    { entry_id: 'e2', mission_id: missionId, entry_type: 'uncertainty', statement: 'an uncertainty', status: 'active', confidence: 0.4, author_id: ownerId, depends_on: [], created_at: '2026-09-20T00:02:00.000Z', updated_at: '2026-09-20T00:02:00.000Z' },
  );
  FAKE_DB.collection('cognitive_work_items').docs.push({
    schema_version: '1.0',
    work_item_id: 'w1',
    mission_id: missionId,
    description: 'demo work',
    mode: 'execute',
    status: 'queued',
    authority_class: 'B',
    trigger: 'open_objective',
    features: { mission_impact: 2, uncertainty: 0.5, information_value: 1, dependency_centrality: 0, urgency: 1, cognitive_cost: 12, cost_basis: 'measured-tokens' },
    created_at: '2026-09-20T00:03:00.000Z',
    updated_at: '2026-09-20T00:03:00.000Z',
  });
  FAKE_DB.collection('trigger_evaluations').docs.push({
    evaluation_id: 't1',
    mission_id: missionId,
    trigger: 'material_contradictory_evidence',
    fired_at: '2026-09-20T00:04:00.000Z',
    outcome: 'useful_information',
    token_cost: 41,
  });
  FAKE_DB.collection('scheduler_decisions').docs.push({
    schema_version: '1.0',
    decision_id: 'd1',
    mission_id: missionId,
    scheduler_mode: 'shadow',
    created_at: '2026-09-20T00:05:00.000Z',
    cost_basis: 'measured-tokens',
    candidates: [
      { work_item_id: 'w1', agent_id: 'agent-a', priority: 3, suitability: 2, combined: 5, feature_contributions: [{ feature: 'priority.mission_impact', value: 2, weight: 1 }] },
      { work_item_id: 'w1', agent_id: 'agent-b', priority: 3, suitability: 1, combined: 4, feature_contributions: [] },
    ],
    exclusions: [{ work_item_id: 'w1', agent_id: 'agent-c', reason: 'workload saturated' }],
    rationale: 'agent-a ranked first',
    existing_allocator_note: 'shadow',
    recommended: { work_item_id: 'w1', agent_id: 'agent-a' },
    recommended_was_acted_on: false,
    allocator_observation: { agent_id: 'agent-a', observed_at: '2026-09-20T00:06:00.000Z', source: 'auto-observer', evidence_ref: 'exec_x' },
  });
  FAKE_DB.collection('allocation_counterfactuals').docs.push({
    counterfactual_id: 'cf1',
    mission_id: missionId,
    decision_id: 'd1',
    cycle_id: 'c1',
    work_item_id: 'w1',
    mode: 'allocate_internal',
    influenced: true,
    chosen_agent_id: 'agent-a',
    existing_allocator_agent_id: 'agent-b',
    recorded_at: '2026-09-20T00:07:00.000Z',
    reason: 'scheduler choice taken over the affinity winner',
  });
  FAKE_DB.collection('cognitive_batons').docs.push({
    schema_version: '1.0',
    baton_id: 'b1',
    mission_id: missionId,
    mission_version: 2,
    recipient_id: 'agent-a',
    mode: 'challenge',
    objective: 'challenge the incumbent',
    deliverable: 'report',
    issued_at: '2026-09-20T00:02:00.000Z',
    expires_at: '2026-09-27T00:00:00.000Z',
    skill_versions: { 'mission-state-management': '1.2.0' },
    blindness: { enabled: true, withheld_classes: ['decision', 'claim'] },
    context: { claims: ['incumbent claim'], note: 'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.sig-goes-here' },
  });
  // Private material that must NEVER surface through any dashboard endpoint.
  FAKE_DB.collection('episodic_events').docs.push(
    {
      id: 'ev_private_journal',
      user_id: ownerId,
      event_type: 'journal',
      content: { message: `my private journal: ${PRIVATE_MARKER} ${EMOTION_MARKER}` },
      timestamp: new Date('2026-09-20T00:08:00Z'),
      metadata: { tags: ['private', 'reflection'], emotional_tags: { valence: -0.9 } },
    },
    {
      id: 'ev_exec',
      user_id: 'katra',
      event_type: 'executive_action',
      content: { message: '[AUTONOMOUS EXECUTIVE]\nGoal: Resolve contradictions\nAction: check conflicts\nAllocated to: agent-b (confidence: 0.78)\nWhy: agent-b has stronger emotional proximity\nResult: success — Found 2 contradictions' },
      timestamp: new Date('2026-09-20T00:09:00Z'),
      metadata: { emotional_tags: { valence: 0.2, arousal: 0.3 } },
    },
  );
}

const ALL_GET_PATHS = [
  '/status', '/missions', '/missions/m_demo/overview', '/missions/m_demo/objectives',
  '/missions/m_demo/epistemics', '/missions/m_demo/uncertainties', '/missions/m_demo/work',
  '/missions/m_demo/scheduler', '/missions/m_demo/batons', '/missions/m_demo/skills',
  '/operations', '/activation', '/executive',
];

beforeEach(() => {
  FAKE_DB.reset();
  delete process.env.COGNITIVE_CONTROL_ENABLED;
  delete process.env.COGNITIVE_SCHEDULER_MODE;
  delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
  process.env.COGNITIVE_CONTROL_ENABLED = 'write';
});

afterEach(() => {
  delete process.env.COGNITIVE_CONTROL_ENABLED;
  delete process.env.COGNITIVE_SCHEDULER_MODE;
  delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
});

describe('read-only property (criterion 5)', () => {
  it('no GET endpoint mutates any collection', async () => {
    seedDemoMission();
    const before = JSON.stringify(FAKE_DB.collections, (k, v) => (k === 'docs' ? v : v));
    for (const p of ALL_GET_PATHS) {
      const { status } = await get(p);
      expect(status).toBe(200);
    }
    const after = JSON.stringify(FAKE_DB.collections, (k, v) => (k === 'docs' ? v : v));
    expect(after).toBe(before);
  });
});

describe('flag gating (criterion 7)', () => {
  it('with the plane off, data endpoints say so explicitly and /status still reports flags', async () => {
    process.env.COGNITIVE_CONTROL_ENABLED = 'off';
    seedDemoMission();
    const missions = await get('/missions');
    expect(missions.body.plane).toBe('off');
    expect(missions.body.reason).toContain('no back door');
    expect(missions.body.missions).toEqual([]);
    const status = await get('/status');
    expect(status.status).toBe(200);
    expect(status.body.plane).toBe('off');
    expect(status.body.scheduler_mode).toBe('off');
    expect(status.body.evidence_gate).toBeTruthy();
  });
});

describe('visibility (criterion 6 + privacy boundary)', () => {
  it('untrusted callers see their own and shared missions, never others', async () => {
    seedDemoMission('m_own', 'client-agent');
    seedDemoMission('m_shared', 'other-owner');
    FAKE_DB.collection('mission_states').docs.find((m: any) => m.mission_id === 'm_shared').shared_id = 'my-team';
    seedDemoMission('m_hidden', 'other-owner');
    const list = await get('/missions', untrusted);
    const ids = list.body.missions.map((m: any) => m.mission_id);
    expect(ids).toContain('m_own');
    expect(ids).toContain('m_shared');
    expect(ids).not.toContain('m_hidden');
    const hidden = await get('/missions/m_hidden/overview', untrusted);
    expect(hidden.status).toBe(404);
  });
});

describe('privacy fixture (criteria 8-10)', () => {
  it('no dashboard response ever contains private journal, reflection, or emotional content', async () => {
    seedDemoMission();
    const paths = [...ALL_GET_PATHS, '/missions/m_demo/skills', '/missions/m_demo/batons'];
    for (const p of paths) {
      for (const caller of [trusted, untrusted]) {
        const { body } = await get(p, caller);
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(PRIVATE_MARKER);
        expect(serialized).not.toContain(EMOTION_MARKER);
        expect(serialized).not.toContain('valence'); // emotional metadata excluded everywhere
      }
    }
  });

  it('the executive view shows only the system\'s own action log, field-filtered', async () => {
    seedDemoMission();
    const { body } = await get('/executive');
    expect(body.actions.length).toBe(1);
    expect(body.actions[0].goal).toBe('Resolve contradictions');
    expect(body.actions[0].allocated_to).toBe('agent-b');
    expect(body.actions[0].allocation_rationale).toBe('agent-b has stronger emotional proximity');
    expect(body.actions[0].result.success).toBe(true);
    expect(JSON.stringify(body)).not.toContain('journal');
    // The emotional_tags FIELD is never returned (the basis text may name it).
    expect(Object.keys(body.actions[0])).not.toContain('emotional_tags');
    expect(JSON.stringify(body)).not.toContain('0.3'); // arousal value from the stored event
  });
});

describe('baton inspector redaction (criterion 8)', () => {
  it('secret-shaped material is redacted, not shown', async () => {
    seedDemoMission();
    const { body } = await get('/missions/m_demo/batons');
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(body.batons[0].redactions).toBe(true);
    expect(body.batons[0].blindness_summary.enabled).toBe(true);
    expect(body.batons[0].blindness_summary.withheld_classes).toEqual(['decision', 'claim']);
  });
});

describe('scheduler view + shadow comparison + counterfactual (criteria 12-13)', () => {
  it('shows ranked candidates, exclusions with reasons, the shadow comparison, and the counterfactual', async () => {
    seedDemoMission();
    const { body } = await get('/missions/m_demo/scheduler');
    const d = body.decisions[0];
    expect(d.ranked_candidates.length).toBe(2);
    expect(d.ranked_candidates[0].basis).toBeTruthy();
    expect(d.exclusions[0].reason).toBe('workload saturated');
    expect(d.shadow_comparison).toBe('agreed');
    expect(d.counterfactual.existing_allocator_agent_id).toBe('agent-b');
    expect(d.counterfactual.chosen_agent_id).toBe('agent-a');
    expect(d.counterfactual.reason).toContain('affinity winner');
    expect(d.cost_basis).toBe('measured-tokens');
  });
});

describe('basis labels (criterion 11)', () => {
  it('numbers carry their basis from stored records', async () => {
    seedDemoMission();
    const work = await get('/missions/m_demo/work');
    expect(work.body.queue[0].cost_basis).toBe('measured-tokens');
    const status = await get('/status');
    expect(status.body.evidence_gate.basis).toContain('scheduler_decisions');
    const ops = await get('/operations');
    expect(ops.body.missions[0].basis).toContain('stored records');
  });
});

describe('empty with stated reason (criterion 4)', () => {
  it('a bare mission returns empty collections with explicit notes', async () => {
    FAKE_DB.collection('mission_states').docs.push({
      mission_id: 'm_empty', title: 'Empty', intent: '', status: 'active', version: 1,
      authority_class: 'B', owner_id: 'operator', success_criteria: [], objectives: [],
      created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
    });
    const sched = await get('/missions/m_empty/scheduler');
    expect(sched.body.decisions).toEqual([]);
    expect(sched.body.note).toContain('§4.4');
    const exec = await get('/executive');
    expect(exec.body.actions).toEqual([]);
    expect(exec.body.note).toContain('§4.4');
  });
});

describe('custodian controls (criterion 14)', () => {
  function seedForRebuild(): void {
    seedDemoMission('m_rebuild');
    const state = FAKE_DB.collection('mission_states').docs.find((m: any) => m.mission_id === 'm_rebuild');
    state.version = 2;
    state.ledger_refs = [];
    FAKE_DB.collection('state_deltas').docs.push({
      delta_id: 'delta1',
      idempotency_key: 'idem1',
      mission_id: 'm_rebuild',
      base_mission_version: 2,
      author_id: 'operator',
      delta_type: 'CLAIM_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'claim-1' }],
      rationale: 'repair test',
      confidence: 0.9,
      status: 'accepted',
      created_at: '2026-09-20T00:10:00.000Z',
      applied_at: '2026-09-20T00:10:00.000Z',
    });
  }

  it('rebuild requires a trusted caller and is audited', async () => {
    seedForRebuild();
    const denied = await post('/operations/rebuild', { mission_id: 'm_rebuild' }, untrusted);
    expect(denied.status).toBe(403);
    const ok = await post('/operations/rebuild', { mission_id: 'm_rebuild' });
    expect(ok.status).toBe(200);
    expect(ok.body.rebuilt).toBe(true);
    expect(ok.body.changed).toBe(true);
    const audit = FAKE_DB.collection('custodian_audit').docs;
    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe('rebuild');
    expect(audit[0].actor_id).toBe('operator');
    expect(audit[0].mission_id).toBe('m_rebuild');
    // Idempotent: a second rebuild reports honestly that nothing changed.
    const again = await post('/operations/rebuild', { mission_id: 'm_rebuild' });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(FAKE_DB.collection('custodian_audit').docs.length).toBe(2);
  });
});
