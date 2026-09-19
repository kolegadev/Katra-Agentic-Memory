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
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import {
  cognitiveControlMode,
  getMissionCognitionServices,
} from './index.js';
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
  status: z.enum(['proposed', 'accepted', 'superseded', 'invalidated', 'open']).default('accepted'),
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
      const state = await services.missions.getMissionState(input.mission_id);
      if (!state) return text(`❌ Mission not found: ${input.mission_id}`);
      const deltas = await services.deltas.listDeltas(input.mission_id, 10);
      const sinceCheckpoint = deltas.filter(d => d.status === 'accepted' && (d.base_mission_version ?? 0) >= state.version - 10);
      const summary = [
        `**Mission:** ${state.title} [${state.status}] — v${state.version}`,
        `**Owner:** ${state.owner_id} | **Authority:** ${state.authority_class}`,
        `**Open objectives:** ${(state.objectives ?? []).filter(o => o.status !== 'completed').map(o => `${o.id} (${o.status})`).join(', ') || 'none'}`,
        `**Recent accepted deltas:** ${sinceCheckpoint.length}`,
        `**Next cognition:** ${state.next_cognition ?? '(not set — open a new baton)'}`,
      ].join('\n');
      return text(summary);
    }
    default:
      return text(`❌ Unknown cognitive tool: ${name}`);
  }
}
