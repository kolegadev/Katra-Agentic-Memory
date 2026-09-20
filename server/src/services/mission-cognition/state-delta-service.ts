// State Delta service (Phase 1) — typed, idempotent, version-checked mutations.
// Merge rules follow handoff doc 02 §"Merge rules". Mongo on this stack is a
// standalone (no transactions): the write path is outbox-style — delta record
// (proposed) → ledger appends → state advance → mark accepted + emit event.
// A crash in the middle leaves a `proposed` delta that rebuild/repair skips.
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import { SCHEMA_IDS, validateAgainst } from './schema-registry.js';
import { emitMissionEvent } from './event-rail.js';
import { MissionStateService } from './mission-state-service.js';
import { EpistemicLedgerService } from './epistemic-ledger-service.js';
import type { DeltaStatus, DeltaType, MissionState, StateDelta, StateDeltaDraft } from '../../types/cognitive-control.js';

/** Additive, commutative delta types auto-merge even under concurrent writers. */
const COMMUTATIVE_ADDITIVE: ReadonlySet<DeltaType> = new Set([
  'CLAIM_ADDED', 'EVIDENCE_ADDED', 'HYPOTHESIS_ADDED', 'UNCERTAINTY_OPENED',
  'EXPERIMENT_PROPOSED', 'EXPERIMENT_RESULT', 'OBJECTIVE_CREATED',
  'CHECKPOINT_CREATED', 'CAPABILITY_REQUESTED', 'BLOCKED', 'PLAN_CHANGE_PROPOSED',
]);

/** Pure merge of one delta into a mission state (no IO). Exported for rebuild. */
export function applyDeltaToState(state: MissionState, delta: StateDelta, now?: string): MissionState {
  const next: MissionState = structuredClone(state);
  const effectiveNow = now ?? new Date().toISOString();
  const entryIds = (delta.ledger_entries ?? []).map(e => e.entry_id!).filter(Boolean);
  const appendRefs = (...ids: string[]) => {
    const have = new Set(next.ledger_refs ?? []);
    for (const id of ids) if (id && !have.has(id)) (next.ledger_refs ??= []).push(id);
  };
  appendRefs(...entryIds);

  const op0 = delta.operations[0] as Record<string, any> | undefined;
  // The operation contract allows only op/path/value/from — the objective id
  // is carried in the path (e.g. /objectives/<id>/status).
  const objectiveId = () =>
    (typeof op0?.path === 'string' && op0.path.startsWith('/objectives/'))
      ? (op0.path.split('/')[2] ?? undefined)
      : undefined;
  const criterionId = () =>
    (typeof op0?.path === 'string' && op0.path.startsWith('/success_criteria/'))
      ? (op0.path.split('/')[2] ?? undefined)
      : undefined;
  switch (delta.delta_type) {
    case 'OBJECTIVE_CREATED': {
      const objective = op0?.objective;
      if (objective?.id && objective?.description) {
        next.objectives ??= [];
        if (!next.objectives.some(o => o.id === objective.id)) next.objectives.push(objective);
      }
      break;
    }
    case 'OBJECTIVE_UPDATED':
    case 'OBJECTIVE_COMPLETED': {
      const id = objectiveId();
      const obj = next.objectives?.find(o => o.id === id);
      if (obj) {
        obj.description = op0?.value?.description ?? op0?.description ?? obj.description;
        obj.status = delta.delta_type === 'OBJECTIVE_COMPLETED' ? 'completed' : (op0?.value?.status ?? obj.status);
      }
      break;
    }
    case 'BLOCKED': {
      const id = objectiveId();
      const obj = next.objectives?.find(o => o.id === id);
      if (obj) obj.status = 'blocked';
      break;
    }
    case 'SUCCESS_CRITERION_UPDATED': {
      const id = criterionId();
      const criterion = next.success_criteria?.find(c => c.id === id);
      if (criterion) {
        criterion.status = op0?.value?.status ?? op0?.status ?? criterion.status;
        if (Array.isArray(op0?.value?.evidence_refs)) criterion.evidence_refs = op0.value.evidence_refs;
      }
      break;
    }
    case 'MISSION_STATUS_CHANGED': {
      if (op0?.status) next.status = op0.status;
      break;
    }
    default:
      // Ledger-reference deltas: content lives in the ledger; state holds the ref.
      break;
  }
  next.updated_at = effectiveNow;
  return next;
}

/**
 * Fail closed on targeted deltas whose path names a target that does not exist.
 *
 * `applyDeltaToState` is a pure merge and every targeted branch is written as
 * `if (obj)` / `if (criterion)` — an unmatched id is therefore a *silent no-op*.
 * Without this check the caller is told `accepted`, the version still advances,
 * and nothing actually changed: an accepted-but-ineffective write, which is the
 * exact failure mode the outbox + monotonic-version protocol exists to prevent.
 * Rejected before any write, consistent with Rule 1.
 */
const OBJECTIVE_TARGETED: ReadonlySet<DeltaType> = new Set<DeltaType>([
  'OBJECTIVE_UPDATED', 'OBJECTIVE_COMPLETED', 'BLOCKED',
]);

export function assertTargetsResolve(state: MissionState, draft: StateDeltaDraft): void {
  const raw = (draft.operations[0] as { path?: unknown } | undefined)?.path;
  const path: string | undefined = typeof raw === 'string' ? raw : undefined;
  const segment = path?.startsWith('/') ? path.split('/')[2] : undefined;

  if (OBJECTIVE_TARGETED.has(draft.delta_type)) {
    if (!segment || !path?.startsWith('/objectives/')) {
      throw new Error(
        `${draft.delta_type} requires an objective path /objectives/<objective_id>/status (got ${JSON.stringify(path)})`,
      );
    }
    if (!(state.objectives ?? []).some(o => o.id === segment)) {
      throw new Error(
        `${draft.delta_type} targets unknown objective id "${segment}"; known: ${
          (state.objectives ?? []).map(o => o.id).join(', ') || '(none)'
        }`,
      );
    }
    return;
  }

  if (draft.delta_type === 'SUCCESS_CRITERION_UPDATED') {
    if (!segment || !path?.startsWith('/success_criteria/')) {
      throw new Error(
        `${draft.delta_type} requires a criterion path /success_criteria/<criterion_id> (got ${JSON.stringify(path)})`,
      );
    }
    if (!(state.success_criteria ?? []).some(c => c.id === segment)) {
      throw new Error(
        `${draft.delta_type} targets unknown success criterion id "${segment}"; known: ${
          (state.success_criteria ?? []).map(c => c.id).join(', ') || '(none)'
        }`,
      );
    }
  }
}

export interface SubmitOptions {
  /** Caller-bound actor identity — overrides any payload author (invariant #4). */
  actorId: string;
  executionIdentity?: string;
}

export class StateDeltaService {
  private missions: MissionStateService;
  private ledger: EpistemicLedgerService;

  constructor(private readonly db: Db) {
    this.missions = new MissionStateService(db);
    this.ledger = new EpistemicLedgerService(db);
  }

  private deltas() {
    return this.db.collection<StateDelta & { _id?: unknown }>(COLLECTIONS.stateDeltas);
  }

  async submitDelta(draft: StateDeltaDraft, opts: SubmitOptions): Promise<StateDelta> {
    // Rule 2: caller identity is authoritative; payload author_id is ignored.
    const deltaDraft: StateDeltaDraft = { ...draft, author_id: opts.actorId };
    const deltaId = draft.delta_id ?? randomUUID();
    const now = new Date().toISOString();

    if (!draft.idempotency_key || draft.idempotency_key.length < 8) {
      throw new Error('idempotency_key must be at least 8 characters (contract: state-delta.schema.json)');
    }

    // Embedded ledger entries must be complete contracts (entry_id + timestamps)
    // before validation; the ledger service honours pre-assigned ids.
    const normalizedEntries = (draft.ledger_entries ?? []).map(e => ({
      ...e,
      entry_id: e.entry_id ?? randomUUID(),
      created_at: e.created_at ?? now,
      updated_at: e.updated_at ?? now,
    }));

    // Rule 1: reject malformed deltas before any write.
    const check = validateAgainst(SCHEMA_IDS.stateDelta, {
      ...deltaDraft,
      ledger_entries: normalizedEntries,
      delta_id: deltaId,
      created_at: now,
    });
    if (!check.valid) throw new Error(`state delta invalid: ${check.errors.join('; ')}`);

    // Rule 3: deduplicate by idempotency key.
    const existing = await this.deltas().findOne({ idempotency_key: draft.idempotency_key });
    if (existing) {
      return { ...existing, status: existing.status === 'accepted' ? 'accepted' : existing.status, _id: undefined } as StateDelta;
    }

    const current = await this.missions.getMissionState(draft.mission_id);
    if (!current) throw new Error(`mission not found: ${draft.mission_id}`);
    // Rule 1 (semantic): a targeted delta that names a non-existent target would
    // otherwise be accepted as a no-op. Reject while still making no writes.
    assertTargetsResolve(current, draft);

    // Rule 4: compare base version with current mission version.
    const competing = await this.deltas().findOne({
      mission_id: draft.mission_id,
      base_mission_version: draft.base_mission_version,
      status: 'accepted',
    });
    let status: DeltaStatus;
    if (draft.base_mission_version !== current.version) {
      status = 'conflict';
    } else if (competing && !COMMUTATIVE_ADDITIVE.has(draft.delta_type)) {
      // Rule 6: conflicting writers on non-additive types route to conflict;
      // neither proposal is dropped (invariant: "conflict resolution never drops").
      status = 'conflict';
    } else {
      status = 'proposed';
    }

    const auditHash = createHash('sha256')
      .update(JSON.stringify({ ...deltaDraft, ledger_entries: normalizedEntries, delta_id: deltaId }))
      .digest('hex');

    const delta: StateDelta = {
      ...deltaDraft,
      ledger_entries: normalizedEntries,
      delta_id: deltaId,
      status,
      created_at: now,
      audit_hash: auditHash,
      execution_identity: opts.executionIdentity,
    };

    if (status !== 'proposed') {
      await this.deltas().insertOne(delta);
      await emitMissionEvent(this.db, {
        mission_id: draft.mission_id,
        event_type: status === 'conflict' ? 'delta.conflict' : 'delta.rejected',
        delta_id: deltaId,
        version: current.version,
        summary: `${draft.delta_type} vs base v${draft.base_mission_version} (current v${current.version})`,
      });
      return delta;
    }

    // Outbox-style apply: record → ledger → state → accept.
    await this.deltas().insertOne(delta);
    try {
      // Rule 7: append ledger entries before materializing state.
      const entryIds: string[] = [];
      for (const entryDraft of normalizedEntries) {
        const created = await this.ledger.appendEntry(entryDraft, { actorId: opts.actorId });
        entryIds.push(created.entry_id);
      }
      const applied: StateDelta = { ...delta, ledger_entries: normalizedEntries.map((e, i) => ({ ...e, entry_id: entryIds[i] ?? e.entry_id })) };
      // Single timestamp for the state's updated_at AND the delta's applied_at:
      // rebuild-from-checkpoint replays with applied_at, so the replayed state
      // must carry the same value the materialized state got (criterion 13).
      const appliedAt = new Date().toISOString();
      const next = applyDeltaToState(current, applied, appliedAt);
      next.version = current.version + 1; // invariant #1: monotonic
      await this.missions.advanceState(draft.mission_id, next);
      applied.status = 'accepted';
      applied.applied_at = appliedAt;
      await this.deltas().updateOne(
        { delta_id: deltaId },
        { $set: { status: 'accepted', applied_at: applied.applied_at, ledger_entries: applied.ledger_entries } },
      );
      await emitMissionEvent(this.db, {
        mission_id: draft.mission_id,
        event_type: 'delta.accepted',
        delta_id: deltaId,
        version: next.version,
        summary: `${draft.delta_type} accepted -> v${next.version}`,
      });
      // Rule 10: invalidate stale batons issued before this version.
      const { BatonService } = await import('./baton-service.js');
      await new BatonService(this.db).invalidateBatonsForMission(draft.mission_id, next.version);
      return applied;
    } catch (error) {
      await this.deltas().updateOne({ delta_id: deltaId }, { $set: { status: 'rejected' } });
      await emitMissionEvent(this.db, {
        mission_id: draft.mission_id,
        event_type: 'delta.rejected',
        delta_id: deltaId,
        summary: `apply failed: ${String(error).slice(0, 200)}`,
      });
      throw error;
    }
  }

  async listDeltas(missionId: string, limit = 50): Promise<StateDelta[]> {
    return this.deltas()
      .find({ mission_id: missionId }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
  }
}
