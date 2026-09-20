// Phase 7: read-only dashboard API for the cognitive control plane.
//
// Contract CONTRACT-phase7.md:
//   §4.4  empty with a stated reason, never invented data — every response
//         carries `basis` fields or explicit reasons
//   §4.5  every GET is read-only: no collection is ever written on a GET path
//   §4.6  obeys the gates: respects caller authority (trusted vs client key),
//         the plane flag, the mode ladder and the kill switch — no path the
//         MCP surface refuses
//   §4.7  COGNITIVE_CONTROL_ENABLED=off -> views explicitly say so (no back door)
//   §4.8-10  baton redaction + blindness summary; no journal/reflection/emotional
//         content reachable anywhere (pinned by the privacy fixture test)
//   §4.11 every displayed number traces to a stored record; the UI states the basis
//   §4.14 custodian controls (rebuild) are trusted-only and audited
//   §4.17 no admin key required for reads — any valid key works; visibility is
//         the same as the MCP surface (trusted = all, untrusted = own/shared)
//
// Part of the no-publish branch feat/cognitive-control-local.
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { get_database } from '../database/connection.js';
import { getCaller } from '../utils/caller-identity.js';
import { COLLECTIONS } from '../services/mission-cognition/collections.js';
import { cognitiveControlMode } from '../services/mission-cognition/index.js';
import { killSwitchActive, schedulerMode } from '../services/mission-cognition/scheduler-mode.js';
import {
  computeEvidenceGate,
  EVIDENCE_THRESHOLD,
  activationHardBound,
} from '../services/mission-cognition/activation-service.js';
import { MissionStateService } from '../services/mission-cognition/mission-state-service.js';
import { redactSecretMaterial } from '../services/mission-cognition/baton-service.js';
import type {
  CognitiveBaton,
  CognitiveWorkItem,
  MissionState,
  SchedulerDecision,
} from '../types/cognitive-control.js';

const PLANE_OFF_REASON = 'COGNITIVE_CONTROL_ENABLED=off — cognitive views are disabled by flag (no back door).';

function db(): Db {
  const d = get_database();
  if (!d) throw new Error('MongoDB disconnected');
  return d;
}

async function visibleMissionIds(d: Db, caller: { user_id: string; trusted: boolean }): Promise<Set<string>> {
  if (caller.trusted) {
    const rows = (await d.collection(COLLECTIONS.missionStates).find({}, { projection: { mission_id: 1 } }).toArray()) as any[];
    return new Set(rows.map(r => r.mission_id));
  }
  const rows = (await d
    .collection(COLLECTIONS.missionStates)
    .find({}, { projection: { mission_id: 1, owner_id: 1, shared_id: 1 } })
    .toArray()) as any[];
  return new Set(rows.filter(r => r.owner_id === caller.user_id || Boolean(r.shared_id)).map(r => r.mission_id));
}

function missionJson(m: MissionState): Record<string, unknown> {
  return {
    mission_id: m.mission_id,
    title: m.title,
    intent: m.intent,
    status: m.status,
    phase: m.phase ?? null,
    version: m.version,
    authority_class: m.authority_class,
    owner_id: m.owner_id,
    shared_id: m.shared_id ?? null,
    checkpoint_id: m.checkpoint_id ?? null,
    success_criteria: m.success_criteria ?? [],
    stop_conditions: m.stop_conditions ?? [],
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

export const createCognitionDashboardRoutes = (): Hono => {
  const router = new Hono();

  // ── Status: flags + evidence gate (always reachable — the UI must be able
  //    to say "disabled" explicitly, criterion 7) ──────────────────────────
  router.get('/status', async (c) => {
    const d = db();
    const gate = await computeEvidenceGate(d);
    return c.json({
      plane: cognitiveControlMode(),
      scheduler_mode: schedulerMode(),
      kill_switch: killSwitchActive(),
      hard_bound: activationHardBound(),
      evidence_gate: {
        open: gate.gate_open,
        threshold: gate.threshold,
        qualifying_decisions: gate.qualifying_decisions,
        observed_decisions: gate.observed_decisions,
        agreement_rate: gate.agreement_rate,
        acknowledged: gate.acknowledged,
        reason: gate.reason,
        basis: `scheduler_decisions with an allocator_observation, threshold ${EVIDENCE_THRESHOLD} (contract §4.1)`,
      },
    });
  });

  // ── Missions list ───────────────────────────────────────────────────────
  router.get('/missions', async (c) => {
    const d = db();
    const caller = getCaller();
    const plane = cognitiveControlMode();
    if (plane === 'off') {
      return c.json({ plane: 'off', reason: PLANE_OFF_REASON, missions: [] });
    }
    const visible = await visibleMissionIds(d, caller);
    const rows = (await d.collection(COLLECTIONS.missionStates).find({}, { projection: { _id: 0 } }).toArray()) as unknown as MissionState[];
    const missions = rows.filter(m => visible.has(m.mission_id)).map(missionJson).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return c.json({ plane, missions });
  });

  async function loadVisibleMission(d: Db, missionId: string) {
    const caller = getCaller();
    const visible = await visibleMissionIds(d, caller);
    if (!visible.has(missionId)) return null;
    const state = (await d
      .collection(COLLECTIONS.missionStates)
      .findOne({ mission_id: missionId }, { projection: { _id: 0 } })) as unknown as MissionState | null;
    return state;
  }

  // ── (a) Mission overview + version timeline ────────────────────────────
  router.get('/missions/:id/overview', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') return c.json({ plane: 'off', reason: PLANE_OFF_REASON });
    const state = await loadVisibleMission(d, c.req.param('id'));
    if (!state) return c.json({ error: 'mission not found or not visible' }, 404);
    const missionId = state.mission_id;
    const versions = (await d
      .collection(COLLECTIONS.missionStateVersions)
      .find({ mission_id: missionId }, { projection: { _id: 0, mission_id: 1, version: 1, checkpoint_id: 1, created_at: 1 } })
      .sort({ version: -1 })
      .limit(30)
      .toArray()) as any[];
    const deltas = (await d
      .collection(COLLECTIONS.stateDeltas)
      .find({ mission_id: missionId }, { projection: { _id: 0, delta_id: 1, delta_type: 1, status: 1, base_mission_version: 1, created_at: 1 } })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray()) as any[];
    const events = (await d
      .collection(COLLECTIONS.missionEvents)
      .find({ mission_id: missionId }, { projection: { _id: 0, event_id: 1, event_type: 1, summary: 1, created_at: 1 } })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray()) as any[];
    const deltaCounts: Record<string, number> = {};
    for (const delta of deltas) deltaCounts[delta.status] = (deltaCounts[delta.status] ?? 0) + 1;
    return c.json({
      mission: missionJson(state),
      version_timeline: versions,
      checkpoint_basis: 'mission_state_versions snapshots, last 30 kept (collections.ts retention policy)',
      deltas: { recent: deltas, counts_by_status: deltaCounts, basis: 'state_deltas, newest 50' },
      events: { recent: events, basis: 'mission_events, newest 20' },
      note: versions.length === 0 ? 'No checkpoints recorded yet — the version timeline is empty because no checkpoint has been taken (empty with stated reason, §4.4).' : null,
    });
  });

  // ── (b) Objectives + dependency graph ───────────────────────────────────
  router.get('/missions/:id/objectives', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') return c.json({ plane: 'off', reason: PLANE_OFF_REASON });
    const state = await loadVisibleMission(d, c.req.param('id'));
    if (!state) return c.json({ error: 'mission not found or not visible' }, 404);
    const objectives = state.objectives ?? [];
    const edges: Array<{ from: string; to: string; kind: string }> = [];
    for (const o of objectives) {
      for (const dep of o.dependency_ids ?? []) edges.push({ from: o.id, to: dep, kind: 'objective-depends-on' });
    }
    const entries = (await d
      .collection(COLLECTIONS.epistemicEntries)
      .find({ mission_id: state.mission_id }, { projection: { _id: 0, entry_id: 1, entry_type: 1, statement: 1, depends_on: 1, status: 1 } })
      .limit(200)
      .toArray()) as any[];
    const entryIds = new Set(entries.map(e => e.entry_id));
    for (const e of entries) {
      for (const dep of e.depends_on ?? []) {
        if (entryIds.has(dep)) edges.push({ from: e.entry_id, to: dep, kind: 'entry-depends-on' });
      }
    }
    return c.json({
      mission_id: state.mission_id,
      objectives,
      entries: entries.map(e => ({ entry_id: e.entry_id, entry_type: e.entry_type, status: e.status, statement: String(e.statement).slice(0, 200) })),
      edges,
      basis: `mission state objectives + epistemic_entries depends_on, both read from stored records (${entries.length} entries loaded)`,
      note: objectives.length === 0 ? 'No objectives declared for this mission — empty with stated reason (§4.4).' : null,
    });
  });

  // ── (c) Claims / evidence / assumptions / decisions / contradictions ────
  router.get('/missions/:id/epistemics', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') return c.json({ plane: 'off', reason: PLANE_OFF_REASON });
    const state = await loadVisibleMission(d, c.req.param('id'));
    if (!state) return c.json({ error: 'mission not found or not visible' }, 404);
    const entries = (await d
      .collection(COLLECTIONS.epistemicEntries)
      .find({ mission_id: state.mission_id }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(300)
      .toArray()) as any[];
    const byType: Record<string, any[]> = {};
    for (const e of entries) {
      (byType[e.entry_type] ??= []).push({
        entry_id: e.entry_id,
        statement: String(e.statement).slice(0, 300),
        status: e.status,
        confidence: e.confidence,
        author_id: e.author_id,
        depends_on: e.depends_on ?? [],
        supersedes: e.supersedes ?? null,
        created_at: e.created_at,
        updated_at: e.updated_at,
      });
    }
    return c.json({
      mission_id: state.mission_id,
      entries: byType,
      basis: 'epistemic_entries read from stored records, newest 300 per mission',
      note: entries.length === 0 ? 'The epistemic ledger is empty for this mission — empty with stated reason (§4.4).' : null,
    });
  });

  // ── (d) Uncertainty register + trigger history ──────────────────────────
  router.get('/missions/:id/uncertainties', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') return c.json({ plane: 'off', reason: PLANE_OFF_REASON });
    const state = await loadVisibleMission(d, c.req.param('id'));
    if (!state) return c.json({ error: 'mission not found or not visible' }, 404);
    const uncertainties = (await d
      .collection(COLLECTIONS.epistemicEntries)
      .find({ mission_id: state.mission_id, entry_type: 'uncertainty' }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray()) as any[];
    const triggers = (await d
      .collection(COLLECTIONS.triggerEvaluations)
      .find({ mission_id: state.mission_id }, { projection: { _id: 0 } })
      .sort({ fired_at: -1 })
      .limit(100)
      .toArray()) as any[];
    return c.json({
      mission_id: state.mission_id,
      uncertainties,
      trigger_history: triggers.map(t => ({
        evaluation_id: t.evaluation_id,
        trigger: t.trigger,
        entry_id: t.entry_id ?? null,
        fired_at: t.fired_at,
        outcome: t.outcome,
        token_cost: t.token_cost,
        cost_basis: 'measured from the usage ledger (trigger-telemetry)',
      })),
      basis: 'epistemic_entries (type uncertainty) + trigger_evaluations, both read from stored records',
      note: uncertainties.length === 0 && triggers.length === 0 ? 'No uncertainties and no trigger history for this mission — empty with stated reason (§4.4).' : null,
    });
  });

  // ── (e) Work queue, ownership, leases, blockers ─────────────────────────
  router.get('/missions/:id/work', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') return c.json({ plane: 'off', reason: PLANE_OFF_REASON });
    const state = await loadVisibleMission(d, c.req.param('id'));
    if (!state) return c.json({ error: 'mission not found or not visible' }, 404);
    const items = (await d
      .collection(COLLECTIONS.cognitiveWorkItems)
      .find({ mission_id: state.mission_id }, { projection: { _id: 0 } })
      .sort({ updated_at: -1 })
      .limit(100)
      .toArray()) as unknown as CognitiveWorkItem[];
    const batons = (await d
      .collection(COLLECTIONS.cognitiveBatons)
      .find({ mission_id: state.mission_id }, { projection: { _id: 0, baton_id: 1, mode: 1, recipient_id: 1, ownership: 1, expires_at: 1, revoked: 1 } })
      .sort({ issued_at: -1 })
      .limit(50)
      .toArray()) as any[];
    const blockers = items.filter(i => i.status === 'blocked');
    return c.json({
      mission_id: state.mission_id,
      queue: items.map(i => ({
        work_item_id: i.work_item_id,
        description: i.description,
        mode: i.mode,
        status: i.status,
        trigger: i.trigger,
        authority_class: i.authority_class,
        cost: i.features.cognitive_cost,
        cost_basis: i.features.cost_basis,
        features: i.features,
        created_at: i.created_at,
        updated_at: i.updated_at,
      })),
      leases: batons,
      blockers: blockers.map(b => b.work_item_id),
      basis: 'cognitive_work_items (queue) + cognitive_batons (leases), read from stored records',
      note: items.length === 0 ? 'Work queue empty for this mission — empty with stated reason (§4.4).' : null,
    });
  });

  // ── (f) Scheduler explanation + shadow comparison ───────────────────────
  router.get('/missions/:id/scheduler', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') return c.json({ plane: 'off', reason: PLANE_OFF_REASON });
    const state = await loadVisibleMission(d, c.req.param('id'));
    if (!state) return c.json({ error: 'mission not found or not visible' }, 404);
    const decisions = (await d
      .collection(COLLECTIONS.schedulerDecisions)
      .find({ mission_id: state.mission_id }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray()) as unknown as SchedulerDecision[];
    const decisionIds = decisions.map(x => x.decision_id);
    const counterfactuals = (await d
      .collection(COLLECTIONS.allocationCounterfactuals)
      .find({ decision_id: { $in: decisionIds } }, { projection: { _id: 0 } })
      .toArray()) as any[];
    const byDecision: Record<string, any> = {};
    for (const cf of counterfactuals) byDecision[cf.decision_id] = cf;
    return c.json({
      mission_id: state.mission_id,
      mode: schedulerMode(),
      decisions: decisions.map(x => ({
        decision_id: x.decision_id,
        scheduler_mode: x.scheduler_mode,
        created_at: x.created_at,
        cost_basis: x.cost_basis,
        rationale: x.rationale,
        recommended: x.recommended,
        recommended_was_acted_on: x.recommended_was_acted_on,
        allocator_observation: x.allocator_observation ?? null,
        existing_allocator_note: x.existing_allocator_note,
        counterfactual: byDecision[x.decision_id] ?? null,
        shadow_comparison: x.allocator_observation
          ? x.recommended
            ? x.allocator_observation.agent_id === x.recommended.agent_id
              ? 'agreed'
              : 'diverged'
            : 'no recommendation made'
          : 'allocator outcome not observed for this decision',
        ranked_candidates: x.candidates.map(cand => ({
          work_item_id: cand.work_item_id,
          agent_id: cand.agent_id,
          priority: cand.priority,
          suitability: cand.suitability,
          combined: cand.combined,
          feature_contributions: cand.feature_contributions,
          basis: 'priority score + suitability score, stored per candidate (Phase 4 scorer)',
        })),
        exclusions: x.exclusions,
      })),
      basis: 'scheduler_decisions read from stored records, newest 20 — ranked candidates, exclusions with reasons, and the shadow comparison (recommendation vs the existing allocator\'s observed choice)',
      note: decisions.length === 0 ? 'No scheduler decisions recorded for this mission — empty with stated reason (§4.4).' : null,
    });
  });

  // ── (g) Baton inspector — redaction + blindness-policy summary ──────────
  router.get('/missions/:id/batons', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') return c.json({ plane: 'off', reason: PLANE_OFF_REASON });
    const state = await loadVisibleMission(d, c.req.param('id'));
    if (!state) return c.json({ error: 'mission not found or not visible' }, 404);
    const batons = (await d
      .collection(COLLECTIONS.cognitiveBatons)
      .find({ mission_id: state.mission_id }, { projection: { _id: 0 } })
      .sort({ issued_at: -1 })
      .limit(20)
      .toArray()) as unknown as CognitiveBaton[];
    const redacted = batons.map(b => {
      const r = redactSecretMaterial(b);
      return {
        baton: r.value,
        redactions: r.redacted,
        blindness_summary: {
          enabled: Boolean(b.blindness?.enabled),
          withheld_classes: b.blindness?.withheld_classes ?? [],
          policy_basis: 'baton.blindness policy, stored on the baton record',
        },
      };
    });
    return c.json({
      mission_id: state.mission_id,
      batons: redacted,
      basis: 'cognitive_batons read from stored records, secret-shaped material redacted before display (same patterns the baton write path rejects)',
      note: batons.length === 0 ? 'No batons issued for this mission — empty with stated reason (§4.4).' : null,
    });
  });

  // ── (h) Skill versions, outcomes, challenge state, canary status ────────
  router.get('/missions/:id/skills', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') return c.json({ plane: 'off', reason: PLANE_OFF_REASON });
    const state = await loadVisibleMission(d, c.req.param('id'));
    if (!state) return c.json({ error: 'mission not found or not visible' }, 404);
    const batons = (await d
      .collection(COLLECTIONS.cognitiveBatons)
      .find({ mission_id: state.mission_id }, { projection: { _id: 0, skill_versions: 1, mode: 1, baton_id: 1, recipient_id: 1, issued_at: 1 } })
      .sort({ issued_at: -1 })
      .limit(50)
      .toArray()) as any[];
    const versions: Record<string, { version: string; last_used_on: string; used_by_baton: string }[]> = {};
    const challenges: any[] = [];
    for (const b of batons) {
      for (const [skill, version] of Object.entries(b.skill_versions ?? {})) {
        (versions[skill] ??= []).push({ version: String(version), last_used_on: b.issued_at, used_by_baton: b.baton_id });
      }
      if (b.mode === 'challenge') challenges.push({ baton_id: b.baton_id, recipient_id: b.recipient_id, issued_at: b.issued_at });
    }
    const feedback = (await d
      .collection('skill_feedback')
      .find({}, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(20)
      .toArray()) as any[];
    return c.json({
      mission_id: state.mission_id,
      skill_versions: versions,
      challenge_state: challenges,
      feedback_outcomes: feedback.map(f => ({
        created_at: f.created_at ?? null,
        outcome: f.outcome ?? f.summary ?? f.feedback ?? 'recorded',
      })),
      canary: { configured: false, reason: 'No canary mechanism exists in this deployment — stated honestly rather than invented (§4.4).' },
      basis: 'skill_versions from cognitive_batons + skill_feedback records; both read from stored records',
      note: Object.keys(versions).length === 0 && feedback.length === 0 ? 'No skill versions recorded on any baton and no skill feedback — empty with stated reason (§4.4).' : null,
    });
  });

  // ── (i) Operations: integrity, projection lag, reconstruction ───────────
  router.get('/operations', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') return c.json({ plane: 'off', reason: PLANE_OFF_REASON });
    const visible = await visibleMissionIds(d, getCaller());
    const rows = (await d.collection(COLLECTIONS.missionStates).find({}, { projection: { _id: 0 } }).toArray()) as unknown as MissionState[];
    const missions = rows.filter(m => visible.has(m.mission_id));
    const perMission: any[] = [];
    for (const m of missions) {
      const versions = (await d
        .collection(COLLECTIONS.missionStateVersions)
        .find({ mission_id: m.mission_id }, { projection: { _id: 0, version: 1, checkpoint_id: 1, created_at: 1 } })
        .sort({ version: -1 })
        .toArray()) as any[];
      const deltas = (await d
        .collection(COLLECTIONS.stateDeltas)
        .find({ mission_id: m.mission_id }, { projection: { _id: 0, status: 1, base_mission_version: 1, created_at: 1 } })
        .toArray()) as any[];
      const accepted = deltas.filter(x => x.status === 'accepted');
      const pendingReplay = accepted.filter(x => x.base_mission_version >= m.version).length;
      const proposed = deltas.filter(x => x.status === 'proposed').length;
      const lastTrigger = (await d
        .collection(COLLECTIONS.triggerEvaluations)
        .find({ mission_id: m.mission_id }, { projection: { _id: 0, fired_at: 1 } })
        .sort({ fired_at: -1 })
        .limit(1)
        .toArray()) as any[];
      perMission.push({
        mission_id: m.mission_id,
        title: m.title,
        current_version: m.version,
        latest_checkpoint_version: versions[0]?.version ?? null,
        checkpoint_count: versions.length,
        last_checkpoint_at: versions[0]?.created_at ?? null,
        accepted_deltas: accepted.length,
        proposed_deltas: proposed,
        replay_pending: pendingReplay,
        integrity: pendingReplay > 0 ? 'lagging' : versions.length === 0 ? 'no checkpoints (versioned audit absent)' : 'consistent',
        last_trigger_evaluation_at: lastTrigger[0]?.fired_at ?? null,
        basis: 'mission_state_versions + state_deltas + trigger_evaluations, read from stored records',
      });
    }
    return c.json({
      plane: cognitiveControlMode(),
      missions: perMission,
      reconstruction: {
        mechanism: 'versioned-state reconstruction',
        basis: 'mission_state_versions snapshots (checkpoints, last 30 kept) + accepted state_deltas replay — these retained records ARE the cognitive plane\'s reconstruction source (collections.ts retention policy). External database snapshots are outside the application and not configured here.',
        rebuild_control: 'POST /api/v1/cognition/operations/rebuild (trusted callers only, audited in custodian_audit)',
      },
      note: missions.length === 0 ? 'No missions visible to this caller — empty with stated reason (§4.4).' : null,
    });
  });

  // ── Activation view: mode, gate, opt-ins, ledger, counterfactuals ───────
  router.get('/activation', async (c) => {
    const d = db();
    const caller = getCaller();
    const plane = cognitiveControlMode();
    const gate = await computeEvidenceGate(d);
    const visible = await visibleMissionIds(d, caller);
    const optIns = (await d
      .collection(COLLECTIONS.missionOptIns)
      .find({}, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray()) as any[];
    const ledger = (await d
      .collection(COLLECTIONS.activationLedger)
      .find({}, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray()) as any[];
    const counterfactuals = (await d
      .collection(COLLECTIONS.allocationCounterfactuals)
      .find({}, { projection: { _id: 0 } })
      .sort({ recorded_at: -1 })
      .limit(50)
      .toArray()) as any[];
    const filterByVisibility = (row: any) => {
      if (caller.trusted) return true;
      if (row.mission_id && visible.has(row.mission_id)) return true;
      return false;
    };
    return c.json({
      plane,
      scheduler_mode: schedulerMode(),
      kill_switch: killSwitchActive(),
      hard_bound: activationHardBound(),
      evidence_gate: {
        open: gate.gate_open,
        threshold: gate.threshold,
        qualifying_decisions: gate.qualifying_decisions,
        agreement_rate: gate.agreement_rate,
        acknowledged: gate.acknowledged,
        reason: gate.reason,
      },
      opt_ins: optIns.filter(filterByVisibility),
      ledger: ledger.filter(row => caller.trusted || row.actor_id === caller.user_id || filterByVisibility(row)),
      counterfactuals: counterfactuals.filter(filterByVisibility).map(cf => ({
        counterfactual_id: cf.counterfactual_id,
        mission_id: cf.mission_id,
        decision_id: cf.decision_id,
        cycle_id: cf.cycle_id,
        work_item_id: cf.work_item_id,
        mode: cf.mode,
        influenced: cf.influenced,
        chosen_agent_id: cf.chosen_agent_id,
        existing_allocator_agent_id: cf.existing_allocator_agent_id,
        recorded_at: cf.recorded_at,
        reason: cf.reason,
        basis: 'allocation_counterfactuals — what the existing allocator would have done, recorded before every influenced allocation (§4.12)',
      })),
      basis: 'activation_ledger + mission_opt_ins + allocation_counterfactuals + evidence gate, all read from stored records',
    });
  });

  // ── Executive view: why the system is doing its current work ────────────
  // Reads ONLY the system's own executive_action log (its factual self-report
  // of goals, allocations and results). No journal/reflection/emotional
  // content is ever touched — pinned by the privacy fixture test.
  router.get('/executive', async (c) => {
    const d = db();
    const rows = (await d
      .collection('episodic_events')
      .find({ event_type: 'executive_action' }, { projection: { _id: 0, id: 1, timestamp: 1, content: 1 } })
      .sort({ timestamp: -1 })
      .limit(25)
      .toArray()) as any[];
    const parsed = rows.map((r: any) => {
      const message = String(r.content?.message ?? '');
      const goal = message.match(/Goal: (.+)/)?.[1] ?? null;
      const action = message.match(/Action: (.+)/)?.[1] ?? null;
      const allocated = message.match(/Allocated to: (\S+)/)?.[1] ?? null;
      const why = message.match(/Why: (.+)/)?.[1] ?? null;
      const result = message.match(/Result: (success|failed) — (.+)/)?.slice(1) ?? null;
      return {
        event_id: r.id,
        timestamp: r.timestamp,
        goal,
        action,
        allocated_to: allocated,
        allocation_rationale: why,
        result: result ? { success: result[0] === 'success', summary: result[1] } : null,
        basis: 'episodic_events executive_action records — the executive\'s own factual action log (emotional_tags excluded by design)',
      };
    });
    return c.json({
      actions: parsed,
      basis: 'episodic_events, event_type executive_action, newest 25 — the system\'s own goal/allocation/result log',
      note: parsed.length === 0 ? 'No executive actions recorded yet — the executive has not acted since records began (empty with stated reason, §4.4).' : null,
    });
  });

  // ── Custodian control: rebuild from checkpoint (trusted only, audited) ──
  router.post('/operations/rebuild', async (c) => {
    const d = db();
    if (cognitiveControlMode() === 'off') {
      return c.json({ error: 'custodian controls disabled: COGNITIVE_CONTROL_ENABLED=off (no back door)' }, 403);
    }
    const caller = getCaller();
    if (!caller.trusted) {
      return c.json({ error: 'custodian controls require a trusted caller (operator)' }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { mission_id?: string };
    if (!body.mission_id) return c.json({ error: 'mission_id required' }, 400);
    const svc = new MissionStateService(d);
    const before = (await d
      .collection(COLLECTIONS.missionStates)
      .findOne({ mission_id: body.mission_id }, { projection: { _id: 0 } })) as any;
    if (!before) return c.json({ error: 'mission not found' }, 404);
    const rebuiltRaw = await svc.rebuildFromCheckpoint(body.mission_id);
    if (!rebuiltRaw) {
      await recordAudit(d, caller.user_id, 'rebuild', body.mission_id, { outcome: 'no checkpoint basis — rebuild refused' });
      return c.json({ rebuilt: false, reason: 'no checkpoint or delta basis exists for this mission — nothing to rebuild (honest refusal, §4.14)' });
    }
    // checkpoint_id is bookkeeping of the MATERIALIZED doc, not mission
    // content: the rebuild reconstructs content, and the stored checkpoint
    // marker is preserved. (The v3 snapshots predate the stamping, and $set
    // drops undefined keys — without this, the marker can never converge.)
    const rebuilt: MissionState = { ...rebuiltRaw, checkpoint_id: before.checkpoint_id ?? rebuiltRaw.checkpoint_id ?? null };
    // §4.14: stable comparison over the UNION key set (never each object
    // against its own keys); _id and updated_at excluded — a rebuild that
    // bumps a timestamp can never be idempotent. `changed` is DERIVED, never
    // hardcoded, and the mutating write happens only when something changed.
    const changedFields = changedFieldNames(before, rebuilt as unknown as Record<string, unknown>);
    if (changedFields.length === 0) {
      await recordAudit(d, caller.user_id, 'rebuild', body.mission_id, { outcome: 'already consistent — nothing changed, nothing written' });
      return c.json({
        rebuilt: true,
        changed: false,
        changed_fields: [],
        version: rebuilt.version,
        reason: 'materialized state already consistent with checkpoint + accepted deltas — idempotent, nothing written',
      });
    }
    await svc.advanceState(body.mission_id, rebuilt);
    await recordAudit(d, caller.user_id, 'rebuild', body.mission_id, { outcome: 'rebuilt', changed_fields: changedFields, version: rebuilt.version });
    return c.json({ rebuilt: true, changed: true, changed_fields: changedFields, version: rebuilt.version, basis: 'mission_state_versions checkpoint + accepted state_deltas replay (MissionStateService.rebuildFromCheckpoint)' });
  });

  return router;
};

/**
 * §4.14 idempotency comparison: same key set, same order, for BOTH objects.
 * `_id` and `updated_at` are excluded from the comparison entirely.
 */
function changedFieldNames(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('_id');
  keys.delete('updated_at');
  const changed: string[] = [];
  for (const k of [...keys].sort()) {
    const av = JSON.stringify((a as any)[k] ?? null);
    const bv = JSON.stringify((b as any)[k] ?? null);
    if (av !== bv) changed.push(k);
  }
  return changed;
}

async function recordAudit(d: Db, actorId: string, action: string, missionId: string, detail: Record<string, unknown>): Promise<void> {
  await d.collection(COLLECTIONS.custodianAudit).insertOne({
    audit_id: randomUUID(),
    actor_id: actorId,
    action,
    mission_id: missionId,
    created_at: new Date().toISOString(),
    detail,
  });
}
