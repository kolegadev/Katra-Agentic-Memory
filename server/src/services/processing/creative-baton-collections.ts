// Collection + index design for the Creative Baton, the plateau-triggered
// cycle orchestrator, its persisted cooldown/budget state and the candidate
// outcome feedback (ITER-7, Phase 5).
//
//   - creative_batons: one row per compiled cycle artifact — the SANITISED,
//     versioned Creative Baton the controller picks candidates up from. Unique
//     `baton_id` (DERIVED from the mission, the cycle and the compiled
//     portfolio, never a random UUID), read paths `{mission_id, created_at:
//     -1}` and `{shared_id, mission_id}`.
//
//     IT IS DELIBERATELY *NOT* A PERSONAL KIND. The compiled baton is the one
//     artifact this feature may share: the whole point of Phase 5 is that a
//     PRIVATE portfolio can produce a SHAREABLE, allow-listed context packet,
//     and a promotion stamps `shared_id` on it. Everything the baton is
//     compiled FROM stays private forever (see below), and the compiler's
//     allow-list — not the write scope — is what makes sharing safe. So a
//     baton is written with an explicit `private: true` request at compile
//     time and re-written through `resolveWriteScope` (team scope) only by the
//     promoter, which is gated on `CREATIVE_BATON_PROMOTION`.
//
//   - creative_baton_promotions: the promotion audit — one row per promotion,
//     carrying the promoting identity, the timestamp, the schema version and
//     the payload hash. Unique `promotion_id` (derived from the baton id and
//     the payload hash, so a second promotion of the same payload cannot insert
//     a second row), read path `{baton_id, promoted_at: -1}` and
//     `{mission_id, promoted_at: -1}`. Team-scoped like the artifact it
//     records, and it carries NO private text: it names the baton, the identity
//     and the hash, nothing else.
//
//   - imagination_cycle_states: ONE row per `{user_id, mission_id}` — the
//     persisted cooldown, window budget and claim bookkeeping that makes the
//     cycle safe across restarts and concurrent callers. This is the row the
//     contract's "cooldown/budget/in-flight state must be PERSISTED per
//     mission" points at: a fresh module graph reads it and cannot re-trigger
//     early, and the window counters continue instead of resetting. Private.
//
//   - imagination_cycles: the cycle run ledger — one row per cycle attempt that
//     got past the gates, keyed by `{user_id, mission_id, cycle_id}`. The id is
//     DERIVED from the mission's scope (identity + mission id), its version and
//     its cycle ordinal, so two concurrent callers of one mission compute the
//     SAME id and exactly one runs; a second mission that shares (version,
//     ordinal) derives a DIFFERENT id, and a claim that looked the row up by
//     `cycle_id` alone could not hand it the first mission's row. It records the
//     counts, the effective budget and what was spent, the coverage view (with
//     its scan bounds), the stop condition that fired and the compiled/promoted
//     baton id. Private.
//
//   - idea_candidate_outcomes: what happened to a candidate after a controller
//     picked it up — `useful_information` / `mere_variance` /
//     `unnecessary_cost`. Unique `{user_id, seed_id, outcome}`, so repeating an
//     outcome for a seed is recorded once and reported as a repeat (which is
//     also what keeps the novelty-drive replenishment from being farmed by
//     re-sending the same call). Private.
//
// `ensureCreativeBatonIndexes()` is the lazy, feature-owned guard (the house
// pattern from mission-cognition/collections.ts, imagination-collections.ts,
// focused-consolidation-collections.ts): the services call it before their
// first write and it is memoised per `Db`. Like the ITER-5/6 collections —
// and unlike the always-on self-model ones — these five are deliberately NOT
// declared in `MEMORY_SYSTEM_INDEXES`: boot-time index initialisation would
// create the collections even on a deployment where the flags are off, and the
// flag-off contract is that nothing at all touches them.
import type { Db } from 'mongodb';

export const CREATIVE_BATON_COLLECTIONS = {
  creativeBatons: 'creative_batons',
  batonPromotions: 'creative_baton_promotions',
  cycleStates: 'imagination_cycle_states',
  cycles: 'imagination_cycles',
  candidateOutcomes: 'idea_candidate_outcomes',
} as const;

/**
 * Write-scope kinds for this feature.
 *
 * `imagination_cycle_states`, `imagination_cycles` and
 * `idea_candidate_outcomes` are PERSONAL_KINDS (`write-scope-policy.ts`) —
 * stated by the collection they protect — so every write of theirs resolves
 * `shared_id: null` no matter what a caller asks for. They stay private
 * forever, like the seeds they are about.
 *
 * `CREATIVE_BATON_KIND` is deliberately NOT personal: the baton is the single
 * shareable artifact, so it is written with the policy's explicit
 * `private: true` opt-out at compile time and promoted (shared scope) by the
 * promoter. `CREATIVE_BATON_PROMOTION_KIND` is not personal either — the audit
 * row describes a team artifact and carries no private text.
 */
export const CREATIVE_BATON_KIND = CREATIVE_BATON_COLLECTIONS.creativeBatons;
export const CREATIVE_BATON_PROMOTION_KIND = CREATIVE_BATON_COLLECTIONS.batonPromotions;
export const IMAGINATION_CYCLE_STATE_KIND = CREATIVE_BATON_COLLECTIONS.cycleStates;
export const IMAGINATION_CYCLE_KIND = CREATIVE_BATON_COLLECTIONS.cycles;
export const CANDIDATE_OUTCOME_KIND = CREATIVE_BATON_COLLECTIONS.candidateOutcomes;

export const CREATIVE_BATONS_UNIQUE_INDEX = 'cbaton_baton_unique';
export const CREATIVE_BATONS_MISSION_INDEX = 'cbaton_mission_created';
export const CREATIVE_BATONS_SHARED_INDEX = 'cbaton_shared_mission';
export const BATON_PROMOTIONS_UNIQUE_INDEX = 'cbpromo_promotion_unique';
export const BATON_PROMOTIONS_BATON_INDEX = 'cbpromo_baton';
export const BATON_PROMOTIONS_MISSION_INDEX = 'cbpromo_mission_created';
export const CYCLE_STATES_UNIQUE_INDEX = 'icycle_user_mission_unique';
/**
 * The cycle claim's unique key. It is COMPOUND on purpose: a cycle id is spelled
 * from the mission's scope, version and ordinal, and the row it claims belongs
 * to `{user_id, mission_id}` — so the constraint (and the claim lookup that
 * relies on it) has to be at that granularity. A `cycle_id`-only index would
 * make two missions whose derivations coincide collide instead of each running.
 */
export const CYCLES_UNIQUE_INDEX = 'icycle_user_mission_cycle_unique';
export const CYCLES_SCOPE_INDEX = 'icycle_user_mission_created';
export const OUTCOMES_UNIQUE_INDEX = 'candoutcome_unique';
export const OUTCOMES_SCOPE_INDEX = 'candoutcome_user_mission_created';

export const CREATIVE_BATONS_UNIQUE_KEYS = { baton_id: 1 } as const;
export const CREATIVE_BATONS_MISSION_KEYS = { mission_id: 1, created_at: -1 } as const;
export const CREATIVE_BATONS_SHARED_KEYS = { shared_id: 1, mission_id: 1 } as const;
export const BATON_PROMOTIONS_UNIQUE_KEYS = { promotion_id: 1 } as const;
export const BATON_PROMOTIONS_BATON_KEYS = { baton_id: 1, promoted_at: -1 } as const;
export const BATON_PROMOTIONS_MISSION_KEYS = { mission_id: 1, promoted_at: -1 } as const;
export const CYCLE_STATES_UNIQUE_KEYS = { user_id: 1, mission_id: 1 } as const;
export const CYCLES_UNIQUE_KEYS = { user_id: 1, mission_id: 1, cycle_id: 1 } as const;
export const CYCLES_SCOPE_KEYS = { user_id: 1, mission_id: 1, created_at: -1 } as const;
export const OUTCOMES_UNIQUE_KEYS = { user_id: 1, seed_id: 1, outcome: 1 } as const;
export const OUTCOMES_SCOPE_KEYS = { user_id: 1, mission_id: 1, created_at: -1 } as const;

/** One promise per store: the guard runs once per `Db`, never once per write. */
const ensured = new WeakMap<Db, Promise<void>>();

/**
 * Create the indexes this feature owns, idempotently. `createIndex` is a no-op
 * when the index already exists, so calling this on first use is safe; a real
 * failure rejects and is retried on the next call (a rejected promise is not
 * memoised).
 */
export function ensureCreativeBatonIndexes(db: Db): Promise<void> {
  let pending = ensured.get(db);
  if (!pending) {
    pending = (async () => {
      const p = (name: string, keys: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
        db.collection(name).createIndex(keys as any, opts as any);

      await Promise.all([
        p(CREATIVE_BATON_COLLECTIONS.creativeBatons, { ...CREATIVE_BATONS_UNIQUE_KEYS }, {
          unique: true,
          name: CREATIVE_BATONS_UNIQUE_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.creativeBatons, { ...CREATIVE_BATONS_MISSION_KEYS }, {
          name: CREATIVE_BATONS_MISSION_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.creativeBatons, { ...CREATIVE_BATONS_SHARED_KEYS }, {
          name: CREATIVE_BATONS_SHARED_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.batonPromotions, { ...BATON_PROMOTIONS_UNIQUE_KEYS }, {
          unique: true,
          name: BATON_PROMOTIONS_UNIQUE_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.batonPromotions, { ...BATON_PROMOTIONS_BATON_KEYS }, {
          name: BATON_PROMOTIONS_BATON_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.batonPromotions, { ...BATON_PROMOTIONS_MISSION_KEYS }, {
          name: BATON_PROMOTIONS_MISSION_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.cycleStates, { ...CYCLE_STATES_UNIQUE_KEYS }, {
          unique: true,
          name: CYCLE_STATES_UNIQUE_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.cycles, { ...CYCLES_UNIQUE_KEYS }, {
          unique: true,
          name: CYCLES_UNIQUE_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.cycles, { ...CYCLES_SCOPE_KEYS }, {
          name: CYCLES_SCOPE_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.candidateOutcomes, { ...OUTCOMES_UNIQUE_KEYS }, {
          unique: true,
          name: OUTCOMES_UNIQUE_INDEX,
        }),
        p(CREATIVE_BATON_COLLECTIONS.candidateOutcomes, { ...OUTCOMES_SCOPE_KEYS }, {
          name: OUTCOMES_SCOPE_INDEX,
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
