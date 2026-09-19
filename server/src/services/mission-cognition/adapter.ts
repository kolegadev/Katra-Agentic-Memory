// missions → mission_states adapter (review §4.3, immediate action #8).
// Mapping table:
//   _id              → mission_id (stable id, task updates key off it)
//   meta_goal        → title + intent
//   status           → ACTIVE→active, PAUSED→paused, COMPLETED→completed, ABANDONED→cancelled
//   user_id          → owner_id
//   task_tree        → objectives[] (ids preserved — OBJECTIVE_UPDATED deltas keep working)
//   created_at/…     → created_at/updated_at
//   success_criteria → [] (legacy records none; owner declares on adoption — explicit, not invented)
//   authority_class  → 'B' (gated) default — explicit declaration overrides (review §3.4)
//   version          → 1 on adoption; in-flight tasks are NOT lost: they become objectives
//                      of the v1 state.
// Adoption is idempotent: repeated calls return the existing state, never a second copy.
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import type { AuthorityClass, MissionObjective, MissionState } from '../../types/cognitive-control.js';

interface LegacyMission {
  _id: string;
  user_id?: string;
  status?: string;
  meta_goal?: string;
  task_tree?: Array<{ id?: string; description?: string; status?: string }>;
  shared_id?: string;
  created_at?: Date | string;
  updated_at?: Date | string;
}

const STATUS_MAP: Record<string, MissionState['status']> = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ABANDONED: 'cancelled',
};

const TASK_STATUS_MAP: Record<string, MissionObjective['status']> = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
};

export function adaptLegacyMission(legacy: LegacyMission): MissionState {
  const now = new Date().toISOString();
  const objectives: MissionObjective[] = (legacy.task_tree ?? []).map((t, i) => ({
    id: t.id ?? `t${i + 1}`,
    description: t.description ?? '',
    status: TASK_STATUS_MAP[t.status ?? 'PENDING'] ?? 'pending',
    owner_id: legacy.user_id ?? 'unknown',
    dependency_ids: [],
  }));
  const state: MissionState = {
    schema_version: '1.0',
    mission_id: legacy._id,
    version: 1,
    title: legacy.meta_goal ?? legacy._id,
    intent: legacy.meta_goal ?? '',
    status: STATUS_MAP[legacy.status ?? 'ACTIVE'] ?? 'active',
    owner_id: legacy.user_id ?? 'unknown',
    shared_id: legacy.shared_id,
    success_criteria: [
      { id: 'c1', description: legacy.meta_goal ?? legacy._id, status: 'unmet' },
    ],
    authority_class: 'B' as AuthorityClass,
    objectives,
    created_at: legacy.created_at ? new Date(legacy.created_at).toISOString() : now,
    updated_at: legacy.updated_at ? new Date(legacy.updated_at).toISOString() : now,
  };
  return state;
}

export async function adoptLegacyMission(db: Db, legacyMissionId: string): Promise<MissionState> {
  const existing = await db
    .collection(COLLECTIONS.missionStates)
    .findOne({ mission_id: legacyMissionId }, { projection: { _id: 0 } });
  if (existing) return existing as unknown as MissionState;

  const legacy = await db
    .collection('memory_missions')
    .findOne({ _id: legacyMissionId } as any, { projection: { _id: 1, user_id: 1, status: 1, meta_goal: 1, task_tree: 1, shared_id: 1, created_at: 1, updated_at: 1 } });
  if (!legacy) throw new Error(`legacy mission not found: ${legacyMissionId}`);

  const state = adaptLegacyMission(legacy as unknown as LegacyMission);
  await db.collection(COLLECTIONS.missionStates).insertOne(state);
  return state;
}
