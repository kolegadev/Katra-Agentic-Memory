/**
 * MCP surface for the imagination engine + the quality-diversity archive
 * (ITER-6, Phase 4).
 *
 * Two tools, both behind `FOCUSED_IMAGINATION` (default OFF):
 *
 *   - `generate_imagination_seeds` (write) — run one imagination cycle for a
 *     mission: plan the operators from its newest Salience Trace, walk the
 *     knowledge graph for distant associations, make the bounded model calls,
 *     and admit the resulting seeds into the archive. It returns the portfolio
 *     summary (seed ids, bins, scores, rejections WITH REASONS) and it does
 *     NOT promote anything: promotion is Phase 5's and no promotion path
 *     exists here.
 *   - `get_idea_archive` (read) — the coverage view plus the SANITIZED
 *     incumbents (cell key, bins, quality and seed IDS only).
 *
 * Gate: with the flag off the tools are not registered AND
 * `dispatchImaginationTool` throws the plain `Unknown tool` error, so the
 * surface is indistinguishable from not existing (the standard this repo
 * applies to every flag-gated family).
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import {
  ImaginationError,
  ImaginationService,
  focusedImaginationEnabled,
  type ImaginationResult,
} from './imagination-service.js';
import { IdeaArchiveError, IdeaArchiveService } from './idea-archive-service.js';

export { focusedImaginationEnabled };

const generateInput = z.object({
  mission_id: z.string().min(1),
  cycle_id: z.string().min(1).optional(),
  seed: z.union([z.string().min(1), z.number()]).optional(),
  trigger: z.string().min(1).optional(),
  mode: z.enum(['explore', 'exploit', 'balanced']).optional(),
  disposition: z.string().min(1).optional(),
  // Budget knobs: a caller may ask for LESS than the deployment allows and can
  // never ask for more (the service clamps every value to the environment cap).
  max_seeds: z.number().int().min(1).optional(),
  max_operators: z.number().int().min(1).optional(),
  max_llm_calls: z.number().int().min(1).optional(),
  user_id: z.string().optional(),
});

const archiveInput = z.object({
  mission_id: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  user_id: z.string().optional(),
});

export const IMAGINATION_TOOL_DEFS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'generate_imagination_seeds',
    description:
      'Run one imagination cycle for a mission and admit the result into its idea archive. Reads the mission\'s newest private Salience Trace and turns it into TESTABLE hypothesis seeds: the ten operator families are selected from what the trace actually presses on (tensions and persistent pulls mutate constraints, absences invert assumptions, surprises reverse causes, attractions shift representation, questions and absences bridge distant associations), one bounded model call is made per operator batch, a seeded multi-hop walk over the mission\'s own knowledge graph supplies the bridges the bridge operators must state, and every seed carries a cheapest test, bounded scores and validated evidence refs. Deterministic: the same seed and the same inputs produce the same portfolio (ids are derived, never random). The archive rejects exact duplicates, paraphrases and excluded regions WITH REASONS — dedupe is containment-aware over content tokens, so padding a restatement with extra characters does not smuggle it past the gate — keeps one incumbent per descriptor cell, and lets a ruled-out idea back only with a VALID changed premise (a complete sentence that is not a no-change assertion such as "nothing has changed", and that names content the excluded text did not) plus a lineage link to the prior rejection. Requires FOCUSED_IMAGINATION; an untrusted caller may only run its own mission; trusted callers may name user_id. Nothing is promoted — the seeds stay private.',
    inputSchema: zodToJsonSchema(generateInput) as Record<string, unknown>,
  },
  {
    name: 'get_idea_archive',
    description:
      'Read the caller\'s own idea archive for a mission: the coverage view (cells total, cells by descriptor dimension, new cells this cycle, occupancy, gaps) plus the sanitized incumbent summaries — cell key, descriptor bins, quality and seed IDS only. It never returns a seed statement, a mechanism or any evidence text, and it never crosses identities: an untrusted caller only ever sees its own archive. Requires FOCUSED_IMAGINATION.',
    inputSchema: zodToJsonSchema(archiveInput) as Record<string, unknown>,
  },
];

export const IMAGINATION_TOOL_NAMES = IMAGINATION_TOOL_DEFS.map((t) => t.name);

const GENERATE_TOOL = 'generate_imagination_seeds';
const ARCHIVE_TOOL = 'get_idea_archive';

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

function summarizeRun(result: ImaginationResult): string {
  if (result.status === 'failed') {
    return [
      '❌ Imagination cycle FAILED — no seeds admitted.',
      `**Run:** \`${result.run_id}\` (cycle \`${result.cycle_id}\`, status \`failed\`)`,
      `**Error:** ${result.error ?? 'unknown'}`,
      `**Planned → actual:** operators ${result.operators_planned} → ${result.operators_run}, model calls ${result.llm_calls_planned} → ${result.llm_calls_actual}`,
      'Use a NEW cycle_id to retry the same mission.',
    ].join('\n');
  }
  if (result.status === 'in_progress') {
    return `⏳ An imagination cycle is already in progress for cycle \`${result.cycle_id}\` (run \`${result.run_id}\`). No second run started.`;
  }

  const lines: string[] = [];
  lines.push(`${result.reused ? '♻️ Replayed recorded run (no model call)' : '✅ Imagination cycle complete'} — cycle \`${result.cycle_id}\``);
  lines.push(
    `**Seeds:** ${result.seeds_generated} generated · ${result.seeds_admitted} admitted · ${result.seeds_below_incumbent} below incumbent · ${result.seeds_rejected} rejected`,
  );
  lines.push(
    `**Budget (effective, planned → actual):** seeds ≤${result.run.budget.max_seeds}, operators ${result.operators_planned} → ${result.operators_run}, model calls ${result.llm_calls_planned} → ${result.llm_calls_actual}`,
  );
  lines.push(`**New cells this cycle:** ${result.new_cells} of ${result.cells_total} · **portfolio digest:** \`${result.portfolio_digest ?? 'n/a'}\``);
  lines.push(
    `**Walk:** depth ${result.run.walk.depth_bound}, ${result.run.walk.paths} path(s), ${result.run.walk.nodes_scanned} node(s) / ${result.run.walk.edges_scanned} edge(s)${result.run.walk.truncated ? ' (truncated at a bound)' : ''}`,
  );
  if (Object.keys(result.dropped_by_reason).length > 0) {
    lines.push(`**Dropped:** ${JSON.stringify(result.dropped_by_reason)}`);
  }
  if (result.run.llm_errors?.length) {
    lines.push(`⚠️ **Model call errors:** ${result.run.llm_errors.join(' | ')}`);
  }

  lines.push('');
  lines.push('**Operator plan** (trace-driven, seeded tie-breaks):');
  for (const entry of result.operator_plan) {
    lines.push(
      `- ${entry.operator} — score ${entry.score}, ${entry.reason}${entry.skipped ? ` (skipped: ${entry.skip_reason})` : ''}${entry.triggered_by.length > 0 ? `, driven by ${entry.triggered_by.join(', ')}` : ''}`,
    );
  }

  lines.push('');
  lines.push('**Portfolio** (rank · cell · scores · id):');
  for (const seed of result.seeds) {
    lines.push(
      `- #${seed.rank} [${seed.operator}] q=${seed.quality.toFixed(3)} n=${seed.novelty_score.toFixed(2)} c=${seed.coherence_score.toFixed(2)} t=${seed.testability_score.toFixed(2)} eig=${seed.expected_information_gain.toFixed(2)} · \`${seed.seed_id}\`${seed.incumbent ? ' (incumbent)' : ''}\n    bins: ${seed.descriptor_bins.join(' / ')}\n    hypothesis: ${seed.hypothesis}\n    cheapest test: ${seed.cheapest_test}${seed.changed_premise ? `\n    changed premise: ${seed.changed_premise}` : ''}${seed.bridge_path ? `\n    bridge: ${seed.bridge_path.join(' → ')}` : ''}`,
    );
  }

  const rejected = result.rejections;
  lines.push('');
  if (rejected.length === 0) {
    lines.push('**Rejections:** none — every generated seed was admitted.');
  } else {
    lines.push('**Rejections** (archived exclusions, with reasons):');
    for (const rejection of rejected) {
      lines.push(
        `- \`${rejection.seed_id}\` [${rejection.operator}] ${rejection.reason}${rejection.duplicate_of ? ` of \`${rejection.duplicate_of}\`` : ''} — ${rejection.detail ?? 'no detail'}`,
      );
    }
  }

  if (result.coverage) {
    lines.push('');
    lines.push(`**Coverage:** ${result.coverage.cells_total} cell(s) · occupancy ${result.coverage.occupancy.ratio} (${result.coverage.occupancy.occupied}/${result.coverage.occupancy.possible})`);
  }
  lines.push('');
  lines.push('_Nothing is promoted: seeds stay private to the caller, no shared scope is written, and the coverage view carries no seed text._');
  return lines.join('\n');
}

async function handleGenerate(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof generateInput>;
  try {
    input = generateInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(GENERATE_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');

  const state = (await db
    .collection('mission_states')
    .findOne({ mission_id: input.mission_id }, { projection: { owner_id: 1, shared_id: 1 } })) as
    | { owner_id?: string; shared_id?: string }
    | null;
  if (!state) return text(`❌ Mission not found: ${input.mission_id}`);
  if (!caller.trusted && state.owner_id !== caller.user_id) {
    return text(
      `❌ Not authorized: mission ${input.mission_id} belongs to another identity. An untrusted caller may only run its own mission.`,
    );
  }

  const userId = resolveScopedUserId(caller, input.user_id);
  const service = new ImaginationService(db);
  try {
    const result = await service.run({
      userId,
      missionId: input.mission_id,
      cycleId: input.cycle_id,
      trigger: input.trigger,
      actorId: caller.user_id,
      seed: input.seed,
      mode: input.mode,
      disposition: input.disposition,
      budget: {
        ...(input.max_seeds !== undefined ? { max_seeds: input.max_seeds } : {}),
        ...(input.max_operators !== undefined ? { max_operators: input.max_operators } : {}),
        ...(input.max_llm_calls !== undefined ? { max_llm_calls: input.max_llm_calls } : {}),
      },
    });
    return text(summarizeRun(result));
  } catch (error) {
    if (error instanceof ImaginationError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Imagination error: ${String((error as Error)?.message ?? error)}`);
  }
}

async function handleGetArchive(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof archiveInput>;
  try {
    input = archiveInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(ARCHIVE_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');

  if (!(await canViewMission(input.mission_id, caller))) {
    return text(`❌ Not authorized for mission ${input.mission_id}.`);
  }

  const userId = resolveScopedUserId(caller, input.user_id);
  const archive = new IdeaArchiveService(db);
  try {
    const coverage = await archive.coverage(input.mission_id, userId);
    const incumbents = await archive.listIncumbents(input.mission_id, userId, input.limit ?? 50);
    const lines: string[] = [];
    lines.push(`**Idea archive** for mission \`${input.mission_id}\` (identity \`${userId}\`)`);
    lines.push(
      `**Cells:** ${coverage.cells_total} · **new this cycle:** ${coverage.new_cells_this_cycle} (cycle \`${coverage.cycle_id ?? 'none'}\`) · **occupancy:** ${coverage.occupancy.ratio} (${coverage.occupancy.occupied}/${coverage.occupancy.possible})`,
    );
    for (const dimension of coverage.descriptor_dimensions) {
      const bins = coverage.cells_by_dimension[dimension] ?? {};
      const rendered = Object.entries(bins)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bin, count]) => `${bin}=${count}`)
        .join(', ');
      lines.push(`- **${dimension}:** ${rendered.length > 0 ? rendered : 'empty'}`);
    }
    lines.push('');
    lines.push('**Incumbents** (sanitized — cell, bins, quality and ids only):');
    if (incumbents.length === 0) {
      lines.push('- none yet');
    } else {
      for (const cell of incumbents) {
        lines.push(
          `- q=${cell.quality.toFixed(3)} · seeds=${cell.seed_count} · cycles ${cell.created_cycle_id}→${cell.last_cycle_id} · \`${cell.incumbent_seed_id}\`\n    bins: ${coverage.descriptor_dimensions.map((d) => `${d}=${cell.bins[d]}`).join(' | ')}`,
        );
      }
    }
    lines.push('');
    lines.push('_Sanitized: this view carries bins, counts, quality and ids — never a seed statement, mechanism or evidence text._');
    return text(lines.join('\n'));
  } catch (error) {
    if (error instanceof IdeaArchiveError) return text(`❌ ${error.message} (${error.code})`);
    return text(`❌ Idea archive error: ${String((error as Error)?.message ?? error)}`);
  }
}

/**
 * Dispatch gate for the imagination tools. With FOCUSED_IMAGINATION off, the
 * tools are indistinguishable from not existing: a plain `Unknown tool` error,
 * no writes, no service call and no model call.
 */
export async function dispatchImaginationTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (!focusedImaginationEnabled()) {
    throw new Error(`Unknown tool: ${name}`);
  }
  switch (name) {
    case GENERATE_TOOL:
      return handleGenerate(args, caller);
    case ARCHIVE_TOOL:
      return handleGetArchive(args, caller);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
