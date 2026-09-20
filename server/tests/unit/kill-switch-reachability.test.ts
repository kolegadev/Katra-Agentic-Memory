/**
 * Unit test — the kill switch makes scheduler/uncertainty tools UNREACHABLE
 * through the live dispatch path.
 *
 * This closes the one item the go-live left explicitly inconclusive: proving a
 * scheduler tool is unreachable *through the handler* failed on a standalone
 * import ("Database not connected"), so it was recorded as neither a pass nor a
 * failure. The property is provable without touching production: the dispatchers
 * throw `Unknown tool: <name>` while the switch is set, which is
 * indistinguishable from the tool not existing.
 *
 * Note which guard fires for WHICH family, because they differ by design:
 *   - scheduler + uncertainty tools: the DISPATCHER throws `Unknown tool`
 *     (indistinguishable from feature-absent — the §4.19 property).
 *   - other cognitive tools: the handler returns a distinctive
 *     "Cognitive control plane disabled" message (a known residual, documented).
 *
 * The final case is the one that makes this a real test: it proves the throw is
 * caused by the switch, not by a misspelled tool name.
 *
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

// CRITICAL for this file's validity. The dispatchers are gated on TWO flags:
//   if (cognitiveControlMode() === 'off' || schedulerMode() === 'off') throw Unknown tool
// With COGNITIVE_CONTROL_ENABLED unset (defaults to 'off') these tests would pass
// for the WRONG reason - the plane being off, not the kill switch. Turning it on
// leaves the kill switch as the only thing that can produce the throw, which is
// what makes the final control case meaningful.
beforeAll(() => { process.env.COGNITIVE_CONTROL_ENABLED = 'write'; });

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';

const FAKE_DB = new FakeDb();

import { dispatchSchedulerTool, dispatchUncertaintyTool } from '../../src/services/mission-cognition/mcp-tools.js';
import { schedulerMode, killSwitchActive } from '../../src/services/mission-cognition/scheduler-mode.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const TRUSTED = { user_id: 'operator', trusted: true } as CallerIdentity;

const SCHEDULER_TOOLS = [
  'create_cognitive_work_item',
  'get_cognitive_queue',
  'explain_scheduler_decision',
  'get_scheduler_recommendation',
];

const UNCERTAINTY_TOOLS = [
  'list_uncertainties',
  'evaluate_triggers',
  'get_hypothesis_diversity',
  'get_trigger_report',
];

const env = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
};

afterEach(() => {
  delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
  env('COGNITIVE_SCHEDULER_MODE', 'shadow');
});

describe('kill switch makes the scheduler surface unreachable', () => {
  it('forces off even when the env asks for the HIGHEST mode', () => {
    env('COGNITIVE_SCHEDULER_MODE', 'allocate_internal');
    expect(schedulerMode()).toBe('allocate_internal'); // baseline: the env alone reaches it
    env('COGNITIVE_ACTIVATION_KILL_SWITCH', '1');
    expect(killSwitchActive()).toBe(true);
    expect(schedulerMode()).toBe('off');
  });

  it('every scheduler tool throws Unknown tool — indistinguishable from not existing', async () => {
    env('COGNITIVE_SCHEDULER_MODE', 'allocate_internal');
    env('COGNITIVE_ACTIVATION_KILL_SWITCH', '1');

    for (const name of SCHEDULER_TOOLS) {
      await expect(
        dispatchSchedulerTool(name, { mission_id: 'm1' }, TRUSTED),
        `${name} must be unreachable`,
      ).rejects.toThrow(`Unknown tool: ${name}`);
    }
  });

  it('every uncertainty tool throws Unknown tool', async () => {
    env('COGNITIVE_SCHEDULER_MODE', 'shadow');
    env('COGNITIVE_ACTIVATION_KILL_SWITCH', '1');

    for (const name of UNCERTAINTY_TOOLS) {
      await expect(
        dispatchUncertaintyTool(name, { mission_id: 'm1' }, TRUSTED),
        `${name} must be unreachable`,
      ).rejects.toThrow(`Unknown tool: ${name}`);
    }
  });

  it('THE CONTROL: with the switch cleared the throw goes away, so the gate is the switch and not a typo', async () => {
    env('COGNITIVE_SCHEDULER_MODE', 'shadow');

    // While set: unreachable.
    env('COGNITIVE_ACTIVATION_KILL_SWITCH', '1');
    await expect(dispatchSchedulerTool('get_cognitive_queue', {}, TRUSTED)).rejects.toThrow(/Unknown tool/);

    // Cleared: the same call no longer throws Unknown tool. It may return any
    // other result (an empty queue, a not-found), but it is genuinely dispatched.
    // (COGNITIVE_CONTROL_ENABLED=write is set in beforeAll, so the plane itself
    // is ON here - the only remaining gate is the kill switch.)
    env('COGNITIVE_ACTIVATION_KILL_SWITCH', undefined);
    let threw: unknown = null;
    try {
      await dispatchSchedulerTool('get_cognitive_queue', {}, TRUSTED);
    } catch (e) {
      threw = e;
    }
    expect(String(threw ?? '')).not.toMatch(/Unknown tool/);
  });

  it('the kill switch is read at CALL time, not cached at boot', () => {
    env('COGNITIVE_SCHEDULER_MODE', 'shadow');
    env('COGNITIVE_ACTIVATION_KILL_SWITCH', undefined);
    expect(schedulerMode()).toBe('shadow');
    env('COGNITIVE_ACTIVATION_KILL_SWITCH', '1');
    expect(schedulerMode()).toBe('off'); // same process, no restart
    env('COGNITIVE_ACTIVATION_KILL_SWITCH', undefined);
    expect(schedulerMode()).toBe('shadow'); // and back
  });
});
