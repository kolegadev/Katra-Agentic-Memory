/**
 * Inheritance envelope — bounded, immutable-bounded inheritance (ITER-8,
 * Phase 6).
 *
 * Contract: CONTRACT-iter8-cognitive-team.md §B. The brief's §4.4 rule is:
 * "Sub-agents receive `parent_identity_id` and an immutable disposition
 * snapshot/version, not the parent's private journals or reflection documents"
 * and "Child may apply a small mission-scoped mutation to approved dimensions;
 * hard floors, caps, message priority and privacy policy are immutable".
 *
 * THIS MODULE IS THAT RULE. An envelope is an IMMUTABLE REFERENCE — it names
 * the parent identity, the parent's disposition snapshot (profile + version +
 * hash), the immutable bounds, the approved dimensions the child may bias and an
 * expiry — and nothing else. Every field is CONSTRUCTED explicitly; there is no
 * spread of a configuration record and no copy of any private store:
 *
 *   - the disposition snapshot comes from `snapshotPersonalityConfig`
 *     (`personality-config-service.ts`, the ITER-2 read-only resolver) and is
 *     reduced to `{ profile, version, hash }`: the hash is taken over the
 *     ALLOW-LISTED subset (profile, version, source_weights, scoring,
 *     max_context_tokens) and never over the identity's documents;
 *   - journals, reflections, salience traces, seeds and beliefs have no place in
 *     the shape at all — the taint suite places markers in every one of them and
 *     proves none appears in an envelope, its hash input or any tool output;
 *   - the parent's own configuration is NEVER modified: this module has no write
 *     path to `system_settings` at all (it is not imported), and a bounded
 *     mutation produces a NEW envelope derived from its parent instead of
 *     rewriting anything.
 *
 * BOUNDED MUTATION (`applyBoundedMutation`) is where the discipline is enforced.
 * A request is classified BEFORE its value is looked at:
 *
 *   - an IMMUTABLE invariant (`inheritance-invariants.ts`: the agent-message
 *     priority, the working-memory/vector floors, the per-source cap BOUNDS, the
 *     privacy policy — including every alias) is refused `immutable_invariant`;
 *   - a dimension outside the approved vocabulary is refused
 *     `dimension_not_approved`, and so is an approved dimension the MODE of this
 *     envelope may not bias;
 *   - a value that is not a finite number, or one that would widen a per-source
 *     cap above the parent's own bound, is refused `out_of_bounds`;
 *   - everything else is CLAMPED into its documented range
 *     (`inheritance-policy.ts`) and the clamp is recorded in the envelope's
 *     `mutations` history — requested value, applied value, range and source.
 *
 * The clamp is always measured against the parent's ORIGINAL values (`baseline`),
 * so a chain of small mutations can never drift beyond the documented band.
 *
 * AUTHENTICITY. `verifyEnvelope` is the same discipline the Creative Baton uses
 * (ITER-7): the format version, a CLOSED registered schema (an extra key fails
 * anywhere), the recomputed `policy_hash` over the canonical payload, and — one
 * layer stronger than a hash — the INVARIANTS re-checked on the decoded values.
 * A document that was tampered with and re-hashed is therefore still refused by
 * name if it weakened anything: the message priority is still 10.0, the floors
 * are still the parent's, the cap was not widened and the privacy policy is
 * still immutable.
 */
import type { Db } from 'mongodb';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { resolveWriteScope, stripSharedId } from '../memory/write-scope-policy.js';
import {
  effectivePersonalityConfig,
  snapshotPersonalityConfig,
  type ResolvedPersonality,
} from '../integration/personality-config-service.js';
import { SCHEMA_IDS, validateAgainst } from '../mission-cognition/schema-registry.js';
import {
  COGNITIVE_TEAM_COLLECTIONS,
  INHERITANCE_ENVELOPE_KIND,
  ensureCognitiveTeamIndexes,
} from './cognitive-team-collections.js';
import { derivedId, hashSeed, sha256Hex, stableStringify } from './imagination-operators.js';
import {
  APPROVED_DIMENSIONS,
  CAP_PCT_MAX,
  K_BAND_RATIO,
  MESSAGE_PRIORITY,
  PRIVACY_POLICY,
  VECTOR_FETCH_LIMIT_MAX,
  clampMutation,
  classifyDimension,
  dimensionRange,
  type ApprovedDimension,
  type InheritanceBaseline,
  type MutationRefusalCode,
} from './inheritance-policy.js';
import { IMMUTABLE_INVARIANT_NOTES } from './inheritance-invariants.js';
import { COGNITIVE_MODES, isCognitiveMode, type CognitiveMode } from './cognitive-mode-service.js';

export const ENVELOPE_VERSION = '1.0';

/** Default window for a spawned scope: the same four hours a mode gets. */
export const DEFAULT_ENVELOPE_TTL_MS = 4 * 60 * 60 * 1000;
export const MIN_ENVELOPE_TTL_MS = 60 * 1000;
export const MAX_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Where a mutation came from. */
export type MutationSource = 'caller' | 'mode_default_bias';

export interface EnvelopeMutation {
  dimension: ApprovedDimension;
  /** What was asked for. */
  requested: number;
  /** What is actually applied — inside the documented range. */
  applied: number;
  clamped: boolean;
  min: number;
  max: number;
  source: MutationSource;
  at: string;
  by: string;
}

export interface EnvelopeBounds {
  /** The agent-message retrieval priority — immutable, always 10.0. */
  message_priority: typeof MESSAGE_PRIORITY;
  /** The working-memory / vector-search floors inherited unchanged. */
  floors: { working_memory: number; vector_search: number };
  /** The bounds a bounded mutation may move inside (never outside). */
  caps: {
    max_single_source_pct: number;
    k_floor: number;
    k_ceiling: number;
    vector_fetch_limit_max: number;
  };
  privacy_policy: typeof PRIVACY_POLICY;
}

/** The scoring a child actually runs with: the parent's, biased in bounds. */
export interface EnvelopeEffectiveScoring {
  profile: string;
  relevance_multiplier: number;
  vector_fetch_limit: number;
  max_single_source_pct: number;
  working_memory_floor: number;
  vector_search_floor: number;
  agent_message_weight: typeof MESSAGE_PRIORITY;
}

export interface InheritanceEnvelope {
  schema_version: '1.0';
  envelope_version: '1.0';
  envelope_id: string;
  /** The id every envelope in this chain descended from (this one when root). */
  root_envelope_id: string;
  /** The envelope this one was derived from — null for a root. */
  parent_envelope_id: string | null;
  parent_identity_id: string;
  mission_id: string;
  child_label: string;
  mode: CognitiveMode | null;
  disposition_snapshot: { profile: string; version: number; hash: string };
  bounds: EnvelopeBounds;
  /** The parent's own values — every documented range is measured from here. */
  baseline: InheritanceBaseline;
  allowed_dimensions: ApprovedDimension[];
  effective_scoring: EnvelopeEffectiveScoring;
  mutations: EnvelopeMutation[];
  expires_at: string;
  policy_hash: string;
  privacy: { private_content_included: false; shared: false };
  created_at: string;
}

/** Why a stored envelope was refused, by name (never a silent null). */
export type EnvelopeIntegrityCode =
  | 'version_unsupported'
  | 'schema_invalid'
  | 'policy_hash_mismatch'
  | 'invariant_violation';

export interface EnvelopeIntegrity {
  ok: boolean;
  code: EnvelopeIntegrityCode | null;
  reason: string;
}

export class InheritanceEnvelopeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'InheritanceEnvelopeError';
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

// ── The disposition snapshot + its hash ─────────────────────────────────────

/**
 * The allow-listed subset of a resolved configuration the envelope's
 * `disposition_snapshot.hash` is taken over. The identity, the origin, the
 * timestamps and anything else the resolver reports are deliberately OUTSIDE it:
 * the hash names the DISPOSITION, not the identity's private documents.
 */
export function dispositionSnapshotInput(resolved: ResolvedPersonality): Record<string, unknown> {
  return {
    profile: resolved.profile,
    version: resolved.version,
    source_weights: resolved.source_weights,
    scoring: resolved.scoring,
    max_context_tokens: resolved.max_context_tokens,
  };
}

export function dispositionHash(resolved: ResolvedPersonality): string {
  return `sha256:${sha256Hex(stableStringify(dispositionSnapshotInput(resolved)))}`;
}

/** The parent's own values, as both the bounds and the ranges read them. */
export function baselineFrom(resolved: ResolvedPersonality): InheritanceBaseline {
  const effective = effectivePersonalityConfig(resolved);
  const scoring = effective.scoring as Record<string, unknown>;
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    k: number(scoring.relevance_multiplier, 2.0),
    vector_fetch_limit: number(scoring.vector_fetch_limit, 5),
    cap_pct: number(scoring.max_single_source_pct, 0.4),
  };
}

export function boundsFrom(resolved: ResolvedPersonality): EnvelopeBounds {
  const effective = effectivePersonalityConfig(resolved);
  const scoring = effective.scoring as Record<string, unknown>;
  const floors = (scoring.budget_floors ?? {}) as Record<string, number>;
  const baseline = baselineFrom(resolved);
  return {
    message_priority: MESSAGE_PRIORITY,
    floors: {
      working_memory: Number(floors.working_memory ?? 0.1),
      vector_search: Number(floors.vector_search ?? 0.15),
    },
    caps: {
      max_single_source_pct: round6(Math.min(CAP_PCT_MAX, baseline.cap_pct)),
      k_floor: dimensionRange('k', baseline).min,
      k_ceiling: dimensionRange('k', baseline).max,
      vector_fetch_limit_max: dimensionRange('vector_fetch_limit', baseline).max,
    },
    privacy_policy: PRIVACY_POLICY,
  };
}

/** The effective scoring an envelope's mutation chain resolves to. */
export function scoringFor(
  resolved: ResolvedPersonality,
  mutations: readonly EnvelopeMutation[],
): EnvelopeEffectiveScoring {
  const baseline = baselineFrom(resolved);
  const bounds = boundsFrom(resolved);
  let k = baseline.k;
  let vectorFetch = baseline.vector_fetch_limit;
  let cap = baseline.cap_pct;
  for (const mutation of mutations) {
    if (mutation.dimension === 'k') k = mutation.applied;
    if (mutation.dimension === 'vector_fetch_limit') vectorFetch = mutation.applied;
    if (mutation.dimension === 'cap_pct') cap = mutation.applied;
  }
  return {
    profile: resolved.profile,
    relevance_multiplier: round6(k),
    vector_fetch_limit: Math.round(vectorFetch),
    max_single_source_pct: round6(cap),
    working_memory_floor: bounds.floors.working_memory,
    vector_search_floor: bounds.floors.vector_search,
    agent_message_weight: MESSAGE_PRIORITY,
  };
}

// ── Canonical payload + hash ────────────────────────────────────────────────

/**
 * The canonical payload `policy_hash` is computed over: the stored document
 * with the hash itself removed and `privacy.shared` normalised to false (a
 * statement about the scope, not about the grant). Everything else is taken as
 * stored — which is exactly what makes a tampered half of the document change
 * the hash.
 */
export function envelopePayloadForHash(envelope: Record<string, unknown>): Record<string, unknown> {
  const { policy_hash: _policyHash, shared_id: _sharedId, ...rest } = envelope;
  const privacy = (rest.privacy ?? {}) as Record<string, unknown>;
  return { ...rest, privacy: { ...privacy, shared: false } };
}

export function envelopePolicyHash(envelope: Record<string, unknown>): string {
  return `sha256:${sha256Hex(stableStringify(envelopePayloadForHash(envelope)))}`;
}

export function inheritanceEnvelopeSchemaId(): string {
  return SCHEMA_IDS.inheritanceEnvelope;
}

// ── Integrity ───────────────────────────────────────────────────────────────

/**
 * Verify a stored envelope before it is used for anything: the format version,
 * the closed registered schema, the recomputed `policy_hash`, and the invariants
 * re-checked on the decoded values (so a re-hashed weakening is still refused).
 */
export function verifyEnvelope(stored: Record<string, unknown> | null | undefined): EnvelopeIntegrity {
  if (!stored) return { ok: false, code: 'schema_invalid', reason: 'no stored inheritance envelope' };
  const version = nonEmpty(stored.envelope_version);
  if (version !== ENVELOPE_VERSION) {
    return {
      ok: false,
      code: 'version_unsupported',
      reason: `envelope_version ${version ?? '(missing)'} is not ${ENVELOPE_VERSION}`,
    };
  }
  const check = validateAgainst(SCHEMA_IDS.inheritanceEnvelope, stored);
  if (!check.valid) {
    return { ok: false, code: 'schema_invalid', reason: `stored envelope failed validation: ${check.errors.slice(0, 3).join('; ')}` };
  }
  const recomputed = envelopePolicyHash(stored);
  const declared = nonEmpty(stored.policy_hash);
  if (recomputed !== declared) {
    return {
      ok: false,
      code: 'policy_hash_mismatch',
      reason:
        `stored policy hash ${declared ?? '(missing)'} does not match the recomputed ${recomputed}: ` +
        'the envelope was modified after it was created',
    };
  }
  const violation = invariantViolation(stored);
  if (violation) return { ok: false, code: 'invariant_violation', reason: violation };
  return { ok: true, code: null, reason: 'verified' };
}

/**
 * The invariant re-check, on VALUES rather than on the hash — the layer that
 * catches a tamperer who recomputed the hash. Returns the refusal reason, or
 * null when every invariant holds.
 */
export function invariantViolation(envelope: Record<string, unknown>): string | null {
  const bounds = (envelope.bounds ?? {}) as Record<string, any>;
  const scoring = (envelope.effective_scoring ?? {}) as Record<string, any>;
  const baseline = (envelope.baseline ?? {}) as Record<string, any>;
  const mutations = Array.isArray(envelope.mutations) ? (envelope.mutations as Array<Record<string, any>>) : [];

  if (bounds.message_priority !== MESSAGE_PRIORITY) {
    return `message_priority is ${String(bounds.message_priority)}, not the immutable ${MESSAGE_PRIORITY} (${IMMUTABLE_INVARIANT_NOTES.message_priority})`;
  }
  if (bounds.privacy_policy !== PRIVACY_POLICY) {
    return `privacy_policy is ${String(bounds.privacy_policy)}, not the immutable '${PRIVACY_POLICY}'`;
  }
  if (scoring.agent_message_weight !== MESSAGE_PRIORITY) {
    return `agent_message_weight is ${String(scoring.agent_message_weight)}, not the pinned ${MESSAGE_PRIORITY}`;
  }
  const floors = (bounds.floors ?? {}) as Record<string, unknown>;
  if (!(typeof floors.working_memory === 'number' && floors.working_memory > 0)) {
    return `the working-memory floor was lowered to ${String(floors.working_memory)} (${IMMUTABLE_INVARIANT_NOTES.floors})`;
  }
  if (!(typeof floors.vector_search === 'number' && floors.vector_search > 0)) {
    return `the vector-search floor was lowered to ${String(floors.vector_search)} (${IMMUTABLE_INVARIANT_NOTES.floors})`;
  }
  if (scoring.working_memory_floor !== floors.working_memory || scoring.vector_search_floor !== floors.vector_search) {
    return 'the effective scoring does not carry the inherited floors';
  }
  const caps = (bounds.caps ?? {}) as Record<string, unknown>;
  if (!(typeof scoring.max_single_source_pct === 'number' && scoring.max_single_source_pct <= Number(caps.max_single_source_pct))) {
    return `max_single_source_pct ${String(scoring.max_single_source_pct)} exceeds the inherited cap bound ${String(caps.max_single_source_pct)} (${IMMUTABLE_INVARIANT_NOTES.cap_bounds})`;
  }
  // …and the cap bound is measured against the PARENT'S OWN value, not against
  // itself: raising both together is still a widened per-source cap.
  if (typeof baseline.cap_pct !== 'number' || !(Number(caps.max_single_source_pct) <= baseline.cap_pct)) {
    return `the per-source cap bound ${String(caps.max_single_source_pct)} was raised above the parent's own ${String(baseline.cap_pct)} (${IMMUTABLE_INVARIANT_NOTES.cap_bounds})`;
  }
  if (!(typeof scoring.max_single_source_pct === 'number' && scoring.max_single_source_pct <= Number(baseline.cap_pct))) {
    return `max_single_source_pct ${String(scoring.max_single_source_pct)} is above the parent's own ${String(baseline.cap_pct)}`;
  }
  // The documented k band is the parent's own value ±`K_BAND_RATIO`, so a
  // tamperer cannot widen the band by moving its two ends.
  if (!(typeof caps.k_floor === 'number' && typeof caps.k_ceiling === 'number' && typeof baseline.k === 'number')) {
    return 'the k band is missing: the documented range has nothing to be measured against';
  }
  if (!(Number(caps.k_floor) >= baseline.k * (1 - K_BAND_RATIO) - 1e-9) || !(Number(caps.k_ceiling) <= baseline.k * (1 + K_BAND_RATIO) + 1e-9)) {
    return `the k band ${String(caps.k_floor)}..${String(caps.k_ceiling)} is wider than the documented ±${K_BAND_RATIO * 100}% of the parent's own ${String(baseline.k)}`;
  }
  if (!(Number(caps.vector_fetch_limit_max) <= VECTOR_FETCH_LIMIT_MAX)) {
    return `the vector fetch ceiling was raised to ${String(caps.vector_fetch_limit_max)}, above the documented maximum ${VECTOR_FETCH_LIMIT_MAX}`;
  }
  if (!(typeof scoring.relevance_multiplier === 'number' && scoring.relevance_multiplier >= Number(caps.k_floor) && scoring.relevance_multiplier <= Number(caps.k_ceiling))) {
    return `relevance_multiplier ${String(scoring.relevance_multiplier)} is outside the documented band ${String(caps.k_floor)}..${String(caps.k_ceiling)}`;
  }
  if (!(typeof scoring.vector_fetch_limit === 'number' && scoring.vector_fetch_limit >= 1 && scoring.vector_fetch_limit <= Number(caps.vector_fetch_limit_max))) {
    return `vector_fetch_limit ${String(scoring.vector_fetch_limit)} is outside 1..${String(caps.vector_fetch_limit_max)}`;
  }
  if (typeof baseline.k !== 'number' || typeof baseline.vector_fetch_limit !== 'number' || typeof baseline.cap_pct !== 'number') {
    return 'the baseline is missing: the documented ranges have nothing to be measured against';
  }
  const allowed = Array.isArray(envelope.allowed_dimensions) ? (envelope.allowed_dimensions as string[]) : [];
  for (const dimension of allowed) {
    if (!(APPROVED_DIMENSIONS as readonly string[]).includes(dimension)) {
      return `allowed_dimensions names '${dimension}', which is not an approved dimension`;
    }
  }
  const mode = envelope.mode;
  if (mode !== null && mode !== undefined) {
    const spec = isCognitiveMode(mode) ? COGNITIVE_MODES[mode] : null;
    if (!spec) return `unknown mode '${String(mode)}'`;
    for (const dimension of allowed) {
      if (!(spec.approved_dimensions as readonly string[]).includes(dimension)) {
        return `allowed_dimensions names '${dimension}', which mode '${spec.mode}' may not bias`;
      }
    }
  }
  for (const mutation of mutations) {
    if (!allowed.includes(String(mutation.dimension))) {
      return `a recorded mutation on '${String(mutation.dimension)}' is not in allowed_dimensions`;
    }
    const range = dimensionRange(mutation.dimension as ApprovedDimension, baseline as InheritanceBaseline);
    if (range.max <= 0 || Number(mutation.applied) < range.min || Number(mutation.applied) > range.max) {
      return `mutation on '${String(mutation.dimension)}' applied ${String(mutation.applied)}, outside ${range.min}..${range.max}`;
    }
    if (mutation.dimension === 'cap_pct' && Number(mutation.applied) > Number(baseline.cap_pct)) {
      return `mutation on 'cap_pct' widened the per-source cap above the parent's own bound`;
    }
  }
  const privacy = (envelope.privacy ?? {}) as Record<string, unknown>;
  if (privacy.private_content_included !== false) {
    return 'privacy.private_content_included is not false';
  }
  return null;
}

// ── Creation ────────────────────────────────────────────────────────────────

export interface CreateEnvelopeArgs {
  parentUserId: string;
  missionId: string;
  childLabel: string;
  mode?: CognitiveMode | string | null;
  ttlMs?: number;
  /** Explicit bounded mutations: clamped in range or refused by name. */
  mutations?: ReadonlyArray<{ dimension: string; value: unknown }>;
  actorId?: string;
  caller?: CallerIdentity;
  now?: () => string;
}

export interface MutationRefusal {
  dimension: string;
  value: unknown;
  code: MutationRefusalCode;
  reason: string;
}

export interface CreateEnvelopeResult {
  envelope: InheritanceEnvelope;
  /** Every requested mutation that was NOT applied, with its named reason. */
  refusals: MutationRefusal[];
}

function envelopeSeed(parentUserId: string, missionId: string): number {
  return hashSeed(`inheritance_envelope:${parentUserId}:${missionId}`);
}

/**
 * Build a root envelope: read the parent's disposition snapshot (read-only),
 * pin the bounds, take the mode's approved dimensions and apply the mode's
 * default bias through the SAME bounded-mutation path a caller's request takes.
 * Pure with respect to the store: nothing is written here.
 */
export async function buildInheritanceEnvelope(
  db: Db,
  args: CreateEnvelopeArgs & { resolved?: ResolvedPersonality; createdAt?: string },
): Promise<CreateEnvelopeResult> {
  const parentUserId = nonEmpty(args.parentUserId);
  const missionId = nonEmpty(args.missionId);
  const childLabel = nonEmpty(args.childLabel);
  if (!parentUserId) throw new InheritanceEnvelopeError('parentUserId is required', 'invalid_args');
  if (!missionId) throw new InheritanceEnvelopeError('missionId is required', 'invalid_args');
  if (!childLabel) throw new InheritanceEnvelopeError('childLabel is required', 'invalid_args');

  const mode = args.mode === undefined || args.mode === null ? null : args.mode;
  if (mode !== null && !isCognitiveMode(mode)) {
    throw new InheritanceEnvelopeError(`Unknown thinking mode '${String(mode)}'`, 'unknown_mode');
  }
  const spec = mode === null ? null : COGNITIVE_MODES[mode];

  const ttlMs = args.ttlMs === undefined ? DEFAULT_ENVELOPE_TTL_MS : Number(args.ttlMs);
  if (!Number.isFinite(ttlMs) || !Number.isInteger(ttlMs) || ttlMs < MIN_ENVELOPE_TTL_MS || ttlMs > MAX_ENVELOPE_TTL_MS) {
    throw new InheritanceEnvelopeError(
      `ttlMs ${String(args.ttlMs)} is outside the documented window ${MIN_ENVELOPE_TTL_MS}..${MAX_ENVELOPE_TTL_MS}`,
      'ttl_out_of_range',
    );
  }

  const resolved = args.resolved ?? (await snapshotPersonalityConfig(db, parentUserId));
  const createdAt = args.createdAt ?? (args.now ?? (() => new Date().toISOString()))();
  const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
  const snapshot = {
    profile: resolved.profile,
    version: resolved.version,
    hash: dispositionHash(resolved),
  };
  const baseline = baselineFrom(resolved);
  const bounds = boundsFrom(resolved);
  const allowed: ApprovedDimension[] = spec ? [...spec.approved_dimensions] : [...APPROVED_DIMENSIONS];
  const actorId = nonEmpty(args.actorId) ?? args.caller?.user_id ?? parentUserId;

  const rootId = derivedId(
    'cenv',
    {
      parent_identity_id: parentUserId,
      mission_id: missionId,
      child_label: childLabel,
      mode,
      disposition_hash: snapshot.hash,
      expires_at: expiresAt,
    },
    envelopeSeed(parentUserId, missionId),
  );

  const envelope: InheritanceEnvelope = {
    schema_version: '1.0',
    envelope_version: ENVELOPE_VERSION,
    envelope_id: rootId,
    root_envelope_id: rootId,
    parent_envelope_id: null,
    parent_identity_id: parentUserId,
    mission_id: missionId,
    child_label: childLabel,
    mode: mode as CognitiveMode | null,
    disposition_snapshot: snapshot,
    bounds,
    baseline,
    allowed_dimensions: allowed,
    effective_scoring: scoringFor(resolved, []),
    mutations: [],
    expires_at: expiresAt,
    policy_hash: '',
    privacy: { private_content_included: false, shared: false },
    created_at: createdAt,
  };
  envelope.policy_hash = envelopePolicyHash(envelope as unknown as Record<string, unknown>);

  const refusals: MutationRefusal[] = [];
  let current = envelope;
  if (spec) {
    for (const [dimension, factor] of Object.entries(spec.default_bias)) {
      const target = (baseline as unknown as Record<string, number>)[dimension] * Number(factor);
      const outcome = applyBoundedMutation(current, {
        dimension,
        value: target,
        source: 'mode_default_bias',
        actorId: `mode:${spec.mode}`,
        at: createdAt,
        resolved,
      });
      if (outcome.ok) current = outcome.envelope;
      else refusals.push({ dimension, value: target, code: outcome.code, reason: outcome.reason });
    }
  }
  for (const mutation of args.mutations ?? []) {
    const outcome = applyBoundedMutation(current, {
      dimension: mutation.dimension,
      value: mutation.value,
      source: 'caller',
      actorId,
      at: createdAt,
      resolved,
    });
    if (outcome.ok) current = outcome.envelope;
    else
      refusals.push({
        dimension: String(mutation.dimension),
        value: mutation.value,
        code: outcome.code,
        reason: outcome.reason,
      });
  }
  return { envelope: current, refusals };
}

/**
 * Create and STORE an envelope. The stored row is verified before it is served,
 * the write is private by construction (a personal kind), and the derived id
 * makes the call idempotent: the same grant over the same window returns the
 * stored envelope instead of inserting a second one.
 */
export async function createInheritanceEnvelope(db: Db, args: CreateEnvelopeArgs): Promise<CreateEnvelopeResult> {
  const parentUserId = nonEmpty(args.parentUserId);
  if (!parentUserId) throw new InheritanceEnvelopeError('parentUserId is required', 'invalid_args');
  if (args.caller && !args.caller.trusted && args.caller.user_id !== parentUserId) {
    throw new InheritanceEnvelopeError(
      `Caller '${args.caller.user_id}' may not create an inheritance envelope for '${parentUserId}'`,
      'forbidden',
    );
  }
  await ensureCognitiveTeamIndexes(db);
  const { envelope, refusals } = await buildInheritanceEnvelope(db, args);

  const scope = resolveWriteScope({ caller: { user_id: parentUserId, trusted: false }, kind: INHERITANCE_ENVELOPE_KIND });
  if (scope.shared_id !== null || scope.user_id !== parentUserId) {
    throw new InheritanceEnvelopeError(
      `inheritance_envelopes must be written privately but resolved { user_id: ${scope.user_id}, shared_id: ${scope.shared_id} }`,
      'scope_invalid',
    );
  }
  const collection = db.collection(COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes);
  const document = stripSharedId(envelope) as unknown as Record<string, unknown>;
  const check = verifyEnvelope(document);
  if (!check.ok) throw new InheritanceEnvelopeError(check.reason, check.code!);

  const existing = (await collection.findOne({ envelope_id: envelope.envelope_id }, { projection: { _id: 0 } })) as
    | Record<string, unknown>
    | null;
  if (existing) {
    const integrity = verifyEnvelope(existing);
    if (!integrity.ok) throw new InheritanceEnvelopeError(integrity.reason, integrity.code!);
    return { envelope: existing as unknown as InheritanceEnvelope, refusals };
  }
  try {
    await collection.insertOne(document as never);
  } catch {
    const winner = (await collection.findOne({ envelope_id: envelope.envelope_id }, { projection: { _id: 0 } })) as
      | Record<string, unknown>
      | null;
    if (!winner) throw new InheritanceEnvelopeError('the envelope could not be stored', 'conflict');
    const integrity = verifyEnvelope(winner);
    if (!integrity.ok) throw new InheritanceEnvelopeError(integrity.reason, integrity.code!);
    return { envelope: winner as unknown as InheritanceEnvelope, refusals };
  }
  return { envelope, refusals };
}

// ── Bounded mutation ────────────────────────────────────────────────────────

/**
 * Store an ALREADY BUILT envelope (a derived one, from a bounded mutation) under
 * its own derived id. The parent's row is never rewritten: a mutation produces a
 * new immutable document, and this is the write for it.
 */
export async function storeEnvelope(
  db: Db,
  envelope: InheritanceEnvelope,
  parentUserId: string,
): Promise<InheritanceEnvelope> {
  const scope = resolveWriteScope({
    caller: { user_id: parentUserId, trusted: false },
    kind: INHERITANCE_ENVELOPE_KIND,
  });
  if (scope.shared_id !== null || scope.user_id !== parentUserId) {
    throw new InheritanceEnvelopeError(
      `inheritance_envelopes must be written privately but resolved { user_id: ${scope.user_id}, shared_id: ${scope.shared_id} }`,
      'scope_invalid',
    );
  }
  const check = verifyEnvelope(envelope as unknown as Record<string, unknown>);
  if (!check.ok) throw new InheritanceEnvelopeError(check.reason, check.code!);
  const collection = db.collection(COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes);
  const document = stripSharedId(envelope) as unknown as Record<string, unknown>;
  const existing = (await collection.findOne({ envelope_id: envelope.envelope_id }, { projection: { _id: 0 } })) as
    | Record<string, unknown>
    | null;
  if (existing) {
    const integrity = verifyEnvelope(existing);
    if (!integrity.ok) throw new InheritanceEnvelopeError(integrity.reason, integrity.code!);
    return existing as unknown as InheritanceEnvelope;
  }
  try {
    await collection.insertOne(document as never);
  } catch {
    const winner = (await collection.findOne({ envelope_id: envelope.envelope_id }, { projection: { _id: 0 } })) as
      | Record<string, unknown>
      | null;
    if (!winner) throw new InheritanceEnvelopeError('the envelope could not be stored', 'conflict');
    const integrity = verifyEnvelope(winner);
    if (!integrity.ok) throw new InheritanceEnvelopeError(integrity.reason, integrity.code!);
    return winner as unknown as InheritanceEnvelope;
  }
  return envelope;
}

export interface ApplyMutationArgs {
  dimension: string;
  value: unknown;
  actorId?: string;
  source?: MutationSource;
  at?: string;
  /**
   * The parent's resolved configuration, when the caller already has it. Every
   * range is measured against the envelope's own `baseline` in any case — this
   * is only used to keep the effective scoring's profile/floors exact.
   */
  resolved?: ResolvedPersonality;
  /** Alternative to `resolved`: the floors the effective scoring must carry. */
  floors?: { working_memory: number; vector_search: number };
}

export type ApplyMutationResult =
  | { ok: true; envelope: InheritanceEnvelope; mutation: EnvelopeMutation }
  | { ok: false; code: MutationRefusalCode; reason: string };

/**
 * Apply ONE bounded, mission-scoped mutation to an envelope and return the
 * DERIVED envelope. The input envelope is never modified — a mutation produces a
 * new immutable document whose history records what was asked for and what was
 * applied — and the parent's own configuration is never touched at all.
 */
export function applyBoundedMutation(
  envelope: InheritanceEnvelope,
  args: ApplyMutationArgs,
): ApplyMutationResult {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, code: 'dimension_not_approved', reason: 'an envelope is required' };
  }
  const classification = classifyDimension(args.dimension);
  if (classification.kind === 'immutable') {
    return {
      ok: false,
      code: 'immutable_invariant',
      reason: `'${String(args.dimension)}' is the immutable invariant '${classification.invariant}': ${IMMUTABLE_INVARIANT_NOTES[classification.invariant]}`,
    };
  }
  if (classification.kind === 'unapproved') {
    return {
      ok: false,
      code: 'dimension_not_approved',
      reason: `'${String(args.dimension)}' is not an approved dimension. Approved: ${APPROVED_DIMENSIONS.join(', ')}`,
    };
  }
  const dimension = classification.dimension;
  const allowed = Array.isArray(envelope.allowed_dimensions) ? envelope.allowed_dimensions : [];
  if (!allowed.includes(dimension)) {
    return {
      ok: false,
      code: 'dimension_not_approved',
      reason:
        `'${dimension}' is approved in general but not for this envelope: ` +
        (envelope.mode
          ? `mode '${envelope.mode}' may bias ${JSON.stringify(envelope.allowed_dimensions)}`
          : `this envelope allows ${JSON.stringify(envelope.allowed_dimensions)}`),
    };
  }
  const baseline = envelope.baseline;
  const outcome = clampMutation(dimension, args.value, baseline);
  if (!outcome.ok) return { ok: false, code: outcome.code, reason: outcome.reason };

  const at = args.at ?? new Date().toISOString();
  const mutation: EnvelopeMutation = {
    dimension,
    requested: outcome.clamp.requested,
    applied: outcome.clamp.applied,
    clamped: outcome.clamp.clamped,
    min: outcome.clamp.min,
    max: outcome.clamp.max,
    source: args.source ?? 'caller',
    at,
    by: nonEmpty(args.actorId) ?? 'caller',
  };
  const mutations = [...envelope.mutations, mutation];
  const derived: InheritanceEnvelope = {
    ...envelope,
    envelope_id: derivedId(
      'cenv',
      {
        root_envelope_id: envelope.root_envelope_id,
        child_label: envelope.child_label,
        mutations: mutations.map((entry) => ({ dimension: entry.dimension, applied: entry.applied, source: entry.source })),
      },
      envelopeSeed(envelope.parent_identity_id, envelope.mission_id),
    ),
    parent_envelope_id: envelope.envelope_id,
    mutations,
    effective_scoring: effectiveScoringAfter(envelope, mutations, args),
    // A mutation never moves the window: the derived scope expires with its
    // parent.
    expires_at: envelope.expires_at,
    policy_hash: '',
  };
  derived.policy_hash = envelopePolicyHash(derived as unknown as Record<string, unknown>);
  const integrity = verifyEnvelope(derived as unknown as Record<string, unknown>);
  if (!integrity.ok) return { ok: false, code: 'out_of_bounds', reason: integrity.reason };
  return { ok: true, envelope: derived, mutation };
}

function effectiveScoringAfter(
  envelope: InheritanceEnvelope,
  mutations: readonly EnvelopeMutation[],
  args: ApplyMutationArgs,
): EnvelopeEffectiveScoring {
  const baseline = envelope.baseline;
  let k = baseline.k;
  let vectorFetch = baseline.vector_fetch_limit;
  let cap = baseline.cap_pct;
  for (const mutation of mutations) {
    if (mutation.dimension === 'k') k = mutation.applied;
    if (mutation.dimension === 'vector_fetch_limit') vectorFetch = mutation.applied;
    if (mutation.dimension === 'cap_pct') cap = mutation.applied;
  }
  const floors = args.floors ?? {
    working_memory: envelope.effective_scoring.working_memory_floor,
    vector_search: envelope.effective_scoring.vector_search_floor,
  };
  return {
    profile: envelope.effective_scoring.profile,
    relevance_multiplier: round6(k),
    vector_fetch_limit: Math.round(vectorFetch),
    max_single_source_pct: round6(cap),
    working_memory_floor: floors.working_memory,
    vector_search_floor: floors.vector_search,
    agent_message_weight: MESSAGE_PRIORITY,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface EnvelopeReadResult {
  envelope: InheritanceEnvelope | null;
  refusal: { code: EnvelopeIntegrityCode; reason: string } | null;
}

/** An envelope is the parent's own grant: own identity, or a trusted caller. */
export function envelopeVisibleTo(
  envelope: Pick<InheritanceEnvelope, 'parent_identity_id'>,
  caller: CallerIdentity,
): boolean {
  return caller.trusted || envelope.parent_identity_id === caller.user_id;
}

/**
 * The VERIFIED read: the envelope the caller may see, or the NAMED refusal that
 * stopped it. A row that is visible but no longer intact is refused rather than
 * served — a read is where a tampered envelope would otherwise reach the first
 * pass, the allocation or a tool output.
 */
export async function readEnvelope(db: Db, envelopeId: string, caller: CallerIdentity): Promise<EnvelopeReadResult> {
  const target = nonEmpty(envelopeId);
  if (!target) return { envelope: null, refusal: null };
  const stored = (await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes)
    .findOne({ envelope_id: target }, { projection: { _id: 0 } })) as Record<string, unknown> | null;
  if (!stored) return { envelope: null, refusal: null };
  const row = stored as unknown as InheritanceEnvelope;
  if (!envelopeVisibleTo(row, caller)) return { envelope: null, refusal: null };
  const integrity = verifyEnvelope(stored);
  if (!integrity.ok) return { envelope: null, refusal: { code: integrity.code!, reason: integrity.reason } };
  return { envelope: row, refusal: null };
}

export async function getEnvelope(db: Db, envelopeId: string, caller: CallerIdentity): Promise<InheritanceEnvelope | null> {
  return (await readEnvelope(db, envelopeId, caller)).envelope;
}

/** The caller's own envelopes for a mission, each verified before it is served. */
export async function listEnvelopes(
  db: Db,
  args: { parentUserId: string; missionId?: string; limit?: number; caller: CallerIdentity },
): Promise<{ envelopes: InheritanceEnvelope[]; refusals: Array<{ envelope_id: string; code: EnvelopeIntegrityCode; reason: string }> }> {
  const parentUserId = nonEmpty(args.parentUserId);
  if (!parentUserId) throw new InheritanceEnvelopeError('parentUserId is required', 'invalid_args');
  if (!args.caller.trusted && args.caller.user_id !== parentUserId) {
    throw new InheritanceEnvelopeError(
      `Caller '${args.caller.user_id}' may not list the inheritance envelopes of '${parentUserId}'`,
      'forbidden',
    );
  }
  const filter: Record<string, unknown> = { parent_identity_id: parentUserId };
  if (nonEmpty(args.missionId)) filter.mission_id = nonEmpty(args.missionId);
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 20), 1), 50);
  const rows = (await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes)
    .find(filter, { projection: { _id: 0 } })
    .sort({ created_at: -1, envelope_id: 1 })
    .limit(limit)
    .toArray()) as unknown as Array<Record<string, unknown>>;
  const envelopes: InheritanceEnvelope[] = [];
  const refusals: Array<{ envelope_id: string; code: EnvelopeIntegrityCode; reason: string }> = [];
  for (const row of rows) {
    const integrity = verifyEnvelope(row);
    if (!integrity.ok) {
      refusals.push({ envelope_id: String(row.envelope_id), code: integrity.code!, reason: integrity.reason });
      continue;
    }
    envelopes.push(row as unknown as InheritanceEnvelope);
  }
  return { envelopes, refusals };
}
