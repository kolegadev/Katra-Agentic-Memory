/**
 * Focused Consolidation — a mission-scoped Salience Trace (ITER-5, Phase 3).
 *
 * Contract: CONTRACT-iter5-focused-consolidation.md. This is the mission-scoped
 * analogue of sleep consolidation: given a mission's REAL operational state it
 * privately produces an evidence-linked, calibrated trace of what feels
 * important and why — plus its own run ledger — and it never touches the
 * daily/weekly/monthly journal families and never writes anything shared.
 *
 * DELIBERATE DEVIATION (recorded per the contract): the brief suggested
 * refactoring shared primitives out of `sleep-consolidation-service.ts`. That
 * was rejected. The journal gather there is entangled with period semantics
 * (period_start/period_end, batched synthesis, the journal output bus) while the
 * focused inputs are mission-scoped (mission state, baton, ledger, work items,
 * deltas) and its output is a private trace, not a journal. Sharing a
 * "gather" primitive between the two would couple them for no reuse. This
 * iteration instead reuses `llmService.extractJson`, the mission-cognition
 * services (mission state / ledger / batons / uncertainty triggers) and the
 * mission-cognition schema registry, and leaves the sleep path untouched.
 *
 * PRIVACY (the point of the feature):
 *   - The only journal/reflection data this module touches is COUNTS obtained
 *     with `countDocuments({ user_id })` on the caller's own rows, plus the
 *     latest journal's `period_type` label. No journal or reflection text is
 *     ever read, projected, stored or sent to a model.
 *   - The stored trace is CONSTRUCTED field by field from the model output.
 *     Unknown keys the model emits are dropped, never stored — which is what
 *     lets the JSON schema tolerate extra keys without leaking anything.
 *   - Every write goes through `resolveWriteScope` with a personal kind and is
 *     `stripSharedId`-ed, so neither collection can carry a `shared_id`.
 *   - A source-level guard test proves this module imports no journal or
 *     reflection writer (and cannot reach one).
 *
 * DETERMINISM: `problem_state_digest` is a pure function of the gathered
 * inputs — ids, versions, statuses, counts and statement prefixes, canonically
 * ordered. No timestamps, no generated ids, no model output and no
 * `Date.now()` enter the digest, so two runs over identical state produce the
 * same digest (proved by test).
 *
 * BOUNDS (no unbounded work): one LLM call per run, retried at most once; a
 * token ceiling (`FOCUSED_CONSOLIDATION_MAX_TOKENS`, default 2000) passed to
 * `extractJson`; a hard per-attempt timeout
 * (`FOCUSED_CONSOLIDATION_TIMEOUT_MS`, default 60000); and fixed caps on every
 * gathered collection and on the normalized signal set.
 *
 * FAIL LOUDLY, NEVER FABRICATE: a failed or unusable model call is recorded as
 * a `failed` run row with the error and writes NO trace. Unresolvable evidence
 * refs are kept, flagged and counted — never dropped and never invented.
 *
 * TRUNCATION IS DEGRADATION, NOT FAILURE: model text longer than its schema
 * bound (`statement`, `why_operationally_relevant`) is truncated to FIT the
 * bound — the ellipsis is included in the limit — and every shortened field is
 * counted as `truncated_fields` on the run ledger. Before this, a 2001-character
 * statement produced a 2001-character value against `maxLength: 2000`, the
 * store rejected the whole document and the run failed with no trace at all.
 *
 * CRASH SAFETY (the trace/ledger window): the trace insert and the run-ledger
 * update that names it are two writes and not one transaction, so the failure
 * between them is COMPENSATED rather than left to chance — the trace is deleted
 * (bounded retry, `ORPHAN_ROLLBACK_ATTEMPTS`) and the run is recorded failed
 * with no trace_id; if that compensating delete also fails, the run row carries
 * `orphan_trace_id` naming the surviving trace and the mismatch is logged
 * loudly. A `running` claim whose `created_at` is missing or unparseable can
 * never be aged, so it is reclaimed as failed instead of wedging the
 * `{user, mission, cycle}` triple at `in_progress` forever.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { llmService } from '../infrastructure/llm-service.js';
import { runWithUsageOrigin, usageDeltaSince, usageSnapshot } from '../infrastructure/llm-usage-ledger.js';
import { resolveWriteScope, stripSharedId } from '../memory/write-scope-policy.js';
import { MissionStateService } from '../mission-cognition/mission-state-service.js';
import { EpistemicLedgerService } from '../mission-cognition/epistemic-ledger-service.js';
import { BatonService } from '../mission-cognition/baton-service.js';
import { evaluateTriggers } from '../mission-cognition/uncertainty-triggers.js';
import { COLLECTIONS } from '../mission-cognition/collections.js';
import { SCHEMA_IDS, validateAgainst } from '../mission-cognition/schema-registry.js';
import {
  FOCUSED_CONSOLIDATION_COLLECTIONS,
  FOCUSED_RUN_KIND,
  SALIENCE_TRACE_KIND,
  ensureFocusedConsolidationIndexes,
} from './focused-consolidation-collections.js';
import type {
  CognitiveBaton,
  FiredTrigger,
  LedgerEntry,
  MissionState,
  StateDelta,
} from '../../types/cognitive-control.js';

// ── Flag ────────────────────────────────────────────────────────────────────
//
// FOCUSED_IMAGINATION — default OFF, truthy `1|true|yes` (case-insensitive),
// exactly like PER_IDENTITY_PERSONALITY. Fails closed: with the flag off the
// MCP tools are not registered AND the dispatch re-check throws
// `Unknown tool`, so the surface is indistinguishable from not existing.
export function focusedImaginationEnabled(): boolean {
  const value = (process.env.FOCUSED_IMAGINATION ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

// ── Bounds ──────────────────────────────────────────────────────────────────
const MAX_LEDGER_ENTRIES_PER_TYPE = 50;
const MAX_WORK_ITEMS = 50;
const MAX_ACCEPTED_DELTAS = 50;
const MAX_SIGNALS = 50;
const MAX_EVIDENCE_REFS_PER_SIGNAL = 20;
const MAX_STATEMENT_CHARS = 2000;
const MAX_DIGEST_STATEMENT_CHARS = 200;
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_LLM_ATTEMPTS = 2;
const CONFIDENCE_FLOOR = 0.2;
/** A `running` claim older than this is treated as abandoned (process died). */
const ABANDONED_RUN_GRACE_MS = 30_000;
/**
 * Compensating-delete attempts after a trace was written but its run row could
 * not be completed. Bounded: after these the caller records the orphan instead
 * of retrying forever.
 */
const ORPHAN_ROLLBACK_ATTEMPTS = 3;

export const SIGNAL_KINDS = [
  'attraction',
  'tension',
  'surprise',
  'absence',
  'persistent_pull',
  'question',
] as const;

export type SalienceSignalKind = (typeof SIGNAL_KINDS)[number];

/** Collections an evidence ref may resolve against, and their id field. */
const RESOLVABLE_REF_SOURCES: Array<{ collection: string; field: string }> = [
  { collection: COLLECTIONS.missionStates, field: 'mission_id' },
  { collection: COLLECTIONS.stateDeltas, field: 'delta_id' },
  { collection: COLLECTIONS.epistemicEntries, field: 'entry_id' },
  { collection: COLLECTIONS.cognitiveWorkItems, field: 'work_item_id' },
  { collection: COLLECTIONS.cognitiveBatons, field: 'baton_id' },
];

export function focusedConsolidationMaxTokens(): number {
  const raw = Number(process.env.FOCUSED_CONSOLIDATION_MAX_TOKENS ?? DEFAULT_MAX_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_TOKENS;
}

export function focusedConsolidationTimeoutMs(): number {
  const raw = Number(process.env.FOCUSED_CONSOLIDATION_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface SalienceSignal {
  kind: SalienceSignalKind;
  statement: string;
  why_operationally_relevant: string;
  intensity: number;
  confidence: number;
  valence: number;
  evidence_refs: string[];
  /** Kept below the confidence floor, but marked (contract §A.5). */
  low_confidence: boolean;
  /** At least one ref did not resolve — kept, flagged, counted (contract §A.4). */
  unresolved_evidence?: boolean;
}

export interface SalienceTraceCalibration {
  signal_count: number;
  intensity_max: number;
  intensity_mean: number;
  confidence_mean: number;
  valence_mean: number;
  low_confidence_count: number;
  confidence_floor: number;
  /**
   * Every calibration value the model did not supply as a plain in-range
   * number, i.e. `clamped_by_field` summed. It counts three different
   * adjustments, all reported per field in `clamped_by_field`:
   *   - an out-of-range number pulled back into range (a true CLAMP);
   *   - a numeric STRING coerced with `Number()` — counted here AND in
   *     `coerced_values`, because coercion changes the value's TYPE, not its
   *     range, so it must not be silently conflated with clamping;
   *   - a missing, non-numeric or non-finite value replaced by 0 (the honest
   *     "no signal claimed").
   */
  clamped_values: number;
  clamped_by_field: Record<string, number>;
  /** The numeric-string subset of `clamped_values` (coerced rather than clamped). */
  coerced_values: number;
  coerced_by_field: Record<string, number>;
  by_kind: Record<string, number>;
  /** Confidence distribution in five 0.2-wide buckets — the run's calibration record. */
  confidence_buckets: Record<string, number>;
}

export interface SalienceTraceEvidence {
  total_refs: number;
  resolved_refs: number;
  unresolved_ref_count: number;
  /** Signals carrying at least one unresolvable ref. */
  unresolved_evidence_count: number;
  flagged_refs: string[];
  resolvable_collections: string[];
  warning?: string;
}

export interface FocusedInputCounts {
  ledger_entries: number;
  hypotheses: number;
  uncertainties: number;
  decisions: number;
  work_items: number;
  accepted_deltas: number;
  fired_triggers: number;
  baton_present: boolean;
  journal_count: number;
  reflection_node_count: number;
  latest_journal_period: string | null;
}

export interface SalienceTracePrivacy {
  raw_reflections_included: false;
  shared: false;
}

export interface SalienceTrace {
  schema_version: '1.0';
  trace_id: string;
  run_id: string;
  mission_id: string;
  mission_version: number;
  cycle_id: string;
  user_id: string;
  trigger: string;
  problem_state_digest: string;
  created_at: string;
  signals: SalienceSignal[];
  calibration: SalienceTraceCalibration;
  evidence: SalienceTraceEvidence;
  input_counts: FocusedInputCounts;
  privacy: SalienceTracePrivacy;
}

export interface FocusedConsolidationRun {
  schema_version: '1.0';
  run_id: string;
  idempotency_key: string;
  user_id: string;
  mission_id: string;
  mission_version: number;
  cycle_id: string;
  trigger: string;
  actor_id: string;
  status: 'running' | 'completed' | 'failed';
  trace_id: string | null;
  problem_state_digest: string;
  model: string;
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  completed_at: string | null;
  duration_ms: number;
  input_counts: FocusedInputCounts;
  output_counts: {
    signals: number;
    by_kind: Record<string, number>;
    dropped_signals: number;
    dropped_by_reason: Record<string, number>;
    trimmed_evidence_refs: number;
  };
  unresolved_evidence_count: number;
  unresolved_ref_count: number;
  /**
   * Every calibration value that was not already a plain in-range number:
   * out-of-range numbers clamped into range, numeric strings coerced with
   * `Number()`, and missing/NaN/non-finite values replaced by 0. The trace's
   * `calibration.clamped_by_field` holds the per-field breakdown and
   * `coerced_values` isolates the numeric-string coercion.
   */
  clamped_values: number;
  /** The numeric-string subset of `clamped_values` — coerced, not clamped. */
  coerced_values: number;
  /** Stored statement/why fields shortened to fit their schema bound. */
  truncated_fields: number;
  low_confidence_count: number;
  confidence_buckets: Record<string, number>;
  /**
   * Set only when a completed trace was written and the run-ledger write that
   * should have named it FAILED, and the compensating delete failed too. The
   * run is `failed` and this field is the recovery hint: the trace with this
   * id is readable and has no completing run row. Null on every ordinary run.
   */
  orphan_trace_id?: string | null;
  warning?: string;
  error: string | null;
  privacy_audit: {
    raw_reflections_included: false;
    shared: false;
    shared_id_written: false;
    journal_writes: 0;
  };
}

export interface FocusedConsolidationArgs {
  userId: string;
  missionId: string;
  cycleId?: string;
  trigger?: string;
  actorId?: string;
}

export interface FocusedConsolidationResult {
  /** The run-ledger row, exactly as stored. */
  run: FocusedConsolidationRun;
  status: 'completed' | 'failed' | 'in_progress';
  /** True when no model call happened: an idempotent replay of an existing run. */
  reused: boolean;
  run_id: string;
  trace_id: string | null;
  mission_id: string;
  mission_version: number;
  cycle_id: string;
  problem_state_digest: string;
  llm_calls: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  signal_count: number;
  unresolved_evidence_count: number;
  unresolved_ref_count: number;
  clamped_values: number;
  coerced_values: number;
  truncated_fields: number;
  low_confidence_count: number;
  /** Non-null only when a completed trace outlived a failed run-ledger write. */
  orphan_trace_id: string | null;
  warning?: string;
  error?: string;
  trace: SalienceTrace | null;
}

export class FocusedConsolidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'FocusedConsolidationError';
  }
}

/** Gathered inputs — counts/summaries and mission operational state only. */
export interface GatheredFocusedInputs {
  mission: MissionState;
  checkpoint_version: number;
  baton: CognitiveBaton | null;
  hypotheses: LedgerEntry[];
  uncertainties: LedgerEntry[];
  decisions: LedgerEntry[];
  fired_triggers: FiredTrigger[];
  work_items: Array<Record<string, unknown>>;
  accepted_deltas: StateDelta[];
  reflection_state: {
    journal_count: number;
    reflection_node_count: number;
    latest_journal_period: string | null;
  };
  input_counts: FocusedInputCounts;
  problem_state_digest: string;
}

// ── Small helpers ───────────────────────────────────────────────────────────

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error);
}

function isDuplicateKeyError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 11000 || /E11000|duplicate key/i.test(errorMessage(error));
}

/**
 * Bound `text` to AT MOST `max` characters INCLUDING the ellipsis.
 *
 * The ellipsis is a character like any other: the previous form returned `max`
 * characters PLUS '…', i.e. `max + 1`, which pushed an over-long statement or
 * why past the trace schema's `maxLength: 2000`. The store then rejected the
 * whole document, so a field one character over the bound did not degrade — it
 * failed the entire run and wrote no trace at all. One character is therefore
 * reserved for the ellipsis, and every field shortened this way is counted
 * (`truncated_fields` on the run ledger).
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  if (max === 1) return '…';
  return `${text.slice(0, max - 1)}…`;
}

/** Canonical JSON: object keys sorted, arrays kept in the order given. */
export function stableStringify(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        out[key] = walk((node as Record<string, unknown>)[key]);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(6));
}

function byEntryId(a: LedgerEntry, b: LedgerEntry): number {
  return String(a.entry_id ?? '').localeCompare(String(b.entry_id ?? ''));
}

/**
 * A caller-supplied run name; free-form but bounded and storable. Normalized
 * to a single-token slug: lowercase, every run of disallowed characters
 * collapses to ONE underscore, and no separator is left dangling at either end
 * — `'Manual Trigger!'` is `'manual_trigger'`, not `'manual_trigger_'` (the
 * trailing separator the previous form stored, because the punctuation-to-
 * underscore replacement was never trimmed).
 */
function sanitizeTrigger(trigger: unknown): string {
  const raw = nonEmpty(trigger) ?? 'manual';
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40)
    // The slice itself can expose a separator that was mid-string before it.
    .replace(/[-_]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'manual';
}

export function defaultCycleId(missionVersion: number): string {
  return `cycle_v${missionVersion}`;
}

export function focusedIdempotencyKey(userId: string, missionId: string, cycleId: string): string {
  return `focused:${userId}:${missionId}:${cycleId}`;
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  // Absorb a late settle so a losing race can never surface as an unhandled
  // rejection once the timeout has already rejected.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 1. Gather (mission-scoped, no LLM) ──────────────────────────────────────

export async function gatherFocusedInputs(
  db: Db,
  mission: MissionState,
  userId: string,
): Promise<GatheredFocusedInputs> {
  const missionId = mission.mission_id;
  const ledger = new EpistemicLedgerService(db);
  const batons = new BatonService(db);

  // Ledger: hypotheses / uncertainties / decisions, newest first by the
  // service's own read path, then bounded and re-sorted by entry_id so the
  // digest never depends on insertion order.
  const openStatuses = new Set(['active', 'accepted', 'challenged']);
  const hypotheses = (await ledger.listEntries(missionId, { entry_type: 'hypothesis' }, MAX_LEDGER_ENTRIES_PER_TYPE))
    .filter((e) => openStatuses.has(e.status))
    .sort(byEntryId);
  const uncertainties = (await ledger.listEntries(missionId, { entry_type: 'uncertainty' }, MAX_LEDGER_ENTRIES_PER_TYPE))
    .filter((e) => openStatuses.has(e.status))
    .sort(byEntryId);
  const decisions = (await ledger.listEntries(missionId, { entry_type: 'decision' }, MAX_LEDGER_ENTRIES_PER_TYPE))
    .filter((e) => openStatuses.has(e.status) || e.status === 'accepted_risk')
    .sort(byEntryId);

  // The active Context Baton, if any (the newest id the mission still lists).
  let baton: CognitiveBaton | null = null;
  const activeBatonIds = mission.active_baton_ids ?? [];
  if (activeBatonIds.length > 0) {
    baton = await batons.getBaton(activeBatonIds[activeBatonIds.length - 1]);
  }

  // Open uncertainties via the existing deterministic detectors (no model calls).
  const { fired } = await evaluateTriggers(db, missionId);
  const firedTriggers = [...fired].sort(
    (a, b) => a.trigger.localeCompare(b.trigger) || String(a.entry_id ?? '').localeCompare(String(b.entry_id ?? '')),
  );

  // Work-item queue.
  const workItems = (await db
    .collection(COLLECTIONS.cognitiveWorkItems)
    .find({ mission_id: missionId }, { projection: { _id: 0 } })
    .toArray()) as unknown as Array<Record<string, unknown>>;
  const queue = workItems
    .filter((w) => ['queued', 'allocated', 'in_progress', 'blocked'].includes(String(w.status)))
    .sort(
      (a, b) =>
        String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) ||
        String(a.work_item_id ?? '').localeCompare(String(b.work_item_id ?? '')),
    )
    .slice(0, MAX_WORK_ITEMS);

  // Accepted state deltas since the last checkpoint.
  const checkpointSnapshots = (await db
    .collection(COLLECTIONS.missionStateVersions)
    .find({ mission_id: missionId }, { projection: { _id: 0, version: 1 } })
    .toArray()) as unknown as Array<{ version?: number }>;
  const checkpointVersion = checkpointSnapshots.reduce(
    (max, snap) => (Number.isFinite(snap.version) ? Math.max(max, Number(snap.version)) : max),
    0,
  );
  const acceptedDeltas = ((await db
    .collection(COLLECTIONS.stateDeltas)
    .find({ mission_id: missionId, status: 'accepted' }, { projection: { _id: 0 } })
    .toArray()) as unknown as StateDelta[])
    .filter((d) => Number(d.base_mission_version ?? 0) >= checkpointVersion)
    .sort(
      (a, b) =>
        String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) ||
        String(a.delta_id ?? '').localeCompare(String(b.delta_id ?? '')),
    )
    .slice(0, MAX_ACCEPTED_DELTAS);

  // The identity's OWN reflection state — COUNTS ONLY. No journal or
  // reflection document is read beyond a count and a non-textual period label.
  const journalCount = await db.collection('reflective_journals').countDocuments({ user_id: userId });
  const reflectionNodeCount = await db.collection('reflection_nodes').countDocuments({ user_id: userId });
  const latestJournal = (await db
    .collection('reflective_journals')
    .findOne({ user_id: userId }, { projection: { _id: 0, period_type: 1 }, sort: { period_start: -1 } })) as
    | { period_type?: unknown }
    | null;
  const reflectionState = {
    journal_count: journalCount,
    reflection_node_count: reflectionNodeCount,
    latest_journal_period: nonEmpty(latestJournal?.period_type),
  };

  const inputCounts: FocusedInputCounts = {
    ledger_entries: hypotheses.length + uncertainties.length + decisions.length,
    hypotheses: hypotheses.length,
    uncertainties: uncertainties.length,
    decisions: decisions.length,
    work_items: queue.length,
    accepted_deltas: acceptedDeltas.length,
    fired_triggers: firedTriggers.length,
    baton_present: baton !== null,
    journal_count: reflectionState.journal_count,
    reflection_node_count: reflectionState.reflection_node_count,
    latest_journal_period: reflectionState.latest_journal_period,
  };

  const problemStateDigest = computeProblemStateDigest({
    mission,
    checkpoint_version: checkpointVersion,
    baton,
    hypotheses,
    uncertainties,
    decisions,
    fired_triggers: firedTriggers,
    work_items: queue,
    accepted_deltas: acceptedDeltas,
    reflection_state: reflectionState,
  });

  return {
    mission,
    checkpoint_version: checkpointVersion,
    baton,
    hypotheses,
    uncertainties,
    decisions,
    fired_triggers: firedTriggers,
    work_items: queue,
    accepted_deltas: acceptedDeltas,
    reflection_state: reflectionState,
    input_counts: inputCounts,
    problem_state_digest: problemStateDigest,
  };
}

/**
 * Deterministic digest of the gathered inputs. Pure: same inputs → same
 * digest. Deliberately excludes every timestamp, every `_id`, the run/trace
 * ids and anything the model returned, because those either change between
 * identical runs or are outputs rather than inputs.
 */
export function computeProblemStateDigest(input: {
  mission: MissionState;
  checkpoint_version: number;
  baton: CognitiveBaton | null;
  hypotheses: LedgerEntry[];
  uncertainties: LedgerEntry[];
  decisions: LedgerEntry[];
  fired_triggers: FiredTrigger[];
  work_items: Array<Record<string, unknown>>;
  accepted_deltas: StateDelta[];
  reflection_state: GatheredFocusedInputs['reflection_state'];
}): string {
  const entry = (e: LedgerEntry) => ({
    entry_id: e.entry_id,
    entry_type: e.entry_type,
    status: e.status,
    confidence: e.confidence,
    statement: truncate(String(e.statement ?? ''), MAX_DIGEST_STATEMENT_CHARS),
  });
  const canonical = {
    mission: {
      mission_id: input.mission.mission_id,
      version: input.mission.version,
      status: input.mission.status,
      owner_id: input.mission.owner_id,
      authority_class: input.mission.authority_class,
      title: input.mission.title,
      intent: input.mission.intent,
      success_criteria: (input.mission.success_criteria ?? []).map((c) => ({
        id: c.id,
        status: c.status,
        description: truncate(String(c.description ?? ''), MAX_DIGEST_STATEMENT_CHARS),
      })),
      objectives: (input.mission.objectives ?? []).map((o) => ({
        id: o.id,
        status: o.status,
        description: truncate(String(o.description ?? ''), MAX_DIGEST_STATEMENT_CHARS),
      })),
      constraints: (input.mission.constraints ?? []).map((c) => ({ id: c.id, kind: c.kind })),
      stop_conditions: input.mission.stop_conditions ?? [],
    },
    checkpoint_version: input.checkpoint_version,
    baton: input.baton
      ? {
          baton_id: input.baton.baton_id,
          mode: input.baton.mode,
          mission_version: input.baton.mission_version,
          objective: truncate(String(input.baton.objective ?? ''), MAX_DIGEST_STATEMENT_CHARS),
          revoked: input.baton.revoked === true,
        }
      : null,
    hypotheses: input.hypotheses.map(entry),
    uncertainties: input.uncertainties.map(entry),
    decisions: input.decisions.map(entry),
    fired_triggers: input.fired_triggers.map((f) => ({
      trigger: f.trigger,
      entry_id: f.entry_id ?? null,
      reason: truncate(String(f.reason ?? ''), MAX_DIGEST_STATEMENT_CHARS),
    })),
    work_items: input.work_items.map((w) => ({
      work_item_id: w.work_item_id ?? null,
      status: w.status ?? null,
      mode: w.mode ?? null,
      description: truncate(String(w.description ?? ''), MAX_DIGEST_STATEMENT_CHARS),
    })),
    accepted_deltas: input.accepted_deltas.map((d) => ({
      delta_id: d.delta_id,
      delta_type: d.delta_type,
      status: d.status,
      base_mission_version: d.base_mission_version,
      rationale: truncate(String(d.rationale ?? ''), MAX_DIGEST_STATEMENT_CHARS),
    })),
    reflection_state: {
      journal_count: input.reflection_state.journal_count,
      reflection_node_count: input.reflection_state.reflection_node_count,
      latest_journal_period: input.reflection_state.latest_journal_period,
    },
  };
  return `sha256:${sha256Hex(stableStringify(canonical))}`;
}

// ── 3. The model call (one prompt, bounded tokens, hard timeout) ────────────

const SIGNAL_KIND_GUIDE: Record<SalienceSignalKind, string> = {
  attraction: 'what the mission is drawn toward — an approach, a promising path it wants to take',
  tension: 'what pulls against itself — a live conflict or trade-off that has not been resolved',
  surprise: 'where reality diverged from expectation — what did not go the way the mission assumed',
  absence: 'what is conspicuously missing and should be there — an unasked question, a missing check',
  persistent_pull: 'what keeps returning across cycles and refuses to close',
  question: 'the single question this mission would ask if it could ask only one',
};

export const FOCUSED_CONSOLIDATION_SYSTEM_PROMPT = `You are the focused-consolidation faculty of a long-horizon mission. You are given the mission's own operational state and you produce a PRIVATE salience trace: what feels important about this mission right now, and why.

You never see journals, reflections, chat history or personal narrative. You are given operational state only. Never ask for that material, never refer to it, and never claim to remember it.

Return ONE JSON object in exactly this shape:
{
  "signals": [
    {
      "kind": "attraction" | "tension" | "surprise" | "absence" | "persistent_pull" | "question",
      "statement": "one sentence, at most 240 characters",
      "why_operationally_relevant": "why this matters for the mission's next actions",
      "intensity": 0.0,
      "confidence": 0.0,
      "valence": 0.0,
      "evidence_refs": ["<ID>"]
    }
  ]
}

The six kinds mean exactly this:
${SIGNAL_KINDS.map((kind) => `- ${kind}: ${SIGNAL_KIND_GUIDE[kind]}`).join('\n')}

Calibration fields:
- intensity 0..1 — how strongly this presses for attention. Reserve 0.9+ for what would change the next decision.
- confidence 0..1 — how well the cited evidence supports the statement. Be honest: below 0.2 means "I am guessing".
- valence -1..1 — -1 aversion/threat … +1 attraction/opportunity.

RULES (binding):
1. 3 to 8 signals, at most 2 of any one kind.
2. evidence_refs must contain at least one id COPIED CHARACTER FOR CHARACTER from the EVIDENCE INDEX below. Never invent, guess or reformat an id; never cite a journal, reflection, conversation or any id that is not in that index.
3. why_operationally_relevant is mandatory and must be operational — the consequence for the work, not a feeling.
4. Extra keys are ignored; a signal without evidence or without a why is discarded. Losing a signal is worse than stating one with low confidence.
5. Respond with JSON only — no prose, no markdown.`;

/** The user message: mission operational state + the ids that may be cited. */
export function buildFocusedPrompt(gathered: GatheredFocusedInputs): string {
  const { mission } = gathered;
  const lines: string[] = [];
  lines.push(`MISSION STATE (v${mission.version})`);
  lines.push(`- id: ${mission.mission_id}`);
  lines.push(`- title: ${mission.title}`);
  lines.push(`- status: ${mission.status} · authority: ${mission.authority_class} · owner: ${mission.owner_id}`);
  lines.push(`- intent: ${truncate(mission.intent, 600)}`);
  if (mission.success_criteria?.length) {
    lines.push(
      `- success criteria: ${mission.success_criteria
        .map((c) => `${c.id}[${c.status}] ${truncate(String(c.description ?? ''), 160)}`)
        .join(' | ')}`,
    );
  }
  if (mission.objectives?.length) {
    lines.push(
      `- objectives: ${mission.objectives
        .map((o) => `${o.id}[${o.status}] ${truncate(String(o.description ?? ''), 160)}`)
        .join(' | ')}`,
    );
  }
  if (mission.stop_conditions?.length) lines.push(`- stop conditions: ${mission.stop_conditions.join(' | ')}`);
  if (mission.constraints?.length) {
    lines.push(`- constraints: ${mission.constraints.map((c) => `${c.kind}:${truncate(c.description, 120)}`).join(' | ')}`);
  }

  lines.push('');
  lines.push('ACTIVE CONTEXT BATON');
  if (gathered.baton) {
    const b = gathered.baton;
    // Deliberately not `- baton: …`: the EVIDENCE INDEX below uses
    // `- <collection>: …` lines, and the model must not mistake a
    // descriptive line for a citable index entry.
    lines.push(`- active baton id: ${b.baton_id}`);
    lines.push(`- mode: ${b.mode} · issued against v${b.mission_version}`);
    lines.push(`- objective: ${truncate(b.objective, 300)}`);
    lines.push(`- deliverable: ${truncate(b.deliverable, 300)}`);
    if (b.stop_conditions?.length) lines.push(`- baton stop conditions: ${b.stop_conditions.join(' | ')}`);
    if (b.blindness?.enabled) lines.push(`- blindness: withholding [${(b.blindness.withheld_classes ?? []).join(', ')}]`);
  } else {
    lines.push('- none active');
  }

  const renderEntries = (label: string, entries: LedgerEntry[]) => {
    lines.push('');
    lines.push(label);
    if (entries.length === 0) {
      lines.push('- none');
      return;
    }
    for (const e of entries) {
      lines.push(`- ${e.entry_id} [${e.status}, confidence ${e.confidence}] ${truncate(String(e.statement), 300)}`);
      if (e.consequence_if_false) lines.push(`    if false: ${truncate(String(e.consequence_if_false), 200)}`);
    }
  };
  renderEntries('HYPOTHESES (open)', gathered.hypotheses);
  renderEntries('UNCERTAINTIES (open)', gathered.uncertainties);
  renderEntries('DECISIONS (in force)', gathered.decisions);

  lines.push('');
  lines.push('FIRED UNCERTAINTY TRIGGERS (deterministic detectors)');
  if (gathered.fired_triggers.length === 0) {
    lines.push('- none fired');
  } else {
    for (const f of gathered.fired_triggers) {
      lines.push(`- ${f.trigger} → ${f.entry_id ?? '(mission)'}: ${truncate(String(f.reason), 240)}`);
    }
  }

  lines.push('');
  lines.push('WORK ITEM QUEUE');
  if (gathered.work_items.length === 0) {
    lines.push('- empty');
  } else {
    for (const w of gathered.work_items) {
      lines.push(
        `- ${w.work_item_id} [${w.status}/${w.mode}] ${truncate(String(w.description ?? ''), 200)}`,
      );
    }
  }

  lines.push('');
  lines.push(`ACCEPTED STATE DELTAS SINCE CHECKPOINT (v${gathered.checkpoint_version})`);
  if (gathered.accepted_deltas.length === 0) {
    lines.push('- none');
  } else {
    for (const d of gathered.accepted_deltas) {
      lines.push(`- ${d.delta_id} [${d.delta_type}] ${truncate(String(d.rationale ?? ''), 200)}`);
    }
  }

  lines.push('');
  lines.push('IDENTITY REFLECTION STATE (counts only — no text is available to you)');
  lines.push(`- journal entries recorded: ${gathered.reflection_state.journal_count}`);
  lines.push(`- reflection nodes recorded: ${gathered.reflection_state.reflection_node_count}`);
  lines.push(`- latest journal period: ${gathered.reflection_state.latest_journal_period ?? 'none'}`);

  lines.push('');
  lines.push('EVIDENCE INDEX — the only ids you may cite in evidence_refs');
  lines.push(`- mission: ${mission.mission_id}`);
  const indexGroup = (label: string, ids: string[]) => {
    if (ids.length === 0) return;
    lines.push(`- ${label}: ${ids.join(', ')}`);
  };
  indexGroup('baton', gathered.baton ? [gathered.baton.baton_id] : []);
  indexGroup('delta', gathered.accepted_deltas.map((d) => d.delta_id));
  indexGroup('entry', [
    ...gathered.hypotheses.map((e) => e.entry_id),
    ...gathered.uncertainties.map((e) => e.entry_id),
    ...gathered.decisions.map((e) => e.entry_id),
  ]);
  indexGroup('work item', gathered.work_items.map((w) => String(w.work_item_id)));

  lines.push('');
  lines.push('Produce the salience trace now as a single JSON object.');
  return lines.join('\n');
}

// ── 4/5. Normalization + calibration + evidence validation ─────────────────

interface NormalizedSignals {
  signals: SalienceSignal[];
  dropped_by_reason: Record<string, number>;
  trimmed_evidence_refs: number;
  clamped_by_field: Record<string, number>;
  clamped_values: number;
  coerced_by_field: Record<string, number>;
  coerced_values: number;
  truncated_fields: number;
}

/**
 * Shorten to fit, with a counter — a value the model sent that is longer than
 * its schema bound is TRUNCATED (and counted), never allowed to fail the run.
 */
function asText(value: unknown, max: number, onTruncate?: () => void): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > max && onTruncate) onTruncate();
    return truncate(trimmed, max);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/** Per-field adjustment counters for one calibration pass. */
interface CalibrationCounters {
  /** Every supplied value that was not already a plain in-range number. */
  clamped: Record<string, number>;
  /** The subset supplied as numeric strings (coerced rather than clamped). */
  coerced: Record<string, number>;
}

/**
 * Clamp one calibration value into [min, max]. A missing, non-numeric or
 * non-finite value becomes `fallback` (0 — the honest "no signal claimed"),
 * and every adjustment is counted so the run can report it. A numeric STRING
 * is accepted (a hostile model emits `'0.7'` freely) but counted in
 * `coerced` as well, because coercion is not clamping.
 */
function clampValue(
  raw: unknown,
  min: number,
  max: number,
  field: string,
  counters: CalibrationCounters,
): number {
  const numericString = typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw));
  const numeric =
    typeof raw === 'number' && Number.isFinite(raw) ? raw : numericString ? Number(raw) : null;
  if (numeric === null) {
    counters.clamped[field] = (counters.clamped[field] ?? 0) + 1;
    return 0;
  }
  if (numericString) counters.coerced[field] = (counters.coerced[field] ?? 0) + 1;
  const clamped = Math.min(max, Math.max(min, numeric));
  if (clamped !== raw) counters.clamped[field] = (counters.clamped[field] ?? 0) + 1;
  return clamped;
}

function normalizeKind(raw: unknown): SalienceSignalKind | null {
  const text = asText(raw, 60);
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/[\s-]+/g, '_');
  return (SIGNAL_KINDS as readonly string[]).includes(normalized) ? (normalized as SalienceSignalKind) : null;
}

/**
 * Build the stored signal set from the model output. The stored signal is
 * CONSTRUCTED field by field — extra keys are dropped, never stored.
 */
export function normalizeSignals(raw: unknown): NormalizedSignals {
  const dropped: Record<string, number> = {};
  const counters: CalibrationCounters = { clamped: {}, coerced: {} };
  let trimmedEvidenceRefs = 0;
  /** Stored fields shortened to fit their schema bound (never a silent loss). */
  let truncatedFields = 0;
  const countTruncation = () => {
    truncatedFields += 1;
  };
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };

  const list = Array.isArray(raw) ? raw : [];
  const signals: SalienceSignal[] = [];
  for (const candidate of list) {
    if (signals.length >= MAX_SIGNALS) {
      drop('over_signal_cap');
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      drop('not_an_object');
      continue;
    }
    const item = candidate as Record<string, unknown>;
    const kind = normalizeKind(item.kind);
    if (!kind) {
      drop('unknown_kind');
      continue;
    }
    const statement = asText(item.statement, MAX_STATEMENT_CHARS, countTruncation);
    if (!statement) {
      drop('missing_statement');
      continue;
    }
    const why = asText(item.why_operationally_relevant, MAX_STATEMENT_CHARS, countTruncation);
    if (!why) {
      drop('missing_why_operationally_relevant');
      continue;
    }
    const refs = (Array.isArray(item.evidence_refs) ? item.evidence_refs : [])
      .map((ref) => nonEmpty(ref))
      .filter((ref): ref is string => ref !== null);
    if (refs.length === 0) {
      // No evidence: discard rather than store an unevidenced signal, and
      // count it — a dropped signal is reported, never silent (contract §A.4).
      drop('no_evidence_refs');
      continue;
    }
    if (refs.length > MAX_EVIDENCE_REFS_PER_SIGNAL) {
      trimmedEvidenceRefs += refs.length - MAX_EVIDENCE_REFS_PER_SIGNAL;
      refs.length = MAX_EVIDENCE_REFS_PER_SIGNAL;
    }
    const confidence = clampValue(item.confidence, 0, 1, 'confidence', counters);
    const signal: SalienceSignal = {
      kind,
      statement,
      why_operationally_relevant: why,
      intensity: clampValue(item.intensity, 0, 1, 'intensity', counters),
      confidence,
      valence: clampValue(item.valence, -1, 1, 'valence', counters),
      evidence_refs: [...new Set(refs)],
      low_confidence: confidence < CONFIDENCE_FLOOR,
    };
    signals.push(signal);
  }

  const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    signals,
    dropped_by_reason: dropped,
    trimmed_evidence_refs: trimmedEvidenceRefs,
    clamped_by_field: counters.clamped,
    clamped_values: sum(counters.clamped),
    coerced_by_field: counters.coerced,
    coerced_values: sum(counters.coerced),
    truncated_fields: truncatedFields,
  };
}

/** Resolve one ref against the mission's OWN collections. `null` = unresolved. */
async function resolveEvidenceRef(db: Db, missionId: string, ref: string): Promise<string | null> {
  for (const source of RESOLVABLE_REF_SOURCES) {
    const hit = await db
      .collection(source.collection)
      .findOne({ mission_id: missionId, [source.field]: ref }, { projection: { [source.field]: 1 } });
    if (hit) return source.collection;
  }
  return null;
}

export async function validateEvidence(
  db: Db,
  missionId: string,
  signals: SalienceSignal[],
): Promise<{ signals: SalienceSignal[]; evidence: SalienceTraceEvidence }> {
  const cache = new Map<string, string | null>();
  const flaggedRefs = new Set<string>();
  let totalRefs = 0;
  let resolvedRefs = 0;
  let unresolvedEvidenceCount = 0;

  const resolvedSignals: SalienceSignal[] = [];
  for (const signal of signals) {
    let unresolved = false;
    for (const ref of signal.evidence_refs) {
      totalRefs += 1;
      if (!cache.has(ref)) cache.set(ref, await resolveEvidenceRef(db, missionId, ref));
      if (cache.get(ref)) {
        resolvedRefs += 1;
      } else {
        unresolved = true;
        flaggedRefs.add(ref);
      }
    }
    if (unresolved) unresolvedEvidenceCount += 1;
    const stored: SalienceSignal = { ...signal };
    if (unresolved) stored.unresolved_evidence = true;
    else delete stored.unresolved_evidence;
    resolvedSignals.push(stored);
  }

  const evidence: SalienceTraceEvidence = {
    total_refs: totalRefs,
    resolved_refs: resolvedRefs,
    unresolved_ref_count: totalRefs - resolvedRefs,
    unresolved_evidence_count: unresolvedEvidenceCount,
    flagged_refs: [...flaggedRefs].sort(),
    resolvable_collections: RESOLVABLE_REF_SOURCES.map((s) => s.collection),
  };
  // More than half the signals carrying unresolved evidence is a warning, not
  // a silent accept (contract §A.4).
  if (resolvedSignals.length > 0 && unresolvedEvidenceCount * 2 > resolvedSignals.length) {
    evidence.warning = `${unresolvedEvidenceCount} of ${resolvedSignals.length} signals cite at least one unresolvable evidence ref (${evidence.unresolved_ref_count} refs total)`;
  }
  return { signals: resolvedSignals, evidence };
}

function summarizeCalibration(
  signals: SalienceSignal[],
  clampedByField: Record<string, number>,
  coercedByField: Record<string, number> = {},
): SalienceTraceCalibration {
  const intensities = signals.map((s) => s.intensity);
  const byKind: Record<string, number> = {};
  for (const signal of signals) byKind[signal.kind] = (byKind[signal.kind] ?? 0) + 1;
  const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    signal_count: signals.length,
    intensity_max: intensities.length > 0 ? Number(Math.max(...intensities).toFixed(6)) : 0,
    intensity_mean: mean(intensities),
    confidence_mean: mean(signals.map((s) => s.confidence)),
    valence_mean: mean(signals.map((s) => s.valence)),
    low_confidence_count: signals.filter((s) => s.low_confidence).length,
    confidence_floor: CONFIDENCE_FLOOR,
    clamped_values: sum(clampedByField),
    clamped_by_field: { ...clampedByField },
    coerced_values: sum(coercedByField),
    coerced_by_field: { ...coercedByField },
    by_kind: byKind,
    confidence_buckets: confidenceBuckets(signals),
  };
}

/** The confidence distribution: five 0.2-wide buckets, closed at 1.0. */
export function confidenceBuckets(signals: SalienceSignal[]): Record<string, number> {
  const buckets: Record<string, number> = {
    '0.0-0.2': 0,
    '0.2-0.4': 0,
    '0.4-0.6': 0,
    '0.6-0.8': 0,
    '0.8-1.0': 0,
  };
  for (const signal of signals) {
    const lower = Math.min(0.999999, Math.max(0, signal.confidence));
    const index = Math.floor(lower / 0.2);
    const key = Object.keys(buckets)[Math.min(index, 4)];
    buckets[key] += 1;
  }
  return buckets;
}

// ── The service ─────────────────────────────────────────────────────────────

/** One in-process single-flight slot per idempotency key. */
const inFlight = new Map<string, Promise<FocusedConsolidationResult>>();

export class FocusedConsolidationService {
  constructor(private readonly db: Db) {}

  private runs() {
    return this.db.collection<FocusedConsolidationRun>(FOCUSED_CONSOLIDATION_COLLECTIONS.focusedRuns);
  }

  private traces() {
    return this.db.collection<SalienceTrace>(FOCUSED_CONSOLIDATION_COLLECTIONS.salienceTraces);
  }

  /** The caller's own traces, newest first. Never another identity's rows. */
  async getTraces(
    userId: string,
    opts: { traceId?: string; missionId?: string; limit?: number } = {},
  ): Promise<SalienceTrace[]> {
    const filter: Record<string, unknown> = { user_id: userId };
    if (opts.traceId) filter.trace_id = opts.traceId;
    if (opts.missionId) filter.mission_id = opts.missionId;
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const rows = await this.traces()
      .find(filter, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
    return rows as unknown as SalienceTrace[];
  }

  /** The run ledger for one mission — the caller's own runs only. */
  async getRuns(userId: string, missionId: string, limit = 10): Promise<FocusedConsolidationRun[]> {
    const rows = await this.runs()
      .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(Math.min(Math.max(limit, 1), 50))
      .toArray();
    return rows as unknown as FocusedConsolidationRun[];
  }

  async run(args: FocusedConsolidationArgs): Promise<FocusedConsolidationResult> {
    const userId = nonEmpty(args.userId);
    const missionId = nonEmpty(args.missionId);
    if (!userId) throw new FocusedConsolidationError('userId is required', 'invalid_args');
    if (!missionId) throw new FocusedConsolidationError('missionId is required', 'invalid_args');
    const actorId = nonEmpty(args.actorId) ?? userId;
    const trigger = sanitizeTrigger(args.trigger);

    await ensureFocusedConsolidationIndexes(this.db);

    const mission = await new MissionStateService(this.db).getMissionState(missionId);
    if (!mission) {
      throw new FocusedConsolidationError(`mission state not found: ${missionId}`, 'mission_not_found');
    }

    const cycleId = nonEmpty(args.cycleId) ?? defaultCycleId(mission.version);
    const idempotencyKey = focusedIdempotencyKey(userId, missionId, cycleId);

    // Idempotency: one run per {missionId, cycleId}. A repeat returns the
    // existing run — no second model call, no duplicate documents.
    const existing = await this.runs().findOne({ idempotency_key: idempotencyKey }, { projection: { _id: 0 } });
    if (existing) return this.replay(existing);

    // Single-flight: a concurrent duplicate in this process awaits the
    // in-flight run instead of starting a second one. It reports `reused:
    // true` — the work was done by the caller that installed the promise.
    const pending = inFlight.get(idempotencyKey);
    if (pending) {
      const shared = await pending;
      return { ...shared, reused: true };
    }

    const work = this.execute({ userId, missionId, actorId, trigger, cycleId, idempotencyKey, mission });
    inFlight.set(idempotencyKey, work);
    try {
      return await work;
    } finally {
      inFlight.delete(idempotencyKey);
    }
  }

  private async replay(run: FocusedConsolidationRun): Promise<FocusedConsolidationResult> {
    if (run.status === 'running') {
      const started = Date.parse(String(run.created_at));
      const startedMs = Number.isFinite(started) ? started : null;
      const graceMs = focusedConsolidationTimeoutMs() + ABANDONED_RUN_GRACE_MS;
      // WEDGE RULE (bounded and deliberate): age is the ONLY evidence that a
      // `running` claim is still alive, so a claim whose `created_at` is
      // missing or unparseable can never satisfy an age test and would pin
      // `{user, mission, cycle}` at `in_progress` forever — the whole cycle
      // unreachable without inventing a new cycle_id. An un-ageable claim is
      // therefore reclaimed as failed immediately; a claim that CAN be aged is
      // reclaimed only after the timeout + grace window.
      const stale = startedMs === null || Date.now() - startedMs > graceMs;
      if (!stale) {
        return { ...this.resultFrom(run), status: 'in_progress', reused: true, trace: null };
      }
      const completedAt = new Date().toISOString();
      const abandoned: FocusedConsolidationRun = {
        ...run,
        status: 'failed',
        error:
          startedMs === null
            ? `abandoned run — its created_at (${JSON.stringify(run.created_at ?? null)}) is missing or unparseable, so the claim cannot be aged; reclaimed as failed after the ${graceMs}ms grace window; use a new cycle_id to retry`
            : `abandoned run — no completion recorded within ${graceMs}ms (process died mid-run?); use a new cycle_id to retry`,
        completed_at: completedAt,
      };
      await this.runs().updateOne(
        { idempotency_key: run.idempotency_key, status: 'running' },
        {
          $set: {
            status: abandoned.status,
            error: abandoned.error,
            completed_at: abandoned.completed_at,
            duration_ms: Date.now() - (startedMs ?? Date.now()),
          },
        },
      );
      return { ...this.resultFrom(abandoned), status: 'failed', reused: true, trace: null };
    }

    if (run.status === 'failed') {
      return { ...this.resultFrom(run), status: 'failed', reused: true, trace: null };
    }

    const trace = run.trace_id
      ? await this.traces().findOne(
          { trace_id: run.trace_id, user_id: run.user_id },
          { projection: { _id: 0 } },
        )
      : null;
    if (!trace) {
      return {
        ...this.resultFrom(run),
        status: 'failed',
        reused: true,
        trace: null,
        error: `run ${run.run_id} is recorded completed but its trace row is missing`,
      };
    }
    return { ...this.resultFrom(run), status: 'completed', reused: true, trace };
  }

  private resultFrom(run: FocusedConsolidationRun): FocusedConsolidationResult {
    return {
      run,
      status: run.status === 'completed' ? 'completed' : run.status === 'failed' ? 'failed' : 'in_progress',
      reused: true,
      run_id: run.run_id,
      trace_id: run.trace_id,
      mission_id: run.mission_id,
      mission_version: run.mission_version,
      cycle_id: run.cycle_id,
      problem_state_digest: run.problem_state_digest,
      llm_calls: run.llm_calls,
      model: run.model,
      input_tokens: run.input_tokens,
      output_tokens: run.output_tokens,
      duration_ms: run.duration_ms,
      signal_count: run.output_counts?.signals ?? 0,
      unresolved_evidence_count: run.unresolved_evidence_count,
      unresolved_ref_count: run.unresolved_ref_count,
      clamped_values: run.clamped_values,
      coerced_values: run.coerced_values ?? 0,
      truncated_fields: run.truncated_fields ?? 0,
      low_confidence_count: run.low_confidence_count,
      orphan_trace_id: run.orphan_trace_id ?? null,
      ...(run.warning ? { warning: run.warning } : {}),
      ...(run.error ? { error: run.error } : {}),
      trace: null,
    };
  }

  private async execute(args: {
    userId: string;
    missionId: string;
    actorId: string;
    trigger: string;
    cycleId: string;
    idempotencyKey: string;
    mission: MissionState;
  }): Promise<FocusedConsolidationResult> {
    const { userId, missionId, actorId, trigger, cycleId, idempotencyKey, mission } = args;
    const startedMs = Date.now();
    const runId = randomUUID();
    const model = llmService.getServiceStatus().model;
    const privacyAudit: FocusedConsolidationRun['privacy_audit'] = {
      raw_reflections_included: false,
      shared: false,
      shared_id_written: false,
      journal_writes: 0,
    };
    const emptyCounts: FocusedInputCounts = {
      ledger_entries: 0,
      hypotheses: 0,
      uncertainties: 0,
      decisions: 0,
      work_items: 0,
      accepted_deltas: 0,
      fired_triggers: 0,
      baton_present: false,
      journal_count: 0,
      reflection_node_count: 0,
      latest_journal_period: null,
    };
    const baseRun: FocusedConsolidationRun = {
      schema_version: '1.0',
      run_id: runId,
      idempotency_key: idempotencyKey,
      user_id: userId,
      mission_id: missionId,
      mission_version: mission.version,
      cycle_id: cycleId,
      trigger,
      actor_id: actorId,
      status: 'running',
      trace_id: null,
      problem_state_digest: '',
      model,
      llm_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      created_at: new Date().toISOString(),
      completed_at: null,
      duration_ms: 0,
      input_counts: emptyCounts,
      output_counts: { signals: 0, by_kind: {}, dropped_signals: 0, dropped_by_reason: {}, trimmed_evidence_refs: 0 },
      unresolved_evidence_count: 0,
      unresolved_ref_count: 0,
      clamped_values: 0,
      coerced_values: 0,
      truncated_fields: 0,
      low_confidence_count: 0,
      confidence_buckets: confidenceBuckets([]),
      orphan_trace_id: null,
      error: null,
      privacy_audit: privacyAudit,
    };

    // Claim the cycle BEFORE the model call: the unique idempotency_key is
    // what makes a cross-process duplicate (and a crash) visible instead of
    // double-running. A duplicate claim returns the winner's run.
    try {
      await this.runs().insertOne(this.privateRun(baseRun));
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const winner = await this.runs().findOne({ idempotency_key: idempotencyKey }, { projection: { _id: 0 } });
      if (!winner) throw error;
      return this.replay(winner);
    }

    const fail = async (error: string, patch: Partial<FocusedConsolidationRun> = {}): Promise<FocusedConsolidationResult> => {
      const failed: FocusedConsolidationRun = {
        ...baseRun,
        ...patch,
        status: 'failed',
        error,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs,
      };
      await this.runs().updateOne({ idempotency_key: idempotencyKey, status: 'running' }, { $set: { ...failed } });
      return { ...this.resultFrom(failed), reused: false, trace: null };
    };

    // 1. Gather (mission-scoped, no model calls).
    let gathered: GatheredFocusedInputs;
    try {
      gathered = await gatherFocusedInputs(this.db, mission, userId);
    } catch (error) {
      return fail(`gather failed: ${errorMessage(error)}`);
    }

    // 3. One bounded model call (retried at most once), attributed to the mission.
    const maxTokens = focusedConsolidationMaxTokens();
    const timeoutMs = focusedConsolidationTimeoutMs();
    const usageBefore = usageSnapshot();
    let llmCalls = 0;
    let output: Record<string, unknown> | null = null;
    let lastError = 'the model returned no usable JSON (empty or non-object output)';
    for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt += 1) {
      llmCalls += 1;
      try {
        const result = await runWithUsageOrigin({ mission_id: missionId }, () =>
          withTimeout(
            llmService.extractJson(FOCUSED_CONSOLIDATION_SYSTEM_PROMPT, buildFocusedPrompt(gathered), maxTokens),
            timeoutMs,
            'focused consolidation model call',
          ),
        );
        if (result && typeof result === 'object' && Object.keys(result).length > 0) {
          output = result;
          break;
        }
        lastError = 'the model returned no usable JSON (empty or non-object output)';
      } catch (error) {
        lastError = errorMessage(error);
      }
    }
    const usage = usageDeltaSince(usageBefore);

    if (!output) {
      return fail(`model call failed after ${llmCalls} attempt(s): ${lastError}`, { llm_calls: llmCalls });
    }
    if (!Array.isArray(output.signals)) {
      return fail('malformed model output: no `signals` array', {
        llm_calls: llmCalls,
        input_counts: gathered.input_counts,
        problem_state_digest: gathered.problem_state_digest,
      });
    }

    // 4/5. Normalize + calibrate, then validate every ref against the mission.
    const normalized = normalizeSignals(output.signals);
    if (normalized.signals.length === 0) {
      return fail(
        `malformed model output: no usable signal survived validation (dropped ${JSON.stringify(normalized.dropped_by_reason)})`,
        {
          llm_calls: llmCalls,
          input_counts: gathered.input_counts,
          problem_state_digest: gathered.problem_state_digest,
          output_counts: {
            signals: 0,
            by_kind: {},
            dropped_signals: Object.values(normalized.dropped_by_reason).reduce((a, b) => a + b, 0),
            dropped_by_reason: normalized.dropped_by_reason,
            trimmed_evidence_refs: normalized.trimmed_evidence_refs,
          },
          clamped_values: normalized.clamped_values,
          coerced_values: normalized.coerced_values,
          truncated_fields: normalized.truncated_fields,
        },
      );
    }

    let validated: Awaited<ReturnType<typeof validateEvidence>>;
    try {
      validated = await validateEvidence(this.db, missionId, normalized.signals);
    } catch (error) {
      return fail(`evidence validation failed: ${errorMessage(error)}`, {
        llm_calls: llmCalls,
        input_counts: gathered.input_counts,
        problem_state_digest: gathered.problem_state_digest,
        clamped_values: normalized.clamped_values,
        coerced_values: normalized.coerced_values,
        truncated_fields: normalized.truncated_fields,
      });
    }

    const calibration = summarizeCalibration(
      validated.signals,
      normalized.clamped_by_field,
      normalized.coerced_by_field,
    );
    const createdAt = new Date().toISOString();
    const traceId = randomUUID();
    const warning = validated.evidence.warning;
    const trace: SalienceTrace = {
      schema_version: '1.0',
      trace_id: traceId,
      run_id: runId,
      mission_id: missionId,
      mission_version: mission.version,
      cycle_id: cycleId,
      user_id: userId,
      trigger,
      problem_state_digest: gathered.problem_state_digest,
      created_at: createdAt,
      signals: validated.signals,
      calibration,
      evidence: validated.evidence,
      input_counts: gathered.input_counts,
      privacy: { raw_reflections_included: false, shared: false },
    };

    // Validate BEFORE storing: a malformed trace fails the run cleanly.
    const check = validateAgainst(SCHEMA_IDS.salienceTrace, trace);
    if (!check.valid) {
      return fail(`salience trace failed schema validation: ${check.errors.slice(0, 5).join('; ')}`, {
        llm_calls: llmCalls,
        input_counts: gathered.input_counts,
        problem_state_digest: gathered.problem_state_digest,
        clamped_values: normalized.clamped_values,
        coerced_values: normalized.coerced_values,
        truncated_fields: normalized.truncated_fields,
        low_confidence_count: calibration.low_confidence_count,
      });
    }

    const outputCounts: FocusedConsolidationRun['output_counts'] = {
      signals: validated.signals.length,
      by_kind: calibration.by_kind,
      dropped_signals: Object.values(normalized.dropped_by_reason).reduce((a, b) => a + b, 0),
      dropped_by_reason: normalized.dropped_by_reason,
      trimmed_evidence_refs: normalized.trimmed_evidence_refs,
    };

    const completed: FocusedConsolidationRun = {
      ...baseRun,
      status: 'completed',
      trace_id: traceId,
      problem_state_digest: gathered.problem_state_digest,
      llm_calls: llmCalls,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedMs,
      input_counts: gathered.input_counts,
      output_counts: outputCounts,
      unresolved_evidence_count: validated.evidence.unresolved_evidence_count,
      unresolved_ref_count: validated.evidence.unresolved_ref_count,
      clamped_values: normalized.clamped_values,
      coerced_values: normalized.coerced_values,
      truncated_fields: normalized.truncated_fields,
      low_confidence_count: calibration.low_confidence_count,
      confidence_buckets: calibration.confidence_buckets,
      ...(warning ? { warning } : {}),
      error: null,
    };

    // ── Store the trace, then close the ledger ──────────────────────────────
    //
    // The two writes cannot be atomic here (no multi-document transaction in
    // this deployment), so the window between them is handled EXPLICITLY
    // instead of being left to chance:
    //
    //   1. trace insert fails            → nothing was written; fail as usual.
    //   2. ledger update fails           → COMPENSATE: delete the trace (bounded
    //      retry). The contract is "a failed run writes no partial trace", so a
    //      failed run must not leave a complete trace behind either.
    //   3. the compensating delete fails → the mismatch is real and is recorded
    //      loudly: the run row names the surviving trace in `orphan_trace_id`
    //      (the recovery hint), so the store never silently disagrees with
    //      itself.
    try {
      await this.traces().insertOne(this.privateTrace(trace));
    } catch (error) {
      return fail(`storing the salience trace failed: ${errorMessage(error)}`, {
        llm_calls: llmCalls,
        input_counts: gathered.input_counts,
        problem_state_digest: gathered.problem_state_digest,
        clamped_values: normalized.clamped_values,
        coerced_values: normalized.coerced_values,
        truncated_fields: normalized.truncated_fields,
        low_confidence_count: calibration.low_confidence_count,
        unresolved_evidence_count: validated.evidence.unresolved_evidence_count,
        unresolved_ref_count: validated.evidence.unresolved_ref_count,
      });
    }

    // The counters a failure AFTER this point still has to report, so the
    // ledger describes the work that was actually done before it broke.
    const counters: Partial<FocusedConsolidationRun> = {
      llm_calls: llmCalls,
      input_counts: gathered.input_counts,
      problem_state_digest: gathered.problem_state_digest,
      clamped_values: normalized.clamped_values,
      coerced_values: normalized.coerced_values,
      truncated_fields: normalized.truncated_fields,
      low_confidence_count: calibration.low_confidence_count,
      unresolved_evidence_count: validated.evidence.unresolved_evidence_count,
      unresolved_ref_count: validated.evidence.unresolved_ref_count,
    };

    try {
      await this.runs().updateOne(
        { idempotency_key: idempotencyKey, status: 'running' },
        { $set: { ...completed } },
      );
    } catch (error) {
      const rolledBack = await this.removeTrace(traceId, userId);
      if (rolledBack) {
        return fail(
          `recording the completed run failed: ${errorMessage(error)}; the trace it had written (${traceId}) was rolled back, so the failed run left none behind`,
          counters,
        );
      }
      // Loud, and recorded: the operator needs to be able to find this trace.
      console.error(
        `❌ focused consolidation: run ${runId} failed to record itself and its trace ${traceId} (mission ${missionId}, user ${userId}) could not be rolled back — the run row names it as orphan_trace_id.`,
      );
      return fail(
        `recording the completed run failed: ${errorMessage(error)}; rolling back trace ${traceId} ALSO failed — a complete trace was left behind and this run names it in orphan_trace_id`,
        { ...counters, orphan_trace_id: traceId },
      );
    }

    return {
      ...this.resultFrom(completed),
      status: 'completed',
      reused: false,
      trace,
    };
  }

  /**
   * Compensating action for the trace/ledger window: delete a trace whose run
   * could not be completed, so a failed run leaves no readable trace behind.
   * Bounded retry — `ORPHAN_ROLLBACK_ATTEMPTS` attempts. Returns false only
   * when a readable row is still there afterwards, which is the caller's cue
   * to record the orphan.
   */
  private async removeTrace(traceId: string, userId: string): Promise<boolean> {
    for (let attempt = 1; attempt <= ORPHAN_ROLLBACK_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.traces().deleteOne({ trace_id: traceId, user_id: userId });
        if (result.deletedCount === 1) return true;
        // Nothing matched: the row is already gone (or never committed). Only
        // a still-readable row counts as an orphan, so verify before giving up.
        const remaining = await this.traces().countDocuments({ trace_id: traceId, user_id: userId });
        if (remaining === 0) return true;
      } catch (error) {
        console.error(
          `❌ focused consolidation: rolling back trace ${traceId} failed on attempt ${attempt}/${ORPHAN_ROLLBACK_ATTEMPTS}: ${errorMessage(error)}`,
        );
      }
    }
    return false;
  }

  /**
   * Both collections are PERSONAL kinds: the scope is resolved through
   * `resolveWriteScope` (which returns `shared_id: null` for a personal kind
   * however the caller asks) and `stripSharedId` removes the field outright.
   * The kind-string never carries a request, so a payload can never widen it.
   */
  private privateScope(kind: string, userId: string): void {
    const scope = resolveWriteScope({ caller: { user_id: userId, trusted: false }, kind });
    if (scope.shared_id !== null || scope.user_id !== userId) {
      throw new FocusedConsolidationError(
        `${kind} must be private to its writer but resolved { user_id: ${scope.user_id}, shared_id: ${scope.shared_id} }`,
        'scope_violation',
      );
    }
  }

  private privateTrace(trace: SalienceTrace): SalienceTrace {
    this.privateScope(SALIENCE_TRACE_KIND, trace.user_id);
    return stripSharedId(trace) as SalienceTrace;
  }

  private privateRun(run: FocusedConsolidationRun): FocusedConsolidationRun {
    this.privateScope(FOCUSED_RUN_KIND, run.user_id);
    return stripSharedId(run) as FocusedConsolidationRun;
  }
}

/** Convenience entry point used by the MCP handler. */
export async function runFocusedConsolidation(
  db: Db,
  args: FocusedConsolidationArgs,
): Promise<FocusedConsolidationResult> {
  return new FocusedConsolidationService(db).run(args);
}
