// Collection + index design for the focused Salience Trace (ITER-5, Phase 3).
//
//   - salience_traces: one row per focused run — a mission-scoped, evidence-
//     linked, calibrated trace of what feels important and why. Unique
//     `trace_id`; read path is `{user_id, mission_id, created_at: -1}` (the
//     caller's own traces for one mission, newest first). The row is PRIVATE:
//     it is written without `shared_id` (see write-scope-policy.ts — both this
//     collection name and `focused_consolidation_runs` are personal kinds), and
//     no shared/team read path exists for it.
//
//   - focused_consolidation_runs: the run ledger — one row per
//     `{user_id, mission_id, cycle_id}`, enforced by a unique
//     `idempotency_key` so a repeat of the same cycle can never double-run or
//     produce a duplicate document. It carries status, timings, model, input
//     and output counts, the unresolved-evidence and clamped-value counts, and
//     the privacy audit. Also private, also written without `shared_id`.
//
// `ensureFocusedConsolidationIndexes()` is the lazy, feature-owned guard (the
// house pattern from mission-cognition/collections.ts and
// self-model-collections.ts): the service calls it before its first write, and
// it is memoised per `Db` so a test process that binds several stores still
// builds the indexes for each of them. Like the mission-cognition collections —
// and unlike the always-on self-model ones — these two are deliberately NOT
// declared in `MEMORY_SYSTEM_INDEXES`: boot-time index initialisation would
// create the collections even on a deployment where FOCUSED_IMAGINATION is off,
// and the flag-off contract is that nothing at all touches them.
import type { Db } from 'mongodb';

export const FOCUSED_CONSOLIDATION_COLLECTIONS = {
  salienceTraces: 'salience_traces',
  focusedRuns: 'focused_consolidation_runs',
} as const;

/**
 * Write-scope kinds for this feature. They are the collection names on
 * purpose: `PERSONAL_KINDS` (services/memory/write-scope-policy.ts) lists the
 * personal kinds by the collection they protect, and the service resolves
 * every write through `resolveWriteScope({ kind: … })` — which returns
 * `shared_id: null` for a personal kind no matter what a caller asks for.
 */
export const SALIENCE_TRACE_KIND = FOCUSED_CONSOLIDATION_COLLECTIONS.salienceTraces;
export const FOCUSED_RUN_KIND = FOCUSED_CONSOLIDATION_COLLECTIONS.focusedRuns;

export const SALIENCE_TRACES_UNIQUE_INDEX = 'st_trace_unique';
export const SALIENCE_TRACES_READ_INDEX = 'st_user_mission_created';
export const FOCUSED_RUNS_UNIQUE_INDEX = 'fcr_idempotency_unique';
export const FOCUSED_RUNS_READ_INDEX = 'fcr_user_mission_cycle';

export const SALIENCE_TRACES_UNIQUE_KEYS = { trace_id: 1 } as const;
export const SALIENCE_TRACES_READ_KEYS = { user_id: 1, mission_id: 1, created_at: -1 } as const;
export const FOCUSED_RUNS_UNIQUE_KEYS = { idempotency_key: 1 } as const;
export const FOCUSED_RUNS_READ_KEYS = { user_id: 1, mission_id: 1, cycle_id: 1 } as const;

/** One promise per store: the guard runs once per `Db`, never once per write. */
const ensured = new WeakMap<Db, Promise<void>>();

/**
 * Create the indexes this feature owns, idempotently. `createIndex` is a no-op
 * when the index already exists, so calling this on first use is safe; a real
 * failure rejects and is retried on the next call (a rejected promise is not
 * memoised).
 */
export function ensureFocusedConsolidationIndexes(db: Db): Promise<void> {
  let pending = ensured.get(db);
  if (!pending) {
    pending = (async () => {
      const p = (name: string, keys: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
        db.collection(name).createIndex(keys as any, opts as any);

      await Promise.all([
        p(FOCUSED_CONSOLIDATION_COLLECTIONS.salienceTraces, { ...SALIENCE_TRACES_UNIQUE_KEYS }, {
          unique: true,
          name: SALIENCE_TRACES_UNIQUE_INDEX,
        }),
        p(FOCUSED_CONSOLIDATION_COLLECTIONS.salienceTraces, { ...SALIENCE_TRACES_READ_KEYS }, {
          name: SALIENCE_TRACES_READ_INDEX,
        }),
        p(FOCUSED_CONSOLIDATION_COLLECTIONS.focusedRuns, { ...FOCUSED_RUNS_UNIQUE_KEYS }, {
          unique: true,
          name: FOCUSED_RUNS_UNIQUE_INDEX,
        }),
        p(FOCUSED_CONSOLIDATION_COLLECTIONS.focusedRuns, { ...FOCUSED_RUNS_READ_KEYS }, {
          name: FOCUSED_RUNS_READ_INDEX,
        }),
      ]);
    })().catch((error) => {
      ensured.delete(db);
      throw error;
    });
    ensured.set(db, pending);
  }
  return pending;
}
