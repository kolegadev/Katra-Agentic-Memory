/**
 * MCP-surface smoke test for the cognitive control plane: full tool chain
 * (create → state → delta → ledger → baton → checkpoint → resume) against
 * the in-memory fake, plus caller-authority rules. No production DB access.
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';
process.env.COGNITIVE_CONTROL_ENABLED = 'write';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { handleCognitiveTool, dispatchCognitiveTool, COGNITIVE_TOOL_DEFS } from '../../src/services/mission-cognition/mcp-tools.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const FAKE_DB = new FakeDb();
const trusted: CallerIdentity = { user_id: 'agent-a', trusted: true };
const untrusted: CallerIdentity = { user_id: 'client-agent', trusted: false };

function txt(result: { type: string; text: string }[]): string {
  return result.map(r => r.text).join('\n');
}

afterEach(() => FAKE_DB.reset());

describe('cognitive control MCP surface (COGNITIVE_CONTROL_ENABLED=write)', () => {
  it('registers the thirty-eight cognitive tools (9 P1-2 + 3 P4 + 10 P5 + 9 P6 activation + 7 P8 skill gates)', () => {
    const names = COGNITIVE_TOOL_DEFS.map(t => t.name);
    expect(names).toEqual([
      'create_mission_v2', 'get_mission_state', 'submit_state_delta', 'list_state_deltas',
      'query_epistemic_ledger', 'compile_cognitive_baton', 'get_cognitive_baton',
      'checkpoint_mission', 'resume_mission',
      'create_cognitive_work_item', 'get_cognitive_queue', 'explain_scheduler_decision',
      'list_uncertainties', 'evaluate_triggers', 'trace_assumption_dependencies',
      'invalidate_decision', 'propose_experiment', 'record_experiment_result',
      'get_trigger_report', 'create_blind_work_item', 'record_trigger_outcome',
      'get_hypothesis_diversity',
      'set_scheduler_mode', 'opt_in_mission', 'revoke_mission_opt_in',
      'get_allocation_evidence', 'acknowledge_evidence', 'get_activation_ledger',
      'get_allocation_counterfactual', 'record_allocator_observation',
      'get_scheduler_recommendation',
      'propose_skill_candidate', 'run_skill_replay', 'start_skill_canary',
      'complete_skill_canary', 'promote_skill_version', 'pin_skill_version',
      'get_skill_candidate_state',
    ]);
  });

  it('runs the full mission lifecycle through the tool surface', async () => {
    const created = await handleCognitiveTool('create_mission_v2', {
      title: 'Egress throttling investigation',
      success_criteria: ['root cause identified', 'fix verified'],
      authority_class: 'B',
    }, trusted);
    const missionId = (txt(created).match(/`(ms_[^`]+)`/) ?? [])[1];
    expect(missionId).toBeTruthy();

    const state = await handleCognitiveTool('get_mission_state', { mission_id: missionId }, trusted);
    expect(txt(state)).toContain('v1');

    const delta = await handleCognitiveTool('submit_state_delta', {
      mission_id: missionId,
      base_mission_version: 1,
      delta_type: 'CLAIM_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'claim-1' }],
      rationale: 'smoke test claim',
      ledger_entries: [{
        entry_type: 'claim', statement: 'YouTube captions are IP-throttled; audio download is not.',
        confidence: 0.8,
      }],
    }, trusted);
    expect(txt(delta)).toContain('accepted');

    const stateV2 = await handleCognitiveTool('get_mission_state', { mission_id: missionId }, trusted);
    expect(txt(stateV2)).toContain('v2');

    const ledger = await handleCognitiveTool('query_epistemic_ledger', { mission_id: missionId }, trusted);
    expect(txt(ledger)).toContain('IP-throttled');

    const baton = await handleCognitiveTool('compile_cognitive_baton', {
      mission_id: missionId, recipient_id: 'worker-1', mode: 'challenge',
      objective: 'Independently verify the throttling claim.', deliverable: 'delta',
      blindness: { enabled: true, withheld_classes: ['incumbent_conclusion'] },
    }, trusted);
    const batonId = (txt(baton).match(/`([0-9a-f-]{36})`/) ?? [])[1];
    expect(batonId).toBeTruthy();

    const fetched = await handleCognitiveTool('get_cognitive_baton', { baton_id: batonId }, trusted);
    expect(txt(fetched)).toContain('Independently verify');

    const ckpt = await handleCognitiveTool('checkpoint_mission', { mission_id: missionId }, trusted);
    expect(txt(ckpt)).toContain('Checkpoint created');

    const resume = await handleCognitiveTool('resume_mission', { mission_id: missionId }, trusted);
    expect(txt(resume)).toContain('v2');
    expect(txt(resume)).toContain('Egress throttling');
  });

  it('a ledger entry declaring `supersedes` moves the target out of accepted', async () => {
    const created = await handleCognitiveTool('create_mission_v2', {
      title: 'Supersession regression', success_criteria: ['correction applied'],
    }, trusted);
    const missionId = (txt(created).match(/`(ms_[^`]+)`/) ?? [])[1];

    await handleCognitiveTool('submit_state_delta', {
      mission_id: missionId, base_mission_version: 1, delta_type: 'CLAIM_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'c1' }],
      rationale: 'first claim',
      ledger_entries: [{ entry_type: 'claim', statement: 'The gate is closed.', confidence: 0.8 }],
    }, trusted);

    const first = await handleCognitiveTool('query_epistemic_ledger', { mission_id: missionId, entry_type: 'claim' }, trusted);
    const staleId = (txt(first).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/) ?? [])[1];
    expect(staleId).toBeTruthy();

    await handleCognitiveTool('submit_state_delta', {
      mission_id: missionId, base_mission_version: 2, delta_type: 'CLAIM_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'c2' }],
      rationale: 'corrected claim',
      ledger_entries: [{
        entry_type: 'claim', status: 'accepted', statement: 'The gate is open.',
        confidence: 0.9, supersedes: staleId,
      }],
    }, trusted);

    // The target must no longer be readable as current...
    const stillAccepted = await handleCognitiveTool('query_epistemic_ledger', { mission_id: missionId, status: 'accepted' }, trusted);
    expect(txt(stillAccepted)).toContain('The gate is open.');
    expect(txt(stillAccepted)).not.toContain('The gate is closed.');

    // ...and must be readable as superseded, with its content intact.
    const superseded = await handleCognitiveTool('query_epistemic_ledger', { mission_id: missionId, status: 'superseded' }, trusted);
    expect(txt(superseded)).toContain('The gate is closed.');
  });

  it('query_epistemic_ledger matches on any subset of filters, and still reports a true miss', async () => {
    const created = await handleCognitiveTool('create_mission_v2', {
      title: 'Ledger read-path regression', success_criteria: ['entries readable'],
    }, trusted);
    const missionId = (txt(created).match(/`(ms_[^`]+)`/) ?? [])[1];
    await handleCognitiveTool('submit_state_delta', {
      mission_id: missionId, base_mission_version: 1, delta_type: 'CLAIM_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'c1' }],
      rationale: 'regression fixture',
      ledger_entries: [{ entry_type: 'claim', statement: 'Regression fixture claim.', confidence: 0.7 }],
    }, trusted);

    // No optional filter at all: the natural call, and the one that used to
    // return "No ledger entries match." against a populated ledger.
    const none = await handleCognitiveTool('query_epistemic_ledger', { mission_id: missionId }, trusted);
    expect(txt(none)).toContain('Regression fixture claim.');

    // Each optional filter supplied alone must also work.
    const byType = await handleCognitiveTool('query_epistemic_ledger', { mission_id: missionId, entry_type: 'claim' }, trusted);
    expect(txt(byType)).toContain('Regression fixture claim.');

    const byStatus = await handleCognitiveTool('query_epistemic_ledger', { mission_id: missionId, status: 'accepted' }, trusted);
    expect(txt(byStatus)).toContain('Regression fixture claim.');

    // And a filter that genuinely matches nothing must still say so. Without
    // this, a fix that simply ignored every filter would pass the checks above.
    const miss = await handleCognitiveTool('query_epistemic_ledger', { mission_id: missionId, entry_type: 'decision' }, trusted);
    expect(txt(miss)).toContain('No ledger entries match.');
  });

  it('caps untrusted callers at authority class B and pins ownership to the caller', async () => {
    const created = await handleCognitiveTool('create_mission_v2', {
      title: 'Agent-owned mission',
      owner_id: 'someone_else',
      success_criteria: ['x'],
      authority_class: 'A',
    }, untrusted);
    const missionId = (txt(created).match(/`(ms_[^`]+)`/) ?? [])[1];
    const state = await handleCognitiveTool('get_mission_state', { mission_id: missionId }, trusted);
    const payload = JSON.parse(txt(state).split('```json\n')[1].split('\n```')[0]);
    expect(payload.authority_class).toBe('B'); // class A capped
    expect(payload.owner_id).toBe('client-agent'); // ownership pinned to caller
  });

  it('denies reads for a caller who is not the owner and not trusted', async () => {
    const created = await handleCognitiveTool('create_mission_v2', { title: 'Private mission', success_criteria: ['x'] }, untrusted);
    const missionId = (txt(created).match(/`(ms_[^`]+)`/) ?? [])[1];
    const denied = await handleCognitiveTool('get_mission_state', { mission_id: missionId }, { user_id: 'other-agent', trusted: false });
    expect(txt(denied)).toContain('Not authorized');
  });

  it('resume_mission reconstructs version/owner/changes/uncertainties/next-action from state only', async () => {
    // create with two objectives, o2 depends on o1
    const created = await handleCognitiveTool('create_mission_v2', {
      title: 'Continuity proving ground',
      success_criteria: ['continuity proven'],
      objectives: [
        { id: 'o1', description: 'Establish baseline facts', status: 'pending', owner_id: 'agent-a' },
        { id: 'o2', description: 'Build on the baseline', status: 'pending', owner_id: 'agent-a', dependency_ids: ['o1'] },
      ],
    }, trusted);
    const missionId = (txt(created).match(/`(ms_[^`]+)`/) ?? [])[1];
    // delta 1 (claim) -> v2, then checkpoint
    await handleCognitiveTool('submit_state_delta', {
      mission_id: missionId, base_mission_version: 1, delta_type: 'CLAIM_ADDED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'c1' }],
      rationale: 'baseline claim', ledger_entries: [{ entry_type: 'claim', statement: 'Egress is throttled per-IP.', confidence: 0.9 }],
    }, trusted);
    await handleCognitiveTool('checkpoint_mission', { mission_id: missionId }, trusted);
    // delta 2 after checkpoint: open an uncertainty -> v3
    await handleCognitiveTool('submit_state_delta', {
      mission_id: missionId, base_mission_version: 2, delta_type: 'UNCERTAINTY_OPENED',
      operations: [{ op: 'add', path: '/ledger_refs/-', value: 'u1' }],
      rationale: 'which egress is clean?', ledger_entries: [{ entry_type: 'uncertainty', status: 'active', statement: 'Whether audio downloads are throttled.', confidence: 0.5 }],
    }, trusted);
    const resume = await handleCognitiveTool('resume_mission', { mission_id: missionId }, trusted);
    const r = txt(resume);
    expect(r).toContain('v3');
    expect(r).toContain('Owner:');
    expect(r).toContain('agent-a');
    expect(r).toContain('Checkpoint:');
    expect(r).toContain('Changed since checkpoint:');
    expect(r).toContain('1 accepted delta');
    expect(r).toContain('UNCERTAINTY_OPENED');
    expect(r).toContain('audio downloads are throttled');
    expect(r).toContain('[objective] o1');
    expect(r).toContain('NO conversation history');
    // complete o1 -> next action must advance to o2 (dependency-aware)
    await handleCognitiveTool('submit_state_delta', {
      mission_id: missionId, base_mission_version: 3, delta_type: 'OBJECTIVE_COMPLETED',
      operations: [{ op: 'replace', path: '/objectives/o1/status', value: 'completed' }],
      rationale: 'baseline established',
    }, trusted);
    const resume2 = await handleCognitiveTool('resume_mission', { mission_id: missionId }, trusted);
    expect(txt(resume2)).toContain('[objective] o2');
  });
});

describe('dispatch gate (contract #5 fix)', () => {
  it('flag off: dispatch throws the plain unknown-tool error', async () => {
    const prev = process.env.COGNITIVE_CONTROL_ENABLED;
    process.env.COGNITIVE_CONTROL_ENABLED = 'off';
    await expect(
      dispatchCognitiveTool('get_mission_state', { mission_id: 'any' }, trusted),
    ).rejects.toThrow('Unknown tool: get_mission_state');
    process.env.COGNITIVE_CONTROL_ENABLED = prev;
  });
  it('flag write: dispatch reaches the handler normally', async () => {
    const res = await dispatchCognitiveTool('get_mission_state', { mission_id: 'nope' }, trusted);
    expect(txt(res)).toContain('Mission state not found');
  });
});

describe('feature gate', () => {
  it('refuses tools when COGNITIVE_CONTROL_ENABLED=off', async () => {
    const prev = process.env.COGNITIVE_CONTROL_ENABLED;
    process.env.COGNITIVE_CONTROL_ENABLED = 'off';
    const res = await handleCognitiveTool('get_mission_state', { mission_id: 'any' }, trusted);
    process.env.COGNITIVE_CONTROL_ENABLED = prev;
    expect(txt(res)).toContain('disabled');
  });
});
