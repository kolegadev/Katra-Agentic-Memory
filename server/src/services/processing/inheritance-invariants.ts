/**
 * The immutable hard invariants of the cognitive team (ITER-8, Phase 6) — the
 * named list a mode, an inheritance envelope or a bounded mutation may never
 * reach, plus the aliases a caller might try instead.
 *
 * It lives in its own module so `inheritance-policy.ts` (the clamp/refuse path)
 * and any consumer can share ONE definition of "immutable": the envelope's
 * bounds, its verifier and the refusal codes all read from here, so "refused by
 * name" and "checked at verify time" can never drift apart.
 *
 * The four invariants are the brief's §8 "Hard invariants" that touch retrieval
 * configuration:
 *
 *   message_priority — inter-agent messages stay the highest-priority retrieval
 *     and cannot be lowered by a profile, a mode or a learned delta.
 *   floors — the working-memory / vector-search task floors cannot be removed by
 *     autonomous adaptation.
 *   cap_bounds — the per-source cap BOUNDS cannot be widened (a child may
 *     tighten the cap it inherits, never raise it above the parent's).
 *   privacy_policy — the privacy policy is immutable.
 *
 * The alias map is deliberately generous: renaming the dimension does not change
 * which invariant it is, so `agent_message`, `agent_message_weight`,
 * `working_memory_floor`, `max_single_source_pct_bounds` and `privacy` all
 * resolve to the invariant they are.
 */
export const IMMUTABLE_INVARIANTS = [
  'message_priority',
  'floors',
  'cap_bounds',
  'privacy_policy',
] as const;

export type ImmutableInvariant = (typeof IMMUTABLE_INVARIANTS)[number];

/** `alias → invariant`. Every key is refused as `immutable_invariant`. */
export const IMMUTABLE_INVARIANT_ALIASES: Record<string, ImmutableInvariant> = {
  message_priority: 'message_priority',
  agent_message: 'message_priority',
  agent_message_priority: 'message_priority',
  agent_message_weight: 'message_priority',
  budget_floors: 'floors',
  floors: 'floors',
  working_memory_floor: 'floors',
  vector_search_floor: 'floors',
  cap_bounds: 'cap_bounds',
  max_single_source_pct_bounds: 'cap_bounds',
  per_source_cap_bounds: 'cap_bounds',
  privacy_policy: 'privacy_policy',
  privacy: 'privacy_policy',
  privacy_bounds: 'privacy_policy',
};

/** One line of prose per invariant, used in refusals and in the envelope doc. */
export const IMMUTABLE_INVARIANT_NOTES: Record<ImmutableInvariant, string> = {
  message_priority:
    'inter-agent messages are the highest-priority retrieval (weight 10.0) and no mode, envelope or learned delta may lower that',
  floors:
    'the working-memory and vector-search task floors cannot be removed by autonomous adaptation',
  cap_bounds:
    'the per-source cap BOUNDS are immutable: a child may tighten the cap it inherits, never widen it',
  privacy_policy: 'the privacy policy is immutable',
};
