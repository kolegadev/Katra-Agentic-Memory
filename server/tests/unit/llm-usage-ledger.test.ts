/**
 * LLM usage ledger tests — §2 option (a) real measurement, mirroring
 * kolega-code ledger.py semantics: exactly-once settlement, snapshot deltas,
 * AsyncLocalStorage origin attribution, tokens as the unit.
 * Part of the no-publish branch feat/cognitive-control-local.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => FAKE_DB,
  is_database_connected: () => true,
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import {
  beginUsageCall,
  recordUsageResponse,
  recordUsageFailure,
  usageSnapshot,
  usageDeltaSince,
  runWithUsageOrigin,
  currentUsageOrigin,
  extractUsage,
  measuredTokensForScope,
} from '../../src/services/infrastructure/llm-usage-ledger.js';
import { measureCognitiveCost, COST_BASIS, COST_BASIS_ZERO, COST_FLOOR } from '../../src/services/mission-cognition/cost-model.js';

const FAKE_DB = new FakeDb();
const db = FAKE_DB.asDb();

describe('exactly-once settlement', () => {
  it('first settle wins; later settles no-op', async () => {
    const id = beginUsageCall('deepseek', 'm');
    recordUsageResponse(id, { input_tokens: 100, output_tokens: 50 });
    recordUsageResponse(id, { input_tokens: 1, output_tokens: 1 }); // ignored
    const s = usageSnapshot();
    expect(s.responses).toBe(1);
    expect(s.input_tokens).toBe(100);
    expect(s.output_tokens).toBe(50);
    expect(s.complete).toBe(true);
  });
  it('failures settle as failed and never raise', () => {
    const id = beginUsageCall('deepseek', 'm');
    expect(() => recordUsageFailure(id, new Error('boom'))).not.toThrow();
    const s = usageSnapshot();
    expect(s.failed).toBe(1);
    expect(s.complete).toBe(true);
  });
  it('abandoned requests stay OPEN and mark the snapshot incomplete', () => {
    beginUsageCall('deepseek', 'm');
    const s = usageSnapshot();
    expect(s.open).toBe(1);
    expect(s.complete).toBe(false);
  });
});

describe('snapshot deltas', () => {
  it('open is the CURRENT count, not a difference; different run yields self', () => {
    const before = usageSnapshot();
    const id1 = beginUsageCall('deepseek', 'm');
    recordUsageResponse(id1, { input_tokens: 10, output_tokens: 2 });
    beginUsageCall('deepseek', 'm'); // still open at delta time
    const delta = usageDeltaSince(before);
    expect(delta.requests).toBe(2);
    expect(delta.responses).toBe(1);
    expect(delta.input_tokens).toBe(10);
    expect(delta.open).toBe(usageSnapshot().open); // CURRENT outstanding count, not a difference
    // different run_id: self, never negative
    const forged = { ...before, run_id: 'other' };
    const self = usageDeltaSince(forged);
    expect(self.run_id).toBe(usageSnapshot().run_id);
    expect(self.requests).toBe(usageSnapshot().requests);
  });
});

describe('origin attribution (AsyncLocalStorage)', () => {
  it('attributes current scope and restores after exit', async () => {
    expect(currentUsageOrigin()).toBeNull();
    await runWithUsageOrigin({ mission_id: 'm1' }, async () => {
      expect(currentUsageOrigin()?.mission_id).toBe('m1');
      const id = beginUsageCall('deepseek', 'm');
      recordUsageResponse(id, { input_tokens: 5, output_tokens: 1 });
      await runWithUsageOrigin({ mission_id: 'm2', work_item_id: 'w2' }, () => {
        expect(currentUsageOrigin()?.mission_id).toBe('m2'); // child shadows
      });
      expect(currentUsageOrigin()?.mission_id).toBe('m1'); // restored
    });
    expect(currentUsageOrigin()).toBeNull();
  });
  it('settled records carry the origin at settle time', async () => {
    FAKE_DB.reset();
    await runWithUsageOrigin({ mission_id: 'attributed', work_item_id: 'w1' }, async () => {
      const id = beginUsageCall('deepseek', 'm');
      recordUsageResponse(id, { input_tokens: 7, output_tokens: 3 });
      await new Promise(r => setTimeout(r, 20)); // let the fire-and-forget persist run
    });
    const rows = FAKE_DB.collection('llm_usage').docs;
    expect(rows).toHaveLength(1);
    expect(rows[0].mission_id).toBe('attributed');
    expect(rows[0].work_item_id).toBe('w1');
  });
});

describe('extractUsage across provider shapes', () => {
  it('normalizes openai-style, deepseek-style and raw payloads', () => {
    expect(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } }))
      .toMatchObject({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 });
    expect(extractUsage({ input_tokens: 5, output_tokens: 2, prompt_cache_hit_tokens: 1 }))
      .toMatchObject({ input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 });
    expect(extractUsage(undefined)).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });
});

describe('measured cost (scheduler §2 unit)', () => {
  it('cost = measured tokens when usage exists', async () => {
    FAKE_DB.reset();
    FAKE_DB.collection('llm_usage').docs.push(
      { mission_id: 'm1', work_item_id: null, input_tokens: 400, output_tokens: 100 },
      { mission_id: 'm1', work_item_id: 'w1', input_tokens: 50, output_tokens: 25 },
    );
    const all = await measureCognitiveCost(db, 'm1');
    expect(all.cost).toBe(575);
    expect(all.basis).toBe(COST_BASIS);
    const one = await measureCognitiveCost(db, 'm1', 'w1');
    expect(one.cost).toBe(75);
  });
  it('zero observed tokens -> floor with visible zero basis, never an invented band', async () => {
    FAKE_DB.reset();
    const z = await measureCognitiveCost(db, 'no-usage-mission');
    expect(z.cost).toBe(COST_FLOOR);
    expect(z.basis).toBe(COST_BASIS_ZERO);
  });
  it('measuredTokensForScope sums input+output', async () => {
    FAKE_DB.reset();
    FAKE_DB.collection('llm_usage').docs.push({ mission_id: 'm9', input_tokens: 10, output_tokens: 5 });
    expect(await measuredTokensForScope(db, 'm9')).toBe(15);
  });
});
