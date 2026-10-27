/**
 * The executive's imagination sweep — the plateau trigger INSIDE the existing
 * tick (ITER-11, WS-1 item 2 · brief §6.1 item 4).
 *
 * Before this iteration the cycle was PULL-ONLY: nothing autonomous ever
 * triggered it, and `autonomous-executive.ts` was not touched at all. This
 * module is the wiring — and it is deliberately the thinnest possible one:
 *
 *   - it runs from inside the executive's EXISTING tick, so the tick's own
 *     single-flight (`ticking`) guard and cadence are the authority/liveness
 *     gates that bound it. The sweep adds no gate of its own and removes none;
 *   - it is FLAG-GATED on `FOCUSED_IMAGINATION` and fails closed: with the
 *     flag off it touches no collection, calls no model and writes nothing;
 *   - it is scoped to the identities the executive ALREADY serves
 *     (`LOCAL_AGENT_ID` + `ALLOCATION_CANDIDATES` — deployment data, not new
 *     product logic) and to the ACTIVE missions those identities own;
 *   - it EVALUATES the plateau for each of those missions first and only then
 *     runs the cycle, so a tick that finds no plateau spends no model call;
 *   - it runs AT MOST ONE cycle per tick: the moment a cycle actually runs
 *     (`ran`, `failed` or `replayed`) the sweep stops. A `skipped` verdict
 *     (cooldown, window budget, no plateau) does not consume the tick's slot,
 *     so a mission that is merely cooling down cannot block another one;
 *   - every failure — a per-mission read, the plateau, the cycle itself — is
 *     caught, recorded in the returned report and logged. The tick continues.
 *
 * The cycle's own gates are untouched and still apply in their contract order
 * (single-flight → global concurrency cap → persisted cooldown → window budget →
 * plateau → claim), so the executive cannot make a mission cycle more often than
 * a human caller could, and cannot start more concurrent cycles than the cap
 * allows. A refusal by the GLOBAL cap (`concurrency_cap`) STOPS the sweep for
 * this tick — the cap is process-wide, so retrying the remaining missions would
 * only be refused again — and the reading is reported (`capped: true`) instead
 * of being retried or silently dropped.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS } from '../mission-cognition/collections.js';
import { focusedImaginationEnabled } from './focused-consolidation-service.js';
import {
  evaluatePlateau,
  runImaginationCycle,
  type CycleConcurrencyRecord,
  type ImaginationCycleResult,
} from './imagination-cycle-service.js';

/** How many identities one tick may sweep. */
export const MAX_SWEEP_IDENTITIES = 8;
/** How many active missions per identity one tick may evaluate. */
export const MAX_SWEEP_MISSIONS = 3;
/** The trigger label the executive's cycles carry (never user input). */
export const EXECUTIVE_TRIGGER = 'executive_tick';
/**
 * The cycle's reason when the GLOBAL concurrency cap refused the slot. The sweep
 * treats it as a STOP: the cap is process-wide, so a refusal for one mission is
 * a refusal for every mission in this tick — the sweep stops calling and reports
 * the reading instead of re-asking the cap once per remaining mission.
 */
export const CONCURRENCY_CAP_REASON = 'concurrency_cap';

export interface ExecutiveImaginationSweepResult {
  /** False when the family flag is off — then nothing at all was read. */
  enabled: boolean;
  identities: number;
  missions_evaluated: number;
  /** Cycles that actually ran/failed/joined (at most 1 per tick). */
  cycles_run: number;
  cycles: Array<{ user_id: string; mission_id: string; status: string; reason: string; cycle_id: string | null }>;
  /** Missions that were evaluated and did NOT run a cycle, with why. */
  skipped: Array<{ user_id: string; mission_id: string; reason: string }>;
  /** Failures, caught and named — the tick is never interrupted by them. */
  failures: Array<{ user_id: string; mission_id: string | null; error: string }>;
  /**
   * The GLOBAL concurrency reading this sweep ended on: the cap in force, the
   * in-flight count and whether this sweep took a slot. It is the reading of the
   * cycle the sweep ran, or of the refusal that stopped it (see `capped`).
   */
  concurrency: CycleConcurrencyRecord | null;
  /** True when the global cap refused this sweep a slot: nothing was started. */
  capped: boolean;
  basis: string;
}

/** The cycle runner's shape, so the injectable seam and the real one agree. */
export type SweepCycleRunner = (db: Db, args: never) => Promise<ImaginationCycleResult>;

export interface ExecutiveImaginationSweepDeps {
  db: Db;
  /**
   * The identities the executive serves — the tick passes its own
   * `ALLOCATION_CANDIDATES`. The fallback (no explicit list) is the local
   * identity from `KATRA_USER_ID`, read HERE rather than imported from the
   * executive so the two modules do not import each other.
   */
  userIds?: readonly string[];
  /** Test/embedding seam: the cycle runner. */
  runner?: SweepCycleRunner;
  /** Test seam: the clock, so a sweep reads it once. */
  now?: () => string;
  /** Test seam: the plateau evaluator. */
  plateau?: typeof evaluatePlateau;
}

function servedIdentities(explicit?: readonly string[]): string[] {
  const fallback = [process.env.KATRA_USER_ID || 'katra'];
  const source = explicit && explicit.length > 0 ? explicit : fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of source) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_SWEEP_IDENTITIES) break;
  }
  return out;
}

/**
 * Evaluate the plateau for the identities the executive serves and run AT MOST
 * ONE cycle per tick. Never throws: every failure is caught, recorded and
 * logged so the caller's tick continues.
 */
export async function runExecutiveImaginationSweep(
  deps: ExecutiveImaginationSweepDeps,
): Promise<ExecutiveImaginationSweepResult> {
  const enabled = focusedImaginationEnabled();
  const report: ExecutiveImaginationSweepResult = {
    enabled,
    identities: 0,
    missions_evaluated: 0,
    cycles_run: 0,
    cycles: [],
    skipped: [],
    failures: [],
    concurrency: null,
    capped: false,
    basis: enabled
      ? 'FOCUSED_IMAGINATION is on: active missions of the identities the executive serves, plateau evaluated first, at most one cycle per tick, and the cycle’s own global concurrency cap respected (a refusal stops the sweep)'
      : 'FOCUSED_IMAGINATION is off — nothing was read, no mission was evaluated and no cycle was run',
  };
  if (!enabled) return report;
  if (!deps?.db) {
    report.failures.push({ user_id: '', mission_id: null, error: 'no database handle was supplied' });
    return report;
  }

  const runner: SweepCycleRunner = deps.runner ?? ((db, args) => runImaginationCycle(db, args));
  const plateauOf = deps.plateau ?? evaluatePlateau;
  const now = deps.now ?? (() => new Date().toISOString());
  const identities = servedIdentities(deps.userIds);
  report.identities = identities.length;

  for (const userId of identities) {
    if (report.cycles_run > 0) break;
    let missionIds: string[] = [];
    try {
      const rows = (await deps.db
        .collection(COLLECTIONS.missionStates)
        .find({ owner_id: userId, status: 'active' }, { projection: { _id: 0, mission_id: 1 } })
        .sort({ mission_id: 1 })
        .limit(MAX_SWEEP_MISSIONS)
        .toArray()) as unknown as Array<{ mission_id?: unknown }>;
      missionIds = rows
        .map((row) => String(row.mission_id ?? '').trim())
        .filter((id) => id.length > 0);
    } catch (error) {
      report.failures.push({ user_id: userId, mission_id: null, error: errorText(error) });
      continue;
    }

    for (const missionId of missionIds) {
      if (report.cycles_run > 0) break;
      report.missions_evaluated += 1;
      try {
        const plateau = await plateauOf(deps.db, { userId, missionId, now });
        if (!plateau.plateau) {
          report.skipped.push({ user_id: userId, mission_id: missionId, reason: 'no_plateau' });
          continue;
        }
        const result = await runner(deps.db, {
          userId,
          missionId,
          trigger: EXECUTIVE_TRIGGER,
          actorId: userId,
          caller: { user_id: userId, trusted: false },
          now,
        } as never);
        if (result.concurrency) report.concurrency = result.concurrency;
        if (result.status === 'skipped') {
          report.skipped.push({ user_id: userId, mission_id: missionId, reason: result.reason });
          if (result.reason === CONCURRENCY_CAP_REASON) {
            // The cap is process-wide: every other mission would be refused too,
            // so the sweep stops here rather than asking once per mission. The
            // tick continues (this is a bound, not an error) and the reading is
            // reported with `capped: true`.
            report.capped = true;
            return report;
          }
          continue;
        }
        report.cycles_run += 1;
        report.cycles.push({
          user_id: userId,
          mission_id: missionId,
          status: result.status,
          reason: result.reason,
          cycle_id: result.cycle_id,
        });
      } catch (error) {
        // A mission whose read or cycle failed is recorded and the sweep moves
        // on: one broken mission must not stop the others, and the tick must
        // never be interrupted by the imagination engine.
        report.failures.push({ user_id: userId, mission_id: missionId, error: errorText(error) });
      }
    }
  }

  return report;
}

function errorText(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error);
}
