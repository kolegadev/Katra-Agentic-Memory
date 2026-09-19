/**
 * Phase 6 activation tests — CONTRACT-phase6.md criteria 1-5, 7-10, 12-14,
 * 19-20 (evidence gate, ladder, opt-ins, hard bound, kill switch,
 * counterfactuals, recorded transitions). Runs against the in-memory fake.
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import {
  EVIDENCE_THRESHOLD,
  computeEvidenceGate,
  setMode,
  optInMission,
  revokeMissionOptIn,
  activeOptInsForOwner,
  getSchedulerInfluence,
  recordAllocationCounterfactual,
  acknowledgeEvidence,
  recordAllocatorObservation,
  observeAllocatorOutcome,
} from '../../src/services/mission-cognition/activation-service.js';
import { resetRuntimeSchedulerMode, schedulerMode } from '../../src/services/mission-cognition/scheduler-mode.js';
import { dispatchActivationTool } from '../../src/services/mission-cognition/mcp-tools.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const FAKE_DB = new FakeDb();
const trusted: CallerIdentity = { user_id: 'operator', trusted: true };
const untrusted: CallerIdentity = { user_id: 'client-agent', trusted: false };

function seedMission(missionId: string, ownerId = 'owner1'): void {
  FAKE_DB.collection('mission_states').docs.push({ mission_id: missionId, owner_id: ownerId });
}

function seedDecision(missionId: string, decisionId: string, opts: {
  recommendedAgent?: string | null;
  observationAgent?: string | null;
  mode?: string;
} = {}): void {
  const recommended = opts.recommendedAgent === undefined
    ? { work_item_id: `w_${decisionId}`, agent_id: 'agent-a' }
    : opts.recommendedAgent === null
      ? null
      : { work_item_id: `w_${decisionId}`, agent_id: opts.recommendedAgent };
  const doc: Record<string, any> = {
    schema_version: '1.0',
    decision_id: decisionId,
    mission_id: missionId,
    scheduler_mode: opts.mode ?? 'shadow',
    created_at: new Date().toISOString(),
    cost_basis: 'measured-tokens',
    candidates: [{ work_item_id: `w_${decisionId}`, agent_id: 'agent-a', priority: 1, suitability: 1, combined: 2, feature_contributions: [] }],
    exclusions: [],
    rationale: 'test',
    existing_allocator_note: 'shadow',
    recommended,
    recommended_was_acted_on: false,
  };
  if (opts.observationAgent !== undefined) {
    doc.allocator_observation = {
      agent_id: opts.observationAgent,
      observed_at: new Date().toISOString(),
      source: 'manual',
    };
  }
  FAKE_DB.collection('scheduler_decisions').docs.push(doc);
}

function seedEvidence(count: number, opts: { agreed?: boolean; ack?: boolean } = {}): void {
  seedMission('m_ev');
  for (let i = 0; i < count; i++) {
    seedDecision('m_ev', `d${i}`, {
      recommendedAgent: 'agent-a',
      observationAgent: opts.agreed === false && i === 0 ? 'agent-b' : 'agent-a',
    });
  }
}

beforeEach(() => {
  FAKE_DB.reset();
  resetRuntimeSchedulerMode();
  delete process.env.COGNITIVE_SCHEDULER_MODE;
  delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
  process.env.COGNITIVE_CONTROL_ENABLED = 'write';
});

afterEach(() => {
  resetRuntimeSchedulerMode();
  delete process.env.COGNITIVE_SCHEDULER_MODE;
  delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
  delete process.env.COGNITIVE_CONTROL_ENABLED;
});

describe('evidence gate (criteria 1-2)', () => {
  it('refuses recommend below the threshold — even with an acknowledgement', async () => {
    seedEvidence(EVIDENCE_THRESHOLD - 1, { ack: true });
    await acknowledgeEvidence(FAKE_DB, { actorId: 'operator' });
    const gate = await computeEvidenceGate(FAKE_DB);
    expect(gate.gate_open).toBe(false);
    expect(gate.qualifying_decisions).toBe(EVIDENCE_THRESHOLD - 1);
    const result = await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'trying early' });
    expect(result.changed).toBe(false);
    expect(schedulerMode()).toBe('off');
    const refusal = FAKE_DB.collection('activation_ledger').docs.find(r => r.kind === 'mode_change_refused');
    expect(refusal).toBeTruthy();
  });

  it('refuses recommend at the threshold when no human has read the figures', async () => {
    seedEvidence(EVIDENCE_THRESHOLD);
    await setMode(FAKE_DB, { mode: 'shadow', actorId: 'operator', reason: 'first rung' });
    const result = await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'no ack yet' });
    expect(result.changed).toBe(false);
    expect(result.refused_reason).toContain('acknowledgement');
  });

  it('opens when evidence is recorded AND a human has acknowledged — figures computed from stored records', async () => {
    seedEvidence(EVIDENCE_THRESHOLD);
    // One disagreement so the measured rate is not a perfect 1.0.
    await recordAllocatorObservation(FAKE_DB, { decisionId: 'd0', agentId: 'agent-b', source: 'manual' });
    const gate = await acknowledgeEvidence(FAKE_DB, { actorId: 'operator', note: 'read' });
    expect(gate.gate_open).toBe(true);
    expect(gate.qualifying_decisions).toBe(EVIDENCE_THRESHOLD);
    // The recorded acknowledgement carries the COMPUTED figures, not caller numbers.
    const ackRow = FAKE_DB.collection('activation_ledger').docs.find(r => r.kind === 'evidence_acknowledged');
    expect(ackRow.detail.decision_count).toBe(EVIDENCE_THRESHOLD);
    expect(ackRow.detail.agreement_rate).toBeCloseTo((EVIDENCE_THRESHOLD - 1) / EVIDENCE_THRESHOLD, 5);
    expect((await setMode(FAKE_DB, { mode: 'shadow', actorId: 'operator', reason: 'first rung' })).changed).toBe(true);
    const result = await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'evidence met' });
    expect(result.changed).toBe(true);
    expect(schedulerMode()).toBe('recommend');
  });
});

describe('mode ladder (criteria 3, 19-20)', () => {
  async function openGate(): Promise<void> {
    seedEvidence(EVIDENCE_THRESHOLD);
    await acknowledgeEvidence(FAKE_DB, { actorId: 'operator' });
  }

  it('cannot skip a rung: off → recommend is refused, off → shadow → recommend works', async () => {
    await openGate();
    const skipped = await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'skip' });
    expect(skipped.changed).toBe(false);
    expect(skipped.refused_reason).toContain('ladder');
    expect((await setMode(FAKE_DB, { mode: 'shadow', actorId: 'operator', reason: 'step 1' })).changed).toBe(true);
    expect((await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'step 2' })).changed).toBe(true);
    expect((await setMode(FAKE_DB, { mode: 'allocate_internal', actorId: 'operator', reason: 'step 3' })).changed).toBe(true);
  });

  it('every mode is reachable in reverse: allocate_internal → recommend → shadow → off', async () => {
    await openGate();
    await setMode(FAKE_DB, { mode: 'shadow', actorId: 'operator', reason: 'up' });
    await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'up' });
    await setMode(FAKE_DB, { mode: 'allocate_internal', actorId: 'operator', reason: 'up' });
    expect(schedulerMode()).toBe('allocate_internal');
    for (const down of ['recommend', 'shadow', 'off'] as const) {
      const r = await setMode(FAKE_DB, { mode: down, actorId: 'operator', reason: 'down' });
      expect(r.changed).toBe(true);
      expect(schedulerMode()).toBe(down);
    }
  });

  it('allocate_gated is refused (not implemented, §4.6) and the refusal is recorded', async () => {
    const r = await setMode(FAKE_DB, { mode: 'allocate_gated', actorId: 'operator', reason: 'try' });
    expect(r.changed).toBe(false);
    expect(r.refused_reason).toContain('not implemented');
    const refusal = FAKE_DB.collection('activation_ledger').docs.find(x => x.kind === 'mode_change_refused');
    expect(refusal.mode_to).toBe('allocate_gated');
    expect(refusal.actor_id).toBe('operator');
    expect(refusal.created_at).toBeTruthy();
  });

  it('every transition is recorded with who, when, and on what evidence (criterion 20)', async () => {
    await openGate();
    await setMode(FAKE_DB, { mode: 'shadow', actorId: 'operator', reason: 'r1' });
    await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'r2' });
    const changes = FAKE_DB.collection('activation_ledger').docs.filter(r => r.kind === 'mode_change');
    expect(changes.map(c => `${c.mode_from}->${c.mode_to}`)).toEqual(['off->shadow', 'shadow->recommend']);
    for (const c of changes) {
      expect(c.actor_id).toBe('operator');
      expect(c.created_at).toBeTruthy();
      expect(c.reason).toBeTruthy();
    }
    // The recommend transition carries its evidence basis.
    expect(changes[1].evidence_ref).toContain('evidence gate open');
  });

  it('kill switch forces off regardless of every other flag (criterion 10)', async () => {
    await openGate();
    await setMode(FAKE_DB, { mode: 'shadow', actorId: 'operator', reason: 'up' });
    await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'up' });
    process.env.COGNITIVE_ACTIVATION_KILL_SWITCH = '1';
    // While the switch is set, the system is off — even with a recommend runtime mode.
    expect(schedulerMode()).toBe('off');
    const r = await setMode(FAKE_DB, { mode: 'allocate_internal', actorId: 'operator', reason: 'no' });
    expect(r.changed).toBe(false);
    expect(r.refused_reason).toContain('KILL_SWITCH');
    // env-var kill switch semantics: off while set (production: set + restart),
    // and separately a runtime toggle to off works with no rebuild (criterion 10).
    delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
    const down = await setMode(FAKE_DB, { mode: 'off', actorId: 'operator', reason: 'runtime toggle down' });
    expect(down.changed).toBe(true);
    expect(schedulerMode()).toBe('off');
  });
});

describe('per-mission opt-in (criteria 5, 7-8)', () => {
  it('opt-in and immediate revocation without a rebuild', async () => {
    seedMission('m_opt');
    const optIn = await optInMission(FAKE_DB, { missionId: 'm_opt', ownerId: 'owner1', actorId: 'operator', reason: 'why' });
    expect((await activeOptInsForOwner(FAKE_DB, 'owner1')).length).toBe(1);
    const revoked = await revokeMissionOptIn(FAKE_DB, { missionId: 'm_opt', actorId: 'operator', reason: 'stop' });
    expect(revoked).toBe(1);
    // Runtime read: the revocation is effective immediately — no rebuild, no restart.
    expect((await activeOptInsForOwner(FAKE_DB, 'owner1')).length).toBe(0);
    expect(FAKE_DB.collection('activation_ledger').docs.some(r => r.kind === 'opt_in' && r.mission_id === 'm_opt')).toBe(true);
    expect(FAKE_DB.collection('activation_ledger').docs.some(r => r.kind === 'opt_in_revoke' && r.mission_id === 'm_opt')).toBe(true);
  });

  it('influence requires allocate_internal mode; recommend mode cannot influence (criterion 4-5)', async () => {
    seedMission('m_opt');
    await optInMission(FAKE_DB, { missionId: 'm_opt', ownerId: 'owner1', actorId: 'operator', reason: 'why' });
    seedDecision('m_opt', 'd_rec');
    resetRuntimeSchedulerMode();
    process.env.COGNITIVE_SCHEDULER_MODE = 'recommend';
    expect(await getSchedulerInfluence(FAKE_DB, { localUserId: 'owner1', candidates: ['agent-a'] })).toBeNull();
    expect(await getSchedulerInfluence(FAKE_DB, { localUserId: 'other-owner', candidates: ['agent-a'] })).toBeNull();
  });
});

describe('hard bound + influence + counterfactual (criteria 9, 12-14)', () => {
  async function enterAllocateInternal(): Promise<void> {
    seedEvidence(EVIDENCE_THRESHOLD);
    await acknowledgeEvidence(FAKE_DB, { actorId: 'operator' });
    await setMode(FAKE_DB, { mode: 'shadow', actorId: 'operator', reason: 'up' });
    await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'up' });
    await setMode(FAKE_DB, { mode: 'allocate_internal', actorId: 'operator', reason: 'up' });
  }

  it('influences at most the hard bound, then HALTS (fail closed) and records the halt once', async () => {
    await enterAllocateInternal();
    seedMission('m_opt');
    await optInMission(FAKE_DB, { missionId: 'm_opt', ownerId: 'owner1', actorId: 'operator', reason: 'why' });
    for (let i = 0; i < 4; i++) seedDecision('m_opt', `bd${i}`);

    const applied: string[] = [];
    for (let i = 0; i < 4; i++) {
      const influence = await getSchedulerInfluence(FAKE_DB, { localUserId: 'owner1', candidates: ['agent-a'] });
      if (!influence) break;
      applied.push(influence.decision_id);
      await recordAllocationCounterfactual(FAKE_DB, {
        missionId: influence.mission_id,
        decisionId: influence.decision_id,
        cycleId: influence.cycle_id,
        workItemId: influence.work_item_id,
        chosenAgentId: influence.agent_id,
        existingAllocatorAgentId: 'agent-b',
        reason: 'test influence',
      });
    }
    expect(applied.length).toBe(3); // hard bound = 3
    const halted = FAKE_DB.collection('activation_ledger').docs.filter(r => r.kind === 'cycle_halt');
    expect(halted.length).toBe(1);
    expect(halted[0].reason).toContain('fail closed');
    // The 4th decision was never consumed by anything.
    const counterfactuals = FAKE_DB.collection('allocation_counterfactuals').docs;
    expect(counterfactuals.length).toBe(3);
    expect(counterfactuals.every(c => c.influenced === true)).toBe(true);
  });

  it('every influenced allocation records the existing allocator\'s counterfactual choice (criterion 12)', async () => {
    await enterAllocateInternal();
    seedMission('m_opt');
    await optInMission(FAKE_DB, { missionId: 'm_opt', ownerId: 'owner1', actorId: 'operator', reason: 'why' });
    seedDecision('m_opt', 'cf1');
    const influence = await getSchedulerInfluence(FAKE_DB, { localUserId: 'owner1', candidates: ['agent-a'] });
    expect(influence).not.toBeNull();
    const cf = await recordAllocationCounterfactual(FAKE_DB, {
      missionId: influence!.mission_id,
      decisionId: influence!.decision_id,
      cycleId: influence!.cycle_id,
      workItemId: influence!.work_item_id,
      chosenAgentId: 'agent-a',
      existingAllocatorAgentId: 'agent-b',
      reason: 'scheduler recommendation beat the affinity winner',
    });
    expect(cf.existing_allocator_agent_id).toBe('agent-b'); // what the existing allocator would have done
    expect(cf.chosen_agent_id).toBe('agent-a');             // what was actually chosen
    expect(cf.reason).toContain('affinity');
    // Records distinguish scheduler-taken from allocator-taken (criterion 13).
    expect(FAKE_DB.collection('allocation_counterfactuals').docs.every(c => typeof c.influenced === 'boolean')).toBe(true);
    // Human-readable why + alternative (criterion 14) — both present on the record.
    expect(cf.reason.length).toBeGreaterThan(10);
    expect(FAKE_DB.collection('activation_ledger').docs.some(r => r.kind === 'influence_applied' && r.detail.decision_id === influence!.decision_id)).toBe(true);
  });

  it('a recommendation outside the allocator\'s candidate set cannot influence it', async () => {
    await enterAllocateInternal();
    seedMission('m_opt');
    await optInMission(FAKE_DB, { missionId: 'm_opt', ownerId: 'owner1', actorId: 'operator', reason: 'why' });
    seedDecision('m_opt', 'out1', { recommendedAgent: 'agent-z' });
    expect(await getSchedulerInfluence(FAKE_DB, { localUserId: 'owner1', candidates: ['agent-a', 'agent-b'] })).toBeNull();
  });

  it('one decision influences at most one allocation', async () => {
    await enterAllocateInternal();
    seedMission('m_opt');
    await optInMission(FAKE_DB, { missionId: 'm_opt', ownerId: 'owner1', actorId: 'operator', reason: 'why' });
    seedDecision('m_opt', 'once1');
    const first = await getSchedulerInfluence(FAKE_DB, { localUserId: 'owner1', candidates: ['agent-a'] });
    expect(first).not.toBeNull();
    await recordAllocationCounterfactual(FAKE_DB, {
      missionId: first!.mission_id, decisionId: first!.decision_id, cycleId: first!.cycle_id,
      workItemId: first!.work_item_id, chosenAgentId: first!.agent_id,
      existingAllocatorAgentId: 'agent-b', reason: 'once',
    });
    expect(await getSchedulerInfluence(FAKE_DB, { localUserId: 'owner1', candidates: ['agent-a'] })).toBeNull();
  });
});

describe('allocator observation (evidence accumulation)', () => {
  it('auto-observer reads the existing allocator\'s stored output and attaches it to the decision', async () => {
    seedMission('m_obs', 'owner1');
    seedDecision('m_obs', 'obs1');
    FAKE_DB.collection('episodic_events').docs.push({
      id: 'exec_x',
      user_id: 'owner1',
      event_type: 'executive_action',
      content: { role: 'assistant', message: '[AUTONOMOUS EXECUTIVE] ... Allocated to: agent-b' },
      timestamp: new Date(Date.now() - 60 * 1000),
      metadata: { assigned_agent: 'agent-b' },
    });
    const obs = await observeAllocatorOutcome(FAKE_DB, 'm_obs', 'obs1');
    expect(obs).not.toBeNull();
    expect(obs!.agent_id).toBe('agent-b');
    expect(obs!.source).toBe('auto-observer');
    const stored = FAKE_DB.collection('scheduler_decisions').docs.find(d => d.decision_id === 'obs1');
    expect(stored.allocator_observation.agent_id).toBe('agent-b');
    // And the evidence now counts toward the gate.
    const gate = await computeEvidenceGate(FAKE_DB);
    expect(gate.qualifying_decisions).toBe(1);
  });

  it('unobservable decisions stay unobserved — never invented', async () => {
    seedMission('m_obs2', 'owner1');
    seedDecision('m_obs2', 'obs2');
    expect(await observeAllocatorOutcome(FAKE_DB, 'm_obs2', 'obs2')).toBeNull();
    const stored = FAKE_DB.collection('scheduler_decisions').docs.find(d => d.decision_id === 'obs2');
    expect(stored.allocator_observation).toBeUndefined();
  });
});

describe('Phase-6 MCP surface', () => {
  it('set_scheduler_mode is reachable from mode off (plane on) and requires a trusted caller', async () => {
    const denied = await dispatchActivationTool('set_scheduler_mode', { mode: 'shadow', reason: 'x' }, untrusted);
    expect(denied.map(d => d.text).join('')).toContain('trusted caller');
    expect(schedulerMode()).toBe('off');
    const ok = await dispatchActivationTool('set_scheduler_mode', { mode: 'shadow', reason: 'x' }, trusted);
    expect(ok.map(d => d.text).join('')).toContain('shadow');
    expect(schedulerMode()).toBe('shadow');
  });

  it('activation tools are unreachable when the plane is off — plain Unknown tool', async () => {
    delete process.env.COGNITIVE_CONTROL_ENABLED;
    await expect(
      dispatchActivationTool('set_scheduler_mode', { mode: 'shadow', reason: 'x' }, trusted),
    ).rejects.toThrow('Unknown tool: set_scheduler_mode');
  });

  it('get_allocation_evidence reports the gate state from stored records', async () => {
    seedEvidence(3);
    const out = await dispatchActivationTool('get_allocation_evidence', {}, trusted);
    const json = JSON.parse(out.map(d => d.text).join('').replace(/^```json\n/, '').replace(/\n```$/, ''));
    expect(json.gate_open).toBe(false);
    expect(json.qualifying_decisions).toBe(3);
    expect(json.threshold).toBe(EVIDENCE_THRESHOLD);
  });

  it('env-booted recommend cannot surface advisories while the gate is closed (§4.1 at the acting path)', async () => {
    process.env.COGNITIVE_SCHEDULER_MODE = 'recommend';
    seedEvidence(2); // far below threshold, no acknowledgement
    seedMission('m_adv');
    const out = await dispatchActivationTool('get_scheduler_recommendation', { mission_id: 'm_adv' }, trusted);
    expect(out.map(d => d.text).join('')).toContain('Evidence gate closed');
  });

  it('env-booted allocate_internal cannot influence while the gate is closed', async () => {
    process.env.COGNITIVE_SCHEDULER_MODE = 'allocate_internal';
    seedMission('m_opt');
    await optInMission(FAKE_DB, { missionId: 'm_opt', ownerId: 'owner1', actorId: 'operator', reason: 'why' });
    seedDecision('m_opt', 'envby');
    expect(await getSchedulerInfluence(FAKE_DB, { localUserId: 'owner1', candidates: ['agent-a'] })).toBeNull();
  });

  it('decisive test A (isolation): influence is scoped to the opted-in mission\'s owner — nothing outside changes', async () => {
    // Same machinery as a real activation, two owners side by side.
    seedEvidence(EVIDENCE_THRESHOLD);
    await acknowledgeEvidence(FAKE_DB, { actorId: 'operator' });
    await setMode(FAKE_DB, { mode: 'shadow', actorId: 'operator', reason: 'up' });
    await setMode(FAKE_DB, { mode: 'recommend', actorId: 'operator', reason: 'up' });
    await setMode(FAKE_DB, { mode: 'allocate_internal', actorId: 'operator', reason: 'up' });
    seedMission('m_in', 'owner-in');
    seedMission('m_out', 'owner-out');
    await optInMission(FAKE_DB, { missionId: 'm_in', ownerId: 'owner-in', actorId: 'operator', reason: 'why' });
    seedDecision('m_in', 'iso-in');
    seedDecision('m_out', 'iso-out');
    // The opted-in owner is influenced.
    const influence = await getSchedulerInfluence(FAKE_DB, { localUserId: 'owner-in', candidates: ['agent-a'] });
    expect(influence?.mission_id).toBe('m_in');
    // The non-opted-in owner is untouched — the scheduler decision for THEIR
    // mission exists but there is no opt-in, so nothing is offered.
    expect(await getSchedulerInfluence(FAKE_DB, { localUserId: 'owner-out', candidates: ['agent-a'] })).toBeNull();
    // And nothing was recorded for the outside mission.
    expect(FAKE_DB.collection('allocation_counterfactuals').docs.some((c: any) => c.mission_id === 'm_out')).toBe(false);
  });
});

describe('criterion 4 — recommendation/advisory call-site discipline (static)', () => {
  it('the allocator reads NO scheduler storage or tools directly; the only bridge is activation-bridge', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = readFileSync('src/services/processing/autonomous-executive.ts', 'utf-8');
    // No direct reads of any scheduler storage, recommendation surface, or ledger.
    expect(src).not.toMatch(/scheduler_decisions/);
    expect(src).not.toMatch(/get_scheduler_recommendation/);
    expect(src).not.toMatch(/mission_opt_ins/);
    expect(src).not.toMatch(/activation_ledger/);
    expect(src).not.toMatch(/allocation_counterfactuals/);
    // No field read of a recommendation record (prose mentions are irrelevant).
    expect(src).not.toMatch(/\.recommended\b/);
    expect(src).not.toMatch(/recommended_was_acted_on/);
    // The only mission-cognition import is the deliberate Phase-6 bridge.
    const missionCognitionImports = [...src.matchAll(/from\s+['"][^'"]*mission-cognition[^'"]*['"]/g)].map(m => m[0]);
    expect(missionCognitionImports).toEqual(["from '../mission-cognition/activation-bridge.js'"]);
  });

  it('the bridge and activation modules never import the live allocator (criterion-12 boundary holds)', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    for (const f of [
      'src/services/mission-cognition/activation-service.ts',
      'src/services/mission-cognition/activation-bridge.ts',
      'src/services/mission-cognition/scheduler-mode.ts',
      'src/services/mission-cognition/scheduler-service.ts',
      'src/services/mission-cognition/mcp-tools.ts',
    ]) {
      const src = readFileSync(f, 'utf-8');
      expect(src).not.toMatch(/from\s+['"][^'"]*autonomous-executive/);
      expect(src).not.toMatch(/require\([^)]*autonomous-executive/);
    }
  });
});
