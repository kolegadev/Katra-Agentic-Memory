/**
 * G12, the LIVE instrument — THE CAP AND THE LEDGER, ON A REAL STORE.
 *
 * The residual this file closes: "live multi-process / concurrency behaviour
 * unverified". The unit suite (`tests/unit/imagination-concurrency-cap.test.ts`)
 * proves the shipped cap against a FakeDb and a stubbed model; it cannot say
 * what the DEPLOYMENT's own store shows, because there the same
 * `imagination_cycles` ledger is written by the executive tick, by tool calls
 * and by any other process. This instrument makes one bounded observation
 * there, and reads the ledger back.
 *
 * WHAT IT DOES, IN TWO PARTS.
 *
 *   Part A (rounds A1 + A2) — THE CAP, in-process and deterministic. It
 *   seeds ITS OWN missions (the ITER-7 scenario, `seedScenario`, exactly as the
 *   baseline instrument does) under its own run token and its own run-scoped
 *   identity, sets the cap in its own environment BEFORE importing the services,
 *   and fires concurrent `runImaginationCycle(db, { force: true })` calls:
 *
 *     round A1 — THREE concurrent calls on ONE mission. The shipped gate order
 *       is per-mission single-flight FIRST, the global cap second, so one call
 *       takes the mission's slot and the other two JOIN it
 *       (`status: 'replayed'`, `reason: 'single_flight_join'`). This round
 *       proves the per-mission bound; it CANNOT reach the cap gate, which is why
 *       round A2 exists.
 *     round A2 — `cap + 1` concurrent calls on `cap + 1` DISTINCT missions of
 *       the same identity. The cap counts slots across every identity and
 *       mission in the process, so distinct missions are the only way more than
 *       one call can be refused by it: `cap` calls take slots and the next is
 *       REFUSED with `status: 'skipped'`, `reason: 'concurrency_cap'` — the
 *       shipped refusal, which "reads nothing, calls no model, claims no cycle
 *       and writes no row" (docs/IMAGINATION-ROLLOUT.md, the cap's table; the
 *       reason string is also exported by the executive bridge as
 *       `CONCURRENCY_CAP_REASON`).
 *
 *   Part B — THE LEDGER'S OWN RECORD. It reads `imagination_cycles` back and
 *   computes, from the rows' own `created_at` / `completed_at` instants, the
 *   MAXIMUM number of cycles that were in flight at once: for this run's own
 *   identity, for the named identity's deployed ledger (bounded lookback), and
 *   for the whole collection's window. That is the cross-process evidence — the
 *   deployment's tick and any other process write the same rows — so the
 *   maximum overlap the ledger shows is the bound that actually held, reported
 *   against the configured cap. No number is asserted in advance: the run fails
 *   only if the observed overlap EXCEEDS the cap (or exceeds the largest cap a
 *   writing row itself declared).
 *
 * EVERY CHECK IS A CHECK, NOT A NOTE. A call that reaches `ran` beyond the cap,
 * a refusal whose status/reason is not one of the shipped pairs, a refused call
 * that left a row behind, a failed cycle, an unreadable ledger, a store row
 * count that does not match the cycles that actually claimed — each of these is
 * a FAILURE of the run, collected in the capture's `violations` and asserted
 * after the capture is written, so the evidence survives the failure.
 *
 * WHAT IT DOES NOT ESTABLISH (stated again in the capture, in the same words):
 * it is ONE bounded observation on ONE host in ONE process, not a soak — it does
 * not prove behaviour under sustained load or across the tick's own cadence; the
 * cap is a PER-PROCESS counter, so two processes can legitimately hold `cap`
 * each and the ledger would show up to `2 × cap`; the ledger's overlap is a
 * LOWER bound on the true in-flight overlap (a slot is taken before the row's
 * `created_at` and released after its `completed_at`); and it says nothing about
 * model quality, novelty or cost.
 *
 * IT RUNS NOTHING UNLESS ASKED. With `IMAGINATION_CONCURRENCY_LIVE` unset the
 * whole file skips, so a normal test run neither connects to a store nor spends
 * a token. The command line (on the deployment host):
 *
 *   cd server
 *   IMAGINATION_CONCURRENCY_LIVE=1 \
 *   IMAGINATION_CONCURRENCY_USER=<identity> \
 *   IMAGINATION_CONCURRENCY_OUT=<capture.json> \
 *   npx vitest run tests/live/imagination-concurrency-live.test.ts
 *
 * Options (all recorded in the capture):
 *   IMAGINATION_CONCURRENCY_RUN          run token; default: a pure function of
 *                                        the clock (`conc-<UTC yyyymmdd-hhmmss>`),
 *                                        never random. It is suffixed onto every
 *                                        mission id and onto the run's identity,
 *                                        so no two runs share a unique key; a
 *                                        token already present in the store
 *                                        REFUSES the run by name.
 *   IMAGINATION_CONCURRENCY_CAP          the cap to run with (default: the
 *                                        shipped default, 2). It is written into
 *                                        `IMAGINATION_MAX_CONCURRENT_CYCLES` in
 *                                        THIS process only, before any service is
 *                                        imported; a value above 4 is refused by
 *                                        name (each extra seat is a real cycle
 *                                        plus a seeded mission, and this is one
 *                                        bounded observation).
 *   IMAGINATION_CONCURRENCY_LOOKBACK_MS  the deployed ledger's window (default
 *                                        7 days); the collection-wide read is
 *                                        bounded by rows and refuses by name.
 *
 * THE CAPTURE IS AN OPERATIONAL ARTEFACT, NOT REPO CONTENT: it carries the host
 * name, the model id, the store's database name and the rows it read. Write it
 * outside the repository, as the other live instruments do. It is written ONCE
 * and an existing path REFUSES the run.
 */
import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import type { Db } from 'mongodb';
import type { FakeDb } from '../helpers/fake-mongo.js';

type Row = Record<string, any>;

const LIVE = process.env.IMAGINATION_CONCURRENCY_LIVE === '1';

/**
 * The shipped default, MIRRORED here because the cap has to be written into the
 * environment in this module's body — before any `src` module is imported — and
 * a mirrored literal can drift. The test re-reads the shipped constant
 * (`DEFAULT_MAX_CONCURRENT_CYCLES`) and REFUSES the run if the two disagree.
 */
const MIRRORED_DEFAULT_CAP = 2;
/** Seats this instrument will run: A1's mission + A2's `cap + 1` missions. */
const MAX_CAP_THIS_INSTRUMENT_WILL_RUN = 4;
/** The shipped knob the cap is read from (`imagination-cycle-config.ts`). */
const SHIPPED_CAP_ENV = 'IMAGINATION_MAX_CONCURRENT_CYCLES';
/** Round A1's call count (three concurrent callers of ONE mission). */
const A1_CONCURRENT_CALLS = 3;
/** The deployed ledger's default window. */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows the collection-wide ledger read will accept before refusing by name. */
const MAX_LEDGER_ROWS = 2000;
/** Rows embedded verbatim in a capture table before it is summarized instead. */
const MAX_EMBEDDED_ROWS = 200;
/** The trigger label every call this instrument makes carries. */
const TRIGGER = 'concurrency_live_instrument';
/** A live round seeds missions, runs real cycles and reads a real ledger. */
const TIMEOUT_MS = 30 * 60 * 1000;

function envText(env: Record<string, string | undefined>, name: string): string | null {
  const raw = env[name];
  return raw === undefined || raw === '' ? null : raw;
}

function text(name: string): string | null {
  return envText(process.env, name);
}

function messageOf(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error);
}

function wholeNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number | { refusal: string } {
  const raw = envText(env, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return { refusal: `${name} '${raw}' is not a positive whole number` };
  }
  return value;
}

/**
 * The cap this run will use, from `IMAGINATION_CONCURRENCY_CAP` or the shipped
 * default — a PURE function of the environment record it is handed.
 */
function capChoiceFromEnv(env: Record<string, string | undefined>): number | { refusal: string } {
  const raw = envText(env, 'IMAGINATION_CONCURRENCY_CAP');
  if (raw === null) return MIRRORED_DEFAULT_CAP;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return {
      refusal:
        `IMAGINATION_CONCURRENCY_CAP '${raw}' is not a positive whole number — the shipped knob silently falls back ` +
        'to its default for such a value, but this instrument refuses rather than measure a cap it did not choose',
    };
  }
  if (value > MAX_CAP_THIS_INSTRUMENT_WILL_RUN) {
    return {
      refusal:
        `IMAGINATION_CONCURRENCY_CAP ${value} exceeds the ${MAX_CAP_THIS_INSTRUMENT_WILL_RUN} this instrument will run — ` +
        'round A2 seats one real multi-call cycle plus one seeded mission per unit of the cap, and this is ONE bounded ' +
        'observation, not a soak',
    };
  }
  return value;
}

/**
 * The run token: `IMAGINATION_CONCURRENCY_RUN`, or a clock-derived default — a
 * PURE function of the environment record and the instant it is given (no
 * randomness, no hidden state), so the same env and the same instant always name
 * the same run.
 */
function runTokenFromEnv(
  env: Record<string, string | undefined>,
  at: Date,
): string | { refusal: string } {
  const raw = envText(env, 'IMAGINATION_CONCURRENCY_RUN');
  const run =
    raw ??
    `conc-${at.toISOString().slice(0, 10).replace(/-/g, '')}-${at.toISOString().slice(11, 19).replace(/:/g, '')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(run)) {
    return {
      refusal:
        `the run token '${run}' is not a run token — it must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ because it is ` +
        'suffixed onto every mission id and every identity this run writes',
    };
  }
  return run;
}

/** A tolerant instant reader: ISO strings, dates and epoch numbers all parse. */
function instantOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

// ── The cap and the flags, IN THIS PROCESS ONLY, before any service loads ───
//
// The module body runs before the test's dynamic imports, so the services first
// see these values already set: the cap this instrument MEASURED WITH, and the
// two feature flags the other cycle-running instruments also turn on for the
// length of their own process (the rollout's deployment runs with the flags
// off). Nothing outside this process is configured or changed.
const capChoice = capChoiceFromEnv(process.env);
const capInForce = typeof capChoice === 'number' ? capChoice : MIRRORED_DEFAULT_CAP;

if (LIVE) {
  process.env[SHIPPED_CAP_ENV] = String(capInForce);
  process.env.FOCUSED_IMAGINATION = '1';
  process.env.CREATIVE_BATON_PROMOTION = '1';
}

const SKIP_REASON =
  'IMAGINATION_CONCURRENCY_LIVE is not set to 1 — this file is the LIVE concurrency instrument (real MongoDB, real ' +
  'model, real cycles); it is skipped so that a normal test run neither connects to a store nor spends a token. ' +
  'See the file header for the command line.';

if (!LIVE) console.log(`[imagination-concurrency-live] SKIPPED: ${SKIP_REASON}`);

// ── The live store, in the shape the shared scenario helper reads ───────────

/**
 * The bridge between the REAL `Db` and `tests/helpers/imagination-scenario.ts`.
 *
 * The helper was written against `FakeDb`: it PUSHES rows into
 * `collection(name).docs` (the scenario's work item and its knowledge graph)
 * and runs every service on `asDb()`. This class presents exactly that shape
 * while every service call goes to the real handle, and `flush()` inserts the
 * rows the helper appended — so the seeded fixture is what the real cycles read,
 * with no second copy of the helper's logic.
 */
class LiveSeedStore {
  private readonly cache = new Map<string, { rows: Row[]; inserted: number }>();

  constructor(private readonly db: Db) {}

  private entry(name: string): { rows: Row[]; inserted: number } {
    const existing = this.cache.get(name);
    if (existing) return existing;
    const created = { rows: [] as Row[], inserted: 0 };
    this.cache.set(name, created);
    return created;
  }

  /** The FakeDb-shaped collection handle the seed helper reads and pushes to. */
  collection(name: string): { docs: Row[] } {
    return { docs: this.entry(name).rows };
  }

  /** The real handle: every service runs on this, never on the snapshot. */
  asDb(): Db {
    return this.db;
  }

  /** The same object, typed the way the shared helper declares its store. */
  asFakeDb(): FakeDb {
    return this as unknown as FakeDb;
  }

  /** Insert every row a helper appended since the last flush. */
  async flush(): Promise<void> {
    for (const [name, entry] of this.cache) {
      if (entry.rows.length <= entry.inserted) continue;
      const fresh = entry.rows.slice(entry.inserted) as Array<Record<string, unknown>>;
      if (fresh.length > 0) await this.db.collection(name).insertMany(fresh as never[]);
      entry.inserted = entry.rows.length;
    }
  }
}

// ── The ledger's own record: the maximum overlap of cycles in flight ────────

interface LedgerReport {
  scope: string;
  description: string;
  configured_cap: number;
  ceiling_used: number;
  rows_in_scope: number;
  rows_swept: number;
  rows_excluded_without_declared_cap: string[];
  rows_excluded_unparseable_instants: string[];
  rows_still_in_flight_at_read: string[];
  maximum_overlap: number;
  maximum_overlap_at: string | null;
  maximum_overlap_rows: string[];
  max_recorded_in_flight_after: number | null;
  declared_caps_seen: number[];
  exceeds_configured_cap: boolean;
  exceeds_declared_ceiling: boolean;
  rows: Row[];
  rows_truncated: boolean;
}

/**
 * The maximum number of cycles in flight at once, from the rows' own instants.
 *
 * The window is HALF-OPEN, `[created_at, completed_at)`: a cycle is in flight
 * from the claim its row records until the completion instant that closes it, so
 * two windows that only TOUCH at an instant are not counted as overlap (ends are
 * processed before starts at the same timestamp). A row with `completed_at:
 * null` is still in flight and is swept to the read instant, and it says so in
 * the capture. A row that declares no `concurrency.max_concurrent_cycles` was
 * written by a version without the cap (the knob is younger than the ledger), so
 * it is EXCLUDED from the enforceable sweep, counted and listed rather than
 * silently compared against a bound it never had.
 */
function ledgerReport(args: { scope: string; description: string; rows: Row[]; cap: number; nowMs: number }): LedgerReport {
  const excludedNoCap: string[] = [];
  const excludedUnparseable: string[] = [];
  const stillInFlight: string[] = [];
  const intervals: Array<{ cycle_id: string; started_ms: number; ended_ms: number }> = [];

  for (const row of args.rows) {
    const cycleId = String(row.cycle_id ?? '(no cycle_id)');
    const declared = Number(row.concurrency?.max_concurrent_cycles);
    if (!Number.isFinite(declared)) {
      excludedNoCap.push(cycleId);
      continue;
    }
    const startedMs = instantOf(row.created_at);
    if (startedMs === null) {
      excludedUnparseable.push(cycleId);
      continue;
    }
    const completedMs = instantOf(row.completed_at);
    if (completedMs === null) stillInFlight.push(cycleId);
    intervals.push({ cycle_id: cycleId, started_ms: startedMs, ended_ms: completedMs ?? args.nowMs });
  }

  const events: Array<{ at: number; delta: number; cycle_id: string }> = [];
  for (const interval of intervals) {
    events.push({ at: interval.started_ms, delta: 1, cycle_id: interval.cycle_id });
    events.push({ at: interval.ended_ms, delta: -1, cycle_id: interval.cycle_id });
  }
  // Ends (-1) BEFORE starts (+1) at the same instant: touching windows do not
  // count as overlap (see the doc comment above).
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);

  const open = new Set<string>();
  let maximum = 0;
  let maximumAt: number | null = null;
  let peakRows: string[] = [];
  for (const event of events) {
    if (event.delta === 1) open.add(event.cycle_id);
    else open.delete(event.cycle_id);
    if (open.size > maximum) {
      maximum = open.size;
      maximumAt = event.at;
      peakRows = [...open].sort();
    }
  }

  const declaredCaps = [
    ...new Set(
      args.rows
        .map((row) => Number(row.concurrency?.max_concurrent_cycles))
        .filter((value) => Number.isFinite(value)),
    ),
  ].sort((left, right) => left - right);
  const recordedInFlight = args.rows
    .map((row) => Number(row.concurrency?.in_flight_after))
    .filter((value) => Number.isFinite(value));
  const ceiling = Math.max(args.cap, ...(declaredCaps.length > 0 ? declaredCaps : [args.cap]));

  const table = args.rows.map((row) => ({
    cycle_id: String(row.cycle_id ?? ''),
    mission_id: String(row.mission_id ?? ''),
    status: String(row.status ?? ''),
    created_at: row.created_at ?? null,
    completed_at: row.completed_at ?? null,
    end_of_window: row.completed_at === null || row.completed_at === undefined ? 'read instant (in flight at read)' : 'completed_at',
    declared_cap: Number.isFinite(Number(row.concurrency?.max_concurrent_cycles))
      ? Number(row.concurrency.max_concurrent_cycles)
      : null,
    in_flight_before: Number.isFinite(Number(row.concurrency?.in_flight_before)) ? Number(row.concurrency.in_flight_before) : null,
    in_flight_after: Number.isFinite(Number(row.concurrency?.in_flight_after)) ? Number(row.concurrency.in_flight_after) : null,
  }));

  return {
    scope: args.scope,
    description: args.description,
    configured_cap: args.cap,
    ceiling_used: ceiling,
    rows_in_scope: args.rows.length,
    rows_swept: intervals.length,
    rows_excluded_without_declared_cap: excludedNoCap,
    rows_excluded_unparseable_instants: excludedUnparseable,
    rows_still_in_flight_at_read: stillInFlight,
    maximum_overlap: maximum,
    maximum_overlap_at: maximumAt === null ? null : new Date(maximumAt).toISOString(),
    maximum_overlap_rows: peakRows,
    max_recorded_in_flight_after: recordedInFlight.length > 0 ? Math.max(...recordedInFlight) : null,
    declared_caps_seen: declaredCaps,
    exceeds_configured_cap: maximum > args.cap,
    exceeds_declared_ceiling: maximum > ceiling,
    rows: table.slice(0, MAX_EMBEDDED_ROWS),
    rows_truncated: table.length > MAX_EMBEDDED_ROWS,
  };
}

describe.skipIf(!LIVE)('imagination concurrency — the cap and the ledger, live', () => {
  it(
    'fires three concurrent calls on one mission and cap+1 across distinct missions, then reads the maximum overlap back from the ledger',
    { timeout: TIMEOUT_MS },
    async () => {
      // ── configuration, refused by name before anything is touched ─────────
      if (typeof capChoice === 'object') {
        throw new Error(`the concurrency live run is REFUSED: ${capChoice.refusal}`);
      }
      const user = text('IMAGINATION_CONCURRENCY_USER');
      const out = text('IMAGINATION_CONCURRENCY_OUT');
      if (!user || !out) {
        throw new Error(
          'the concurrency live run is REFUSED: IMAGINATION_CONCURRENCY_USER and IMAGINATION_CONCURRENCY_OUT are both ' +
            'required — this instrument never defaults an identity or an output path (they are deployment data, and a ' +
            'default would silently write a live run under the wrong owner or over the wrong file)',
        );
      }
      if (existsSync(out)) {
        throw new Error(
          `the concurrency live run is REFUSED: ${out} already exists — an evidence file is written once; choose a new ` +
            'path (the run is idempotent, the file is not)',
        );
      }
      const startedRunAt = new Date();
      const runToken = runTokenFromEnv(process.env, startedRunAt);
      if (typeof runToken === 'object') {
        throw new Error(`the concurrency live run is REFUSED: ${runToken.refusal}`);
      }
      const lookback = wholeNumber(process.env, 'IMAGINATION_CONCURRENCY_LOOKBACK_MS', DEFAULT_LOOKBACK_MS);
      if (typeof lookback === 'object') {
        throw new Error(`the concurrency live run is REFUSED: ${lookback.refusal}`);
      }

      // ── the progress file: durable marks, written as they happen ─────────
      //
      // A live run takes minutes and can fail at any step; the capture itself is
      // only written once everything is read, so a failed run must still say
      // exactly how far it got.
      const progressPath = `${out}.progress.log`;
      const marks: Array<{ at: string; step: string; detail?: string }> = [];
      const mark = (step: string, detail?: string): void => {
        const entry = { at: new Date().toISOString(), step, ...(detail ? { detail } : {}) };
        marks.push(entry);
        const line = `${entry.at} ${step}${entry.detail ? ` — ${entry.detail}` : ''}`;
        console.error(`[concurrency-live] ${line}`);
        try {
          const parent = path.dirname(progressPath);
          if (parent && parent !== '.' && !existsSync(parent)) mkdirSync(parent, { recursive: true });
          appendFileSync(progressPath, `${line}\n`);
        } catch (error) {
          console.error(`[concurrency-live] the progress file could not be appended: ${messageOf(error)}`);
        }
      };

      // ── the services, imported AFTER the cap and the flags are set ────────
      const connection = await import('../../src/database/connection.js');
      const { llmService } = await import('../../src/services/infrastructure/llm-service.js');
      const { runImaginationCycle } = await import(
        '../../src/services/processing/imagination-cycle-service.js'
      );
      const { DEFAULT_MAX_CONCURRENT_CYCLES, maxConcurrentCycles } = await import(
        '../../src/services/processing/imagination-cycle-config.js'
      );
      const { CONCURRENCY_CAP_REASON } = await import(
        '../../src/services/processing/executive-imagination-bridge.js'
      );
      const { CREATIVE_BATON_COLLECTIONS } = await import(
        '../../src/services/processing/creative-baton-collections.js'
      );
      const { IMAGINATION_COLLECTIONS } = await import('../../src/services/processing/imagination-collections.js');
      const { COLLECTIONS } = await import('../../src/services/mission-cognition/collections.js');
      const { SCENARIO_MISSION, seedScenario } = await import('../helpers/imagination-scenario.js');

      const cap = capInForce;
      if (DEFAULT_MAX_CONCURRENT_CYCLES !== MIRRORED_DEFAULT_CAP) {
        throw new Error(
          `the concurrency live run is REFUSED: this file mirrors the shipped default cap as ${MIRRORED_DEFAULT_CAP}, ` +
            `but DEFAULT_MAX_CONCURRENT_CYCLES is now ${DEFAULT_MAX_CONCURRENT_CYCLES} — the mirrored literal has drifted ` +
            'and a default-cap run would measure the wrong number; update the mirror before running',
        );
      }
      if (maxConcurrentCycles() !== cap) {
        throw new Error(
          `the concurrency live run is REFUSED: this process was configured with ${SHIPPED_CAP_ENV}=${cap} before the ` +
            `services were imported, but maxConcurrentCycles() reads ${maxConcurrentCycles()} — the cap this run would ` +
            'measure is not the cap it chose',
        );
      }

      // The run is NAMESPACED: the identity and every mission id carry the run
      // token, so nothing this run writes can collide with, exclude or
      // contaminate a deployment's own rows — and the ledger read for this
      // run's own scope is exactly this run's rows.
      const identity = `${user}-${runToken}-concurrency`;
      const missionA1 = `${SCENARIO_MISSION}_${runToken}`;
      const missionsA1 = [missionA1];
      const missionsA2 = Array.from(
        { length: cap + 1 },
        (_value, index) => `${SCENARIO_MISSION}_${runToken}_cap_${index + 1}`,
      );
      const allMissions = [...missionsA1, ...missionsA2];
      // Round A1's call list: the SAME mission three times, on purpose — the
      // concurrent same-mission callers are what the single-flight slot joins.
      const a1CallMissions = [missionA1, missionA1, missionA1];
      const caller = { user_id: identity, trusted: true };
      const invocation = {
        call: 'runImaginationCycle(db, { userId, missionId, actorId, caller, force, trigger })',
        user_id: identity,
        actor_id: identity,
        caller,
        force: true,
        trigger: TRIGGER,
        note:
          'force overrides the PLATEAU gate only (RunCycleArgs.force); the single-flight gate, the global cap, the ' +
          'persisted cooldown and the per-mission window budget all still apply in their shipped order',
      };
      mark(
        'run started',
        `run '${runToken}', identity '${identity}', cap ${cap} (${SHIPPED_CAP_ENV}), missions ${allMissions.join(', ')}`,
      );

      // ── the real store ────────────────────────────────────────────────────
      let db: Db | null = null;
      try {
        db = await connection.connect_to_mongodb();
        if (!db && connection.is_database_connected()) db = connection.get_database();
      } catch (error) {
        throw new Error(
          `the concurrency live run is REFUSED: the store could not be reached — ${messageOf(error)} (MONGODB_URI / ` +
            'DATABASE_NAME must name the store this instrument may read and write)',
        );
      }
      if (!db || !connection.is_database_connected()) {
        throw new Error(
          'the concurrency live run is REFUSED: connect_to_mongodb() returned no database, or the connection reports it ' +
            'is not connected',
        );
      }
      const liveDb: Db = db;
      mark('store connected', `database '${liveDb.databaseName}' on ${hostname()}`);

      // ── the real model, named and required ────────────────────────────────
      //
      // A cycle is a multi-call model workload and seeding a scenario makes a
      // real focused-consolidation call: with no provider there is nothing to
      // measure, so the run refuses instead of capturing empty cycles.
      const modelStartedMs = Date.now();
      let model = llmService.getServiceStatus();
      while (!model.available && Date.now() - modelStartedMs < 120_000) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        model = llmService.getServiceStatus();
      }
      if (!model.available) {
        throw new Error(
          `the concurrency live run is REFUSED: llmService.getServiceStatus().available is false — ` +
            `${JSON.stringify({ provider: model.provider, model: model.model, providers: model.providers, waited_ms: Date.now() - modelStartedMs })}. ` +
            'The cycle and the seeded fixture both need the real provider.',
        );
      }
      mark('model available', `${model.provider}/${model.model} (waited ${Date.now() - modelStartedMs}ms)`);

      const store = new LiveSeedStore(liveDb);
      const nowMs = () => Date.now();

      // ── the run token must be fresh ───────────────────────────────────────
      const usedMissions = (await liveDb
        .collection(String(COLLECTIONS.missionStates))
        .find({ mission_id: { $in: allMissions } }, { projection: { _id: 0, mission_id: 1 } })
        .toArray()) as Array<{ mission_id?: string }>;
      const identityRowsAlready = await liveDb
        .collection(CREATIVE_BATON_COLLECTIONS.cycles)
        .countDocuments({ user_id: identity });
      if (usedMissions.length > 0 || identityRowsAlready > 0) {
        throw new Error(
          `the concurrency live run is REFUSED: run token '${runToken}' has already been used — ` +
            `${usedMissions.length} mission(s) exist (${usedMissions.map((row) => String(row.mission_id)).sort().join(', ')}) ` +
            `and the run-scoped identity '${identity}' already has ${identityRowsAlready} cycle row(s). Pick a fresh ` +
            'IMAGINATION_CONCURRENCY_RUN; this instrument never reuses or overwrites a run’s rows',
        );
      }

      // ── the ledger window, bounded BEFORE anything is spent ───────────────
      //
      // The overlap sweep is a bounded read: the refusal has to come before the
      // cycles run, not after, or an expensive run would end by throwing its own
      // evidence away. The window starts before the fixture is seeded, so it is a
      // superset of everything this run will write (and is recorded in the
      // capture).
      const windowStartIso = new Date(startedRunAt.getTime() - lookback).toISOString();
      const ledgerWindowRows = {
        identity: await liveDb
          .collection(CREATIVE_BATON_COLLECTIONS.cycles)
          .countDocuments({ user_id: user, created_at: { $gte: windowStartIso } }),
        collection: await liveDb
          .collection(CREATIVE_BATON_COLLECTIONS.cycles)
          .countDocuments({ created_at: { $gte: windowStartIso } }),
      };
      if (ledgerWindowRows.identity > MAX_LEDGER_ROWS || ledgerWindowRows.collection > MAX_LEDGER_ROWS) {
        throw new Error(
          `the concurrency live run is REFUSED before spending anything: the ${Math.round(lookback / 3_600_000)}h ledger ` +
            `window already holds more rows (identity '${user}': ${ledgerWindowRows.identity}, collection: ` +
            `${ledgerWindowRows.collection}) than the ${MAX_LEDGER_ROWS} this instrument will sweep — narrow ` +
            'IMAGINATION_CONCURRENCY_LOOKBACK_MS deliberately',
        );
      }
      mark(
        'ledger window bounded',
        `identity '${user}' ${ledgerWindowRows.identity} row(s), collection ${ledgerWindowRows.collection} row(s) since ${windowStartIso}`,
      );

      // ── the fixture: the ITER-7 scenario, re-seeded under this run ────────
      //
      // The store's `from_to_type` index on knowledge_relationships is GLOBAL, so
      // every seeding carries its own graph id prefix (the baseline instrument's
      // rule, per mission here because every mission gets its own graph).
      for (const [index, missionId] of allMissions.entries()) {
        await seedScenario(store.asFakeDb(), {
          ownerId: identity,
          missionId,
          idPrefix: `${runToken}-m${index + 1}-`,
        });
        mark('scenario seeded', `${missionId} (owner ${identity}, own graph prefix)`);
      }
      await store.flush();
      mark('fixture flushed', `${allMissions.length} mission(s) seeded; scenario work item and graphs inserted`);

      // ── the store's own counts, taken BEFORE any cycle runs ───────────────
      const countNow = async () => ({
        cycles: await liveDb.collection(CREATIVE_BATON_COLLECTIONS.cycles).countDocuments({ user_id: identity }),
        seeds: await liveDb.collection(IMAGINATION_COLLECTIONS.ideaSeeds).countDocuments({ user_id: identity }),
        mission_states: await liveDb
          .collection(String(COLLECTIONS.missionStates))
          .countDocuments({ mission_id: { $in: allMissions } }),
      });

      const before = await countNow();
      mark(
        'store counted (before the rounds)',
        `${before.cycles} cycle row(s), ${before.seeds} seed(s), ${before.mission_states} mission state(s) for '${identity}'`,
      );

      // ── the calls, fired in ONE synchronous turn each round ───────────────
      //
      // `runImaginationCycle` takes its slot (and applies the global cap) BEFORE
      // its first `await`, so a round issued in one synchronous turn is decided
      // by the CALL ORDER, not by the store's or the model's latency: the first
      // `cap` distinct-mission calls take slots, the next is refused without
      // reading anything, and a second call for a mission whose slot is held
      // joins it. No sleep, no retry, no race window; the only nondeterminism is
      // how long the model takes.
      const fireRound = (
        round: string,
        missionIds: string[],
      ): Promise<Array<{ mission_id: string; index: number; result: Row | null; rejected: string | null; elapsed_ms: number }>> => {
        const issuedAt = Date.now();
        const calls = missionIds.map((missionId, index) => {
          const promise = runImaginationCycle(liveDb, {
            userId: identity,
            missionId,
            actorId: identity,
            caller,
            force: true,
            trigger: TRIGGER,
          });
          return promise.then(
            (result) => ({ mission_id: missionId, index, result: result as unknown as Row, rejected: null, elapsed_ms: Date.now() - issuedAt }),
            (error) => ({ mission_id: missionId, index, result: null, rejected: messageOf(error), elapsed_ms: Date.now() - issuedAt }),
          );
        });
        mark(`${round} fired`, `${missionIds.length} concurrent call(s): ${missionIds.join(', ')}`);
        return Promise.all(calls);
      };

      type Disposition = 'ran' | 'failed' | 'refused_by_cap' | 'joined_single_flight' | 'rejected' | 'unrecognised';
      interface CallRecord {
        round: string;
        mission_id: string;
        index: number;
        status: string | null;
        reason: string | null;
        cycle_id: string | null;
        stop_reason: string | null;
        error: string | null;
        concurrency: Row | null;
        disposition: Disposition;
        verbatim: string;
        elapsed_ms: number;
      }

      const classify = (round: string, raw: Awaited<ReturnType<typeof fireRound>>[number]): CallRecord => {
        const result = raw.result;
        const status = result ? String(result.status) : null;
        const reason = result ? String(result.reason) : null;
        let disposition: Disposition;
        if (raw.rejected !== null) disposition = 'rejected';
        else if (status === 'ran') disposition = 'ran';
        else if (status === 'failed') disposition = 'failed';
        else if (status === 'skipped' && reason === CONCURRENCY_CAP_REASON) disposition = 'refused_by_cap';
        else if (status === 'replayed' && reason === 'single_flight_join') disposition = 'joined_single_flight';
        else disposition = 'unrecognised';
        return {
          round,
          mission_id: raw.mission_id,
          index: raw.index,
          status,
          reason,
          cycle_id: result ? (result.cycle_id ?? null) : null,
          stop_reason: result ? (result.stop_reason ?? null) : null,
          error: raw.rejected ?? (result ? (result.error ?? null) : null),
          concurrency: result ? (result.concurrency ?? null) : null,
          disposition,
          verbatim:
            raw.rejected !== null
              ? `runImaginationCycle REJECTED — ${raw.rejected}`
              : `status '${status}' / reason '${reason}'`,
          elapsed_ms: raw.elapsed_ms,
        };
      };

      const a1Raw = await fireRound('round A1 (one mission, three concurrent calls)', a1CallMissions);
      const a1 = a1Raw.map((call) => classify('A1_single_mission', call));
      mark(
        'round A1 settled',
        a1.map((call) => `${call.index + 1}: ${call.verbatim}`).join(' | '),
      );

      const a2Raw = await fireRound(`round A2 (cap+1 = ${cap + 1} distinct missions)`, missionsA2);
      const a2 = a2Raw.map((call) => classify('A2_cap', call));
      mark(
        'round A2 settled',
        a2.map((call) => `${call.index + 1}: ${call.verbatim}`).join(' | '),
      );

      const calls = [...a1, ...a2];

      // ── the store's own counts, taken AFTER the rounds ────────────────────
      const ledgerRows = (await liveDb
        .collection(CREATIVE_BATON_COLLECTIONS.cycles)
        .find({ user_id: identity }, { projection: { _id: 0 } })
        .sort({ created_at: 1 })
        .toArray()) as unknown as Row[];
      const after = await countNow();
      const afterMs = nowMs();

      // NOTHING IS DELETED: these collections can only grow over the run, and
      // the capture says so with the same numbers.
      expect(after.cycles, 'NOTHING IS DELETED: this run adds rows, it removes none').toBeGreaterThanOrEqual(before.cycles);
      expect(after.seeds, 'NOTHING IS DELETED: the seed archive can only grow').toBeGreaterThanOrEqual(before.seeds);
      expect(after.mission_states, 'NOTHING IS DELETED: the seeded missions are still in the store').toBeGreaterThanOrEqual(
        before.mission_states,
      );
      mark(
        'store counted (after the rounds)',
        `${after.cycles} cycle row(s), ${after.seeds} seed(s), ${after.mission_states} mission state(s); ` +
          `${ledgerRows.length} row(s) read back`,
      );

      // ── the ledger's own record: the maximum overlap, per scope ───────────
      // The window (`windowStartIso`, bounded before the fixture was seeded) is a
      // superset of every row this run wrote.
      const deployedRows = (await liveDb
        .collection(CREATIVE_BATON_COLLECTIONS.cycles)
        .find({ user_id: user, created_at: { $gte: windowStartIso } }, { projection: { _id: 0 } })
        .sort({ created_at: 1 })
        .limit(MAX_LEDGER_ROWS + 1)
        .toArray()) as unknown as Row[];
      const collectionRows = (await liveDb
        .collection(CREATIVE_BATON_COLLECTIONS.cycles)
        .find({ created_at: { $gte: windowStartIso } }, { projection: { _id: 0 } })
        .sort({ created_at: 1 })
        .limit(MAX_LEDGER_ROWS + 1)
        .toArray()) as unknown as Row[];
      if (deployedRows.length > MAX_LEDGER_ROWS || collectionRows.length > MAX_LEDGER_ROWS) {
        throw new Error(
          `the concurrency live run is REFUSED at the ledger read: the ${Math.round(lookback / 3_600_000)}h window grew past ` +
            `the ${MAX_LEDGER_ROWS} rows this instrument sweeps between the pre-flight count and this read (identity: ` +
            `${deployedRows.length > MAX_LEDGER_ROWS}, collection: ${collectionRows.length > MAX_LEDGER_ROWS}) — re-run when ` +
            'the ledger is quieter, or narrow IMAGINATION_CONCURRENCY_LOOKBACK_MS deliberately',
        );
      }
      mark(
        'ledger read',
        `run scope ${ledgerRows.length} row(s); identity '${user}' ${deployedRows.length} row(s) since ${windowStartIso}; ` +
          `collection ${collectionRows.length} row(s) in the same window`,
      );

      const ledger: LedgerReport[] = [
        ledgerReport({
          scope: 'run_scoped_identity',
          description:
            `every imagination_cycles row of this run's own identity '${identity}' — the ledger's record of the ` +
            'concurrent calls this instrument just made',
          rows: ledgerRows,
          cap,
          nowMs: afterMs,
        }),
        ledgerReport({
          scope: 'deployed_identity',
          description:
            `every imagination_cycles row of the identity named in IMAGINATION_CONCURRENCY_USER ('${user}') created in ` +
            `the last ${Math.round(lookback / 3_600_000)}h — the deployment's own ledger, written by its tick and any ` +
            'other process',
          rows: deployedRows,
          cap,
          nowMs: afterMs,
        }),
        ledgerReport({
          scope: 'collection_window',
          description:
            `every imagination_cycles row in the store created in the last ${Math.round(lookback / 3_600_000)}h, ` +
            'whatever identity wrote it — the widest ledger-side view the cap can be checked against',
          rows: collectionRows,
          cap,
          nowMs: afterMs,
        }),
      ];
      for (const report of ledger) {
        mark(
          `overlap — ${report.scope}`,
          `maximum overlap ${report.maximum_overlap} of at most ${report.ceiling_used} (configured cap ${report.configured_cap}) ` +
            `over ${report.rows_swept} swept row(s), ${report.rows_excluded_without_declared_cap.length} excluded for no ` +
            `declared cap, ${report.rows_still_in_flight_at_read.length} still in flight at read`,
        );
      }

      // ── the checks: a violation FAILS the run ────────────────────────────
      const violations: Row[] = [];
      const notes: string[] = [];
      const fail = (kind: string, detail: Row) => violations.push({ kind, ...detail });

      for (const call of calls) {
        if (call.disposition === 'rejected') {
          fail('call_rejected', {
            round: call.round,
            mission_id: call.mission_id,
            verbatim: call.verbatim,
            note: 'a cycle call that THREW is never a pass — the run cannot claim the cap held if a call never got as far as a gate',
          });
        }
        if (call.disposition === 'unrecognised') {
          fail('unrecognised_outcome', {
            round: call.round,
            mission_id: call.mission_id,
            status: call.status,
            reason: call.reason,
            note:
              `this run recognises only the shipped pairs: {status 'ran'}, {status 'failed'}, ` +
              `{status 'skipped', reason '${CONCURRENCY_CAP_REASON}'} and {status 'replayed', reason 'single_flight_join'}`,
          });
        }
        if (call.disposition === 'failed') {
          fail('cycle_failed', {
            round: call.round,
            mission_id: call.mission_id,
            cycle_id: call.cycle_id,
            stop_reason: call.stop_reason,
            error: call.error,
            note: 'a cycle that ran and failed is reported by name; the cap observation is not reported as clean over it',
          });
        }
      }

      // Round A1 — ONE mission, THREE concurrent calls: exactly one may take the
      // mission's slot; the others JOIN it. The cap can never refuse a same-
      // mission call (its gate is checked first), so this round is also the
      // evidence that the cap did not break the join.
      const a1Started = a1.filter((call) => call.disposition === 'ran' || call.disposition === 'failed');
      const a1Joined = a1.filter((call) => call.disposition === 'joined_single_flight');
      if (a1Started.length > cap) {
        fail('cap_exceeded', {
          round: 'A1_single_mission',
          started: a1Started.length,
          cap,
          note: 'more cycles reached a terminal state than the cap permits',
        });
      }
      if (a1Started.length !== 1) {
        fail('single_mission_slot_not_single', {
          round: 'A1_single_mission',
          started: a1Started.length,
          expected: 1,
          calls: a1.map((call) => call.verbatim),
        });
      }
      if (a1Joined.length !== A1_CONCURRENT_CALLS - 1) {
        fail('join_not_observed', {
          round: 'A1_single_mission',
          joined: a1Joined.length,
          expected: A1_CONCURRENT_CALLS - 1,
          calls: a1.map((call) => call.verbatim),
        });
      }

      // Round A2 — cap+1 concurrent calls across cap+1 DISTINCT missions: at most
      // `cap` may reach a terminal state and every other call must carry the
      // shipped cap refusal, verbatim, and leave nothing behind.
      const a2Started = a2.filter((call) => call.disposition === 'ran' || call.disposition === 'failed');
      const a2Refused = a2.filter((call) => call.disposition === 'refused_by_cap');
      if (a2Started.length > cap) {
        fail('cap_exceeded', {
          round: 'A2_cap',
          started: a2Started.length,
          cap,
          verbatim: a2.map((call) => call.verbatim),
        });
      }
      if (a2Started.length !== cap || a2Refused.length !== a2.length - cap) {
        fail('cap_not_observed', {
          round: 'A2_cap',
          started: a2Started.length,
          refused_by_cap: a2Refused.length,
          expected_started: cap,
          expected_refused: a2.length - cap,
          verbatim: a2.map((call) => call.verbatim),
        });
      }
      for (const call of a2Refused) {
        const concurrency = call.concurrency ?? {};
        if (concurrency.capped !== true || Number(concurrency.max_concurrent_cycles) !== cap) {
          fail('cap_refusal_reading_wrong', {
            round: 'A2_cap',
            mission_id: call.mission_id,
            concurrency,
            note: `a call refused by the cap must report the reading it was refused under: capped true, max_concurrent_cycles ${cap}`,
          });
        }
        if (call.cycle_id !== null) {
          fail('refusal_claimed_a_cycle', {
            round: 'A2_cap',
            mission_id: call.mission_id,
            cycle_id: call.cycle_id,
            note: 'the shipped refusal reads nothing, claims no cycle and writes no row — it must return no cycle_id',
          });
        }
      }
      const refusedMissionIds = a2Refused.map((call) => call.mission_id);
      const perMissionRows = new Map<string, number>();
      for (const missionId of missionsA2) perMissionRows.set(missionId, 0);
      for (const row of ledgerRows) {
        const missionId = String(row.mission_id);
        if (perMissionRows.has(missionId)) perMissionRows.set(missionId, (perMissionRows.get(missionId) ?? 0) + 1);
      }
      for (const missionId of missionsA2) {
        const rows = perMissionRows.get(missionId) ?? 0;
        if (refusedMissionIds.includes(missionId) && rows !== 0) {
          fail('refusal_wrote_a_row', {
            round: 'A2_cap',
            mission_id: missionId,
            rows,
            note: 'the ledger holds a row for a mission whose only call in this round was REFUSED by the cap',
          });
        }
        if (!refusedMissionIds.includes(missionId) && rows !== 1) {
          fail('claim_row_count', {
            round: 'A2_cap',
            mission_id: missionId,
            rows,
            expected: 1,
            note: 'a mission whose call took a slot must have exactly one cycle row (the claim it wrote)',
          });
        }
      }

      const claimedCycleIds = new Set(
        calls
          .filter((call) => call.disposition === 'ran' || call.disposition === 'failed')
          .map((call) => String(call.cycle_id)),
      );
      const rowsDelta = after.cycles - before.cycles;
      if (rowsDelta !== claimedCycleIds.size) {
        fail('ledger_row_count', {
          rows_before: before.cycles,
          rows_after: after.cycles,
          rows_delta: rowsDelta,
          cycles_that_claimed: claimedCycleIds.size,
          note: 'the ledger must hold exactly one row per cycle that claimed, and none for a refusal',
        });
      }

      const a2RowReadings = ledgerRows
        .filter((row) => missionsA2.includes(String(row.mission_id)))
        .map((row) => Number(row.concurrency?.in_flight_after))
        .filter((value) => Number.isFinite(value));
      const maxRecordedInFlight = a2RowReadings.length > 0 ? Math.max(...a2RowReadings) : null;
      if (maxRecordedInFlight !== cap) {
        fail('recorded_in_flight_reading', {
          observed: maxRecordedInFlight,
          expected: cap,
          readings: a2RowReadings,
          note:
            'each row carries the reading its call held its slot under (the shipped `concurrency` record); with cap+1 ' +
            'calls issued in one synchronous turn the maximum recorded in_flight_after must be the cap',
        });
      }

      for (const report of ledger) {
        if (report.rows_excluded_unparseable_instants.length > 0) {
          const detail = {
            scope: report.scope,
            cycle_ids: report.rows_excluded_unparseable_instants,
            note: 'a row whose instants cannot be parsed cannot be swept, so the overlap would be under-stated silently',
          };
          if (report.scope === 'run_scoped_identity') {
            // A row THIS run wrote must be readable: if it is not, the run's own
            // ledger cannot be trusted and the run fails by name.
            fail('ledger_row_unreadable_instant', detail);
          } else {
            // A row another process wrote (legacy data, a schema this version
            // does not know): the sweep excludes it and the capture lists it, so
            // the exclusion is visible rather than silent, but the instrument
            // does not fail the whole observation over another system's row.
            notes.push(
              `the ${report.scope} scope holds ${report.rows_excluded_unparseable_instants.length} row(s) whose instants ` +
                `cannot be parsed (${report.rows_excluded_unparseable_instants.join(', ')}); they are excluded from that ` +
                'scope’s overlap sweep and listed in this capture',
            );
          }
        }
        if (report.exceeds_declared_ceiling) {
          fail('ledger_overlap_exceeds_cap', {
            scope: report.scope,
            maximum_overlap: report.maximum_overlap,
            configured_cap: report.configured_cap,
            ceiling_used: report.ceiling_used,
            at: report.maximum_overlap_at,
            rows: report.maximum_overlap_rows,
            declared_caps_seen: report.declared_caps_seen,
            note: 'the ledger shows MORE cycles in flight at once than the cap allows — the bound did not hold',
          });
        }
      }

      const runScoped = ledger[0];
      if (runScoped && runScoped.maximum_overlap < cap) {
        notes.push(
          `this run's own ledger shows a maximum overlap of ${runScoped.maximum_overlap}, below the cap of ${cap}: the ` +
            "rows' own in_flight readings say up to " +
            `${runScoped.max_recorded_in_flight_after ?? 'unknown'} slots were held at claim time, so the ledger's window ` +
            '(claim → completion) can be narrower than the slot it describes',
        );
      }
      for (const report of ledger) {
        const otherCaps = report.declared_caps_seen.filter((declared) => declared !== cap);
        if (otherCaps.length > 0) {
          notes.push(
            `${report.scope}: rows declare cap(s) ${otherCaps.join(', ')} besides this run's ${cap}, so the overlap was ` +
              `compared against the largest declared cap (${report.ceiling_used}) — the bound that bound a process is the ` +
              'one it declared on its own rows',
          );
        }
      }
      const deployed = ledger[1];
      if (deployed && deployed.rows_in_scope === 0) {
        notes.push(
          `the deployment's ledger holds NO rows for identity '${user}' in the last ${Math.round(lookback / 3_600_000)}h, so ` +
            'this run carries no cross-process evidence beyond its own rows — the tick may write under other identities, ' +
            'or may not have run in the window',
        );
      }
      if (deployed && deployed.rows_excluded_without_declared_cap.length > 0) {
        notes.push(
          `${deployed.rows_excluded_without_declared_cap.length} row(s) of identity '${user}' declare no cap and were ` +
            'excluded from the enforceable sweep (the cap knob is younger than the ledger)',
        );
      }

      // ── the capture, written ONCE ────────────────────────────────────────
      const finishedAt = new Date().toISOString();
      const roundSummary = (round: string, records: CallRecord[]) => ({
        round,
        calls: records.length,
        mission_ids: records.map((record) => record.mission_id),
        ran: records.filter((record) => record.disposition === 'ran').length,
        failed: records.filter((record) => record.disposition === 'failed').length,
        refused_by_cap: records.filter((record) => record.disposition === 'refused_by_cap').length,
        joined_single_flight: records.filter((record) => record.disposition === 'joined_single_flight').length,
        unrecognised: records.filter((record) => record.disposition === 'unrecognised').length,
        rejected: records.filter((record) => record.disposition === 'rejected').length,
        elapsed_ms: records.reduce((longest, record) => Math.max(longest, record.elapsed_ms), 0),
      });

      const capture = {
        instrument: 'server/tests/live/imagination-concurrency-live.test.ts',
        kind: 'imagination_concurrency_live',
        capture: {
          kind: 'imagination_concurrency_live',
          verdict:
            violations.length === 0
              ? `PASSED — the cap of ${cap} held for every call this run made, and the ledger's own maximum overlap of ` +
                `cycles in flight (${runScoped?.maximum_overlap ?? 'n/a'} this run, ${deployed?.maximum_overlap ?? 'n/a'} ` +
                `for '${user}') did not exceed it`
              : `FAILED — ${violations.length} violation(s); see this capture's violations (the evidence was written before the assertions ran)`,
          summary:
            `one bounded live observation of the shipped global concurrency cap (${SHIPPED_CAP_ENV}=${cap}, ` +
            `${typeof capChoice === 'number' && text('IMAGINATION_CONCURRENCY_CAP') !== null ? 'an explicit override' : 'the shipped default'}): ` +
            `round A1 fired ${A1_CONCURRENT_CALLS} concurrent runImaginationCycle calls at ONE mission of identity ` +
            `'${identity}' (${roundSummary('A1_single_mission', a1).ran} ran, ` +
            `${roundSummary('A1_single_mission', a1).joined_single_flight} joined the running cycle); round A2 fired ` +
            `${a2.length} concurrent calls across ${missionsA2.length} DISTINCT missions (${roundSummary('A2_cap', a2).ran} ran, ` +
            `${roundSummary('A2_cap', a2).refused_by_cap} refused by the cap with reason '${CONCURRENCY_CAP_REASON}'), and the ` +
            'ledger was then read back to compute the maximum number of cycles that were in flight at once.',
          disclosure: [
            `WHAT RAN: this process seeded ${allMissions.length} mission(s) of the shipped ITER-7 scenario ` +
              `(seedScenario, real focused-consolidation trace per mission) under the run-scoped identity '${identity}', ` +
              `then made ${calls.length} concurrent runImaginationCycle calls with force: true — ${A1_CONCURRENT_CALLS} at ` +
              `one mission, then ${a2.length} across ${missionsA2.length} distinct missions. The exact arguments are in ` +
              'this capture\'s invocation block; every call went to the REAL store and the REAL model, and there is no ' +
              'mock of the connection anywhere in the instrument.',
            `THE CAP AND WHERE IT CAME FROM: ${SHIPPED_CAP_ENV} was set to ${cap} by the INSTRUMENT, in its module body, ` +
              `before any service was imported — from ${text('IMAGINATION_CONCURRENCY_CAP') === null ? `the shipped default (DEFAULT_MAX_CONCURRENT_CYCLES=${DEFAULT_MAX_CONCURRENT_CYCLES})` : `the explicit IMAGINATION_CONCURRENCY_CAP=${text('IMAGINATION_CONCURRENCY_CAP')}`} ` +
              `— and maxConcurrentCycles() read ${maxConcurrentCycles()} in this process. It is a PER-PROCESS bound ` +
              '(docs/IMAGINATION-ROLLOUT.md: "cycles in flight at once across every identity and mission in this ' +
              'process"); nothing outside this process was configured or changed.',
            'FLAGS IN THE INSTRUMENT PROCESS ONLY: FOCUSED_IMAGINATION=1 and CREATIVE_BATON_PROMOTION=1 were set by this ' +
              'file for the length of this one process, as the other cycle-running instruments do; the deployment keeps ' +
              'its own values. No deployment configuration was read or written.',
            `EACH CALL'S OUTCOME, VERBATIM: this capture's calls carry every call\'s status/reason exactly as the service ` +
              `returned them. The only non-\'ran\' outcomes this run recognises are the SHIPPED refusals — ` +
              `{status: 'skipped', reason: '${CONCURRENCY_CAP_REASON}'} (the global cap: nothing read, no model call, no ` +
              `cycle claimed, no row written) and {status: 'replayed', reason: 'single_flight_join'} (a same-mission caller ` +
              'joining the running cycle) — plus {status: \'failed\'} where a cycle ran and failed. Anything else is a ' +
              'VIOLATION in this capture, not a note.',
            `THE OVERLAP AND THE ROWS IT CAME FROM: for each scope (this run\'s own identity; the identity named in ` +
              `IMAGINATION_CONCURRENCY_USER over the last ${Math.round(lookback / 3_600_000)}h; and the whole collection in ` +
              'the same window) this capture lists the rows it read and the maximum number of cycles in flight at once, ' +
              'computed from those rows\' own created_at (start) and completed_at (end). The window is HALF-OPEN ' +
              '[created_at, completed_at): ends are processed before starts at the same instant, so two windows that only ' +
              'touch are not counted as overlap; a row with completed_at null is swept to the read instant and is listed as ' +
              'still in flight; a row that declares no concurrency.max_concurrent_cycles is EXCLUDED from the enforceable ' +
              'sweep and listed, because the cap is younger than the ledger. That same-mode/read-boundary arithmetic is ' +
              'what makes this the LOWER bound it is (see what this run does NOT establish).',
            `NOTHING WAS DELETED: this instrument deletes nothing. The store\'s own counts before and after the rounds ` +
              `(${before.cycles} → ${after.cycles} cycle rows, ${before.seeds} → ${after.seeds} seed rows, ` +
              `${before.mission_states} → ${after.mission_states} mission states for '${identity}') are in this capture\'s ` +
              'store block, the ledger holds exactly one row per cycle that actually claimed, and the rows this run wrote ' +
              'are listed by id so a person can clean them up deliberately afterwards.',
            'ONE BOUNDED OBSERVATION, NOT A SOAK: this is a single run, in a single process, on a single host, that made at ' +
              `most ${calls.length} concurrent calls and ${allMissions.length + calls.length} model-touching operations in ` +
              'total, once. It is a spot measurement of the bound under a handful of simultaneous cycles, not a load test.',
            'WHAT IT DOES NOT ESTABLISH: (a) it does not prove behaviour under sustained load, over hours or days, or ' +
              "across the executive tick's own cadence — a single observation cannot; (b) the cap is a PER-PROCESS " +
              'counter, so two processes (two hosts, or the deployment and this instrument) may each hold up to the cap ' +
              'and the ledger would legitimately show up to twice it — this run did not test two processes and its sweep ' +
              'compares against the largest cap the writing rows themselves declared; (c) the ledger\'s overlap is a LOWER ' +
              "bound on the true in-flight overlap, because a slot is taken before the row's created_at (index creation " +
              'and the cooldown/budget/plateau gates) and released after its completed_at; (d) it says nothing about model ' +
              'quality, novelty, cost or the tick\'s behaviour; (e) it ran against the one store MONGODB_URI names, in the ' +
              'one process this test file runs in.',
          ],
          cap: {
            env_knob: SHIPPED_CAP_ENV,
            in_force: cap,
            source:
              text('IMAGINATION_CONCURRENCY_CAP') === null
                ? `default: the shipped DEFAULT_MAX_CONCURRENT_CYCLES (${DEFAULT_MAX_CONCURRENT_CYCLES}) mirrored in this file and re-checked against the shipped constant at run time`
                : `override: IMAGINATION_CONCURRENCY_CAP=${text('IMAGINATION_CONCURRENCY_CAP')}`,
            raw_override: text('IMAGINATION_CONCURRENCY_CAP'),
            shipped_default_constant: DEFAULT_MAX_CONCURRENT_CYCLES,
            accessor_read: maxConcurrentCycles(),
            refusal_reason_for_a_capped_call: CONCURRENCY_CAP_REASON,
            refusal_reason_source: 'src/services/processing/executive-imagination-bridge.ts CONCURRENCY_CAP_REASON',
          },
          invocation,
          rounds: [roundSummary('A1_single_mission', a1), roundSummary('A2_cap', a2)],
          calls,
          ledger,
          store: {
            identity,
            missions: { a1: missionsA1, a2: missionsA2, seeded: allMissions },
            counts_before: before,
            counts_after: after,
            ledger_window_rows_at_preflight: ledgerWindowRows,
            rows_delta: rowsDelta,
            cycles_that_claimed: claimedCycleIds.size,
            per_mission_row_counts: Object.fromEntries(perMissionRows),
            rows_written_by_this_run: ledgerRows.map((row) => ({
              cycle_id: String(row.cycle_id ?? ''),
              mission_id: String(row.mission_id ?? ''),
              status: String(row.status ?? ''),
              created_at: row.created_at ?? null,
              completed_at: row.completed_at ?? null,
            })),
            note: 'nothing was deleted: the counts can only grow, the assertion is above in the run, and the numbers are repeated here',
          },
          violations,
          notes,
          environment: {
            store: {
              kind: 'mongodb',
              database: liveDb.databaseName,
              connection: 'src/database/connection.ts connect_to_mongodb()',
            },
            model,
            host: hostname(),
            user,
            run_token: runToken,
            run_token_source: text('IMAGINATION_CONCURRENCY_RUN') === null ? 'clock-derived default (pure function of the env record and the instant)' : 'IMAGINATION_CONCURRENCY_RUN',
            identity,
            lookback_ms: lookback,
            window_start: windowStartIso,
            started_at: startedRunAt.toISOString(),
            finished_at: finishedAt,
            pipeline: marks,
          },
        },
      };

      const parent = path.dirname(out);
      if (parent && parent !== '.' && !existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(out, `${JSON.stringify(capture, null, 2)}\n`);
      mark('capture written', out);

      expect(
        violations,
        `the concurrency live run FAILED by name: ${violations.map((violation) => String(violation.kind)).join(', ')} ` +
          `(the evidence is in ${out}, written before this assertion ran)`,
      ).toEqual([]);
    },
  );
});
