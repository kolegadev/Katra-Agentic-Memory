/**
 * MCP surface for the Creative Baton, the plateau-triggered cycle, the
 * controller adapter and the candidate outcome feedback (ITER-7, Phase 5).
 *
 * Five tools, gated as the contract requires:
 *
 *   - `run_imagination_cycle` (write; `mode: 'evaluate_only'` / `dry_run` reads
 *     only) — run ONE cycle for a mission, or just show the plateau conditions
 *     and the persisted cooldown/budget without writing anything.
 *   - `get_creative_baton` (read) — the caller/scope-aware read: a baton id, or
 *     a mission id for its newest VISIBLE baton.
 *   - `promote_creative_baton` (write, team scope) — gated on BOTH flags and on
 *     a TRUSTED caller.
 *   - `baton_candidates_to_work_items` (write, shared queue) — the adapter.
 *   - `record_candidate_outcome` (write) — archive + telemetry + capped novelty.
 *
 * Gate: all five live behind `FOCUSED_IMAGINATION` (default off) and
 * `promote_creative_baton` additionally behind `CREATIVE_BATON_PROMOTION`
 * (default off). With a flag off the tool is not registered at all AND
 * `dispatchCreativeBatonTool` throws the plain `Unknown tool` error, so the
 * surface is indistinguishable from not existing — the standard this repo
 * applies to every flag-gated family.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import {
  CANDIDATE_OUTCOMES,
  CandidateOutcomeError,
  batonCandidatesToWorkItems,
  listCandidateOutcomes,
  recordCandidateOutcome,
} from './imagination-outcome-service.js';
import {
  ImaginationCycleError,
  evaluatePlateau,
  readCycleState,
  runImaginationCycle,
  windowAt,
  type ImaginationCycleResult,
  type PlateauEvaluation,
} from './imagination-cycle-service.js';
import { maxCyclesPerWindow, maxTokensPerWindow } from './imagination-cycle-config.js';
import {
  CreativeBatonError,
  CreativeBatonService,
  creativeBatonPromotionEnabled,
  type CreativeBaton,
} from './creative-baton-compiler.js';
import { promoteCreativeBaton } from './creative-baton-promotion.js';
import { focusedImaginationEnabled } from './focused-consolidation-service.js';

export { focusedImaginationEnabled, creativeBatonPromotionEnabled };

const runCycleInput = z.object({
  mission_id: z.string().min(1),
  cycle_id: z.string().min(1).optional(),
  trigger: z.string().min(1).optional(),
  force: z.boolean().optional(),
  mode: z.enum(['run', 'evaluate_only']).optional(),
  /** Alias for `mode: 'evaluate_only'`. */
  dry_run: z.boolean().optional(),
  user_id: z.string().optional(),
});

const getBatonInput = z.object({
  baton_id: z.string().min(1).optional(),
  mission_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  user_id: z.string().optional(),
});

const promoteInput = z.object({
  baton_id: z.string().min(1),
  user_id: z.string().optional(),
});

const adapterInput = z.object({
  baton_id: z.string().min(1),
  user_id: z.string().optional(),
});

const outcomeInput = z.object({
  seed_id: z.string().min(1),
  outcome: z.enum(CANDIDATE_OUTCOMES),
  baton_id: z.string().min(1).optional(),
  detail: z.string().max(2000).optional(),
  user_id: z.string().optional(),
});

export const CREATIVE_BATON_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Requires CREATIVE_BATON_PROMOTION in addition to FOCUSED_IMAGINATION. */
  requires_promotion_flag?: boolean;
}> = [
  {
    name: 'run_imagination_cycle',
    description:
      'Run ONE imagination cycle for a stalled mission, or evaluate the plateau without writing. The gates are checked in a fixed order and a refusal writes NOTHING: single-flight (a concurrent caller joins the run), the PERSISTED cooldown, the per-mission window budget (cycles and measured tokens) and then the plateau evaluation. A cycle runs focused consolidation, generates and admits idea seeds, reads the bounded coverage view, compiles a versioned SANITISED Creative Baton (an allow-list: no evidence refs, no changed premises, no trace text, no bridges) and — only with CREATIVE_BATON_PROMOTION=1 and a trusted caller — promotes it to the team scope. It records which STOP CONDITION fired (budget exhausted, coverage target reached, no candidate above the novelty/coherence floor, two rounds without a new cell, a high-value promotion that restored inventory, a privacy validation failure, or a cancelled/superseded mission) plus the coverage scan bounds and whether a bound was hit. The returned `status` is HONEST: `ran` only for a cycle that completed, `failed` (with `reason`, `stop_reason` and `error`) for one whose stored row failed — an upstream failure or a privacy-validation failure — so a caller reading only `status` is never told a failed cycle ran. The cycle id is derived from the scope of the mission (identity + mission id), its version and its ordinal, so two concurrent callers of ONE mission agree on it while two DIFFERENT missions never share a cycle. `mode: "evaluate_only"` (or `dry_run: true`) returns the plateau conditions, the cooldown and the budget accounting with ZERO writes and no model call. `force: true` bypasses the PLATEAU gate only — never the cooldown or the budget. Requires FOCUSED_IMAGINATION; an untrusted caller may only run its own mission.',
    inputSchema: zodToJsonSchema(runCycleInput) as Record<string, unknown>,
  },
  {
    name: 'get_creative_baton',
    description:
      'Read a Creative Baton, caller/scope-aware: pass a `baton_id`, or a `mission_id` for its newest VISIBLE baton. An untrusted caller sees only its own batons plus batons that were PROMOTED to the team scope; another identity\'s unpromoted baton is reported exactly like a missing one. Every stored baton is INTEGRITY-CHECKED before it is served (format version, the closed JSON schema, the secret scan and the payload hash recomputed over the stored document), so a row tampered with after it was written — including one tampered with AFTER it was promoted — is REFUSED by name (`payload_hash_mismatch`, `schema_invalid`, `secret_material`, `version_unsupported`) instead of being rendered as a baton. The baton carries the compiled portfolio (seed ids, hypotheses, mechanisms, descriptor bins, scores, cheapest tests), the attention cues derived from the trace\'s signal shapes, excluded-region FINGERPRINTS (never the excluded text), the coverage gaps with the scan\'s bounds and the next round\'s budget. Requires FOCUSED_IMAGINATION.',
    inputSchema: zodToJsonSchema(getBatonInput) as Record<string, unknown>,
  },
  {
    name: 'promote_creative_baton',
    description:
      'Promote a Creative Baton to the team scope — the ONLY operation in this feature that writes shared state. Requires FOCUSED_IMAGINATION=1 and CREATIVE_BATON_PROMOTION=1 (with either off the tool does not exist), and a TRUSTED caller. The stored baton is re-validated against the registered schema and secret-scanned again, and its payload hash is recomputed and compared with the one the compiler wrote, so a tampered baton is refused with a named reason (`payload_hash_mismatch`, `schema_invalid`, `secret_material`) instead of being shared. The re-validation runs on EVERY call, BEFORE the idempotency answer: a baton tampered with after it was promoted is refused rather than reported as an unchanged no-op, and the schema is CLOSED (`additionalProperties: false`), so an extra key anywhere in the packet fails even when the writer recomputed the payload hash. Promotion records the promoting identity, timestamp, schema version and payload hash in the promotion audit, and is idempotent: promoting the same payload twice reports the existing promotion and writes nothing.',
    inputSchema: zodToJsonSchema(promoteInput) as Record<string, unknown>,
    requires_promotion_flag: true,
  },
  {
    name: 'baton_candidates_to_work_items',
    description:
      'Turn a baton\'s eligible candidates into CONTROLLER WORK ITEMS through the existing scheduler funnel (`SchedulerService.upsertWorkItems` — no new write path): each item carries the baton id and seed id in its description and in a `provenance` field, reuses the existing `manual` trigger (the item exists because a caller explicitly asked for it) and is `explore`. Idempotent: the queue dedupes on trigger + description, so re-running inserts nothing and reports the same items as reused. An untrusted caller may only adapt a PROMOTED (team-shared) baton, because the work queue is shared state; a trusted caller may adapt its own. The stored baton is integrity-checked before a single candidate is copied, so a tampered baton reaches neither the queue nor the caller. The result counts what the call ACTUALLY added: `created`/`reused` describe the baton-derived items and `work_items_added_total` (with `funnel_derived_added`) describes every row the funnel added, including the items it derives from mission state itself. Requires FOCUSED_IMAGINATION.',
    inputSchema: zodToJsonSchema(adapterInput) as Record<string, unknown>,
  },
  {
    name: 'record_candidate_outcome',
    description:
      'Record what a candidate turned out to be — `useful_information`, `mere_variance` or `unnecessary_cost`. It feeds the archive\'s identity-bound `recordOutcome` (the seed is looked up by seed id AND identity, so no caller can write into another identity\'s lineage), the existing trigger telemetry (measured token cost, grouped under the `imagination_candidate` trigger) and a CAPPED novelty-drive replenishment (+0.05 per useful outcome, at most 0.2 per identity and mission per rolling 24 hours, computed from the stored outcome rows so a restart cannot refill the same budget). Repeating the same outcome for the same seed is recorded ONCE and reported as a repeat. Requires FOCUSED_IMAGINATION.',
    inputSchema: zodToJsonSchema(outcomeInput) as Record<string, unknown>,
  },
];

export const CREATIVE_BATON_TOOL_NAMES = CREATIVE_BATON_TOOL_DEFS.map((tool) => tool.name);

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

// ── Rendering ───────────────────────────────────────────────────────────────

function renderPlateau(evaluation: PlateauEvaluation): string[] {
  const lines: string[] = [];
  lines.push(
    `**Plateau:** ${evaluation.plateau ? 'yes' : 'no'} · cooldown remaining \`${evaluation.cooldown_remaining_ms}ms\``,
  );
  for (const condition of evaluation.conditions) {
    lines.push(
      `- ${condition.met ? '✅' : '⛔'} \`${condition.name}\` — ${JSON.stringify(condition.evidence)}`,
    );
  }
  return lines;
}

function renderCycleResult(result: ImaginationCycleResult): string {
  const lines: string[] = [];
  const icon = result.status === 'ran' ? '✅' : result.status === 'failed' ? '❌' : result.status === 'replayed' ? '♻️' : '⏭️';
  lines.push(
    `${icon} \`${result.status}\` — **${result.reason}**${result.cycle_id ? ` · cycle \`${result.cycle_id}\`` : ''}`,
  );
  if (result.stop_reason) lines.push(`**Stop condition:** \`${result.stop_reason}\``);
  if (result.error) lines.push(`**Error:** ${result.error}`);
  if (result.cooldown_remaining_ms > 0) {
    lines.push(`**Cooldown:** ${result.cooldown_remaining_ms}ms remaining — nothing was written.`);
  }
  if (result.trace_id) lines.push(`**Trace:** \`${result.trace_id}\``);
  if (result.baton_id) lines.push(`**Creative baton:** \`${result.baton_id}\``);
  if (result.promotion_skipped) lines.push(`**Promotion:** skipped (\`${result.promotion_skipped}\`)`);
  else if (result.promoted) lines.push('**Promotion:** shared to the team scope.');
  if (result.portfolio) {
    const portfolio = result.portfolio;
    lines.push(
      `**Portfolio:** ${portfolio.seeds_generated} generated · ${portfolio.seeds_admitted} admitted · ` +
        `${portfolio.seeds_below_incumbent} below incumbent · ${portfolio.seeds_rejected} rejected · ` +
        `${portfolio.candidates_eligible}/${portfolio.candidates_considered} eligible · ` +
        `${portfolio.new_cells} new cell(s) of ${portfolio.cells_total}`,
    );
    if (portfolio.portfolio_digest) lines.push(`**Portfolio digest:** \`${portfolio.portfolio_digest}\``);
  }
  if (result.budget) {
    const budget = result.budget;
    lines.push(
      `**Budget:** cycles ${budget.cycles_in_window_before} → ${budget.cycles_in_window_after} of ${budget.max_cycles} · ` +
        `tokens ${budget.tokens_in_window_before} → ${budget.tokens_in_window_after} of ${budget.max_tokens} ` +
        `(this cycle: ${budget.tokens_spent_this_cycle})`,
    );
  }
  if (result.stop_conditions.length > 0) {
    lines.push('');
    lines.push('**Stop conditions evaluated** (first met wins):');
    for (const condition of result.stop_conditions) {
      lines.push(`- ${condition.met ? '✅' : '⛔'} \`${condition.name}\` — ${JSON.stringify(condition.evidence)}`);
    }
  }
  if (result.plateau) {
    lines.push('');
    lines.push('**Plateau conditions at gate time:**');
    lines.push(...renderPlateau(result.plateau));
  }
  return lines.join('\n');
}

function renderBaton(baton: CreativeBaton): string {
  const lines: string[] = [];
  lines.push(`**Creative baton** \`${baton.baton_id}\` (version ${baton.creative_baton_version})`);
  lines.push(
    `**Mission:** ${baton.mission_id} v${baton.mission_version} · **cycle:** ${baton.cycle_id} · **trigger:** ${baton.trigger.type} (${baton.trigger.evidence.join(', ') || 'none'})`,
  );
  lines.push(
    `**Scope:** ${baton.shared_id ? `shared (\`${baton.shared_id}\`)` : 'private'} · **stop reason:** ${baton.stop_reason ?? 'n/a'} · **payload hash:** \`${baton.payload_hash}\``,
  );
  lines.push(
    `**Counts:** ${baton.counts.candidates_eligible}/${baton.counts.candidates_considered} eligible candidates · ` +
      `${baton.counts.excluded_regions} excluded-region fingerprint(s) · ${baton.counts.attention_targets} attention cue(s)`,
  );
  lines.push(
    `**Coverage:** ${baton.coverage_summary.cells_total} cell(s) · ${baton.coverage_summary.new_cells_this_cycle} new · ` +
      `scan ${baton.coverage_summary.scan.cells_scanned}/${baton.coverage_summary.scan.cells_limit} cell(s), ` +
      `dedupe bound ${baton.coverage_summary.scan.seeds_dedupe_limit} seed(s)${baton.coverage_summary.scan.truncated ? ' — ⚠️ TRUNCATED' : ''}`,
  );
  lines.push(
    `**Next round budget:** ${baton.next_round_budget.candidates} candidate(s), ${baton.next_round_budget.tests} test(s)`,
  );
  lines.push('');
  lines.push('**Attention targets** (derived from the trace\'s signal shapes — never its text):');
  for (const target of baton.attention_targets) {
    lines.push(`- ${target.cue}\n    why: ${target.why_operationally_relevant}`);
  }
  lines.push('');
  lines.push('**Candidates:**');
  if (baton.candidate_portfolio.length === 0) {
    lines.push('- none above the novelty/coherence floor this cycle');
  }
  for (const candidate of baton.candidate_portfolio) {
    lines.push(
      `- \`${candidate.seed_id}\` (lineage \`${candidate.lineage_ref}\`) n=${candidate.novelty_score.toFixed(2)} c=${candidate.coherence_score.toFixed(2)} eig=${candidate.expected_information_gain.toFixed(2)} · privacy_safe=${candidate.privacy_safe}\n    hypothesis: ${candidate.hypothesis}\n    mechanism: ${candidate.mechanism}\n    cheapest test: ${candidate.cheapest_test}`,
    );
  }
  lines.push('');
  lines.push('**Excluded regions** (fingerprints only — the excluded text is not in a baton):');
  for (const region of baton.excluded_regions) {
    lines.push(`- \`${region.pattern}\` — ${region.reason}; re-openable with ${region.unless}`);
  }
  lines.push('');
  lines.push(
    `_Privacy: raw_reflections_included=${baton.privacy.raw_reflections_included}, shared=${baton.privacy.shared}; the baton was compiled from an allow-list, so no evidence ref, changed premise, trace statement or bridge text is present._`,
  );
  return lines.join('\n');
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleRunCycle(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof runCycleInput>;
  try {
    input = runCycleInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments('run_imagination_cycle', error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  if (!(await canViewMission(input.mission_id, caller))) {
    return text(
      `❌ Not authorized: mission ${input.mission_id} belongs to another identity. An untrusted caller may only run its own mission.`,
    );
  }
  const userId = resolveScopedUserId(caller, input.user_id);
  const evaluateOnly = input.mode === 'evaluate_only' || input.dry_run === true;

  try {
    if (evaluateOnly) {
      const plateau = await evaluatePlateau(db, { userId, missionId: input.mission_id });
      const state = await readCycleState(db, userId, input.mission_id);
      const window = windowAt(state, Date.parse(plateau.evaluated_at), plateau.evaluated_at);
      const lines: string[] = [];
      lines.push(
        `🔎 **Evaluate-only** for mission \`${input.mission_id}\` (identity \`${userId}\`) — no writes, no model call.`,
      );
      lines.push(...renderPlateau(plateau));
      lines.push('');
      lines.push(
        `**Persisted state:** cycles run ${state?.cycle_count ?? 0} · last cycle \`${state?.last_cycle_id ?? 'none'}\` · ` +
          `last stop \`${state?.last_stop_reason ?? 'none'}\``,
      );
      lines.push(
        `**Window budget:** cycles ${window.cycles}/${maxCyclesPerWindow()} · tokens ${window.tokens}/${maxTokensPerWindow()} (window started ${window.startedAt})`,
      );
      lines.push(
        `**Cooldown remaining:** ${plateau.cooldown_remaining_ms}ms (persisted across restarts; shrinking IMAGINATION_CYCLE_COOLDOWN_MS takes effect immediately).`,
      );
      lines.push(
        '_A cycle would run when the plateau is true (or "force" is set) AND the cooldown has expired AND the window budget allows it._',
      );
      return text(lines.join('\n'));
    }
    const result = await runImaginationCycle(db, {
      userId,
      missionId: input.mission_id,
      cycleId: input.cycle_id,
      trigger: input.trigger,
      force: input.force,
      actorId: caller.user_id,
      caller,
    });
    return text(renderCycleResult(result));
  } catch (error) {
    if (error instanceof ImaginationCycleError) return text(`❌ ${error.message} (${error.code})`);
    if (error instanceof CreativeBatonError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Imagination cycle error: ${String((error as Error)?.message ?? error)}`);
  }
}

async function handleGetBaton(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof getBatonInput>;
  try {
    input = getBatonInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments('get_creative_baton', error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  if (!input.baton_id && !input.mission_id) {
    return text('❌ Provide `baton_id` or `mission_id`.');
  }
  if (input.mission_id && !(await canViewMission(input.mission_id, caller))) {
    return text(`❌ Not authorized for mission ${input.mission_id}.`);
  }
  const userId = resolveScopedUserId(caller, input.user_id);
  const service = new CreativeBatonService(db);

  const blocks: string[] = [];
  let missionForOutcomes: string | null = input.mission_id ?? null;
  if (input.baton_id) {
    // The VERIFIED read: a stored baton is integrity-checked (version, closed
    // schema, secret scan, payload hash) before it is served, so a tampered row
    // is refused BY NAME instead of being rendered as a baton.
    const read = await service.readCreativeBaton(input.baton_id, caller);
    if (read.refusal) {
      return text(`❌ Creative baton ${input.baton_id} refused (\`${read.refusal.code}\`): ${read.refusal.reason}`);
    }
    if (!read.baton) return text(`❌ No creative baton visible for you: ${input.baton_id}`);
    missionForOutcomes = read.baton.mission_id;
    blocks.push(renderBaton(read.baton));
  } else {
    const visible = await service.listVisibleBatons(userId, input.mission_id!, caller, input.limit ?? 5);
    if (visible.batons.length === 0 && visible.refusals.length === 0) {
      return text(`❌ No creative baton recorded for mission ${input.mission_id} under ${userId}.`);
    }
    blocks.push(...visible.batons.map(renderBaton));
    for (const refusal of visible.refusals) {
      blocks.push(
        `❌ Creative baton \`${refusal.baton_id}\` refused (\`${refusal.code}\`): ${refusal.reason}`,
      );
    }
  }
  // The recorded outcomes are part of the resume surface: a controller reading
  // a baton should see what already happened to its candidates.
  const outcomes = missionForOutcomes ? await listCandidateOutcomes(db, userId, missionForOutcomes, 20) : [];
  if (outcomes.length > 0) {
    blocks.push(
      [
        '**Recorded candidate outcomes** (newest first):',
        ...outcomes.map(
          (row) =>
            `- \`${row.seed_id}\` ${row.outcome} at ${row.recorded_at} (novelty +${row.novelty_replenished})${row.detail ? ` — ${row.detail}` : ''}`,
        ),
      ].join('\n'),
    );
  }
  return text(blocks.join('\n\n---\n\n'));
}

async function handlePromote(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof promoteInput>;
  try {
    input = promoteInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments('promote_creative_baton', error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  const userId = resolveScopedUserId(caller, input.user_id);
  const result = await promoteCreativeBaton(db, { userId, batonId: input.baton_id, caller });
  if (!result.promoted) {
    return text(`❌ Promotion refused (${result.code}): ${result.reason}`);
  }
  const promotion = result.promotion;
  return text(
    [
      `${result.reused ? '♻️ Already promoted (no write)' : '✅ Promoted'} — baton \`${input.baton_id}\``,
      `**Shared scope:** \`${result.shared_id}\``,
      promotion
        ? `**Audit:** promotion \`${promotion.promotion_id}\` by \`${promotion.promoted_by}\` at ${promotion.promoted_at} · schema ${promotion.baton_schema_version} · payload \`${promotion.payload_hash}\``
        : '**Audit:** no promotion row found for this payload.',
      result.reason,
    ].join('\n'),
  );
}

async function handleAdapter(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof adapterInput>;
  try {
    input = adapterInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments('baton_candidates_to_work_items', error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  const userId = resolveScopedUserId(caller, input.user_id);
  try {
    const result = await batonCandidatesToWorkItems(db, { userId, batonId: input.baton_id, caller });
    const lines: string[] = [];
    lines.push(`✅ ${result.reason}`);
    lines.push(
      `**Baton:** \`${result.baton_id}\` · **mission:** ${result.mission_id} · **scope:** ${result.promoted ? `shared (\`${result.shared_id}\`)` : 'private (trusted caller)'}`,
    );
    lines.push('');
    lines.push('**Work items** (controller queue, trigger `manual`, mode `explore`):');
    for (const item of result.work_items) {
      lines.push(`- \`${item.work_item_id}\` ← seed \`${item.seed_id}\``);
    }
    if (result.work_items.length === 0) lines.push('- none (the baton carries no eligible candidate)');
    lines.push('');
    lines.push(
      `**Rows added to the queue by this call:** ${result.work_items_added_total} ` +
        `(${result.created} baton-derived, ${result.funnel_derived_added} the funnel derived from mission state) · ` +
        `${result.reused} baton item(s) already queued`,
    );
    return text(lines.join('\n'));
  } catch (error) {
    if (error instanceof CandidateOutcomeError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Adapter error: ${String((error as Error)?.message ?? error)}`);
  }
}

async function handleOutcome(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof outcomeInput>;
  try {
    input = outcomeInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments('record_candidate_outcome', error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');
  const userId = resolveScopedUserId(caller, input.user_id);
  try {
    const result = await recordCandidateOutcome(db, {
      userId,
      seedId: input.seed_id,
      outcome: input.outcome,
      batonId: input.baton_id,
      detail: input.detail,
    });
    if (!result.recorded && !result.repeated) {
      return text(`❌ Nothing recorded: ${result.reason}`);
    }
    return text(
      [
        result.repeated
          ? `♻️ Repeat — the \`${input.outcome}\` outcome for \`${input.seed_id}\` is already on record (recorded once).`
          : `✅ Recorded \`${input.outcome}\` for \`${input.seed_id}\`.`,
        `**Archive lineage updated:** ${result.lineage_updated} · **telemetry:** \`${result.telemetry_evaluation_id ?? 'n/a'}\``,
        `**Novelty drive:** +${result.novelty_replenished} (cap remaining today: ${result.novelty_cap_remaining})`,
        result.reason,
      ].join('\n'),
    );
  } catch (error) {
    if (error instanceof CandidateOutcomeError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Outcome error: ${String((error as Error)?.message ?? error)}`);
  }
}

/**
 * Dispatch gate. With `FOCUSED_IMAGINATION` off (or, for promotion, with
 * `CREATIVE_BATON_PROMOTION` off) the tool is indistinguishable from not
 * existing: a plain `Unknown tool` error, no writes, no service call and no
 * model call.
 */
export async function dispatchCreativeBatonTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (!focusedImaginationEnabled()) {
    throw new Error(`Unknown tool: ${name}`);
  }
  if (name === 'promote_creative_baton' && !creativeBatonPromotionEnabled()) {
    throw new Error(`Unknown tool: ${name}`);
  }
  switch (name) {
    case 'run_imagination_cycle':
      return handleRunCycle(args, caller);
    case 'get_creative_baton':
      return handleGetBaton(args, caller);
    case 'promote_creative_baton':
      return handlePromote(args, caller);
    case 'baton_candidates_to_work_items':
      return handleAdapter(args, caller);
    case 'record_candidate_outcome':
      return handleOutcome(args, caller);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
