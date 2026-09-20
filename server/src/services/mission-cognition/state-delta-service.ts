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
      // The operation contract allows only op/path/value/from, so the objective
      // arrives in `value` (`objective` is kept as a fallback for rows written
      // directly to the collection). Reading `op0.objective` alone made this
      // branch a guaranteed no-op: every OBJECTIVE_CREATED was accepted, advanced
      // the version, and created nothing.
      const rawObjective = op0?.value ?? op0?.objective;
      const objective = (rawObjective && typeof rawObjective === 'object')
        ? rawObjective as Record<string, any>
        : undefined;
      if (objective?.id && objective?.description) {
        next.objectives ??= [];
        if (!next.objectives.some(o => o.id === objective.id)) next.objectives.push(objective as never);
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
        // A `replace` on a /status path carries the status as the raw value;
        // an update delta may instead carry an object. Accept both, and never
        // write undefined over a real status (that would be an accepted write
        // that silently changes nothing — the failure this assertion guards).
        const raw = op0?.value;
        const nextStatus =
          typeof raw === 'string' ? raw : (raw?.status ?? op0?.status ?? undefined);
        if (nextStatus !== undefined) criterion.status = nextStatus;
        const refs = typeof raw === 'object' && raw !== null ? raw.evidence_refs : undefined;
        if (Array.isArray(refs)) criterion.evidence_refs = refs;
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
 * Fail closed on deltas that could not take effect.
 *
 * `applyDeltaToState` is a pure merge and every branch is written defensively
 * (`if (obj)`, `if (criterion)`, `if (op0?.status)`) — so a delta that names a
 * target that does not exist, or omits the value its branch needs, is a *silent
 * no-op*. The caller is told `accepted`, the version still advances, and nothing
 * actually changed. That is the exact failure mode the outbox + monotonic-version
 * protocol exists to prevent, and it has been observed three times in practice:
 *
 *   1. OBJECTIVE_COMPLETED with an array-index path (/objectives/0/status)
 *   2. SUCCESS_CRITERION_UPDATED carrying an object where the branch read a string
 *   3. ledger-reference deltas (the `default:` branch) submitted with content in
 *      operations[].value and NO ledger_entries — the content was discarded while
 *      the version advanced; the research mission's findings landed only in the
 *      delta record and the epistemic ledger stayed empty.
 *
 * This function covers every branch of the applier. Rejected before any write,
 * consistent with Rule 1.
 */

/** Delta types whose only state effect is appending ledger_refs (applier default). */
const LEDGER_REFERENCE: ReadonlySet<DeltaType> = new Set<DeltaType>([
  'CLAIM_ADDED', 'EVIDENCE_ADDED', 'ASSUMPTION_CHALLENGED',
  'UNCERTAINTY_OPENED', 'UNCERTAINTY_UPDATED', 'UNCERTAINTY_RESOLVED',
  'HYPOTHESIS_ADDED', 'HYPOTHESIS_REJECTED',
  'EXPERIMENT_PROPOSED', 'EXPERIMENT_RESULT',
  'DECISION_PROPOSED', 'DECISION_ACCEPTED', 'DECISION_INVALIDATED',
  'CAPABILITY_REQUESTED', 'PLAN_CHANGE_PROPOSED',
]);
const OBJECTIVE_TARGETED: ReadonlySet<DeltaType> = new Set<DeltaType>([
  'OBJECTIVE_UPDATED', 'OBJECTIVE_COMPLETED', 'BLOCKED',
]);

export function assertTargetsResolve(state: MissionState, draft: StateDeltaDraft): void {
  const raw = (draft.operations[0] as { path?: unknown } | undefined)?.path;
  const path: string | undefined = typeof raw === 'string' ? raw : undefined;
  const segment = path?.startsWith('/') ? path.split('/')[2] : undefined;

  const OBJECTIVE_STATUSES = ['pending', 'ready', 'in_progress', 'blocked', 'completed', 'cancelled'];
  const CRITERION_STATUSES = ['unmet', 'partial', 'met', 'waived'];

  // Value APPLICABILITY. Resolving the target is not enough: a delta can name a
  // real objective or criterion and still change nothing, because the schema's
  // `value` is optional and unconstrained. OBJECTIVE_UPDATED with no value, or
  // value={}, and SUCCESS_CRITERION_UPDATED likewise, were accepted and advanced
  // the version without writing anything. (Raised by the Verifier's break-attempt
  // against the deployed build — the checks must live INSIDE these blocks, before
  // their returns, or the narrowed type makes them unreachable.)

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
    // OBJECTIVE_COMPLETED ("completed") and BLOCKED ("blocked") carry their own
    // effect, so only OBJECTIVE_UPDATED needs an applicable value.
    if (draft.delta_type === 'OBJECTIVE_UPDATED') {
      const value = (draft.operations[0] as { value?: unknown } | undefined)?.value;
      const v = (value && typeof value === 'object' ? value : {}) as {
        description?: unknown;
        status?: unknown;
      };
      const hasDescription = typeof v.description === 'string' && v.description.trim().length > 0;
      const hasStatus = typeof v.status === 'string' && OBJECTIVE_STATUSES.includes(v.status);
      if (v.description !== undefined && !hasDescription) {
        throw new Error('OBJECTIVE_UPDATED description must be a non-empty string when present');
      }
      if (!hasDescription && !hasStatus) {
        throw new Error(
          'OBJECTIVE_UPDATED requires operations[0].value with a non-empty description or a valid status ' +
            `(${OBJECTIVE_STATUSES.join('|')}); a valueless update changes no state`,
        );
      }
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
    const value = (draft.operations[0] as { value?: unknown } | undefined)?.value;
    const isStatusString = typeof value === 'string' && CRITERION_STATUSES.includes(value);
    const v = (value && typeof value === 'object' ? value : {}) as {
      status?: unknown;
      evidence_refs?: unknown;
    };
    const hasStatus = typeof v.status === 'string' && CRITERION_STATUSES.includes(v.status);
    const hasRefs = Array.isArray(v.evidence_refs) && v.evidence_refs.length > 0;
    if (!isStatusString && !hasStatus && !hasRefs) {
      throw new Error(
        'SUCCESS_CRITERION_UPDATED requires operations[0].value to be a status string or an object with ' +
          `a valid status (${CRITERION_STATUSES.join('|')}) or non-empty evidence_refs; ` +
          'a valueless update changes no state',
      );
    }
    return;
  }

  // OBJECTIVE_CREATED: the applier only pushes when the op carries a complete
  // objective (`if (objective?.id && objective?.description)`), so a partial op
  // creates nothing while still being recorded accepted.
  if (draft.delta_type === 'OBJECTIVE_CREATED') {
    const op = draft.operations[0] as { value?: unknown; objective?: unknown } | undefined;
    const raw = op?.value ?? op?.objective;
    const objective = (raw && typeof raw === 'object' ? raw : undefined) as
      | { id?: unknown; description?: unknown }
      | undefined;
    if (!objective || typeof objective.id !== 'string' || !objective.id || !objective.description) {
      throw new Error(
        'OBJECTIVE_CREATED requires operations[0].value with a string id and a non-empty description',
      );
    }
    return;
  }

  // MISSION_STATUS_CHANGED: `if (op0?.status) next.status = op0.status` — no
  // status means no effect.
  if (draft.delta_type === 'MISSION_STATUS_CHANGED') {
    const status = (draft.operations[0] as { status?: unknown } | undefined)?.status;
    if (typeof status !== 'string' || !status) {
      throw new Error('MISSION_STATUS_CHANGED requires operations[0].status (a non-empty string)');
    }
    return;
  }

  // Ledger-reference deltas: state holds only the refs, so without at least one
  // complete ledger entry the delta changes nothing at all. This is the branch
  // that quietly discarded the research findings.
  if (LEDGER_REFERENCE.has(draft.delta_type)) {
    const entries = draft.ledger_entries ?? [];
    if (entries.length === 0) {
      throw new Error(
        `${draft.delta_type} carries no ledger_entries, so it would change no state; ` +
          'the statement belongs in ledger_entries, not in operations[].value',
      );
    }
    const incomplete = entries.find(
      e => !(e as { statement?: unknown })?.statement || !(e as { entry_type?: unknown })?.entry_type,
    );
    if (incomplete) {
      throw new Error(`${draft.delta_type} has a ledger entry missing statement or entry_type`);
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
