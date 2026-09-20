/**
 * Phase 8 tests — CONTRACT-phase8.md §4.5-4.16:
 *  - skill evolution gates (candidate → replay → canary → promotion; refusals recorded)
 *  - the eight seeded failure modes, run on CONTROLLED missions only, with the
 *    declared-correct-behaviour-first discipline and honest misses recorded
 *  - structural proof that the injection path cannot reach non-controlled missions
 *  - baseline metric defined before measurement (§4.9)
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import {
  proposeSkillCandidate,
  runSkillReplay,
  startSkillCanary,
  completeSkillCanary,
  promoteSkillVersion,
  pinSkillVersion,
  candidateState,
  REPLAY_MIN_USAGE,
} from '../../src/services/mission-cognition/skill-evolution-service.js';
import { evaluateTriggers } from '../../src/services/mission-cognition/uncertainty-triggers.js';
import { buildResumeReport } from '../../src/services/mission-cognition/resume.js';
import { getMissionCognitionServices } from '../../src/services/mission-cognition/index.js';
import { dispatchActivationTool } from '../../src/services/mission-cognition/mcp-tools.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const FAKE_DB = new FakeDb();
const trusted: CallerIdentity = { user_id: 'operator', trusted: true };
const untrusted: CallerIdentity = { user_id: 'client-agent', trusted: false };

/** §4.7: the injection path is structurally incapable of touching a
 *  non-controlled mission — the harness helpers refuse any other prefix. */
const CONTROLLED_PREFIX = 'p8ctl_';
function controlledMission(missionId: string): void {
  if (!missionId.startsWith(CONTROLLED_PREFIX)) {
    throw new Error(`seeded faults go into controlled missions only (${CONTROLLED_PREFIX}*); refused: ${missionId}`);
  }
  FAKE_DB.collection('mission_states').docs.push({
    mission_id: missionId, title: `p8 ${missionId}`, intent: 'seeded fault', status: 'active',
    version: 1, authority_class: 'B', owner_id: 'operator', success_criteria: [],
    objectives: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}
function seedEntry(missionId: string, e: Record<string, unknown>): void {
  FAKE_DB.collection('epistemic_entries').docs.push({ mission_id: missionId, status: 'accepted', confidence: 0.5, ...e });
}

beforeEach(() => {
  FAKE_DB.reset();
  process.env.COGNITIVE_CONTROL_ENABLED = 'write';
  process.env.COGNITIVE_SCHEDULER_MODE = 'shadow';
  delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
});
afterEach(() => {
  delete process.env.COGNITIVE_CONTROL_ENABLED;
  delete process.env.COGNITIVE_SCHEDULER_MODE;
  delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
});

// ── skill evolution gates (criteria 11-16) ────────────────────────────────

function seedHistoricalUsage(skill: string, opts: { missions?: number; negativeRate?: number } = {}): string[] {
  const missions = opts.missions ?? REPLAY_MIN_USAGE;
  const ids: string[] = [];
  for (let i = 0; i < missions; i++) {
    const id = `hist_${i}`;
    ids.push(id);
    FAKE_DB.collection('mission_states').docs.push({
      mission_id: id, title: `hist ${i}`, intent: '', status: 'active', version: 1,
      authority_class: 'B', owner_id: 'operator', success_criteria: [], objectives: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    FAKE_DB.collection('state_deltas').docs.push({
      delta_id: `d_${i}`, idempotency_key: `idem_${i}`, mission_id: id, base_mission_version: 1,
      author_id: 'operator', delta_type: 'CLAIM_ADDED', operations: [], rationale: 'hist',
      confidence: 0.5, status: 'accepted', skills_used: { [skill]: '1.0.0' },
      created_at: new Date().toISOString(),
    });
  }
  if (opts.negativeRate !== undefined) {
    // Seed a full outcome set so the recorded rate equals the requested rate:
    // 4 outcomes per mission, negativeRate share are unnecessary_cost.
    const totalPerMission = 4;
    const negativesTotal = Math.round(missions * totalPerMission * opts.negativeRate);
    let seeded = 0;
    for (let i = 0; i < missions; i++) {
      for (let j = 0; j < totalPerMission; j++) {
        const isNegative = seeded < negativesTotal;
        seeded++;
        FAKE_DB.collection('trigger_evaluations').docs.push({
          evaluation_id: `out_${i}_${j}`, mission_id: ids[i], trigger: 'material_contradictory_evidence',
          fired_at: new Date().toISOString(),
          outcome: isNegative ? 'unnecessary_cost' : 'useful_information', token_cost: 10,
        });
      }
    }
  }
  return ids;
}

describe('skill evolution gates — candidate → replay → canary → promotion (criteria 11-16)', () => {
  it('the full chain works and promotion updates the registry with every step recorded', async () => {
    seedHistoricalUsage('mission-state-management', { negativeRate: 0.2 });
    controlledMission('p8ctl_canary_target');
    const cand = await proposeSkillCandidate(FAKE_DB, {
      skill: 'mission-state-management', version: '1.3.0', note: 'better checkpoint compaction', actorId: 'operator',
    });
    const replay = await runSkillReplay(FAKE_DB, { candidateId: cand.candidate_id!, actorId: 'operator' });
    expect(replay.verdict).toBe('pass');
    await startSkillCanary(FAKE_DB, { candidateId: cand.candidate_id!, missionId: 'p8ctl_canary_target', actorId: 'operator' });
    await completeSkillCanary(FAKE_DB, { candidateId: cand.candidate_id!, outcome: 'ok', actorId: 'operator' });
    const promotion = await promoteSkillVersion(FAKE_DB, { candidateId: cand.candidate_id!, actorId: 'operator' });
    expect(promotion.kind).toBe('promotion');
    const registry = FAKE_DB.collection('skill_registry').docs;
    expect(registry.length).toBe(1);
    expect(registry[0]).toEqual(expect.objectContaining({ skill: 'mission-state-management', current_version: '1.3.0' }));
    const state = await candidateState(FAKE_DB, cand.candidate_id!);
    expect(state!.promoted).toBe(true);
    expect(state!.replay_verdict).toBe('pass');
    const kinds = FAKE_DB.collection('skill_evolution').docs.map((r: any) => r.kind);
    for (const k of ['candidate', 'replay', 'canary', 'promotion']) expect(kinds).toContain(k);
  });

  it('promotion without replay evidence is REFUSED and the refusal is recorded (§4.12)', async () => {
    const cand = await proposeSkillCandidate(FAKE_DB, {
      skill: 'epistemic-ledger', version: '9.9.9', note: 'skip replay', actorId: 'operator',
    });
    await expect(promoteSkillVersion(FAKE_DB, { candidateId: cand.candidate_id!, actorId: 'operator' }))
      .rejects.toThrow(/no replay evidence/);
    const refusal = FAKE_DB.collection('skill_evolution').docs.find((r: any) => r.kind === 'refusal');
    expect(refusal).toBeTruthy();
    expect(refusal.note).toContain('no replay evidence');
    expect(FAKE_DB.collection('skill_registry').docs.length).toBe(0);
  });

  it('promotion without canary evidence is REFUSED and recorded — replay alone is not enough (§4.12)', async () => {
    seedHistoricalUsage('epistemic-ledger', { negativeRate: 0 });
    const cand = await proposeSkillCandidate(FAKE_DB, {
      skill: 'epistemic-ledger', version: '2.0.0', note: 'replay but no canary', actorId: 'operator',
    });
    const replay = await runSkillReplay(FAKE_DB, { candidateId: cand.candidate_id!, actorId: 'operator' });
    expect(replay.verdict).toBe('pass');
    await expect(promoteSkillVersion(FAKE_DB, { candidateId: cand.candidate_id!, actorId: 'operator' }))
      .rejects.toThrow(/no completed ok-canary/);
    const refusal = FAKE_DB.collection('skill_evolution').docs.find((r: any) => r.kind === 'refusal');
    expect(refusal.note).toContain('no completed ok-canary');
  });

  it('a single good run is insufficient by construction (§4.16) and a regressing candidate is rejected (§4.13)', async () => {
    // One historical mission only -> replay 'insufficient'.
    seedHistoricalUsage('cognitive-baton', { missions: 1, negativeRate: 0 });
    const single = await proposeSkillCandidate(FAKE_DB, {
      skill: 'cognitive-baton', version: '1.1.0', note: 'one good run', actorId: 'operator',
    });
    const r1 = await runSkillReplay(FAKE_DB, { candidateId: single.candidate_id!, actorId: 'operator' });
    expect(r1.verdict).toBe('insufficient');
    await expect(promoteSkillVersion(FAKE_DB, { candidateId: single.candidate_id!, actorId: 'operator' }))
      .rejects.toThrow(/no replay evidence/);

    // Enough usage but recorded negative outcomes above the threshold -> 'fail'.
    FAKE_DB.reset();
    seedHistoricalUsage('cognitive-baton', { missions: 4, negativeRate: 0.75 });
    const reg = await proposeSkillCandidate(FAKE_DB, {
      skill: 'cognitive-baton', version: '1.2.0', note: 'regressing', actorId: 'operator',
    });
    const r2 = await runSkillReplay(FAKE_DB, { candidateId: reg.candidate_id!, actorId: 'operator' });
    expect(r2.verdict).toBe('fail');
    expect(r2.detail.negative_rate).toBe(0.75);
    await expect(startSkillCanary(FAKE_DB, { candidateId: reg.candidate_id!, missionId: 'm_x', actorId: 'operator' }))
      .rejects.toThrow(/canary refused: replay verdict fail/);
  });

  it('pin records the explicit migration approval (§4.15) and the lifecycle tools require a trusted caller', async () => {
    controlledMission('p8ctl_pin');
    const pin = await pinSkillVersion(FAKE_DB, { missionId: 'p8ctl_pin', skill: 'explore-and-falsify', version: '0.9.0', actorId: 'operator' });
    expect(pin.kind).toBe('pin');
    expect(pin.mission_id).toBe('p8ctl_pin');
    const denied = await dispatchActivationTool('propose_skill_candidate', {
      skill: 'x', version: '1', note: 'nope',
    }, untrusted);
    expect(denied.map(d => d.text).join('')).toContain('trusted caller');
    // Flag-off: plain Unknown tool, indistinguishable.
    delete process.env.COGNITIVE_CONTROL_ENABLED;
    await expect(dispatchActivationTool('promote_skill_version', { candidate_id: 'cand_x' }, trusted))
      .rejects.toThrow('Unknown tool: promote_skill_version');
  });
});

// ── seeded failure modes (criteria 5-8) ───────────────────────────────────

describe('seeded failure modes — doc 04, controlled missions only (criteria 5-8)', () => {
  it('the injection path refuses non-controlled missions (structural, criterion 7)', () => {
    expect(() => controlledMission('ms_production_mission')).toThrow(/controlled missions only/);
    expect(() => controlledMission('p8ctl_ok')).not.toThrow();
  });

  it('seeds all eight modes, declares behaviour first, records honest misses, and captures the run', async () => {
    // §4.9: the metric is defined BEFORE measuring.
    const METRIC_DEFINITION =
      'detected_count / 8, where a mode is detected iff the plane\'s deterministic surface flags it ' +
      'automatically (uncertainty trigger fired, or a mechanism verdict: baton auto-revocation, ' +
      'resume reconstruction). Baseline without the layer = 0/8 by construction: the detectors only ' +
      'exist inside the plane. Honest misses are recorded as findings, not smoothed over.';

    interface FaultRun {
      mode: string;
      declared_correct_behaviour: string;
      observed: string;
      detected: boolean;
      finding?: string;
    }
    const runs: FaultRun[] = [];

    // (a) wrong inherited assumption — claim with high confidence depending on an assumption, no direct evidence.
    {
      controlledMission('p8ctl_a');
      seedEntry('p8ctl_a', { entry_id: 'assump_a', entry_type: 'assumption', status: 'accepted', confidence: 0.9, statement: 'inherited assumption' });
      seedEntry('p8ctl_a', { entry_id: 'claim_a', entry_type: 'claim', status: 'accepted', confidence: 0.9, statement: 'built on the assumption', depends_on: ['assump_a'] });
      const { fired } = await evaluateTriggers(FAKE_DB, 'p8ctl_a');
      const detected = fired.some(f => f.trigger === 'high_confidence_unsupported');
      runs.push({
        mode: '(a) wrong inherited assumption',
        declared_correct_behaviour: 'the plane flags the high-confidence claim that rests on an unsupported assumption (trigger high_confidence_unsupported)',
        observed: fired.map(f => f.trigger).join(',') || '(no triggers fired)',
        detected,
        ...(detected ? {} : { finding: 'plane did not detect this mode' }),
      });
    }

    // (b) contradictory evidence.
    {
      controlledMission('p8ctl_b');
      seedEntry('p8ctl_b', { entry_id: 'claim_b', entry_type: 'claim', status: 'accepted', confidence: 0.9, statement: 'the claim' });
      seedEntry('p8ctl_b', { entry_id: 'ev_b', entry_type: 'evidence', status: 'accepted', statement: 'against it', evidence_against: ['claim_b'] });
      const { fired } = await evaluateTriggers(FAKE_DB, 'p8ctl_b');
      const detected = fired.some(f => f.trigger === 'material_contradictory_evidence');
      runs.push({
        mode: '(b) contradictory evidence',
        declared_correct_behaviour: 'the plane flags material evidence against an accepted claim (trigger material_contradictory_evidence)',
        observed: fired.map(f => f.trigger).join(',') || '(no triggers fired)',
        detected,
        ...(detected ? {} : { finding: 'plane did not detect this mode' }),
      });
    }

    // (c) context loss — resume from stored records alone.
    {
      controlledMission('p8ctl_c');
      seedEntry('p8ctl_c', { entry_id: 'note_c', entry_type: 'claim', status: 'accepted', statement: 'context must survive' });
      const report = await buildResumeReport(FAKE_DB, 'p8ctl_c');
      const detected = Boolean(report.mission && report.next_action?.rationale);
      runs.push({
        mode: '(c) context loss',
        declared_correct_behaviour: 'the plane reconstructs the mission from stored records with NO chat history (resume view), so a context loss does not lose the mission',
        observed: JSON.stringify(report).slice(0, 120),
        detected,
        ...(detected ? {} : { finding: 'plane did not detect this mode' }),
      });
    }

    // (d) stale baton — auto-revocation on version advance.
    {
      controlledMission('p8ctl_d');
      const services = getMissionCognitionServices(FAKE_DB as never);
      const baton = await services.batons.issueBaton({
        schema_version: '1.0', mission_id: 'p8ctl_d', mission_version: 1, recipient_id: 'agent-a',
        mode: 'execute', objective: 'do work', deliverable: 'report',
        expires_at: new Date(Date.now() + 3600e3).toISOString(),
      });
      await services.deltas.submitDelta({
        schema_version: '1.0', idempotency_key: 'p8ctl_d1_key', mission_id: 'p8ctl_d', base_mission_version: 1,
        author_id: 'operator', delta_type: 'CLAIM_ADDED',
        operations: [{ op: 'add', path: '/ledger_refs/-', value: null }], rationale: 'advance',
        ledger_entries: [{
          schema_version: '1.0', mission_id: 'p8ctl_d', entry_type: 'claim',
          statement: 'advance the mission version so the baton goes stale',
          status: 'accepted', author_id: 'operator', confidence: 0.5,
        }],
        confidence: 0.5,
      }, { actorId: 'operator' });
      const fetched = await services.batons.getBaton(baton.baton_id, 'agent-a');
      const revoked = FAKE_DB.collection('cognitive_batons').docs.find((b: any) => b.baton_id === baton.baton_id);
      const detected = fetched === null || Boolean(revoked?.revoked);
      runs.push({
        mode: '(d) stale baton',
        declared_correct_behaviour: 'a baton whose mission version is behind the current state is auto-revoked on read (never honoured stale)',
        observed: fetched === null ? 'baton revoked / unreadable' : 'baton still served',
        detected,
        ...(detected ? {} : { finding: 'plane did not detect this mode' }),
      });
    }

    // (e) executor duplication — two agents, same conclusion.
    {
      controlledMission('p8ctl_e');
      seedEntry('p8ctl_e', { entry_id: 'h_e1', entry_type: 'hypothesis', status: 'accepted', author_id: 'agent-a', statement: 'The fix is X' });
      seedEntry('p8ctl_e', { entry_id: 'h_e2', entry_type: 'claim', status: 'accepted', author_id: 'agent-b', statement: 'The fix is X' });
      const { fired } = await evaluateTriggers(FAKE_DB, 'p8ctl_e');
      const detected = fired.some(f => f.trigger === 'convergent_agents');
      runs.push({
        mode: '(e) executor duplication',
        declared_correct_behaviour: 'two agents converging on the same conclusion is flagged (trigger convergent_agents) so duplication is visible',
        observed: fired.map(f => f.trigger).join(',') || '(no triggers fired)',
        detected,
        ...(detected ? {} : { finding: 'plane did not detect this mode' }),
      });
    }

    // (f) graph lag — no detector exists in the plane. Honest miss, recorded.
    runs.push({
      mode: '(f) graph lag',
      declared_correct_behaviour: 'the plane has no knowledge-graph lag detector; knowledge-graph internals are outside mission-cognition (not in the plane\'s boundary)',
      observed: 'no detector exists to run',
      detected: false,
      finding: 'HONEST MISS: no graph-lag detection surface exists in the plane — recorded, not smoothed over (§4.6).',
    });

    // (g) LLM outage — no detector exists in the plane. Honest miss, recorded.
    runs.push({
      mode: '(g) LLM outage',
      declared_correct_behaviour: 'the plane does not watch LLM availability; llm-service.ts is closed (Phase 4 boundary) — an outage shows up as measured cost basis, not as a trigger',
      observed: 'no detector exists to run',
      detected: false,
      finding: 'HONEST MISS: no LLM-outage detection surface exists in the plane — recorded, not smoothed over (§4.6).',
    });

    // (h) correlated agents.
    {
      controlledMission('p8ctl_h');
      seedEntry('p8ctl_h', { entry_id: 'h_h1', entry_type: 'hypothesis', status: 'accepted', author_id: 'agent-c', statement: 'Correlated conclusion' });
      seedEntry('p8ctl_h', { entry_id: 'h_h2', entry_type: 'claim', status: 'accepted', author_id: 'agent-d', statement: 'Correlated conclusion' });
      const { fired } = await evaluateTriggers(FAKE_DB, 'p8ctl_h');
      const detected = fired.some(f => f.trigger === 'convergent_agents');
      runs.push({
        mode: '(h) correlated agents',
        declared_correct_behaviour: 'agents whose conclusions correlate are flagged (trigger convergent_agents) so the correlation is visible',
        observed: fired.map(f => f.trigger).join(',') || '(no triggers fired)',
        detected,
        ...(detected ? {} : { finding: 'plane did not detect this mode' }),
      });
    }

    const detectedCount = runs.filter(r => r.detected).length;
    const capture = {
      harness: 'phase8-seeded-faults',
      contract: 'CONTRACT-phase8.md §4.5-4.10',
      metric_defined_before_measurement: METRIC_DEFINITION,
      controlled_prefix: CONTROLLED_PREFIX,
      baseline_without_layer: '0/8 by construction — the detectors only exist inside the plane',
      detected_count: detectedCount,
      total_modes: runs.length,
      honest_misses: runs.filter(r => !r.detected).map(r => ({ mode: r.mode, finding: r.finding })),
      runs,
      captured_at: new Date().toISOString(),
    };
    const outDir = process.env.HOME + '/katra-long-horizon/loop/harness';
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/phase8-seeded-faults.json`, JSON.stringify(capture, null, 2));
    expect(FAKE_DB).toBeTruthy();

    // The plane must detect the modes it owns; honest misses are findings, not failures.
    expect(detectedCount).toBeGreaterThanOrEqual(5); // (a)(b)(c)(d)(e)(h) expected; (f)(g) honest misses
    expect(capture.honest_misses.length).toBeGreaterThanOrEqual(2);
    // No production-collection writes happened anywhere: every seeded mission
    // and entry carries the controlled prefix.
    const allMissions = FAKE_DB.collection('mission_states').docs.map((m: any) => m.mission_id);
    expect(allMissions.every(id => id.startsWith(CONTROLLED_PREFIX))).toBe(true);
  });
});
