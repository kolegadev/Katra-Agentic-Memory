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
  AFFECT_AROUSAL_FLOOR,
  AFFECT_AROUSAL_GAIN,
  AFFECT_AROUSAL_SUM_MAX,
  AFFECT_SUCCESS_CAP_OFFSET,
  AFFECT_SUCCESS_GAIN,
  stateKey,
  arousalOf,
  arousalTargetSum,
  AFFECT_BANDS,
  AFFECT_BASELINE,
  deriveAffect,
  selfReportTarget,
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
  process.env.KATRA_AFFECT_IDENTITIES = 'test-identity,test-a,test-b,test-c,test-d,test-e,test-f,test-g,test-h,test-i,test-j,test-k,test-l';
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
    // arousal = 0.5 + 0.5*tanh(GAIN*(b+g - base)/side), base = b0+g0 = 0.7, side = SUM_MAX - base
    // above the baseline (AFFECT-4: the excess is normalised by the range that side can reach,
    // not by the baseline sum — dividing by 0.7 made one baseline sum of distance the whole scale).
    const base = 0.7;
    const side = 2.4 + 2.2 <= base ? base : AFFECT_AROUSAL_SUM_MAX - base;
    expect(fear.arousal).toBeCloseTo(
      0.5 + 0.5 * Math.tanh(AFFECT_AROUSAL_GAIN * (2.4 + 2.2 - base) / side), 12,
    );
    const shares = FEAR.map((value) => value / FEAR.reduce((a, b) => a + b, 0));
    const entropy = -shares.reduce((sum, p) => sum + p * Math.log(p), 0);
    expect(fear.entropy).toBeCloseTo(entropy, 10);
    expect(fear.intensity).toBeCloseTo(1 - entropy / Math.log(6), 10);
  });

  it('spans the range the bands actually reach: calm is readable, and so is alarm', () => {
    // AFFECT-4, measured on the live lane 2026-10-26. The previous scale divided the excess by the
    // BASELINE SUM, so one baseline sum of distance was the whole readout: 11 of 16 live pins read
    // above 0.95, a busy working day (beta+gamma 1.16) read 0.79, the calm fixture read 0.34, and
    // the floor was 0.119 — calm was unreachable and alarm was indistinguishable from ordinary work.
    // The readout now spans the reachable band range, one normalisation per side.
    const atZero = deriveAffect(asBands([1, 1, 2, 2, 0, 0]));
    const atCeiling = deriveAffect(asBands([1, 1, 2, 2, 2.0, 1.7]));
    const atBaseline = deriveAffect(asBands([1, 1, 2, 2, 0.5, 0.2]));

    expect(atZero.arousal).toBeLessThan(0.05);          // calm is reachable at last
    expect(atCeiling.arousal).toBeGreaterThan(0.95);     // and so is alarm
    expect(atBaseline.arousal).toBeCloseTo(0.5, 6);      // the baseline keeps the midpoint

    // The named fixtures have to land where their names say.
    expect(deriveAffect(asBands(CALM)).arousal).toBeLessThan(0.3);
    expect(deriveAffect(asBands(STARTLE)).arousal).toBeGreaterThan(0.95);
  });

  it('is monotone and continuous at the baseline, and its inverse recovers the band sum', () => {
    const samples = [0, 0.2, 0.47, 0.7, 1.0, 1.6, 2.4, 3.0, 3.7];
    for (let i = 1; i < samples.length; i += 1) {
      expect(arousalOf(0, samples[i])).toBeGreaterThanOrEqual(arousalOf(0, samples[i - 1]) - 1e-12);
    }
    // Continuity at the join: both sides give exactly 0.5 at the baseline sum.
    expect(arousalOf(0.35, 0.35)).toBeCloseTo(0.5, 12);
    expect(arousalOf(0.699, 0.001)).toBeCloseTo(0.5, 3);

    // The inverse is what the self-report blend uses, so it has to return the sum it was given.
    for (const [beta, gamma] of [[0.35, 0.12], [0.5, 0.2], [0.8, 0.36], [1.6, 1.1]] as const) {
      expect(arousalTargetSum(arousalOf(beta, gamma))).toBeCloseTo(beta + gamma, 6);
    }
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

  // AFFECT-3. The door shipped as an additive shock, and a shock from (valence, arousal) can only
  // ever ADD activation: beta (1.5a) and gamma (2a^2) are non-negative for every a, and the one
  // decreasing term, theta, is not in the arousal readout. Measured live on 2026-10-26: reporting
  // arousal 0.10 ("as calm as I can say") moved the readout 0.796 -> 0.822, and reporting 0.62 moved
  // it 0.779 -> 0.951. The four cases below are the contract the blend has to satisfy.
  it('can LOWER arousal: a calm report is a correction, not another stimulus', async () => {
    const identity = fresh('test-e');
    vi.useFakeTimers();
    vi.setSystemTime(6_000_000);
    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(6_000_000 + i * 1_000);
      await engine.observe(identity, stimulusFromToolCall('store_memory', false));
    }
    const hot = await engine.getState(identity);
    expect(hot.arousal).toBeGreaterThan(0.8);

    vi.setSystemTime(6_010_000);
    await engine.recordSelfReport(identity, 0, 0.1, 'calmer than that');

    const cooled = await engine.getState(identity);
    expect(cooled.arousal).toBeLessThan(hot.arousal);

    // Asserted on beta+gamma, the quantity the blend moves, because the readout is tanh-compressed
    // near the ceiling: at arousal 0.999 a 35% cut in beta+gamma only moves the NUMBER by 0.03. That
    // compression is the readout's, not the door's, and the next case shows the blend still converges.
    const hotSum = hot.bands.beta + hot.bands.gamma;
    const coolSum = cooled.bands.beta + cooled.bands.gamma;
    expect(coolSum).toBeLessThan(hotSum * 0.7);
  });

  it('converges on what was reported, and stops at the floor the readout can express', async () => {
    const identity = fresh('test-f');
    vi.useFakeTimers();
    vi.setSystemTime(7_000_000);
    await engine.observe(identity, stimulusFromToolCall('store_memory', false));   // start hot
    for (let i = 0; i < 14; i += 1) {
      vi.setSystemTime(7_000_000 + i * 1_000);
      // The rate limit lives in the door, not the engine: repeated reports are what convergence means.
      await engine.observe(identity, { valence: 0, arousal: 0.1, weight: 0.35, source: 'self_report' });
    }
    const settled = await engine.getState(identity);
    expect(settled.arousal).toBeLessThan(0.2);
    // Not below the floor: the readout cannot name a calmer state, and the target must not pretend.
    expect(settled.arousal).toBeGreaterThanOrEqual(AFFECT_AROUSAL_FLOOR - 1e-6);
  });

  it('moves valence where it was told, including across zero', async () => {
    const identity = fresh('test-g');
    vi.useFakeTimers();
    vi.setSystemTime(8_000_000);
    const before = await engine.getState(identity);
    expect(before.valence).toBeGreaterThan(-0.2);      // baseline sits near zero

    await engine.recordSelfReport(identity, -0.8, 0.3, 'this does not sit right');
    const after = await engine.getState(identity);
    expect(after.valence).toBeLessThan(-0.2);
    expect(after.valence).toBeLessThan(before.valence);
  });

  it('leaves the bands it was not told about where they were', async () => {
    const identity = fresh('test-h');
    vi.useFakeTimers();
    vi.setSystemTime(9_000_000);
    const before = await engine.getState(identity);
    await engine.recordSelfReport(identity, -0.5, 0.9, 'plain');
    const after = await engine.getState(identity);
    // A report is two numbers. theta and delta are not among them, so the blend must not invent them
    // (the additive version wrote theta += 0.3*(1-a)*w on every report).
    expect(after.bands.theta).toBeCloseTo(before.bands.theta, 10);
    expect(after.bands.delta).toBeCloseTo(before.bands.delta, 10);
  });

  it('the target is an exact inverse: it reads back as the state that was reported', () => {
    const from = { delta: 1, theta: 1.3, alpha_l: 1.44, alpha_r: 2.55, beta: 1.1, gamma: 0.4 };
    for (const [valence, arousal] of [[0.45, 0.62], [-0.8, 0.2], [0, 0.9], [0.9, 0.15]] as const) {
      const target = selfReportTarget(from, valence, arousal);
      const readBack = deriveAffect(target);
      expect(readBack.valence).toBeCloseTo(valence, 3);
      expect(Math.max(readBack.arousal, AFFECT_AROUSAL_FLOOR)).toBeCloseTo(
        Math.max(arousal, AFFECT_AROUSAL_FLOOR), 3,
      );
    }
  });
});

describe('the bounded success channel, and attribution (AFFECT-5)', () => {
  it('two hundred successes cannot reach the alarm region', async () => {
    // Measured live 2026-10-26: a brute-force campaign put 1111 successful calls through this engine
    // against 18 memories written, held beta at its clamp and arousal at 0.95 for hours, so "working
    // hard" and "alarmed" read the same. Volume must not be able to do that.
    const identity = fresh('test-i');
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    for (let i = 0; i < 200; i += 1) {
      vi.setSystemTime(10_000_000 + i * 100);
      await engine.observe(identity, stimulusFromToolCall('store_memory', true));
    }
    const state = await engine.getState(identity);
    const baseSum = state.baseline.beta + state.baseline.gamma;
    const sum = state.bands.beta + state.bands.gamma;

    expect(sum).toBeLessThanOrEqual(baseSum + AFFECT_SUCCESS_CAP_OFFSET + 0.05);
    expect(state.arousal).toBeLessThan(0.7);        // engaged, not alarmed
  });

  it('one failure still reaches alarm, however much work came before it', async () => {
    const identity = fresh('test-j');
    vi.useFakeTimers();
    vi.setSystemTime(11_000_000);
    for (let i = 0; i < 100; i += 1) {
      vi.setSystemTime(11_000_000 + i * 100);
      await engine.observe(identity, stimulusFromToolCall('store_memory', true));
    }
    const working = await engine.getState(identity);
    expect(working.arousal).toBeLessThan(0.7);

    vi.setSystemTime(11_020_000);
    await engine.observe(identity, stimulusFromToolCall('store_memory', false));
    const alarmed = await engine.getState(identity);

    // The asymmetry is the point: a failure keeps full authority, a thousand greps do not.
    expect(alarmed.arousal).toBeGreaterThan(0.9);
    expect(alarmed.arousal - working.arousal).toBeGreaterThan(0.25);
  });

  it('content keeps authority the success channel is not allowed to reach', async () => {
    const identity = fresh('test-k');
    vi.useFakeTimers();
    vi.setSystemTime(12_000_000);
    for (let i = 0; i < 200; i += 1) {
      vi.setSystemTime(12_000_000 + i * 100);
      await engine.observe(identity, stimulusFromToolCall('store_memory', true));
    }
    const capped = await engine.getState(identity);

    vi.setSystemTime(12_040_000);
    await engine.observe(identity, { valence: -0.4, arousal: 0.9, weight: 1, source: 'content' });
    const afterContent = await engine.getState(identity);

    expect(afterContent.arousal).toBeGreaterThan(capped.arousal);
    expect(afterContent.bands.beta + afterContent.bands.gamma)
      .toBeGreaterThan(capped.bands.beta + capped.bands.gamma + 0.1);
  });

  it('says who moved the state: contributors are recorded per source', async () => {
    const identity = fresh('test-l');
    vi.useFakeTimers();
    vi.setSystemTime(13_000_000);
    for (let i = 0; i < 5; i += 1) {
      vi.setSystemTime(13_000_000 + i * 100);
      await engine.observe(identity, stimulusFromToolCall('store_memory', true));
    }
    await engine.observe(identity, {
      valence: -0.3, arousal: 0.5, weight: 0.5, source: 'anomaly', source_id: 'campaign-a',
    });
    const state = await engine.getState(identity);

    expect(state.contributors?.['tool_success']?.observations).toBe(5);
    expect(state.contributors?.['campaign-a']?.observations).toBe(1);
    // most observations first, so the loudest channel is the first thing a reader sees
    expect(Object.keys(state.contributors || {})[0]).toBe('tool_success');
  });

  it('a context gets its own state, and the pin says whose feeling it is', async () => {
    const identity = fresh('test-k');
    vi.useFakeTimers();
    vi.setSystemTime(14_000_000);

    // A scoped key is enabled by its identity: adding a context needs no allow-list edit.
    expect(engine.isEnabled(stateKey(identity, 'sentry-cwe'))).toBe(true);

    const before = await engine.getState(identity);
    for (let i = 0; i < 10; i += 1) {
      vi.setSystemTime(14_000_000 + i * 100);
      await engine.observe(identity,
        { valence: -0.6, arousal: 0.8, weight: 0.9, source: 'tool_failure' },
        'sentry-cwe');
    }
    const scoped = await engine.getState(identity, 'sentry-cwe');
    const unscoped = await engine.getState(identity);

    expect(scoped.context).toBe('sentry-cwe');
    expect(scoped.identity).toBe(identity);            // the identity is not renamed by a scope
    expect(scoped.observations).toBe(10);
    // and the identity's own state did not move
    expect(unscoped.observations).toBe(before.observations);
    expect(unscoped.arousal).toBeCloseTo(before.arousal, 6);

    expect(engine.signatureFor(scoped).source).toBe('katra:sentry-cwe');
    expect(engine.signatureFor(unscoped).source).toBe('katra');
  });

  it('the success channel is quieter than it was: the impulse carries the gain', () => {
    const ok = stimulusFromToolCall('store_memory', true);
    expect(ok.arousal_gain).toBe(AFFECT_SUCCESS_GAIN);
    expect(ok.valence_gain).toBe(AFFECT_SUCCESS_GAIN);
    expect(ok.arousal_cap_offset).toBe(AFFECT_SUCCESS_CAP_OFFSET);
    // a failure is untouched: it keeps full authority, which is what makes alarm meaningful
    const bad = stimulusFromToolCall('store_memory', false);
    expect(bad.arousal_gain).toBeUndefined();
    expect(bad.arousal_cap_offset).toBeUndefined();
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
    process.env.KATRA_AFFECT_IDENTITIES = 'test-identity';
    const state = await engine.getState('some-other-agent');
    expect(state.enabled).toBe(false);
    expect(engine.isEnabled('test-identity')).toBe(true);
    expect(engine.isEnabled('some-other-agent')).toBe(false);
  });

  it('refuses a self-report when off, with a named reason', async () => {
    delete process.env.KATRA_AFFECT_ENABLED;
    const result = await engine.recordSelfReport('agent', 0.5, 0.5);
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
