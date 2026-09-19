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
import { handleCognitiveTool, COGNITIVE_TOOL_DEFS } from '../../src/services/mission-cognition/mcp-tools.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const FAKE_DB = new FakeDb();
const trusted: CallerIdentity = { user_id: 'satori', trusted: true };
const untrusted: CallerIdentity = { user_id: 'client-agent', trusted: false };

function txt(result: { type: string; text: string }[]): string {
  return result.map(r => r.text).join('\n');
}

afterEach(() => FAKE_DB.reset());

describe('cognitive control MCP surface (COGNITIVE_CONTROL_ENABLED=write)', () => {
  it('registers the nine Phase 1-2 tools', () => {
    const names = COGNITIVE_TOOL_DEFS.map(t => t.name);
    expect(names).toEqual([
      'create_mission_v2', 'get_mission_state', 'submit_state_delta', 'list_state_deltas',
      'query_epistemic_ledger', 'compile_cognitive_baton', 'get_cognitive_baton',
      'checkpoint_mission', 'resume_mission',
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
