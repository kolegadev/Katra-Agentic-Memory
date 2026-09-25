// Collection + index design for the imagination engine + quality-diversity
// archive (ITER-6, Phase 4).
//
//   - idea_seeds: one row per generated hypothesis seed — a private, evidence-
//     linked, deterministic artifact. Unique `seed_id` (DERIVED from the
//     seed's content + the run's PRNG seed + the mission, never a random
//     UUID), read paths `{user_id, mission_id, cycle_id}` and
//     `{user_id, created_at: -1}`. PRIVATE: written without `shared_id` (see
//     write-scope-policy.ts — the collection name is a personal kind).
//     Rejected seeds live here too (`state: 'rejected'` + `rejection`), which
//     is what makes an exclusion durable: a later seed can only come back with
//     a changed premise and a lineage link to that rejection.
//
//   - idea_lineages: one row per seed — lineage is not optional. Unique
//     `lineage_id`; carries the parent links, the transformations that
//     produced the seed, and the tests / results / failure signatures recorded
//     against it. Also private, also written without `shared_id`.
//
//   - idea_archive_cells: the quality-diversity archive — one cell per
//     descriptor-bin TUPLE. Unique `{user_id, mission_id, cell_key}`; a cell
//     holds its bins, the incumbent seed id, the incumbent's quality, the
//     cell's history (creation, replacement, changed-premise re-entry, a
//     challenger that did not beat the incumbent) and a coverage date.
//
//     IDENTITY-OWNED, AND DELIBERATELY *NOT* A PERSONAL KIND. The brief calls
//     the archive "mission-scoped"; it is realised privacy-first instead,
//     because a cell's meaning is a *private seed id* (`incumbent_seed_id`):
//     sharing cells would leak the shape of an identity's private portfolio,
//     and every cell would be undecodable to anyone who cannot read the seeds.
//     So cells are keyed by `{user_id, mission_id}` — mission-indexed, but
//     owned by the identity that wrote them — and every cell write goes
//     through `resolveWriteScope({ private: true })` + `stripSharedId`, so a
//     cell can never carry a `shared_id` either. The shareable surface is the
//     SANITIZED coverage view (bins, counts, quality and ids only) — never
//     statements, evidence text or reflection material.
//
//   - imagination_runs: the run ledger — one row per
//     `{user_id, mission_id, cycle_id, seed}`, enforced by a unique
//     `idempotency_key`. It is where "the run records planned vs actual"
//     lives: budgets (effective caps), operators planned vs run, model calls
//     planned vs actual, seeds generated / admitted / rejected / below
//     incumbent, new cells, per-reason drop counts, the operator plan, the
//     rejections with reasons, the portfolio digest and the privacy audit.
//     Private, like the focused-consolidation run ledger.
//
// `ensureImaginationIndexes()` is the lazy, feature-owned guard (the house
// pattern from mission-cognition/collections.ts, self-model-collections.ts and
// focused-consolidation-collections.ts): the services call it before their
// first write, and it is memoised per `Db` so a test process that binds
// several stores still builds the indexes for each of them. Like the ITER-5
// collections — and unlike the always-on self-model ones — these four are
// deliberately NOT declared in `MEMORY_SYSTEM_INDEXES`: boot-time index
// initialisation would create the collections even on a deployment where
// FOCUSED_IMAGINATION is off, and the flag-off contract is that nothing at all
// touches them.
import type { Db } from 'mongodb';

export const IMAGINATION_COLLECTIONS = {
  ideaSeeds: 'idea_seeds',
  ideaLineages: 'idea_lineages',
  ideaArchiveCells: 'idea_archive_cells',
  imaginationRuns: 'imagination_runs',
} as const;

/**
 * Write-scope kinds for this feature. `idea_seeds` and `idea_lineages` are the
 * collection names on purpose: `PERSONAL_KINDS` (services/memory/write-scope-
 * policy.ts) lists the personal kinds by the collection they protect, and the
 * services resolve every write through `resolveWriteScope({ kind })` — which
 * returns `shared_id: null` for a personal kind no matter what a caller asks
 * for.
 *
 * `IDEA_ARCHIVE_CELL_KIND` is NOT in `PERSONAL_KINDS` (the contract makes the
 * archive identity-owned but mission-indexed). It is therefore written with an
 * explicit `requested: { private: true }`, which is the policy's own opt-out:
 * the resolved scope is `shared_id: null` for that write, and the payload is
 * `stripSharedId`-ed anyway, so a cell cannot carry a shared scope either.
 */
export const IDEA_SEED_KIND = IMAGINATION_COLLECTIONS.ideaSeeds;
export const IDEA_LINEAGE_KIND = IMAGINATION_COLLECTIONS.ideaLineages;
export const IDEA_ARCHIVE_CELL_KIND = IMAGINATION_COLLECTIONS.ideaArchiveCells;
export const IMAGINATION_RUN_KIND = IMAGINATION_COLLECTIONS.imaginationRuns;

export const IDEA_SEEDS_UNIQUE_INDEX = 'is_seed_unique';
export const IDEA_SEEDS_SCOPE_INDEX = 'is_user_mission_cycle';
export const IDEA_SEEDS_READ_INDEX = 'is_user_created';
export const IDEA_LINEAGES_UNIQUE_INDEX = 'il_lineage_unique';
export const IDEA_LINEAGES_SCOPE_INDEX = 'il_user_mission';
export const IDEA_CELLS_UNIQUE_INDEX = 'iac_cell_unique';
export const IDEA_CELLS_SCOPE_INDEX = 'iac_user_mission';
export const IMAGINATION_RUNS_UNIQUE_INDEX = 'irun_idempotency_unique';
export const IMAGINATION_RUNS_SCOPE_INDEX = 'irun_user_mission_cycle';

export const IDEA_SEEDS_UNIQUE_KEYS = { seed_id: 1 } as const;
export const IDEA_SEEDS_SCOPE_KEYS = { user_id: 1, mission_id: 1, cycle_id: 1 } as const;
export const IDEA_SEEDS_READ_KEYS = { user_id: 1, created_at: -1 } as const;
export const IDEA_LINEAGES_UNIQUE_KEYS = { lineage_id: 1 } as const;
export const IDEA_LINEAGES_SCOPE_KEYS = { user_id: 1, mission_id: 1 } as const;
export const IDEA_CELLS_UNIQUE_KEYS = { user_id: 1, mission_id: 1, cell_key: 1 } as const;
export const IDEA_CELLS_SCOPE_KEYS = { user_id: 1, mission_id: 1 } as const;
export const IMAGINATION_RUNS_UNIQUE_KEYS = { idempotency_key: 1 } as const;
export const IMAGINATION_RUNS_SCOPE_KEYS = { user_id: 1, mission_id: 1, cycle_id: 1 } as const;

/** One promise per store: the guard runs once per `Db`, never once per write. */
const ensured = new WeakMap<Db, Promise<void>>();

/**
 * Create the indexes this feature owns, idempotently. `createIndex` is a no-op
 * when the index already exists, so calling this on first use is safe; a real
 * failure rejects and is retried on the next call (a rejected promise is not
 * memoised).
 */
export function ensureImaginationIndexes(db: Db): Promise<void> {
  let pending = ensured.get(db);
  if (!pending) {
    pending = (async () => {
      const p = (name: string, keys: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
        db.collection(name).createIndex(keys as any, opts as any);

      await Promise.all([
        p(IMAGINATION_COLLECTIONS.ideaSeeds, { ...IDEA_SEEDS_UNIQUE_KEYS }, {
          unique: true,
          name: IDEA_SEEDS_UNIQUE_INDEX,
        }),
        p(IMAGINATION_COLLECTIONS.ideaSeeds, { ...IDEA_SEEDS_SCOPE_KEYS }, {
          name: IDEA_SEEDS_SCOPE_INDEX,
        }),
        p(IMAGINATION_COLLECTIONS.ideaSeeds, { ...IDEA_SEEDS_READ_KEYS }, {
          name: IDEA_SEEDS_READ_INDEX,
        }),
        p(IMAGINATION_COLLECTIONS.ideaLineages, { ...IDEA_LINEAGES_UNIQUE_KEYS }, {
          unique: true,
          name: IDEA_LINEAGES_UNIQUE_INDEX,
        }),
        p(IMAGINATION_COLLECTIONS.ideaLineages, { ...IDEA_LINEAGES_SCOPE_KEYS }, {
          name: IDEA_LINEAGES_SCOPE_INDEX,
        }),
        p(IMAGINATION_COLLECTIONS.ideaArchiveCells, { ...IDEA_CELLS_UNIQUE_KEYS }, {
          unique: true,
          name: IDEA_CELLS_UNIQUE_INDEX,
        }),
        p(IMAGINATION_COLLECTIONS.ideaArchiveCells, { ...IDEA_CELLS_SCOPE_KEYS }, {
          name: IDEA_CELLS_SCOPE_INDEX,
        }),
        p(IMAGINATION_COLLECTIONS.imaginationRuns, { ...IMAGINATION_RUNS_UNIQUE_KEYS }, {
          unique: true,
          name: IMAGINATION_RUNS_UNIQUE_INDEX,
        }),
        p(IMAGINATION_COLLECTIONS.imaginationRuns, { ...IMAGINATION_RUNS_SCOPE_KEYS }, {
          name: IMAGINATION_RUNS_SCOPE_INDEX,
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
