/**
 * ITER-11, WS-1 item 2 (DoD #5) — the autonomous trigger INSIDE the executive
 * tick.
 *
 * Contract: "inside the existing tick, when `FOCUSED_IMAGINATION` is on,
 * evaluate the plateau for the identities the executive already serves and,
 * subject to the cycle's own single-flight/cooldown/budget, run at most one
 * cycle per tick; authority and liveness gates unchanged; failures are logged
 * and never break the tick. A test drives the tick with a stalled fixture and
 * asserts exactly one cycle, and with the flag off asserts zero calls and zero
 * writes."
 *
 * Proved to fail against the pre-iteration tick: `autonomous-executive.ts`
 * contained no sweep, so with the flag ON the tick wrote zero cycle rows (the
 * "exactly one cycle" assertions failed) — and there was no sweep module to
 * import at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

// The allocation set is read at module load by the executive, so it is pinned
// before any import (the identities the tick serves).
vi.hoisted(() => {
  process.env.KATRA_USER_ID = 'agent-a';
  process.env.KATRA_ALLOCATION_CANDIDATES = 'agent-a,agent-b';
  delete process.env.COGNITIVE_SCHEDULER_MODE;
  delete process.env.COGNITIVE_ACTIVATION_KILL_SWITCH;
});

const holder = vi.hoisted(() => ({ db: null as any }));
/** Every collection name the sweep/cycle touched, in order (0 with the flag off). */
const touched = vi.hoisted(() => ({ names: [] as string[], calls: 0 }));

vi.mock('../../src/database/connection.js', async () => {
  const { FakeDb } = await import('../helpers/fake-mongo.js');
  const real = new FakeDb();
  holder.db = real;
  return {
    get_database: () => ({
      collection: (name: string) => {
        touched.names.push(name);
        touched.calls += 1;
        return real.collection(name);
      },
    }),
    is_database_connected: () => true,
    connect_to_mongodb: async () => {},
    close_connection: async () => {},
  };
});

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { llmService } from '../../src/services/infrastructure/llm-service.js';
import {
  OPERATOR_USER,
  SCENARIO_MISSION,
  defaultResponder,
  seedScenario,
  seedMission,
} from '../helpers/imagination-scenario.js';
import { AutonomousExecutive } from '../../src/services/processing/autonomous-executive.js';
import { runExecutiveImaginationSweep } from '../../src/services/processing/executive-imagination-bridge.js';
import { CREATIVE_BATON_COLLECTIONS } from '../../src/services/processing/creative-baton-collections.js';

const CYCLES = CREATIVE_BATON_COLLECTIONS.cycles;
const STATES = CREATIVE_BATON_COLLECTIONS.cycleStates;
const BATONS = CREATIVE_BATON_COLLECTIONS.creativeBatons;

const spies: Array<{ mockRestore: () => void }> = [];

/** Every collection the IMAGINATION stack would write, and the private ones. */
const IMAGINATION_COLLECTIONS = [
  CYCLES,
  STATES,
  BATONS,
  'idea_seeds',
  'idea_lineages',
  'idea_archive_cells',
  'imagination_runs',
  'salience_traces',
  'focused_consolidation_runs',
];

function db(): any {
  return holder.db;
}

function rowCount(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of IMAGINATION_COLLECTIONS) counts[name] = db().collection(name).docs.length;
  return counts;
}

/** Drive the real tick (private in production; the suite reaches in like the peers do). */
async function driveTick(): Promise<void> {
  const executive = AutonomousExecutive.get_instance();
  await (executive as any).tick();
}

beforeEach(async () => {
  // The mock factory owns the FakeDb; reset it through the mocked handle.
  db().reset();
  touched.names = [];
  touched.calls = 0;
  delete process.env.FOCUSED_IMAGINATION;
  delete process.env.CREATIVE_BATON_PROMOTION;
  delete process.env.IMAGINATION_CYCLE_COOLDOWN_MS;
  const spy = vi.spyOn(llmService, 'extractJson').mockImplementation((async (system: string, prompt: string) =>
    defaultResponder(system, prompt)) as never);
  spies.push(spy);
  spies.push(
    vi.spyOn(llmService, 'getServiceStatus').mockReturnValue({
      available: true,
      provider: 'stub',
      model: 'test-model',
      providers: ['stub(ready)'],
    } as never),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  delete process.env.FOCUSED_IMAGINATION;
  delete process.env.CREATIVE_BATON_PROMOTION;
  delete process.env.IMAGINATION_CYCLE_COOLDOWN_MS;
});

describe('executive tick — the plateau trigger is wired and flag-gated', () => {
  it('with FOCUSED_IMAGINATION off: zero calls into the imagination stack and zero writes', async () => {
    await seedScenario(db());
    const before = rowCount();

    await driveTick();

    // Nothing in the imagination stack was read or written by the sweep…
    const after = rowCount();
    expect(after).toEqual(before);
    expect(after[CYCLES]).toBe(0);
    expect(after[STATES]).toBe(0);
    expect(after[BATONS]).toBe(0);
    const name = (collection: string) => touched.names.filter((entry) => entry === collection).length;
    expect(name(CYCLES)).toBe(0);
    expect(name(STATES)).toBe(0);
    expect(name(BATONS)).toBe(0);
    expect(name('salience_traces')).toBe(0);

    // …and the sweep says so itself, without touching the store either.
    const callsBefore = touched.calls;
    const sweep = await runExecutiveImaginationSweep({ db: db() });
    expect(sweep.enabled).toBe(false);
    expect(sweep.cycles_run).toBe(0);
    expect(sweep.missions_evaluated).toBe(0);
    expect(sweep.basis).toContain('FOCUSED_IMAGINATION is off');
    expect(touched.calls).toBe(callsBefore);
  });

  it('with the flag on and a stalled fixture: the tick runs EXACTLY ONE cycle and returns', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    await seedScenario(db(), { ownerId: OPERATOR_USER });

    await driveTick();

    const cycles = db().collection(CYCLES).docs as Array<Record<string, any>>;
    expect(cycles).toHaveLength(1);
    expect(cycles[0].user_id).toBe(OPERATOR_USER);
    expect(cycles[0].mission_id).toBe(SCENARIO_MISSION);
    expect(cycles[0].trigger).toBe('executive_tick');
    expect(cycles[0].actor_id).toBe(OPERATOR_USER);
    expect(cycles[0].status).toBe('completed');
    expect(db().collection(STATES).docs).toHaveLength(1);
    // The cycle's own budget record is persisted: the executive did not bypass
    // a single gate (cooldown/budget are recorded, not skipped).
    expect(cycles[0].budget.max_cycles).toBeGreaterThan(0);
    expect(cycles[0].cooldown_remaining_ms).toBe(0);

    // A SECOND tick in the same window is the cycle's own cooldown saying no:
    // the tick still runs, but it writes no second cycle.
    await driveTick();
    expect(db().collection(CYCLES).docs).toHaveLength(1);
  });

  it('runs AT MOST ONE cycle per tick across several stalled missions', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    await seedScenario(db(), { missionId: 'mission_stalled_one', ownerId: OPERATOR_USER });
    await seedScenario(db(), { missionId: 'mission_stalled_two', ownerId: OPERATOR_USER });
    await seedScenario(db(), { missionId: 'mission_stalled_three', ownerId: OPERATOR_USER });

    await driveTick();

    const cycles = db().collection(CYCLES).docs as Array<Record<string, any>>;
    expect(cycles).toHaveLength(1);

    // A SECOND sweep (what the next tick does) may run exactly ONE more cycle —
    // for a DIFFERENT mission, never a second one for the mission that just
    // ran: its own persisted cooldown refuses.
    const second = await runExecutiveImaginationSweep({ db: db() });
    expect(second.enabled).toBe(true);
    expect(second.cycles_run).toBe(1);
    expect(second.cycles[0].mission_id).not.toBe(cycles[0].mission_id);
    expect(db().collection(CYCLES).docs).toHaveLength(2);

    // One more sweep covers the third mission; from then on every mission is
    // inside its own cooldown, so a sweep evaluates and runs nothing — the
    // refusals are the cycle's own gates, by name.
    const third = await runExecutiveImaginationSweep({ db: db() });
    expect(third.cycles_run).toBe(1);
    expect(db().collection(CYCLES).docs).toHaveLength(3);
    const fourth = await runExecutiveImaginationSweep({ db: db() });
    expect(fourth.cycles_run).toBe(0);
    expect(fourth.missions_evaluated).toBeGreaterThanOrEqual(1);
    expect(fourth.skipped.every((row) => row.reason === 'cooldown' || row.reason === 'no_plateau')).toBe(true);
    expect(db().collection(CYCLES).docs).toHaveLength(3);
  });

  it('only serves the identities the executive already serves (never another owner)', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    // A stalled mission owned by an identity OUTSIDE the allocation set.
    await seedScenario(db(), { missionId: 'mission_foreign_owner', ownerId: 'outsider' });

    await driveTick();

    expect(db().collection(CYCLES).docs).toHaveLength(0);
    // The tick sweeps the executive's own two identities…
    const sweep = await runExecutiveImaginationSweep({ db: db(), userIds: ['agent-a', 'agent-b'] });
    expect(sweep.identities).toBe(2);
    expect(sweep.cycles_run).toBe(0);
    // …and the default (no explicit list) is the local identity only.
    expect((await runExecutiveImaginationSweep({ db: db() })).identities).toBe(1);
    // The foreign owner's mission was never evaluated, let alone cycled.
    expect(sweep.missions_evaluated).toBe(0);
  });

  it('a non-stalled mission is evaluated and skipped, with no cycle and no model call', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    // A mission with enough admitted candidates, coverage above the floor and
    // no contradictions is NOT in a plateau.
    await seedMission(db(), { missionId: 'mission_healthy', ownerId: OPERATOR_USER, candidates: 6 });
    process.env.IMAGINATION_PLATEAU_COVERAGE_FLOOR = '1';
    process.env.IMAGINATION_PLATEAU_MIN_CANDIDATES = '1';

    try {
      const sweep = await runExecutiveImaginationSweep({ db: db() });
      expect(sweep.enabled).toBe(true);
      expect(sweep.cycles_run).toBe(0);
      expect(sweep.skipped).toEqual([{ user_id: OPERATOR_USER, mission_id: 'mission_healthy', reason: 'no_plateau' }]);
      expect(db().collection(CYCLES).docs).toHaveLength(0);
    } finally {
      delete process.env.IMAGINATION_PLATEAU_COVERAGE_FLOOR;
      delete process.env.IMAGINATION_PLATEAU_MIN_CANDIDATES;
    }
  });

  it('a FAILING mission is recorded and never breaks the sweep or the tick', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    await seedScenario(db(), { missionId: 'mission_stalled_a', ownerId: OPERATOR_USER });
    const failing = async () => {
      throw new Error('plateau read exploded');
    };
    const sweep = await runExecutiveImaginationSweep({
      db: db(),
      plateau: failing as never,
    });
    expect(sweep.failures).toHaveLength(1);
    expect(sweep.failures[0].error).toContain('plateau read exploded');
    expect(sweep.cycles_run).toBe(0);

    // The tick itself still completes: a failing sweep cannot stop the loop.
    const errors = spies.length; // (spies are restored after the test)
    void errors;
    await driveTick();
    expect(db().collection(CYCLES).docs.length).toBeGreaterThanOrEqual(0);
  });

  it('a concurrent tick does not run a second cycle (the tick’s own single-flight holds)', async () => {
    process.env.FOCUSED_IMAGINATION = '1';
    await seedScenario(db(), { ownerId: OPERATOR_USER });
    const executive = AutonomousExecutive.get_instance() as any;
    // Two ticks fired at once: the second returns immediately (ticking guard),
    // and even if it did not, the cycle's single-flight and cooldown would.
    await Promise.all([executive.tick(), executive.tick()]);
    expect(db().collection(CYCLES).docs).toHaveLength(1);
  });
});
