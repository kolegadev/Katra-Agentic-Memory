/**
 * Unit tests — create_mission_v2's `constraints` input must be usable.
 *
 * Regression cover for a declared-but-unusable parameter. create_mission_v2
 * accepted constraints as a RECORD (z.record(string, string[])) and passed it
 * straight through to createMissionState, which validates against
 * mission-state.schema.json — whose $defs/constraint requires an ARRAY of
 * {id, kind, description}. So there was NO value that worked:
 *
 *     a record -> zod passes, schema rejects "/constraints must be array"
 *     an array -> zod rejects
 *
 * Found by trying to USE the parameter on a real task (a CFSI market-sizing
 * mission), not by reading the code — the same class as OBJECTIVE_CREATED:
 * something declared that cannot actually function.
 *
 * This file pins the alignment: the MCP input shape and the stored schema must
 * describe the same constraint, and a mission created with constraints must
 * actually persist them.
 *
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, vi } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';
process.env.COGNITIVE_CONTROL_ENABLED = 'write';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';

const FAKE_DB = new FakeDb();

import { handleCognitiveTool, COGNITIVE_TOOL_DEFS } from '../../src/services/mission-cognition/mcp-tools.js';
import { validateAgainst, SCHEMA_IDS } from '../../src/services/mission-cognition/schema-registry.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';
import type { MissionState } from '../../src/types/cognitive-control.js';

const TRUSTED = { user_id: 'operator', trusted: true } as CallerIdentity;

const CONSTRAINT = { id: 'c-withdrawn', kind: 'legal' as const, description: 'Withdrawn v1 figures must not be re-quoted.' };

describe('create_mission_v2 constraints are usable', () => {
  it('the declared input shape is an ARRAY of {id, kind, description} — matching the stored schema', () => {
    const def = COGNITIVE_TOOL_DEFS.find(t => t.name === 'create_mission_v2')!;
    const props = (def.inputSchema as any).properties ?? {};
    const c = props.constraints;
    expect(c, 'constraints must be declared').toBeTruthy();
    // must be an array, not a record/object — the defect was exactly this
    expect(c.type, 'constraints must be an ARRAY to match mission-state.schema.json').toBe('array');
    expect(c.items?.properties?.id).toBeTruthy();
    expect(c.items?.properties?.kind).toBeTruthy();
    expect(c.items?.properties?.description).toBeTruthy();
    expect(c.items?.properties?.kind?.enum).toContain('legal');
  });

  it('a mission created WITH constraints persists them (the case that used to throw)', async () => {
    FAKE_DB.reset();
    const out = await handleCognitiveTool('create_mission_v2', {
      title: 'constraints regression',
      intent: 'prove constraints survive creation',
      owner_id: 'operator',
      success_criteria: [{ id: 'A1', description: 'something', status: 'unmet' }],
      constraints: [CONSTRAINT],
    }, TRUSTED);

    const text = out.map((c: any) => c.text ?? '').join('');
    const mid = (text.match(/ms_\d+_[a-z0-9]+/) || [])[0];
    expect(mid, `mission id not returned: ${text.slice(0, 200)}`).toBeTruthy();

    const state = (await handleCognitiveTool('get_mission_state', { mission_id: mid }, TRUSTED))
      .map((c: any) => c.text ?? '').join('');
    const m = state.match(/```json\n([\s\S]*?)\n```/);
    expect(m, 'mission state not readable').toBeTruthy();
    const parsed = JSON.parse(m![1]) as MissionState;

    expect(parsed.constraints).toBeTruthy();
    expect(Array.isArray(parsed.constraints)).toBe(true);
    expect(parsed.constraints![0]).toMatchObject({ id: 'c-withdrawn', kind: 'legal' });
  });

  it('and the persisted mission still validates against the stored schema', async () => {
    FAKE_DB.reset();
    const out = await handleCognitiveTool('create_mission_v2', {
      title: 'schema conformance',
      owner_id: 'operator',
      success_criteria: [{ id: 'A1', description: 'x', status: 'unmet' }],
      constraints: [CONSTRAINT, { id: 'c-sourcing', kind: 'technical', description: 'Report-first sourcing order.' }],
    }, TRUSTED);
    const mid = (out.map((c: any) => c.text ?? '').join('').match(/ms_\d+_[a-z0-9]+/) || [])[0];
    expect(mid).toBeTruthy();

    const state = (await handleCognitiveTool('get_mission_state', { mission_id: mid }, TRUSTED))
      .map((c: any) => c.text ?? '').join('');
    const parsed = JSON.parse(state.match(/```json\n([\s\S]*?)\n```/)![1]);

    const check = validateAgainst(SCHEMA_IDS.missionState, parsed);
    expect(check.valid, `mission state failed its own schema: ${(check.errors || []).join('; ')}`).toBe(true);
    expect(parsed.constraints).toHaveLength(2);
  });

  it('a bogus constraint kind is REFUSED and nothing is persisted', async () => {
    FAKE_DB.reset();
    // In-process the input parse throws rather than returning a message; over the
    // live MCP path the server converts that to a returned error. Either way the
    // property that matters is the same: refused, and no mission written.
    let threw = false;
    try {
      await handleCognitiveTool('create_mission_v2', {
        title: 'bad kind',
        owner_id: 'operator',
        success_criteria: [{ id: 'A1', description: 'x', status: 'unmet' }],
        constraints: [{ id: 'c1', kind: 'not-a-kind', description: 'nope' }],
      }, TRUSTED);
    } catch {
      threw = true;
    }
    expect(threw, 'a bogus kind must be refused').toBe(true);

    const stored = FAKE_DB.collection('mission_states').docs as any[];
    expect(stored.filter(d => d.title === 'bad kind')).toHaveLength(0);
  });
});
