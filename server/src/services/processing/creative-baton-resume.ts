/**
 * The baton-aware resume — the controller's own view of a MISSION'S Creative
 * Baton (ITER-11, WS-1 · brief §6.1 item 4, DoD bullet 5).
 *
 * Before this iteration `resume.ts` reconstructed a mission from the state
 * store, the deltas and the ledger — and never looked at the baton, so "resume
 * from a baton" meant "the queued work items happen to be there". This module
 * is the missing read: when a mission holds an ACTIVE, PROMOTED Creative Baton
 * whose version is still current, the resume report carries
 *
 *   - its ATTENTION TARGETS (cue + why it is operationally relevant),
 *   - a CANDIDATE PORTFOLIO SUMMARY in sanitised, operational fields only —
 *     ids, descriptor bins, the four scores, the cheap test and the lineage
 *     reference. The baton's prose (`hypothesis`, `mechanism`) is deliberately
 *     NOT copied into the resume report: the summary counts how much it left
 *     behind (`prose_omitted`) instead of quietly carrying it, and
 *   - the candidates that already became CONTROLLER WORK ITEMS, read from the
 *     work queue by the baton/seed provenance the adapter wrote.
 *
 * A baton that may not be resumed is REFUSED BY NAME and excluded — never
 * silently absent:
 *
 *   no_baton            the mission has no baton at all
 *   foreign_identity    the only rows belong to another identity and are private
 *   stale_version       `creative_baton_version` is not the current version
 *   tampered            the payload hash no longer matches the stored document
 *   invalid             the stored row fails the closed schema / secret scan
 *   not_promoted        a private baton — resuming is a promoted artefact's job
 *   revoked             the mission is cancelled/completed, so the baton is dead
 *
 * NO private content, ever: the section is built from the baton (an
 * allow-listed, secret-scanned packet), the work queue rows the baton's own
 * provenance points at, and counts. It never reads a journal, a reflection, a
 * salience trace or another identity's private row, and the refusal reasons
 * name the check that failed rather than quoting stored text.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS } from '../mission-cognition/collections.js';
import { CREATIVE_BATON_COLLECTIONS } from './creative-baton-collections.js';
import {
  CREATIVE_BATON_VERSION,
  verifyStoredBaton,
  type CreativeBaton,
} from './creative-baton-compiler.js';
import { ADAPTER_WORK_ITEM_TRIGGER } from './imagination-outcome-service.js';

/** How many stored rows one resume may look at (the newest first). */
export const MAX_BATON_ROWS = 10;
/** How many work items the section reports (the queue is the controller's). */
export const MAX_RESUME_WORK_ITEMS = 50;

export type BatonResumeCode =
  | 'included'
  | 'no_baton'
  | 'foreign_identity'
  | 'stale_version'
  | 'tampered'
  | 'invalid'
  | 'not_promoted'
  | 'revoked';

export interface BatonResumeCandidateSummary {
  seed_id: string;
  descriptor_bins: string[];
  novelty_score: number;
  coherence_score: number;
  expected_information_gain: number;
  cheapest_test: string;
  lineage_ref: string;
  /** The candidate's own quality, recomputed from its stored scores. */
  quality: number;
  /** The number of prose fields (hypothesis/mechanism) NOT copied here. */
  prose_omitted: number;
  work_item_ids: string[];
}

export interface BatonResumeWorkItem {
  work_item_id: string;
  seed_id: string | null;
  status: string | null;
  source: string | null;
}

export interface BatonResumeSection {
  status: 'absent' | 'included' | 'refused';
  code: BatonResumeCode;
  /** The named refusal, or the reason the baton was included. */
  reason: string;
  baton_id: string | null;
  creative_baton_version: string | null;
  mission_version: number | null;
  cycle_id: string | null;
  promoted: boolean;
  attention_targets: Array<{ cue: string; why_operationally_relevant: string }>;
  candidate_portfolio: BatonResumeCandidateSummary[];
  work_items: BatonResumeWorkItem[];
  counts: {
    rows_scanned: number;
    superseded_batons: number;
    attention_targets: number;
    candidates: number;
    candidates_with_work_item: number;
    work_items: number;
    prose_fields_omitted: number;
  };
  privacy: {
    raw_reflections_included: false;
    private_text_included: false;
    /** Where every field of this section came from. */
    basis: string;
  };
  basis: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function finite(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/** The four quality weights, read from the archive's documented function. */
const QUALITY_WEIGHTS = { novelty: 0.35, coherence: 0.25, testability: 0.25, information_gain: 0.15 } as const;

function qualityOf(input: {
  novelty_score: number;
  coherence_score: number;
  expected_information_gain: number;
  cheapest_test: string;
}): number {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  // `testability_score` is not carried by the baton's allow-list (the candidate
  // row has `cheapest_test` instead): an executable cheap test is what makes a
  // candidate testable, so its presence is worth the full testability weight
  // and its absence nothing. Stated here because the number is reported.
  const testability = input.cheapest_test.trim().length > 0 ? 1 : 0;
  return Number(
    (
      QUALITY_WEIGHTS.novelty * clamp(input.novelty_score) +
      QUALITY_WEIGHTS.coherence * clamp(input.coherence_score) +
      QUALITY_WEIGHTS.testability * testability +
      QUALITY_WEIGHTS.information_gain * clamp(input.expected_information_gain)
    ).toFixed(6),
  );
}

function emptySection(
  code: BatonResumeCode,
  reason: string,
  counts: Partial<BatonResumeSection['counts']> = {},
): BatonResumeSection {
  return {
    status: code === 'no_baton' ? 'absent' : 'refused',
    code,
    reason,
    baton_id: null,
    creative_baton_version: null,
    mission_version: null,
    cycle_id: null,
    promoted: false,
    attention_targets: [],
    candidate_portfolio: [],
    work_items: [],
    counts: {
      rows_scanned: 0,
      superseded_batons: 0,
      attention_targets: 0,
      candidates: 0,
      candidates_with_work_item: 0,
      work_items: 0,
      prose_fields_omitted: 0,
      ...counts,
    },
    privacy: {
      raw_reflections_included: false,
      private_text_included: false,
      basis: 'nothing was read: the section carries no baton material',
    },
    basis: reason,
  };
}

/**
 * Read one mission's resume-facing baton section. Bounded (10 rows), ordered
 * (newest first), and total: every failure mode is a NAMED refusal, never a
 * throw and never a silent omission.
 */
export async function buildBatonResumeSection(
  db: Db,
  args: { missionId: string; userId: string; missionStatus?: string | null; callerTrusted?: boolean },
): Promise<BatonResumeSection> {
  const missionId = nonEmpty(args.missionId);
  const userId = nonEmpty(args.userId);
  if (!db || !missionId || !userId) {
    return emptySection('no_baton', 'a mission id and an owning identity are required to read a baton');
  }

  const rows = (
    (await db
      .collection(CREATIVE_BATON_COLLECTIONS.creativeBatons)
      .find({ mission_id: missionId }, { projection: { _id: 0 } })
      // ONE sort key (the newest first) plus a JS tie-break below: a multi-key
      // sort is not portable across the stores this repo runs on (the in-memory
      // fake applies its keys one after another, the driver as one key), and
      // "which baton is newest" decides whether the resume includes or refuses
      // a packet — it must not depend on the store's sort semantics.
      .sort({ created_at: -1 })
      .limit(MAX_BATON_ROWS)
      .toArray()
  ) as unknown as CreativeBaton[]).sort((left, right) => {
    const byTime = String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''));
    if (byTime !== 0) return byTime;
    return String(left.baton_id ?? '').localeCompare(String(right.baton_id ?? ''));
  });

  if (rows.length === 0) {
    return emptySection('no_baton', `mission ${missionId} holds no creative baton`);
  }

  // Visible means: the mission's owning identity, a promoted (team-shared)
  // artefact, or a trusted caller. A private row of another identity is never
  // read at all.
  const visible = rows.filter(
    (row) =>
      row.user_id === userId || nonEmpty(row.shared_id) !== null || args.callerTrusted === true,
  );
  if (visible.length === 0) {
    return emptySection(
      'foreign_identity',
      `${rows.length} baton row(s) exist for this mission but none belongs to '${userId}' and none is promoted`,
      { rows_scanned: rows.length },
    );
  }

  const baton = visible[0];
  const superseded = visible.length - 1;
  const identified = {
    baton_id: nonEmpty(baton.baton_id),
    creative_baton_version: nonEmpty(baton.creative_baton_version),
    mission_version: Number.isFinite(Number(baton.mission_version)) ? Number(baton.mission_version) : null,
    cycle_id: nonEmpty(baton.cycle_id),
  };
  const refused = (code: BatonResumeCode, reason: string): BatonResumeSection => ({
    ...emptySection(code, reason, { rows_scanned: rows.length, superseded_batons: superseded }),
    ...identified,
    promoted: nonEmpty(baton.shared_id) !== null || nonEmpty(baton.promotion_id) !== null,
  });

  // The version the controller honours is the CURRENT one: a baton compiled by
  // an older (or unknown) compiler is stale, and resuming it would hand the
  // controller a packet whose shape it no longer understands.
  if (identified.creative_baton_version !== CREATIVE_BATON_VERSION) {
    return refused(
      'stale_version',
      `stale baton ${identified.baton_id ?? '(unidentified)'}: creative_baton_version ` +
        `${identified.creative_baton_version ?? '(missing)'} is not the current ${CREATIVE_BATON_VERSION}`,
    );
  }

  const integrity = verifyStoredBaton(baton as unknown as Record<string, unknown>);
  if (!integrity.ok) {
    return refused(
      integrity.code === 'payload_hash_mismatch' ? 'tampered' : 'invalid',
      `${integrity.code === 'payload_hash_mismatch' ? 'tampered' : 'invalid'} baton ` +
        `${identified.baton_id ?? '(unidentified)'} (${integrity.code}): ${integrity.reason}`,
    );
  }

  const promoted = nonEmpty(baton.shared_id) !== null || nonEmpty(baton.promotion_id) !== null;
  if (!promoted) {
    return refused(
      'not_promoted',
      `baton ${identified.baton_id} exists but was never promoted — the resume surface carries the ` +
        'active PROMOTED artefact only (the private one is readable by its owner through the baton tools)',
    );
  }

  const missionStatus = nonEmpty(args.missionStatus);
  if (missionStatus === 'cancelled' || missionStatus === 'completed') {
    return refused(
      'revoked',
      `baton ${identified.baton_id} is revoked: mission ${missionId} is ${missionStatus}, so the baton is dead ` +
        'and must not be resumed',
    );
  }

  // ── Build the section (sanitised fields only) ─────────────────────────────
  const attentionTargets = (baton.attention_targets ?? [])
    .map((target) => ({
      cue: String(target?.cue ?? '').trim(),
      why_operationally_relevant: String(target?.why_operationally_relevant ?? '').trim(),
    }))
    .filter((target) => target.cue.length > 0)
    .slice(0, 12);

  const candidates = baton.candidate_portfolio ?? [];
  const workItems = await readBatonWorkItems(db, baton, candidates.map((candidate) => candidate.seed_id));
  const workItemIdsBySeed = new Map<string, string[]>();
  for (const row of workItems) {
    if (!row.seed_id) continue;
    workItemIdsBySeed.set(row.seed_id, [...(workItemIdsBySeed.get(row.seed_id) ?? []), row.work_item_id]);
  }

  let proseOmitted = 0;
  const portfolio: BatonResumeCandidateSummary[] = candidates.map((candidate) => {
    const raw = candidate as unknown as Record<string, unknown>;
    const hypothesis = String(raw.hypothesis ?? '');
    const mechanism = String(raw.mechanism ?? '');
    if (hypothesis.length > 0) proseOmitted += 1;
    if (mechanism.length > 0) proseOmitted += 1;
    const cheapestTest = String(candidate.cheapest_test ?? '');
    return {
      seed_id: String(candidate.seed_id ?? ''),
      descriptor_bins: [...(candidate.descriptor_bins ?? [])],
      novelty_score: finite(candidate.novelty_score),
      coherence_score: finite(candidate.coherence_score),
      expected_information_gain: finite(candidate.expected_information_gain),
      cheapest_test: cheapestTest,
      lineage_ref: String(candidate.lineage_ref ?? ''),
      quality: qualityOf({
        novelty_score: finite(candidate.novelty_score),
        coherence_score: finite(candidate.coherence_score),
        expected_information_gain: finite(candidate.expected_information_gain),
        cheapest_test: cheapestTest,
      }),
      prose_omitted: 2,
      work_item_ids: workItemIdsBySeed.get(String(candidate.seed_id ?? '')) ?? [],
    };
  });

  const withWorkItem = portfolio.filter((row) => row.work_item_ids.length > 0).length;
  return {
    status: 'included',
    // The INCLUDED case names itself: before this, a section that carried the
    // promoted baton reported `code: 'no_baton'` — the same code the ABSENT and
    // failed-read cases use — so a reader branching on the code alone read
    // "there is no baton" from a baton the resume had just included. Found by
    // the full-loop live run on a real mission (docs/IMAGINATION-LOOP-LIVE.md).
    code: 'included',
    reason:
      `active promoted baton ${identified.baton_id} (version ${identified.creative_baton_version}, ` +
      `compiled at mission version ${identified.mission_version ?? 'unknown'}) is current and re-verified`,
    ...identified,
    promoted: true,
    attention_targets: attentionTargets,
    candidate_portfolio: portfolio,
    work_items: workItems,
    counts: {
      rows_scanned: rows.length,
      superseded_batons: superseded,
      attention_targets: attentionTargets.length,
      candidates: portfolio.length,
      candidates_with_work_item: withWorkItem,
      work_items: workItems.length,
      prose_fields_omitted: proseOmitted,
    },
    privacy: {
      raw_reflections_included: false,
      private_text_included: false,
      basis:
        'creative_batons (the verified promoted row), cognitive_work_items (rows whose provenance points at this ' +
        'baton/seed) and the mission state — the baton is an allow-listed, secret-scanned packet, and its prose ' +
        'fields are COUNTED as omitted rather than copied into the resume report',
    },
    basis:
      `${rows.length} baton row(s) scanned (newest first), ${superseded} superseded, the newest verified against ` +
      `creative_baton_version ${CREATIVE_BATON_VERSION}, the closed schema, the secret scan and the payload hash; ` +
      `${portfolio.length} candidate(s), ${withWorkItem} already turned into work items`,
  };
}

/** The work items the adapter derived from this baton (by baton/seed provenance). */
async function readBatonWorkItems(
  db: Db,
  baton: CreativeBaton,
  seedIds: readonly string[],
): Promise<BatonResumeWorkItem[]> {
  const batonId = nonEmpty(baton.baton_id);
  if (!batonId) return [];
  const rows = (await db
    .collection(COLLECTIONS.cognitiveWorkItems)
    .find(
      { mission_id: baton.mission_id, 'provenance.baton_id': batonId },
      { projection: { _id: 0, work_item_id: 1, status: 1, description: 1, provenance: 1, trigger: 1 } },
    )
    .limit(MAX_RESUME_WORK_ITEMS)
    .toArray()
    .catch(() => [] as unknown[])) as unknown as Array<Record<string, any>>;
  const known = new Set(seedIds.map((id) => String(id)));
  return rows
    .map((row) => {
      const provenance = (row.provenance ?? {}) as Record<string, unknown>;
      const seedId = nonEmpty(provenance.seed_id);
      return {
        work_item_id: String(row.work_item_id ?? ''),
        seed_id: seedId,
        status: nonEmpty(row.status),
        source: nonEmpty(provenance.source) ?? nonEmpty(row.trigger),
      };
    })
    .filter((row) => row.work_item_id.length > 0 && (row.seed_id === null || known.has(row.seed_id)))
    .sort((left, right) => left.work_item_id.localeCompare(right.work_item_id));
}

/** The trigger the controller adapter stamps on a baton-derived work item. */
export const BATON_WORK_ITEM_TRIGGER = ADAPTER_WORK_ITEM_TRIGGER;
