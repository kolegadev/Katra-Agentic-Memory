/**
 * Creative Baton promotion (ITER-7, Phase 5) — explicit, gated, idempotent.
 *
 * Contract: CONTRACT-iter7-creative-baton.md §C. The compiler never promotes;
 * THIS module is the only code that puts a `shared_id` on a Creative Baton, and
 * it is gated twice:
 *
 *   1. both flags must be on — `FOCUSED_IMAGINATION` (the family) AND
 *      `CREATIVE_BATON_PROMOTION` (this capability). Either one off and the
 *      promotion is refused BEFORE anything is read or written, so a default
 *      deployment cannot share a baton even by mistake;
 *   2. the caller must be TRUSTED. Promotion is the one operation in this
 *      feature that writes TEAM state, and a client key cannot make private
 *      material team-visible. (The adapter in `imagination-outcome-service.ts`
 *      follows the same rule from the other side: an untrusted caller may only
 *      turn an ALREADY-PROMOTED baton into work items.)
 *
 * Re-validation, not trust: the STORED document is validated against the
 * registered schema — which is CLOSED (`additionalProperties: false`), so an
 * extra key anywhere in the packet fails — and secret-scanned again at promote
 * time, and its payload hash is recomputed and compared with the one the
 * compiler wrote. A tampered baton — a mutated hypothesis, a smuggled extra
 * field even with the hash recomputed, a broken shape — fails with a NAMED
 * refusal code instead of being shared.
 *
 * THE RE-VALIDATION RUNS BEFORE THE IDEMPOTENCY ANSWER, on every call: an
 * existing `shared_id` records that the payload validated ONCE, which is not
 * the same as validating NOW. A row tampered with after its promotion is
 * therefore refused by name rather than reported as an unchanged no-op.
 *
 * The promotion writes two rows: the audit row (identity, timestamp, schema
 * version and payload hash) and the `shared_id` stamp on the baton itself. It
 * is idempotent: a second promotion of the same payload finds the existing
 * audit row and the existing stamp and reports them without writing anything.
 */
import type { Db } from 'mongodb';
import { resolveWriteScope } from '../memory/write-scope-policy.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import {
  CREATIVE_BATON_COLLECTIONS,
  CREATIVE_BATON_KIND,
  CREATIVE_BATON_PROMOTION_KIND,
  ensureCreativeBatonIndexes,
} from './creative-baton-collections.js';
import {
  CREATIVE_BATON_VERSION,
  CreativeBatonError,
  creativeBatonPromotionEnabled,
  verifyStoredBaton,
  type CreativeBaton,
} from './creative-baton-compiler.js';
import { focusedImaginationEnabled } from './focused-consolidation-service.js';
import { derivedId, hashSeed } from './imagination-operators.js';

export interface CreativeBatonPromotion {
  schema_version: '1.0';
  promotion_id: string;
  baton_id: string;
  mission_id: string;
  cycle_id: string;
  /** The identity the baton belongs to (the compiler's `user_id`). */
  user_id: string;
  /** The identity that performed the promotion (named by, or the caller's own). */
  promoted_by: string;
  promoted_at: string;
  /** The baton format version that was validated (`creative_baton_version`). */
  baton_schema_version: '1.0';
  creative_baton_version: '1.0';
  /** sha256 over the canonical sanitised payload (see `batonPayloadForHash`). */
  payload_hash: string;
  shared_id: string;
}

export type PromotionRefusalCode =
  | 'flag_off'
  | 'untrusted_caller'
  | 'baton_not_found'
  | 'not_owner'
  | 'schema_invalid'
  | 'secret_material'
  | 'version_unsupported'
  | 'payload_hash_mismatch'
  | 'scope_invalid';

export interface PromotionResult {
  promoted: boolean;
  /** True when an EARLIER promotion is being reported instead of a new write. */
  reused: boolean;
  shared_id: string | null;
  promotion: CreativeBatonPromotion | null;
  code: PromotionRefusalCode | null;
  reason: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function refusal(code: PromotionRefusalCode, reason: string): PromotionResult {
  return { promoted: false, reused: false, shared_id: null, promotion: null, code, reason };
}

/** `promotion_id` is derived from the baton and the payload — never random. */
export function promotionIdFor(batonId: string, payloadHash: string): string {
  return derivedId('cbpromo', { baton_id: batonId, payload_hash: payloadHash }, hashSeed(`promotion:${batonId}`));
}

export interface PromoteCreativeBatonArgs {
  userId: string;
  batonId: string;
  caller: CallerIdentity;
  now?: () => string;
}

/**
 * `promoteCreativeBaton(db, { userId, batonId, caller })`.
 *
 * `userId` is the identity the baton must belong to (a trusted caller may name
 * it; an untrusted caller is pinned to its own — `baton_not_found` is reported
 * for a baton it does not own, exactly like a missing id, so a probe cannot tell
 * "not yours" from "not there").
 */
export async function promoteCreativeBaton(db: Db, args: PromoteCreativeBatonArgs): Promise<PromotionResult> {
  if (!focusedImaginationEnabled() || !creativeBatonPromotionEnabled()) {
    return refusal(
      'flag_off',
      'promotion requires FOCUSED_IMAGINATION=1 and CREATIVE_BATON_PROMOTION=1; nothing was read or written',
    );
  }
  const caller: CallerIdentity = args.caller;
  // A trusted caller may promote on behalf of a named identity; an untrusted
  // caller is pinned to itself — and, because promotion writes team state, an
  // untrusted caller is refused outright.
  const userId = caller.trusted ? nonEmpty(args.userId) ?? caller.user_id : caller.user_id;
  const batonId = nonEmpty(args.batonId);
  if (!batonId) return refusal('baton_not_found', 'batonId is required');
  if (!caller.trusted) {
    return refusal(
      'untrusted_caller',
      'promotion writes a team scope and requires a trusted caller; an untrusted caller cannot promote a baton',
    );
  }

  await ensureCreativeBatonIndexes(db);
  const batons = db.collection<CreativeBaton>(CREATIVE_BATON_COLLECTIONS.creativeBatons);
  const promotions = db.collection<CreativeBatonPromotion>(CREATIVE_BATON_COLLECTIONS.batonPromotions);

  const stored = (await batons.findOne({ baton_id: batonId }, { projection: { _id: 0 } })) as unknown as Record<
    string,
    unknown
  > | null;
  if (!stored) return refusal('baton_not_found', `no creative baton with id ${batonId}`);
  if (String(stored.user_id) !== userId) {
    return refusal('not_owner', `creative baton ${batonId} does not belong to ${userId}`);
  }

  // RE-VALIDATION RUNS FIRST, BEFORE the idempotency answer. An existing
  // `shared_id` records that the payload ONCE validated; it is not a licence to
  // skip validating it now — a row tampered with AFTER its promotion must be
  // refused by name here, exactly like one tampered with before. The check is
  // the shared `verifyStoredBaton` (format version → closed schema → secret scan
  // → recomputed payload hash), so promotion, the reads and the adapter can
  // never disagree about what "intact" means.
  const integrity = verifyStoredBaton(stored);
  if (!integrity.ok) {
    return refusal(integrity.code!, integrity.reason);
  }
  const recomputed = nonEmpty(stored.payload_hash)!;

  // Intact AND already promoted: report the earlier promotion, write nothing.
  const existingSharedId = nonEmpty(stored.shared_id);
  if (existingSharedId) {
    const audit = (await promotions.findOne(
      { baton_id: batonId, payload_hash: recomputed },
      { projection: { _id: 0 } },
    )) as unknown as CreativeBatonPromotion | null;
    return {
      promoted: true,
      reused: true,
      shared_id: existingSharedId,
      promotion: audit,
      code: null,
      reason: audit
        ? `already promoted at ${audit.promoted_at} by ${audit.promoted_by} — no second write`
        : 'already promoted — no second write',
    };
  }

  const now = args.now ?? (() => new Date().toISOString());
  const promotedAt = now();
  const scope = resolveWriteScope({
    caller: { user_id: userId, trusted: true },
    kind: CREATIVE_BATON_KIND,
    requested: { user_id: userId },
  });
  if (!scope.shared_id) {
    return refusal('scope_invalid', 'the write-scope policy refused a shared scope for the promoted baton');
  }

  const promotion: CreativeBatonPromotion = {
    schema_version: '1.0',
    promotion_id: promotionIdFor(batonId, recomputed),
    baton_id: batonId,
    mission_id: String(stored.mission_id),
    cycle_id: String(stored.cycle_id),
    user_id: userId,
    promoted_by: caller.user_id,
    promoted_at: promotedAt,
    baton_schema_version: '1.0',
    creative_baton_version: CREATIVE_BATON_VERSION,
    payload_hash: recomputed,
    shared_id: scope.shared_id,
  };

  const auditScope = resolveWriteScope({
    caller: { user_id: userId, trusted: true },
    kind: CREATIVE_BATON_PROMOTION_KIND,
    requested: { user_id: userId },
  });
  const auditDoc = { ...promotion, shared_id: auditScope.shared_id ?? scope.shared_id };
  try {
    await promotions.insertOne(auditDoc);
  } catch (error) {
    // A concurrent promotion of the same payload won the unique promotion_id.
    const winner = (await promotions.findOne(
      { promotion_id: promotion.promotion_id },
      { projection: { _id: 0 } },
    )) as unknown as CreativeBatonPromotion | null;
    if (!winner) throw error;
    await batons.updateOne(
      { baton_id: batonId },
      {
        $set: {
          shared_id: winner.shared_id,
          promotion_id: winner.promotion_id,
          promoted_at: winner.promoted_at,
          promoted_by: winner.promoted_by,
          // The WHOLE privacy object, never a dotted path: a dotted `$set` is
          // one shape to the real driver and another to simpler stores, and a
          // shared flag that lands only on one of them is a scope bug.
          privacy: { raw_reflections_included: false, shared: true },
        },
      },
    );
    return {
      promoted: true,
      reused: true,
      shared_id: winner.shared_id,
      promotion: winner,
      code: null,
      reason: 'a concurrent promotion of the same payload is on record — no second audit row',
    };
  }

  await batons.updateOne(
    { baton_id: batonId },
    {
      $set: {
        shared_id: promotion.shared_id,
        promotion_id: promotion.promotion_id,
        promoted_at: promotion.promoted_at,
        promoted_by: promotion.promoted_by,
        // The WHOLE privacy object, never a dotted path (see above).
        privacy: { raw_reflections_included: false, shared: true },
      },
    },
  );

  return {
    promoted: true,
    reused: false,
    shared_id: promotion.shared_id,
    promotion,
    code: null,
    reason: `promoted to ${promotion.shared_id} with payload ${promotion.payload_hash}`,
  };
}

/** The promotion audit rows for one baton, newest first (operator surface). */
export async function listBatonPromotions(db: Db, batonId: string): Promise<CreativeBatonPromotion[]> {
  await ensureCreativeBatonIndexes(db);
  return (await db
    .collection<CreativeBatonPromotion>(CREATIVE_BATON_COLLECTIONS.batonPromotions)
    .find({ baton_id: batonId }, { projection: { _id: 0 } })
    .sort({ promoted_at: -1 })
    .limit(20)
    .toArray()) as unknown as CreativeBatonPromotion[];
}

/** Re-exported so a caller can catch promotion failures by type. */
export { CreativeBatonError };
