// Phase 6: controlled activation — evidence gate, mode transitions, opt-ins,
// hard bound, counterfactuals, and the activation ledger.
//
// Contract invariants enforced HERE (and nowhere else):
//   §4.1/4.2  `recommend` cannot be enabled without >=50 evidenced shadow decisions
//             whose allocator observation is recorded AND a human-read acknowledgement.
//             The gate reads STORED RECORDS only — never an assertion, never a caller number.
//   §4.3      ladder semantics: one rung at a time upward, any downward move allowed.
//   §4.6      allocate_gated is NOT implemented (no externally-visible effect pathway to
//             gate) — enabling it is refused and recorded.
//   §4.7/4.8  per-mission opt-in; revocation effective immediately (runtime read, no rebuild).
//   §4.9      hard bound per activation cycle: breach HALTS influence (fail closed).
//   §4.10     kill switch forces off regardless of every other flag.
//   §4.12-14  every influenced allocation records the existing allocator's counterfactual
//             choice; records distinguish scheduler-taken vs allocator-taken; human-readable why.
//   §4.19/20  every transition reachable in reverse and recorded with who/when/evidence.
// Part of the no-publish branch feat/cognitive-control-local.
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import {
  IMPLEMENTED_MODES,
  SCHEDULER_MODE_LADDER,
  killSwitchActive,
  schedulerMode,
  setRuntimeSchedulerMode,
} from './scheduler-mode.js';
import type {
  ActivationLedgerEntry,
  AllocationCounterfactual,
  AllocatorObservation,
  EvidenceAcknowledgement,
  EvidenceGateState,
  MissionOptIn,
  SchedulerDecision,
  SchedulerMode,
} from '../../types/cognitive-control.js';

/** §4.1 — evidence threshold for enabling `recommend`. */
export const EVIDENCE_THRESHOLD = 50;
/** §4.9 — default hard bound on influenced work items per activation cycle (env-overridable). */
export function activationHardBound(): number {
  const raw = Number.parseInt(process.env.COGNITIVE_ACTIVATION_HARD_BOUND ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

// ── Activation ledger ──────────────────────────────────────────────────────

export async function recordLedger(
  db: Db,
  entry: Omit<ActivationLedgerEntry, 'ledger_id' | 'created_at'>,
): Promise<ActivationLedgerEntry> {
  const full: ActivationLedgerEntry = {
    ledger_id: randomUUID(),
    created_at: new Date().toISOString(),
    ...entry,
  };
  await db.collection(COLLECTIONS.activationLedger).insertOne(full);
  return full;
}

// ── Evidence gate (§4.1-4.2) ───────────────────────────────────────────────

interface QualifyingDecision {
  decision: SchedulerDecision;
  observation: AllocatorObservation;
}

async function qualifyingDecisions(db: Db): Promise<QualifyingDecision[]> {
  const missionIds = new Set(
    ((await db.collection(COLLECTIONS.missionStates).find({}, { projection: { mission_id: 1 } }).toArray()) as any[])
      .map((m: any) => m.mission_id),
  );
  const rows = (await db
    .collection(COLLECTIONS.schedulerDecisions)
    .find(
      { scheduler_mode: { $in: ['shadow', 'recommend'] }, 'allocator_observation.observed_at': { $exists: true } },
      { projection: { _id: 0 } },
    )
    .toArray()) as unknown as SchedulerDecision[];
  // "for real missions": the decision's mission must exist in mission_states,
  // the scheduler must have ranked candidates, and the allocator's actual choice
  // must be recorded on the decision. Anything less is not evidence.
  return rows
    .filter(d => missionIds.has(d.mission_id))
    .filter(d => (d.candidates?.length ?? 0) > 0 && d.allocator_observation)
    .map(d => ({ decision: d, observation: d.allocator_observation! }));
}

export async function latestEvidenceAcknowledgement(db: Db): Promise<EvidenceAcknowledgement | null> {
  const rows = (await db
    .collection(COLLECTIONS.activationLedger)
    .find({ kind: 'evidence_acknowledged' }, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .limit(1)
    .toArray()) as unknown as ActivationLedgerEntry[];
  const row = rows[0];
  if (!row) return null;
  const d = row.detail ?? {};
  return {
    acknowledgement_id: row.ledger_id,
    acknowledged_by: row.actor_id,
    created_at: row.created_at,
    decision_count: Number(d.decision_count ?? 0),
    observed_decisions: Number(d.observed_decisions ?? 0),
    agreement_rate: typeof d.agreement_rate === 'number' ? d.agreement_rate : null,
    note: typeof d.note === 'string' ? d.note : undefined,
  };
}

export async function computeEvidenceGate(db: Db): Promise<EvidenceGateState> {
  const qualifying = await qualifyingDecisions(db);
  const observed = qualifying.filter(q => q.decision.recommended !== null);
  const agreements = observed.filter(q => q.observation.agent_id !== null && q.observation.agent_id === q.decision.recommended!.agent_id);
  const agreementRate = observed.length > 0 ? agreements.length / observed.length : null;
  const ack = await latestEvidenceAcknowledgement(db);
  const acknowledged = Boolean(ack && ack.decision_count >= EVIDENCE_THRESHOLD);
  const gateOpen = qualifying.length >= EVIDENCE_THRESHOLD && acknowledged;
  const reason = gateOpen
    ? `gate open: ${qualifying.length} evidenced decisions (>= ${EVIDENCE_THRESHOLD}) and a human-read acknowledgement exists.`
    : qualifying.length < EVIDENCE_THRESHOLD
      ? `gate closed: only ${qualifying.length} of ${EVIDENCE_THRESHOLD} evidenced decisions recorded.`
      : 'gate closed: evidence threshold met but no human-read acknowledgement recorded.';
  return {
    gate_open: gateOpen,
    threshold: EVIDENCE_THRESHOLD,
    qualifying_decisions: qualifying.length,
    observed_decisions: observed.length,
    agreement_rate: agreementRate,
    acknowledged,
    latest_acknowledgement: ack,
    reason,
  };
}

/** Human-read acknowledgement: figures are COMPUTED from stored records, never caller-asserted. */
export async function acknowledgeEvidence(
  db: Db,
  opts: { actorId: string; note?: string },
): Promise<EvidenceGateState> {
  const state = await computeEvidenceGate(db);
  await recordLedger(db, {
    kind: 'evidence_acknowledged',
    actor_id: opts.actorId,
    reason: `human-read acknowledgement of scheduler evidence: ${state.qualifying_decisions} evidenced decisions, agreement ${state.agreement_rate === null ? 'n/a' : (state.agreement_rate * 100).toFixed(1)}%`,
    detail: {
      decision_count: state.qualifying_decisions,
      observed_decisions: state.observed_decisions,
      agreement_rate: state.agreement_rate,
      note: opts.note,
    },
  });
  return computeEvidenceGate(db);
}

// ── Allocator observation (evidence accumulation) ──────────────────────────

export async function recordAllocatorObservation(
  db: Db,
  opts: { decisionId: string; agentId: string | null; source: 'manual' | 'auto-observer'; evidenceRef?: string; note?: string },
): Promise<boolean> {
  const observation: AllocatorObservation = {
    agent_id: opts.agentId,
    observed_at: new Date().toISOString(),
    source: opts.source,
    evidence_ref: opts.evidenceRef,
    note: opts.note,
  };
  const result = await db.collection(COLLECTIONS.schedulerDecisions).updateOne(
    { decision_id: opts.decisionId },
    { $set: { allocator_observation: observation } },
  );
  return (result as any).matchedCount > 0;
}

/**
 * Strict auto-observer: after a shadow decision is recorded, read the stored
 * output of the existing allocator for the mission owner (episodic_events
 * executive_action, latest within the decision window). Observation-only —
 * the allocator is never invoked or modified.
 */
export async function observeAllocatorOutcome(
  db: Db,
  missionId: string,
  decisionId: string,
): Promise<AllocatorObservation | null> {
  try {
    const mission = (await db
      .collection(COLLECTIONS.missionStates)
      .findOne({ mission_id: missionId }, { projection: { owner_id: 1 } })) as any;
    if (!mission) return null;
    const decision = (await db
      .collection(COLLECTIONS.schedulerDecisions)
      .findOne({ decision_id: decisionId }, { projection: { created_at: 1 } })) as any;
    if (!decision) return null;
    const windowStart = new Date(new Date(decision.created_at).getTime() - 60 * 60 * 1000);
    const events = (await db
      .collection('episodic_events')
      .find({
        user_id: mission.owner_id,
        event_type: 'executive_action',
        timestamp: { $gte: windowStart, $lte: new Date(decision.created_at) },
      })
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray()) as any[];
    if (events.length === 0) return null; // unobservable — leave unobserved, never invent
    const event = events[0];
    const agentId = typeof event.metadata?.assigned_agent === 'string' ? event.metadata.assigned_agent : null;
    const observation: AllocatorObservation = {
      agent_id: agentId,
      observed_at: new Date().toISOString(),
      source: 'auto-observer',
      evidence_ref: String(event.id ?? event._id ?? 'executive_action'),
    };
    await db.collection(COLLECTIONS.schedulerDecisions).updateOne(
      { decision_id: decisionId },
      { $set: { allocator_observation: observation } },
    );
    return observation;
  } catch (err) {
    console.warn('   ⚠️ allocator observation failed (evidence unaffected):', (err as Error).message);
    return null;
  }
}

// ── Per-mission opt-in register (§4.7-4.8) ─────────────────────────────────

export async function optInMission(
  db: Db,
  opts: { missionId: string; ownerId: string; actorId: string; reason: string },
): Promise<MissionOptIn> {
  const optIn: MissionOptIn = {
    opt_in_id: randomUUID(),
    mission_id: opts.missionId,
    owner_id: opts.ownerId,
    opted_in_by: opts.actorId,
    reason: opts.reason,
    created_at: new Date().toISOString(),
  };
  await db.collection(COLLECTIONS.missionOptIns).insertOne(optIn);
  await recordLedger(db, {
    kind: 'opt_in',
    actor_id: opts.actorId,
    mission_id: opts.missionId,
    reason: opts.reason,
    detail: { opt_in_id: optIn.opt_in_id, owner_id: opts.ownerId },
  });
  return optIn;
}

export async function revokeMissionOptIn(
  db: Db,
  opts: { missionId: string; actorId: string; reason: string },
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.collection(COLLECTIONS.missionOptIns).updateMany(
    { mission_id: opts.missionId, revoked_at: { $exists: false } },
    { $set: { revoked_at: now, revoked_by: opts.actorId, revoke_reason: opts.reason } },
  );
  const count = (result as any).matchedCount ?? 0;
  await recordLedger(db, {
    kind: 'opt_in_revoke',
    actor_id: opts.actorId,
    mission_id: opts.missionId,
    reason: opts.reason,
    detail: { revoked_count: count },
  });
  return count;
}

export async function activeOptInsForOwner(db: Db, ownerId: string): Promise<MissionOptIn[]> {
  return (await db
    .collection(COLLECTIONS.missionOptIns)
    .find({ owner_id: ownerId, revoked_at: { $exists: false } }, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .limit(20)
    .toArray()) as unknown as MissionOptIn[];
}

// ── Mode transitions (§4.3, §4.10, §4.19-4.20) ─────────────────────────────

export interface SetModeResult {
  mode: SchedulerMode;
  changed: boolean;
  refused_reason?: string;
  gate?: EvidenceGateState;
  cycle_id?: string;
}

export async function setMode(
  db: Db,
  opts: { mode: SchedulerMode; actorId: string; reason: string },
): Promise<SetModeResult> {
  const current = schedulerMode();
  const target = opts.mode;

  const refuse = async (reason: string, extra?: Partial<SetModeResult>): Promise<SetModeResult> => {
    await recordLedger(db, {
      kind: 'mode_change_refused',
      actor_id: opts.actorId,
      mode_from: current,
      mode_to: target,
      reason: `${opts.reason} — REFUSED: ${reason}`,
      detail: extra?.gate ? { gate: extra.gate } : undefined,
    });
    return { mode: current, changed: false, refused_reason: reason, ...extra };
  };

  if (killSwitchActive() && target !== 'off') {
    return refuse('COGNITIVE_ACTIVATION_KILL_SWITCH=1 — only off is reachable');
  }
  if (target === 'allocate_gated') {
    return refuse('allocate_gated is not implemented (§4.6): no externally-visible effect pathway exists to gate');
  }
  if (!IMPLEMENTED_MODES.includes(target)) {
    return refuse(`unknown mode ${target}`);
  }
  if (target === current) return { mode: current, changed: false };

  const fromIdx = SCHEDULER_MODE_LADDER.indexOf(current);
  const toIdx = SCHEDULER_MODE_LADDER.indexOf(target);
  if (toIdx > fromIdx) {
    // Upward: one rung at a time — no skipping (contract §4.3).
    if (toIdx !== fromIdx + 1) {
      return refuse(`mode ladder: cannot jump ${current} → ${target}; reach one rung at a time`);
    }
    if (toIdx >= SCHEDULER_MODE_LADDER.indexOf('recommend')) {
      const gate = await computeEvidenceGate(db);
      if (!gate.gate_open) {
        return refuse(`evidence gate closed: ${gate.reason}`, { gate });
      }
    }
  }

  // Downward always allowed (reversibility, §4.19).
  const cycleId = target === 'allocate_internal' ? randomUUID() : undefined;
  await recordLedger(db, {
    kind: 'mode_change',
    actor_id: opts.actorId,
    mode_from: current,
    mode_to: target,
    reason: opts.reason,
    evidence_ref: toIdx > fromIdx && toIdx >= SCHEDULER_MODE_LADDER.indexOf('recommend')
      ? 'evidence gate open (computed from stored records)'
      : undefined,
    cycle_id: cycleId,
  });
  if (cycleId) {
    await recordLedger(db, {
      kind: 'cycle_start',
      actor_id: opts.actorId,
      mode_to: target,
      cycle_id: cycleId,
      reason: `activation cycle opened with hard bound ${activationHardBound()}`,
      detail: { hard_bound: activationHardBound() },
    });
  }
  setRuntimeSchedulerMode(target);
  return { mode: target, changed: true, cycle_id: cycleId };
}

// ── Influence query + hard bound + counterfactual (§4.5, §4.9, §4.12-14) ───

export async function currentCycleId(db: Db): Promise<string | null> {
  const row = (await db
    .collection(COLLECTIONS.activationLedger)
    .findOne({ kind: 'cycle_start' }, { projection: { _id: 0, cycle_id: 1 }, sort: { created_at: -1 } })) as any;
  return row?.cycle_id ?? null;
}

async function influencedCountInCycle(db: Db, cycleId: string): Promise<number> {
  return db.collection(COLLECTIONS.allocationCounterfactuals).countDocuments({ cycle_id: cycleId, influenced: true });
}

async function cycleHaltRecorded(db: Db, cycleId: string): Promise<boolean> {
  const row = await db
    .collection(COLLECTIONS.activationLedger)
    .findOne({ kind: 'cycle_halt', cycle_id: cycleId }, { projection: { ledger_id: 1 } });
  return Boolean(row);
}

export interface SchedulerInfluence {
  mission_id: string;
  decision_id: string;
  cycle_id: string;
  work_item_id: string;
  agent_id: string;
}

/**
 * The one entry point through which the existing allocator may consult the
 * scheduler. Returns null unless: mode is allocate_internal, the mission is
 * explicitly opted in, the scheduler's recommendation is for a candidate the
 * allocator could actually choose, and the per-cycle hard bound is not
 * breached. On breach the cycle HALTS (recorded once) — fail closed.
 */
export async function getSchedulerInfluence(
  db: Db,
  opts: { localUserId: string; candidates: string[] },
): Promise<SchedulerInfluence | null> {
  if (schedulerMode() !== 'allocate_internal') return null;
  if (killSwitchActive()) return null;
  const optIns = await activeOptInsForOwner(db, opts.localUserId);
  if (optIns.length === 0) return null;
  const cycleId = await currentCycleId(db);
  if (!cycleId) return null;
  const bound = activationHardBound();
  const used = await influencedCountInCycle(db, cycleId);
  if (used >= bound) {
    if (!(await cycleHaltRecorded(db, cycleId))) {
      await recordLedger(db, {
        kind: 'cycle_halt',
        actor_id: 'system',
        cycle_id: cycleId,
        reason: `hard bound ${bound} reached for cycle ${cycleId} — influence halted (fail closed)`,
      });
    }
    return null;
  }
  for (const optIn of optIns) {
    const decisions = (await db
      .collection(COLLECTIONS.schedulerDecisions)
      .find({ mission_id: optIn.mission_id, recommended: { $ne: null } }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(10)
      .toArray()) as unknown as SchedulerDecision[];
    for (const decision of decisions) {
      const rec = decision.recommended;
      if (!rec) continue;
      if (!opts.candidates.includes(rec.agent_id)) continue; // outside the allocator's candidate set — cannot influence
      const already = await db
        .collection(COLLECTIONS.allocationCounterfactuals)
        .findOne({ decision_id: decision.decision_id }, { projection: { counterfactual_id: 1 } });
      if (already) continue; // one decision influences at most one allocation
      return {
        mission_id: optIn.mission_id,
        decision_id: decision.decision_id,
        cycle_id: cycleId,
        work_item_id: rec.work_item_id,
        agent_id: rec.agent_id,
      };
    }
  }
  return null;
}

export async function recordAllocationCounterfactual(
  db: Db,
  opts: {
    missionId: string;
    decisionId: string;
    cycleId: string;
    workItemId: string;
    chosenAgentId: string;
    existingAllocatorAgentId: string;
    reason: string;
  },
): Promise<AllocationCounterfactual> {
  const counterfactual: AllocationCounterfactual = {
    counterfactual_id: randomUUID(),
    mission_id: opts.missionId,
    decision_id: opts.decisionId,
    cycle_id: opts.cycleId,
    work_item_id: opts.workItemId,
    mode: 'allocate_internal',
    influenced: true,
    chosen_agent_id: opts.chosenAgentId,
    existing_allocator_agent_id: opts.existingAllocatorAgentId,
    recorded_at: new Date().toISOString(),
    reason: opts.reason,
  };
  await db.collection(COLLECTIONS.allocationCounterfactuals).insertOne(counterfactual);
  await recordLedger(db, {
    kind: 'counterfactual_recorded',
    actor_id: 'autonomous-executive',
    mission_id: opts.missionId,
    cycle_id: opts.cycleId,
    reason: opts.reason,
    detail: { counterfactual_id: counterfactual.counterfactual_id, decision_id: opts.decisionId },
  });
  await recordLedger(db, {
    kind: 'influence_applied',
    actor_id: 'autonomous-executive',
    mission_id: opts.missionId,
    cycle_id: opts.cycleId,
    reason: `scheduler's choice taken: ${opts.chosenAgentId} (existing allocator would have chosen ${opts.existingAllocatorAgentId})`,
    detail: { decision_id: opts.decisionId, counterfactual_id: counterfactual.counterfactual_id },
  });
  return counterfactual;
}
