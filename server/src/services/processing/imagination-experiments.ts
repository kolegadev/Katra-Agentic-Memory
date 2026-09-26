/**
 * ITER-9 (Phase 7) — experiment records and the ONE gated write.
 *
 * Contract: CONTRACT-iter9-observability.md §B.
 *
 *   - `registerExperiment({ userId, name, hypothesis, checkpoints, arms })`
 *     records the brief's §7.4 shape (control arms A/B, treatment arms C/D) as
 *     DATA: an arm is a label plus a configuration object, and a checkpoint is
 *     a name — nothing about the comparison is compiled into code.
 *   - `recordExperimentObservation(db, args, caller)` is the ONLY write path
 *     this iteration adds to the dashboard/MCP surface. It is gated on
 *     `FOCUSED_IMAGINATION` AND a trusted caller, CALLER-OWNED (the row's
 *     `user_id` is the caller's own identity, never a supplied one), CLOSED (an
 *     unknown key is refused by name), BOUNDED (a `note` over
 *     `EXPERIMENT_NOTE_MAX_LENGTH` is refused by name as `note_too_long` — the
 *     same constant the MCP schema caps with) and IDEMPOTENT per
 *     `{experiment, arm, metric, checkpoint}`: repeating the same key updates
 *     the row, repeating the same key AND the same numbers writes nothing at
 *     all and says so.
 *   - `compareExperiment(userId, experimentId)` aggregates each arm's
 *     observations and returns, per metric, the baseline and treatment means,
 *     the delta, the direction, the target it applied (the brief's "≥30% better
 *     useful novelty", named and overridable) and a verdict of `improved` /
 *     `not_improved` / `insufficient_data` — with the `n` behind each side and
 *     the minimum sample size.
 *
 * Both row kinds live in one additive collection (`imagination_experiments`),
 * discriminated by `kind`, so a rollback is droppable in one step. Nothing here
 * reads a journal, a reflection or another identity's row: an observation is
 * looked up and written against `{user_id, experiment_id}` only.
 */
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { focusedImaginationEnabled } from './focused-consolidation-service.js';

export const IMAGINATION_EXPERIMENTS_COLLECTION = 'imagination_experiments';

export const EXPERIMENTS_SCOPE_INDEX = 'impexp_user_kind';
export const EXPERIMENTS_ID_INDEX = 'impexp_experiment';
export const OBSERVATIONS_UNIQUE_INDEX = 'impexp_observation_unique';

/** The kind tag on a registered experiment row. */
export const EXPERIMENT_KIND = 'experiment';
/** The kind tag on an observation row. */
export const OBSERVATION_KIND = 'observation';

/** Every key an observation may carry — an extra key is refused by name. */
export const OBSERVATION_KEYS = [
  'experiment_id',
  'arm',
  'metric',
  'value',
  'n',
  'checkpoint',
  'note',
] as const;

/** Every key `registerExperiment` accepts. */
export const EXPERIMENT_KEYS = ['user_id', 'name', 'hypothesis', 'checkpoints', 'arms'] as const;

/**
 * The ONE note bound of the observability surface (ITER-10 F2). The MCP zod
 * schema for `record_experiment_observation` caps `note` with THIS constant and
 * the service refuses anything longer — one number, two enforcement points, so
 * the surface and the service cannot drift apart. The service is the authority:
 * a caller that reaches the service directly (the REST route, a service call)
 * gets the same refusal by name (`note_too_long`).
 */
export const EXPERIMENT_NOTE_MAX_LENGTH = 2000;

export interface ExperimentArm {
  label: string;
  config: Record<string, unknown>;
}

export interface ExperimentRecord {
  schema_version: '1.0';
  kind: typeof EXPERIMENT_KIND;
  experiment_id: string;
  user_id: string;
  name: string;
  hypothesis: string;
  checkpoints: string[];
  arms: ExperimentArm[];
  created_at: string;
}

export interface ObservationRecord {
  schema_version: '1.0';
  kind: typeof OBSERVATION_KIND;
  observation_id: string;
  observation_key: string;
  user_id: string;
  experiment_id: string;
  arm: string;
  metric: string;
  checkpoint: string;
  value: number;
  n: number;
  note: string | null;
  recorded_at: string;
  updated_at: string;
}

export interface RegisterExperimentArgs {
  userId: string;
  name: string;
  hypothesis: string;
  checkpoints: readonly string[];
  arms: readonly ExperimentArm[];
  at?: string;
}

/**
 * The write's arguments, in the WIRE shape (snake_case): the closed-shape check,
 * the refusal messages and the HTTP/MCP bodies all speak this spelling, so a
 * caller cannot smuggle a differently-spelled key past the check.
 */
export interface RecordObservationArgs {
  experiment_id: string;
  arm: string;
  metric: string;
  value: number;
  n: number;
  checkpoint?: string;
  note?: string;
}

export type ObservationRefusalCode =
  | 'flag_off'
  | 'untrusted_caller'
  | 'invalid_args'
  | 'note_too_long'
  | 'experiment_not_found'
  | 'unknown_arm'
  | 'unknown_checkpoint';

export interface RecordObservationResult {
  recorded: boolean;
  /** True when an existing row for this key was rewritten with new numbers. */
  updated: boolean;
  /** True when the row already held exactly these numbers — nothing written. */
  unchanged: boolean;
  code: ObservationRefusalCode | null;
  reason: string;
  observation: ObservationRecord | null;
  experiment_id: string | null;
}

// ── Improvement targets (named, and overridable per call) ───────────────────

export interface ImprovementTarget {
  /** Which way is better for this metric. */
  direction: 'higher' | 'lower';
  /** The relative gain the treatment must reach to count as `improved`. */
  min_relative_gain: number;
  /** The minimum `n` BOTH arms need before a verdict is formed. */
  min_samples: number;
}

/**
 * The brief's §7.4 gate — "≥30% better useful novelty" — named here so a
 * comparison can state which target it applied. `false_novelty_rate` and
 * `cost_of_novelty` are the two metrics where LOWER is better, so their
 * direction is inverted rather than silently compared the wrong way round.
 */
export const EXPERIMENT_IMPROVEMENT_TARGETS: Record<string, ImprovementTarget> = {
  // The names the metrics view reports (the window-over-window comparison uses
  // THIS table, so a "lower is better" metric is never compared the wrong way
  // round: a faster plateau response and a smaller false-novelty share are
  // IMPROVEMENTS, whatever their sign).
  useful_novelty_rate: { direction: 'higher', min_relative_gain: 0.3, min_samples: 3 },
  false_novelty: { direction: 'lower', min_relative_gain: 0.3, min_samples: 5 },
  cost_of_novelty: { direction: 'lower', min_relative_gain: 0.3, min_samples: 1 },
  idea_survival: { direction: 'higher', min_relative_gain: 0.1, min_samples: 3 },
  archive_coverage_gain: { direction: 'higher', min_relative_gain: 0.1, min_samples: 1 },
  time_to_next_viable_direction: { direction: 'lower', min_relative_gain: 0.2, min_samples: 1 },
  agent_divergence: { direction: 'higher', min_relative_gain: 0.1, min_samples: 1 },
  // The spellings an experiment caller may use for the same measurements.
  false_novelty_rate: { direction: 'lower', min_relative_gain: 0.3, min_samples: 3 },
  idea_survival_rate: { direction: 'higher', min_relative_gain: 0.1, min_samples: 3 },
  time_to_next_viable_direction_ms: { direction: 'lower', min_relative_gain: 0.2, min_samples: 1 },
};

/** Used for a metric the table does not name. */
export const DEFAULT_IMPROVEMENT_TARGET: ImprovementTarget = {
  direction: 'higher',
  min_relative_gain: 0.3,
  min_samples: 3,
};

// ── Indexes ─────────────────────────────────────────────────────────────────

const ensured = new WeakMap<Db, Promise<void>>();

/**
 * The indexes this feature owns. The observation key is unique (that is what
 * makes the write idempotent per `{experiment, arm, metric, checkpoint}`); the
 * experiment id is indexed but NOT uniquely constrained, because observation
 * rows carry it too.
 */
export function ensureExperimentIndexes(db: Db): Promise<void> {
  let pending = ensured.get(db);
  if (!pending) {
    pending = (async () => {
      const collection = () => db.collection(IMAGINATION_EXPERIMENTS_COLLECTION);
      await Promise.all([
        collection().createIndex({ observation_key: 1 }, { unique: true, name: OBSERVATIONS_UNIQUE_INDEX }),
        collection().createIndex({ user_id: 1, kind: 1 }, { name: EXPERIMENTS_SCOPE_INDEX }),
        collection().createIndex({ user_id: 1, experiment_id: 1, metric: 1 }, { name: EXPERIMENTS_ID_INDEX }),
      ]);
    })().catch((error) => {
      ensured.delete(db);
      throw error;
    });
    ensured.set(db, pending);
  }
  return pending;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The DERIVED experiment id: the same registration derives the same id. */
export function experimentIdFor(args: {
  userId: string;
  name: string;
  hypothesis: string;
  checkpoints: readonly string[];
  arms: readonly ExperimentArm[];
}): string {
  const payload = JSON.stringify({
    name: args.name,
    hypothesis: args.hypothesis,
    checkpoints: [...args.checkpoints],
    arms: args.arms.map((arm) => ({ label: arm.label, config: arm.config })),
  });
  return `impexp_${digest(`experiment:${args.userId}:${payload}`).slice(0, 32)}`;
}

/** The DERIVED observation key: the same key derives the same id. */
export function observationKeyFor(args: {
  userId: string;
  experimentId: string;
  arm: string;
  metric: string;
  checkpoint: string;
}): string {
  return `impexp_obs_${digest(
    `observation:${args.userId}:${args.experimentId}:${args.arm}:${args.metric}:${args.checkpoint}`,
  ).slice(0, 32)}`;
}

/** Closed-shape check: any key outside `allowed` is named back. */
export function unexpectedKeys(row: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(row).filter((key) => !allowed.includes(key));
}

// ── Registration (service API — reachable only through the gated write) ─────

export interface RegisterExperimentResult {
  experiment: ExperimentRecord;
  reused: boolean;
}

/**
 * Register an experiment. IDEMPOTENT by the derived id: registering the same
 * name, hypothesis, checkpoints and arms twice returns the stored row with
 * `reused: true` and writes nothing.
 *
 * This is a service API, not a surface: it is deliberately NOT mounted on a
 * route or an MCP tool of its own — the only way the dashboard/MCP surface
 * reaches it is through `recordExperimentObservation`, which is gated.
 */
export async function registerExperiment(
  db: Db,
  args: RegisterExperimentArgs,
): Promise<RegisterExperimentResult> {
  const userId = nonEmpty(args.userId);
  const name = nonEmpty(args.name);
  const hypothesis = nonEmpty(args.hypothesis);
  if (!userId) throw new Error('registerExperiment: userId is required');
  if (!name) throw new Error('registerExperiment: name is required');
  if (!hypothesis) throw new Error('registerExperiment: hypothesis is required');

  const checkpoints = (Array.isArray(args.checkpoints) ? args.checkpoints : [])
    .map((checkpoint) => nonEmpty(checkpoint))
    .filter((checkpoint): checkpoint is string => checkpoint !== null);
  if (checkpoints.length === 0) throw new Error('registerExperiment: at least one checkpoint is required');

  const arms = (Array.isArray(args.arms) ? args.arms : []).map((arm) => ({
    label: nonEmpty(arm?.label) ?? '',
    config: (arm?.config && typeof arm.config === 'object' ? arm.config : {}) as Record<string, unknown>,
  }));
  if (arms.length === 0) throw new Error('registerExperiment: at least one arm is required');
  if (arms.some((arm) => arm.label.length === 0)) throw new Error('registerExperiment: every arm needs a label');
  if (new Set(arms.map((arm) => arm.label)).size !== arms.length) {
    throw new Error('registerExperiment: arm labels must be unique');
  }

  await ensureExperimentIndexes(db);
  const collection = db.collection<ExperimentRecord>(IMAGINATION_EXPERIMENTS_COLLECTION);
  const experiment_id = experimentIdFor({ userId, name, hypothesis, checkpoints, arms });
  const existing = (await collection.findOne(
    { experiment_id, kind: EXPERIMENT_KIND },
    { projection: { _id: 0 } },
  )) as unknown as ExperimentRecord | null;
  if (existing) return { experiment: existing, reused: true };

  const row: ExperimentRecord = {
    schema_version: '1.0',
    kind: EXPERIMENT_KIND,
    experiment_id,
    user_id: userId,
    name,
    hypothesis,
    checkpoints,
    arms,
    created_at: nonEmpty(args.at) ?? new Date().toISOString(),
  };
  await collection.insertOne(row as unknown as ExperimentRecord);
  return { experiment: row, reused: false };
}

export async function getExperiment(db: Db, userId: string, experimentId: string): Promise<ExperimentRecord | null> {
  const row = (await db
    .collection(IMAGINATION_EXPERIMENTS_COLLECTION)
    .findOne({ user_id: userId, experiment_id: experimentId, kind: EXPERIMENT_KIND }, { projection: { _id: 0 } })) as
    | unknown
    | null;
  return (row as ExperimentRecord | null) ?? null;
}

export async function listExperiments(db: Db, userId: string): Promise<ExperimentRecord[]> {
  const rows = (await db
    .collection(IMAGINATION_EXPERIMENTS_COLLECTION)
    .find({ user_id: userId, kind: EXPERIMENT_KIND }, { projection: { _id: 0 } })
    .sort({ created_at: -1, experiment_id: 1 })
    .toArray()) as unknown as ExperimentRecord[];
  return rows;
}

export async function listObservations(db: Db, userId: string, experimentId: string): Promise<ObservationRecord[]> {
  const rows = (await db
    .collection(IMAGINATION_EXPERIMENTS_COLLECTION)
    .find({ user_id: userId, experiment_id: experimentId, kind: OBSERVATION_KIND }, { projection: { _id: 0 } })
    .sort({ metric: 1, arm: 1, checkpoint: 1 })
    .toArray()) as unknown as ObservationRecord[];
  return rows;
}

// ── The ONE gated write ─────────────────────────────────────────────────────

/**
 * Record one observation. Everything that makes this safe is checked BEFORE a
 * row is touched: the family flag, the caller's trust, the closed shape, the
 * experiment's existence and ownership, the arm and the checkpoint.
 *
 * The row's `user_id` is `caller.user_id` — there is no parameter that could
 * point it at another identity.
 */
export async function recordExperimentObservation(
  db: Db,
  args: RecordObservationArgs,
  caller: CallerIdentity,
): Promise<RecordObservationResult> {
  const refuse = (code: ObservationRefusalCode, reason: string): RecordObservationResult => ({
    recorded: false,
    updated: false,
    unchanged: false,
    code,
    reason,
    observation: null,
    experiment_id: null,
  });

  if (!focusedImaginationEnabled()) {
    return refuse('flag_off', 'FOCUSED_IMAGINATION is off — the experiment write is disabled (no back door)');
  }
  if (!caller.trusted) {
    return refuse('untrusted_caller', 'recording an experiment observation requires a trusted caller (operator)');
  }

  const raw = (args ?? {}) as unknown as Record<string, unknown>;
  const unexpected = unexpectedKeys(raw, OBSERVATION_KEYS);
  if (unexpected.length > 0) {
    return refuse('invalid_args', `unexpected key(s) on an observation: ${unexpected.join(', ')}`);
  }

  const experimentId = nonEmpty(raw.experiment_id);
  const arm = nonEmpty(raw.arm);
  const metric = nonEmpty(raw.metric);
  const value = finiteNumber(raw.value);
  const n = finiteNumber(raw.n);
  if (!experimentId) return refuse('invalid_args', 'experiment_id is required');
  if (!arm) return refuse('invalid_args', 'arm is required');
  if (!metric) return refuse('invalid_args', 'metric is required');
  if (value === null) return refuse('invalid_args', 'value must be a finite number');
  if (n === null || n < 1) return refuse('invalid_args', 'n must be a positive integer');
  // The note bound is enforced HERE, not only on the MCP surface: a note over
  // the shared limit is refused BY NAME before a row (or a lookup) is touched.
  const rawNote = typeof raw.note === 'string' ? raw.note : null;
  if (rawNote !== null && rawNote.length > EXPERIMENT_NOTE_MAX_LENGTH) {
    return refuse(
      'note_too_long',
      `note is ${rawNote.length} characters — the limit is ${EXPERIMENT_NOTE_MAX_LENGTH} (EXPERIMENT_NOTE_MAX_LENGTH, shared with the MCP schema)`,
    );
  }
  const note = nonEmpty(rawNote);

  await ensureExperimentIndexes(db);
  const experiment = await getExperiment(db, caller.user_id, experimentId);
  if (!experiment) {
    return refuse('experiment_not_found', `no experiment ${experimentId} is registered for this caller`);
  }
  if (!experiment.arms.some((candidate) => candidate.label === arm)) {
    return refuse('unknown_arm', `arm ${arm} is not one of this experiment's arms (${experiment.arms.map((a) => a.label).join(', ')})`);
  }
  const requestedCheckpoint = nonEmpty(raw.checkpoint);
  const checkpoint = requestedCheckpoint ?? experiment.checkpoints[0];
  if (!experiment.checkpoints.includes(checkpoint)) {
    return refuse(
      'unknown_checkpoint',
      `checkpoint ${checkpoint} is not one of this experiment's checkpoints (${experiment.checkpoints.join(', ')})`,
    );
  }

  const collection = db.collection<ObservationRecord>(IMAGINATION_EXPERIMENTS_COLLECTION);
  const observation_key = observationKeyFor({ userId: caller.user_id, experimentId, arm, metric, checkpoint });
  const existing = (await collection.findOne({ observation_key }, { projection: { _id: 0 } })) as unknown as
    | ObservationRecord
    | null;

  if (existing && existing.value === value && existing.n === n && (existing.note ?? null) === (note ?? null)) {
    return {
      recorded: true,
      updated: false,
      unchanged: true,
      code: null,
      reason: 'this {experiment, arm, metric, checkpoint} already holds exactly these numbers — nothing written',
      observation: existing,
      experiment_id: experimentId,
    };
  }

  const at = new Date().toISOString();
  const row: ObservationRecord = {
    schema_version: '1.0',
    kind: OBSERVATION_KIND,
    observation_id: `impexp_obs_${digest(observation_key).slice(0, 24)}`,
    observation_key,
    user_id: caller.user_id,
    experiment_id: experimentId,
    arm,
    metric,
    checkpoint,
    value,
    n: Math.floor(n),
    note: note ?? null,
    recorded_at: existing?.recorded_at ?? at,
    updated_at: at,
  };
  await collection.updateOne({ observation_key }, { $set: row as unknown as Record<string, unknown> }, { upsert: true });
  return {
    recorded: true,
    updated: existing !== null,
    unchanged: false,
    code: null,
    reason: existing
      ? 'an observation for this key already existed — it was updated in place (idempotent per key)'
      : 'observation recorded',
    observation: row,
    experiment_id: experimentId,
  };
}

// ── The comparison ──────────────────────────────────────────────────────────

export interface ArmAggregate {
  arm: string;
  /** The `n`-weighted mean of this arm's observations for the metric. */
  weighted_mean: number;
  /** The total `n` behind it. */
  n: number;
  /** The stored observations that went into it (checkpoint → value). */
  checkpoints: Array<{ checkpoint: string; value: number; n: number }>;
}

export interface MetricComparison {
  metric: string;
  direction: 'higher' | 'lower';
  target: { min_relative_gain: number; min_samples: number; source: 'named-target' | 'default-target' | 'override' };
  baseline: ArmAggregate;
  treatment: ArmAggregate;
  delta: number | null;
  /** Improvement in the target's direction, relative to |baseline|. */
  relative_gain: number | null;
  verdict: 'improved' | 'not_improved' | 'insufficient_data';
  reason: string;
  n: { baseline: number; treatment: number; minimum: number };
  basis: string;
}

export interface ExperimentComparison {
  experiment_id: string;
  user_id: string;
  /** The first arm of each side (kept for a single-arm comparison's spelling). */
  baseline_arm: string;
  treatment_arm: string;
  /** Every arm pooled on each side (the brief's §7.4 A/B vs C/D shape). */
  baseline_arms: string[];
  treatment_arms: string[];
  metrics: MetricComparison[];
  verdict: 'improved' | 'not_improved' | 'insufficient_data';
  counts: { improved: number; not_improved: number; insufficient_data: number };
  basis: string;
  privacy: {
    scope: 'private';
    private_rows: number;
    shared_rows: 0;
    raw_reflections_included: false;
    basis: string;
  };
}

export interface CompareExperimentOptions {
  /** Defaults to the experiment's first arm. */
  baselineArm?: string;
  /** Defaults to the experiment's last arm. */
  treatmentArm?: string;
  /**
   * The brief's §7.4 shape is Control A/B against Treatment C/D: a side may pool
   * SEVERAL arms, and when it does the pooled rows are weighted by their own n.
   */
  baselineArms?: readonly string[];
  treatmentArms?: readonly string[];
  /** Per-metric target overrides (the named target is the default). */
  targets?: Record<string, Partial<ImprovementTarget>>;
}

/** The target a metric is judged against, with where it came from. */
export function improvementTargetFor(
  metric: string,
  override?: Partial<ImprovementTarget>,
): { target: ImprovementTarget; source: 'named-target' | 'default-target' | 'override' } {
  const named = EXPERIMENT_IMPROVEMENT_TARGETS[metric];
  return {
    target: { ...(named ?? DEFAULT_IMPROVEMENT_TARGET), ...(override ?? {}) },
    source: override ? 'override' : named ? 'named-target' : 'default-target',
  };
}

export interface MeasuredValue {
  /** The value being compared (a rate, a mean, a median — whatever the metric reports). */
  value: number | null;
  /** The sample behind it. */
  n: number;
}

export interface ValueComparison {
  direction: 'higher' | 'lower';
  target: { min_relative_gain: number; min_samples: number; source: 'named-target' | 'default-target' | 'override' };
  delta: number | null;
  relative_gain: number | null;
  verdict: 'improved' | 'not_improved' | 'insufficient_data';
  reason: string;
  n: { baseline: number; treatment: number; minimum: number };
}

/**
 * The ONE verdict rule, shared by the experiment comparison and by the metrics
 * view's window-over-window comparison, so "improved" means the same thing
 * wherever it is reported:
 *
 *   - `insufficient_data` when either side has no value, either side's `n` is
 *     below the target's `min_samples`, or the baseline is 0 (a RELATIVE gain
 *     cannot be formed from it);
 *   - `improved` when the relative gain in the metric's own direction reaches
 *     the target's `min_relative_gain`;
 *   - `not_improved` otherwise — a regression and a flat reading are both
 *     reported as not improved, never smoothed into one number.
 */
export function compareMeasuredValues(args: {
  metric: string;
  baseline: MeasuredValue | null;
  treatment: MeasuredValue | null;
  override?: Partial<ImprovementTarget>;
  baselineLabel?: string;
  treatmentLabel?: string;
}): ValueComparison {
  const { target, source } = improvementTargetFor(args.metric, args.override);
  const baselineLabel = args.baselineLabel ?? 'baseline';
  const treatmentLabel = args.treatmentLabel ?? 'treatment';
  const base = args.baseline;
  const next = args.treatment;
  const n = { baseline: base?.n ?? 0, treatment: next?.n ?? 0, minimum: target.min_samples };
  const core = { direction: target.direction, target: { ...target, source }, n };

  if (!base || !next || base.value === null || next.value === null) {
    return {
      ...core,
      delta: null,
      relative_gain: null,
      verdict: 'insufficient_data',
      reason: `${!base || base.value === null ? baselineLabel : treatmentLabel} has no measured value for ${args.metric} — no comparison can be formed`,
    };
  }
  const delta = Number((next.value - base.value).toFixed(6));
  if (n.baseline < target.min_samples || n.treatment < target.min_samples) {
    return {
      ...core,
      delta,
      relative_gain: null,
      verdict: 'insufficient_data',
      reason: `n is ${n.baseline} (${baselineLabel}) / ${n.treatment} (${treatmentLabel}), below the minimum ${target.min_samples} — no verdict is formed`,
    };
  }
  if (base.value === 0) {
    return {
      ...core,
      delta,
      relative_gain: null,
      verdict: 'insufficient_data',
      reason: `the ${baselineLabel} reads 0, so a relative gain cannot be formed from it`,
    };
  }
  const relative =
    target.direction === 'higher'
      ? (next.value - base.value) / Math.abs(base.value)
      : (base.value - next.value) / Math.abs(base.value);
  const relativeGain = Number(relative.toFixed(6));
  const improved = relativeGain >= target.min_relative_gain;
  return {
    ...core,
    delta,
    relative_gain: relativeGain,
    verdict: improved ? 'improved' : 'not_improved',
    reason: improved
      ? `${target.direction} is better and the ${relativeGain} relative gain reaches the ${target.min_relative_gain} target (n ${n.baseline}/${n.treatment})`
      : `${relativeGain} relative gain does not reach the ${target.min_relative_gain} target in the "${target.direction} is better" direction (n ${n.baseline}/${n.treatment})`,
  };
}

function aggregate(
  observations: readonly ObservationRecord[],
  arms: readonly string[],
  metric: string,
): ArmAggregate | null {
  const rows = observations.filter((row) => arms.includes(row.arm) && row.metric === metric);
  if (rows.length === 0) return null;
  const totalN = rows.reduce((sum, row) => sum + row.n, 0);
  const weighted = rows.reduce((sum, row) => sum + row.value * row.n, 0) / totalN;
  return {
    // The pooled label: one arm keeps its own name, several are joined.
    arm: arms.join('+'),
    weighted_mean: Number(weighted.toFixed(6)),
    n: totalN,
    checkpoints: rows.map((row) => ({ checkpoint: row.checkpoint, value: row.value, n: row.n })),
  };
}

/**
 * Compare an experiment's baseline and treatment arms, metric by metric.
 *
 * The verdict rules are the brief's honesty rules, applied literally:
 *   - `insufficient_data` when either arm has no observation for the metric, or
 *     when either arm's total `n` is below the target's `min_samples`, or when
 *     the baseline is 0 (a RELATIVE gain cannot be formed from it);
 *   - `improved` when the relative gain in the metric's own direction reaches
 *     the target's `min_relative_gain`;
 *   - `not_improved` otherwise — a regression and a flat reading are both
 *     reported as not improved, never smoothed into one number.
 *
 * The overall verdict is `improved` only when at least one metric improved and
 * NO metric regressed; a regression anywhere makes the experiment
 * `not_improved`.
 */
export async function compareExperiment(
  db: Db,
  userId: string,
  experimentId: string,
  options: CompareExperimentOptions = {},
): Promise<ExperimentComparison | null> {
  const experiment = await getExperiment(db, userId, experimentId);
  if (!experiment) return null;
  const observations = await listObservations(db, userId, experimentId);

  const requestedBaseline = (options.baselineArms ?? []).map((arm) => nonEmpty(arm)).filter((arm): arm is string => arm !== null);
  const requestedTreatment = (options.treatmentArms ?? []).map((arm) => nonEmpty(arm)).filter((arm): arm is string => arm !== null);
  const baselineArms = requestedBaseline.length > 0
    ? requestedBaseline
    : [nonEmpty(options.baselineArm) ?? experiment.arms[0].label];
  const treatmentArms = requestedTreatment.length > 0
    ? requestedTreatment
    : [nonEmpty(options.treatmentArm) ?? experiment.arms[experiment.arms.length - 1].label];
  const baselineArm = baselineArms[0];
  const treatmentArm = treatmentArms[0];
  const metrics = [...new Set(observations.map((row) => row.metric))].sort();

  const comparisons: MetricComparison[] = [];
  for (const metric of metrics) {
    const { target, source } = improvementTargetFor(metric, options.targets?.[metric]);
    const baseline = aggregate(observations, baselineArms, metric);
    const treatment = aggregate(observations, treatmentArms, metric);
    const verdict = compareMeasuredValues({
      metric,
      baseline: baseline ? { value: baseline.weighted_mean, n: baseline.n } : null,
      treatment: treatment ? { value: treatment.weighted_mean, n: treatment.n } : null,
      override: options.targets?.[metric],
      baselineLabel: `the baseline side (${baselineArms.join(', ')})`,
      treatmentLabel: `the treatment side (${treatmentArms.join(', ')})`,
    });
    comparisons.push({
      metric,
      direction: verdict.direction,
      target: verdict.target,
      baseline: baseline ?? { arm: baselineArm, weighted_mean: 0, n: 0, checkpoints: [] },
      treatment: treatment ?? { arm: treatmentArm, weighted_mean: 0, n: 0, checkpoints: [] },
      delta: verdict.delta,
      relative_gain: verdict.relative_gain,
      verdict: verdict.verdict,
      reason: verdict.reason,
      n: verdict.n,
      basis:
        `imagination_experiments observations for ${metric} (kind ${OBSERVATION_KIND}), ` +
        `arms ${baselineArms.join('+')} vs arms ${treatmentArms.join('+')}, pooled and weighted by their recorded n; ` +
        `target ${target.direction} is better by ${target.min_relative_gain} relative (${source})`,
    });
  }

  const counts = {
    improved: comparisons.filter((row) => row.verdict === 'improved').length,
    not_improved: comparisons.filter((row) => row.verdict === 'not_improved').length,
    insufficient_data: comparisons.filter((row) => row.verdict === 'insufficient_data').length,
  };
  const overall: ExperimentComparison['verdict'] =
    comparisons.length === 0 || counts.improved + counts.not_improved === 0
      ? 'insufficient_data'
      : counts.not_improved > 0
        ? 'not_improved'
        : 'improved';

  return {
    experiment_id: experimentId,
    user_id: userId,
    baseline_arm: baselineArm,
    treatment_arm: treatmentArm,
    baseline_arms: baselineArms,
    treatment_arms: treatmentArms,
    metrics: comparisons,
    verdict: overall,
    counts,
    basis:
      `${observations.length} observation(s) across ${metrics.length} metric(s); the overall verdict is "improved" only when at least one metric improved and none regressed, ` +
      '"not_improved" when any metric regressed or fell short of its target, and "insufficient_data" when no metric had enough samples to form a verdict',
    privacy: {
      scope: 'private',
      private_rows: observations.length + 1,
      shared_rows: 0,
      raw_reflections_included: false,
      basis:
        'imagination_experiments rows for this identity only (the experiment and its observations); this collection is written without a shared_id and carries no journal or reflection material',
    },
  };
}
