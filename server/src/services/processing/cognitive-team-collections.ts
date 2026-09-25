// Collection + index design for the cognitive team (ITER-8, Phase 6).
//
//   - thinking_mode_assignments: one row per mode assignment — the ephemeral,
//     EXPIRING thinking mode an identity holds on a mission. Unique
//     `assignment_id` (DERIVED from the mission scope, the mode, the reason and
//     the start, never a random UUID), read paths `{user_id, mission_id, status}`
//     (the read the active-mode lookup and the expiry sweep use) and
//     `{expires_at}` (the column the TTL is computed from). PRIVATE: the mode a
//     mission's owner has taken on is that identity's own working disposition,
//     so the row is written through `resolveWriteScope` + `stripSharedId` and can
//     never carry a `shared_id`. It carries the reason, the start, the expiry,
//     the policy version, the inheritance policy, the parent's disposition
//     snapshot VERSION and the reset behaviour — and no private memory.
//
//   - inheritance_envelopes: one row per bounded, mission-scoped inheritance
//     grant — the brief's §4.4 "sub-agents receive `parent_identity_id` and an
//     immutable disposition snapshot/version, not the parent's private journals
//     or reflection documents". Unique `envelope_id` (DERIVED from the parent,
//     the mission, the child label, the mode, the disposition hash and the
//     mutation chain), read paths `{parent_identity_id, mission_id}` and
//     `{expires_at}`. An envelope is an IMMUTABLE REFERENCE: it names a
//     disposition snapshot (profile + version + hash), the immutable bounds
//     (message priority 10.0, the working-memory/vector floors, the per-source
//     cap bounds, the privacy policy), the approved dimensions the child may
//     bias and its own expiry. A bounded mutation produces a NEW row derived
//     from its parent — the original row is never rewritten — and the parent's
//     own configuration is never touched at all. No private content: the
//     taint suite proves it across journals, reflections, traces, seeds and
//     beliefs.
//
//   - cognitive_portfolios: the team's persisted artifacts, discriminated by
//     `kind`:
//       * `allocation` — the §4.5 portfolio: which agents generate, which bins
//         each one is selected to cover, the reserved independent evaluator and
//         EVERY score component with its inputs (the `allocation_report`);
//       * `first_pass` — the independent first pass: the per-agent generation
//         requests (mission digest + the agent's OWN envelope/mode + public
//         context only) and, once it has run, each agent's isolated portfolio
//         with its provenance;
//       * `synthesis` — a merged portfolio: per-candidate provenance, the
//         exclusions carried VERBATIM, and the appended `synthesis` lineage
//         record. A synthesis can never promote (Phase 5 owns promotion).
//     Unique `portfolio_id` (derived, kind-tagged), read path
//     `{user_id, mission_id, kind, created_at}`. PRIVATE.
//
// All three are personal kinds (`write-scope-policy.ts` — stated by the
// collection they protect), so every write resolves `shared_id: null` no matter
// what a caller asks for: a mode assignment, an inheritance envelope and a
// portfolio are one identity's own mission-scoped working state. Nothing in this
// iteration writes a shared scope.
//
// `ensureCognitiveTeamIndexes()` is the lazy, feature-owned guard (the house
// pattern from mission-cognition/collections.ts, imagination-collections.ts and
// creative-baton-collections.ts): the services call it before their first write
// and it is memoised per `Db`. Like the ITER-5/6/7 collections — and unlike the
// always-on self-model ones — these three are deliberately NOT declared in
// `MEMORY_SYSTEM_INDEXES`: boot-time index initialisation would create the
// collections even on a deployment where the flag is off, and the flag-off
// contract is that nothing at all touches them.
import type { Db } from 'mongodb';

export const COGNITIVE_TEAM_COLLECTIONS = {
  modeAssignments: 'thinking_mode_assignments',
  inheritanceEnvelopes: 'inheritance_envelopes',
  cognitivePortfolios: 'cognitive_portfolios',
} as const;

/**
 * Write-scope kinds for this feature. Each is the collection name on purpose:
 * `PERSONAL_KINDS` lists the personal kinds by the collection they protect, and
 * the services resolve every write through `resolveWriteScope({ kind })` — which
 * returns `shared_id: null` for a personal kind no matter what a caller asks
 * for.
 */
export const MODE_ASSIGNMENT_KIND = COGNITIVE_TEAM_COLLECTIONS.modeAssignments;
export const INHERITANCE_ENVELOPE_KIND = COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes;
export const COGNITIVE_PORTFOLIO_KIND = COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios;

export const MODE_ASSIGNMENTS_UNIQUE_INDEX = 'cogmode_assignment_unique';
export const MODE_ASSIGNMENTS_SCOPE_INDEX = 'cogmode_user_mission_status';
export const MODE_ASSIGNMENTS_EXPIRY_INDEX = 'cogmode_expires_at';
export const ENVELOPES_UNIQUE_INDEX = 'cogenv_envelope_unique';
export const ENVELOPES_SCOPE_INDEX = 'cogenv_parent_mission';
export const ENVELOPES_EXPIRY_INDEX = 'cogenv_expires_at';
export const PORTFOLIOS_UNIQUE_INDEX = 'cogport_portfolio_unique';
export const PORTFOLIOS_SCOPE_INDEX = 'cogport_user_mission_kind';

export const MODE_ASSIGNMENTS_UNIQUE_KEYS = { assignment_id: 1 } as const;
export const MODE_ASSIGNMENTS_SCOPE_KEYS = { user_id: 1, mission_id: 1, status: 1 } as const;
export const MODE_ASSIGNMENTS_EXPIRY_KEYS = { expires_at: 1 } as const;
export const ENVELOPES_UNIQUE_KEYS = { envelope_id: 1 } as const;
export const ENVELOPES_SCOPE_KEYS = { parent_identity_id: 1, mission_id: 1 } as const;
export const ENVELOPES_EXPIRY_KEYS = { expires_at: 1 } as const;
export const PORTFOLIOS_UNIQUE_KEYS = { portfolio_id: 1 } as const;
export const PORTFOLIOS_SCOPE_KEYS = { user_id: 1, mission_id: 1, kind: 1, created_at: -1 } as const;

/** One promise per store: the guard runs once per `Db`, never once per write. */
const ensured = new WeakMap<Db, Promise<void>>();

/**
 * Create the indexes this feature owns, idempotently. `createIndex` is a no-op
 * when the index already exists, so calling this on first use is safe; a real
 * failure rejects and is retried on the next call (a rejected promise is not
 * memoised).
 */
export function ensureCognitiveTeamIndexes(db: Db): Promise<void> {
  let pending = ensured.get(db);
  if (!pending) {
    pending = (async () => {
      const p = (name: string, keys: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
        db.collection(name).createIndex(keys as any, opts as any);

      await Promise.all([
        p(COGNITIVE_TEAM_COLLECTIONS.modeAssignments, { ...MODE_ASSIGNMENTS_UNIQUE_KEYS }, {
          unique: true,
          name: MODE_ASSIGNMENTS_UNIQUE_INDEX,
        }),
        p(COGNITIVE_TEAM_COLLECTIONS.modeAssignments, { ...MODE_ASSIGNMENTS_SCOPE_KEYS }, {
          name: MODE_ASSIGNMENTS_SCOPE_INDEX,
        }),
        p(COGNITIVE_TEAM_COLLECTIONS.modeAssignments, { ...MODE_ASSIGNMENTS_EXPIRY_KEYS }, {
          name: MODE_ASSIGNMENTS_EXPIRY_INDEX,
        }),
        p(COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes, { ...ENVELOPES_UNIQUE_KEYS }, {
          unique: true,
          name: ENVELOPES_UNIQUE_INDEX,
        }),
        p(COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes, { ...ENVELOPES_SCOPE_KEYS }, {
          name: ENVELOPES_SCOPE_INDEX,
        }),
        p(COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes, { ...ENVELOPES_EXPIRY_KEYS }, {
          name: ENVELOPES_EXPIRY_INDEX,
        }),
        p(COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios, { ...PORTFOLIOS_UNIQUE_KEYS }, {
          unique: true,
          name: PORTFOLIOS_UNIQUE_INDEX,
        }),
        p(COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios, { ...PORTFOLIOS_SCOPE_KEYS }, {
          name: PORTFOLIOS_SCOPE_INDEX,
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
