/**
 * Cognitive mode service — thinking modes as EXPIRING assignments (ITER-8,
 * Phase 6).
 *
 * Contract: CONTRACT-iter8-cognitive-team.md §A. A mission can hold a TEAM of
 * cognitive roles: an ephemeral thinking mode laid on top of the identity's own
 * disposition, never a rewrite of it. This module owns the catalogue and the
 * lifecycle; `inheritance-envelope.ts` owns the bounded configuration a spawned
 * child inherits.
 *
 * THE CATALOGUE IS THE BRIEF'S APPENDIX C, VERBATIM. Each of the eight modes is
 * recorded with its attention bias and its obligation exactly as the brief
 * states them (`APPENDIX_C_SOURCE`), plus three things this iteration needs and
 * the brief does not spell out:
 *
 *   - `approved_dimensions` — the CLOSED vocabulary of bounded configuration
 *     dimensions this mode may bias (`APPROVED_DIMENSIONS` in
 *     `inheritance-envelope.ts`: the retrieval relevance multiplier `k`, the
 *     vector fetch limit and the per-source cap `cap_pct`). A hard invariant
 *     (the agent-message priority, the working-memory/vector floors, the
 *     per-source cap BOUNDS, the privacy policy) is not in that vocabulary at
 *     all, so "a mode may bias an approved dimension and never a hard
 *     invariant" is a property of the vocabulary rather than a rule someone has
 *     to remember.
 *   - `default_bias` — the mission-scoped bias the mode applies to those
 *     dimensions when an envelope is created for it. It is applied through
 *     `applyBoundedMutation`, the SAME clamp/refuse path a caller's request
 *     takes, so a mode can never step outside the documented ranges either.
 *   - `engine_mode` — which spread the ITER-6 operator plan runs in
 *     (`explore` prefers untouched families, `exploit` is strictly
 *     score-ordered, `balanced` is the documented middle). This is how a mode
 *     reaches the generation it drives without reimplementing the engine.
 *
 * MODES EXPIRE. Every assignment carries a required reason, a start and an
 * explicit `expires_at` computed from its TTL. EXPIRY IS COMPUTED AT READ — no
 * cron, no sweep, no background timer (`activeMode`), and the transition is
 * recorded ONCE (`status: 'expired'` + the expiry record) behind a guarded
 * update that pins the row's `expires_at` to the exact window THIS READ computed
 * from. Pinning the window is what keeps a read from shortening a live mode: a
 * renewal that lands between the read and the write moves `expires_at`, so the
 * stale guard matches nothing, and the losing read RE-READS and reports the row
 * as it now is instead of stamping its own stale conclusion on it. A mode never
 * silently extends: the only code that moves `expires_at` is `renewMode`, which
 * requires a reason and appends a renewal record. An expired assignment cannot
 * be renewed at all — a lapsed mode is replaced by an explicit new assignment.
 *
 * BOUNDS ARE ENFORCED IN THE SERVICE, not only in the MCP schema: a reason is
 * required, non-empty and capped at `MAX_REASON_LENGTH` characters, and a TTL
 * must be an INTEGER NUMBER of milliseconds inside the documented window —
 * `'60000'` is refused (`ttl_out_of_range`) rather than coerced by `Number()`
 * into a window the tool's own schema would have rejected. A mode is working
 * state, so `assignMode` also refuses one for a mission that is not RUNNABLE:
 * `completed`, `cancelled` or any state that is not `active`/`paused` is refused
 * BY NAME (`mission_not_runnable`) before anything is written — the same
 * understanding of "a mission that is over" that `work-item-generator.ts` and
 * `imagination-cycle-service.ts` use. A mission the service cannot see at all is
 * left to the transport's visibility check.
 *
 * PINNING. An identity may only assign, renew, expire and read its OWN modes;
 * a trusted caller may act for any identity. A mission-scoped mode is visible to
 * the mission's OWNER under the owner's own identity — the tools look the mission
 * up to decide who may name a `user_id` at all and REFUSE an untrusted caller
 * that names another identity, rather than silently answering for the caller's
 * own — and every read and write is pinned to `caller` in the SERVICE as well as
 * at the transport, exactly as `personality-config-service.ts` does.
 *
 * NOTHING HERE IS SHARED. The rows are a personal kind
 * (`cognitive-team-collections.ts`), every write resolves `shared_id: null` and
 * is `stripSharedId`-ed, and the row carries no private memory: the reason text
 * the caller supplied, the mode, the window, the policy names and the parent's
 * disposition VERSION — never a journal, a reflection, a trace, a seed or a
 * belief.
 */
import type { Db } from 'mongodb';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { resolveWriteScope, stripSharedId } from '../memory/write-scope-policy.js';
import { snapshotPersonalityConfig } from '../integration/personality-config-service.js';
import {
  COGNITIVE_TEAM_COLLECTIONS,
  MODE_ASSIGNMENT_KIND,
  ensureCognitiveTeamIndexes,
} from './cognitive-team-collections.js';
import { derivedId, hashSeed, sha256Hex, stableStringify } from './imagination-operators.js';
import { APPROVED_DIMENSIONS, type ApprovedDimension } from './inheritance-policy.js';
import type { DescriptorDimension } from './idea-archive-service.js';

// ── Flag ────────────────────────────────────────────────────────────────────

/**
 * `COGNITIVE_TEAM_ALLOCATION` — default OFF, truthy `1|true|yes`
 * (case-insensitive, surrounding whitespace ignored), exactly like every other
 * flag in this repo. It FAILS CLOSED: unset, empty or anything else is off, so a
 * typo never enables the family. It gates the whole MCP surface of this
 * iteration — with it off the six tools are not registered AND the dispatch
 * re-check throws the plain `Unknown tool` error, so the surface is
 * indistinguishable from not existing.
 */
export function cognitiveTeamAllocationEnabled(): boolean {
  const value = (process.env.COGNITIVE_TEAM_ALLOCATION ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

// ── The catalogue (brief Appendix C) ────────────────────────────────────────

/** Where the verbatim strings below come from. */
export const APPENDIX_C_SOURCE =
  'Katra Imagination & Memory Personality Implementation Brief — Appendix C, "Suggested initial thinking modes".';

export const COGNITIVE_MODE_NAMES = [
  'philosopher',
  'technician',
  'strategist',
  'creative',
  'analyst',
  'critic',
  'verifier',
  'synthesizer',
] as const;

export type CognitiveMode = (typeof COGNITIVE_MODE_NAMES)[number];

/** The engine's plan spread a mode drives (`imagination-operators.planOperators`). */
export type EngineMode = 'explore' | 'exploit' | 'balanced';

export interface ModeAttentionBins {
  dimension: DescriptorDimension;
  bins: readonly string[];
}

export interface CognitiveModeSpec {
  mode: CognitiveMode;
  /** The Appendix C table's own label (differing only for `critic`). */
  label: string;
  /** Appendix C, "Attention bias" — verbatim. */
  attention_bias: string;
  /** Appendix C, "Obligation" — verbatim. */
  obligation: string;
  /** The approved dimensions this mode may bias. Never a hard invariant. */
  approved_dimensions: readonly ApprovedDimension[];
  /**
   * The mission-scoped bias this mode applies to those dimensions (multipliers
   * of the parent's own value), applied through `applyBoundedMutation` — i.e.
   * clamped to the documented ranges like any other request.
   */
  default_bias: Partial<Record<ApprovedDimension, number>>;
  /** The descriptor bins this mode tends to occupy (allocation coverage). */
  attention_bins: readonly ModeAttentionBins[];
  /** Which spread the ITER-6 operator plan runs in for this mode. */
  engine_mode: EngineMode;
  /**
   * How many operator families a generation round runs for this mode — the
   * second of the two knobs the mode turns on the ITER-6 engine (the first is
   * `engine_mode`). A wide attention bias (philosopher, creative) spreads over
   * many families; a convergent one (strategist, critic, verifier) runs the two
   * the trace presses hardest on. The engine clamps this to its own budget, so a
   * mode can lower it and never raise it above the deployment's cap.
   */
  operator_budget: number;
  /** What expiry does — the brief's "reset behavior". */
  reset_behaviour: string;
}

/**
 * The reset behaviour of every mode in this iteration: the mission-scoped bias
 * is dropped at expiry and the identity resolves its own disposition again.
 * Expiry never writes anything back into the parent's configuration — the
 * bounded mutation only ever existed on the envelope.
 */
export const RESET_BEHAVIOUR = 'return_to_parent_disposition';

export const COGNITIVE_MODES: Record<CognitiveMode, CognitiveModeSpec> = {
  philosopher: {
    mode: 'philosopher',
    label: 'Philosopher',
    attention_bias: 'Assumptions, meanings, category errors, first principles',
    obligation: 'Return clarified premises and implications, not only abstractions.',
    approved_dimensions: ['k'],
    default_bias: { k: 0.9 },
    attention_bins: [
      { dimension: 'representation', bins: ['prose'] },
      { dimension: 'violated_assumption', bins: ['necessity', 'sufficiency'] },
      { dimension: 'evidence_family', bins: ['epistemic_ledger'] },
      { dimension: 'test_strategy', bins: ['observation_study'] },
    ],
    engine_mode: 'explore',
    operator_budget: 6,
    reset_behaviour: RESET_BEHAVIOUR,
  },
  technician: {
    mode: 'technician',
    label: 'Technician',
    attention_bias: 'Mechanisms, interfaces, failure modes, reproducibility',
    obligation: 'Return executable tests or concrete implementation deltas.',
    approved_dimensions: ['vector_fetch_limit', 'cap_pct'],
    default_bias: { vector_fetch_limit: 0.6, cap_pct: 0.9 },
    attention_bins: [
      { dimension: 'mechanism', bins: ['substitution', 'composition'] },
      { dimension: 'representation', bins: ['protocol'] },
      { dimension: 'evidence_family', bins: ['operational_state'] },
      { dimension: 'test_strategy', bins: ['instrumentation', 'cheapest_probe'] },
    ],
    engine_mode: 'balanced',
    operator_budget: 3,
    reset_behaviour: RESET_BEHAVIOUR,
  },
  strategist: {
    mode: 'strategist',
    label: 'Strategist',
    attention_bias: 'Dependencies, sequencing, leverage, opportunity cost',
    obligation: 'Return portfolio and decision consequences.',
    approved_dimensions: ['cap_pct'],
    default_bias: { cap_pct: 0.85 },
    attention_bins: [
      { dimension: 'violated_assumption', bins: ['independence'] },
      { dimension: 'evidence_family', bins: ['work_queue'] },
      { dimension: 'test_strategy', bins: ['simulation', 'ab_test'] },
    ],
    engine_mode: 'exploit',
    operator_budget: 2,
    reset_behaviour: RESET_BEHAVIOUR,
  },
  creative: {
    mode: 'creative',
    label: 'Creative',
    attention_bias: 'Remote analogies, inversion, representation shifts',
    obligation: 'Return diverse seeds with explicit bridges and cheap tests.',
    approved_dimensions: ['vector_fetch_limit', 'k'],
    default_bias: { vector_fetch_limit: 1.4, k: 1.1 },
    attention_bins: [
      { dimension: 'mechanism', bins: ['reversal', 'relocation', 'composition'] },
      { dimension: 'representation', bins: ['graph'] },
      { dimension: 'evidence_family', bins: ['external_observation'] },
      { dimension: 'test_strategy', bins: ['cheapest_probe'] },
    ],
    engine_mode: 'explore',
    operator_budget: 6,
    reset_behaviour: RESET_BEHAVIOUR,
  },
  analyst: {
    mode: 'analyst',
    label: 'Analyst',
    attention_bias: 'Evidence quality, decomposition, quantitative structure',
    obligation: 'Return calibrated confidence and competing explanations.',
    approved_dimensions: ['k', 'cap_pct'],
    default_bias: { k: 1.05, cap_pct: 0.9 },
    attention_bins: [
      { dimension: 'representation', bins: ['numeric'] },
      { dimension: 'evidence_family', bins: ['temporal_series'] },
      { dimension: 'test_strategy', bins: ['instrumentation', 'observation_study'] },
    ],
    engine_mode: 'balanced',
    operator_budget: 3,
    reset_behaviour: RESET_BEHAVIOUR,
  },
  critic: {
    mode: 'critic',
    label: 'Critic / red-team',
    attention_bias: 'Hidden assumptions, counterexamples, adversarial cases',
    obligation: 'Attack ideas without silently replacing the objective.',
    approved_dimensions: ['cap_pct'],
    default_bias: { cap_pct: 0.75 },
    attention_bins: [
      { dimension: 'violated_assumption', bins: ['stability', 'identity'] },
      { dimension: 'evidence_family', bins: ['trace_absence'] },
      { dimension: 'test_strategy', bins: ['kill_criterion'] },
    ],
    engine_mode: 'exploit',
    operator_budget: 2,
    reset_behaviour: RESET_BEHAVIOUR,
  },
  verifier: {
    mode: 'verifier',
    label: 'Verifier',
    attention_bias: 'Formal checks, experiments, source/proof validation',
    obligation: 'Independent evaluation; may not grade its own generated seed.',
    approved_dimensions: ['cap_pct', 'vector_fetch_limit'],
    default_bias: { cap_pct: 0.8, vector_fetch_limit: 0.8 },
    attention_bins: [
      { dimension: 'representation', bins: ['protocol'] },
      { dimension: 'evidence_family', bins: ['operational_state'] },
      { dimension: 'test_strategy', bins: ['kill_criterion', 'cheapest_probe'] },
    ],
    engine_mode: 'exploit',
    operator_budget: 2,
    reset_behaviour: RESET_BEHAVIOUR,
  },
  synthesizer: {
    mode: 'synthesizer',
    label: 'Synthesizer',
    attention_bias: 'Complementarity and compression across portfolios',
    obligation: 'Preserve lineage, disagreements and exclusion reasons.',
    approved_dimensions: ['vector_fetch_limit'],
    default_bias: { vector_fetch_limit: 1.2 },
    attention_bins: [
      { dimension: 'mechanism', bins: ['composition'] },
      { dimension: 'representation', bins: ['table', 'list'] },
      { dimension: 'violated_assumption', bins: ['independence'] },
    ],
    engine_mode: 'balanced',
    operator_budget: 4,
    reset_behaviour: RESET_BEHAVIOUR,
  },
};

export function isCognitiveMode(value: unknown): value is CognitiveMode {
  return typeof value === 'string' && (COGNITIVE_MODE_NAMES as readonly string[]).includes(value);
}

/** The catalogue entry, or null for a name that is not a mode. */
export function modeSpec(mode: unknown): CognitiveModeSpec | null {
  return isCognitiveMode(mode) ? COGNITIVE_MODES[mode] : null;
}

/** The bins of a mode as `dimension=bin` strings (the allocation vocabulary). */
export function modeBinLabels(mode: CognitiveModeSpec): string[] {
  return mode.attention_bins.flatMap((entry) => entry.bins.map((bin) => `${entry.dimension}=${bin}`));
}

// ── Assignment shape ────────────────────────────────────────────────────────

export const MODE_POLICY_VERSION = '1.0';
export const INHERITANCE_POLICY = 'bounded_mission_scoped';

/** Default window: four hours of one mission. */
export const DEFAULT_MODE_TTL_MS = 4 * 60 * 60 * 1000;
/** Floor: a mode shorter than a minute is not a mode, it is a typo. */
export const MIN_MODE_TTL_MS = 60 * 1000;
/** Ceiling: a week. A mode is ephemeral; anything longer is a disposition change. */
export const MAX_MODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The maximum length of a stored reason — the SAME cap the MCP schema applies
 * (`z.string().min(1).max(500)`), enforced here as well so a service caller
 * cannot store a megabyte of prose where the tool would have refused it.
 */
export const MAX_REASON_LENGTH = 500;

/**
 * The mission statuses a mode may be assigned on. A mode is the working state of
 * a mission that is still running: `paused` is live (a paused mission keeps its
 * modes), while `draft` — and any status this iteration does not know — is not,
 * and is refused rather than guessed at.
 */
export const RUNNABLE_MISSION_STATUSES = ['active', 'paused'] as const;

/** The statuses that make a mission terminal, named for the refusal. */
export const TERMINAL_MISSION_STATUSES = ['completed', 'cancelled'] as const;

export type ModeAssignmentStatus = 'active' | 'expired';

export interface ModeRenewal {
  at: string;
  by: string;
  reason: string;
  ttl_ms: number;
  expires_at: string;
}

export interface ModeExpiry {
  at: string;
  by: string;
  reason: string;
}

export interface ThinkingModeAssignment {
  schema_version: '1.0';
  assignment_id: string;
  user_id: string;
  mission_id: string;
  mode: CognitiveMode;
  /** Why the mode was taken on — required, non-empty, stored verbatim. */
  reason: string;
  /** The identity that made the assignment. */
  actor_id: string;
  status: ModeAssignmentStatus;
  started_at: string;
  expires_at: string;
  ttl_ms: number;
  policy_version: string;
  inheritance_policy: string;
  /** The parent's disposition VERSION at assignment time (null when unversioned). */
  snapshot_version: number | null;
  reset_behaviour: string;
  /** Explicit renewals, in order. The ONLY records that move `expires_at`. */
  renewals: ModeRenewal[];
  /** Set once, by the read-computed expiry or by an explicit expire. */
  expiry: ModeExpiry | null;
  created_at: string;
  updated_at: string;
}

/** Codes a caller can be refused with, by name. */
export type ModeErrorCode =
  | 'invalid_args'
  | 'reason_required'
  | 'reason_too_long'
  | 'unknown_mode'
  | 'ttl_out_of_range'
  | 'mission_not_runnable'
  | 'not_found'
  | 'already_expired'
  | 'mode_expired'
  | 'conflict';

export class CognitiveModeError extends Error {
  constructor(message: string, readonly code: ModeErrorCode) {
    super(message);
    this.name = 'CognitiveModeError';
  }
}

/** Raised when an untrusted caller acts for, or reads, another identity. */
export class ModeAccessError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ModeAccessError';
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The assignment's GRANT: the fields that make the assignment what it is, and
 * the only ones an assignment's hash covers. Renewals and the expiry record are
 * deliberately OUTSIDE it — a renewal moves the window, and the expiry closes
 * it, without either of them rewriting the grant the caller asked for.
 */
export function assignmentGrant(assignment: Record<string, unknown>): Record<string, unknown> {
  return {
    assignment_id: assignment.assignment_id,
    user_id: assignment.user_id,
    mission_id: assignment.mission_id,
    mode: assignment.mode,
    reason: assignment.reason,
    actor_id: assignment.actor_id,
    started_at: assignment.started_at,
    ttl_ms: assignment.ttl_ms,
    policy_version: assignment.policy_version,
    inheritance_policy: assignment.inheritance_policy,
    snapshot_version: assignment.snapshot_version,
    reset_behaviour: assignment.reset_behaviour,
  };
}

export function assignmentGrantHash(assignment: Record<string, unknown>): string {
  return `sha256:${sha256Hex(stableStringify(assignmentGrant(assignment)))}`;
}
/** The closed key set of a stored assignment — an extra key is a hard failure. */
export const ASSIGNMENT_KEYS: readonly string[] = [
  'schema_version',
  'assignment_id',
  'user_id',
  'mission_id',
  'mode',
  'reason',
  'actor_id',
  'status',
  'started_at',
  'expires_at',
  'ttl_ms',
  'policy_version',
  'inheritance_policy',
  'snapshot_version',
  'reset_behaviour',
  'grant_hash',
  'renewals',
  'expiry',
  'created_at',
  'updated_at',
];

export interface AssignmentIntegrity {
  ok: boolean;
  code: 'schema_invalid' | 'version_unsupported' | 'grant_hash_mismatch' | null;
  reason: string;
}

/**
 * Verify a stored assignment before it is served: the format version, the
 * CLOSED key set (an extra key fails) and the recomputed grant hash. A row
 * tampered with after the write — a rewritten reason, a moved start, a swapped
 * mode — is refused by name instead of being reported as the grant the caller
 * holds.
 */
export function verifyAssignment(stored: Record<string, unknown> | null | undefined): AssignmentIntegrity {
  if (!stored) return { ok: false, code: 'schema_invalid', reason: 'no stored mode assignment' };
  if (stored.schema_version !== '1.0') {
    return {
      ok: false,
      code: 'version_unsupported',
      reason: `mode assignment schema_version ${String(stored.schema_version ?? '(missing)')} is not 1.0`,
    };
  }
  for (const key of Object.keys(stored)) {
    if (!ASSIGNMENT_KEYS.includes(key)) {
      return { ok: false, code: 'schema_invalid', reason: `unexpected field '${key}' on a mode assignment` };
    }
  }
  if (!isCognitiveMode(stored.mode)) {
    return { ok: false, code: 'schema_invalid', reason: `unknown mode '${String(stored.mode)}'` };
  }
  const recomputed = assignmentGrantHash(stored);
  const declared = nonEmpty(stored.grant_hash);
  if (recomputed !== declared) {
    return {
      ok: false,
      code: 'grant_hash_mismatch',
      reason: `stored grant hash ${declared ?? '(missing)'} does not match the recomputed ${recomputed}`,
    };
  }
  return { ok: true, code: null, reason: 'verified' };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export interface ModeCaller {
  user_id: string;
  trusted: boolean;
}

function pinWrite(caller: ModeCaller | undefined, userId: string, action: string): void {
  if (caller && !caller.trusted && caller.user_id !== userId) {
    throw new ModeAccessError(`Caller '${caller.user_id}' may not ${action} for '${userId}'`);
  }
}

function pinRead(caller: ModeCaller | undefined, userId: string, action: string): void {
  if (caller && !caller.trusted && caller.user_id !== userId) {
    throw new ModeAccessError(`Caller '${caller.user_id}' may not ${action} for '${userId}'`);
  }
}

function nowIso(now?: () => string): string {
  return (now ?? (() => new Date().toISOString()))();
}

/**
 * A reason is REQUIRED, non-empty and capped in the SERVICE — the MCP schema's
 * `max(500)` is a transport bound, and a service caller must not be able to
 * store a megabyte of prose where the tool would have refused it.
 */
function validReason(reason: unknown, message: string): string {
  const value = nonEmpty(reason);
  if (!value) throw new CognitiveModeError(message, 'reason_required');
  if (value.length > MAX_REASON_LENGTH) {
    throw new CognitiveModeError(
      `reason is ${value.length} characters; the documented cap is ${MAX_REASON_LENGTH} (it is refused, never truncated)`,
      'reason_too_long',
    );
  }
  return value;
}

function validTtl(ttlMs: unknown): number {
  // A NUMBER only: `Number('60000')` used to coerce a string into a window the
  // tool's own `z.number().int()` schema would have refused, so the service
  // accepted calls the transport rejects. No coercion here.
  if (typeof ttlMs !== 'number') {
    throw new CognitiveModeError(
      `ttl_ms must be a NUMBER of milliseconds (received ${ttlMs === null ? 'null' : typeof ttlMs}); a string is refused, never coerced`,
      'ttl_out_of_range',
    );
  }
  const value = ttlMs;
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new CognitiveModeError('ttl_ms must be an integer number of milliseconds', 'ttl_out_of_range');
  }
  if (value < MIN_MODE_TTL_MS || value > MAX_MODE_TTL_MS) {
    throw new CognitiveModeError(
      `ttl_ms ${value} is outside the documented window ${MIN_MODE_TTL_MS}..${MAX_MODE_TTL_MS} (a mode is ephemeral; it is neither clamped nor silently extended)`,
      'ttl_out_of_range',
    );
  }
  return value;
}

/**
 * A mode is working state, so it may only be granted on a mission that is still
 * RUNNABLE. The check follows the codebase's own understanding of a mission that
 * is over (`work-item-generator.ts`, `imagination-cycle-service.ts`); the one
 * difference is that the statuses it DOES understand are an allow-list here, so
 * an unknown state is refused rather than guessed at. A mission the store cannot
 * see — no row, or a row with no status — is left to the transport's mission
 * visibility check rather than being refused here.
 */
async function assertMissionRunnable(db: Db, missionId: string): Promise<void> {
  const state = (await db
    .collection('mission_states')
    .findOne({ mission_id: missionId }, { projection: { _id: 0, status: 1 } })) as { status?: unknown } | null;
  const status = typeof state?.status === 'string' && state.status.trim().length > 0 ? state.status.trim() : null;
  if (status === null) return;
  if ((RUNNABLE_MISSION_STATUSES as readonly string[]).includes(status)) return;
  const named = (TERMINAL_MISSION_STATUSES as readonly string[]).includes(status)
    ? `mission ${missionId} is '${status}' (terminal)`
    : `mission ${missionId} is '${status}', which is not a runnable state (runnable: ${RUNNABLE_MISSION_STATUSES.join(', ')})`;
  throw new CognitiveModeError(
    `${named}: a thinking mode may only be assigned on a mission that is still running — a mode on finished or unstarted work would be a disposition for work that is over`,
    'mission_not_runnable',
  );
}

export interface AssignModeArgs {
  userId: string;
  missionId: string;
  mode: CognitiveMode | string;
  reason: string;
  ttlMs?: number;
  actorId?: string;
  caller?: CallerIdentity;
  now?: () => string;
}

/**
 * Assign a mode to an identity for a mission. The reason is REQUIRED and stored
 * verbatim (capped at `MAX_REASON_LENGTH`), the TTL is explicit (default
 * `DEFAULT_MODE_TTL_MS`, a NUMBER and refused outside the documented window
 * rather than clamped), the mission must still be runnable (a terminal mission
 * is refused by name, before anything is written), and the grant hash is written
 * over the immutable part of the row. Idempotent by derived id: assigning the
 * same mode over the same reason and window returns the stored row instead of
 * writing a second one.
 */
export async function assignMode(db: Db, args: AssignModeArgs): Promise<ThinkingModeAssignment> {
  const userId = nonEmpty(args.userId);
  const missionId = nonEmpty(args.missionId);
  if (!userId) throw new CognitiveModeError('userId is required', 'invalid_args');
  if (!missionId) throw new CognitiveModeError('missionId is required', 'invalid_args');
  if (!isCognitiveMode(args.mode)) {
    throw new CognitiveModeError(
      `Unknown thinking mode '${String(args.mode)}'. Valid: ${COGNITIVE_MODE_NAMES.join(', ')}`,
      'unknown_mode',
    );
  }
  const reason = validReason(args.reason, 'reason is required: every mode assignment records why it was taken on');
  const actorId = nonEmpty(args.actorId) ?? args.caller?.user_id ?? userId;
  const ttlMs = args.ttlMs === undefined ? DEFAULT_MODE_TTL_MS : validTtl(args.ttlMs);
  pinWrite(args.caller, userId, 'assign a thinking mode');
  // Refused BEFORE any write (and before the lazy index creation), so a refused
  // assignment touches nothing at all.
  await assertMissionRunnable(db, missionId);

  await ensureCognitiveTeamIndexes(db);

  const now = args.now ?? (() => new Date().toISOString());
  const startedAt = nowIso(now);
  const expiresAt = new Date(Date.parse(startedAt) + ttlMs).toISOString();
  const spec = COGNITIVE_MODES[args.mode];

  // The parent's disposition VERSION at assignment time: a read-only snapshot
  // (never a write, never a migration) so the assignment records which version
  // of the identity's configuration it was made against.
  let snapshotVersion: number | null = null;
  try {
    const snapshot = await snapshotPersonalityConfig(db, userId);
    snapshotVersion = typeof snapshot.version === 'number' && Number.isFinite(snapshot.version) ? snapshot.version : null;
  } catch {
    snapshotVersion = null;
  }

  const assignmentId = derivedId(
    'mode',
    {
      user_id: userId,
      mission_id: missionId,
      mode: args.mode,
      reason,
      started_at: startedAt,
      ttl_ms: ttlMs,
    },
    hashSeed(`thinking_mode:${userId}:${missionId}`),
  );

  const assignment: ThinkingModeAssignment = {
    schema_version: '1.0',
    assignment_id: assignmentId,
    user_id: userId,
    mission_id: missionId,
    mode: args.mode,
    reason,
    actor_id: actorId,
    status: 'active',
    started_at: startedAt,
    expires_at: expiresAt,
    ttl_ms: ttlMs,
    policy_version: MODE_POLICY_VERSION,
    inheritance_policy: INHERITANCE_POLICY,
    snapshot_version: snapshotVersion,
    reset_behaviour: spec.reset_behaviour,
    renewals: [],
    expiry: null,
    created_at: startedAt,
    updated_at: startedAt,
  };
  (assignment as unknown as Record<string, unknown>).grant_hash = assignmentGrantHash(
    assignment as unknown as Record<string, unknown>,
  );

  const scope = resolveWriteScope({ caller: { user_id: userId, trusted: false }, kind: MODE_ASSIGNMENT_KIND });
  if (scope.shared_id !== null || scope.user_id !== userId) {
    throw new CognitiveModeError(
      `thinking_mode_assignments must be written privately but resolved { user_id: ${scope.user_id}, shared_id: ${scope.shared_id} }`,
      'invalid_args',
    );
  }
  const doc = stripSharedId(assignment);
  const collection = db.collection(COGNITIVE_TEAM_COLLECTIONS.modeAssignments);
  const existing = (await collection.findOne({ assignment_id: assignmentId }, { projection: { _id: 0 } })) as
    | Record<string, unknown>
    | null;
  if (existing) return assertAssignment(existing);
  try {
    await collection.insertOne(doc as never);
  } catch {
    // Two concurrent identical assignments race on the unique id; the loser
    // reads the winner's row rather than writing a second grant.
    const winner = (await collection.findOne({ assignment_id: assignmentId }, { projection: { _id: 0 } })) as
      | Record<string, unknown>
      | null;
    if (!winner) throw new CognitiveModeError('the assignment could not be stored', 'conflict');
    return assertAssignment(winner);
  }
  return doc;
}

function assertAssignment(stored: Record<string, unknown>): ThinkingModeAssignment {
  const integrity = verifyAssignment(stored);
  if (!integrity.ok) throw new CognitiveModeError(integrity.reason, 'conflict');
  return stored as unknown as ThinkingModeAssignment;
}

/** Expiry is a COMPUTED property, at read, from the stored window. */
export function isExpired(assignment: Pick<ThinkingModeAssignment, 'expires_at' | 'status'>, atMs: number): boolean {
  if (assignment.status === 'expired') return true;
  const expiry = Date.parse(String(assignment.expires_at));
  return Number.isFinite(expiry) ? atMs >= expiry : false;
}

export interface ActiveModeArgs {
  userId: string;
  missionId: string;
  caller?: CallerIdentity;
  now?: () => string;
}

export interface ActiveModeResult {
  /** The mode in force, or the newest recorded assignment when none is. */
  assignment: ThinkingModeAssignment | null;
  /** The catalogue entry for it, when there is one. */
  mode: CognitiveModeSpec | null;
  /** True when the returned assignment is still active. */
  active: boolean;
  /** True when THIS read recorded the expiry OF THE RETURNED assignment. */
  expired_now: boolean;
  /** How many lapsed assignments this read recorded (each exactly once). */
  expiries_recorded: number;
  /** How many assignments this mission holds in total (bounded scan). */
  assignments_total: number;
}

/**
 * The mode in force for `{userId, missionId}` — expiry COMPUTED AT READ. Every
 * lapsed assignment this read sees is recorded as `expired` exactly once
 * (guarded update: a second read writes nothing) and the live one is returned;
 * a mission with no live assignment returns its newest (expired) one, so the
 * caller learns the mode lapsed instead of being told there never was one.
 *
 * The guard pins the EXACT `expires_at` this read computed from, so a read
 * cannot shorten a mode that a concurrent `renewMode` has just extended: the
 * stale guard matches nothing, and the losing read re-reads the row and reports
 * the current state instead of writing its own stale conclusion.
 */
export async function activeMode(db: Db, args: ActiveModeArgs): Promise<ActiveModeResult> {
  const userId = nonEmpty(args.userId);
  const missionId = nonEmpty(args.missionId);
  if (!userId) throw new CognitiveModeError('userId is required', 'invalid_args');
  if (!missionId) throw new CognitiveModeError('missionId is required', 'invalid_args');
  pinRead(args.caller, userId, 'read the thinking mode of');

  const now = args.now ?? (() => new Date().toISOString());
  const at = nowIso(now);
  const nowMs = Date.parse(at);
  const collection = db.collection(COGNITIVE_TEAM_COLLECTIONS.modeAssignments);
  const rows = (await collection
    .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })
    .sort({ started_at: -1, assignment_id: 1 })
    .limit(50)
    .toArray()) as unknown as Array<Record<string, unknown>>;

  const lapsed: ThinkingModeAssignment[] = [];
  let live: ThinkingModeAssignment | null = null;
  let recorded = 0;

  for (const row of rows) {
    const assignment = assertAssignment(row);
    if (!isExpired(assignment, nowMs)) {
      if (!live) live = assignment;
      continue;
    }
    if (assignment.status !== 'active') {
      lapsed.push(assignment);
      continue;
    }
    // The read-computed transition: ONE guarded write per assignment, matching
    // only a row that is still active AND still carries the exact window this
    // read computed the conclusion from. Renewal is the only thing that moves
    // `expires_at`, so pinning it is what stops an interleaved renewal from
    // being reverted by a stale read; the stored window is never touched.
    const expiry: ModeExpiry = { at, by: 'ttl', reason: 'ttl_elapsed' };
    const result = await collection.updateOne(
      { assignment_id: assignment.assignment_id, status: 'active', expires_at: assignment.expires_at },
      { $set: { status: 'expired', expiry, updated_at: at } },
    );
    const matched = Number((result as { matchedCount?: number }).matchedCount ?? 0) > 0;
    if (matched) {
      recorded += 1;
      lapsed.push({ ...assignment, status: 'expired', expiry, updated_at: at });
      continue;
    }
    // The guard lost: the row changed under this read (a renewal moved the
    // window, or another writer closed it). RE-READ and report the state that is
    // actually stored — never write the stale read's conclusion over it.
    const fresh = (await collection.findOne(
      { assignment_id: assignment.assignment_id },
      { projection: { _id: 0 } },
    )) as Record<string, unknown> | null;
    if (!fresh) {
      lapsed.push(assignment);
      continue;
    }
    const current = assertAssignment(fresh);
    if (isExpired(current, nowMs)) lapsed.push(current);
    else if (!live) live = current;
  }

  if (live) {
    return {
      assignment: live,
      mode: COGNITIVE_MODES[live.mode] ?? null,
      active: true,
      expired_now: false,
      expiries_recorded: recorded,
      assignments_total: rows.length,
    };
  }
  const newest = lapsed[0] ?? null;
  return {
    assignment: newest,
    mode: newest ? COGNITIVE_MODES[newest.mode] ?? null : null,
    active: false,
    expired_now: newest !== null && newest.status === 'expired' && recorded > 0,
    expiries_recorded: recorded,
    assignments_total: rows.length,
  };
}

export interface ExpireModeArgs {
  assignmentId: string;
  actorId?: string;
  reason: string;
  caller?: CallerIdentity;
  now?: () => string;
}

export interface ExpireModeResult {
  expired: boolean;
  code: 'expired' | 'already_expired' | null;
  reason: string;
  assignment: ThinkingModeAssignment | null;
}

/**
 * EXPLICIT expiry: the caller ends a mode early. The reason is required, the
 * transition is guarded (an already-expired assignment is reported, not
 * re-stamped), and nothing else about the grant changes.
 */
export async function expireMode(db: Db, args: ExpireModeArgs): Promise<ExpireModeResult> {
  const assignmentId = nonEmpty(args.assignmentId);
  if (!assignmentId) throw new CognitiveModeError('assignmentId is required', 'invalid_args');
  const reason = validReason(args.reason, 'reason is required: a mode is never ended without one');
  const now = args.now ?? (() => new Date().toISOString());
  const collection = db.collection(COGNITIVE_TEAM_COLLECTIONS.modeAssignments);
  const stored = (await collection.findOne({ assignment_id: assignmentId }, { projection: { _id: 0 } })) as
    | Record<string, unknown>
    | null;
  if (!stored) return { expired: false, code: null, reason: `no such assignment: ${assignmentId}`, assignment: null };
  const assignment = assertAssignment(stored);
  pinWrite(args.caller, assignment.user_id, 'expire a thinking mode');

  const at = nowIso(now);
  const expiry: ModeExpiry = { at, by: nonEmpty(args.actorId) ?? args.caller?.user_id ?? assignment.user_id, reason };
  const result = await collection.updateOne(
    { assignment_id: assignmentId, status: 'active' },
    { $set: { status: 'expired', expiry, updated_at: at } },
  );
  const matched = Number((result as { matchedCount?: number }).matchedCount ?? 0) > 0;
  const updated = (await collection.findOne({ assignment_id: assignmentId }, { projection: { _id: 0 } })) as
    | Record<string, unknown>
    | null;
  const current = updated ? assertAssignment(updated) : assignment;
  return matched
    ? { expired: true, code: 'expired', reason: `mode '${current.mode}' expired by ${expiry.by}: ${reason}`, assignment: current }
    : {
        expired: false,
        code: 'already_expired',
        reason: `assignment ${assignmentId} is already expired (${current.expiry?.reason ?? 'recorded expiry'}); nothing was rewritten`,
        assignment: current,
      };
}

export interface RenewModeArgs {
  assignmentId: string;
  actorId?: string;
  reason: string;
  ttlMs?: number;
  caller?: CallerIdentity;
  now?: () => string;
}

export interface RenewModeResult {
  renewed: boolean;
  code: 'renewed' | 'mode_expired' | null;
  reason: string;
  assignment: ThinkingModeAssignment | null;
}

/**
 * EXPLICIT renewal — the ONLY path that moves `expires_at`. It requires a
 * reason, extends from `max(now, current expiry)` so an active window is never
 * shortened, and appends a renewal record. An EXPIRED assignment is refused by
 * name: a lapsed mode is replaced by a new assignment, never revived in place.
 * A renewal is also refused by name on a mission that is no longer runnable:
 * extending a mode is keeping working state alive, and a mission that is over
 * has no work to keep alive.
 */
export async function renewMode(db: Db, args: RenewModeArgs): Promise<RenewModeResult> {
  const assignmentId = nonEmpty(args.assignmentId);
  if (!assignmentId) throw new CognitiveModeError('assignmentId is required', 'invalid_args');
  const reason = validReason(args.reason, 'reason is required: a renewal is an explicit act');
  const ttlMs = args.ttlMs === undefined ? null : validTtl(args.ttlMs);
  const now = args.now ?? (() => new Date().toISOString());
  const collection = db.collection(COGNITIVE_TEAM_COLLECTIONS.modeAssignments);
  const stored = (await collection.findOne({ assignment_id: assignmentId }, { projection: { _id: 0 } })) as
    | Record<string, unknown>
    | null;
  if (!stored) throw new CognitiveModeError(`no such assignment: ${assignmentId}`, 'not_found');
  const assignment = assertAssignment(stored);
  pinWrite(args.caller, assignment.user_id, 'renew a thinking mode');
  await assertMissionRunnable(db, assignment.mission_id);

  const at = nowIso(now);
  if (isExpired(assignment, Date.parse(at))) {
    return {
      renewed: false,
      code: 'mode_expired',
      reason: `assignment ${assignmentId} expired at ${assignment.expires_at} and cannot be renewed: assign the mode again with a fresh reason`,
      assignment,
    };
  }

  const window = ttlMs ?? assignment.ttl_ms;
  const baseline = Math.max(Date.parse(at), Date.parse(assignment.expires_at));
  const expiresAt = new Date(baseline + window).toISOString();
  const renewal: ModeRenewal = {
    at,
    by: nonEmpty(args.actorId) ?? args.caller?.user_id ?? assignment.user_id,
    reason,
    ttl_ms: window,
    expires_at: expiresAt,
  };
  const result = await collection.updateOne(
    { assignment_id: assignmentId, status: 'active', expires_at: assignment.expires_at },
    { $push: { renewals: renewal } as never, $set: { expires_at: expiresAt, updated_at: at } },
  );
  const matched = Number((result as { matchedCount?: number }).matchedCount ?? 0) > 0;
  const updated = (await collection.findOne({ assignment_id: assignmentId }, { projection: { _id: 0 } })) as
    | Record<string, unknown>
    | null;
  const current = updated ? assertAssignment(updated) : assignment;
  if (!matched) {
    // The guarded update lost to a concurrent change: report the row as it now
    // is rather than claiming a window that was never stored.
    return {
      renewed: false,
      code: null,
      reason: `assignment ${assignmentId} changed while this renewal was being written; it now expires at ${current.expires_at}`,
      assignment: current,
    };
  }
  return {
    renewed: true,
    code: 'renewed',
    reason: `mode '${current.mode}' renewed by ${renewal.by} until ${expiresAt}: ${reason}`,
    assignment: current,
  };
}

export interface ListAssignmentsArgs {
  userId: string;
  missionId?: string;
  limit?: number;
  caller?: CallerIdentity;
}

/** The caller's own assignments (trusted callers may name any identity). */
export async function listAssignments(db: Db, args: ListAssignmentsArgs): Promise<ThinkingModeAssignment[]> {
  const userId = nonEmpty(args.userId);
  if (!userId) throw new CognitiveModeError('userId is required', 'invalid_args');
  pinRead(args.caller, userId, 'list the thinking modes of');
  const filter: Record<string, unknown> = { user_id: userId };
  if (nonEmpty(args.missionId)) filter.mission_id = nonEmpty(args.missionId);
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 20), 1), 50);
  const rows = (await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.modeAssignments)
    .find(filter, { projection: { _id: 0 } })
    .sort({ started_at: -1, assignment_id: 1 })
    .limit(limit)
    .toArray()) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => assertAssignment(row));
}
