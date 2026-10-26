/**
 * AFFECT-2 — `search_by_feeling`: recall by state, and the ways it must fail honestly.
 *
 * The tool is a thin composition — take the caller's current state, ask the wave lane which pins
 * resonate, resolve the ids back to memories — so the tests are about the three places that go wrong
 * in that composition:
 *
 *   1. the state must come from the ENGINE, not from the agent's words (the whole claim is that no text
 *      is involved);
 *   2. a lane that answers with a failure must be reported as a failure, never as "nothing found";
 *   3. nothing-found must read as an answer ("nothing similar is stored"), because that is information.
 *
 * The AGMT client is mocked: these tests must not depend on a running wave store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const affectSearch = vi.fn();

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => null,
  is_database_connected: () => false,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

vi.mock('../../src/services/integration/agmt-affect-client.js', () => ({
  // env-aware, like the real one: deleting KATRA_AFFECT_ENABLED must actually turn the lane off
  agmtAffectConfig: () => ({
    url: 'http://agmt.test', token: '',
    enabled: String(process.env.KATRA_AFFECT_ENABLED || '0') === '1',
    timeoutMs: 800,
  }),
  affectSearch: (...args: any[]) => affectSearch(...args),
  pinAffect: async () => ({ ok: true }),
  affectLaneStats: async () => ({ ok: true, stats: {} }),
}));

import { handleSearchByFeeling } from '../../src/mcp-server.js';
import { AffectEngine } from '../../src/services/processing/affect-engine.js';

const engine = AffectEngine.get_instance();
const text = (result: any[]) => result.map(part => part.text).join('\n');

/** The identity resolveUserId() yields here: an untrusted/absent caller is pinned to its own. */
const IDENTITY = 'katra';

beforeEach(() => {
  process.env.KATRA_AFFECT_ENABLED = '1';
  process.env.KATRA_AFFECT_IDENTITIES = `shoshin,${IDENTITY}`;
  affectSearch.mockReset();
});

afterEach(() => {
  delete process.env.KATRA_AFFECT_ENABLED;
  delete process.env.KATRA_AFFECT_IDENTITIES;
});

describe('search_by_feeling', () => {
  it('queries with the CURRENT state, not with words', async () => {
    affectSearch.mockResolvedValue({ ok: true, hits: [], scored: 0, admitted: 0, floor: 0.9 });
    await engine.observe(IDENTITY, {
      valence: -0.7, arousal: 0.9, weight: 1, source: 'content',
    });
    const state = await engine.getState(IDENTITY);

    await handleSearchByFeeling({ user_id: IDENTITY });
    expect(affectSearch).toHaveBeenCalledTimes(1);
    const [query, options] = affectSearch.mock.calls[0];
    // The engine decays toward baseline on wall-clock time, so the handler's read (a moment later)
    // differs in the fourth decimal. Family separation is ~0.06, so 1% is still a tight comparison.
    for (const [band, value] of Object.entries(state.bands as Record<string, number>)) {
      const sent = (query.bands as Record<string, number>)[band];
      expect(Math.abs(sent - value) / Math.max(Math.abs(value), 1e-9)).toBeLessThan(0.01);
    }
    expect(options.identity).toBe(IDENTITY);
    // No text ever enters the call: that is the capability under test.
    expect(JSON.stringify(query)).not.toMatch(/query|text|keyword/i);
  });

  it('an explicit state overrides the live one', async () => {
    affectSearch.mockResolvedValue({ ok: true, hits: [], scored: 0, admitted: 0, floor: 0.9 });
    await handleSearchByFeeling({ state: [1, 1, 2, 2, 0.5, 0.2], user_id: IDENTITY });
    const [query] = affectSearch.mock.calls[0];
    expect(query.bands).toEqual([1, 1, 2, 2, 0.5, 0.2]);
  });

  it('reports a lane failure as a failure, not as "nothing found"', async () => {
    affectSearch.mockResolvedValue({ ok: false, hits: [], scored: 0, admitted: 0, code: 'timeout: 800ms' });
    const out = text(await handleSearchByFeeling({ user_id: IDENTITY }));
    expect(out).toContain('failure');
    expect(out).toContain('timeout: 800ms');
    expect(out).not.toContain('Nothing resonates');
  });

  it('an empty result is an answer, and says what it means', async () => {
    affectSearch.mockResolvedValue({ ok: true, hits: [], scored: 12, admitted: 0, floor: 0.9 });
    const out = text(await handleSearchByFeeling({ user_id: IDENTITY }));
    expect(out).toContain('Nothing resonates');
    expect(out).toContain('12 pinned memories');
    expect(out).toContain('min_resonance: 0');
  });

  it('lists hits with their resonance and the state each was pinned under', async () => {
    affectSearch.mockResolvedValue({
      ok: true, scored: 3, admitted: 1, seconds: 0.01, floor: 0.9,
      hits: [{
        external_id: 'katra:event_x', resonance: 0.954, user_id: IDENTITY, shared_id: '',
        at: 1792971000, state: { bands: {}, valence: -0.3, arousal: 0.8 },
      }],
    });
    const out = text(await handleSearchByFeeling({ user_id: IDENTITY }));
    expect(out).toContain('0.954');
    expect(out).toContain('katra:event_x');
    expect(out).toContain('valence -0.30');
    expect(out).toContain('arousal 0.80');
  });

  it('refuses with a reason when the engine is not enabled for the identity', async () => {
    // Pass a different user_id and the guard pins the caller instead, so ineligibility is set here.
    process.env.KATRA_AFFECT_IDENTITIES = 'someone-else';
    affectSearch.mockResolvedValue({ ok: true, hits: [], scored: 0, admitted: 0, floor: 0.9 });
    const out = text(await handleSearchByFeeling({ user_id: 'someone-else' }));
    expect(out).toContain('No affect state');
    expect(affectSearch).not.toHaveBeenCalled();
  });

  it('refuses when the lane is off, without pretending to have searched', async () => {
    delete process.env.KATRA_AFFECT_ENABLED;
    const out = text(await handleSearchByFeeling({ user_id: IDENTITY }));
    expect(out).toContain('off');
    expect(affectSearch).not.toHaveBeenCalled();
  });
});
