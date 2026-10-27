/**
 * Controller adapter + candidate outcome feedback (ITER-7, Phase 5).
 *
 * Contract: CONTRACT-iter7-creative-baton.md §D. Two operations, both about
 * what happens to a candidate AFTER the cycle compiled it:
 *
 *   1. `batonCandidatesToWorkItems` — turns a baton's eligible candidates into
 *      controller work items. It goes through `SchedulerService.upsertWorkItems`
 *      (with `options.extra`) and therefore through `work-item-generator.ts`,
 *      which builds the item with the mission's own priority feature vector: NO
 *      new write path into `cognitive_work_items` was added, and the funnel's
 *      `{mission_id, trigger, description}` dedupe is what makes the adapter
 *      idempotent — re-running it inserts nothing.
 *
 *      TRIGGER CHOICE (documented, per the contract): the existing enum is
 *      reused — the item is `manual`, because the item exists because a caller
 *      EXPLICITLY asked for the controller to pick up a promoted candidate
 *      (unlike `open_objective`/`active_uncertainty`/…, which the generator
 *      derives from mission state by itself). PROVENANCE IS IN THE DESCRIPTION
 *      and, structurally, in the row's `provenance` field:
 *      `{source: 'creative_baton', baton_id, seed_id}` — so no enum value had to
 *      be invented to make a baton candidate traceable. Mode is `explore`: a
 *      candidate is a hypothesis to test, not work to execute.
 *
 *      REFUSALS: an untrusted caller may only adapt a PROMOTED (team-shared)
 *      baton — the work queue is shared state, and an unpromoted baton is
 *      private material. A baton the caller cannot see is reported exactly like
 *      a missing one.
 *
 *      INTEGRITY: the baton is read through the VERIFIED read
 *      (`CreativeBatonService.readCreativeBaton`), so a stored row that no
 *      longer matches its payload hash — or that carries a key the closed schema
 *      does not allow — is refused BY NAME (`payload_hash_mismatch`,
 *      `schema_invalid`, …) before a single candidate is copied. Without that,
 *      a tampered row would have its candidate text written into the SHARED
 *      queue. The refusal's code is the error's code, so a caller can branch on
 *      it instead of parsing prose.
 *
 *      HONEST COUNTERS: `created`/`reused` describe the BATON-derived items
 *      (unchanged), and `work_items_added_total` — measured from the store
 *      before and after the call — counts EVERY row the call added, including
 *      the items the funnel derives from mission state by itself. Reporting only
 *      the baton-derived number understates what the call did; reporting only
 *      the total would hide the baton's contribution, so both are returned
 *      (`funnel_derived_added` is the difference) and the queue item count is
 *      never a guess.
 *
 *   2. `recordCandidateOutcome` — what happened: `useful_information`,
 *      `mere_variance` or `unnecessary_cost`. Three consumers, in order:
 *        a. the archive's `recordOutcome` (identity-bound: the seed is looked up
 *           by `{seed_id, user_id}`, so no caller can write into another
 *           identity's lineage);
 *        b. the existing `trigger-telemetry` instrument
 *           (`recordTriggerOutcome`, measured token cost from the usage ledger,
 *           grouped under the new `imagination_candidate` trigger type);
 *        c. a CAPPED novelty-drive replenishment.
 *
 *      IDEMPOTENCY, DOCUMENTED (the contract allows either rule): repeating the
 *      same OUTCOME for the same SEED is recorded ONCE. The row
 *      `{user_id, seed_id, outcome}` is unique; a repeat is reported as
 *      `repeated: true` and touches neither the lineage, the telemetry, nor the
 *      drive. A DIFFERENT outcome for the same seed is a new record (a candidate
 *      can be mere variance and later turn out useful).
 *
 *      THE NOVELTY CAP: `+NOVELTY_REPLENISHMENT_PER_USEFUL` (0.05) per useful
 *      outcome, at most `NOVELTY_REPLENISHMENT_DAILY_CAP` (0.2) per identity and
 *      mission per rolling 24 h. The cap is computed from the STORED outcome
 *      rows, not from memory — so a restart cannot be used to replenish the same
 *      budget again (the drive itself is an in-process signal; the row is the
 *      durable fact). The replenishment is applied AFTER the row is written, so
 *      a crash can lose a replenishment (harmless) but can never double one.
 */
import type { Db } from 'mongodb';
import { MotivationalEngine } from './motivational-engine.js';
import { SchedulerService } from '../mission-cognition/scheduler-service.js';
import { recordTriggerOutcome } from '../mission-cognition/trigger-telemetry.js';
import { COLLECTIONS } from '../mission-cognition/collections.js';
import { usageSnapshot } from '../infrastructure/llm-usage-ledger.js';
import type { CognitiveWorkItem, TriggerOutcome, TriggerType } from '../../types/cognitive-control.js';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import {
  CREATIVE_BATON_COLLECTIONS,
  CANDIDATE_OUTCOME_KIND,
  ensureCreativeBatonIndexes,
} from './creative-baton-collections.js';
import { CreativeBatonService, type CreativeBatonCandidate } from './creative-baton-compiler.js';
import { IdeaArchiveService, privateDoc } from './idea-archive-service.js';
import { derivedId, hashSeed } from './imagination-operators.js';

export const CANDIDATE_OUTCOMES = ['useful_information', 'mere_variance', 'unnecessary_cost'] as const;
export type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];

/** Per useful outcome. Small on purpose: one outcome is a signal, not a refill. */
export const NOVELTY_REPLENISHMENT_PER_USEFUL = 0.05;
/** The most any identity+mission may replenish in a rolling 24 hours. */
export const NOVELTY_REPLENISHMENT_DAILY_CAP = 0.2;
/** The telemetry trigger type this feedback is recorded under. */
export const IMAGINATION_CANDIDATE_TRIGGER: TriggerType = 'imagination_candidate';
/** The work-item trigger reused for adapter items (see the header). */
export const ADAPTER_WORK_ITEM_TRIGGER = 'manual' as const;
/** Guard on the description (the seed's own bounds already keep it far smaller). */
const MAX_ADAPTER_DESCRIPTION = 1500;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CandidateOutcomeRecord {
  schema_version: '1.0';
  outcome_id: string;
  user_id: string;
  mission_id: string;
  seed_id: string;
  baton_id: string | null;
  outcome: CandidateOutcome;
  /** Caller-supplied context; stored on the PRIVATE row, never in telemetry. */
  detail: string | null;
  novelty_replenished: number;
  telemetry_evaluation_id: string | null;
  recorded_at: string;
}

export interface CandidateOutcomeResult {
  recorded: boolean;
  /** True when this `{seed, outcome}` pair was already on record. */
  repeated: boolean;
  outcome: CandidateOutcomeRecord | null;
  novelty_replenished: number;
  novelty_cap_remaining: number;
  telemetry_evaluation_id: string | null;
  lineage_updated: boolean;
  reason: string;
}

export interface CandidateWorkItem {
  work_item_id: string;
  seed_id: string;
  description: string;
  trigger: string;
}

export interface AdapterResult {
  schema_version: '1.0';
  baton_id: string;
  mission_id: string;
  promoted: boolean;
  shared_id: string | null;
  /** BATON-derived items this call inserted into the controller queue. */
  created: number;
  /** BATON-derived items the queue already had (the funnel's dedupe). */
  reused: number;
  /**
   * EVERY row this call added to the queue, measured from the store before and
   * after it: the baton-derived items PLUS the items the funnel derives from
   * mission state on its own (a stale checkpoint, a blocked objective, …). The
   * baton-derived `created` alone understates what the call did.
   */
  work_items_added_total: number;
  /** `work_items_added_total - created`: what the FUNNEL added by itself. */
  funnel_derived_added: number;
  work_items: CandidateWorkItem[];
  reason: string;
}

export class CandidateOutcomeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CandidateOutcomeError';
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error);
}

function isDuplicateKeyError(error: unknown): boolean {
  return /E11000|duplicate key/i.test(errorMessage(error));
}

/** The item description: stable (idempotency), explicit, bounded. */
export function adapterDescription(batonId: string, candidate: CreativeBatonCandidate): string {
  const text =
    `[creative_baton ${batonId} seed ${candidate.seed_id}] Test the candidate: ${candidate.hypothesis}` +
    ` — cheapest test: ${candidate.cheapest_test}`;
  return text.length <= MAX_ADAPTER_DESCRIPTION ? text : `${text.slice(0, MAX_ADAPTER_DESCRIPTION - 1)}…`;
}

// ── 1. the adapter ──────────────────────────────────────────────────────────

/**
 * Turn a baton's eligible candidates into controller work items.
 *
 * Idempotent: every item's description is derived from the baton id, the seed
 * id and the candidate's own text, and the queue dedupes on
 * `{mission_id, trigger, description}` — so a second call inserts nothing and
 * reports the same items as `reused`.
 */
export async function batonCandidatesToWorkItems(
  db: Db,
  args: { userId: string; batonId: string; caller: CallerIdentity },
): Promise<AdapterResult> {
  const batonId = nonEmpty(args.batonId);
  if (!batonId) throw new CandidateOutcomeError('batonId is required', 'invalid_args');

  await ensureCreativeBatonIndexes(db);
  // A read FOR USE: the stored baton is verified (version, closed schema, secret
  // scan, payload hash) before a single candidate becomes work. A row tampered
  // with after its promotion is refused HERE, by name, instead of having its
  // text copied into the SHARED work queue.
  const read = await new CreativeBatonService(db).readCreativeBaton(batonId, args.caller);
  if (read.refusal) {
    throw new CandidateOutcomeError(
      `baton ${batonId} refused (${read.refusal.code}): ${read.refusal.reason}`,
      read.refusal.code,
    );
  }
  const baton = read.baton;
  if (!baton) throw new CandidateOutcomeError(`no visible creative baton with id ${batonId}`, 'baton_not_found');
  const sharedId = nonEmpty(baton.shared_id);

  // The work queue is SHARED state: an untrusted caller may only contribute the
  // candidates of a PROMOTED baton (an operator has already approved sharing
  // them). A trusted caller may adapt its own baton without a promotion.
  if (!args.caller.trusted && !sharedId) {
    throw new CandidateOutcomeError(
      'baton_not_promoted: an untrusted caller may only turn a PROMOTED (team-shared) baton into work items',
      'baton_not_promoted',
    );
  }

  const candidates = baton.candidate_portfolio ?? [];
  const extra = candidates.map((candidate) => ({
    trigger: ADAPTER_WORK_ITEM_TRIGGER,
    description: adapterDescription(baton.baton_id, candidate),
    mode: 'explore' as const,
    provenance: {
      source: 'creative_baton',
      baton_id: baton.baton_id,
      seed_id: candidate.seed_id,
      cycle_id: baton.cycle_id,
      requested_by: args.caller.user_id,
    },
  }));

  const before = await db
    .collection(COLLECTIONS.cognitiveWorkItems)
    .find(
      { mission_id: baton.mission_id, trigger: ADAPTER_WORK_ITEM_TRIGGER, description: { $in: extra.map((item) => item.description) } },
      { projection: { _id: 0, work_item_id: 1, description: 1 } },
    )
    .limit(200)
    .toArray()
    .catch(() => [] as unknown[]);
  const existingDescriptions = new Set(
    (before as unknown as Array<{ description: string }>).map((row) => row.description),
  );

  const queuedRows = async (): Promise<number> =>
    Number(await db.collection(COLLECTIONS.cognitiveWorkItems).countDocuments({ mission_id: baton.mission_id }));
  const rowsBefore = await queuedRows();
  const stored = await new SchedulerService(db).upsertWorkItems(baton.mission_id, { extra });
  const rowsAfter = await queuedRows();
  // EVERY row the call added, measured from the store. The baton-derived count
  // below is the adapter's own contribution; the difference is what the funnel
  // derived from mission state in the same pass (it runs its own generators).
  const workItemsAddedTotal = Math.max(0, rowsAfter - rowsBefore);

  const workItems: CandidateWorkItem[] = [];
  const byDescription = new Map<string, CognitiveWorkItem>();
  for (const item of stored) byDescription.set(String((item as unknown as { description: string }).description), item);
  for (const candidate of candidates) {
    const description = adapterDescription(baton.baton_id, candidate);
    const item = byDescription.get(description);
    if (!item) continue;
    const workItemId = String((item as unknown as { work_item_id?: string }).work_item_id ?? item.work_item_id);
    workItems.push({ work_item_id: workItemId, seed_id: candidate.seed_id, description, trigger: ADAPTER_WORK_ITEM_TRIGGER });
  }
  const created = workItems.filter((item) => !existingDescriptions.has(item.description)).length;
  const reused = workItems.length - created;
  const funnelDerivedAdded = Math.max(0, workItemsAddedTotal - created);
  const missing = candidates.length - workItems.length;
  // A partial (or empty) enqueue is REPORTED rather than silent: the generator
  // refuses to build items for a missing, completed or cancelled mission, and
  // that refusal is a fact about the mission, not a quiet success.
  const queueNote =
    missing > 0
      ? `${workItems.length} of ${candidates.length} candidate item(s) reached the controller queue — the generator ` +
        'refused the rest (a missing, completed or cancelled mission generates no work items)'
      : `${workItems.length} candidate item(s) in the controller queue`;

  return {
    schema_version: '1.0',
    baton_id: baton.baton_id,
    mission_id: baton.mission_id,
    promoted: sharedId !== null,
    shared_id: sharedId,
    created,
    reused,
    work_items_added_total: workItemsAddedTotal,
    funnel_derived_added: funnelDerivedAdded,
    work_items: workItems,
    reason:
      `${queueNote} (${created} new, ${reused} already queued, ${workItemsAddedTotal} row(s) added to the ` +
      `queue by this call: ${created} baton-derived, ${funnelDerivedAdded} the funnel derived from mission state)`,
  };
}

// ── 2. outcome feedback ─────────────────────────────────────────────────────

/**
 * Record what a candidate turned out to be. The three writes are described in
 * the header; the whole thing is idempotent per `{seed, outcome}`.
 */
export async function recordCandidateOutcome(
  db: Db,
  args: {
    userId: string;
    seedId: string;
    outcome: CandidateOutcome;
    batonId?: string | null;
    detail?: string | null;
    now?: () => string;
  },
): Promise<CandidateOutcomeResult> {
  const userId = nonEmpty(args.userId);
  const seedId = nonEmpty(args.seedId);
  const outcome = args.outcome;
  if (!userId) throw new CandidateOutcomeError('userId is required', 'invalid_args');
  if (!seedId) throw new CandidateOutcomeError('seedId is required', 'invalid_args');
  if (!(CANDIDATE_OUTCOMES as readonly string[]).includes(String(outcome))) {
    throw new CandidateOutcomeError(
      `outcome must be one of ${CANDIDATE_OUTCOMES.join(' | ')}`,
      'invalid_args',
    );
  }
  const now = args.now ?? (() => new Date().toISOString());
  const recordedAt = now();

  await ensureCreativeBatonIndexes(db);
  const outcomes = db.collection<CandidateOutcomeRecord>(CREATIVE_BATON_COLLECTIONS.candidateOutcomes);

  // The identity is part of the lookup: a cross-identity call finds no seed.
  const seed = (await db
    .collection('idea_seeds')
    .findOne({ seed_id: seedId, user_id: userId }, { projection: { _id: 0, mission_id: 1, seed_id: 1 } })) as unknown as
    | { mission_id?: string }
    | null;
  if (!seed) {
    return {
      recorded: false,
      repeated: false,
      outcome: null,
      novelty_replenished: 0,
      novelty_cap_remaining: NOVELTY_REPLENISHMENT_DAILY_CAP,
      telemetry_evaluation_id: null,
      lineage_updated: false,
      reason: `no seed ${seedId} under ${userId}`,
    };
  }
  const missionId = String(seed.mission_id ?? '');

  const existing = (await outcomes.findOne(
    { user_id: userId, seed_id: seedId, outcome },
    { projection: { _id: 0 } },
  )) as unknown as CandidateOutcomeRecord | null;
  if (existing) {
    const used = await noveltyUsed(db, userId, missionId, recordedAt);
    return {
      recorded: false,
      repeated: true,
      outcome: existing,
      novelty_replenished: 0,
      novelty_cap_remaining: Math.max(0, Number((NOVELTY_REPLENISHMENT_DAILY_CAP - used).toFixed(6))),
      telemetry_evaluation_id: existing.telemetry_evaluation_id ?? null,
      lineage_updated: false,
      reason: `the ${outcome} outcome for ${seedId} is already on record — recorded once, no repeat write`,
    };
  }

  const batonId = nonEmpty(args.batonId);
  const detail = nonEmpty(args.detail);

  // (a) the archive's identity-bound outcome record
  const archive = new IdeaArchiveService(db);
  const lineage = await archive.recordOutcome(
    seedId,
    {
      verdict: outcome,
      detail: detail ?? null,
      test: 'creative baton candidate outcome',
      at: recordedAt,
      ...(outcome === 'unnecessary_cost'
        ? { failure_signature: `unnecessary_cost: ${detail ?? 'a candidate that cost without changing a decision'}` }
        : {}),
    },
    userId,
  );

  // (b) trigger telemetry — measured cost, and a note that carries NO detail
  // (telemetry rows are mission-scoped, not personal: the caller's own words
  // stay on the private outcome row).
  const telemetry = await recordTriggerOutcome(
    db,
    {
      trigger: IMAGINATION_CANDIDATE_TRIGGER,
      mission_id: missionId,
      entry_id: seedId,
      reason: `creative baton candidate ${seedId}${batonId ? ` from ${batonId}` : ''}`,
    },
    outcome satisfies TriggerOutcome,
    `creative baton candidate outcome: ${outcome}`,
    usageSnapshot(),
  );

  // (c) the capped novelty replenishment — computed from the STORED rows
  const used = await noveltyUsed(db, userId, missionId, recordedAt);
  const remaining = Math.max(0, NOVELTY_REPLENISHMENT_DAILY_CAP - used);
  const amount =
    outcome === 'useful_information'
      ? Number(Math.min(NOVELTY_REPLENISHMENT_PER_USEFUL, remaining).toFixed(6))
      : 0;

  const record: CandidateOutcomeRecord = {
    schema_version: '1.0',
    outcome_id: derivedId(
      'candoutcome',
      { user_id: userId, seed_id: seedId, outcome, baton_id: batonId ?? null },
      hashSeed(`candidate_outcome:${userId}:${seedId}:${outcome}`),
    ),
    user_id: userId,
    mission_id: missionId,
    seed_id: seedId,
    baton_id: batonId,
    outcome,
    detail: detail ?? null,
    novelty_replenished: amount,
    telemetry_evaluation_id: telemetry.evaluation_id,
    recorded_at: recordedAt,
  };
  try {
    await outcomes.insertOne(privateDoc(CANDIDATE_OUTCOME_KIND, userId, record));
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // A concurrent identical call won: report it as the repeat it is. The
    // winner owns the drive replenishment, so nothing is applied here.
    const winner = (await outcomes.findOne(
      { user_id: userId, seed_id: seedId, outcome },
      { projection: { _id: 0 } },
    )) as unknown as CandidateOutcomeRecord | null;
    return {
      recorded: false,
      repeated: true,
      outcome: winner,
      novelty_replenished: 0,
      novelty_cap_remaining: Math.max(0, Number((NOVELTY_REPLENISHMENT_DAILY_CAP - used).toFixed(6))),
      telemetry_evaluation_id: winner?.telemetry_evaluation_id ?? telemetry.evaluation_id,
      lineage_updated: lineage !== null,
      reason: 'a concurrent identical outcome is on record — recorded once',
    };
  }

  // Only now, with the idempotency row durably written, does the drive move.
  if (amount > 0) MotivationalEngine.get_instance().replenishDrive('novelty', amount);

  return {
    recorded: true,
    repeated: false,
    outcome: record,
    novelty_replenished: amount,
    novelty_cap_remaining: Math.max(0, Number((remaining - amount).toFixed(6))),
    telemetry_evaluation_id: telemetry.evaluation_id,
    lineage_updated: lineage !== null,
    reason: `recorded ${outcome} for ${seedId} (archive + telemetry${amount > 0 ? ` + novelty +${amount}` : ''})`,
  };
}

/** The novelty amount already replenished in the rolling 24h window. */
async function noveltyUsed(db: Db, userId: string, missionId: string, at: string): Promise<number> {
  const atMs = Date.parse(at);
  const since = new Date((Number.isFinite(atMs) ? atMs : Date.now()) - DAY_MS).toISOString();
  const rows = (await db
    .collection(CREATIVE_BATON_COLLECTIONS.candidateOutcomes)
    .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0, novelty_replenished: 1, recorded_at: 1 } })
    .sort({ recorded_at: -1 })
    .limit(200)
    .toArray()) as unknown as Array<{ novelty_replenished?: number; recorded_at?: string }>;
  let used = 0;
  for (const row of rows) {
    const stamped = String(row.recorded_at ?? '');
    if (stamped < since) continue;
    used += Number(row.novelty_replenished ?? 0);
  }
  return Number(used.toFixed(6));
}

/** The recorded outcomes for a mission, newest first (the RESUME surface). */
export async function listCandidateOutcomes(
  db: Db,
  userId: string,
  missionId: string,
  limit = 50,
): Promise<CandidateOutcomeRecord[]> {
  return (await db
    .collection<CandidateOutcomeRecord>(CREATIVE_BATON_COLLECTIONS.candidateOutcomes)
    .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })
    .sort({ recorded_at: -1, outcome_id: 1 })
    .limit(Math.min(Math.max(Math.floor(limit) || 1, 1), 200))
    .toArray()) as unknown as CandidateOutcomeRecord[];
}
