/**
 * Deprecation telemetry for the legacy global personality record (ITER-11,
 * WS-3 item 2 · brief §6.2).
 *
 * The brief asks that the changed personality path "keep old endpoints
 * operational for one release and emit deprecation telemetry, not hard
 * failures". ITER-2 changed the endpoints in the same release and replaced the
 * telemetry with a documented deploy-together precondition (review finding
 * F11). This module supplies the missing half, and only that:
 *
 *   - `notePersonalityDeprecation` records that a request was served by the
 *     LEGACY global record (`personality_config`, the no-`user_id` path) while
 *     `PER_IDENTITY_PERSONALITY` is on — i.e. that a caller is still reading
 *     the key the migration is meant to retire;
 *   - the rows are BOUNDED BY CONSTRUCTION: one counter row per
 *     {identity, kind, UTC day}, with the count set by read-modify-write (the
 *     fake store has no `$inc`, and a lost increment on a race is acceptable
 *     for a counter that must never grow rows). A flood of requests therefore
 *     adds no rows at all;
 *   - the rows are TTL'd: `expires_at` is stamped `DEPRECATION_TTL_DAYS` out
 *     and a `{ expires_at: 1 }` TTL index is installed, so the deployment
 *     drops them without a job. Reads ALSO filter expired rows in code, so the
 *     count is right on a store without TTL enforcement (and in the unit
 *     suite);
 *   - writes are RATE-LIMITED in-process (`MIN_WRITE_INTERVAL_MS` per
 *     {identity, kind}) so a hot read path pays at most one write a minute;
 *   - it NEVER throws and never blocks: a telemetry failure is swallowed by
 *     design, because a deprecation counter must not be able to break the
 *     endpoint it is watching.
 *
 * The rollout view (`GET /api/v1/imagination/rollout`) surfaces the count with
 * its basis, so "is anything still reading the legacy key?" has an answer.
 */
import type { Db } from 'mongodb';
import { privateDoc } from '../processing/idea-archive-service.js';

/** The collection the counters live in (a personal kind). */
export const DEPRECATION_EVENT_COLLECTION = 'personality_deprecation_events';
/** How long a counter row lives before the deployment (or a read) drops it. */
export const DEPRECATION_TTL_DAYS = 30;
/** The most one {identity, kind} writes in a burst: one row a minute. */
export const MIN_WRITE_INTERVAL_MS = 60_000;

export const DEPRECATION_KINDS = ['legacy_read', 'no_user_id_path', 'legacy_write'] as const;
export type DeprecationKind = (typeof DEPRECATION_KINDS)[number];

export interface DeprecationEventRow {
  event_key: string;
  user_id: string;
  kind: DeprecationKind;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface NoteDeprecationResult {
  recorded: boolean;
  throttled: boolean;
  row: DeprecationEventRow | null;
  reason: string;
}

export interface DeprecationSummary {
  /** The total count over every live row in scope. */
  events: number;
  by_kind: Record<string, number>;
  rows: number;
  identities: string[] | null;
  window_days: number;
  ttl_days: number;
  expires_after: string;
  basis: string;
}

/** In-process write throttle, keyed by `{identity}:{kind}`. */
const lastWriteAt = new Map<string, number>();

/** The UTC day an instant belongs to (`2026-09-26`). */
export function utcDay(at: string): string {
  const ms = Date.parse(at);
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 10);
}

/**
 * The DERIVED event key: one row per {identity, kind, UTC day}. This is what
 * makes the row count a function of identities × kinds × days rather than of
 * request volume.
 */
export function deprecationEventKey(userId: string, kind: DeprecationKind, day: string): string {
  return `deprecation:${kind}:${userId}:${day}`;
}

let indexesReady = new WeakMap<Db, Promise<void>>();

/** Install the TTL index (idempotent, never throws). */
export async function ensureDeprecationIndexes(db: Db): Promise<void> {
  const pending = indexesReady.get(db);
  if (pending) return pending;
  const work = (async () => {
    await db
      .collection(DEPRECATION_EVENT_COLLECTION)
      .createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'pdep_ttl' });
  })().catch(() => {
    indexesReady.delete(db);
  });
  indexesReady.set(db, work);
}

/**
 * Record one read/write of the legacy global personality record. Bounded
 * (one counter row per {identity, kind, day}), TTL'd, throttled and TOTAL —
 * it never throws, and it reports whether it wrote.
 */
export async function notePersonalityDeprecation(
  db: Db,
  args: { userId: string; kind: DeprecationKind; now?: () => string; note?: string | null },
): Promise<NoteDeprecationResult> {
  try {
    const userId = typeof args?.userId === 'string' ? args.userId.trim() : '';
    const kind = DEPRECATION_KINDS.includes(args?.kind as DeprecationKind) ? (args.kind as DeprecationKind) : null;
    if (!db || !userId || !kind) {
      return { recorded: false, throttled: false, row: null, reason: 'a database, an identity and a known kind are required' };
    }
    const now = args.now ?? (() => new Date().toISOString());
    const at = now();
    const atMs = Date.parse(at);
    const throttleKey = `${userId}:${kind}`;
    const last = lastWriteAt.get(throttleKey);
    if (last !== undefined && Number.isFinite(atMs) && atMs - last < MIN_WRITE_INTERVAL_MS) {
      return {
        recorded: false,
        throttled: true,
        row: null,
        reason: `throttled: ${kind} for '${userId}' was written less than ${MIN_WRITE_INTERVAL_MS} ms ago`,
      };
    }

    await ensureDeprecationIndexes(db);
    const collection = db.collection(DEPRECATION_EVENT_COLLECTION);
    const event_key = deprecationEventKey(userId, kind, utcDay(at));
    const existing = (await collection.findOne({ event_key }, { projection: { _id: 0 } })) as unknown as
      | DeprecationEventRow
      | null;
    const row: DeprecationEventRow = {
      event_key,
      user_id: userId,
      kind,
      count: Number(existing?.count ?? 0) + 1,
      first_seen_at: existing?.first_seen_at ?? at,
      last_seen_at: at,
      expires_at: new Date((Number.isFinite(atMs) ? atMs : Date.now()) + DEPRECATION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    };
    await collection.updateOne(
      { event_key },
      { $set: privateDoc(DEPRECATION_EVENT_COLLECTION, userId, row) },
      { upsert: true },
    );
    lastWriteAt.set(throttleKey, Number.isFinite(atMs) ? atMs : Date.now());
    void args.note;
    return { recorded: true, throttled: false, row, reason: `counted ${kind} for '${userId}' (${row.count}× today)` };
  } catch (error) {
    // Telemetry NEVER breaks the endpoint it watches.
    return {
      recorded: false,
      throttled: false,
      row: null,
      reason: `telemetry write failed (${String((error as Error)?.message ?? error)}) — swallowed by design`,
    };
  }
}

/**
 * The live counter total, for the rollout view. Expired rows are filtered in
 * code as well as by the TTL index, so the number is right everywhere.
 */
export async function countPersonalityDeprecationEvents(
  db: Db,
  opts: { userId?: string | null; now?: () => string } = {},
): Promise<DeprecationSummary> {
  const now = opts.now ?? (() => new Date().toISOString());
  const at = now();
  const summary: DeprecationSummary = {
    events: 0,
    by_kind: {},
    rows: 0,
    identities: null,
    window_days: DEPRECATION_TTL_DAYS,
    ttl_days: DEPRECATION_TTL_DAYS,
    expires_after: `${DEPRECATION_TTL_DAYS} days`,
    basis: 'no store was read',
  };
  if (!db) return { ...summary, basis: 'no database handle — the count is unavailable' };
  try {
    const filter: Record<string, unknown> = { expires_at: { $gte: at } };
    const userId = typeof opts.userId === 'string' && opts.userId.trim().length > 0 ? opts.userId.trim() : null;
    if (userId) filter.user_id = userId;
    const rows = (await db
      .collection(DEPRECATION_EVENT_COLLECTION)
      .find(filter, { projection: { _id: 0, user_id: 1, kind: 1, count: 1 } })
      .limit(1000)
      .toArray()) as unknown as Array<{ user_id: string; kind: string; count: number }>;
    const byKind: Record<string, number> = {};
    const identities = new Set<string>();
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      total += count;
      byKind[row.kind] = (byKind[row.kind] ?? 0) + count;
      identities.add(String(row.user_id));
    }
    return {
      events: total,
      by_kind: byKind,
      rows: rows.length,
      identities: userId ? [userId] : [...identities].sort(),
      window_days: DEPRECATION_TTL_DAYS,
      ttl_days: DEPRECATION_TTL_DAYS,
      expires_after: `${DEPRECATION_TTL_DAYS} days`,
      basis:
        `${rows.length} live counter row(s) in ${DEPRECATION_EVENT_COLLECTION} with expires_at ≥ ${at}` +
        (userId ? ` for '${userId}'` : ' across every identity') +
        `; one row per {identity, kind, UTC day}, TTL ${DEPRECATION_TTL_DAYS} days, counts set by read-modify-write`,
    };
  } catch (error) {
    return {
      ...summary,
      basis: `the deprecation count could not be read (${String((error as Error)?.message ?? error)})`,
    };
  }
}

/** Test seam: forget the in-process write throttle. */
export function resetDeprecationThrottle(): void {
  lastWriteAt.clear();
}
