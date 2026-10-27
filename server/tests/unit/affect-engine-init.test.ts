/**
 * AFFECT-1 — initialisation is single-flight and the durable state wins.
 *
 * This is the regression test for a defect found on the live service, not in a mock: the engine
 * marked an identity "loaded" *before* awaiting the read, so two tool calls arriving together both
 * built a fresh baseline, and a persist could then overwrite the durable row with that default. The
 * evidence was a restart plus one call leaving `observations: 1` against a durable 13 — an agent's
 * mood silently wiped by a cold start.
 *
 * The mock here is deliberately SLOW: the read resolves only when the test says so, which is what
 * makes the race reproducible at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const DURABLE = {
  user_id: 'test-identity',
  bands: { delta: 1.0, theta: 1.1, alpha_l: 2.2, alpha_r: 1.7, beta: 1.5, gamma: 0.9 },
  baseline: { delta: 1.0, theta: 1.0, alpha_l: 2.0, alpha_r: 2.0, beta: 0.5, gamma: 0.2 },
  last_update_ms: Date.now() - 5_000,
  observations: 13,
  sources: { tool_failure: 3, content: 10 },
  trail: [],
};

let release: (() => void) | null = null;
let findOneCalls = 0;
let written: any[] = [];

/** A database whose read blocks until `release()` is called. */
const slowDatabase = {
  collection: () => ({
    findOne: async () => {
      findOneCalls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { ...DURABLE };
    },
    updateOne: async (_filter: any, update: any) => {
      written.push(update?.$set);
      return { acknowledged: true };
    },
  }),
};

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => slowDatabase,
  is_database_connected: () => true,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

import { AffectEngine } from '../../src/services/processing/affect-engine.js';

beforeEach(() => {
  process.env.KATRA_AFFECT_ENABLED = '1';
  process.env.KATRA_AFFECT_IDENTITIES = 'test-identity';
  findOneCalls = 0;
  written = [];
  release = null;
});

afterEach(() => {
  delete process.env.KATRA_AFFECT_ENABLED;
  delete process.env.KATRA_AFFECT_IDENTITIES;
});

describe('initialise once, and never at the durable state’s expense', () => {
  it('concurrent first calls share ONE read, and the durable state is the one served', async () => {
    const engine = AffectEngine.get_instance();

    const first = engine.initialize('test-identity');
    const second = engine.initialize('test-identity');
    const third = engine.getState('test-identity');

    // Both callers are waiting on the same read, not racing their own.
    await Promise.resolve();
    expect(findOneCalls).toBe(1);
    release?.();
    await Promise.all([first, second, third]);

    const state = await engine.getState('test-identity');
    expect(state.observations).toBe(13);
    // 1.7 as persisted, plus the five seconds of decay since `last_update_ms` — the point is that the
    // curve RESUMES where it left off rather than restarting at the baseline (2.0).
    expect(state.bands.alpha_r).toBeGreaterThan(1.7);
    expect(state.bands.alpha_r).toBeLessThan(1.71);
    expect(state.sources.tool_failure).toBe(3);
  });

  it('a write after the load carries the loaded observations, never a fresh zero', async () => {
    const engine = AffectEngine.get_instance();
    const loading = engine.getState('test-identity');
    await Promise.resolve();
    release?.();
    await loading;

    await engine.observe('test-identity', { valence: 0.4, arousal: 0.3, weight: 1, source: 'content' });
    expect(written.length).toBeGreaterThan(0);
    const last = written[written.length - 1];
    expect(last.observations).toBe(14);
    expect(last.bands.gamma).toBeGreaterThan(0.2);
  });
});
