// Resume report builder — the continuity surface for Iteration 1 (criteria 9-13).
// Reconstructs everything an agent needs after a TOTAL context clear, from the
// state store only (Mission State + checkpoint + accepted deltas + ledger).
// No conversation history is consulted anywhere in this path.
// Part of the no-publish branch feat/cognitive-control-local.
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import type { MissionState, StateDelta } from '../../types/cognitive-control.js';

export interface ResumeReport {
  mission: {
    mission_id: string;
    title: string;
    status: string;
    version: number;
    owner_id: string;
    authority_class: string;
    success_criteria: Array<{ id: string; description: string; status: string }>;
  };
  checkpoint: { checkpoint_id: string | null; version: number | null; created_at: string | null };
  changed_since_checkpoint: Array<{
    delta_id: string;
    delta_type: string;
    applied_at: string | null;
    author_id: string;
    summary: string;
  }>;
  active_uncertainties: Array<{ entry_id: string; statement: string; status: string }>;
  next_action: { kind: 'objective' | 'blocked' | 'complete'; objective_id?: string; description?: string; rationale: string };
  reconstruction_source: string[]; // proves no-transcript-replay: names the stores used
}

interface ObjectiveLike { id: string; description: string; status: string; dependency_ids?: string[] }

export function computeNextAction(state: MissionState): ResumeReport['next_action'] {
  const objectives: ObjectiveLike[] = (state.objectives ?? []).map(o => ({
    id: o.id,
    description: o.description,
    status: o.status,
    dependency_ids: o.dependency_ids ?? [],
  }));
  const completed = new Set(objectives.filter(o => o.status === 'completed').map(o => o.id));
  const actionable = objectives.find(
    o =>
      (o.status === 'pending' || o.status === 'ready') &&
      (o.dependency_ids ?? []).every(dep => completed.has(dep)),
  );
  if (actionable) {
    return {
      kind: 'objective',
      objective_id: actionable.id,
      description: actionable.description,
      rationale: 'first pending/ready objective with all dependencies completed (by insertion order)',
    };
  }
  const inProgress = objectives.find(o => o.status === 'in_progress');
  if (inProgress) {
    return {
      kind: 'objective',
      objective_id: inProgress.id,
      description: inProgress.description,
      rationale: 'objective already in progress — continue it',
    };
  }
  const firstOpen = objectives.find(o => o.status !== 'completed' && o.status !== 'cancelled');
  if (firstOpen) {
    return {
      kind: 'blocked',
      objective_id: firstOpen.id,
      description: firstOpen.description,
      rationale: `no unblocked pending objective; next open objective is ${firstOpen.status} (dependencies or owner needed)`,
    };
  }
  // Objectives being done is not the same as the mission being done. Previously
  // this branch emitted the same "verify success criteria" line whether the
  // criteria were all met or none had been looked at, which is misleading in
  // exactly the case a reader most wants clarity: a finished mission.
  const criteria = state.success_criteria ?? [];
  const openCriteria = criteria.filter(c => c.status !== 'met' && c.status !== 'waived');
  if (criteria.length > 0 && openCriteria.length === 0) {
    return {
      kind: 'complete',
      rationale:
        `all ${objectives.length} objective(s) completed and all ${criteria.length} success criteria ` +
        'satisfied — the mission is ready to close',
    };
  }
  if (criteria.length === 0) {
    return {
      kind: 'complete',
      rationale: 'all objectives completed — no success criteria are declared on this mission',
    };
  }
  return {
    kind: 'complete',
    rationale:
      `all objectives completed — ${openCriteria.length} of ${criteria.length} success criteria still open ` +
      `(${openCriteria.map(c => c.id).join(', ')}); verify them before closing the mission`,
  };
}

export async function buildResumeReport(db: Db, missionId: string): Promise<ResumeReport> {
  const state = await db
    .collection<MissionState & { _id?: unknown }>(COLLECTIONS.missionStates)
    .findOne({ mission_id: missionId }, { projection: { _id: 0 } });
  if (!state) throw new Error(`mission not found: ${missionId}`);

  // Latest checkpoint snapshot (version + timestamp) at or before the current version.
  const checkpointDoc = await db
    .collection(COLLECTIONS.missionStateVersions)
    .findOne(
      { mission_id: missionId, version: { $lte: state.version } },
      { projection: { _id: 0, checkpoint_id: 1, version: 1, created_at: 1 }, sort: { version: -1 } },
    );
  const checkpoint = checkpointDoc
    ? { checkpoint_id: checkpointDoc.checkpoint_id ?? null, version: checkpointDoc.version ?? null, created_at: checkpointDoc.created_at ?? null }
    : { checkpoint_id: state.checkpoint_id ?? null, version: null, created_at: null };

  // Accepted deltas applied after the checkpoint version.
  const sinceVersion = checkpoint.version ?? 0;
  const deltas = await db
    .collection<StateDelta & { _id?: unknown }>(COLLECTIONS.stateDeltas)
    .find(
      { mission_id: missionId, status: 'accepted', base_mission_version: { $gte: sinceVersion } },
      { projection: { _id: 0, delta_id: 1, delta_type: 1, applied_at: 1, author_id: 1, rationale: 1 } },
    )
    .sort({ created_at: 1 })
    .limit(50)
    .toArray();

  const uncertainties = await db
    .collection(COLLECTIONS.epistemicEntries)
    .find(
      { mission_id: missionId, entry_type: 'uncertainty', status: { $in: ['active', 'accepted', 'challenged'] } },
      { projection: { _id: 0, entry_id: 1, statement: 1, status: 1 } },
    )
    .sort({ created_at: -1 })
    .limit(20)
    .toArray() as unknown as Array<{ entry_id: string; statement: string; status: string }>;

  return {
    mission: {
      mission_id: state.mission_id,
      title: state.title,
      status: state.status,
      version: state.version,
      owner_id: state.owner_id,
      authority_class: state.authority_class,
      success_criteria: state.success_criteria,
    },
    checkpoint,
    changed_since_checkpoint: deltas.map(d => ({
      delta_id: d.delta_id,
      delta_type: d.delta_type,
      applied_at: d.applied_at ?? null,
      author_id: d.author_id,
      summary: d.rationale.slice(0, 200),
    })),
    active_uncertainties: uncertainties,
    next_action: computeNextAction(state),
    reconstruction_source: [
      'mission_states (current materialized state)',
      'mission_state_versions (checkpoint snapshot)',
      'state_deltas (accepted deltas)',
      'epistemic_entries (open uncertainties)',
      'NO conversation history / transcript consulted',
    ],
  };
}
