/**
 * Personality Config Service — per-identity memory personality (ITER-2).
 *
 * The saved Memory Personality used to be a single process-wide record
 * (`system_settings{key:'personality_config'}`): every identity read and wrote
 * the same disposition. This service makes it per-identity while keeping that
 * legacy record as the migration fallback:
 *
 *   identity record `personality_config:<user_id>`  (flag ON only)
 *     → legacy global `personality_config`
 *       → built-in `balanced` defaults
 *
 * Flag `PER_IDENTITY_PERSONALITY` (default OFF, truthy `1|true|yes`) fails
 * closed: unset/anything else means the identity record is not even read, and
 * writes keep targeting the legacy global record exactly as before, so an
 * existing deployment sees no change until the flag is turned on.
 *
 * Invariants (must not be weakened):
 * - Resolution is READ-ONLY. It never writes, never migrates, and never
 *   creates an identity document — not even a fallback one. An identity with
 *   no record falls back to the legacy record and then to the defaults; it
 *   never inherits another identity's configuration, and nothing is ever
 *   created for another identity as a side effect of a read or a write.
 * - Writes are caller-pinned in the service as well as at the transport:
 *   an untrusted caller may only ever write its own record.
 * - Validation is the pre-iteration PUT sanitiser, extracted verbatim so the
 *   behaviour (unknown profile → error, unknown sources dropped, weights
 *   clamped 0..10, `agent_message` never settable, scoring keys whitelisted,
 *   `max_context_tokens` clamped 500..20000) is unchanged.
 * - `origin` and `version` are server-owned: a caller cannot set them.
 */

import type { Db } from 'mongodb';

import {
  AGENT_MESSAGE_WEIGHT,
  ALL_SOURCES,
  PROFILES,
  RECOMMENDED_BUDGETS,
} from './personality-profiles.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';

/** Where the resolved configuration was read from. */
export type PersonalityOrigin = 'identity' | 'legacy' | 'default';

/** The identity record key: `personality_config:<user_id>`. */
export function personalityConfigKey(userId: string): string {
  return `personality_config:${userId}`;
}

/** The pre-iteration global record key — the migration fallback. */
export const LEGACY_PERSONALITY_CONFIG_KEY = 'personality_config';

/**
 * Version reported when the record carries none — an identity record has been
 * written for this user at least once, so version 0 is never an identity
 * record: it is the legacy record (pre-versioned) or nothing at all.
 */
const NO_VERSION = 0;

/** System settings collection name (shared with the identity records). */
const SETTINGS_COLLECTION = 'system_settings';

/**
 * Bounded retry budget for the versioned write below. Each attempt re-reads
 * the record and re-derives the version, so three attempts absorb realistic
 * contention; a caller that still loses every race gets a loud conflict error
 * instead of a silently lost update.
 */
const MAX_WRITE_ATTEMPTS = 3;

export interface ResolvedPersonality {
  /** The identity this configuration was resolved for. */
  user_id: string;
  /** Saved profile name (`balanced` when the record names none). */
  profile: string;
  /** Source-weight OVERRIDES stored on the record (empty when none). */
  source_weights: Record<string, number>;
  /** Scoring overrides stored on the record (empty when none). */
  scoring: Record<string, unknown>;
  /**
   * Explicit token budget, or null when the record stores none — callers
   * apply the profile's recommended budget in that case (see
   * `effectivePersonalityConfig`).
   */
  max_context_tokens: number | null;
  /** Stored record version; 0 for the legacy record and for no record. */
  version: number;
  origin: PersonalityOrigin;
  /** ISO timestamp of the last write to the source record, or null. */
  updated_at: string | null;
}

/** A validated personality write, produced by `sanitizePersonalityPatch`. */
export interface PersonalityPatch {
  personality: string;
  source_weights: Record<string, number>;
  scoring: Record<string, unknown>;
  /** Present only when the caller supplied a usable budget. */
  max_context_tokens?: number;
}

/** Everything a consumer needs to run retrieval for this identity. */
export interface EffectivePersonality {
  profile: string;
  /** Profile weights merged with the stored overrides, agent_message pinned. */
  source_weights: Record<string, number>;
  /** Profile scoring merged with the stored overrides. */
  scoring: Record<string, unknown>;
  /** Explicit budget, or the profile's recommended budget when unset. */
  max_context_tokens: number;
}

/**
 * Raised when a caller tries to write an identity's configuration that is not
 * its own. The service is the last line of defence; transports map this to
 * 401/403.
 */
export class PersonalityAccessError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'PersonalityAccessError';
  }
}

/**
 * Raised when every bounded attempt in the versioned write lost the race to a
 * concurrent writer. Reporting this is strictly better than reporting a
 * version that was never stored: the caller can retry, and no update is
 * silently dropped.
 */
export class PersonalityWriteConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'PersonalityWriteConflictError';
  }
}

/**
 * `PER_IDENTITY_PERSONALITY` — default OFF. Truthy is `1|true|yes`
 * (case-insensitive, surrounding whitespace ignored); everything else
 * (unset included) is off, so a typo never enables per-identity storage.
 */
export function perIdentityPersonalityEnabled(): boolean {
  const value = (process.env.PER_IDENTITY_PERSONALITY ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Read one settings record, or null when absent/unreadable. */
async function readRecord(db: Db, key: string): Promise<Record<string, any> | null> {
  if (!db) return null;
  const doc = await db.collection(SETTINGS_COLLECTION).findOne({ key });
  return (doc as Record<string, any> | null) ?? null;
}

function defaultResolved(userId: string): ResolvedPersonality {
  return {
    user_id: userId,
    profile: 'balanced',
    source_weights: {},
    scoring: {},
    max_context_tokens: null,
    version: NO_VERSION,
    origin: 'default',
    updated_at: null,
  };
}

/**
 * Resolve the configuration for one identity. Read-only: the only database
 * operation is a single `findOne` per candidate key (two at most, and the
 * identity key is not read at all while the flag is off).
 */
export async function resolvePersonalityConfig(db: Db, userId: string): Promise<ResolvedPersonality> {
  const identityDoc = perIdentityPersonalityEnabled()
    ? await readRecord(db, personalityConfigKey(userId))
    : null;
  const doc = identityDoc ?? (await readRecord(db, LEGACY_PERSONALITY_CONFIG_KEY));

  if (!doc) return defaultResolved(userId);

  return {
    user_id: userId,
    profile: doc.personality || 'balanced',
    source_weights: (doc.source_weights as Record<string, number>) || {},
    scoring: (doc.scoring as Record<string, unknown>) || {},
    max_context_tokens:
      typeof doc.max_context_tokens === 'number' && Number.isFinite(doc.max_context_tokens)
        ? doc.max_context_tokens
        : null,
    version: typeof doc.version === 'number' && Number.isFinite(doc.version) ? doc.version : NO_VERSION,
    origin: identityDoc ? 'identity' : 'legacy',
    updated_at: toIso(doc.updated_at),
  };
}

/**
 * Immutable snapshot of an identity's configuration — the same read order as
 * `resolvePersonalityConfig` (still no writes), frozen for later inheritance
 * work (Phase 2+). The returned object and its nested maps cannot be mutated
 * by the caller.
 */
export async function snapshotPersonalityConfig(db: Db, userId: string): Promise<ResolvedPersonality> {
  const resolved = await resolvePersonalityConfig(db, userId);
  return deepFreeze(structuredClone(resolved));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Materialise the effective configuration for a resolved record: the profile's
 * weights/scoring merged with the record's overrides, with `agent_message`
 * re-pinned to its invariant weight last so no stored value can weaken it.
 */
export function effectivePersonalityConfig(resolved: ResolvedPersonality): EffectivePersonality {
  const base = PROFILES[resolved.profile] || PROFILES['balanced'];
  const overrideWeights = resolved.source_weights || {};
  const overrideScoring = (resolved.scoring || {}) as Record<string, any>;
  const overrideFloors = (overrideScoring.budget_floors || {}) as Record<string, number>;

  const source_weights: Record<string, number> = { ...base.weights, ...overrideWeights };
  source_weights.agent_message = AGENT_MESSAGE_WEIGHT;

  const scoring: Record<string, unknown> = {
    relevance_multiplier: base.relevance_multiplier,
    recency_half_life_days: base.recency_half_life_days,
    budget_floors: { ...base.budget_floors },
    max_single_source_pct: base.max_single_source_pct,
    vector_fetch_limit: base.vector_fetch_limit,
    vector_sample: base.vector_sample,
    min_fetch_weight: base.min_fetch_weight,
    ...overrideScoring,
  };
  scoring.budget_floors = { ...base.budget_floors, ...overrideFloors };

  return {
    profile: resolved.profile,
    source_weights,
    scoring,
    max_context_tokens:
      resolved.max_context_tokens ?? (RECOMMENDED_BUDGETS[resolved.profile] || 5000),
  };
}

export type SanitizeResult =
  | { ok: true; patch: PersonalityPatch }
  | { ok: false; error: string };

/**
 * The PUT body sanitiser, extracted unchanged from the admin route so the
 * route and every other writer share one definition of "valid personality".
 *
 * Parity notes (deliberate, tested against the pre-iteration code):
 * - a missing/blank/non-string profile name → error;
 * - an unknown profile → error naming the valid ones;
 * - weight overrides: unknown sources and non-numeric values are dropped,
 *   values are clamped to 0..10, and `agent_message` is never settable;
 * - scoring overrides: only the whitelisted keys survive;
 * - `max_context_tokens`: clamped to 500..20000, or omitted when unusable.
 * A non-object body still throws here (destructuring) exactly as the route
 * used to — the route turns that into the same 500 it always did.
 */
export function sanitizePersonalityPatch(body: unknown): SanitizeResult {
  const { personality, source_weights, scoring, max_context_tokens } = body as Record<string, any>;

  if (!personality || typeof personality !== 'string') {
    return { ok: false, error: 'personality (profile name) is required' };
  }
  if (!PROFILES[personality]) {
    return {
      ok: false,
      error: `Unknown personality '${personality}'. Valid: ${Object.keys(PROFILES).join(', ')}`,
    };
  }

  // Sanitize weight overrides: only known sources, numeric, and never
  // allow agent_message to be lowered (operational invariant).
  const cleanWeights: Record<string, number> = {};
  if (source_weights && typeof source_weights === 'object') {
    for (const [src, val] of Object.entries(source_weights)) {
      if (!(ALL_SOURCES as readonly string[]).includes(src)) continue;
      const num = Number(val);
      if (!Number.isFinite(num)) continue;
      if (src === 'agent_message') continue; // pinned — ignore attempts to change
      cleanWeights[src] = Math.max(0, Math.min(10, num)); // clamp 0..10
    }
  }

  // Sanitize scoring params.
  const cleanScoring: Record<string, unknown> = {};
  if (scoring && typeof scoring === 'object') {
    const allowed = [
      'relevance_multiplier', 'recency_half_life_days',
      'budget_floors', 'max_single_source_pct',
      'vector_fetch_limit', 'vector_sample', 'min_fetch_weight',
    ];
    for (const [k, v] of Object.entries(scoring)) {
      if (allowed.includes(k)) cleanScoring[k] = v;
    }
  }

  const budget = Number.isFinite(Number(max_context_tokens))
    ? Math.max(500, Math.min(20000, Number(max_context_tokens)))
    : undefined;

  const patch: PersonalityPatch = {
    personality,
    source_weights: cleanWeights,
    scoring: cleanScoring,
  };
  if (budget !== undefined) patch.max_context_tokens = budget;
  return { ok: true, patch };
}

/**
 * Persist a validated patch and return the record as it now resolves.
 *
 * - Flag ON: upsert `personality_config:<userId>` with `origin:'identity'` and
 *   a server-owned `version` (integer, 1 on create, +1 per write). The write
 *   is a bounded compare-and-set on the observed version, so concurrent
 *   updates land as sequential increments instead of a lost update (see the
 *   loop below); exhausted retries raise `PersonalityWriteConflictError`
 *   rather than reporting a version that was never stored. The create is
 *   guarded too — `{ key, version: { $exists: false } }` — so a record that
 *   another writer created in the meantime is never silently overwritten: the
 *   loop re-reads and bumps it instead, which keeps `version` equal to the
 *   number of successful writes and guarantees that no payload is discarded
 *   without an increment.
 * - Flag OFF: upsert the legacy global record exactly as the pre-iteration
 *   route did — no identity document is created, and no `origin`/`version`
 *   field is written.
 * - Caller pinning: an untrusted caller may only write its own record.
 * `origin` and `version` from the patch are ignored — they are server-owned.
 */
export async function updatePersonalityConfig(
  db: Db,
  userId: string,
  patch: PersonalityPatch,
  caller: CallerIdentity,
): Promise<ResolvedPersonality> {
  if (!caller.trusted && caller.user_id !== userId) {
    throw new PersonalityAccessError(
      `Caller '${caller.user_id}' may not write the personality config for '${userId}'`,
    );
  }

  const collection = db.collection(SETTINGS_COLLECTION);

  if (!perIdentityPersonalityEnabled()) {
    const now = new Date();
    const update: Record<string, unknown> = {
      key: LEGACY_PERSONALITY_CONFIG_KEY,
      personality: patch.personality,
      source_weights: patch.source_weights,
      scoring: patch.scoring,
      updated_at: now,
    };
    if (patch.max_context_tokens !== undefined) update.max_context_tokens = patch.max_context_tokens;

    await collection.updateOne(
      { key: LEGACY_PERSONALITY_CONFIG_KEY },
      { $set: update },
      { upsert: true },
    );
    return resolvePersonalityConfig(db, userId);
  }

  const key = personalityConfigKey(userId);

  // Read → compute → compare-and-set, bounded. The filter pins the version we
  // just observed, so a concurrent writer's increment cannot be overwritten:
  // whoever loses the race sees no matching document and re-reads (each
  // increment is stored exactly once, and `version` always moves forward).
  // No transactions are assumed — a single guarded `updateOne` is the unit.
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const existing = await readRecord(db, key);
    const observedVersion =
      typeof existing?.version === 'number' && Number.isFinite(existing.version)
        ? existing.version
        : NO_VERSION;

    const update: Record<string, unknown> = {
      key,
      personality: patch.personality,
      source_weights: patch.source_weights,
      scoring: patch.scoring,
      origin: 'identity',
      version: observedVersion + 1,
      // Stamped per attempt, inside the loop: a retried write must record when
      // it landed, not when the request started (a lost race costs a round
      // trip, and under contention several).
      updated_at: new Date(),
    };
    if (patch.max_context_tokens !== undefined) update.max_context_tokens = patch.max_context_tokens;

    let result: {
      matchedCount?: number;
      modifiedCount?: number;
      upsertedId?: unknown;
      upsertedCount?: number;
    };
    try {
      result = existing !== null
        // Guarded update: only the exact observed version may be incremented.
        ? await collection.updateOne(versionGuard(key, existing), { $set: update }, { upsert: false })
        // Create: guarded on "no version yet" instead of on the key alone, so
        // a versioned record another writer created between our read and this
        // write can never be matched — and therefore never overwritten with a
        // payload that carries no increment. Such a race reaches us either as
        // a matched-but-not-inserted result (an unversioned record was in the
        // way) or as the unique `key` index refusing the duplicate insert; both
        // mean "someone else's record is there", so the loop re-reads it.
        : await collection.updateOne(
            { key, version: { $exists: false } },
            { $set: update },
            { upsert: true },
          );
    } catch (error) {
      if (existing === null && isDuplicateKeyError(error)) continue;
      throw error;
    }

    if (existing !== null ? matched(result) : inserted(result)) {
      return resolvePersonalityConfig(db, userId);
    }
    // `matched` without `upsertedId`: the create hit an existing record (or a
    // racing writer's create won), so re-read and take the guarded update
    // path — every increment is then counted exactly once.
  }

  throw new PersonalityWriteConflictError(
    `Concurrent writes to '${key}' did not settle after ${MAX_WRITE_ATTEMPTS} attempts`,
  );
}

/**
 * The compare-and-set filter for an observed record: equality on the version
 * value that was actually read — whatever it is, including `null` or a string
 * left by a hand-written or pre-versioned record, so such a record can still
 * be versioned instead of being permanently unwritable — and, only when the
 * field is absent, on its absence (`$exists`, since the fake supports no
 * `$not`/`$or`). A concurrent change to any of those values fails the filter,
 * so the loop re-reads rather than overwriting it.
 *
 * (`resolvePersonalityConfig` reports version 0 for a stored non-number, so
 * the first write over such a record is version 1 — the count of successful
 * writes, as everywhere else.)
 */
function versionGuard(key: string, existing: Record<string, any>): Record<string, unknown> {
  return existing.version === undefined
    ? { key, version: { $exists: false } }
    : { key, version: existing.version };
}

/**
 * True for the duplicate-key error the unique index on `system_settings.key`
 * raises when two writers create the same record at once (MongoDB E11000).
 * The numeric code is the contract; the message check keeps it working across
 * driver packagings that surface the error differently.
 */
function isDuplicateKeyError(error: any): boolean {
  return error?.code === 11000 || /E\d*11000/.test(String(error?.message ?? ''));
}

/** True when a guarded (`upsert:false`) update hit the document it filtered on. */
function matched(result: { matchedCount?: number; modifiedCount?: number }): boolean {
  return (result.matchedCount ?? result.modifiedCount ?? 0) > 0;
}

/** True when an `upsert:true` write inserted rather than matched. */
function inserted(result: { upsertedId?: unknown; upsertedCount?: number }): boolean {
  return result.upsertedId != null || result.upsertedCount === 1;
}
