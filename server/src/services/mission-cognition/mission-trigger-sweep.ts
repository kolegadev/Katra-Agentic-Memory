// Periodic deterministic sweep over active missions (2026-10-23).
//
// Why this exists. The eight epistemic detectors were reachable from exactly two
// places: the `evaluate_triggers` MCP tool, which someone has to call, and
// focused consolidation, which costs a model call and only runs for a mission
// somebody already asked about. Nothing ever evaluated the portfolio. The
// consequence was measured on 2026-10-23: 30 active missions, 28 of them with no
// accepted delta for 25 days or more, three with none at all, and not one signal
// produced — because no detector looked at time and no loop looked at missions.
//
// Property of this sweep: it costs no model calls, writes one append-only record
// per run, and changes no mission state. It reports; it does not act. A stall is
// a trigger, not a stop.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import { evaluateTriggers, missionStallDays } from './uncertainty-triggers.js';
import type { FiredTrigger } from '../../types/cognitive-control.js';

export interface SweptMission {
  mission_id: string;
  owner_id?: string;
  version: number;
  fired: FiredTrigger[];
  by_trigger: Record<string, number>;
}

export interface TriggerSweepRecord {
  sweep_id: string;
  swept_at: string;
  stall_days: number;
  missions_scanned: number;
  missions_with_triggers: number;
  /** mission_ids where `mission_stalled` fired. The signal, in one place. */
  stalled: string[];
  missions: SweptMission[];
  errors: Array<{ mission_id: string; error: string }>;
}

const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Sweep cadence in ms. `0` disables the scheduled sweep. */
export function triggerSweepIntervalMs(): number {
  const raw = process.env.MISSION_TRIGGER_SWEEP_MS;
  if (raw === undefined || raw === '') return DEFAULT_SWEEP_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SWEEP_INTERVAL_MS;
}

/**
 * Evaluate every active mission once and persist the snapshot.
 *
 * `now` is injectable so the result is a pure function of state and clock input,
 * which is what makes the stall detector testable at all: the real condition is
 * "three weeks have passed", and a test cannot wait three weeks.
 */
export async function sweepActiveMissions(
  db: Db,
  opts: { now?: number; limit?: number; persist?: boolean } = {},
): Promise<TriggerSweepRecord> {
  const now = opts.now ?? Date.now();
  const states = (await db
    .collection(COLLECTIONS.missionStates)
    .find(
      { status: 'active' },
      { projection: { _id: 0, mission_id: 1, owner_id: 1, version: 1 } },
    )
    .limit(opts.limit ?? 500)
    .toArray()) as unknown as Array<{ mission_id: string; owner_id?: string; version?: number }>;

  const missions: SweptMission[] = [];
  const errors: Array<{ mission_id: string; error: string }> = [];
  const stalled: string[] = [];

  for (const state of states) {
    try {
      const { fired, byTrigger } = await evaluateTriggers(db, state.mission_id, { now });
      if ((byTrigger['mission_stalled'] ?? 0) > 0) stalled.push(state.mission_id);
      missions.push({
        mission_id: state.mission_id,
        owner_id: state.owner_id,
        version: Number(state.version ?? 0),
        fired,
        by_trigger: byTrigger,
      });
    } catch (err) {
      // One bad mission must not cost the sweep. The failure is recorded by name.
      errors.push({
        mission_id: state.mission_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const record: TriggerSweepRecord = {
    sweep_id: `sweep_${randomUUID()}`,
    swept_at: new Date(now).toISOString(),
    stall_days: missionStallDays(),
    missions_scanned: states.length,
    missions_with_triggers: missions.filter(m => m.fired.length > 0).length,
    stalled,
    missions,
    errors,
  };

  if (opts.persist !== false) {
    await db.collection(COLLECTIONS.triggerSweeps).insertOne({ ...record } as never);
  }
  return record;
}
