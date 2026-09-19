// Collection + index design for the cognitive control plane (Phase 1).
// Retention/compaction policy (doc 06 + review §4.4):
//   - mission_events:      TTL 90 days (durable outbox, compacted)
//   - cognitive_batons:    TTL 7 days via _expires_at (audit metadata lives in mission_events)
//   - state_deltas, epistemic_entries, mission_state_versions: retained (they ARE the audit)
//   - mission_state_versions: compacted in the checkpoint path (keep last 30)
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';

export const COLLECTIONS = {
  missionStates: 'mission_states',
  missionStateVersions: 'mission_state_versions',
  epistemicEntries: 'epistemic_entries',
  stateDeltas: 'state_deltas',
  cognitiveBatons: 'cognitive_batons',
  cognitiveWorkItems: 'cognitive_work_items',
  agentCognitiveProfiles: 'agent_cognitive_profiles',
  schedulerDecisions: 'scheduler_decisions',
  missionEvents: 'mission_events',
  triggerEvaluations: 'trigger_evaluations', // Phase 5: trigger precision + cost telemetry (§5.3)
} as const;

export const EVENT_TTL_SECONDS = 90 * 24 * 3600; // 90 days
export const BATON_TTL_SECONDS = 7 * 24 * 3600; // 7 days
export const MISSION_STATE_VERSION_KEEP = 30;

export async function ensureMissionCognitionIndexes(db: Db): Promise<void> {
  const p = (name: string, keys: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
    db.collection(name).createIndex(keys as any, opts as any);

  await Promise.all([
    p(COLLECTIONS.missionStates, { mission_id: 1 }, { unique: true, name: 'ms_mission_unique' }),
    p(COLLECTIONS.missionStates, { updated_at: -1 }, { name: 'ms_updated' }),
    p(COLLECTIONS.missionStateVersions, { mission_id: 1, version: 1 }, { unique: true, name: 'msv_mission_version_unique' }),
    p(COLLECTIONS.epistemicEntries, { entry_id: 1 }, { unique: true, name: 'le_entry_unique' }),
    p(COLLECTIONS.epistemicEntries, { mission_id: 1, entry_type: 1, created_at: -1 }, { name: 'le_mission_type' }),
    p(COLLECTIONS.stateDeltas, { delta_id: 1 }, { unique: true, name: 'sd_delta_unique' }),
    p(COLLECTIONS.stateDeltas, { idempotency_key: 1 }, { unique: true, name: 'sd_idem_unique' }),
    p(COLLECTIONS.stateDeltas, { mission_id: 1, created_at: -1 }, { name: 'sd_mission' }),
    p(COLLECTIONS.cognitiveBatons, { baton_id: 1 }, { unique: true, name: 'cb_baton_unique' }),
    p(COLLECTIONS.cognitiveBatons, { mission_id: 1, issued_at: -1 }, { name: 'cb_mission' }),
    p(COLLECTIONS.cognitiveBatons, { _expires_at: 1 }, { expireAfterSeconds: 0, name: 'cb_ttl' }),
    p(COLLECTIONS.cognitiveWorkItems, { work_item_id: 1 }, { unique: true, name: 'cwi_unique' }),
    p(COLLECTIONS.cognitiveWorkItems, { mission_id: 1, status: 1 }, { name: 'cwi_mission_status' }),
    p(COLLECTIONS.agentCognitiveProfiles, { agent_id: 1 }, { unique: true, name: 'acp_unique' }),
    p(COLLECTIONS.schedulerDecisions, { mission_id: 1, created_at: -1 }, { name: 'sched_mission' }),
    p(COLLECTIONS.missionEvents, { mission_id: 1, created_at: -1 }, { name: 'me_mission' }),
    p(COLLECTIONS.missionEvents, { _expires_at: 1 }, { expireAfterSeconds: 0, name: 'me_ttl' }),
    p(COLLECTIONS.triggerEvaluations, { evaluation_id: 1 }, { unique: true, name: 'te_unique' }),
    p(COLLECTIONS.triggerEvaluations, { mission_id: 1, trigger: 1, fired_at: -1 }, { name: 'te_mission_trigger' }),
  ]);
}
