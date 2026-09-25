// Collection + index design for the durable self-model (ITER-4).
//
//   - agent_beliefs: one row per {user_id, entity_name, proposition}
//     (`user_entity_proposition_unique`). Beliefs are identity-scoped, so the
//     key includes user_id. Deployments that predate identity separation still
//     hold rows carrying the legacy identity-less `user_id` value `default`;
//     no identity and are left exactly as they are. The unique index therefore
//     has to be created only once the pre-existing duplicate keys under
//     that value have been collapsed — `dedupeAgentBeliefs()`
//     (self-model-service.ts) counts the duplicates, collapses each key group
//     deterministically and only then creates the index. It is declared in
//     `MEMORY_SYSTEM_INDEXES` so index initialisation keeps it afterwards.
//
//   - procedural_patterns: one row per {user_id, tool_name, input_shape}
//     (`user_tool_shape_unique`), read by `{user_id, last_seen: -1}`. A tool
//     pattern belongs to the identity that produced it, so both the unique key
//     and the read index lead with user_id.
//
// `ensureSelfModelIndexes()` is the lazy guard used by the service on first
// use (the house pattern from mission-cognition/collections.ts). It creates
// the procedural_patterns indexes and the agent_beliefs read index — never the
// agent_beliefs unique index, which only the dedupe migration may create
// (a unique index over un-collapsed data would fail to build, and a failed
// build at boot would leave the identity boundary unenforced).
import type { Db } from 'mongodb';

export const SELF_MODEL_COLLECTIONS = {
  agentBeliefs: 'agent_beliefs',
  proceduralPatterns: 'procedural_patterns',
} as const;

export const AGENT_BELIEFS_UNIQUE_INDEX = 'user_entity_proposition_unique';
export const AGENT_BELIEFS_READ_INDEX = 'user_entity_confidence';
export const PROCEDURAL_PATTERNS_UNIQUE_INDEX = 'user_tool_shape_unique';
export const PROCEDURAL_PATTERNS_READ_INDEX = 'user_last_seen';

export const AGENT_BELIEFS_UNIQUE_KEYS = {
  user_id: 1,
  entity_name: 1,
  proposition: 1,
} as const;

export const AGENT_BELIEFS_READ_KEYS = {
  user_id: 1,
  entity_name: 1,
  confidence: -1,
} as const;

export const PROCEDURAL_PATTERNS_UNIQUE_KEYS = {
  user_id: 1,
  tool_name: 1,
  input_shape: 1,
} as const;

export const PROCEDURAL_PATTERNS_READ_KEYS = {
  user_id: 1,
  last_seen: -1,
} as const;

/**
 * Create the indexes this feature owns, idempotently. Safe to call on every
 * start: `createIndex` is a no-op when the index already exists. Throws on a
 * real failure — callers decide whether that is fatal (the service logs and
 * keeps serving from its cache).
 */
export async function ensureSelfModelIndexes(db: Db): Promise<void> {
  const p = (name: string, keys: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
    db.collection(name).createIndex(keys as any, opts as any);

  await Promise.all([
    // procedural_patterns: the unique triple is the row identity …
    p(SELF_MODEL_COLLECTIONS.proceduralPatterns, { ...PROCEDURAL_PATTERNS_UNIQUE_KEYS }, {
      unique: true,
      name: PROCEDURAL_PATTERNS_UNIQUE_INDEX,
    }),
    // … and reads are "this identity's most recently seen patterns".
    p(SELF_MODEL_COLLECTIONS.proceduralPatterns, { ...PROCEDURAL_PATTERNS_READ_KEYS }, {
      name: PROCEDURAL_PATTERNS_READ_INDEX,
    }),
    // agent_beliefs: reads are { user_id, entity_name } (non-unique — the
    // unique index is created by the dedupe migration, see the module header).
    p(SELF_MODEL_COLLECTIONS.agentBeliefs, { ...AGENT_BELIEFS_READ_KEYS }, {
      name: AGENT_BELIEFS_READ_INDEX,
    }),
  ]);
}
