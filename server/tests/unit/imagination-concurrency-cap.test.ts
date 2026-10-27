/**
 * ITER-11 refinement — the GLOBAL concurrency cap (the brief's §8 bound).
 *
 * The reviewer's residual R3: "No global concurrency cap; safety is per-mission
 * single-flight + per-mission budget … now MORE relevant, because the executive
 * tick triggers cycles autonomously, so N missions can each run one cycle at
 * once." Before this iteration nothing bounded the PROCESS: three stalled
 * missions could each start a cycle in the same tick.
 *
 * What is proved here, against the REAL services (only `llmService.extractJson`
 * is stubbed — no network, no provider):
 *
 *   A. the knob       — `IMAGINATION_MAX_CONCURRENT_CYCLES` defaults to 2 and a
 *      missing / non-numeric / non-positive value falls back to the default (a
 *      knob can never switch the bound off);
 *   B. cap = 1        — with one cycle in flight, a second cycle for a DIFFERENT
 *      mission is REFUSED (`concurrency_cap`), writes nothing at all and makes
 *      no model call; the first cycle still completes and the slot is released;
 *   C. cap = 2        — two cycles run concurrently across two missions and the
 *      THIRD is refused, with the reading (in flight 2 of 2) reported;
 *   D. every exit     — a skipped cycle, a failed cycle and a THROWING cycle
 *      each release their slot, so the cap cannot drift closed;
 *   E. single-flight  — two callers of the SAME mission still JOIN (the cap sits
 *      after the join gate and does not break it);
 *   F. the run row    — the reading is recorded on `imagination_cycles` and
 *      returned in the result (the "report"), so an operator can see which bound
 *      refused a cycle;
 *   G. the executive  — the sweep respects the cap: with the cap reached the
 *      tick's cycle is refused, the sweep records `capped: true` and starts
 *      nothing further.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

const holder = vi.hoisted(() => ({ db: null as any }));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => holder.db,
  is_database_connected: () => holder.db !== null,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { llmService } from '../../src/services/infrastructure/llm-service.js';
import { OPERATOR_USER, OTHER_USER, defaultResponder, seedScenario } from '../helpers/imagination-scenario.js';
import {
  inFlightCycles,
  runImaginationCycle,
} from '../../src/services/processing/imagination-cycle-service.js';
import {
  DEFAULT_MAX_CONCURRENT_CYCLES,
  maxConcurrentCycles,
} from '../../src/services/processing/imagination-cycle-config.js';
import { CREATIVE_BATON_COLLECTIONS } from '../../src/services/processing/creative-baton-collections.js';
import {
  CONCURRENCY_CAP_REASON,
  runExecutiveImaginationSweep,
} from '../../src/services/processing/executive-imagination-bridge.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const OWNER: CallerIdentity = { user_id: OPERATOR_USER, trusted: false };
const CYCLES = CREATIVE_BATON_COLLECTIONS.cycles;

/** Three separate missions, so "across identities" is genuinely exercised. */
const MISSION_A = 'mission_concurrency_a';
const MISSION_B = 'mission_concurrency_b';
const MISSION_C = 'mission_concurrency_c';

let db: FakeDb;
const spies: Array<{ mockRestore: () => void }> = [];

/**
 * The model gate: every `extractJson` call counts itself, and — while the gate
 * is `held` — BLOCKS on a promise the test releases. That is what keeps a cycle
 * genuinely in flight while the next caller arrives, instead of relying on
 * timing.
 */
const gate = {
  held: false,
  entered: 0,
  calls: 0,
  waiters: [] as Array<() => void>,
  release: (): void => {
    gate.held = false;
    for (const waiter of gate.waiters.splice(0)) waiter();
  },
  /** Resolves when at least `count` model calls have entered the responder. */
  enteredAtLeast(count: number): Promise<void> {
    if (gate.entered >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (gate.entered >= count) resolve();
        else setTimeout(check, 1);
      };
      check();
    });
  },
};

beforeEach(async () => {
  db = new FakeDb();
  holder.db = db.asDb();
  process.env.FOCUSED_IMAGINATION = '1';
  delete process.env.CREATIVE_BATON_PROMOTION;
  delete process.env.COGNITIVE_TEAM_ALLOCATION;
  delete process.env.IMAGINATION_MAX_CONCURRENT_CYCLES;
  gate.held = false;
  gate.entered = 0;
  gate.calls = 0;
  gate.waiters.length = 0;
  spies.push(
    vi.spyOn(llmService, 'extractJson').mockImplementation((async (system: string, prompt: string) => {
      gate.entered += 1;
      if (gate.held) await new Promise<void>((resolve) => gate.waiters.push(resolve));
      gate.calls += 1;
      return defaultResponder(system, prompt);
    }) as never),
  );
});

afterEach(() => {
  gate.release();
  for (const spy of spies.splice(0)) spy.mockRestore();
  delete process.env.FOCUSED_IMAGINATION;
  delete process.env.IMAGINATION_MAX_CONCURRENT_CYCLES;
});

/** Every document the store holds, so "wrote nothing" is a whole-store check. */
function dump(): string {
  const entries = [...db.collections.entries()]
    // Only NON-EMPTY collections: the fake creates a collection on first
    // ACCESS, so a read alone would otherwise look like a write.
    .filter(([, collection]) => collection.docs.length > 0)
    .map(([name, collection]) => [name, collection.docs] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function cycleArgs(missionId: string, userId: string = OPERATOR_USER) {
  return {
    userId,
    missionId,
    caller: { user_id: userId, trusted: false } as CallerIdentity,
    now: () => new Date('2026-09-26T12:00:00.000Z').toISOString(),
  };
}

describe('the global concurrency cap — the knob', () => {
  it('defaults to 2 and refuses to be switched off by a bad value', () => {
    delete process.env.IMAGINATION_MAX_CONCURRENT_CYCLES;
    expect(maxConcurrentCycles()).toBe(2);
    expect(DEFAULT_MAX_CONCURRENT_CYCLES).toBe(2);
    process.env.IMAGINATION_MAX_CONCURRENT_CYCLES = '1';
    expect(maxConcurrentCycles()).toBe(1);
    process.env.IMAGINATION_MAX_CONCURRENT_CYCLES = '5';
    expect(maxConcurrentCycles()).toBe(5);
    // A missing/non-numeric/non-positive value falls back to the default — a
    // knob can never disable the bound (the rule every knob here follows).
    for (const bad of ['', 'abc', '0', '-3', 'NaN']) {
      process.env.IMAGINATION_MAX_CONCURRENT_CYCLES = bad;
      expect(maxConcurrentCycles(), `value '${bad}'`).toBe(DEFAULT_MAX_CONCURRENT_CYCLES);
    }
  });
});

describe('the global concurrency cap — the bound', () => {
  it('cap 1: a second cycle for a DIFFERENT mission is refused and writes nothing', async () => {
    await seedScenario(db, { missionId: MISSION_A, ownerId: OPERATOR_USER });
    await seedScenario(db, { missionId: MISSION_B, ownerId: OPERATOR_USER });
    process.env.IMAGINATION_MAX_CONCURRENT_CYCLES = '1';

    gate.held = true;
    const first = runImaginationCycle(db, cycleArgs(MISSION_A));
    // The slot is taken SYNCHRONOUSLY (before the first await of the cycle),
    // so the reading is exact — not a timing assumption.
    expect(inFlightCycles()).toBe(1);
    await gate.enteredAtLeast(1); // the first cycle is inside its model call
    const before = dump();
    const callsBefore = gate.calls;

    const refused = await runImaginationCycle(db, cycleArgs(MISSION_B));
    expect(refused.status).toBe('skipped');
    expect(refused.reason).toBe('concurrency_cap');
    expect(refused.cycle_id).toBeNull();
    expect(refused.baton_id).toBeNull();
    expect(refused.portfolio).toBeNull();
    expect(refused.trace_id).toBeNull();
    expect(refused.concurrency).toEqual({
      max_concurrent_cycles: 1,
      in_flight_before: 1,
      in_flight_after: 1,
      capped: true,
    });
    // NO PARTIAL STATE, and no model call for the refused mission.
    expect(dump()).toBe(before);
    expect(gate.calls).toBe(callsBefore);
    expect(
      (db.collection(CYCLES).docs as Array<Record<string, any>>).filter((row) => row.mission_id === MISSION_B),
    ).toEqual([]);

    gate.release();
    const ran = await first;
    expect(ran.status).toBe('ran');
    expect(ran.concurrency).toEqual({
      max_concurrent_cycles: 1,
      in_flight_before: 0,
      in_flight_after: 1,
      capped: false,
    });
    // The slot is released the moment the cycle finishes.
    expect(inFlightCycles()).toBe(0);

    // …and the refused mission can run its cycle once the slot is free.
    const second = await runImaginationCycle(db, cycleArgs(MISSION_B));
    expect(second.status).toBe('ran');
    expect(second.concurrency).toEqual({
      max_concurrent_cycles: 1,
      in_flight_before: 0,
      in_flight_after: 1,
      capped: false,
    });
    expect(inFlightCycles()).toBe(0);
  }, 30000);

  it('cap 2: two cycles run at once across two missions and the THIRD is refused', async () => {
    await seedScenario(db, { missionId: MISSION_A, ownerId: OPERATOR_USER });
    await seedScenario(db, { missionId: MISSION_B, ownerId: OPERATOR_USER });
    await seedScenario(db, { missionId: MISSION_C, ownerId: OTHER_USER });
    process.env.IMAGINATION_MAX_CONCURRENT_CYCLES = '2';

    gate.held = true;
    const first = runImaginationCycle(db, cycleArgs(MISSION_A));
    const second = runImaginationCycle(db, cycleArgs(MISSION_B));
    expect(inFlightCycles()).toBe(2);
    await gate.enteredAtLeast(2);

    const before = dump();
    const refused = await runImaginationCycle(db, cycleArgs(MISSION_C, OTHER_USER));
    expect(refused.status).toBe('skipped');
    expect(refused.reason).toBe('concurrency_cap');
    expect(refused.concurrency).toEqual({
      max_concurrent_cycles: 2,
      in_flight_before: 2,
      in_flight_after: 2,
      capped: true,
    });
    expect(dump()).toBe(before);

    gate.release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual(['ran', 'ran']);
    expect(inFlightCycles()).toBe(0);
  }, 30000);

  it('releases the slot on every exit path: skipped, failed and throwing cycles', async () => {
    await seedScenario(db, { missionId: MISSION_A, ownerId: OPERATOR_USER });
    process.env.IMAGINATION_MAX_CONCURRENT_CYCLES = '1';

    // (a) a cycle that RUNS releases its slot.
    const ran = await runImaginationCycle(db, cycleArgs(MISSION_A));
    expect(ran.status).toBe('ran');
    expect(inFlightCycles()).toBe(0);

    // (b) a cycle that is SKIPPED (the persisted cooldown) releases it.
    const skipped = await runImaginationCycle(db, cycleArgs(MISSION_A));
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toBe('cooldown');
    expect(skipped.concurrency?.capped).toBe(false);
    expect(inFlightCycles()).toBe(0);

    // (c) a cycle that THROWS releases it — the `finally` is on every path.
    await expect(runImaginationCycle(db, cycleArgs('mission_that_does_not_exist'))).rejects.toThrow(
      /mission state not found/,
    );
    expect(inFlightCycles()).toBe(0);

    // (d) a cycle that FAILS (a terminal mission) releases it.
    await seedScenario(db, { missionId: MISSION_B, ownerId: OPERATOR_USER, status: 'completed' });
    const failed = await runImaginationCycle(db, cycleArgs(MISSION_B));
    expect(failed.status).toBe('failed');
    expect(failed.stop_reason).toBe('mission_cancelled_or_superseded');
    expect(failed.concurrency?.capped).toBe(false);
    expect(inFlightCycles()).toBe(0);

    // …and after all four exits the slot is genuinely reusable.
    const failedRun = db
      .collection(CYCLES)
      .docs.find((row: any) => row.mission_id === MISSION_B && row.status === 'failed');
    expect(failedRun, 'the failed cycle was not recorded').toBeTruthy();
    const again = await runImaginationCycle(db, { ...cycleArgs(MISSION_A), force: true });
    expect(again.status).toBe('skipped'); // still cooling down — but NOT refused by the cap
    expect(again.reason).toBe('cooldown');
    expect(inFlightCycles()).toBe(0);
  }, 30000);

  it('same-mission callers still JOIN instead of being refused by the cap', async () => {
    await seedScenario(db, { missionId: MISSION_A, ownerId: OPERATOR_USER });
    process.env.IMAGINATION_MAX_CONCURRENT_CYCLES = '1';

    gate.held = true;
    const first = runImaginationCycle(db, cycleArgs(MISSION_A));
    expect(inFlightCycles()).toBe(1);
    await gate.enteredAtLeast(1);

    // The cap is complete at 1, and this caller is for the SAME mission: it must
    // join the running cycle (gate 1) rather than be refused by the cap (gate
    // 1b) — otherwise a busy mission would become unreachable, and the
    // single-flight contract would be silently replaced by a refusal.
    //
    // The join is STARTED (not awaited) while the first cycle is still blocked:
    // a join resolves only when the cycle it joined finishes, so awaiting it
    // before releasing the gate would be a deadlock of this test, not a finding
    // about the code.
    const joinCall = runImaginationCycle(db, cycleArgs(MISSION_A));
    expect(inFlightCycles()).toBe(1); // a join takes no second slot

    gate.release();
    const join = await joinCall;
    expect(join.status).toBe('replayed');
    expect(join.reason).toBe('single_flight_join');
    expect(join.reason).not.toBe(CONCURRENCY_CAP_REASON);

    expect((await first).status).toBe('ran');
    expect(inFlightCycles()).toBe(0);
  }, 30000);

  it('records the reading on the run row and returns it in the report', async () => {
    await seedScenario(db, { missionId: MISSION_A, ownerId: OPERATOR_USER });
    process.env.IMAGINATION_MAX_CONCURRENT_CYCLES = '1';
    const result = await runImaginationCycle(db, cycleArgs(MISSION_A));
    expect(result.status).toBe('ran');
    const row = (db.collection(CYCLES).docs as Array<Record<string, any>>).find(
      (entry) => entry.cycle_id === result.cycle_id,
    );
    expect(row, 'the cycle row is missing').toBeTruthy();
    expect(row!.concurrency).toEqual({
      max_concurrent_cycles: 1,
      in_flight_before: 0,
      in_flight_after: 1,
      capped: false,
    });
    // The row and the report agree (the same record the tool renders).
    expect(result.concurrency).toEqual(row!.concurrency);
  }, 30000);

  it('the executive sweep respects the cap: with both slots taken it starts nothing', async () => {
    // Two cycles held in flight on ANOTHER identity's missions, and one active
    // mission for the identity the executive serves. The cap is global, so the
    // sweep's own mission must be refused even though nothing of its own is
    // running.
    await seedScenario(db, { missionId: MISSION_A, ownerId: OTHER_USER });
    await seedScenario(db, { missionId: MISSION_B, ownerId: OTHER_USER });
    await seedScenario(db, { missionId: MISSION_C, ownerId: OPERATOR_USER });
    process.env.IMAGINATION_MAX_CONCURRENT_CYCLES = '2';

    gate.held = true;
    const first = runImaginationCycle(db, cycleArgs(MISSION_A, OTHER_USER));
    const second = runImaginationCycle(db, cycleArgs(MISSION_B, OTHER_USER));
    expect(inFlightCycles()).toBe(2);
    await gate.enteredAtLeast(2);

    const before = dump();
    const sweep = await runExecutiveImaginationSweep({ db: db.asDb(), userIds: [OPERATOR_USER] });
    expect(sweep.enabled).toBe(true);
    expect(sweep.cycles_run).toBe(0);
    expect(sweep.cycles).toEqual([]);
    expect(sweep.capped).toBe(true);
    expect(sweep.concurrency).toEqual({
      max_concurrent_cycles: 2,
      in_flight_before: 2,
      in_flight_after: 2,
      capped: true,
    });
    expect(sweep.skipped).toEqual([
      { user_id: OPERATOR_USER, mission_id: MISSION_C, reason: CONCURRENCY_CAP_REASON },
    ]);
    // The refusal is a bound, not a failure, and it wrote nothing.
    expect(sweep.failures).toEqual([]);
    expect(dump()).toBe(before);

    gate.release();
    await Promise.all([first, second]);
    expect(inFlightCycles()).toBe(0);

    // Once the slots are free the same sweep runs its mission's cycle.
    const after = await runExecutiveImaginationSweep({ db: db.asDb(), userIds: [OPERATOR_USER] });
    expect(after.capped).toBe(false);
    expect(after.cycles_run).toBe(1);
    expect(after.cycles[0].mission_id).toBe(MISSION_C);
    expect(after.cycles[0].status).toBe('ran');
    expect(after.concurrency?.capped).toBe(false);
  }, 40000);
});
