/**
 * ITER-9 (Phase 7) — the MCP surface of the imagination observability layer.
 *
 * Two tools, both behind `FOCUSED_IMAGINATION` (default OFF), the same family
 * flag every other ITER-5/6/7 tool uses:
 *
 *   - `get_imagination_metrics` (READ, caller-pinned) — the §7.3 metric set for
 *     one identity: every number carries its basis (window, n, sources) and a
 *     metric below its documented minimum reports `insufficient_data` instead
 *     of a rate. An untrusted caller is pinned to its own identity; naming
 *     another identity is honoured only for a trusted caller.
 *   - `record_experiment_observation` (WRITE, trusted + flag on) — the ONE
 *     write this iteration adds. It records an observation against a registered
 *     experiment (or registers one first, from a `register` block), it is
 *     caller-owned (the row's user_id is the caller's own — there is no
 *     parameter that could point it elsewhere), its shape is closed, its `note`
 *     is bounded by `EXPERIMENT_NOTE_MAX_LENGTH` (the service refuses a longer
 *     one by name) and it is idempotent per `{experiment, arm, metric,
 *     checkpoint}`.
 *
 * With the flag off, neither tool is registered AND the dispatch re-check
 * throws the plain `Unknown tool` error, so the surface is indistinguishable
 * from not existing — the standard this repo applies to every flag-gated
 * family.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { get_database } from '../../database/connection.js';
import { focusedImaginationEnabled } from './focused-consolidation-service.js';
import { computeImaginationMetrics, metricsWindowDays } from './imagination-metrics-service.js';
import { EXPERIMENT_NOTE_MAX_LENGTH, recordExperimentObservation, registerExperiment } from './imagination-experiments.js';

const metricsInput = z.object({
  user_id: z.string().optional(),
  mission_id: z.string().optional(),
  window_days: z.number().int().min(1).max(365).optional(),
});

const armInput = z.object({
  label: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

const registerInput = z.object({
  name: z.string().min(1),
  hypothesis: z.string().min(1),
  checkpoints: z.array(z.string().min(1)).min(1),
  arms: z.array(armInput).min(1),
});

const observationInput = z
  .object({
    experiment_id: z.string().min(1).optional(),
    arm: z.string().min(1),
    metric: z.string().min(1).max(120),
    value: z.number(),
    n: z.number().int().min(1),
    checkpoint: z.string().min(1).optional(),
    // The bound is the SERVICE's own constant (ITER-10 F2): the schema caps
    // with the same number `recordExperimentObservation` refuses on, so the two
    // cannot drift apart.
    note: z.string().max(EXPERIMENT_NOTE_MAX_LENGTH).optional(),
    // Register-on-first-write: the ONLY way this surface reaches
    // `registerExperiment` (there is no separate registration tool).
    register: registerInput.optional(),
  })
  .strict();

export const IMAGINATION_OBSERVABILITY_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: 'get_imagination_metrics',
    description:
      'Read the imagination metrics for ONE identity: useful novelty rate, archive coverage gain, idea survival (declared as a proxy), time to next viable direction, false novelty, agent divergence (plus the same-mode control when one was recorded), privacy leakage, cost of novelty and personality stability. Every metric carries its basis — the measurement window, the n behind it, the collections it was read from and the documented minimum sample — and a metric below that minimum reports insufficient_data rather than a fabricated rate (cost of novelty with a zero denominator is insufficient_data, not 0). Privacy leakage is an audit count with its basis: the shared-scope artefacts are read back and checked against the private keys the baton allow-list forbids and against markers lifted from this identity\'s own private stores. Caller-pinned: an untrusted caller always reads its own identity; a trusted caller may name one. Requires FOCUSED_IMAGINATION; nothing is written and no model call is made.',
    inputSchema: zodToJsonSchema(metricsInput) as Record<string, unknown>,
  },
  {
    name: 'record_experiment_observation',
    description:
      'Record one observation for a registered experiment (the ONE gated write of the observability layer). Trusted callers only, and only with FOCUSED_IMAGINATION on — the write is CALLER-OWNED (the row\'s user_id is the caller\'s own identity; there is no user_id parameter at all), its shape is CLOSED (an unknown key is refused by name) and it is IDEMPOTENT per {experiment, arm, metric, checkpoint}: repeating the same key updates the row in place, and repeating the same key with the same numbers writes nothing at all and says so. Supply experiment_id for an existing experiment, or a `register` block (name, hypothesis, checkpoints, arms) to register one first — registration is idempotent by a derived id and returns the same experiment_id for the same content. The comparison it feeds applies the brief\'s named target ("≥30% better useful novelty", overridable per call) and returns improved / not_improved / insufficient_data with the n and the threshold it used. The `note` is capped at 2000 characters — the same bound the service enforces, refused by name as note_too_long.',
    inputSchema: zodToJsonSchema(observationInput) as Record<string, unknown>,
  },
];

export const IMAGINATION_OBSERVABILITY_TOOL_NAMES = IMAGINATION_OBSERVABILITY_TOOL_DEFS.map((tool) => tool.name);

const METRICS_TOOL = 'get_imagination_metrics';
const OBSERVATION_TOOL = 'record_experiment_observation';

function text(message: string): TextContent[] {
  return [{ type: 'text', text: message }];
}

function invalidArguments(tool: string, error: unknown): TextContent[] | null {
  if (!(error instanceof z.ZodError)) return null;
  const detail = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
  return text(`❌ Invalid arguments for ${tool} — ${detail}`);
}

/**
 * The identity a read is measured for. An untrusted caller is PINNED to itself
 * — a supplied user_id is ignored, never honoured — and only a trusted caller
 * may name another identity.
 */
export function resolveMetricsUserId(caller: CallerIdentity, requested?: unknown): string {
  const provided = typeof requested === 'string' && requested.trim().length > 0 ? requested.trim() : undefined;
  return caller.trusted && provided ? provided : caller.user_id;
}

function metricLine(label: string, metric: { status: string; value: any; basis: any; reason: string | null }): string {
  const basis = metric.basis ?? {};
  const suffix =
    metric.status === 'ok'
      ? `n=${basis.n} · window ${basis.window?.days ?? '—'}d · minimum ${basis.minimum ?? '—'}`
      : `INSUFFICIENT DATA — ${metric.reason}`;
  return `- **${label}:** ${metric.status === 'ok' ? JSON.stringify(metric.value) : 'insufficient_data'} (${suffix})`;
}

async function handleGetMetrics(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof metricsInput>;
  try {
    input = metricsInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(METRICS_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');

  const userId = resolveMetricsUserId(caller, input.user_id);
  const metrics = await computeImaginationMetrics(db, {
    userId,
    missionId: input.mission_id ?? null,
    ...(input.window_days ? { windowDays: input.window_days } : {}),
  });

  const lines: string[] = [];
  lines.push(`## Imagination metrics — identity \`${userId}\`${input.mission_id ? ` · mission \`${input.mission_id}\`` : ''}`);
  lines.push(
    `**Window:** ${metrics.window.from} → ${metrics.window.to} (${metrics.window.days} day(s), default ${metricsWindowDays()}) · **minimum samples:** outcomes ${metrics.minimum_samples.outcomes}, generated ${metrics.minimum_samples.generated}, cycles ${metrics.minimum_samples.cycles}, agents ${metrics.minimum_samples.agents}`,
  );
  lines.push('');
  lines.push(metricLine('Useful novelty rate', metrics.useful_novelty_rate));
  lines.push(metricLine('Archive coverage gain', metrics.archive_coverage_gain));
  lines.push(metricLine('Idea survival (proxy)', metrics.idea_survival));
  lines.push(metricLine('Time to next viable direction', metrics.time_to_next_viable_direction));
  lines.push(metricLine('False novelty', metrics.false_novelty));
  lines.push(metricLine('Agent divergence', metrics.agent_divergence));
  lines.push(metricLine('Agent divergence (same-mode control)', metrics.agent_divergence_same_mode_control));
  lines.push(metricLine('Cost of novelty', metrics.cost_of_novelty));
  lines.push('');
  lines.push(
    `- **Privacy leakage (audit):** ${metrics.privacy_leakage.flagged} flag(s) across ${metrics.privacy_leakage.shared_artefacts_scanned} shared artefact(s), ${metrics.privacy_leakage.markers_checked} marker(s) checked — basis: ${metrics.privacy_leakage.basis.measurement}`,
  );
  lines.push(
    `- **Personality stability:** ${metrics.personality_stability.violations} violation(s) across ${metrics.personality_stability.envelopes_checked} envelope(s) and ${metrics.personality_stability.assignments_checked} assignment(s) — basis: ${metrics.personality_stability.basis.measurement}`,
  );
  lines.push('');
  lines.push('**Bases** (what each metric was read from):');
  for (const [key, metric] of Object.entries(metrics)) {
    const candidate = metric as { basis?: { sources?: string[]; measurement?: string } };
    if (!candidate?.basis?.sources) continue;
    lines.push(`- \`${key}\`: ${candidate.basis.sources.join(', ')} — ${candidate.basis.measurement}`);
  }
  lines.push('');
  lines.push(`_${metrics.privacy.basis}_`);
  lines.push('');
  lines.push('_Read-only: no cycle ran, nothing was promoted and no mode changed._');
  return text(lines.join('\n'));
}

async function handleRecordObservation(args: unknown, caller: CallerIdentity): Promise<TextContent[]> {
  let input: z.infer<typeof observationInput>;
  try {
    input = observationInput.parse(args);
  } catch (error) {
    const invalid = invalidArguments(OBSERVATION_TOOL, error);
    if (!invalid) throw error;
    return invalid;
  }
  if (!focusedImaginationEnabled()) {
    return text('❌ FOCUSED_IMAGINATION is off — the experiment write is disabled (no back door).');
  }
  if (!caller.trusted) {
    return text('❌ Recording an experiment observation requires a trusted caller (operator).');
  }
  const db = get_database();
  if (!db) return text('⚠️ MongoDB disconnected.');

  let experimentId = input.experiment_id ?? null;
  if (!experimentId) {
    if (!input.register) {
      return text('❌ Supply experiment_id, or a `register` block to register the experiment first.');
    }
    const registered = await registerExperiment(db, {
      userId: caller.user_id,
      name: input.register.name,
      hypothesis: input.register.hypothesis,
      checkpoints: input.register.checkpoints,
      arms: input.register.arms.map((arm) => ({ label: arm.label, config: arm.config ?? {} })),
    });
    experimentId = registered.experiment.experiment_id;
  }

  const result = await recordExperimentObservation(
    db,
    {
      experiment_id: experimentId,
      arm: input.arm,
      metric: input.metric,
      value: input.value,
      n: input.n,
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
      ...(input.note ? { note: input.note } : {}),
    },
    caller,
  );
  if (!result.recorded) return text(`❌ ${result.reason}`);
  const observation = result.observation!;
  return text(
    [
      result.unchanged
        ? `♻️ Unchanged — ${result.reason}`
        : result.updated
          ? `♻️ Updated in place — ${result.reason}`
          : `✅ Observation recorded — ${result.reason}`,
      `**Experiment:** \`${observation.experiment_id}\` · **arm:** \`${observation.arm}\` · **metric:** \`${observation.metric}\` · **checkpoint:** \`${observation.checkpoint}\``,
      `**Value:** ${observation.value} · **n:** ${observation.n}${observation.note ? ` · note: ${observation.note}` : ''}`,
      `**Key:** \`${observation.observation_key}\` (idempotent per {experiment, arm, metric, checkpoint})`,
      '',
      '_Caller-owned: the row belongs to the calling identity. Compare with the dashboard\'s /imagination/experiments/compare view._',
    ].join('\n'),
  );
}

/**
 * Dispatch gate for the observability tools. With FOCUSED_IMAGINATION off the
 * tools are indistinguishable from not existing: a plain `Unknown tool` error,
 * no writes, no service call and no model call.
 */
export async function dispatchImaginationObservabilityTool(
  name: string,
  args: unknown,
  caller: CallerIdentity,
): Promise<TextContent[]> {
  if (!focusedImaginationEnabled()) {
    throw new Error(`Unknown tool: ${name}`);
  }
  switch (name) {
    case METRICS_TOOL:
      return handleGetMetrics(args, caller);
    case OBSERVATION_TOOL:
      return handleRecordObservation(args, caller);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
