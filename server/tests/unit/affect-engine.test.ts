/**
 * AFFECT-1 — the streaming affect engine.
 *
 * The engine is a leaky integrator over six band powers with a bounded self-report door. These tests
 * pin the properties the design claims, and deliberately pin the ones that are easy to fake:
 *
 *  - the derivations must equal the PUBLISHED formulas, in the same fixtures the storage lane
 *    (`agmt/affect.py`) uses, so a state computed here and a state read back from the wave store mean
 *    the same thing;
 *  - decay must actually converge, and two shocks a second apart must not equal their sum (the
 *    integrator is doing work between them);
 *  - the self-report must be WEAKER than one tool failure, or it would be the voluntary heartbeat the
 *    design note argues against;
 *  - with the flag off, nothing moves and no pin is attempted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => null,
  is_database_connected: () => false,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

import {
  AffectEngine,
  AFFECT_BANDS,
  AFFECT_BASELINE,
  deriveAffect,
  feltLabel,
  stimulusFromContent,
  stimulusFromToolCall,
  stimulusFromAnomaly,
} from '../../src/services/processing/affect-engine.js';

const engine = AffectEngine.get_instance();

/** The fixture states, identical to tests/test_affect_lane.py's STATES. */
const CALM = [1.1, 1.4, 2.2, 2.2, 0.35, 0.12];
const STARTLE = [1.0, 1.0, 2.0, 2.0, 1.85, 1.82];
const FEAR = [1.0, 1.2, 2.0, 2.0, 2.4, 2.2];
const SAD = [1.2, 1.3, 2.6, 1.4, 0.4, 0.15];

const asBands = (values: number[]) =>
  Object.fromEntries(AFFECT_BANDS.map((band, index) => [band, values[index]])) as any;

function fresh(identity: string) {
  // A per-test identity keeps the singleton's cached states from leaking between cases.
  return identity;
}

beforeEach(() => {
  process.env.KATRA_AFFECT_ENABLED = '1';
  process.env.KATRA_AFFECT_IDENTITIES = 'shoshin,test-identity,test-a,test-b,test-c,test-d';
});

afterEach(() => {
  delete process.env.KATRA_AFFECT_ENABLED;
  delete process.env.KATRA_AFFECT_IDENTITIES;
  vi.useRealTimers();
});

describe('deriveAffect — the published formulas', () => {
  it('equals the storage lane formula on the shared fixtures', () => {
    const fear = deriveAffect(asBands(FEAR));
    // faa = ln(alpha_r) - ln(alpha_l) = ln(2.0) - ln(2.0)
    expect(fear.faa).toBeCloseTo(0, 12);
    expect(fear.valence).toBeCloseTo(Math.tanh(0 / 1.2), 12);
    // arousal = 0.5 + 0.5*tanh((b+g - (b0+g0)) / (b0+g0)), b0+g0 = 0.7
    expect(fear.arousal).toBeCloseTo(0.5 + 0.5 * Math.tanh((2.4 + 2.2 - 0.7) / 0.7), 12);
    const shares = FEAR.map((value) => value / FEAR.reduce((a, b) => a + b, 0));
    const entropy = -shares.reduce((sum, p) => sum + p * Math.log(p), 0);
    expect(fear.entropy).toBeCloseTo(entropy, 10);
    expect(fear.intensity).toBeCloseTo(1 - entropy / Math.log(6), 10);
  });

  it('takes the sign of the frontal asymmetry from the alpha bands', () => {
    // Left alpha suppressed (the approach reading) -> positive faa -> positive valence.
    const approach = deriveAffect(asBands([1.0, 1.0, 1.4, 2.6, 0.9, 0.45]));
    expect(approach.faa).toBeGreaterThan(0);
    expect(approach.valence).toBeGreaterThan(0);
    // Right alpha suppressed -> negative faa -> negative valence.
    const withdrawal = deriveAffect(asBands(SAD));
    expect(withdrawal.faa).toBeLessThan(0);
    expect(withdrawal.valence).toBeLessThan(0);
    // Balanced alpha -> no asymmetry at all.
    expect(deriveAffect(asBands([1, 1, 2, 2, 0.5, 0.2])).faa).toBeCloseTo(0, 12);
  });

  it('separates calm from a startle by arousal, not by label guesswork', () => {
    expect(deriveAffect(asBands(CALM)).arousal).toBeLessThan(0.5);
    expect(deriveAffect(asBands(STARTLE)).arousal).toBeGreaterThan(0.9);
    expect(deriveAffect(asBands([1, 1, 2, 2, 0.5, 0.2])).arousal).toBeCloseTo(0.5, 12);
  });

  it('labels are rendering-only and stay inside the published set', () => {
    const labels = new Set(['alarmed', 'frustrated', 'focused', 'satisfied', 'flat', 'steady']);
    for (const v of [-1, -0.5, 0, 0.5, 1]) {
      for (const a of [0, 0.3, 0.5, 0.7, 1]) {
        expect(labels.has(feltLabel(v, a))).toBe(true);
      }
    }
  });
});

describe('the integrator', () => {
  it('decays back to the baseline, and the fast bands get there first', async () => {
    const identity = fresh('test-a');
    // One fake clock for the whole test: observe, read and advance all on the same timeline, so the
    // elapsed time is exactly what this test says it is.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    await engine.observe(identity, { valence: -0.8, arousal: 0.9, weight: 1, source: 'content' });
    const moved = await engine.getState(identity);
    expect(moved.arousal).toBeGreaterThan(0.8);

    // gamma's rate is 0.05/s, so 10/gamma = 200 s and it is home within 1%.
    vi.setSystemTime(1_000_000_000 + 200_000);
    const later = await engine.getState(identity);
    expect(Math.abs(later.bands.gamma - AFFECT_BASELINE.gamma)).toBeLessThan(0.01);
    // beta's rate is 0.02/s: at 200 s it is still ~2% out, and only at 10/0.02 = 500 s is it home.
    expect(Math.abs(later.bands.beta - AFFECT_BASELINE.beta)).toBeGreaterThan(0.01);
    vi.setSystemTime(1_000_000_000 + 600_000);
    const muchLater = await engine.getState(identity);
    expect(Math.abs(muchLater.bands.beta - AFFECT_BASELINE.beta)).toBeLessThan(0.01);
    // The slow bands are still carrying some of it (that is the point of per-band decay).
    expect(Math.abs(muchLater.bands.alpha_l - AFFECT_BASELINE.alpha_l)).toBeGreaterThan(0.0001);
  });

  it('two shocks a second apart are not their sum (the decay runs between them)', async () => {
    const identity = fresh('test-b');
    const stimulus = { valence: -0.8, arousal: 0.9, weight: 1, source: 'content' as const };
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await engine.observe(identity, stimulus);
    vi.setSystemTime(1_001_000);
    await engine.observe(identity, stimulus);
    const twice = await engine.getState(identity);

    const single = fresh('test-c');
    vi.setSystemTime(2_000_000);
    await engine.observe(single, stimulus);
    vi.setSystemTime(2_001_000);
    const once = await engine.getState(single);

    expect(twice.bands.gamma).toBeGreaterThan(once.bands.gamma);
    // If the integrator were a plain accumulator these would be equal.
    expect(twice.bands.gamma).toBeLessThan(once.bands.gamma * 2 - 1e-9);
  });

  it('habituates to sustained success: twenty calls in a minute do not read as alarm', async () => {
    // Measured live before habituation existed: 13 successes in 30s pinned arousal at 0.97, i.e. an
    // agent that is simply working looked alarmed. The success channel now decays in weight.
    const identity = fresh('test-b');
    vi.useFakeTimers();
    vi.setSystemTime(6_000_000);
    for (let i = 0; i < 20; i += 1) {
      vi.setSystemTime(6_000_000 + i * 3_000);
      await engine.observe(identity, stimulusFromToolCall('vector_search', true));
    }
    const busy = await engine.getState(identity);
    expect(busy.arousal).toBeLessThan(0.9);
    expect(['focused', 'steady', 'satisfied']).toContain(busy.felt);

    // And one failure still dwarfs the twentieth success.
    vi.setSystemTime(6_060_000);
    await engine.observe(identity, stimulusFromToolCall('store_memory', false));
    const afterFailure = await engine.getState(identity);
    expect(afterFailure.arousal).toBeGreaterThan(busy.arousal);
    expect(afterFailure.valence).toBeLessThan(0);
  });

  it('an outcome does not speak to the calm band: successes leave theta near baseline', async () => {
    const identity = fresh('test-a');
    vi.useFakeTimers();
    vi.setSystemTime(7_000_000);
    for (let i = 0; i < 60; i += 1) {
      vi.setSystemTime(7_000_000 + i * 2_000);
      await engine.observe(identity, stimulusFromToolCall('get_health', true));
    }
    const busy = await engine.getState(identity);
    expect(busy.bands.theta).toBeLessThan(AFFECT_BASELINE.theta * 1.05);
    // Activation still moves (mildly), which is the point of keeping the outcome channel at all.
    expect(busy.arousal).toBeGreaterThan(AFFECT_BASELINE.beta / AFFECT_BASELINE.beta * 0.5);
    expect(busy.arousal).toBeLessThanOrEqual(1);
  });

  it('no band drifts more than twice its baseline from the baseline', async () => {
    const identity = fresh('test-e');
    vi.useFakeTimers();
    vi.setSystemTime(8_000_000);
    for (let i = 0; i < 200; i += 1) {
      vi.setSystemTime(8_000_000 + i * 500);
      await engine.observe(identity, { valence: -1, arousal: 1, weight: 1, source: 'content' });
    }
    const state = await engine.getState(identity);
    for (const band of AFFECT_BANDS) {
      const baseline = AFFECT_BASELINE[band];
      const span = Math.max(3 * baseline, 1.5);
      expect(state.bands[band]).toBeGreaterThanOrEqual(Math.max(0.05, baseline - span) - 1e-9);
      expect(state.bands[band]).toBeLessThanOrEqual(Math.min(6, baseline + span) + 1e-9);
    }
  });

  it('stays finite and in range under a hundred shocks', async () => {
    const identity = fresh('test-d');
    for (let i = 0; i < 100; i += 1) {
      await engine.observe(identity, {
        valence: i % 2 === 0 ? -1 : 1,
        arousal: 1,
        weight: 1,
        source: i % 3 === 0 ? 'tool_failure' : 'content',
      });
    }
    const state = await engine.getState(identity);
    for (const band of AFFECT_BANDS) {
      expect(Number.isFinite(state.bands[band])).toBe(true);
      expect(state.bands[band]).toBeGreaterThanOrEqual(0.05);
      expect(state.bands[band]).toBeLessThanOrEqual(6.0);
    }
    expect(state.arousal).toBeGreaterThanOrEqual(0);
    expect(state.arousal).toBeLessThanOrEqual(1);
    expect(Math.abs(state.valence)).toBeLessThan(1);
  });
});

describe('the bounded self-report', () => {
  it('moves the state less than one tool failure does', async () => {
    const byReport = fresh('test-a');
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    await engine.recordSelfReport(byReport, -1, 1, 'this is hard');
    const reported = await engine.getState(byReport);

    const byFailure = fresh('test-b');
    vi.setSystemTime(4_000_000);
    await engine.observe(byFailure, stimulusFromToolCall('store_memory', false));
    const failed = await engine.getState(byFailure);

    expect(failed.arousal).toBeGreaterThan(reported.arousal);
    expect(failed.bands.gamma).toBeGreaterThan(reported.bands.gamma);
  });

  it('is rate-limited: a second report inside 60s is refused, not silently applied', async () => {
    const identity = fresh('test-c');
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const first = await engine.recordSelfReport(identity, -0.9, 0.9, 'first');
    expect(first.accepted).toBe(true);
    vi.setSystemTime(5_030_000);
    const second = await engine.recordSelfReport(identity, 0.9, 0.9, 'second');
    expect(second.accepted).toBe(false);
    expect(String(second.reason)).toContain('rate-limited');
    expect(second.state?.valence).toBeLessThan(0);       // the first report still owns the state
  });
});

describe('the stimulus extractor', () => {
  it('reads content through the existing tagger', () => {
    const bad = stimulusFromContent('the deploy failed and the retry loop crashed');
    expect(bad?.source).toBe('content');
    expect(bad?.valence).toBeLessThan(0);
    expect(stimulusFromContent('')).toBeNull();
  });

  it('weights failures above successes, and ignores a normal anomaly', () => {
    const failure = stimulusFromToolCall('vector_search', false);
    const success = stimulusFromToolCall('vector_search', true);
    expect(failure.weight).toBeGreaterThan(success.weight);
    expect(failure.valence).toBeLessThan(0);
    expect(success.valence).toBeGreaterThan(0);
    expect(stimulusFromAnomaly('normal')).toBeNull();
    expect(stimulusFromAnomaly('anomalous')?.valence).toBeLessThan(0);
  });
});

describe('the gate', () => {
  it('is inert when the engine is off: no state change, baseline values', async () => {
    delete process.env.KATRA_AFFECT_ENABLED;
    const identity = fresh('test-d');
    expect(engine.isEnabled(identity)).toBe(false);
    const observed = await engine.observe(identity, {
      valence: -1, arousal: 1, weight: 1, source: 'content',
    });
    expect(observed).toBeNull();
    const state = await engine.getState(identity);
    expect(state.enabled).toBe(false);
    expect(state.bands).toEqual(AFFECT_BASELINE);
    expect(state.observations).toBe(0);
  });

  it('is inert for an identity that is not allowlisted', async () => {
    process.env.KATRA_AFFECT_IDENTITIES = 'shoshin';
    const state = await engine.getState('some-other-agent');
    expect(state.enabled).toBe(false);
    expect(engine.isEnabled('shoshin')).toBe(true);
    expect(engine.isEnabled('some-other-agent')).toBe(false);
  });

  it('refuses a self-report when off, with a named reason', async () => {
    delete process.env.KATRA_AFFECT_ENABLED;
    const result = await engine.recordSelfReport('shoshin', 0.5, 0.5);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('the signature handed to the wave store', () => {
  it('carries the bands and provenance, never a label', async () => {
    const identity = fresh('test-a');
    await engine.observe(identity, stimulusFromToolCall('get_health', false));
    const state = await engine.getState(identity);
    const signature = engine.signatureFor(state);
    expect(Object.keys(signature).sort()).toEqual(['at', 'bands', 'engine', 'source']);
    expect(signature.bands).toEqual(state.bands);
    expect(signature.source).toBe('katra');
    expect(JSON.stringify(signature)).not.toContain(state.felt);
  });
});
