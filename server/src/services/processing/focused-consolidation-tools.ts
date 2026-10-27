/**
 * MCP surface for focused consolidation (ITER-5, Phase 3).
 *
 * Two tools, both behind `FOCUSED_IMAGINATION` (default OFF):
 *
 *   - `run_focused_consolidation` (write) — run one focused consolidation
 *     cycle for a mission. The caller may only run its OWN mission unless it
 *     is trusted; the written trace and run row are private to the caller.
 *   - `get_salience_trace` (read) — read the caller's own traces. Never
 *     another identity's rows, never a shared/team path.
 *
 * Gate: with the flag off the tools are not registered AND `dispatchFocusedTool`
 * throws the plain `Unknown tool` error, so the surface is indistinguishable
 * from not existing (the standard this repo applies to every flag-gated family).
 * Unlike the cognitive-control families this one is gated ONLY on its own flag:
 * the contract makes FOCUSED_IMAGINATION the single switch, and the service
 * reads mission state directly rather than through the cognitive tool surface.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import {
  FocusedConsolidationError,
  FocusedConsolidationService,
  focusedImaginationEnabled,
  type FocusedConsolidationResult,
  type SalienceTrace,
} from './focused-consolidation-service.js';

export { focusedImaginationEnabled };

const runFocusedInput = z.object({
  mission_id: z.string().min(1),
  cycle_id: z.string().min(1).optional(),
  trigger: z.string().min(1).optional(),
  user_id: z.string().optional(),
});

const getSalienceTraceInput = z.object({
  trace_id: z.string().optional(),
  mission_id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  user_id: z.string().optional(),
});

export const FOCUSED_TOOL_DEFS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'run_focused_consolidation',
    description:
      'Run one focused consolidation cycle for a mission: gather its real state (mission state, active baton, epistemic ledger, open uncertainties, work queue, accepted deltas since the last checkpoint, and the identity\'s reflection state as COUNTS ONLY) and privately produce an evidence-linked, calibrated Salience Trace — attractions, tensions, surprises, absences, persistent pulls and questions, each with why_operationally_relevant and resolvable evidence refs. One bounded LLM call per run (retry at most once); a repeat with the same cycle_id replays the recorded run without calling the model; a failure is recorded as a failed run with no trace. The trace never contains journal/reflection text and never carries a shared scope. Requires FOCUSED_IMAGINATION; an untrusted caller may only run its own mission; trusted callers may name user_id.',
    inputSchema: zodToJsonSchema(runFocusedInput) as Record<string, unknown>,
  },
  {
    name: 'get_salience_trace',
    description:
      'Read the caller\'s own salience traces (newest first), by trace_id or for a mission, with the run-ledger summary of the run that produced each one (status, model, timings, counts, unresolved-evidence and clamped-value counts). Caller-pinned: an untrusted caller only ever reads traces written under its own identity, never another identity\'s. Requires FOCUSED_IMAGINATION.',
    inputSchema: zodToJsonSchema(getSalienceTraceInput) as Record<string, unknown>,
  },
];

export const FOCUSED_TOOL_NAMES = FOCUSED_TOOL_DEFS.map((t) => t.name);

function text(message: string): TextContent[] {
  return [{ type: 'text', text: message }];
}

/**
 * Wrong-typed arguments are a caller error, not a crash. The mission-cognition
 * handlers report one as a readable `❌` line instead of letting a raw ZodError
 * escape to the outer catch — whose message is the serialized issue array
 * (`[{"code":"invalid_type","expected":"string","received":"number",…}]`), which
 * names no tool and is unreadable where operators actually see it. Returns null
 * when the failure is not a validation failure, so the caller rethrows it and
 * the real error surfaces unchanged.
 */
function invalidArguments(tool: string, error: unknown): TextContent[] | null {
  if (!(error instanceof z.ZodError)) return null;
  const detail = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return text(`❌ Invalid arguments for ${tool} — ${detail}`);
}

/**
 * Identity resolution — the same rule as `resolveUserId` in mcp-server.ts:
 * a trusted caller may name a user; an untrusted caller is ALWAYS pinned to
 * its own identity (the IDOR boundary).
 */
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

function summarizeResult(result: FocusedConsolidationResult): string {
  if (result.status === 'failed') {
    const lines = [
      `❌ Focused consolidation FAILED — no trace written.`,
      `**Run:** \`${result.run_id}\` (cycle \`${result.cycle_id}\`, status \`failed\`)`,
      `**Error:** ${result.error ?? 'unknown'}`,
      `**Model calls:** ${result.llm_calls} · **Mission:** ${result.mission_id} v${result.mission_version}`,
    ];
    if (result.orphan_trace_id) {
      lines.push(
        `⚠️ **Orphan trace:** \`${result.orphan_trace_id}\` was written but its run row could not be completed and the rollback failed — it has no completing run and is named on the run row as \`orphan_trace_id\`.`,
      );
    }
    lines.push('Use a NEW cycle_id to retry the same mission.');
    return lines.join('\n');
  }
  if (result.status === 'in_progress') {
    return `⏳ Focused consolidation already in progress for cycle \`${result.cycle_id}\` (run \`${result.run_id}\`). No second run started.`;
  }
  const trace = result.trace;
  const lines: string[] = [];
  lines.push(
    `${result.reused ? '♻️ Replayed recorded run (no model call)' : '✅ Focused consolidation complete'} — trace \`${result.trace_id}\``,
  );
  lines.push(
    `**Mission:** ${result.mission_id} v${result.mission_version} · **Cycle:** ${result.cycle_id} · **Trigger:** ${trace?.trigger ?? 'manual'}`,
  );
  lines.push(
    `**Signals:** ${result.signal_count} · **low confidence:** ${result.low_confidence_count} · **clamped/coerced:** ${result.clamped_values} (coerced: ${result.coerced_values}) · **truncated fields:** ${result.truncated_fields} · **unresolved evidence:** ${result.unresolved_evidence_count} signal(s) / ${result.unresolved_ref_count} ref(s)`,
  );
  lines.push(
    `**Model:** ${result.model} · **calls:** ${result.llm_calls} · **tokens:** ${result.input_tokens} in / ${result.output_tokens} out · **duration:** ${result.duration_ms}ms`,
  );
  lines.push(`**problem_state_digest:** \`${result.problem_state_digest}\``);
  if (result.warning) lines.push(`⚠️ **Warning:** ${result.warning}`);
  if (trace) {
    for (const signal of trace.signals) {
      const flags = [signal.low_confidence ? 'low_confidence' : null, signal.unresolved_evidence ? 'unresolved_evidence' : null]
        .filter(Boolean)
        .join(',');
      lines.push(
        `- [${signal.kind}] i=${signal.intensity.toFixed(2)} c=${signal.confidence.toFixed(2)} v=${signal.valence.toFixed(2)}${flags ? ` (${flags})` : ''} ${signal.statement}\n    why: ${signal.why_operationally_relevant}\n    evidence: ${signal.evidence_refs.join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}

function renderTrace(trace: SalienceTrace, runLine: string | null): string {
  const lines = [`\`\`\`json\n${JSON.stringify(trace, null, 2)}\n\`\`\``];
  if (runLine) lines.push(runLine);
  lines.push(
    `_Private: raw_reflections_included=${trace.privacy.raw_reflections_included}, shared=${trace.privacy.shared}; evidence checked against [${trace.evidence.resolvable_collections.join(', ')}]._`,
  );
  return lines.join('\n');
}

async function handleRunFocusedConsolidation(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof runFocusedInput>;
  try {
    input = runFocusedInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments('run_focused_consolidation', error);
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
    return text(`❌ Not authorized: mission ${input.mission_id} belongs to another identity. An untrusted caller may only run its own mission.`);
  }

  const userId = resolveScopedUserId(caller, input.user_id);
  const service = new FocusedConsolidationService(db);
  try {
    const result = await service.run({
      userId,
      missionId: input.mission_id,
      cycleId: input.cycle_id,
      trigger: input.trigger,
      actorId: caller.user_id,
    });
    return text(summarizeResult(result));
  } catch (error) {
    if (error instanceof FocusedConsolidationError) {
      return text(`❌ ${error.message} (${error.code})`);
    }
    // Fail loudly: an unexpected failure is reported with its message; the run
    // ledger (if a run was claimed) already carries the failed row.
    return text(`❌ Focused consolidation error: ${String((error as Error)?.message ?? error)}`);
  }
}

async function handleGetSalienceTrace(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof getSalienceTraceInput>;
  try {
    input = getSalienceTraceInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments('get_salience_trace', error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');

  if (input.mission_id && !(await canViewMission(input.mission_id, caller))) {
    return text(`❌ Not authorized for mission ${input.mission_id}.`);
  }

  const userId = resolveScopedUserId(caller, input.user_id);
  const service = new FocusedConsolidationService(db);
  const traces = await service.getTraces(userId, {
    traceId: input.trace_id,
    missionId: input.mission_id,
    limit: input.limit,
  });
  if (traces.length === 0) {
    return text(input.trace_id ? `❌ No salience trace found: ${input.trace_id}` : 'No salience traces recorded for you.');
  }

  const runs = new Map<string, string>();
  for (const trace of traces) {
    if (!runs.has(trace.mission_id)) {
      const missionRuns = await service.getRuns(trace.user_id, trace.mission_id, 5);
      for (const run of missionRuns) {
        runs.set(
          run.run_id,
          `Run \`${run.run_id}\`: status=${run.status} model=${run.model} calls=${run.llm_calls} tokens=${run.input_tokens}/${run.output_tokens} duration=${run.duration_ms}ms signals=${run.output_counts?.signals ?? 0} unresolved=${run.unresolved_evidence_count} clamped=${run.clamped_values} coerced=${run.coerced_values ?? 0} truncated=${run.truncated_fields ?? 0}${run.orphan_trace_id ? ` orphan_trace_id=${run.orphan_trace_id}` : ''}${run.error ? ` error=${run.error}` : ''}`,
        );
      }
    }
  }

  const blocks = traces.map((trace) => renderTrace(trace, runs.get(trace.run_id) ?? null));
  return text(blocks.join('\n\n---\n\n'));
}

/**
 * Dispatch gate for the focused-consolidation tools. With FOCUSED_IMAGINATION
 * off, the tools are indistinguishable from not existing: a plain
 * `Unknown tool` error, no writes, no service call and no model call.
 */
export async function dispatchFocusedTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (!focusedImaginationEnabled()) {
    throw new Error(`Unknown tool: ${name}`);
  }
  switch (name) {
    case 'run_focused_consolidation':
      return handleRunFocusedConsolidation(args, caller);
    case 'get_salience_trace':
      return handleGetSalienceTrace(args, caller);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
