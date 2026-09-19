// Mission State service (Phase 1) — versioned operational truth, checkpoints,
// deterministic rebuild. Versions are monotonic (invariant #1); rebuild replays
// accepted deltas over a checkpoint (invariant #3).
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db, Collection } from 'mongodb';
import { COLLECTIONS, MISSION_STATE_VERSION_KEEP } from './collections.js';
import { SCHEMA_IDS, validateAgainst } from './schema-registry.js';
import { emitMissionEvent } from './event-rail.js';
import type { MissionState, StateDelta } from '../../types/cognitive-control.js';

type StoredMissionState = MissionState & { _id?: unknown };
type StoredVersion = { mission_id: string; version: number; checkpoint_id: string; state: MissionState; created_at: string; _id?: unknown };

export class MissionStateService {
  constructor(private readonly db: Db) {}

  private states(): Collection<StoredMissionState> {
    return this.db.collection(COLLECTIONS.missionStates);
  }

  private versions(): Collection<StoredVersion> {
    return this.db.collection(COLLECTIONS.missionStateVersions);
  }

  async createMissionState(draft: Omit<MissionState, 'version' | 'created_at' | 'updated_at'>): Promise<MissionState> {
    const now = new Date().toISOString();
    const state: MissionState = { ...draft, version: 1, created_at: now, updated_at: now };
    const check = validateAgainst(SCHEMA_IDS.missionState, state);
    if (!check.valid) throw new Error(`mission state invalid: ${check.errors.join('; ')}`);
    await this.states().insertOne(state);
    await emitMissionEvent(this.db, {
      mission_id: state.mission_id,
      event_type: 'mission.created',
      version: 1,
      summary: state.title,
    });
    return state;
  }

  async getMissionState(missionId: string, version?: number): Promise<MissionState | null> {
    if (version === undefined) {
      return this.states().findOne({ mission_id: missionId }, { projection: { _id: 0 } });
    }
    const snap = await this.versions().findOne(
      { mission_id: missionId, version: { $lte: version } },
      { projection: { _id: 0 }, sort: { version: -1 } },
    );
    if (snap) return snap.state;
    // Versions only exist as snapshots at checkpoints; a request for the
    // current (uncheckpointed) version resolves to the materialized state.
    const current = await this.states().findOne({ mission_id: missionId }, { projection: { _id: 0 } });
    return current && current.version === version ? current : null;
  }

  /** Durable checkpoint: snapshot the current state; compact version history to the last 30. */
  async checkpointMission(missionId: string, actorId: string): Promise<MissionState | null> {
    const current = await this.getMissionState(missionId);
    if (!current) return null;
    const checkpointId = randomUUID();
    const now = new Date().toISOString();
    // The snapshot and the materialized state must be the SAME object so that
    // rebuild-from-checkpoint reproduces the materialized state byte-identically
    // (contract criterion 13): build once, persist once, update once.
    const checkpointed: MissionState = { ...current, checkpoint_id: checkpointId, updated_at: now };
    await this.versions().insertOne({
      mission_id: missionId,
      version: checkpointed.version,
      checkpoint_id: checkpointId,
      state: checkpointed,
      created_at: now,
    });
    // Compaction: keep the newest MISSION_STATE_VERSION_KEEP versions per mission.
    const stale = await this.versions()
      .find({ mission_id: missionId }, { projection: { _id: 0, version: 1 }, sort: { version: -1 }, skip: MISSION_STATE_VERSION_KEEP })
      .toArray();
    if (stale.length > 0) {
      await this.versions().deleteMany({
        mission_id: missionId,
        version: { $in: stale.map(s => s.version) },
      });
    }
    await this.states().updateOne(
      { mission_id: missionId },
      { $set: { checkpoint_id: checkpointId, updated_at: now } },
    );
    await emitMissionEvent(this.db, {
      mission_id: missionId,
      event_type: 'mission.checkpoint.created',
      version: current.version,
      summary: `checkpoint at v${current.version} by ${actorId}`,
    });
    return this.getMissionState(missionId);
  }

  /** Deterministic rebuild: latest checkpoint state + replay of accepted deltas. */
  async rebuildFromCheckpoint(missionId: string): Promise<MissionState | null> {
    const latest = await this.versions()
      .find({ mission_id: missionId }, { projection: { _id: 0 }, sort: { version: -1 }, limit: 1 })
      .toArray();
    const deltas = await this.db
      .collection<StateDelta & { _id?: unknown }>(COLLECTIONS.stateDeltas)
      .find({ mission_id: missionId, status: 'accepted' }, { projection: { _id: 0 } })
      .sort({ created_at: 1 })
      .toArray();
    if (latest.length === 0 && deltas.length === 0) return null;
    // Start from the newest checkpoint at or before the first delta version, else the
    // earliest checkpoint, else a synthetic base derived from the current state doc.
    const base = latest[0]?.state ?? (await this.states().findOne({ mission_id: missionId }, { projection: { _id: 0 } }));
    if (!base) return null;
    let state: MissionState = structuredClone(base);
    const { applyDeltaToState } = await import('./state-delta-service.js');
    for (const delta of deltas) {
      if (state.version !== delta.base_mission_version) continue; // only contiguous replay
      state = applyDeltaToState(state, delta, delta.applied_at);
      state.version = delta.base_mission_version + 1;
    }
    return state;
  }

  /** Advance the materialized state exactly once per accepted delta. */
  async advanceState(missionId: string, next: MissionState): Promise<void> {
    await this.states().updateOne({ mission_id: missionId }, { $set: { ...next } });
  }
}
