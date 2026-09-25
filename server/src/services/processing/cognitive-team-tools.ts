/**
 * MCP surface for the cognitive team (ITER-8, Phase 6).
 *
 * Six tools, all behind `COGNITIVE_TEAM_ALLOCATION` (default OFF):
 *
 *   - `assign_thinking_mode` (write) — the brief's named tool, and the whole
 *     mode LIFECYCLE folded into one surface: `action: "assign"` (default),
 *     `"renew"` and `"expire"`. The contract allows the surface to be narrowed
 *     as long as `assign_thinking_mode` and a caller-pinned read survive and the
 *     choice is documented; keeping renew/expire as explicit ACTIONS here means
 *     every mode transition still goes through a tool with a required reason,
 *     while the surface stays at the six the contract names.
 *   - `get_active_mode` (read) — the mode in force for a mission, with the
 *     expiry COMPUTED AT READ (no cron): an assignment past its window is
 *     reported expired, and the transition is recorded once.
 *   - `create_inheritance_envelope` (write) — create a bounded inheritance grant
 *     for a spawned scope, or apply bounded MUTATIONS to an existing one. The
 *     mutation surface is folded in here for the same reason as the mode
 *     actions: it is the same artifact, and a refused mutation is reported BY
 *     NAME (`immutable_invariant`, `dimension_not_approved`, `out_of_bounds`).
 *   - `allocate_cognitive_portfolio` (write) — the §4.5 portfolio: missing-bin
 *     coverage, the convergence and load penalties, and the reserved
 *     independent evaluator, with every score component and input reported.
 *   - `plan_independent_first_pass` (write; `run: false` is a read) — the
 *     per-agent generation requests (only the mission digest, the agent's own
 *     envelope/mode and the public context), and with `run: true` the isolated
 *     first pass itself through ITER-6's engine.
 *   - `synthesize_portfolios` (write) — a merged portfolio with provenance and
 *     exclusion reasons preserved verbatim. It cannot promote.
 *
 * Gate and pinning: with `COGNITIVE_TEAM_ALLOCATION` off the tools are not
 * registered AND `dispatchCognitiveTeamTool` throws the plain `Unknown tool`
 * error, so the surface is indistinguishable from not existing. Every tool is
 * caller-pinned: an untrusted caller may only act for, and read, its own
 * identity, and only for a mission it owns or that is shared with it; the
 * services re-check the same pin independently.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import {
  COGNITIVE_MODE_NAMES,
  COGNITIVE_MODES,
  CognitiveModeError,
  ModeAccessError,
  activeMode,
  assignMode,
  cognitiveTeamAllocationEnabled,
  expireMode,
  listAssignments,
  renewMode,
  type ThinkingModeAssignment,
} from './cognitive-mode-service.js';
import {
  InheritanceEnvelopeError,
  applyBoundedMutation,
  createInheritanceEnvelope,
  listEnvelopes,
  readEnvelope,
  storeEnvelope,
  verifyEnvelope,
  type InheritanceEnvelope,
} from './inheritance-envelope.js';
import {
  AllocateResult,
  CognitiveAllocationError,
  allocatePortfolio,
} from './cognitive-allocation-service.js';
import {
  FirstPassError,
  planFirstPass,
  readFirstPass,
  runFirstPass,
  synthesizePortfolios,
  type FirstPassRecord,
  type FirstPassRequest,
  type PortfolioExclusion,
} from './independent-first-pass.js';

export { cognitiveTeamAllocationEnabled };

// ── Input schemas ───────────────────────────────────────────────────────────

const mutationInput = z.object({
  dimension: z.string().min(1),
  value: z.number(),
});

const assignInput = z.object({
  action: z.enum(['assign', 'renew', 'expire']).optional(),
  mission_id: z.string().min(1),
  mode: z.enum(COGNITIVE_MODE_NAMES).optional(),
  reason: z.string().min(1).max(500),
  ttl_ms: z.number().int().min(1).optional(),
  assignment_id: z.string().min(1).optional(),
  user_id: z.string().optional(),
});

const activeModeInput = z.object({
  mission_id: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  user_id: z.string().optional(),
});

const envelopeInput = z.object({
  mission_id: z.string().min(1),
  child_label: z.string().min(1).max(120).optional(),
  envelope_id: z.string().min(1).optional(),
  mode: z.enum(COGNITIVE_MODE_NAMES).optional(),
  ttl_ms: z.number().int().min(1).optional(),
  mutations: z.array(mutationInput).max(16).optional(),
  user_id: z.string().optional(),
});

const allocateInput = z.object({
  mission_id: z.string().min(1),
  candidates: z
    .array(
      z.object({
        identity: z.string().min(1),
        mode: z.string().min(1),
        emotional_proximity: z.number().min(0).max(1).optional(),
        task_skill_fit: z.number().min(0).max(1).optional(),
        availability: z.number().min(0).max(1).optional(),
        covered_bins: z.array(z.string().min(1)).max(64).optional(),
        recent_cycles: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(24),
  missing_bins: z.array(z.string().min(1)).max(64).optional(),
  max_agents: z.number().int().min(1).max(12).optional(),
  user_id: z.string().optional(),
});

const firstPassInput = z.object({
  mission_id: z.string().min(1),
  team: z
    .array(
      z.object({
        identity: z.string().min(1),
        mode: z.enum(COGNITIVE_MODE_NAMES),
        envelope_id: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .max(12),
  run: z.boolean().optional(),
  user_id: z.string().optional(),
});

const synthesizeInput = z.object({
  mission_id: z.string().min(1),
  pass_id: z.string().min(1),
  exclusions: z
    .array(
      z.object({
        ref: z.string().min(1),
        kind: z.enum(['rejected_hypothesis', 'excluded_region', 'rejected_seed']),
        reason: z.string().min(1),
        text_hash: z.string().min(1),
      }),
    )
    .optional(),
  synthesizer_identity: z.string().min(1).optional(),
  user_id: z.string().optional(),
});

export const COGNITIVE_TEAM_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: 'assign_thinking_mode',
    description:
      'Assign, renew or expire an EPHEMERAL thinking mode for a mission (the brief\'s Appendix C modes: philosopher, technician, strategist, creative, analyst, critic, verifier, synthesizer — each recorded with its attention bias and obligation verbatim, and each declaring which APPROVED configuration dimensions it may bias and never a hard invariant). The reason is REQUIRED and stored verbatim (capped at 500 characters, refused rather than truncated), the TTL is explicit (default 4h, a NUMBER of milliseconds refused outside the documented 1 minute..7 day window rather than clamped — a string is never coerced), and the assignment records its start, expiry, policy version, inheritance policy, the parent\'s disposition snapshot VERSION and its reset behaviour. A mode is working state for a mission that is still running: assigning or renewing one on a mission that is not runnable (`completed`, `cancelled`, or any status other than `active`/`paused`) is refused BY NAME (`mission_not_runnable`) before anything is written. `action: "renew"` extends the window from `max(now, current expiry)` — the ONLY path that moves it — and an expired assignment cannot be renewed at all; `action: "expire"` ends it early with a reason. Expiry is computed at READ, never by a cron: a mission whose mode has lapsed reports `expired` and the transition is recorded once. An untrusted caller may only act for its own identity. Requires COGNITIVE_TEAM_ALLOCATION=1.',
    inputSchema: zodToJsonSchema(assignInput) as Record<string, unknown>,
  },
  {
    name: 'get_active_mode',
    description:
      'Read the thinking mode in force for a mission: the assignment, its catalogue entry (attention bias, obligation, the approved dimensions it may bias, its attention bins and its engine spread), its window and whether it is still active. EXPIRY IS COMPUTED AT READ — an assignment past its window is reported `expired` (and recorded as expired exactly once, with no cron anywhere). Returns the caller\'s OWN mode: an untrusted caller is PINNED to its own identity, so NAMING another identity is refused by name rather than silently answered for the caller — a mission\'s OWNER reads the mode it holds on its mission under its own identity, and another identity\'s assignment needs a TRUSTED caller. Requires COGNITIVE_TEAM_ALLOCATION=1.',
    inputSchema: zodToJsonSchema(activeModeInput) as Record<string, unknown>,
  },
  {
    name: 'create_inheritance_envelope',
    description:
      'Create the BOUNDED inheritance grant a spawned cognitive scope receives, or apply bounded MUTATIONS to one (`envelope_id`). The envelope is an IMMUTABLE REFERENCE — `parent_identity_id` plus a disposition snapshot (profile, version and a hash over an allow-listed subset of the parent\'s configuration), the immutable bounds (message priority 10.0, the working-memory/vector floors, the per-source cap bounds and the privacy policy), the approved dimensions this scope may bias, the parent\'s baseline values and an expiry. It carries NO private memory: no journal, reflection, trace, seed or belief text can reach it, its hash input or this output (a taint suite proves it). A bounded mutation is CLAMPED into its documented range and recorded in the envelope\'s history (k within ±25% of the parent\'s value, vector_fetch_limit within 1..20, cap_pct tightened within bounds); anything else is refused BY NAME — `immutable_invariant` (the message priority, the floors, the cap bounds, the privacy policy and every alias of them), `dimension_not_approved` (an unknown dimension, or one this envelope\'s mode may not bias) or `out_of_bounds` (not a finite number, or an attempt to widen a per-source cap above the parent\'s own bound). The parent\'s own configuration is NEVER modified: a mutation produces a NEW derived envelope. Requires COGNITIVE_TEAM_ALLOCATION=1.',
    inputSchema: zodToJsonSchema(envelopeInput) as Record<string, unknown>,
  },
  {
    name: 'allocate_cognitive_portfolio',
    description:
      'Allocate a PORTFOLIO — not one winner — for a mission, using the brief\'s §4.5 score: 0.35*emotional_proximity + 0.25*task_skill_fit + 0.20*missing_approach_coverage + 0.10*recent_success + 0.10*availability - convergence_penalty - load_penalty. `missing_approach_coverage` comes from the archive\'s coverage gaps (ITER-6/7) unless the caller supplies `missing_bins`, so the allocation targets the descriptor bins NOTHING occupies; `recent_success` is derived from the identity\'s recorded candidate outcomes; `availability` from its live mode assignments on this mission; the convergence penalty punishes sharing a mode with peers AND picking yet another agent of a mode the portfolio already holds — the duplicate-pick cost is measured against the portfolio AS IT STANDS, so it decides the pick rather than being reported after it; the load penalty punishes an identity that has just been cycling hard inside the persisted window. EVERY component and penalty is returned with its inputs in `allocation_report`, so the decision is auditable, and equal inputs always produce the same portfolio. The result reserves one verifier/critic that is NOT among the generators, recorded with the reason "independent evaluator". Requires COGNITIVE_TEAM_ALLOCATION=1.',
    inputSchema: zodToJsonSchema(allocateInput) as Record<string, unknown>,
  },
  {
    name: 'plan_independent_first_pass',
    description:
      'Plan — and with `run: true` execute — an INDEPENDENT first pass: each agent in the team gets its own generation request carrying ONLY the mission digest (ids, version, title, intent, the trace\'s problem-state digest, a summary of signal SHAPES, the coverage gaps and the exclusions as fingerprints), the agent\'s OWN envelope and mode, and the engine settings derived from them. No peer seeds, no peer identities, no peer envelope and no private memory: an exclusion crosses as `{ref, kind, reason, text_hash}` and a trace signal as its shape, never its statement. With `run: true` each READY request runs through ITER-6\'s engine reading that agent\'s OWN trace and archive (`{user_id, mission_id}`-keyed, so the isolation is structural), and each agent\'s stream is derived from the pass, its MODE and its envelope scoring — never from a peer and never from the identity\'s private state, which is what makes a same-mode team converge and a mixed-mode team span the space. A request whose agent has no trace, or whose envelope is missing, expired, tampered with or granted for another mode, is returned `blocked` with the named reason instead of being generated anyway. Requires COGNITIVE_TEAM_ALLOCATION=1.',
    inputSchema: zodToJsonSchema(firstPassInput) as Record<string, unknown>,
  },
  {
    name: 'synthesize_portfolios',
    description:
      'Merge the portfolios of an independent first pass into ONE synthesized portfolio with provenance intact: a candidate several agents produced keeps EVERY source (agent, mode, cycle, seed id) in its provenance — the merge collapses the statement, never the lineage — and the exclusions ride along VERBATIM as fingerprints. Supplying an `exclusions` list that DROPS one on record is refused (`exclusion_dropped`), and rewriting one — same ref, different kind, reason or text hash — is refused (`exclusion_rewritten`), so a synthesizer can never erase or restate why an idea was ruled out. A synthesizer CANNOT ADD one either: an exclusion supplied that is NOT on record is IGNORED (a synthesizer preserves the mission\'s exclusions, it does not extend them) and is named back in the output rather than quietly dropped. The artifact appends a `synthesis` lineage record, carries `promoted: false`, and CANNOT promote: it is a private row with no shared scope, and promotion stays where Phase 5 put it. Requires COGNITIVE_TEAM_ALLOCATION=1.',
    inputSchema: zodToJsonSchema(synthesizeInput) as Record<string, unknown>,
  },
];

export const COGNITIVE_TEAM_TOOL_NAMES = COGNITIVE_TEAM_TOOL_DEFS.map((tool) => tool.name);

const ASSIGN_TOOL = 'assign_thinking_mode';
const GET_MODE_TOOL = 'get_active_mode';
const ENVELOPE_TOOL = 'create_inheritance_envelope';
const ALLOCATE_TOOL = 'allocate_cognitive_portfolio';
const FIRST_PASS_TOOL = 'plan_independent_first_pass';
const SYNTHESIZE_TOOL = 'synthesize_portfolios';

function text(message: string): TextContent[] {
  return [{ type: 'text', text: message }];
}

function invalidArguments(tool: string, error: unknown): TextContent[] | null {
  if (!(error instanceof z.ZodError)) return null;
  const detail = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  return text(`❌ Invalid arguments for ${tool} — ${detail}`);
}

/** A trusted caller may name a user; an untrusted caller is pinned to itself. */
function resolveScopedUserId(caller: CallerIdentity, requested?: unknown): string {
  const provided = typeof requested === 'string' && requested.trim().length > 0 ? requested.trim() : undefined;
  return caller.trusted && provided ? provided : caller.user_id;
}

/** Mission visibility for an untrusted caller: its own mission, or a shared one. */
async function canViewMission(missionId: string, caller: CallerIdentity): Promise<boolean> {
  if (caller.trusted) return true;
  const state = (await get_database()
    .collection('mission_states')
    .findOne({ mission_id: missionId }, { projection: { owner_id: 1, shared_id: 1 } })) as
    | { owner_id?: string; shared_id?: string }
    | null;
  if (!state) return false;
  return state.owner_id === caller.user_id || Boolean(state.shared_id);
}

async function missionOwnerId(missionId: string): Promise<string | null> {
  const state = (await get_database()
    .collection('mission_states')
    .findOne({ mission_id: missionId }, { projection: { owner_id: 1 } })) as { owner_id?: string } | null;
  return state?.owner_id ?? null;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderAssignment(assignment: ThinkingModeAssignment, active: boolean | null): string[] {
  const spec = COGNITIVE_MODES[assignment.mode];
  const lines: string[] = [];
  lines.push(
    `**Mode:** \`${assignment.mode}\` (${spec.label}) · **status:** \`${assignment.status}\`${active === false ? ' (lapsed)' : ''}`,
  );
  lines.push(`**Assignment:** \`${assignment.assignment_id}\` · **identity:** ${assignment.user_id} · **mission:** ${assignment.mission_id}`);
  lines.push(`**Reason:** ${assignment.reason}`);
  lines.push(
    `**Window:** started ${assignment.started_at} · expires ${assignment.expires_at} · ttl ${assignment.ttl_ms}ms${assignment.renewals.length > 0 ? ` · renewed ${assignment.renewals.length}×` : ''}`,
  );
  lines.push(
    `**Policy:** version ${assignment.policy_version} · inheritance \`${assignment.inheritance_policy}\` · parent disposition version ${assignment.snapshot_version ?? 'none'} · reset \`${assignment.reset_behaviour}\``,
  );
  lines.push(`**Attention bias (verbatim):** ${spec.attention_bias}`);
  lines.push(`**Obligation (verbatim):** ${spec.obligation}`);
  lines.push(
    `**May bias:** ${spec.approved_dimensions.join(', ') || 'nothing'} · **attention bins:** ${spec.attention_bins.flatMap((entry) => entry.bins.map((bin) => `${entry.dimension}=${bin}`)).join(', ')} · **engine spread:** ${spec.engine_mode}`,
  );
  if (assignment.expiry) {
    lines.push(`**Expiry:** recorded ${assignment.expiry.at} by ${assignment.expiry.by} — ${assignment.expiry.reason}`);
  }
  return lines;
}

function renderEnvelope(envelope: InheritanceEnvelope): string[] {
  const lines: string[] = [];
  lines.push(
    `**Envelope:** \`${envelope.envelope_id}\`${envelope.parent_envelope_id ? ` (derived from \`${envelope.parent_envelope_id}\`)` : ''} · **child:** ${envelope.child_label} · **mode:** ${envelope.mode ?? 'none'}`,
  );
  lines.push(
    `**Parent identity:** ${envelope.parent_identity_id} · **mission:** ${envelope.mission_id} · **expires:** ${envelope.expires_at}`,
  );
  lines.push(
    `**Disposition snapshot:** profile \`${envelope.disposition_snapshot.profile}\` · version ${envelope.disposition_snapshot.version} · hash \`${envelope.disposition_snapshot.hash}\``,
  );
  lines.push(
    `**Bounds (immutable):** message_priority ${envelope.bounds.message_priority} · floors working_memory ${envelope.bounds.floors.working_memory} / vector_search ${envelope.bounds.floors.vector_search} · caps cap_pct ≤ ${envelope.bounds.caps.max_single_source_pct}, k ${envelope.bounds.caps.k_floor}..${envelope.bounds.caps.k_ceiling}, fetch ≤ ${envelope.bounds.caps.vector_fetch_limit_max} · privacy \`${envelope.bounds.privacy_policy}\``,
  );
  lines.push(
    `**Allowed dimensions:** ${envelope.allowed_dimensions.join(', ')} · **baseline:** k=${envelope.baseline.k} fetch=${envelope.baseline.vector_fetch_limit} cap=${envelope.baseline.cap_pct}`,
  );
  lines.push(
    `**Effective scoring:** k=${envelope.effective_scoring.relevance_multiplier} · vector_fetch_limit=${envelope.effective_scoring.vector_fetch_limit} · cap_pct=${envelope.effective_scoring.max_single_source_pct} · floors ${envelope.effective_scoring.working_memory_floor}/${envelope.effective_scoring.vector_search_floor} · agent_message ${envelope.effective_scoring.agent_message_weight}`,
  );
  if (envelope.mutations.length === 0) {
    lines.push('**Mutations:** none — the parent\'s own values, unbounded.');
  } else {
    lines.push('**Mutation history** (requested → applied, range, source):');
    for (const mutation of envelope.mutations) {
      lines.push(
        `- \`${mutation.dimension}\`: ${mutation.requested} → ${mutation.applied}${mutation.clamped ? ' (CLAMPED)' : ''} in ${mutation.min}..${mutation.max} · ${mutation.source} · by ${mutation.by} at ${mutation.at}`,
      );
    }
  }
  lines.push(
    `**Policy hash:** \`${envelope.policy_hash}\` · **privacy:** private_content_included=${envelope.privacy.private_content_included}, shared=${envelope.privacy.shared}`,
  );
  lines.push(
    '_The envelope is an immutable reference: no journal, reflection, trace, seed or belief is in it, and the parent\'s own configuration was never modified._',
  );
  return lines;
}

function renderRequest(request: FirstPassRequest): string[] {
  const lines: string[] = [];
  lines.push(
    `- ${request.status === 'ready' ? '✅' : '⛔'} **${request.agent.identity}** as \`${request.agent.mode}\` (${request.agent.mode_label}) · request \`${request.request_id}\`${request.blocked_reason ? ` — blocked: \`${request.blocked_reason}\`` : ''}`,
  );
  lines.push(
    `    envelope: ${request.envelope ? `\`${request.envelope.envelope_id}\` · disposition \`${request.envelope.disposition_hash}\` · k=${request.envelope.effective_scoring.relevance_multiplier} fetch=${request.envelope.effective_scoring.vector_fetch_limit} cap=${request.envelope.effective_scoring.max_single_source_pct}` : 'none'}`,
  );
  lines.push(`    attention bias: ${request.mode_definition.attention_bias}`);
  lines.push(`    obligation: ${request.mode_definition.obligation}`);
  lines.push(
    `    may bias: ${request.mode_definition.approved_dimensions.join(', ') || 'nothing'} · engine spread: \`${request.engine.mode}\` · cycle \`${request.engine.cycle_id}\``,
  );
  lines.push(
    `    mission digest: v${request.mission_digest.mission_version} · trace \`${request.mission_digest.trace_id ?? 'none'}\` · digest \`${request.mission_digest.problem_state_digest ?? 'none'}\` · ${request.mission_digest.trace_summary.length} signal shape(s) · ${request.mission_digest.coverage_gaps.reduce((total, gap) => total + gap.unoccupied_bins.length, 0)} missing bin(s) · ${request.mission_digest.exclusions.length} exclusion fingerprint(s)`,
  );
  return lines;
}

function renderFirstPass(pass: FirstPassRecord): string[] {
  const lines: string[] = [];
  lines.push(
    `**First pass** \`${pass.pass_id}\` — ${pass.status} · ${pass.counts.agents} agent(s): ${pass.counts.ready} ready, ${pass.counts.blocked} blocked · ${pass.counts.seeds} seed(s) from ${pass.counts.generated} agent(s)`,
  );
  lines.push(`**Mission:** ${pass.mission_id} · **planned by:** ${pass.user_id} · **created:** ${pass.created_at}`);
  lines.push('');
  lines.push('**Requests** (mission digest + own envelope/mode + public context only):');
  for (const request of pass.requests) lines.push(...renderRequest(request));
  if (pass.results.length > 0) {
    lines.push('');
    lines.push('**Isolated portfolios:**');
    for (const result of pass.results) {
      lines.push(
        `- **${result.identity}** (\`${result.mode}\`, spread \`${result.engine_mode}\`): ${result.status} · ${result.seeds.length} seed(s) · run \`${result.run_id ?? 'n/a'}\` · cycle \`${result.cycle_id ?? 'n/a'}\` · ${result.llm_calls} model call(s)${result.error ? ` · error: ${result.error}` : ''}${result.blocked_reason ? ` · blocked: \`${result.blocked_reason}\`` : ''}`,
      );
      for (const seed of result.seeds) {
        lines.push(`    - \`${seed.seed_id}\` [${seed.operator}] q=${seed.quality.toFixed(3)} · ${seed.hypothesis}`);
      }
    }
  }
  lines.push('');
  lines.push(
    '_Isolation: every request carries the agent\'s own envelope/mode and the public context only — no peer seeds, identities or private memory; each agent generated from its own trace and archive._',
  );
  return lines;
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleAssign(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof assignInput>;
  try {
    input = assignInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(ASSIGN_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  const userId = resolveScopedUserId(caller, input.user_id);
  const action = input.action ?? 'assign';

  try {
    if (action === 'assign') {
      if (!(await canViewMission(input.mission_id, caller))) {
        return text(`❌ Not authorized for mission ${input.mission_id}.`);
      }
      if (!input.mode) return text('❌ `mode` is required to assign a thinking mode.');
      const assignment = await assignMode(db, {
        userId,
        missionId: input.mission_id,
        mode: input.mode,
        reason: input.reason,
        ttlMs: input.ttl_ms,
        actorId: caller.user_id,
        caller,
      });
      const lines = [`✅ Thinking mode assigned — no silent extension: it expires at ${assignment.expires_at}.`];
      lines.push(...renderAssignment(assignment, true));
      return text(lines.join('\n'));
    }
    if (!input.assignment_id) {
      return text(`❌ \`assignment_id\` is required to ${action} a thinking mode.`);
    }
    if (action === 'renew') {
      const result = await renewMode(db, {
        assignmentId: input.assignment_id,
        reason: input.reason,
        ttlMs: input.ttl_ms,
        actorId: caller.user_id,
        caller,
      });
      if (!result.renewed || !result.assignment) {
        return text(`❌ Renewal refused (\`${result.code ?? 'conflict'}\`): ${result.reason}`);
      }
      const lines = [`✅ ${result.reason}`];
      lines.push(...renderAssignment(result.assignment, true));
      return text(lines.join('\n'));
    }
    const result = await expireMode(db, {
      assignmentId: input.assignment_id,
      reason: input.reason,
      actorId: caller.user_id,
      caller,
    });
    if (!result.assignment) return text(`❌ ${result.reason}`);
    const lines = [result.expired ? `✅ ${result.reason}` : `ℹ️ ${result.reason}`];
    lines.push(...renderAssignment(result.assignment, false));
    return text(lines.join('\n'));
  } catch (error) {
    if (error instanceof ModeAccessError) return text(`❌ ${error.message}`);
    if (error instanceof CognitiveModeError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Thinking mode error: ${String((error as Error)?.message ?? error)}`);
  }
}

async function handleGetActiveMode(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof activeModeInput>;
  try {
    input = activeModeInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(GET_MODE_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  const requested = typeof input.user_id === 'string' && input.user_id.trim().length > 0 ? input.user_id.trim() : undefined;
  const owner = await missionOwnerId(input.mission_id);
  // A mission-scoped mode is readable by the identity that holds it, and a
  // TRUSTED caller may name any identity. An untrusted caller is PINNED to its
  // own identity — the service will not answer for anyone else — so NAMING
  // another identity is refused BY NAME here rather than being silently answered
  // for the caller (which is what the old text implied was a mission-owner read
  // of the named identity's mode). A mission's owner reads the mode it holds on
  // its mission, under its own identity; another identity's mode needs a trusted
  // caller.
  if (!caller.trusted && requested !== undefined && requested !== caller.user_id) {
    const ownerNote =
      owner === caller.user_id
        ? ` '${caller.user_id}' owns mission ${input.mission_id}: a mission-scoped mode is visible to the owner under its OWN identity, never another identity's.`
        : '';
    return text(
      `❌ Not authorized: an untrusted caller is PINNED to its own identity and may not name '${requested}'.${ownerNote} A trusted caller may name another identity.`,
    );
  }
  const userId = resolveScopedUserId(caller, input.user_id);
  try {
    const result = await activeMode(db, { userId, missionId: input.mission_id, caller });
    const lines: string[] = [];
    if (!result.assignment) {
      lines.push(`ℹ️ No thinking mode recorded for ${userId} on mission ${input.mission_id}.`);
    } else {
      lines.push(
        result.active
          ? `✅ Active thinking mode for ${userId} on mission ${input.mission_id}.`
          : `⏳ The newest thinking mode for ${userId} on mission ${input.mission_id} has lapsed${result.expired_now ? ' (recorded expired by this read)' : ''}.`,
      );
      lines.push(...renderAssignment(result.assignment, result.active));
    }
    const history = await listAssignments(db, { userId, missionId: input.mission_id, limit: input.limit ?? 10, caller });
    lines.push('');
    lines.push(`**Recorded assignments** (${history.length} of ${result.assignments_total}, newest first):`);
    for (const assignment of history) {
      lines.push(
        `- \`${assignment.assignment_id}\` · \`${assignment.mode}\` · \`${assignment.status}\` · ${assignment.started_at} → ${assignment.expires_at} · ${assignment.reason}`,
      );
    }
    lines.push('');
    lines.push('_Expiry is computed at read — there is no cron: an assignment past its window is reported expired, once._');
    return text(lines.join('\n'));
  } catch (error) {
    if (error instanceof ModeAccessError) return text(`❌ ${error.message}`);
    if (error instanceof CognitiveModeError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Thinking mode error: ${String((error as Error)?.message ?? error)}`);
  }
}

async function handleEnvelope(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof envelopeInput>;
  try {
    input = envelopeInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(ENVELOPE_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  const userId = resolveScopedUserId(caller, input.user_id);
  if (!(await canViewMission(input.mission_id, caller))) {
    return text(`❌ Not authorized for mission ${input.mission_id}.`);
  }

  try {
    const refusals: Array<{ dimension: string; code: string; reason: string }> = [];
    let envelope: InheritanceEnvelope;
    let derived = false;

    if (input.envelope_id) {
      const read = await readEnvelope(db, input.envelope_id, caller);
      if (read.refusal) {
        return text(`❌ Envelope ${input.envelope_id} refused (\`${read.refusal.code}\`): ${read.refusal.reason}`);
      }
      if (!read.envelope) return text(`❌ No inheritance envelope visible for you: ${input.envelope_id}`);
      envelope = read.envelope;
      for (const mutation of input.mutations ?? []) {
        const outcome = applyBoundedMutation(envelope, {
          dimension: mutation.dimension,
          value: mutation.value,
          actorId: caller.user_id,
          source: 'caller',
        });
        if (!outcome.ok) {
          refusals.push({ dimension: mutation.dimension, code: outcome.code, reason: outcome.reason });
          continue;
        }
        envelope = await storeEnvelope(db, outcome.envelope, envelope.parent_identity_id);
        derived = true;
      }
    } else {
      if (!input.child_label) {
        return text('❌ `child_label` is required to create an envelope (or pass `envelope_id` to mutate one).');
      }
      const created = await createInheritanceEnvelope(db, {
        parentUserId: userId,
        missionId: input.mission_id,
        childLabel: input.child_label,
        mode: input.mode ?? null,
        ttlMs: input.ttl_ms,
        mutations: input.mutations,
        actorId: caller.user_id,
        caller,
      });
      envelope = created.envelope;
      for (const refusal of created.refusals) {
        refusals.push({ dimension: refusal.dimension, code: refusal.code, reason: refusal.reason });
      }
    }

    const lines: string[] = [];
    lines.push(
      `✅ Inheritance envelope ${derived ? 'derived (the source envelope is unchanged)' : 'created'} — bounded and immutable-bounded.`,
    );
    lines.push(...renderEnvelope(envelope));
    if (refusals.length > 0) {
      lines.push('');
      lines.push(`**Refused mutations (${refusals.length}) — nothing was applied for these:**`);
      for (const refusal of refusals) {
        lines.push(`- \`${refusal.dimension}\` → refused \`${refusal.code}\`: ${refusal.reason}`);
      }
    }
    return text(lines.join('\n'));
  } catch (error) {
    if (error instanceof InheritanceEnvelopeError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Inheritance envelope error: ${String((error as Error)?.message ?? error)}`);
  }
}

function renderAllocation(result: AllocateResult): string {
  const portfolio = result.portfolio;
  const lines: string[] = [];
  lines.push(
    `${result.reused ? '♻️ Existing portfolio' : '✅ Portfolio allocated'} \`${portfolio.portfolio_id}\` for mission ${portfolio.mission_id}`,
  );
  lines.push(
    `**Weights:** ${Object.entries(portfolio.weights).map(([key, value]) => `${key}=${value}`).join(' · ')}`,
  );
  lines.push(
    `**Missing bins:** ${portfolio.counts.bins_targeted} targeted · ${portfolio.counts.bins_covered} covered · ${portfolio.counts.bins_uncovered.length} uncovered${portfolio.counts.bins_uncovered.length > 0 ? ` (${portfolio.counts.bins_uncovered.slice(0, 8).join(', ')}${portfolio.counts.bins_uncovered.length > 8 ? '…' : ''})` : ''}`,
  );
  lines.push(
    `**Coverage source:** ${portfolio.coverage_source.source} · ${portfolio.coverage_source.cells_total} cell(s) · scan truncated: ${portfolio.coverage_source.scan_truncated}`,
  );
  lines.push('');
  lines.push('**Agents (portfolio, not one winner):**');
  if (portfolio.agents.length === 0) lines.push('- none');
  for (const agent of portfolio.agents) {
    lines.push(
      `- #${agent.selection_rank} ${agent.role === 'evaluator' ? '🔍' : ''} **${agent.identity}** as \`${agent.mode}\` (spread \`${agent.engine_mode ?? 'n/a'}\`) · static ${agent.static_score} → selected ${agent.selection_score}${agent.covered_bins.length > 0 ? ` · covers ${agent.covered_bins.join(', ')}` : ''}`,
    );
  }
  lines.push('');
  if (portfolio.verifier_reservation) {
    lines.push(
      `**Independent evaluator:** ${portfolio.verifier_reservation.identity} as \`${portfolio.verifier_reservation.mode}\` — reason "${portfolio.verifier_reservation.reason}", evaluates ${portfolio.verifier_reservation.evaluates.join(', ') || 'the portfolio'} (it generated none of them).`,
    );
  } else {
    lines.push(`**Independent evaluator:** none reserved — ${portfolio.verifier_refusal ?? 'no reason recorded'}`);
  }
  lines.push('');
  lines.push('**Allocation report** (every component with its inputs):');
  for (const row of portfolio.allocation_report) {
    const components = row.components;
    lines.push(
      `- ${row.selected ? '✅' : '⛔'} **${row.identity}** \`${row.mode}\` · static ${row.static_score} · selection ${row.selection_score}${row.selection_rank ? ` (rank #${row.selection_rank})` : ''} — ${row.reason}`,
    );
    lines.push(
      `    ep=${components.emotional_proximity.value} (${components.emotional_proximity.source}) · skill=${components.task_skill_fit.value} (${components.task_skill_fit.source}) · coverage=${components.missing_approach_coverage.value} (${components.missing_approach_coverage.source}, ${components.missing_approach_coverage.detail.targeted_bins}/${components.missing_approach_coverage.detail.missing_bins} bins) · success=${components.recent_success.value} (${components.recent_success.source}, ${components.recent_success.detail.useful_outcomes}/${components.recent_success.detail.outcomes_total}) · availability=${components.availability.value} (${components.availability.source}, ${components.availability.detail.active_assignments} live mode(s))`,
    );
    lines.push(
      `    penalties: convergence ${row.penalties.convergence.value} (peers ${row.penalties.convergence.peer_component} + duplicate picks ${row.penalties.convergence.duplicate_pick_component}) · load ${row.penalties.load.value} (${row.penalties.load.cycles_in_window}/${row.penalties.load.max_cycles} cycles in window)`,
    );
  }
  lines.push('');
  lines.push(
    `_Deterministic: equal inputs produce the same portfolio; the report carries identities, modes, bins and scores — never a seed statement, a trace or a belief._`,
  );
  return lines.join('\n');
}

async function handleAllocate(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof allocateInput>;
  try {
    input = allocateInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(ALLOCATE_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  if (!(await canViewMission(input.mission_id, caller))) {
    return text(`❌ Not authorized for mission ${input.mission_id}.`);
  }
  const userId = resolveScopedUserId(caller, input.user_id);
  try {
    const result = await allocatePortfolio(db, {
      userId,
      missionId: input.mission_id,
      candidates: input.candidates,
      missingBins: input.missing_bins,
      maxAgents: input.max_agents,
      caller,
    });
    return text(renderAllocation(result));
  } catch (error) {
    if (error instanceof CognitiveAllocationError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Allocation error: ${String((error as Error)?.message ?? error)}`);
  }
}

async function handleFirstPass(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof firstPassInput>;
  try {
    input = firstPassInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(FIRST_PASS_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  if (!(await canViewMission(input.mission_id, caller))) {
    return text(`❌ Not authorized for mission ${input.mission_id}.`);
  }
  const userId = resolveScopedUserId(caller, input.user_id);
  const team = input.team.map((member) => ({
    identity: member.identity,
    mode: member.mode,
    envelope_id: member.envelope_id,
  }));
  try {
    const planned = await planFirstPass(db, { userId, missionId: input.mission_id, team, caller });
    if (input.run !== true) {
      const lines = ['🔎 **Planned** (no generation yet — pass `run: true` to execute).'];
      lines.push(...renderFirstPass(planned.pass));
      return text(lines.join('\n'));
    }
    const ran = await runFirstPass(db, { userId, missionId: input.mission_id, team, caller, pass: planned.pass });
    const lines = ['✅ **Independent first pass executed** — each agent generated from its own trace and archive.'];
    lines.push(...renderFirstPass(ran.pass));
    return text(lines.join('\n'));
  } catch (error) {
    if (error instanceof FirstPassError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ First pass error: ${String((error as Error)?.message ?? error)}`);
  }
}

async function handleSynthesize(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof synthesizeInput>;
  try {
    input = synthesizeInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(SYNTHESIZE_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  if (!(await canViewMission(input.mission_id, caller))) {
    return text(`❌ Not authorized for mission ${input.mission_id}.`);
  }
  const userId = resolveScopedUserId(caller, input.user_id);
  try {
    const pass = await readFirstPass(db, input.pass_id);
    if (!pass) return text(`❌ No first pass visible for you: ${input.pass_id}`);
    if (pass.mission_id !== input.mission_id) {
      return text(`❌ First pass ${input.pass_id} belongs to mission ${pass.mission_id}, not ${input.mission_id}.`);
    }
    if (!caller.trusted && pass.user_id !== caller.user_id) {
      return text(`❌ Not authorized: first pass ${input.pass_id} was planned by another identity.`);
    }
    const result = await synthesizePortfolios(db, {
      userId,
      missionId: input.mission_id,
      portfolios: [pass],
      exclusions: input.exclusions as PortfolioExclusion[] | undefined,
      synthesizer: input.synthesizer_identity ? { identity: input.synthesizer_identity } : undefined,
      caller,
    });
    if (!result.synthesized || !result.portfolio) {
      const lines = [`❌ Synthesis refused (\`${result.code ?? 'refused'}\`): ${result.reason}`];
      for (const refusal of result.refusals) lines.push(`- \`${refusal.ref}\` — \`${refusal.code}\`: ${refusal.reason}`);
      for (const ref of result.ignored_exclusions ?? []) {
        lines.push(
          `- \`${ref}\` — \`exclusion_ignored\`: not on record, so it was IGNORED (a synthesizer preserves the mission's exclusions, it cannot add one)`,
        );
      }
      return text(lines.join('\n'));
    }
    const portfolio = result.portfolio;
    const lines: string[] = [];
    lines.push(`✅ ${result.reason}`);
    lines.push(
      `**Synthesis** \`${portfolio.portfolio_id}\` · sources: ${portfolio.sources.join(', ')} · promoted: ${portfolio.promoted} (this path CANNOT promote)`,
    );
    lines.push(
      `**Counts:** ${portfolio.counts.candidates_in} candidate(s) in → ${portfolio.counts.candidates_out} out (${portfolio.counts.merged} merged) · ${portfolio.counts.exclusions} exclusion(s) carried verbatim`,
    );
    lines.push('');
    lines.push('**Candidates with provenance:**');
    for (const candidate of portfolio.candidates) {
      lines.push(
        `- \`${candidate.seed_id}\` q=${candidate.quality.toFixed(3)} · merged_from ${candidate.merged_from}\n    ${candidate.hypothesis}\n    provenance: ${candidate.provenance.map((entry) => `${entry.source_agent}/${entry.source_mode}←${entry.source_seed_id}`).join(', ')}`,
      );
    }
    lines.push('');
    lines.push('**Exclusions (verbatim fingerprints):**');
    for (const exclusion of portfolio.exclusions) {
      lines.push(`- \`${exclusion.ref}\` (${exclusion.kind}) — ${exclusion.reason} · text \`${exclusion.text_hash}\``);
    }
    if (portfolio.exclusions.length === 0) lines.push('- none recorded');
    if (result.ignored_exclusions.length > 0) {
      lines.push('');
      lines.push(
        `**Ignored (${result.ignored_exclusions.length}) — supplied but NOT on record, so a synthesis cannot add them:** ${result.ignored_exclusions.map((ref) => `\`${ref}\``).join(', ')}`,
      );
    }
    lines.push('');
    lines.push(`**Lineage:** ${portfolio.lineage.map((entry) => `${entry.kind} by ${entry.by} at ${entry.at}`).join(' · ')}`);
    lines.push('');
    lines.push('_Promotion is not performed here: a synthesis is a private row with no shared scope._');
    return text(lines.join('\n'));
  } catch (error) {
    if (error instanceof FirstPassError) return text(`❌ ${error.message} (${error.code})`);
    if (error instanceof CognitiveAllocationError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Synthesis error: ${String((error as Error)?.message ?? error)}`);
  }
}

/**
 * Dispatch gate. With `COGNITIVE_TEAM_ALLOCATION` off the tools are
 * indistinguishable from not existing: a plain `Unknown tool` error, no writes,
 * no service call and no model call.
 */
export async function dispatchCognitiveTeamTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (!cognitiveTeamAllocationEnabled()) {
    throw new Error(`Unknown tool: ${name}`);
  }
  switch (name) {
    case ASSIGN_TOOL:
      return handleAssign(args, caller);
    case GET_MODE_TOOL:
      return handleGetActiveMode(args, caller);
    case ENVELOPE_TOOL:
      return handleEnvelope(args, caller);
    case ALLOCATE_TOOL:
      return handleAllocate(args, caller);
    case FIRST_PASS_TOOL:
      return handleFirstPass(args, caller);
    case SYNTHESIZE_TOOL:
      return handleSynthesize(args, caller);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
