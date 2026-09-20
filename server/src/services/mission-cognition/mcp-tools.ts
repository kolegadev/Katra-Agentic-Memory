// MCP tool surface for the cognitive control plane (Phase 1-2 subset).
// Caller-authority rules (review gap §4.1, immediate action #5):
//   - actor binding: every write is attributed to caller.user_id; payload author_id ignored
//   - untrusted callers (client keys): owner forced to themselves, authority_class capped at 'B'
//   - trusted callers (loopback/admin): may declare owner + A/B/C explicitly
//   - visibility: trusted → full; untrusted → own missions or shared-scope missions
// Registered only when COGNITIVE_CONTROL_ENABLED != off.
// Part of the no-publish branch feat/cognitive-control-local.
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { randomUUID } from 'node:crypto';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import {
  cognitiveControlMode,
  schedulerMode,
  getMissionCognitionServices,
} from './index.js';
import { SchedulerService } from './scheduler-service.js';
import { runWithUsageOrigin } from '../infrastructure/llm-usage-ledger.js';
import type { AuthorityClass, CognitiveBatonDraft, StateDeltaDraft } from '../../types/cognitive-control.js';

const AuthorityClassSchema = z.enum(['A', 'B', 'C']);
const objectiveSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'ready', 'in_progress', 'blocked', 'completed', 'cancelled']).default('pending'),
  owner_id: z.string().optional(),
  dependency_ids: z.array(z.string()).optional(),
  evidence_refs: z.array(z.string()).optional(),
});
const criterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(['unmet', 'partial', 'met', 'waived']).default('unmet'),
  evidence_refs: z.array(z.string()).optional(),
});

const createMissionV2Input = z.object({
  title: z.string().min(1),
  intent: z.string().optional(),
  owner_id: z.string().optional(),
  success_criteria: z.array(z.union([z.string(), criterionSchema])).default([]),
  stop_conditions: z.array(z.string()).optional(),
  constraints: z.record(z.string(), z.array(z.string())).optional(),
  authority_class: AuthorityClassSchema.optional(),
  objectives: z.array(objectiveSchema).optional(),
  shared_id: z.string().optional(),
});

const getMissionStateInput = z.object({ mission_id: z.string(), version: z.number().int().positive().optional() });

const ledgerEntrySchema = z.object({
  entry_type: z.enum(['claim', 'evidence', 'assumption', 'hypothesis', 'uncertainty', 'contradiction', 'decision', 'experiment', 'result', 'unknown']),
  statement: z.string().min(1),
  status: z.enum(['proposed', 'active', 'accepted', 'challenged', 'rejected', 'superseded', 'invalidated', 'resolved', 'deferred', 'accepted_risk']).default('accepted'),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  depends_on: z.array(z.string()).optional(),
  supersedes: z.string().optional(),
  evidence_for: z.array(z.string()).optional(),
  evidence_against: z.array(z.string()).optional(),
  consequence_if_false: z.string().optional(),
  independence_requirement: z.boolean().optional(),
});

const submitStateDeltaInput = z.object({
  mission_id: z.string(),
  base_mission_version: z.number().int().positive(),
  delta_type: z.string().min(1),
  operations: z.array(z.record(z.string(), z.unknown())).default([]),
  ledger_entries: z.array(ledgerEntrySchema).optional(),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  idempotency_key: z.string().optional(),
  evidence_refs: z.array(z.string()).optional(),
  expected_effects: z.array(z.string()).optional(),
  human_gate: z.enum(['none', 'approval', 'review']).optional(),
  skills_used: z.record(z.string(), z.string()).optional(),
  baton_id: z.string().optional(),
  work_item_id: z.string().optional(),
});

const queryLedgerInput = z.object({
  mission_id: z.string(),
  entry_id: z.string().optional(),
  entry_type: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const compileBatonInput = z.object({
  mission_id: z.string(),
  mission_version: z.number().int().positive().optional(),
  recipient_id: z.string(),
  mode: z.enum(['execute', 'explore', 'challenge', 'synthesize', 'verify', 'monitor']),
  objective: z.string().min(1),
  non_objectives: z.array(z.string()).optional(),
  deliverable: z.string().min(1),
  required_delta_types: z.array(z.string()).optional(),
  stop_conditions: z.array(z.string()).optional(),
  budget: z.object({ max_cost: z.number().optional(), max_hours: z.number().optional() }).optional(),
  blindness: z.object({ enabled: z.boolean(), withheld_classes: z.array(z.string()).default([]) }).optional(),
  skill_versions: z.record(z.string(), z.string()).optional(),
  expires_at: z.string().optional(),
  ttl_seconds: z.number().int().positive().max(7 * 24 * 3600).default(24 * 3600),
});

const getBatonInput = z.object({ baton_id: z.string() });
const checkpointInput = z.object({ mission_id: z.string() });
const resumeInput = z.object({ mission_id: z.string() });
const listDeltasInput = z.object({ mission_id: z.string(), limit: z.number().int().min(1).max(200).default(50) });

// Phase 4 (shadow scheduler) tool inputs — registered only when
// COGNITIVE_SCHEDULER_MODE != off AND COGNITIVE_CONTROL_ENABLED != off.
const createWorkItemInput = z.object({
  mission_id: z.string(),
  description: z.string().min(1),
  mode: z.enum(['execute', 'explore', 'challenge', 'synthesize', 'verify', 'monitor']).default('execute'),
  authority_class: AuthorityClassSchema.default('B'),
});
const queueInput = z.object({ mission_id: z.string().optional() });
const explainInput = z.object({ mission_id: z.string() });

// Phase 5 (uncertainty engine) tool inputs — same gating as Phase 4.
const missionOnlyInput = z.object({ mission_id: z.string() });
const traceInput = z.object({ mission_id: z.string(), entry_id: z.string(), depth_bound: z.number().int().min(1).max(32).optional() });
const invalidateInput = z.object({ mission_id: z.string(), decision_entry_id: z.string(), reason: z.string().min(1) });
const proposeExperimentInput = z.object({
  mission_id: z.string(),
  statement: z.string().min(1),
  separates_hypotheses: z.array(z.string()).min(1),
});
const recordResultInput = z.object({
  mission_id: z.string(),
  experiment_entry_id: z.string(),
  summary: z.string().min(1),
  supports_entry_id: z.string().optional(),
  contradicts_entry_id: z.string().optional(),
});
const triggerOutcomeInput = z.object({
  mission_id: z.string(),
  trigger: z.string().min(1),
  entry_id: z.string().optional(),
  outcome: z.enum(['useful_information', 'mere_variance', 'unnecessary_cost']),
  note: z.string().optional(),
});
const blindWorkInput = z.object({ mission_id: z.string(), uncertainty_entry_id: z.string() });

// Phase 6 (controlled activation) tool inputs.
const setSchedulerModeInput = z.object({
  mode: z.enum(['off', 'shadow', 'recommend', 'allocate_internal', 'allocate_gated']),
  reason: z.string().min(1),
});
const optInMissionInput = z.object({ mission_id: z.string(), reason: z.string().min(1) });
const acknowledgeEvidenceInput = z.object({ note: z.string().optional() });
const ledgerInput = z.object({ limit: z.number().int().min(1).max(200).optional() });
const counterfactualInput = z.object({
  counterfactual_id: z.string().optional(),
  mission_id: z.string().optional(),
});
const recordObservationInput = z.object({
  decision_id: z.string(),
  agent_id: z.string().optional(), // omitted/null = the allocator made no allocation
  note: z.string().optional(),
});

// Phase 8 (skill evolution gates) tool inputs.
const skillCandidateInput = z.object({ skill: z.string().min(1), version: z.string().min(1), note: z.string().min(1) });
const skillCandidateIdInput = z.object({ candidate_id: z.string().min(1) });
const skillCanaryInput = z.object({ candidate_id: z.string().min(1), mission_id: z.string().min(1) });
const skillCanaryOutcomeInput = z.object({ candidate_id: z.string().min(1), outcome: z.enum(['ok', 'regressed']) });
const skillPinInput = z.object({ mission_id: z.string().min(1), skill: z.string().min(1), version: z.string().min(1) });

export const COGNITIVE_TOOL_DEFS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'create_mission_v2',
    description: 'Create a rich long-horizon mission with explicit success criteria, stop conditions, authority class (A/B/C), and constraints. Returns the mission id and initial version. Part of the cognitive control plane (local testing).',
    inputSchema: zodToSchema(createMissionV2Input),
  },
  {
    name: 'get_mission_state',
    description: 'Read the authoritative mission state (current or a specified version). Mission State outranks chat history for operational truth.',
    inputSchema: zodToSchema(getMissionStateInput),
  },
  {
    name: 'submit_state_delta',
    description: 'Submit a typed state delta against base_mission_version. Validated, deduplicated by idempotency key, version-checked, merged or routed to conflict. Returns delta id and status.',
    inputSchema: zodToSchema(submitStateDeltaInput),
  },
  {
    name: 'list_state_deltas',
    description: 'Audit a mission change history: proposed/accepted/rejected/conflict deltas.',
    inputSchema: zodToSchema(listDeltasInput),
  },
  {
    name: 'query_epistemic_ledger',
    description: 'Retrieve typed, dependency-linked epistemic entries (claims, evidence, assumptions, uncertainties, decisions, experiments) for a mission.',
    inputSchema: zodToSchema(queryLedgerInput),
  },
  {
    name: 'compile_cognitive_baton',
    description: 'Compile and issue an immutable cognitive baton: minimum sufficient context for one reasoning episode, bound to a mission version, with blindness policy and capability references.',
    inputSchema: zodToSchema(compileBatonInput),
  },
  {
    name: 'get_cognitive_baton',
    description: 'Retrieve an issued baton if authorized and unexpired. Stale (pre-version-advance) batons are revoked automatically.',
    inputSchema: zodToSchema(getBatonInput),
  },
  {
    name: 'checkpoint_mission',
    description: 'Create a durable version checkpoint of the current mission state (with version-history compaction).',
    inputSchema: zodToSchema(checkpointInput),
  },
  {
    name: 'resume_mission',
    description: 'Resume a mission after context loss: current state, version, deltas since checkpoint, and next recommended cognition — no chat replay needed.',
    inputSchema: zodToSchema(resumeInput),
  },
  {
    name: 'create_cognitive_work_item',
    description: 'Add bounded cognition to the shadow scheduler queue for a mission (Phase 4). Requires COGNITIVE_SCHEDULER_MODE != off. Changes no real allocation.',
    inputSchema: zodToSchema(createWorkItemInput),
  },
  {
    name: 'get_cognitive_queue',
    description: 'Inspect the shadow work queue: prioritised cognitive work items and their feature vectors, for a mission or globally. Changes no real allocation.',
    inputSchema: zodToSchema(queueInput),
  },
  {
    name: 'explain_scheduler_decision',
    description: 'Return the latest shadow scheduler decision: ranked candidates with per-feature score contributions, exclusions with reasons, and the rationale — why THIS next, and what would change its mind.',
    inputSchema: zodToSchema(explainInput),
  },
  {
    name: 'list_uncertainties',
    description: 'List open/active uncertainty entries for a mission (Phase 5).',
    inputSchema: zodToSchema(missionOnlyInput),
  },
  {
    name: 'evaluate_triggers',
    description: 'Run the eight deterministic uncertainty trigger detectors over current state; return fired triggers with reasons. No model calls. (Phase 5)',
    inputSchema: zodToSchema(missionOnlyInput),
  },
  {
    name: 'trace_assumption_dependencies',
    description: 'Transitive dependents of an epistemic entry through depends_on, with the depth bound applied. Cycle-safe. (Phase 5)',
    inputSchema: zodToSchema(traceInput),
  },
  {
    name: 'invalidate_decision',
    description: 'Propagate DECISION_INVALIDATED via state deltas, suspend only the affected work items, and preserve the prior plan for audit. (Phase 5)',
    inputSchema: zodToSchema(invalidateInput),
  },
  {
    name: 'propose_experiment',
    description: 'Register a discriminating experiment and the hypotheses it separates. (Phase 5)',
    inputSchema: zodToSchema(proposeExperimentInput),
  },
  {
    name: 'record_experiment_result',
    description: 'Attach a result to an experiment; a result contradicting accepted state opens a contradiction entry. (Phase 5)',
    inputSchema: zodToSchema(recordResultInput),
  },
  {
    name: 'get_trigger_report',
    description: 'Trigger precision + measured cost: fires, useful, performative, cost per useful trigger. (Phase 5)',
    inputSchema: zodToSchema(missionOnlyInput),
  },
  {
    name: 'create_blind_work_item',
    description: 'Create a blind parallel work item for an uncertainty: the payload carries no incumbent conclusion or rationale. (Phase 5)',
    inputSchema: zodToSchema(blindWorkInput),
  },
  {
    name: 'record_trigger_outcome',
    description: 'Classify a fired trigger as useful information / mere variance / unnecessary cost, with token cost measured from the usage ledger. (Phase 5)',
    inputSchema: zodToSchema(triggerOutcomeInput),
  },
  {
    name: 'get_hypothesis_diversity',
    description: 'Hypothesis diversity over submitted hypotheses: distinct forms, falsifiable count, flagged not-falsifiable, authors, recorded alternatives. (Phase 5)',
    inputSchema: zodToSchema(missionOnlyInput),
  },
  // ── Phase 6: controlled activation (contract §5.1) ─────────────────────
  // These tools are registered when COGNITIVE_CONTROL_ENABLED != off and are NOT
  // gated on COGNITIVE_SCHEDULER_MODE (set_scheduler_mode must be reachable from
  // off). Every mode-affecting action is gate-checked and ledger-recorded in the
  // activation service — the tool layer cannot bypass the gate.
  {
    name: 'set_scheduler_mode',
    description: 'Move COGNITIVE_SCHEDULER_MODE one rung at a time (off→shadow→recommend→allocate_internal), or downward freely. recommend and above require the stored-evidence gate (>=50 evidenced decisions + human-read acknowledgement). allocate_gated is not implemented (§4.6) and is refused. Every transition/refusal is recorded in the activation ledger. Trusted callers only.',
    inputSchema: zodToSchema(setSchedulerModeInput),
  },
  {
    name: 'opt_in_mission',
    description: 'Enable scheduler allocation-influence for ONE mission, with a stated reason (Phase 6, per-mission opt-in). Recorded in the opt-in register and activation ledger.',
    inputSchema: zodToSchema(optInMissionInput),
  },
  {
    name: 'revoke_mission_opt_in',
    description: 'Revoke a mission opt-in. Takes effect immediately (runtime read — no rebuild). Recorded in the activation ledger.',
    inputSchema: zodToSchema(optInMissionInput),
  },
  {
    name: 'get_allocation_evidence',
    description: 'The evidence gate state, computed from STORED records: evidenced decisions, agreement rate, human-read acknowledgement, threshold, open/closed.',
    inputSchema: zodToSchema(z.object({})),
  },
  {
    name: 'acknowledge_evidence',
    description: 'Record that a human has read the scheduler evidence figures. The figures are COMPUTED from stored records at acknowledgement time — never taken from the caller. Trusted callers only.',
    inputSchema: zodToSchema(acknowledgeEvidenceInput),
  },
  {
    name: 'get_activation_ledger',
    description: 'Who changed what mode/opt-in, when, on what evidence: the activation ledger (mode changes, refusals, opt-ins, revocations, cycle starts/halts, counterfactuals, acknowledgements).',
    inputSchema: zodToSchema(ledgerInput),
  },
  {
    name: 'get_allocation_counterfactual',
    description: 'For an influenced allocation: what was chosen and what the existing allocator would have done instead, with the recorded reason.',
    inputSchema: zodToSchema(counterfactualInput),
  },
  {
    name: 'record_allocator_observation',
    description: 'Record what the existing allocator actually did for a scheduler decision (manual evidence accumulation for the gate; the shadow pass also auto-observes). Omit agent_id when no allocation happened.',
    inputSchema: zodToSchema(recordObservationInput),
  },
  {
    name: 'get_scheduler_recommendation',
    description: 'ADVISORY ONLY (recommend mode and above): the latest scheduler decision\'s recommended work item and agent, with rationale. No allocation path reads this.',
    inputSchema: zodToSchema(missionOnlyInput),
  },
  // ── Phase 8: skill evolution gates (contract §5.2) ─────────────────────
  {
    name: 'propose_skill_candidate',
    description: 'Register a skill-version candidate against an existing skill (Phase 8 gate chain step 1 of 4: candidate). Trusted callers only; recorded in skill_evolution.',
    inputSchema: zodToSchema(skillCandidateInput),
  },
  {
    name: 'run_skill_replay',
    description: 'Replay a candidate against historical missions read from stored records; report the regression verdict (pass / fail / insufficient). A single good run is insufficient by construction (Phase 8, §4.13/§4.16).',
    inputSchema: zodToSchema(skillCandidateIdInput),
  },
  {
    name: 'start_skill_canary',
    description: 'Start a scoped canary for a candidate on ONE mission. Requires a passing replay; refused (and recorded) otherwise. Reversible via outcome recording (Phase 8, §4.14).',
    inputSchema: zodToSchema(skillCanaryInput),
  },
  {
    name: 'complete_skill_canary',
    description: 'Record the canary outcome (ok / regressed) — the evidence promotion will require (Phase 8, §4.14).',
    inputSchema: zodToSchema(skillCanaryOutcomeInput),
  },
  {
    name: 'promote_skill_version',
    description: 'Promote a candidate to the current skill version. Refused UNLESS both replay evidence (pass) and a completed ok-canary exist; every refusal is recorded (Phase 8, §4.12).',
    inputSchema: zodToSchema(skillCandidateIdInput),
  },
  {
    name: 'pin_skill_version',
    description: 'Pin a skill version to an active mission — the explicit migration approval of §4.15. Trusted callers only; recorded.',
    inputSchema: zodToSchema(skillPinInput),
  },
  {
    name: 'get_skill_candidate_state',
    description: 'The full gate-chain state of a candidate: proposal, replay verdict, canary status, promotion. Read-only.',
    inputSchema: zodToSchema(skillCandidateIdInput),
  },
];

function zodToSchema(s: z.ZodType): Record<string, unknown> {
  return zodToJsonSchema(s) as Record<string, unknown>;
}

function text(message: string): TextContent[] {
  return [{ type: 'text', text: message }];
}

function resolveActor(caller: CallerIdentity, requestedOwner?: string): { actor: string; owner: string; authorityCap: AuthorityClass | null } {
  // Untrusted callers cannot act as or create for another identity, and cannot declare class A.
  const actor = caller.user_id;
  const owner = caller.trusted && requestedOwner ? requestedOwner : actor;
  const authorityCap: AuthorityClass | null = caller.trusted ? null : 'B';
  return { actor, owner, authorityCap };
}

async function canViewMission(missionId: string, caller: CallerIdentity): Promise<boolean> {
  if (caller.trusted) return true;
  const db = get_database();
  const state = await db
    .collection('mission_states')
    .findOne({ mission_id: missionId }, { projection: { owner_id: 1, shared_id: 1 } });
  if (!state) return false;
  const s = state as any;
  if (s.owner_id === caller.user_id) return true;
  return Boolean(s.shared_id); // shared-scope missions are visible to team identities
}

export async function handleCognitiveTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  const mode = cognitiveControlMode();
  if (mode === 'off') return text('❌ Cognitive control plane disabled (COGNITIVE_CONTROL_ENABLED=off).');
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  const services = getMissionCognitionServices(db);

  const guard = async (missionId: string): Promise<TextContent[] | null> => {
    if (!(await canViewMission(missionId, caller))) return text(`❌ Not authorized for mission ${missionId}.`);
    return null;
  };

  switch (name) {
    case 'create_mission_v2': {
      const input = createMissionV2Input.parse(args);
      const { owner, authorityCap } = resolveActor(caller, input.owner_id);
      if (mode !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const requested: AuthorityClass = input.authority_class ?? 'B';
      // Untrusted callers are capped at B; class A requires a trusted caller.
      const authority: AuthorityClass = authorityCap && requested === 'A' ? 'B' : requested;
      const criteria = input.success_criteria.map((c, i) =>
        typeof c === 'string'
          ? { id: `c${i + 1}`, description: c, status: 'unmet' as const }
          : c,
      );
      const objectives = input.objectives?.map(o => ({
        ...o,
        owner_id: o.owner_id ?? owner,
      }));
      const state = await services.missions.createMissionState({
        schema_version: '1.0',
        mission_id: `ms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title: input.title,
        intent: input.intent ?? input.title,
        status: 'active',
        owner_id: owner,
        shared_id: input.shared_id,
        success_criteria: criteria,
        stop_conditions: input.stop_conditions,
        constraints: input.constraints,
        authority_class: authority,
        objectives,
        created_at: '',
        updated_at: '',
      } as never);
      return text(`✅ Mission created (v${state.version}).\n\n**ID:** \`${state.mission_id}\`\n**Title:** ${state.title}\n**Authority:** ${state.authority_class}\n**Success criteria:** ${state.success_criteria.map(c => `${c.id}:${c.status}`).join(', ') || '(none declared)'}`);
    }
    case 'get_mission_state': {
      const input = getMissionStateInput.parse(args);
      const denied = await guard(input.mission_id);
      if (denied) return denied;
      const state = await services.missions.getMissionState(input.mission_id, input.version);
      if (!state) return text(`❌ Mission state not found: ${input.mission_id}`);
      return text(`**Mission state v${state.version}** — ${state.title} [${state.status}]\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``);
    }
    case 'submit_state_delta': {
      const input = submitStateDeltaInput.parse(args);
      const denied = await guard(input.mission_id);
      if (denied) return denied;
      if (mode !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { actor } = resolveActor(caller);
      const draft: StateDeltaDraft = {
        schema_version: '1.0',
        idempotency_key: input.idempotency_key ?? `idem_${input.mission_id}_${input.base_mission_version}_${input.delta_type}_${JSON.stringify(input.operations).slice(0, 80)}`,
        mission_id: input.mission_id,
        base_mission_version: input.base_mission_version,
        author_id: actor,
        delta_type: input.delta_type as never,
        operations: input.operations,
        ledger_entries: input.ledger_entries?.map(e => ({ schema_version: '1.0', mission_id: input.mission_id, author_id: actor, ...e } as never)),
        rationale: input.rationale,
        confidence: input.confidence,
        evidence_refs: input.evidence_refs,
        expected_effects: input.expected_effects,
        human_gate: input.human_gate,
        skills_used: input.skills_used,
        baton_id: input.baton_id,
        work_item_id: input.work_item_id,
      };
      const delta = await services.deltas.submitDelta(draft, { actorId: actor });
      return text(`Delta \`${delta.delta_id}\` — status **${delta.status}** (${delta.delta_type} against base v${delta.base_mission_version})`);
    }
    case 'list_state_deltas': {
      const input = listDeltasInput.parse(args);
      const denied = await guard(input.mission_id);
      if (denied) return denied;
      const deltas = await services.deltas.listDeltas(input.mission_id, input.limit);
      return text(deltas.length === 0 ? 'No deltas recorded.' : deltas.map(d => `- ${d.created_at} ${d.delta_type} [${d.status}] base v${d.base_mission_version} by ${d.author_id} (${d.delta_id})`).join('\n'));
    }
    case 'query_epistemic_ledger': {
      const input = queryLedgerInput.parse(args);
      const denied = await guard(input.mission_id);
      if (denied) return denied;
      if (input.entry_id) {
        const entry = await services.ledger.getEntry(input.entry_id);
        if (!entry) return text(`❌ Ledger entry not found: ${input.entry_id}`);
        return text(`\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\``);
      }
      const entries = await services.ledger.listEntries(input.mission_id, {
        entry_type: input.entry_type as never,
        status: input.status as never,
      }, input.limit);
      if (entries.length === 0) return text('No ledger entries match.');
      return text(entries.map(e => `- [${e.entry_type}/${e.status}] ${e.confidence.toFixed(2)} ${e.entry_id}: ${e.statement.slice(0, 140)}`).join('\n'));
    }
    case 'compile_cognitive_baton': {
      const input = compileBatonInput.parse(args);
      const denied = await guard(input.mission_id);
      if (denied) return denied;
      if (mode !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { actor } = resolveActor(caller);
      const state = await services.missions.getMissionState(input.mission_id);
      if (!state) return text(`❌ Mission state not found: ${input.mission_id}`);
      const expiresAt = input.expires_at ?? new Date(Date.now() + input.ttl_seconds * 1000).toISOString();
      const draft: CognitiveBatonDraft = {
        schema_version: '1.0',
        mission_id: input.mission_id,
        mission_version: input.mission_version ?? state.version,
        recipient_id: input.recipient_id,
        mode: input.mode,
        objective: input.objective,
        non_objectives: input.non_objectives,
        deliverable: input.deliverable,
        required_delta_types: input.required_delta_types as never,
        stop_conditions: input.stop_conditions,
        budget: input.budget,
        blindness: input.blindness,
        skill_versions: input.skill_versions,
        expires_at: expiresAt,
      };
      const baton = await services.batons.issueBaton(draft);
      return text(`✅ Baton issued \`${baton.baton_id}\` for ${baton.recipient_id} (${baton.mode}, mission v${baton.mission_version}, expires ${baton.expires_at}).\nBlindness: ${baton.blindness?.enabled ? `enabled, withholding [${baton.blindness.withheld_classes.join(', ')}]` : 'off'}.`);
    }
    case 'get_cognitive_baton': {
      const input = getBatonInput.parse(args);
      const baton = await services.batons.getBaton(input.baton_id, caller.trusted ? undefined : caller.user_id);
      if (!baton) return text('❌ Baton not found, expired, revoked, or not authorized for this caller.');
      return text(`\`\`\`json\n${JSON.stringify(baton, null, 2)}\n\`\`\``);
    }
    case 'checkpoint_mission': {
      const input = checkpointInput.parse(args);
      const denied = await guard(input.mission_id);
      if (denied) return denied;
      if (mode !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { actor } = resolveActor(caller);
      const state = await services.missions.checkpointMission(input.mission_id, actor);
      if (!state) return text(`❌ Mission not found: ${input.mission_id}`);
      return text(`✅ Checkpoint created for ${input.mission_id} at v${state.version} (\`${state.checkpoint_id}\`).`);
    }
    case 'resume_mission': {
      const input = resumeInput.parse(args);
      const denied = await guard(input.mission_id);
      if (denied) return denied;
      const { buildResumeReport } = await import('./resume.js');
      const report = await buildResumeReport(db, input.mission_id);
      const lines = [
        `**Mission:** ${report.mission.title} [${report.mission.status}] — v${report.mission.version}`,
        `**Owner:** ${report.mission.owner_id} | **Authority:** ${report.mission.authority_class}`,
        `**Checkpoint:** ${report.checkpoint.checkpoint_id ?? '(none)'} at v${report.checkpoint.version ?? '?'} ${report.checkpoint.created_at ?? ''}`,
        `**Changed since checkpoint:** ${report.changed_since_checkpoint.length} accepted delta(s) — ${report.changed_since_checkpoint.map(d => `${d.delta_type} by ${d.author_id}`).join(', ') || 'none'}`,
        `**Active uncertainties:** ${report.active_uncertainties.map(u => `${u.entry_id}: ${u.statement.slice(0, 120)}`).join(' | ') || 'none'}`,
        `**Next action:** [${report.next_action.kind}] ${report.next_action.objective_id ?? ''} ${report.next_action.description ?? ''} — ${report.next_action.rationale}`,
        `**Reconstruction source:** ${report.reconstruction_source.join('; ')}`,
      ];
      return text(lines.join('\n'));
    }
    default:
      return text(`❌ Unknown cognitive tool: ${name}`);
  }
}

// ── Phase 4: shadow scheduler tool handlers ──────────────────────────────

async function handleSchedulerTool(name: string, args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  if (cognitiveControlMode() === 'off') return text('❌ Cognitive control plane disabled (COGNITIVE_CONTROL_ENABLED=off).');
  if (schedulerMode() === 'off') return text('❌ Cognitive scheduler disabled (COGNITIVE_SCHEDULER_MODE=off).');
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  const scheduler = new SchedulerService(db);

  const canView = async (missionId: string) => {
    if (caller.trusted) return true;
    const state = await db.collection('mission_states').findOne({ mission_id: missionId }, { projection: { owner_id: 1, shared_id: 1 } });
    if (!state) return false;
    const s = state as any;
    return s.owner_id === caller.user_id || Boolean(s.shared_id);
  };

  switch (name) {
    case 'create_cognitive_work_item': {
      const input = createWorkItemInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      const { measureCognitiveCost } = await import('./cost-model.js');
      const measured = await measureCognitiveCost(db, input.mission_id);
      const now = new Date().toISOString();
      const item = {
        schema_version: '1.0',
        work_item_id: randomUUID(),
        mission_id: input.mission_id,
        description: input.description,
        mode: input.mode,
        status: 'queued' as const,
        authority_class: input.authority_class,
        trigger: 'manual' as const,
        features: {
          mission_impact: 1,
          uncertainty: 0,
          information_value: 1,
          dependency_centrality: 0,
          urgency: 1,
          cognitive_cost: measured.cost,
          cost_basis: measured.basis,
        },
        created_at: now,
        updated_at: now,
      };
      await db.collection('cognitive_work_items').insertOne(item);
      return text(`✅ Work item queued \`${item.work_item_id}\` for ${input.mission_id} (${input.mode}, manual trigger). Shadow only — no real allocation changed.`);
    }
    case 'get_cognitive_queue': {
      const input = queueInput.parse(args);
      if (input.mission_id && !(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      const queue = await scheduler.listQueue(input.mission_id);
      if (queue.length === 0) return text('Queue empty — no shadow work items.');
      return text(queue.map(w => `- [${w.status}/${w.trigger}] ${w.work_item_id} ${w.mode}: ${w.description.slice(0, 120)} · cost=${w.features.cognitive_cost} (${w.features.cost_basis})`).join('\n'));
    }
    case 'explain_scheduler_decision': {
      const input = explainInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      // Run a shadow pass so the explanation reflects current state, then explain.
      await scheduler.runShadowPass(input.mission_id);
      return text(await scheduler.explainLatest(input.mission_id));
    }
    default:
      return text(`❌ Unknown scheduler tool: ${name}`);
  }
}

/**
 * Dispatch gate for the scheduler tools (criterion 13): with either flag off,
 * the tools are indistinguishable from not existing — plain Unknown tool.
 */
/**
 * Attribution origin from tool args: any LLM call the server makes while
 * handling a cognitive tool is attributed to that mission/work item scope
 * (usage-ledger AsyncLocalStorage — kolega-code LlmCallOrigin equivalent).
 */
function usageOriginFromArgs(args: unknown) {
  const a = (args ?? {}) as Record<string, unknown>;
  const origin = {
    mission_id: typeof a.mission_id === 'string' ? a.mission_id : undefined,
    work_item_id: typeof a.work_item_id === 'string' ? a.work_item_id : undefined,
  };
  return origin.mission_id ? origin : null;
}

export async function dispatchSchedulerTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (cognitiveControlMode() === 'off' || schedulerMode() === 'off') {
    throw new Error(`Unknown tool: ${name}`);
  }
  return runWithUsageOrigin(usageOriginFromArgs(args), () => handleSchedulerTool(name, args, caller));
}

// ── Phase 5: uncertainty engine tool handlers ─────────────────────────────

async function handleUncertaintyTool(name: string, args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  if (cognitiveControlMode() === 'off') return text('❌ Cognitive control plane disabled (COGNITIVE_CONTROL_ENABLED=off).');
  if (schedulerMode() === 'off') return text('❌ Cognitive scheduler disabled (COGNITIVE_SCHEDULER_MODE=off).');
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');

  const canView = async (missionId: string) => {
    if (caller.trusted) return true;
    const state = await db.collection('mission_states').findOne({ mission_id: missionId }, { projection: { owner_id: 1, shared_id: 1 } });
    if (!state) return false;
    const s = state as any;
    return s.owner_id === caller.user_id || Boolean(s.shared_id);
  };

  switch (name) {
    case 'list_uncertainties': {
      const input = missionOnlyInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      const rows = await db.collection('epistemic_entries')
        .find({ mission_id: input.mission_id, entry_type: 'uncertainty', status: { $in: ['active', 'accepted', 'challenged'] } }, { projection: { _id: 0, entry_id: 1, statement: 1, status: 1, consequence_if_false: 1, independence_requirement: 1, information_needed: 1 } })
        .toArray() as unknown as Array<Record<string, unknown>>;
      if (rows.length === 0) return text('No open uncertainties for this mission.');
      return text(rows.map(u => `- ${u.entry_id} [${u.status}] ${String(u.statement).slice(0, 140)}${u.consequence_if_false ? ` (if false: ${u.consequence_if_false})` : ''}${u.independence_requirement ? ` (independence: ${u.independence_requirement})` : ''}`).join('\n'));
    }
    case 'evaluate_triggers': {
      const input = missionOnlyInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      const { evaluateTriggers } = await import('./uncertainty-triggers.js');
      const { fired, byTrigger } = await evaluateTriggers(db, input.mission_id);
      const lines = [`Fired ${fired.length} trigger(s) — deterministic, no model calls.`];
      lines.push(...fired.map(f => `- [${f.trigger}] ${f.entry_id ?? ''}: ${f.reason}`));
      lines.push('By detector: ' + Object.entries(byTrigger).map(([k, v]) => `${k}=${v}`).join(' · '));
      return text(lines.join('\n'));
    }
    case 'trace_assumption_dependencies': {
      const input = traceInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      const { traceAssumptionDependencies } = await import('./dependency-traversal.js');
      const trace = await traceAssumptionDependencies(db, input.mission_id, input.entry_id, input.depth_bound);
      return text(`Transitive dependents of ${trace.root_entry_id}: ${trace.dependents.join(', ') || 'none'} · depth bound ${trace.depth_bound_applied}${trace.cycle_detected ? ' · CYCLE DETECTED (bounded)' : ''}`);
    }
    case 'invalidate_decision': {
      const input = invalidateInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { invalidateDecision } = await import('./invalidation.js');
      const result = await invalidateDecision(db, input.mission_id, input.decision_entry_id, caller.user_id, input.reason);
      return text(`Decision ${input.decision_entry_id} invalidated via delta ${result.delta_id}.\nDependents reopened: ${result.dependent_entry_ids.join(', ') || 'none'}.\nWork items suspended (scoped, not mission-wide): ${result.suspended_work_items}.\nPrior plan preserved: ${result.plan_preserved.entry_id}.`);
    }
    case 'propose_experiment': {
      const input = proposeExperimentInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { proposeExperiment } = await import('./experiment-registry.js');
      const exp = await proposeExperiment(db, input.mission_id, caller.user_id, input.statement, input.separates_hypotheses);
      return text(`Experiment proposed: ${exp.entry_id} — separates hypotheses [${input.separates_hypotheses.join(', ')}].`);
    }
    case 'record_experiment_result': {
      const input = recordResultInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { resolveExperiment } = await import('./experiment-registry.js');
      const exp = await resolveExperiment(db, input.mission_id, input.experiment_entry_id, caller.user_id, {
        summary: input.summary,
        supports_entry_id: input.supports_entry_id,
        contradicts_entry_id: input.contradicts_entry_id,
      });
      return text(`Result recorded on ${exp.entry_id} (status ${exp.status}).${input.contradicts_entry_id ? ` Contradiction opened against ${input.contradicts_entry_id}.` : ''}`);
    }
    case 'get_trigger_report': {
      const input = missionOnlyInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      const { getTriggerReport } = await import('./trigger-telemetry.js');
      const report = await getTriggerReport(db, input.mission_id);
      return text(`Triggers: ${report.fires} fires · ${report.useful} useful · ${report.performative} performative · ${report.unnecessary} unnecessary cost · total ${report.total_tokens} measured tokens · ${report.cost_per_useful_trigger.toFixed(1)} tokens per useful trigger.`);
    }
    case 'create_blind_work_item': {
      const input = blindWorkInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { buildBlindBrief, createBlindWorkItem } = await import('./blind-work.js');
      const brief = await buildBlindBrief(db, input.mission_id, input.uncertainty_entry_id);
      const item = await createBlindWorkItem(db, input.mission_id, input.uncertainty_entry_id, brief);
      return text(`Blind work item ${item.work_item_id} queued (independence_requirement=blind_parallel). Brief: "${brief.question.slice(0, 160)}" — withheld classes [${brief.withheld_classes.join(', ')}].`);
    }
    case 'record_trigger_outcome': {
      const input = triggerOutcomeInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { recordTriggerOutcome } = await import('./trigger-telemetry.js');
      const rec = await recordTriggerOutcome(db, {
        trigger: input.trigger as never,
        mission_id: input.mission_id,
        entry_id: input.entry_id,
        reason: input.note ?? '',
      }, input.outcome, input.note);
      return text(`Outcome recorded: ${rec.evaluation_id} — ${rec.outcome} at ${rec.token_cost} measured tokens.`);
    }
    case 'get_hypothesis_diversity': {
      const input = missionOnlyInput.parse(args);
      if (!(await canView(input.mission_id))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      const { measureHypothesisDiversity } = await import('./hypothesis-diversity.js');
      const r = await measureHypothesisDiversity(db, input.mission_id);
      return text(`Hypotheses: ${r.submitted_count} submitted · ${r.distinct_forms} distinct forms · ${r.falsifiable_count} falsifiable · ${r.flagged_not_falsifiable.length} flagged not-falsifiable [${r.flagged_not_falsifiable.join(', ') || 'none'}] · ${r.distinct_authors} authors · ${r.alternatives_recorded} recorded alternatives.`);
    }
    default:
      return text(`❌ Unknown uncertainty tool: ${name}`);
  }
}

/**
 * Dispatch gate for the Phase 5 uncertainty tools (criterion 24 + §5.2):
 * flag off (either flag) → plain Unknown tool, indistinguishable from absent.
 * Mutating verbs additionally require COGNITIVE_CONTROL_ENABLED=write
 * (enforced inside the handler).
 */
export async function dispatchUncertaintyTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (cognitiveControlMode() === 'off' || schedulerMode() === 'off') {
    throw new Error(`Unknown tool: ${name}`);
  }
  return runWithUsageOrigin(usageOriginFromArgs(args), () => handleUncertaintyTool(name, args, caller));
}

/**
 * Dispatch gate for the mcp-server tool switch (contract #5 fix):
 * with COGNITIVE_CONTROL_ENABLED=off the cognitive tools are NOT reachable —
 * callers get the plain unknown-tool error, indistinguishable from the
 * feature not existing. With read/write the normal handler runs.
 */
export async function dispatchCognitiveTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (cognitiveControlMode() === 'off') {
    throw new Error(`Unknown tool: ${name}`);
  }
  return runWithUsageOrigin(usageOriginFromArgs(args), () => handleCognitiveTool(name, args, caller));
}

// ── Phase 6: controlled activation tools (contract §5.1) ───────────────────

const ACTIVATION_TOOL_NAMES = [
  'set_scheduler_mode',
  'opt_in_mission',
  'revoke_mission_opt_in',
  'get_allocation_evidence',
  'acknowledge_evidence',
  'get_activation_ledger',
  'get_allocation_counterfactual',
  'record_allocator_observation',
  'get_scheduler_recommendation',
  // Phase 8 skill evolution gates (plane-gated like the activation tools).
  'propose_skill_candidate',
  'run_skill_replay',
  'start_skill_canary',
  'complete_skill_canary',
  'promote_skill_version',
  'pin_skill_version',
  'get_skill_candidate_state',
];

export function isActivationTool(name: string): boolean {
  return ACTIVATION_TOOL_NAMES.includes(name);
}

async function handleActivationTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (cognitiveControlMode() === 'off') return text('❌ Cognitive control plane disabled (COGNITIVE_CONTROL_ENABLED=off).');
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  const {
    setMode,
    optInMission,
    revokeMissionOptIn,
    computeEvidenceGate,
    acknowledgeEvidence,
    recordAllocatorObservation,
  } = await import('./activation-service.js');

  const missionOfDecision = async (decisionId: string): Promise<string | null> => {
    const row = (await db.collection('scheduler_decisions').findOne({ decision_id: decisionId }, { projection: { mission_id: 1 } })) as any;
    return row?.mission_id ?? null;
  };

  switch (name) {
    case 'set_scheduler_mode': {
      const input = setSchedulerModeInput.parse(args);
      if (!caller.trusted) return text('❌ set_scheduler_mode requires a trusted caller (operator).');
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const result = await setMode(db, { mode: input.mode, actorId: caller.user_id, reason: input.reason });
      if (!result.changed) {
        return text(`❌ Mode NOT changed (still ${result.mode}). ${result.refused_reason ?? 'no-op'}${result.gate ? `\nGate: ${result.gate.reason}` : ''}`);
      }
      return text(`✅ Scheduler mode: ${result.mode}.${result.cycle_id ? ` Activation cycle ${result.cycle_id} opened (hard bound ${result.gate ? 'n/a' : 'see ledger'}).` : ''} Transition recorded in the activation ledger.`);
    }
    case 'opt_in_mission':
    case 'revoke_mission_opt_in': {
      const input = optInMissionInput.parse(args);
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const state = (await db.collection('mission_states').findOne({ mission_id: input.mission_id }, { projection: { owner_id: 1 } })) as any;
      if (!state) return text(`❌ Mission not found: ${input.mission_id}`);
      if (!caller.trusted && state.owner_id !== caller.user_id) return text(`❌ Not authorized: only the mission owner may opt ${input.mission_id} in.`);
      if (name === 'opt_in_mission') {
        const optIn = await optInMission(db, {
          missionId: input.mission_id,
          ownerId: state.owner_id,
          actorId: caller.user_id,
          reason: input.reason,
        });
        return text(`✅ Mission ${input.mission_id} opted in (${optIn.opt_in_id}) by ${caller.user_id}: ${input.reason}. Influence applies only when COGNITIVE_SCHEDULER_MODE=allocate_internal.`);
      }
      const revoked = await revokeMissionOptIn(db, { missionId: input.mission_id, actorId: caller.user_id, reason: input.reason });
      return text(`✅ Opt-in revoked for ${input.mission_id} (${revoked} active registration${revoked === 1 ? '' : 's'}). Effective immediately — no rebuild.`);
    }
    case 'get_allocation_evidence': {
      const gate = await computeEvidenceGate(db);
      return text(`\`\`\`json\n${JSON.stringify(gate, null, 2)}\n\`\`\``);
    }
    case 'acknowledge_evidence': {
      const input = acknowledgeEvidenceInput.parse(args);
      if (!caller.trusted) return text('❌ acknowledge_evidence requires a trusted caller (operator/human).');
      const gate = await acknowledgeEvidence(db, { actorId: caller.user_id, note: input.note });
      return text(`✅ Evidence acknowledged by ${caller.user_id} — figures computed from stored records: ${gate.qualifying_decisions} evidenced decisions, agreement ${gate.agreement_rate === null ? 'n/a' : (gate.agreement_rate * 100).toFixed(1)}%. Gate ${gate.gate_open ? 'OPEN' : 'closed'}.`);
    }
    case 'get_activation_ledger': {
      const input = ledgerInput.parse(args);
      const rows = (await db
        .collection('activation_ledger')
        .find({}, { projection: { _id: 0 } })
        .sort({ created_at: -1 })
        .limit(input.limit ?? 50)
        .toArray()) as unknown as Array<Record<string, any>>;
      const visible = [];
      for (const row of rows) {
        if (caller.trusted) { visible.push(row); continue; }
        if (row.actor_id === caller.user_id) { visible.push(row); continue; }
        if (row.mission_id && (await canViewMission(row.mission_id, caller))) visible.push(row);
      }
      if (visible.length === 0) return text('No ledger entries visible to you.');
      return text(visible.map(r =>
        `- ${r.created_at} [${r.kind}] ${r.actor_id}: ${r.reason}${r.mode_from && r.mode_to ? ` (${r.mode_from} → ${r.mode_to})` : ''}${r.cycle_id ? ` cycle=${r.cycle_id}` : ''}`,
      ).join('\n'));
    }
    case 'get_allocation_counterfactual': {
      const input = counterfactualInput.parse(args);
      const filter = input.counterfactual_id
        ? { counterfactual_id: input.counterfactual_id }
        : { mission_id: input.mission_id };
      const row = (await db
        .collection('allocation_counterfactuals')
        .find(filter, { projection: { _id: 0 } })
        .sort({ recorded_at: -1 })
        .limit(1)
        .toArray())[0] as any;
      if (!row) return text('No counterfactual record matches.');
      if (!caller.trusted && !(await canViewMission(row.mission_id, caller))) return text(`❌ Not authorized for mission ${row.mission_id}.`);
      return text(
        `**Chosen:** ${row.chosen_agent_id} (${row.influenced ? "scheduler's choice taken" : "existing allocator's choice taken"})\n` +
        `**Existing allocator would have chosen:** ${row.existing_allocator_agent_id}\n` +
        `**Why:** ${row.reason}\n` +
        `Mission ${row.mission_id} · decision ${row.decision_id} · cycle ${row.cycle_id} · recorded ${row.recorded_at}`,
      );
    }
    case 'record_allocator_observation': {
      const input = recordObservationInput.parse(args);
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const missionId = await missionOfDecision(input.decision_id);
      if (!missionId) return text(`❌ Decision not found: ${input.decision_id}`);
      if (!(await canViewMission(missionId, caller))) return text(`❌ Not authorized for mission ${missionId}.`);
      const updated = await recordAllocatorObservation(db, {
        decisionId: input.decision_id,
        agentId: input.agent_id ?? null,
        source: 'manual',
        note: input.note,
      });
      return text(updated
        ? `✅ Observation recorded on ${input.decision_id}: allocator chose ${input.agent_id ?? 'no allocation'}.`
        : `❌ Decision not found: ${input.decision_id}`);
    }
    case 'get_scheduler_recommendation': {
      const input = missionOnlyInput.parse(args);
      const mode = schedulerMode();
      if (mode !== 'recommend' && mode !== 'allocate_internal') {
        return text(`❌ Advisories are only surfaced in recommend mode and above (current: ${mode}). In shadow mode decisions are recorded but not surfaced.`);
      }
      // §4.1 at the acting path: advisories are not produced below the evidence
      // gate, even if the process was booted straight into recommend via env.
      const gate = await computeEvidenceGate(db);
      if (!gate.gate_open) {
        return text(`❌ Evidence gate closed — no advisories. ${gate.reason}`);
      }
      if (!(await canViewMission(input.mission_id, caller))) return text(`❌ Not authorized for mission ${input.mission_id}.`);
      const scheduler = new SchedulerService(db);
      await scheduler.runShadowPass(input.mission_id);
      const d = await scheduler.latestDecision(input.mission_id);
      if (!d) return text('No scheduler decision recorded for this mission.');
      return text(
        `**ADVISORY ONLY** — no allocation path reads this.\n` +
        `Decision ${d.decision_id} (${d.scheduler_mode}):\n` +
        `- Recommended: ${d.recommended ? `${d.recommended.work_item_id} → ${d.recommended.agent_id}` : '(none)'}\n` +
        `- Rationale: ${d.rationale}\n` +
        `- Acted on: ${d.recommended_was_acted_on ? 'yes' : 'no'}`,
      );
    }
    // ── Phase 8: skill evolution gates ────────────────────────────────────
    case 'propose_skill_candidate': {
      const input = skillCandidateInput.parse(args);
      if (!caller.trusted) return text('❌ propose_skill_candidate requires a trusted caller.');
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { proposeSkillCandidate } = await import('./skill-evolution-service.js');
      const rec = await proposeSkillCandidate(db, { skill: input.skill, version: input.version, note: input.note, actorId: caller.user_id });
      return text(`✅ Candidate ${rec.candidate_id} proposed: ${input.skill}@${input.version}. Chain: candidate → replay → canary → promotion.`);
    }
    case 'run_skill_replay': {
      const input = skillCandidateIdInput.parse(args);
      if (!caller.trusted) return text('❌ run_skill_replay requires a trusted caller.');
      const { runSkillReplay } = await import('./skill-evolution-service.js');
      try {
        const { verdict, detail } = await runSkillReplay(db, { candidateId: input.candidate_id, actorId: caller.user_id });
        return text(`Replay verdict: **${verdict}**\n\`\`\`json\n${JSON.stringify(detail, null, 2)}\n\`\`\``);
      } catch (err: any) {
        return text(`❌ ${err.message}`);
      }
    }
    case 'start_skill_canary': {
      const input = skillCanaryInput.parse(args);
      if (!caller.trusted) return text('❌ start_skill_canary requires a trusted caller.');
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { startSkillCanary } = await import('./skill-evolution-service.js');
      try {
        const rec = await startSkillCanary(db, { candidateId: input.candidate_id, missionId: input.mission_id, actorId: caller.user_id });
        return text(`✅ Canary started for ${rec.candidate_id} on mission ${input.mission_id} (replay passed). Record the outcome with complete_skill_canary.`);
      } catch (err: any) {
        return text(`❌ ${err.message}`);
      }
    }
    case 'complete_skill_canary': {
      const input = skillCanaryOutcomeInput.parse(args);
      if (!caller.trusted) return text('❌ complete_skill_canary requires a trusted caller.');
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { completeSkillCanary } = await import('./skill-evolution-service.js');
      try {
        const rec = await completeSkillCanary(db, { candidateId: input.candidate_id, outcome: input.outcome, actorId: caller.user_id });
        return text(`✅ Canary outcome recorded for ${rec.candidate_id}: ${input.outcome}.`);
      } catch (err: any) {
        return text(`❌ ${err.message}`);
      }
    }
    case 'promote_skill_version': {
      const input = skillCandidateIdInput.parse(args);
      if (!caller.trusted) return text('❌ promote_skill_version requires a trusted caller.');
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { promoteSkillVersion } = await import('./skill-evolution-service.js');
      try {
        const rec = await promoteSkillVersion(db, { candidateId: input.candidate_id, actorId: caller.user_id });
        return text(`✅ Promoted ${rec.skill} to version ${rec.version} (${rec.candidate_id}). Registry updated; recorded in skill_evolution.`);
      } catch (err: any) {
        return text(`❌ ${err.message}`);
      }
    }
    case 'pin_skill_version': {
      const input = skillPinInput.parse(args);
      if (!caller.trusted) return text('❌ pin_skill_version requires a trusted caller.');
      if (cognitiveControlMode() !== 'write') return text('❌ COGNITIVE_CONTROL_ENABLED=read — writes disabled.');
      const { pinSkillVersion } = await import('./skill-evolution-service.js');
      const rec = await pinSkillVersion(db, { missionId: input.mission_id, skill: input.skill, version: input.version, actorId: caller.user_id });
      return text(`✅ Pinned ${input.skill}@${input.version} to mission ${input.mission_id} (${rec.entry_id}) — explicit migration approval, §4.15.`);
    }
    case 'get_skill_candidate_state': {
      const input = skillCandidateIdInput.parse(args);
      const { candidateState } = await import('./skill-evolution-service.js');
      const state = await candidateState(db, input.candidate_id);
      if (!state) return text(`❌ Candidate not found: ${input.candidate_id}`);
      return text(`\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``);
    }
    default:
      return text(`❌ Unknown activation tool: ${name}`);
  }
}

/**
 * Phase 6 dispatch gate: activation tools are reachable whenever the cognitive
 * control plane is enabled — set_scheduler_mode must work from mode `off`
 * (that is how activation starts). Gate enforcement lives inside the activation
 * service, which reads stored records only.
 */
export async function dispatchActivationTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (cognitiveControlMode() === 'off') {
    throw new Error(`Unknown tool: ${name}`);
  }
  return runWithUsageOrigin(usageOriginFromArgs(args), () => handleActivationTool(name, args, caller));
}
