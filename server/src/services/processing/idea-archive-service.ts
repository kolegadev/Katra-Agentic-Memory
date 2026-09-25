/**
 * Idea archive — the quality-diversity archive for hypothesis seeds
 * (ITER-6, Phase 4).
 *
 * Contract: CONTRACT-iter6-imagination-engine.md §B. This module owns four
 * things and nothing else:
 *
 *   1. THE DESCRIPTOR SPACE. Five dimensions — `mechanism`, `representation`,
 *      `violated_assumption`, `evidence_family`, `test_strategy` — each with a
 *      closed bin vocabulary. A CELL is the tuple of bins, so "the same kind of
 *      idea" is a location in the space, not a similarity judgement: two seeds
 *      land in one cell exactly when all five bins agree. The incumbent of a
 *      cell is the highest-quality seed in it.
 *
 *   2. QUALITY. `quality = f(novelty, coherence, testability,
 *      information_gain)`, a documented fixed-weight mean
 *      (`QUALITY_WEIGHTS`, summing to 1) over values already clamped to
 *      [0, 1] — so quality is comparable across operators and predictable
 *      rather than tuned.
 *
 *   3. DEDUPE. Deterministic near-duplicate detection over the seed's
 *      STATEMENT (hypothesis + mechanism). Three pure, documented
 *      measurements, in this order:
 *
 *        a. NORMALISED EQUALITY ("  Mixed   CASE!!  " ≡ "mixed case") is
 *           `duplicate_of`.
 *        b. CONTAINMENT over CONTENT tokens (stopword-filtered, ≥3 characters)
 *           — `|A ∩ B| / min(|A|, |B|)` — at or above
 *           `CONTAINMENT_THRESHOLD = 0.7` with at least
 *           `MIN_CONTAINMENT_OVERLAP = 2` shared tokens is `paraphrase_of`.
 *           This is the measurement that survives PADDING, and it is why the
 *           gate cannot be defeated by length: a stored statement with 800
 *           extra characters appended still contains (almost) every content
 *           token of the original, so containment stays ≈ 1.0 while Jaccard
 *           collapses toward 0. Directional by construction: the denominator
 *           is the SHORTER statement, so "verbose restatement of a stored
 *           seed" and "terse restatement of a stored seed" are caught alike.
 *        c. JACCARD over the full token sets at `PARAPHRASE_THRESHOLD = 0.72`,
 *           with the length guard (`LENGTH_GUARD_RATIO = 0.5`) applied ONLY
 *           where containment is genuinely low. The guard keeps its original
 *           job — never scoring a one-line claim against a paragraph as if
 *           length were free — but it is no longer an escape hatch: a padded
 *           restatement is caught by (b) before the guard is consulted. A
 *           sentence that appends hundreds of characters is admitted only
 *           when its CONTENT really is new.
 *
 *      A match against the mission's exclusion list (rejected hypotheses and
 *      the trace's low-confidence regions) is `excluded_region`, and the same
 *      three measurements apply to it (a padded restatement of a ruled-out
 *      hypothesis is a ruled-out hypothesis). Every rejection carries its
 *      reason and the id it collided with.
 *
 *      ONE GATE, AND IT IS COMPARED FIELD BY FIELD (two ITER-6 residuals):
 *        - the containment branch fires at the SAME threshold the archive
 *          compares against (`CONTAINMENT_THRESHOLD = PARAPHRASE_THRESHOLD`),
 *          so there is no band in which the documented rule and the operative
 *          gate disagree;
 *        - a candidate is compared against a stored seed as the MAXIMUM of
 *          three measurements — hypothesis against hypothesis, mechanism
 *          against mechanism, and comparable text against comparable text —
 *          exactly the way an exclusion region is compared. Comparing only the
 *          concatenations let a VERBATIM hypothesis followed by a fresh
 *          mechanism dilute the overlap below the gate (5 shared content tokens
 *          out of 15 reads as 0.33, not as 1.0), so a restated claim could be
 *          admitted as new merely by rewording its mechanism.
 *
 *   4. CHANGED-PREMISE RE-ENTRY. An excluded idea may come back ONLY with a
 *      valid changed premise AND a lineage link to the prior rejection
 *      (`parent_seed_ids` naming it). A VALID premise is deterministic and
 *      shape is not enough — it must
 *        (a) be a complete sentence (≥ `MIN_CHANGED_PREMISE_WORDS` words and a
 *            terminator, `isCompletePremise`),
 *        (b) pass the VACUITY check: it may not be a no-change assertion
 *            ("nothing has changed", "no change", "same as before",
 *            "unchanged", "as before", … — `NO_CHANGE_PHRASES`), because
 *            "nothing has changed" is the opposite of a changed premise, and
 *        (c) INTRODUCE CHANGE: at least `MIN_CHANGED_PREMISE_TOKENS = 2`
 *            distinct content tokens (≥4 characters, stopword-filtered) that
 *            do NOT appear in the excluded/rejected text it is re-opening — a
 *            premise that only restates the rejected idea has changed nothing.
 *      A premise that fails (a), (b) or (c) is rejected with a reason that
 *      names the failure (`missing_changed_premise`, `vacuous_changed_premise`,
 *      `premise_restates_exclusion`); a valid premise without a lineage link is
 *      `missing_lineage_link`. With both, the cell's history records the
 *      re-entry and the premise is stored on the seed.
 *
 *      TWO LIMITATIONS OF THIS GATE, STATED PLAINLY (ITER-6 residual, no code
 *      change — the behaviour is unchanged and is the behaviour the gate
 *      intends):
 *        - THE VACUITY STOPLIST IS FINITE. `NO_CHANGE_PHRASES` is a closed list
 *          of English phrasings (22 of them, matched longest-first as whole
 *          words). A no-change assertion phrased OUTSIDE the list — "the
 *          situation is what it was", "we are where we were" — passes (b), and
 *          is then caught only if it also fails (c): either it introduces no new
 *          content token (rejected as `premise_restates_exclusion`) or it does
 *          introduce some, in which case this gate has no further defence. The
 *          stoplist is deliberately blunt and errs toward refusing a re-entry,
 *          but it is not a semantic understanding of "changed".
 *        - THERE IS NO SYNONYM REWRITE. A premise that restates the excluded
 *          text in synonyms ("the nightly rebuild", "the compaction process")
 *          introduces tokens the excluded text does not contain, so (c) counts
 *          them as change and the re-entry is admitted. Catching that would need
 *          an embedding or a thesaurus; this module has neither, and pretending
 *          otherwise by tuning the token floor would only move the hole. The
 *          archive's own dedupe (1–3) is what keeps such a re-entry honest: it
 *          lands in the SAME descriptor cell as the prior rejection, where it
 *          has to beat the incumbent to take the cell over.
 *
 * PRIVACY. Seeds and lineages are personal kinds and cells are identity-owned
 * (see imagination-collections.ts); every write resolves its scope through
 * `resolveWriteScope` and is `stripSharedId`-ed, so no document here can carry
 * a `shared_id`. `coverage()` and `listIncumbents()` are the SANITIZED
 * surface: bins, counts, quality and ids — never a statement, a memo, an
 * evidence text or reflection material.
 *
 * DETERMINISM. Nothing in this module generates an id: ids arrive derived
 * (content + PRNG seed + mission) and everything else is a pure function of
 * the store. Timestamps live only on the rows (`created_at`, history `at`),
 * never inside the portfolio payload.
 */
import type { Db } from 'mongodb';
import { resolveWriteScope, stripSharedId } from '../memory/write-scope-policy.js';
import { SCHEMA_IDS, validateAgainst } from '../mission-cognition/schema-registry.js';
import {
  IMAGINATION_COLLECTIONS,
  IDEA_ARCHIVE_CELL_KIND,
  IDEA_LINEAGE_KIND,
  IDEA_SEED_KIND,
  ensureImaginationIndexes,
} from './imagination-collections.js';
import type { OperatorFamily } from './imagination-operators.js';

// ── Descriptor space ────────────────────────────────────────────────────────

export const DESCRIPTOR_DIMENSIONS = [
  'mechanism',
  'representation',
  'violated_assumption',
  'evidence_family',
  'test_strategy',
] as const;

export type DescriptorDimension = (typeof DESCRIPTOR_DIMENSIONS)[number];

/**
 * The closed bin vocabulary per dimension. `unclassified` is always available
 * (and is the fallback for anything the model did not choose from the list):
 * an unclassified seed is still archived, in a cell of its own, and counted in
 * the coverage view's occupancy denominator.
 */
export const DESCRIPTOR_BINS: Record<DescriptorDimension, readonly string[]> = {
  mechanism: ['removal', 'substitution', 'reversal', 'amplification', 'relocation', 'composition'],
  representation: ['prose', 'list', 'table', 'graph', 'numeric', 'protocol'],
  violated_assumption: ['necessity', 'sufficiency', 'independence', 'stability', 'scarcity', 'identity'],
  evidence_family: [
    'operational_state',
    'epistemic_ledger',
    'work_queue',
    'temporal_series',
    'external_observation',
    'trace_absence',
  ],
  test_strategy: ['cheapest_probe', 'ab_test', 'simulation', 'instrumentation', 'observation_study', 'kill_criterion'],
};

export const UNCLASSIFIED_BIN = 'unclassified';

export type DescriptorBins = Record<DescriptorDimension, string>;

export function emptyBins(): DescriptorBins {
  return DESCRIPTOR_DIMENSIONS.reduce((acc, dimension) => {
    acc[dimension] = UNCLASSIFIED_BIN;
    return acc;
  }, {} as DescriptorBins);
}

function binCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalise the model's descriptor assignment. Accepts the record form
 * (`{mechanism: 'removal', …}`) and the ordered-array form
 * (`['removal', …, …]` in `DESCRIPTOR_DIMENSIONS` order), because a hostile
 * model emits either. Anything not in the vocabulary becomes `unclassified`
 * and is counted — never silently invented, never allowed to widen the space.
 */
export function normalizeBins(raw: unknown): { bins: DescriptorBins; descriptor_bins: string[]; unclassified: number } {
  const bins = emptyBins();
  let unclassified = 0;
  const record = (dimension: DescriptorDimension, value: unknown): void => {
    const candidate = binCandidate(value);
    const chosen = candidate && DESCRIPTOR_BINS[dimension].includes(candidate) ? candidate : UNCLASSIFIED_BIN;
    bins[dimension] = chosen;
    if (chosen === UNCLASSIFIED_BIN) unclassified += 1;
  };

  if (Array.isArray(raw)) {
    DESCRIPTOR_DIMENSIONS.forEach((dimension, index) => record(dimension, raw[index]));
  } else if (raw && typeof raw === 'object') {
    const source = raw as Record<string, unknown>;
    for (const dimension of DESCRIPTOR_DIMENSIONS) record(dimension, source[dimension]);
  } else {
    for (const dimension of DESCRIPTOR_DIMENSIONS) record(dimension, null);
  }

  return { bins, descriptor_bins: DESCRIPTOR_DIMENSIONS.map((dimension) => bins[dimension]), unclassified };
}

/** The cell key: the tuple of bins, in dimension order, as one storable string. */
export function cellKeyFor(bins: DescriptorBins): string {
  return DESCRIPTOR_DIMENSIONS.map((dimension) => `${dimension}=${bins[dimension]}`).join('|');
}

/** Every cell the space can address (used for `occupancy.possible`). */
export function possibleCellCount(): number {
  return DESCRIPTOR_DIMENSIONS.reduce((product, dimension) => product * (DESCRIPTOR_BINS[dimension].length + 1), 1);
}

// ── Quality ─────────────────────────────────────────────────────────────────

/**
 * The documented quality function. Fixed weights, summing to 1, over values
 * already clamped into [0, 1]: quality is a mean, not a score to be tuned, and
 * two seeds with the same four numbers always compare the same way.
 */
export const QUALITY_WEIGHTS = {
  novelty: 0.35,
  coherence: 0.25,
  testability: 0.25,
  information_gain: 0.15,
} as const;

export function qualityOf(input: {
  novelty_score: number;
  coherence_score: number;
  testability_score: number;
  expected_information_gain: number;
}): number {
  const clamp = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
  const quality =
    QUALITY_WEIGHTS.novelty * clamp(input.novelty_score) +
    QUALITY_WEIGHTS.coherence * clamp(input.coherence_score) +
    QUALITY_WEIGHTS.testability * clamp(input.testability_score) +
    QUALITY_WEIGHTS.information_gain * clamp(input.expected_information_gain);
  return Number(quality.toFixed(6));
}

// ── Similarity / dedupe ─────────────────────────────────────────────────────

/** At or above this Jaccard overlap the seed is a PARAPHRASE (rejected). */
export const PARAPHRASE_THRESHOLD = 0.72;
/**
 * Containment at or above this fraction of the SHORTER statement's content
 * tokens makes the pair a paraphrase — regardless of how much longer the other
 * one is.
 *
 * ONE EFFECTIVE THRESHOLD (the ITER-6 residual fix): this constant IS the gate
 * the archive compares against — `PARAPHRASE_THRESHOLD` — and is not merely
 * close to it. Before, containment fired at 0.7 while the archive rejected at
 * 0.72, so a containment value in `[0.7, 0.72)` returned early from
 * `statementSimilarity` (skipping the Jaccard branch entirely) and was then
 * judged "not a duplicate" by the caller: a band in which the documented
 * containment rule and the operative gate disagreed. There is now one number;
 * raising or lowering `PARAPHRASE_THRESHOLD` moves both together.
 */
export const CONTAINMENT_THRESHOLD = PARAPHRASE_THRESHOLD;
/**
 * The arithmetic floor for containment to be decisive: with fewer than two
 * shared content tokens "overlap" is not a measurement (a single shared word
 * would make a two-word fragment a paraphrase of any paragraph containing it).
 */
export const MIN_CONTAINMENT_OVERLAP = 2;
/** Content tokens are normalised tokens at least this long. */
export const MIN_CONTENT_TOKEN_CHARS = 3;
/** The changed-premise rule uses the same notion with a 4-character floor. */
export const MIN_PREMISE_TOKEN_CHARS = 4;
/**
 * Length guard: when the two statements differ in length by more than this
 * fraction of the longer one, JACCARD similarity is reported as 0 — a short
 * restatement and a long one are not Jaccard-paraphrases of each other. It is
 * consulted only when CONTENT CONTAINMENT is low (`statementSimilarity`), so it
 * cancels the Jaccard branch for a haiku-vs-paragraph pair without letting a
 * padded restatement through the containment branch.
 */
export const LENGTH_GUARD_RATIO = 0.5;

/**
 * The stopword list for CONTENT tokens. Function words carry no topic, which
 * is exactly why padding is cheap to produce and why containment must ignore
 * them: "the queue starves" + 800 characters of "in addition to the above, the
 * broader picture …" keeps every content token of the original and adds none of
 * its own.
 */
export const CONTENT_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'he', 'her', 'here',
  'hers', 'him', 'his', 'how', 'however', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'may',
  'me', 'might', 'more', 'most', 'must', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'one', 'only',
  'onto', 'or', 'other', 'our', 'out', 'over', 'own', 'same', 'shall', 'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'upon', 'us', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'would', 'you', 'your',
]);

/** Lowercase, punctuation to spaces, collapse whitespace. */
export function normalizeStatement(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenSet(text: string): Set<string> {
  const normalized = normalizeStatement(text);
  return new Set(normalized.length > 0 ? normalized.split(' ') : []);
}

/**
 * The CONTENT tokens of a text: its normalised tokens minus `CONTENT_STOPWORDS`
 * and minus anything shorter than `minChars`. Deterministic and pure — the same
 * text always yields the same set, and the set is what containment measures.
 */
export function contentTokens(text: string, minChars: number = MIN_CONTENT_TOKEN_CHARS): Set<string> {
  const out = new Set<string>();
  for (const token of tokenSet(text)) {
    if (token.length < minChars) continue;
    if (CONTENT_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/** One containment measurement: the ratio, and the shared tokens behind it. */
export interface ContainmentMeasure {
  /** `|A ∩ B| / min(|A|, |B|)` over content tokens, 0 when either side is empty. */
  value: number;
  /** How many distinct content tokens the two share (the ratio's numerator). */
  shared: string[];
}

/**
 * Directional-by-construction overlap over content tokens: the denominator is
 * the SHORTER side, so "A restates B" and "B restates A" measure the same —
 * and neither can be diluted by appending text to the longer side.
 */
export function containmentMeasure(left: string, right: string): ContainmentMeasure {
  const a = contentTokens(left);
  const b = contentTokens(right);
  if (a.size === 0 || b.size === 0) return { value: 0, shared: [] };
  const shared = [...a].filter((token) => b.has(token)).sort();
  const denominator = Math.min(a.size, b.size);
  return { value: Number((shared.length / denominator).toFixed(6)), shared };
}

/** The containment ratio alone (see `containmentMeasure` for the shared set). */
export function statementContainment(left: string, right: string): number {
  return containmentMeasure(left, right).value;
}

/** The seed's comparable statement: the hypothesis and the mechanism it runs by. */
export function comparableText(seed: { hypothesis?: unknown; mechanism?: unknown }): string {
  return normalizeStatement(`${String(seed.hypothesis ?? '')} ${String(seed.mechanism ?? '')}`);
}

/**
 * Similarity of two statements, in [0, 1], pure and symmetric:
 *
 *   1. identical after normalisation            → 1
 *   2. content containment ≥ `CONTAINMENT_THRESHOLD` with at least
 *      `MIN_CONTAINMENT_OVERLAP` shared tokens  → the containment value
 *      (a padded or verbose restatement is a restatement, whatever its length)
 *   3. otherwise Jaccard over the full token sets, with `LENGTH_GUARD_RATIO`
 *      applied first — the guard now applies ONLY here, where containment is
 *      low, which is where "not comparable" is the honest answer.
 *
 * The returned value can be 1.0 for statements that are not byte-identical
 * (containment saturates whenever one statement's content is a subset of the
 * other's). EXACTNESS is therefore never decided by this number: the archive
 * reports `duplicate_of` from normalised equality and `paraphrase_of` from
 * this measurement.
 */
export function statementSimilarity(left: string, right: string): number {
  const a = normalizeStatement(left);
  const b = normalizeStatement(right);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const containment = containmentMeasure(a, b);
  if (containment.shared.length >= MIN_CONTAINMENT_OVERLAP && containment.value >= CONTAINMENT_THRESHOLD) {
    return containment.value;
  }
  const longer = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > LENGTH_GUARD_RATIO * longer) return 0;
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return Number((intersection / union).toFixed(6));
}

/** Two seeds collide when their comparable statements are similar enough. */
export function seedSimilarity(
  left: { hypothesis?: unknown; mechanism?: unknown },
  right: { hypothesis?: unknown; mechanism?: unknown },
): number {
  return statementSimilarity(comparableText(left), comparableText(right));
}

// ── Exclusions, rejections, admissions ──────────────────────────────────────

export type ExclusionKind = 'rejected_hypothesis' | 'excluded_region';

/** One region of idea space the mission has already ruled out. */
export interface ExclusionRegion {
  kind: ExclusionKind;
  /** The ruled-out statement (used ONLY for the similarity comparison). */
  text: string;
  /** The id it is anchored to: an epistemic entry id or a trace signal id. */
  ref: string;
}

export type RejectionReason =
  | 'duplicate_of'
  | 'paraphrase_of'
  | 'excluded_region'
  | 'schema_invalid'
  | 'missing_changed_premise'
  | 'vacuous_changed_premise'
  | 'premise_restates_exclusion'
  | 'missing_lineage_link';

export interface DuplicateMatch {
  reason: Extract<RejectionReason, 'duplicate_of' | 'paraphrase_of' | 'excluded_region'>;
  /** The id the candidate collided with (a seed id, or an exclusion's ref). */
  duplicate_of: string;
  similarity: number;
  source: 'seed' | 'rejection' | 'exclusion';
}

export interface DuplicateFinding {
  duplicate: boolean;
  reason: Extract<RejectionReason, 'duplicate_of' | 'paraphrase_of' | 'excluded_region'> | null;
  /** The id the candidate collided with (a seed id, or an exclusion's ref). */
  duplicate_of: string | null;
  similarity: number;
  source: 'seed' | 'rejection' | 'exclusion' | null;
  /**
   * EVERY region the candidate collides with, not just the closest one. The
   * changed-premise gate accepts a lineage link to ANY of them: one idea can be
   * ruled out both by the ledger and by an earlier archived rejection, and
   * insisting on one particular id would make the gate arbitrary.
   */
  matches: DuplicateMatch[];
}

export interface IdeaSeedInput {
  seed_id: string;
  user_id: string;
  mission_id: string;
  mission_version?: number;
  cycle_id?: string;
  prng_seed?: number;
  seed_source?: string;
  operator: OperatorFamily;
  hypothesis: string;
  mechanism: string;
  /** Ordered by `DESCRIPTOR_DIMENSIONS`; `bins` is the same tuple keyed by dimension. */
  descriptor_bins?: string[];
  bins?: DescriptorBins;
  evidence_refs: string[];
  novelty_score: number;
  coherence_score: number;
  testability_score: number;
  cheapest_test: string;
  expected_information_gain: number;
  parent_seed_ids: string[];
  /** Present only on a changed-premise re-entry; must be a complete sentence. */
  changed_premise?: string;
  lineage_ref: string;
  bridge_path?: string[];
  bridge?: string;
  novelty_self_reported?: number;
  rank?: number;
}

export interface IdeaSeedRejection {
  reason: RejectionReason;
  detail?: string | null;
  duplicate_of?: string | null;
  at: string;
}

export interface IdeaSeed extends Omit<IdeaSeedInput, 'descriptor_bins' | 'bins' | 'rank'> {
  schema_version: '1.0';
  descriptor_bins: string[];
  bins: DescriptorBins;
  cell_key: string;
  quality: number;
  rank: number;
  state: 'admitted' | 'rejected';
  incumbent: boolean;
  rejection?: IdeaSeedRejection;
  created_at: string;
}

export interface CellHistoryEntry {
  event: 'created' | 'replaced' | 'challenger_below_incumbent' | 'changed_premise_reentry';
  at: string;
  seed_id: string;
  cycle_id: string;
  reason: string;
  previous_incumbent_id?: string | null;
  previous_quality?: number | null;
  quality?: number | null;
  prior_rejection_id?: string | null;
  premise?: string | null;
}

export interface IdeaArchiveCell {
  schema_version: '1.0';
  user_id: string;
  mission_id: string;
  cell_key: string;
  bins: DescriptorBins;
  incumbent_seed_id: string;
  quality: number;
  history: CellHistoryEntry[];
  coverage_date: string;
  created_cycle_id: string;
  last_cycle_id: string;
  seed_count: number;
}

export interface IdeaLinage {
  schema_version: '1.0';
  lineage_id: string;
  seed_id: string;
  user_id: string;
  mission_id: string;
  cycle_id: string;
  operator: OperatorFamily;
  parent_seed_ids: string[];
  transformations: Array<{ type: string; detail?: string | null; at: string }>;
  tests: Array<{ name: string; detail?: string | null; at: string }>;
  results: Array<{ verdict: string; detail?: string | null; at: string }>;
  failure_signatures: Array<{ signature: string; at: string }>;
  changed_premise?: string;
  created_at: string;
  updated_at: string;
}

export type AdmissionDecision = 'admitted' | 'replaced' | 'below_incumbent' | 'unchanged' | 'rejected';

export interface AdmissionResult {
  decision: AdmissionDecision;
  seed: IdeaSeed | null;
  cell_key: string | null;
  bins: DescriptorBins | null;
  quality: number;
  incumbent: boolean;
  previous_incumbent_id: string | null;
  rejection?: { reason: RejectionReason; detail?: string | null; duplicate_of?: string | null };
  reentry?: { prior_rejection_id: string; premise: string };
  history?: CellHistoryEntry;
  lineage_id?: string;
}

export interface CoverageView {
  mission_id: string;
  user_id: string;
  cells_total: number;
  cells_by_dimension: Record<DescriptorDimension, Record<string, number>>;
  new_cells_this_cycle: number;
  cycle_id: string | null;
  occupancy: { occupied: number; possible: number; ratio: number };
  gaps: Array<{ dimension: DescriptorDimension; unoccupied_bins: string[] }>;
  descriptor_dimensions: DescriptorDimension[];
  coverage_date: string;
  /**
   * THE SCAN BEHIND THE NUMBERS (ITER-6 residual): every read this view is
   * built from is bounded, so the bounds and whether any of them bit are part of
   * the view. A truncated view still reports what it saw — it just says so,
   * instead of presenting a bounded scan as the whole archive.
   */
  scan: CoverageScan;
}

export interface CoverageScan {
  /** The bound on cells read (`MAX_COVERAGE_CELLS`). */
  cells_limit: number;
  cells_scanned: number;
  /** True when the cell scan hit its bound: `cells_total` is then a FLOOR. */
  cells_truncated: boolean;
  /** The bound on the dedupe scan (`MAX_DEDUPE_SCAN`). */
  seeds_dedupe_limit: number;
  seeds_scanned: number;
  /**
   * True when the mission holds at least `seeds_dedupe_limit` seeds, so the
   * dedupe scan cannot have seen all of them.
   */
  seeds_truncated: boolean;
  /** Any bound bit at all. */
  truncated: boolean;
}

export interface SeedOutcome {
  verdict: string;
  detail?: string | null;
  /** The test that produced the outcome — appended to the lineage's `tests`. */
  test?: string | null;
  failure_signature?: string | null;
  at?: string;
}

export interface ArchiveOptions {
  /** The mission's exclusions (ledger rejections + trace low-confidence regions). */
  exclusions?: readonly ExclusionRegion[];
}

const FAILURE_VERDICTS = new Set(['refuted', 'falsified', 'failed', 'rejected', 'abandoned']);

/** Bound on how many of the mission's seeds a dedupe pass compares against. */
export const MAX_DEDUPE_SCAN = 200;
/** Bound on cells read for a coverage view. */
export const MAX_COVERAGE_CELLS = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function coverageDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A "sentence" for the changed-premise gate: at least a few words and a
 * terminator somewhere, so `'changed'` or `'n/a'` cannot open a closed gate.
 */
export const MIN_CHANGED_PREMISE_WORDS = 5;

export function isCompletePremise(premise: unknown): boolean {
  const text = nonEmpty(premise);
  if (!text) return false;
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length < MIN_CHANGED_PREMISE_WORDS) return false;
  return /[.!?;]/.test(text);
}

/**
 * The VACUITY stoplist: phrasings that assert that NOTHING changed. A premise
 * containing one of these is not a changed premise — "Nothing has changed here
 * at all." is six words and a terminator, and it opens nothing.
 *
 * Matched as a whole-word phrase against the normalised premise, longest first
 * so the reported phrase is the most specific one. The check is deliberately
 * blunt and errs toward refusing a re-entry: the caller may always state what
 * changed in plainer words, while a vacuous premise that slipped through would
 * re-open a ruled-out idea with no reason at all.
 */
export const NO_CHANGE_PHRASES: readonly string[] = [
  'nothing has really changed',
  'nothing has changed',
  'nothing changed',
  'nothing is different',
  'nothing new',
  'no new evidence',
  'no new information',
  'no changes',
  'no change',
  'no difference',
  'has not changed',
  'have not changed',
  'not changed',
  'remains unchanged',
  'remains the same',
  'still unchanged',
  'still the same',
  'same as previously',
  'same as before',
  'as previously',
  'as before',
  'unchanged',
];

/** The no-change phrase a premise asserts, or `null` when it asserts none. */
export function vacuousPremisePhrase(premise: unknown): string | null {
  const text = nonEmpty(premise);
  if (!text) return null;
  const normalized = ` ${normalizeStatement(text)} `;
  const ordered = [...NO_CHANGE_PHRASES].sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const phrase of ordered) {
    if (normalized.includes(` ${phrase} `)) return phrase;
  }
  return null;
}

/** `false` for a premise that merely says nothing changed. */
export function isVacuousPremise(premise: unknown): boolean {
  return vacuousPremisePhrase(premise) !== null;
}

/**
 * How many distinct content tokens a premise introduces that the excluded /
 * rejected text does NOT already contain (`MIN_PREMISE_TOKEN_CHARS`-floor,
 * stopword-filtered, case- and punctuation-insensitive). The list is sorted, so
 * it is stable and printable — a rejection can say exactly which words it found
 * (or that it found too few).
 */
export function newContentTokens(premise: unknown, priorTexts: readonly string[]): string[] {
  const text = nonEmpty(premise);
  if (!text) return [];
  const prior = new Set<string>();
  for (const priorText of priorTexts) {
    for (const token of contentTokens(priorText, MIN_PREMISE_TOKEN_CHARS)) prior.add(token);
  }
  return [...contentTokens(text, MIN_PREMISE_TOKEN_CHARS)].filter((token) => !prior.has(token)).sort();
}

/**
 * The number of NEW content tokens a valid changed premise must introduce. Two
 * is the smallest number that can name a change ("the window moved" names one
 * change; one token is a relabelling, and zero is a restatement).
 */
export const MIN_CHANGED_PREMISE_TOKENS = 2;

/**
 * Resolve + assert the write scope for one of this feature's documents. A
 * personal kind resolves private whatever the caller asks; a mission-indexed
 * kind (the archive cells) is written with the policy's own explicit opt-out.
 * Returns the document with `shared_id` removed, so a payload can never widen
 * the scope it was given.
 */
export function privateDoc<T extends object>(
  kind: string,
  userId: string,
  doc: T,
  opts: { private?: boolean } = {},
): T {
  const scope = resolveWriteScope({
    caller: { user_id: userId, trusted: false },
    kind,
    ...(opts.private ? { requested: { private: true } } : {}),
  });
  if (scope.shared_id !== null || scope.user_id !== userId) {
    throw new Error(
      `${kind} must be identity-owned but resolved { user_id: ${scope.user_id}, shared_id: ${scope.shared_id} }`,
    );
  }
  return stripSharedId(doc) as T;
}

export class IdeaArchiveError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'IdeaArchiveError';
  }
}

export class IdeaArchiveService {
  constructor(
    private readonly db: Db,
    private readonly options: ArchiveOptions = {},
  ) {}

  private seeds() {
    return this.db.collection<IdeaSeed>(IMAGINATION_COLLECTIONS.ideaSeeds);
  }

  private lineages() {
    return this.db.collection<IdeaLinage>(IMAGINATION_COLLECTIONS.ideaLineages);
  }

  private cells() {
    return this.db.collection<IdeaArchiveCell>(IMAGINATION_COLLECTIONS.ideaArchiveCells);
  }

  /** Every seed of one mission, newest first, bounded (deterministic order). */
  async getSeeds(userId: string, missionId: string, cycleId?: string): Promise<IdeaSeed[]> {
    const filter: Record<string, unknown> = { user_id: userId, mission_id: missionId };
    if (cycleId) filter.cycle_id = cycleId;
    const rows = (await this.seeds()
      .find(filter, { projection: { _id: 0 } })
      .sort({ created_at: -1, seed_id: 1 })
      .limit(MAX_DEDUPE_SCAN)
      .toArray()) as unknown as IdeaSeed[];
    return rows;
  }

  async getLineage(userId: string, lineageId: string): Promise<IdeaLinage | null> {
    return (await this.lineages().findOne(
      { lineage_id: lineageId, user_id: userId },
      { projection: { _id: 0 } },
    )) as unknown as IdeaLinage | null;
  }

  /** The lineage of one seed (the lineage rows are keyed by the seed too). */
  async getLineageForSeed(userId: string, seedId: string): Promise<IdeaLinage | null> {
    return (await this.lineages().findOne(
      { seed_id: seedId, user_id: userId },
      { projection: { _id: 0 } },
    )) as unknown as IdeaLinage | null;
  }

  /**
   * The mission's finished exclusion list: its own rejected seeds (rejections
   * are stored, so an exclusion is durable and re-enterable) plus whatever the
   * caller supplies from the ledger and the trace.
   */
  async exclusions(userId: string, missionId: string, extra: readonly ExclusionRegion[] = []): Promise<ExclusionRegion[]> {
    const rejected = (await this.seeds()
      .find({ user_id: userId, mission_id: missionId, state: 'rejected' }, { projection: { _id: 0 } })
      .sort({ seed_id: 1 })
      .limit(MAX_DEDUPE_SCAN)
      .toArray()) as unknown as IdeaSeed[];
    const fromArchive: ExclusionRegion[] = rejected.map((seed) => ({
      // The rejected seed's comparable text is hypothesis + mechanism, and the
      // comparison below tries the region against each field, so a stored
      // rejection is an exclusion in exactly the same shape as a ledger one.
      kind: 'rejected_hypothesis',
      text: `${seed.hypothesis} ${seed.mechanism}`,
      ref: seed.seed_id,
    }));
    return [...(this.options.exclusions ?? []), ...extra, ...fromArchive];
  }

  /**
   * Deterministic near-duplicate detection against everything the archive
   * already knows: the mission's seeds (exact → `duplicate_of`, near →
   * `paraphrase_of`), its stored rejections (same reasons, `source:
   * 'rejection'`) and the mission's exclusion list (`excluded_region`).
   */
  async isDuplicate(seed: IdeaSeedInput, extraExclusions: readonly ExclusionRegion[] = []): Promise<DuplicateFinding> {
    const id = nonEmpty(seed.seed_id) ?? '';
    const text = comparableText(seed);
    let best: DuplicateFinding = {
      duplicate: false,
      reason: null,
      duplicate_of: null,
      similarity: 0,
      source: null,
      matches: [],
    };

    const rows = await this.getSeeds(seed.user_id, seed.mission_id);
    for (const row of rows) {
      if (row.seed_id === id) continue;
      // THE SAME THREE MEASUREMENTS THE EXCLUSION PATH USES (ITER-6 residual):
      // hypothesis against hypothesis, mechanism against mechanism, and the
      // concatenation against the concatenation — the closest match wins.
      // Comparing only the concatenations let a VERBATIM hypothesis followed by
      // a reworded mechanism dilute the overlap below the gate and be admitted
      // as new. Exactness is still decided by normalised equality, never by the
      // score.
      const similarity = Math.max(
        seedSimilarity(seed, row),
        statementSimilarity(String(seed.hypothesis ?? ''), String(row.hypothesis ?? '')),
        statementSimilarity(String(seed.mechanism ?? ''), String(row.mechanism ?? '')),
      );
      if (similarity < PARAPHRASE_THRESHOLD) continue;
      const exact = comparableText(row) === text;
      const reason = exact ? 'duplicate_of' : 'paraphrase_of';
      best.matches.push({
        reason,
        duplicate_of: row.seed_id,
        similarity,
        source: row.state === 'rejected' ? 'rejection' : 'seed',
      });
      if (similarity <= best.similarity) continue;
      best = {
        ...best,
        duplicate: true,
        reason,
        duplicate_of: row.seed_id,
        similarity,
        source: row.state === 'rejected' ? 'rejection' : 'seed',
      };
      if (similarity === 1) break;
    }

    for (const region of await this.exclusions(seed.user_id, seed.mission_id, extraExclusions)) {
      // An exclusion is a SINGLE statement (a ruled-out hypothesis or a trace
      // region) while a seed's comparable text is its claim PLUS its mechanism,
      // so the region is compared against each of the two fields and the closer
      // match wins. Comparing it only against the concatenation would make the
      // length guard reject every short exclusion — a gate that never closes.
      const similarity = Math.max(
        statementSimilarity(seed.hypothesis, region.text),
        statementSimilarity(seed.mechanism, region.text),
        statementSimilarity(text, region.text),
      );
      if (similarity < PARAPHRASE_THRESHOLD) continue;
      best.matches.push({
        reason: 'excluded_region',
        duplicate_of: region.ref,
        similarity,
        source: 'exclusion',
      });
      if (similarity <= best.similarity) continue;
      best = {
        ...best,
        duplicate: true,
        reason: 'excluded_region',
        duplicate_of: region.ref,
        similarity,
        source: 'exclusion',
      };
    }

    if (best.reason === null) {
      // Similar but below the threshold: honestly NOT a duplicate (and the
      // similarity is reported so the caller can see how close it came).
      return { ...best, duplicate: false };
    }
    return best;
  }

  /**
   * Admit a seed into the archive, replace the cell's incumbent when the seed
   * beats it, or reject it with a reason. Idempotent: a seed_id that is already
   * stored is `unchanged` (no writes at all).
   *
   * `opts.premise` is the changed-premise re-entry. `opts.premise` OR
   * `seed.changed_premise` opens the gate for a seed that matches an exclusion,
   * but only together with a lineage link (a `parent_seed_ids` entry naming the
   * prior rejection) AND a premise that passes the three part rule in
   * `isCompletePremise` / `vacuousPremisePhrase` / `newContentTokens`: a
   * complete sentence that is not a no-change assertion and that introduces at
   * least `MIN_CHANGED_PREMISE_TOKENS` content tokens the excluded text does not
   * already contain. Whatever is missing is a rejection whose reason names it.
   */
  async admitOrReplace(
    seed: IdeaSeedInput,
    opts: { exclusions?: readonly ExclusionRegion[]; premise?: string | null } = {},
  ): Promise<AdmissionResult> {
    await ensureImaginationIndexes(this.db);
    const userId = nonEmpty(seed.user_id);
    const missionId = nonEmpty(seed.mission_id);
    if (!userId || !missionId) {
      throw new IdeaArchiveError('seed.user_id and seed.mission_id are required', 'invalid_args');
    }
    const seedId = nonEmpty(seed.seed_id);
    if (!seedId) throw new IdeaArchiveError('seed.seed_id is required', 'invalid_args');

    const { bins, descriptor_bins } = normalizeBins(seed.bins ?? seed.descriptor_bins);
    const cellKey = cellKeyFor(bins);
    const quality = qualityOf(seed);
    const extraExclusions = opts.exclusions ?? [];

    const stored = (await this.seeds().findOne(
      { seed_id: seedId, user_id: userId },
      { projection: { _id: 0 } },
    )) as unknown as IdeaSeed | null;
    if (stored) {
      return {
        decision: 'unchanged',
        seed: stored,
        cell_key: stored.cell_key,
        bins: stored.bins,
        quality: stored.quality,
        incumbent: stored.incumbent === true,
        previous_incumbent_id: null,
        ...(stored.rejection ? { rejection: { ...stored.rejection } } : {}),
      };
    }

    const finding = await this.isDuplicate({ ...seed, descriptor_bins }, extraExclusions);
    const premise = nonEmpty(opts.premise) ?? nonEmpty(seed.changed_premise);

    if (finding.reason) {
      // A match against the archive's own prior rejection or the mission's
      // exclusion list can be re-opened by a changed premise; an exact/near
      // duplicate of a LIVE seed cannot (there is nothing to re-open — the
      // incumbent already says it).
      const reopenable = finding.source === 'exclusion' || finding.source === 'rejection';
      if (!reopenable) {
        return this.reject(seed, bins, cellKey, quality, descriptor_bins, {
          reason: finding.reason,
          duplicate_of: finding.duplicate_of,
          detail: `similarity ${finding.similarity} against ${finding.duplicate_of}`,
        });
      }
      if (!premise) {
        return this.reject(seed, bins, cellKey, quality, descriptor_bins, {
          reason: 'excluded_region',
          duplicate_of: finding.duplicate_of,
          detail: `matches ${finding.duplicate_of} (${finding.reason}, similarity ${finding.similarity}) and carries no changed_premise`,
        });
      }
      // "A lineage link to the prior rejection": the seed must name one of the
      // regions it collides with — the closest match or any other — because an
      // idea can be ruled out by the ledger AND by an earlier archive rejection
      // at once, and either is a legitimate prior rejection to cite.
      const citingParents = (seed.parent_seed_ids ?? []).filter((parent) =>
        finding.matches.some((match) => match.duplicate_of === parent),
      );
      const priorRejectionId = citingParents[0] ?? finding.duplicate_of ?? '';
      const linked = citingParents.length > 0;
      if (!isCompletePremise(premise)) {
        return this.reject(seed, bins, cellKey, quality, descriptor_bins, {
          reason: 'missing_changed_premise',
          duplicate_of: finding.duplicate_of,
          detail: `changed_premise must be at least ${MIN_CHANGED_PREMISE_WORDS} words and a complete sentence`,
        });
      }
      // Shape is not enough. A premise must SAY WHAT CHANGED: a no-change
      // assertion is not a changed premise, and a premise that only restates
      // the text it is re-opening has changed nothing.
      const vacuous = vacuousPremisePhrase(premise);
      if (vacuous) {
        return this.reject(seed, bins, cellKey, quality, descriptor_bins, {
          reason: 'vacuous_changed_premise',
          duplicate_of: finding.duplicate_of,
          detail: `changed_premise asserts that nothing changed ("${vacuous}") against ${finding.duplicate_of}: it must name what is different since the idea was ruled out`,
        });
      }
      const excludedTexts = (await this.exclusions(seed.user_id, seed.mission_id, extraExclusions))
        .filter((region) => finding.matches.some((match) => match.duplicate_of === region.ref))
        .map((region) => region.text);
      const introduced = newContentTokens(premise, excludedTexts);
      if (introduced.length < MIN_CHANGED_PREMISE_TOKENS) {
        return this.reject(seed, bins, cellKey, quality, descriptor_bins, {
          reason: 'premise_restates_exclusion',
          duplicate_of: finding.duplicate_of,
          detail: `changed_premise introduces ${introduced.length} content token(s) that are not already in the excluded text (${introduced.join(', ') || 'none'}); at least ${MIN_CHANGED_PREMISE_TOKENS} are required`,
        });
      }
      if (!linked) {
        return this.reject(seed, bins, cellKey, quality, descriptor_bins, {
          reason: 'missing_lineage_link',
          duplicate_of: finding.duplicate_of,
          detail: `changed_premise given but parent_seed_ids names none of the prior rejections this seed collides with (${finding.matches
            .map((match) => match.duplicate_of)
            .join(', ')})`,
        });
      }
      return this.admit(seed, bins, cellKey, quality, descriptor_bins, {
        premise,
        priorRejectionId,
      });
    }

    // No collision: the seed may still carry a changed premise (a re-entry that
    // is no longer needed, or a deliberate restatement) — it is admitted and
    // the premise is kept on the row.
    return this.admit(seed, bins, cellKey, quality, descriptor_bins, {
      premise: premise ?? undefined,
      priorRejectionId: undefined,
    });
  }

  /** The explicit re-entry API: a changed premise is required, not inferred. */
  async changedPremiseReentry(
    seed: IdeaSeedInput,
    premise: string,
    opts: { exclusions?: readonly ExclusionRegion[] } = {},
  ): Promise<AdmissionResult> {
    return this.admitOrReplace({ ...seed, changed_premise: premise }, { ...opts, premise });
  }

  private async reject(
    seed: IdeaSeedInput,
    bins: DescriptorBins,
    cellKey: string,
    quality: number,
    descriptor_bins: string[],
    rejection: { reason: RejectionReason; detail?: string | null; duplicate_of?: string | null },
  ): Promise<AdmissionResult> {
    const rejectionRecord: IdeaSeedRejection = {
      reason: rejection.reason,
      detail: rejection.detail ?? null,
      duplicate_of: rejection.duplicate_of ?? null,
      at: nowIso(),
    };
    const doc = this.storedSeed(seed, bins, cellKey, quality, descriptor_bins, {
      state: 'rejected',
      incumbent: false,
      rejection: rejectionRecord,
    });
    const check = validateAgainst(SCHEMA_IDS.ideaSeed, doc);
    if (!check.valid) {
      // A document that cannot satisfy its own schema is NOT stored: the
      // rejection is reported (and counted) instead of writing a broken row.
      return {
        decision: 'rejected',
        seed: null,
        cell_key: cellKey,
        bins,
        quality,
        incumbent: false,
        previous_incumbent_id: null,
        rejection: {
          reason: 'schema_invalid',
          detail: `${rejection.reason}: ${check.errors.slice(0, 3).join('; ')}`,
          duplicate_of: rejection.duplicate_of ?? null,
        },
      };
    }
    await this.seeds().insertOne(privateDoc(IDEA_SEED_KIND, seed.user_id, doc));
    return {
      decision: 'rejected',
      seed: doc,
      cell_key: cellKey,
      bins,
      quality,
      incumbent: false,
      previous_incumbent_id: null,
      rejection: { reason: rejection.reason, detail: rejection.detail ?? null, duplicate_of: rejection.duplicate_of ?? null },
    };
  }

  private storedSeed(
    seed: IdeaSeedInput,
    bins: DescriptorBins,
    cellKey: string,
    quality: number,
    descriptor_bins: string[],
    extra: { state: 'admitted' | 'rejected'; incumbent: boolean; rejection?: IdeaSeedRejection },
  ): IdeaSeed {
    const doc: IdeaSeed = {
      schema_version: '1.0',
      seed_id: seed.seed_id,
      user_id: seed.user_id,
      mission_id: seed.mission_id,
      mission_version: Number.isFinite(seed.mission_version) ? Number(seed.mission_version) : 1,
      cycle_id: nonEmpty(seed.cycle_id) ?? 'cycle_manual',
      prng_seed: Number.isFinite(seed.prng_seed) ? Number(seed.prng_seed) : 0,
      ...(nonEmpty(seed.seed_source) ? { seed_source: String(seed.seed_source) } : {}),
      operator: seed.operator,
      hypothesis: seed.hypothesis,
      mechanism: seed.mechanism,
      descriptor_bins,
      bins,
      cell_key: cellKey,
      evidence_refs: [...(seed.evidence_refs ?? [])],
      novelty_score: Math.min(1, Math.max(0, seed.novelty_score)),
      coherence_score: Math.min(1, Math.max(0, seed.coherence_score)),
      testability_score: Math.min(1, Math.max(0, seed.testability_score)),
      expected_information_gain: Math.min(1, Math.max(0, seed.expected_information_gain)),
      cheapest_test: seed.cheapest_test,
      parent_seed_ids: [...(seed.parent_seed_ids ?? [])],
      lineage_ref: seed.lineage_ref,
      ...(nonEmpty(seed.changed_premise) ? { changed_premise: String(seed.changed_premise) } : {}),
      ...(seed.bridge_path?.length ? { bridge_path: [...seed.bridge_path] } : {}),
      ...(nonEmpty(seed.bridge) ? { bridge: String(seed.bridge) } : {}),
      ...(Number.isFinite(seed.novelty_self_reported)
        ? { novelty_self_reported: Number(seed.novelty_self_reported) }
        : {}),
      quality,
      rank: Number.isFinite(seed.rank) ? Number(seed.rank) : 0,
      state: extra.state,
      incumbent: extra.incumbent,
      ...(extra.rejection ? { rejection: extra.rejection } : {}),
      created_at: nowIso(),
    };
    return doc;
  }

  private async admit(
    seed: IdeaSeedInput,
    bins: DescriptorBins,
    cellKey: string,
    quality: number,
    descriptor_bins: string[],
    gate: { premise?: string; priorRejectionId?: string },
  ): Promise<AdmissionResult> {
    const at = nowIso();
    const cell = (await this.cells().findOne(
      { user_id: seed.user_id, mission_id: seed.mission_id, cell_key: cellKey },
      { projection: { _id: 0 } },
    )) as unknown as IdeaArchiveCell | null;

    const history: CellHistoryEntry =
      gate.priorRejectionId && gate.premise
        ? {
            event: 'changed_premise_reentry',
            at,
            seed_id: seed.seed_id,
            cycle_id: nonEmpty(seed.cycle_id) ?? 'cycle_manual',
            reason: 'changed_premise with a lineage link to the prior rejection',
            prior_rejection_id: gate.priorRejectionId,
            premise: gate.premise,
            previous_incumbent_id: cell?.incumbent_seed_id ?? null,
            previous_quality: cell?.quality ?? null,
            quality,
          }
        : !cell
          ? {
              event: 'created',
              at,
              seed_id: seed.seed_id,
              cycle_id: nonEmpty(seed.cycle_id) ?? 'cycle_manual',
              reason: 'first seed in this cell',
              previous_incumbent_id: null,
              previous_quality: null,
              quality,
            }
          : quality > cell.quality
            ? {
                event: 'replaced',
                at,
                seed_id: seed.seed_id,
                cycle_id: nonEmpty(seed.cycle_id) ?? 'cycle_manual',
                reason: `quality ${quality} beats the incumbent's ${cell.quality}`,
                previous_incumbent_id: cell.incumbent_seed_id,
                previous_quality: cell.quality,
                quality,
              }
            : {
                event: 'challenger_below_incumbent',
                at,
                seed_id: seed.seed_id,
                cycle_id: nonEmpty(seed.cycle_id) ?? 'cycle_manual',
                reason: `quality ${quality} does not beat the incumbent's ${cell.quality}`,
                previous_incumbent_id: cell.incumbent_seed_id,
                previous_quality: cell.quality,
                quality,
              };

    // The cell's invariant is "the incumbent is the highest-quality seed in
    // it", and a changed-premise re-entry does not suspend it: a re-entry with
    // a lower quality than the incumbent is admitted and recorded in the
    // history, but the incumbent keeps the cell.
    const isIncumbent = !cell || quality > cell.quality;
    const doc = this.storedSeed(seed, bins, cellKey, quality, descriptor_bins, {
      state: 'admitted',
      incumbent: isIncumbent,
    });

    const check = validateAgainst(SCHEMA_IDS.ideaSeed, doc);
    if (!check.valid) {
      return {
        decision: 'rejected',
        seed: null,
        cell_key: cellKey,
        bins,
        quality,
        incumbent: false,
        previous_incumbent_id: null,
        rejection: { reason: 'schema_invalid', detail: check.errors.slice(0, 3).join('; '), duplicate_of: null },
      };
    }

    await this.seeds().insertOne(privateDoc(IDEA_SEED_KIND, seed.user_id, doc));

    const lineage: IdeaLinage = {
      schema_version: '1.0',
      lineage_id: seed.lineage_ref,
      seed_id: seed.seed_id,
      user_id: seed.user_id,
      mission_id: seed.mission_id,
      cycle_id: nonEmpty(seed.cycle_id) ?? 'cycle_manual',
      operator: seed.operator,
      parent_seed_ids: [...(seed.parent_seed_ids ?? [])],
      transformations: [
        {
          type: `operator:${seed.operator}`,
          detail:
            gate.priorRejectionId && gate.premise
              ? `changed-premise re-entry against the prior rejection ${gate.priorRejectionId}`
              : `generated by ${seed.operator} in cycle ${nonEmpty(seed.cycle_id) ?? 'cycle_manual'}`,
          at,
        },
      ],
      tests: [],
      results: [],
      failure_signatures: [],
      ...(gate.premise ? { changed_premise: gate.premise } : {}),
      created_at: at,
      updated_at: at,
    };
    await this.lineages().insertOne(privateDoc(IDEA_LINEAGE_KIND, seed.user_id, lineage));

    const nextCell: IdeaArchiveCell = {
      schema_version: '1.0',
      user_id: seed.user_id,
      mission_id: seed.mission_id,
      cell_key: cellKey,
      bins,
      incumbent_seed_id: isIncumbent ? seed.seed_id : cell!.incumbent_seed_id,
      quality: isIncumbent ? quality : cell!.quality,
      history: [...(cell?.history ?? []), history],
      coverage_date: coverageDate(),
      created_cycle_id: cell?.created_cycle_id ?? nonEmpty(seed.cycle_id) ?? 'cycle_manual',
      last_cycle_id: nonEmpty(seed.cycle_id) ?? 'cycle_manual',
      seed_count: (cell?.seed_count ?? 0) + 1,
    };
    if (cell) {
      await this.cells().updateOne(
        { user_id: seed.user_id, mission_id: seed.mission_id, cell_key: cellKey },
        { $set: privateDoc(IDEA_ARCHIVE_CELL_KIND, seed.user_id, nextCell, { private: true }) },
      );
    } else {
      await this.cells().insertOne(
        privateDoc(IDEA_ARCHIVE_CELL_KIND, seed.user_id, nextCell, { private: true }),
      );
    }

    const decision: AdmissionDecision = isIncumbent ? (cell ? 'replaced' : 'admitted') : 'below_incumbent';
    return {
      decision,
      seed: doc,
      cell_key: cellKey,
      bins,
      quality,
      incumbent: isIncumbent,
      previous_incumbent_id: cell?.incumbent_seed_id ?? null,
      ...(gate.priorRejectionId && gate.premise
        ? { reentry: { prior_rejection_id: gate.priorRejectionId, premise: gate.premise } }
        : {}),
      history,
      lineage_id: seed.lineage_ref,
    };
  }

  /**
   * Record what happened to a seed after it was archived. Results are appended
   * to the lineage; a refuted/failed verdict (or an explicit failure signature)
   * also lands in `failure_signatures`, so a ruled-out idea leaves a trace that
   * a future changed-premise re-entry can cite.
   *
   * THE IDENTITY IS REQUIRED AND IS PART OF THE MATCH. The seed is looked up by
   * `{seed_id, user_id}`, so a caller cannot write into another identity's
   * lineage even if it guesses (or learns) a seed id: a cross-identity call
   * finds no seed and reports `null` — the same answer as an unknown id, which
   * keeps the failure indistinguishable from "no such seed". An empty identity
   * is a caller error and throws, because "record this outcome somewhere" is
   * not a request this archive can honour.
   */
  async recordOutcome(seedId: string, outcome: SeedOutcome, userId: string): Promise<IdeaLinage | null> {
    await ensureImaginationIndexes(this.db);
    const id = nonEmpty(seedId);
    if (!id) throw new IdeaArchiveError('seedId is required', 'invalid_args');
    const identity = nonEmpty(userId);
    if (!identity) {
      throw new IdeaArchiveError(
        'userId is required: an outcome is recorded against the identity that owns the seed',
        'invalid_args',
      );
    }
    const seed = (await this.seeds().findOne(
      { seed_id: id, user_id: identity },
      { projection: { _id: 0 } },
    )) as unknown as IdeaSeed | null;
    if (!seed) return null;

    const at = nonEmpty(outcome.at) ?? nowIso();
    const verdict = nonEmpty(outcome.verdict) ?? 'unknown';
    const detail = nonEmpty(outcome.detail);
    const failureSignature =
      nonEmpty(outcome.failure_signature) ??
      (FAILURE_VERDICTS.has(verdict.toLowerCase()) ? `${verdict}: ${detail ?? 'no detail recorded'}` : null);

    await this.lineages().updateOne(
      { lineage_id: seed.lineage_ref, user_id: seed.user_id },
      {
        $set: { updated_at: at },
        $push: {
          results: { verdict, detail: detail ?? null, at },
          ...(nonEmpty(outcome.test) ? { tests: { name: String(outcome.test), detail: detail ?? null, at } } : {}),
          ...(failureSignature ? { failure_signatures: { signature: failureSignature, at } } : {}),
        },
      },
    );
    return this.getLineage(seed.user_id, seed.lineage_ref);
  }

  /**
   * The SANITIZED coverage view: cells, bins, counts, quality and ids only —
   * plus the SCAN it was read through (`scan`), so a bounded read is never
   * presented as the whole archive. `cycleId` anchors
   * `new_cells_this_cycle`; without one the newest cycle the archive knows
   * about is used.
   */
  async coverage(missionId: string, userId: string, opts: { cycleId?: string } = {}): Promise<CoverageView> {
    const cells = (await this.cells()
      .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })
      .sort({ cell_key: 1 })
      .limit(MAX_COVERAGE_CELLS)
      .toArray()) as unknown as IdeaArchiveCell[];
    const seedCount = await this.seeds().countDocuments({ user_id: userId, mission_id: missionId });

    const cellsByDimension = DESCRIPTOR_DIMENSIONS.reduce((acc, dimension) => {
      acc[dimension] = {};
      return acc;
    }, {} as Record<DescriptorDimension, Record<string, number>>);
    for (const cell of cells) {
      for (const dimension of DESCRIPTOR_DIMENSIONS) {
        const bin = cell.bins?.[dimension] ?? UNCLASSIFIED_BIN;
        cellsByDimension[dimension][bin] = (cellsByDimension[dimension][bin] ?? 0) + 1;
      }
    }

    const cycleId = nonEmpty(opts.cycleId) ?? (await this.latestCycle(userId, missionId));
    const newCells = cycleId ? cells.filter((cell) => cell.created_cycle_id === cycleId).length : 0;

    const possible = possibleCellCount();
    return {
      mission_id: missionId,
      user_id: userId,
      cells_total: cells.length,
      cells_by_dimension: cellsByDimension,
      new_cells_this_cycle: newCells,
      cycle_id: cycleId,
      occupancy: {
        occupied: cells.length,
        possible,
        // Occupancy is the fraction of the descriptor space that is addressed.
        ratio: Number((cells.length / possible).toFixed(9)),
      },
      gaps: DESCRIPTOR_DIMENSIONS.map((dimension) => ({
        dimension,
        unoccupied_bins: DESCRIPTOR_BINS[dimension].filter(
          (bin) => (cellsByDimension[dimension][bin] ?? 0) === 0,
        ),
      })),
      descriptor_dimensions: [...DESCRIPTOR_DIMENSIONS],
      coverage_date: coverageDate(),
      scan: {
        cells_limit: MAX_COVERAGE_CELLS,
        cells_scanned: cells.length,
        cells_truncated: cells.length >= MAX_COVERAGE_CELLS,
        seeds_dedupe_limit: MAX_DEDUPE_SCAN,
        seeds_scanned: seedCount,
        seeds_truncated: seedCount >= MAX_DEDUPE_SCAN,
        truncated: cells.length >= MAX_COVERAGE_CELLS || seedCount >= MAX_DEDUPE_SCAN,
      },
    };
  }

  private async latestCycle(userId: string, missionId: string): Promise<string | null> {
    const newest = (await this.cells()
      .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })
      .sort({ coverage_date: -1, cell_key: 1 })
      .limit(1)
      .toArray()) as unknown as IdeaArchiveCell[];
    return newest[0]?.last_cycle_id ?? null;
  }

  /**
   * The archive's shareable surface: one sanitized summary per cell — ids,
   * bins and quality ONLY. No hypothesis, no mechanism, no evidence text.
   */
  async listIncumbents(
    missionId: string,
    userId: string,
    limit = 50,
  ): Promise<Array<{
    cell_key: string;
    bins: DescriptorBins;
    incumbent_seed_id: string;
    quality: number;
    seed_count: number;
    history_count: number;
    created_cycle_id: string;
    last_cycle_id: string;
  }>> {
    const cells = (await this.cells()
      .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })
      .sort({ quality: -1, cell_key: 1 })
      .limit(Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_COVERAGE_CELLS))
      .toArray()) as unknown as IdeaArchiveCell[];
    return cells.map((cell) => ({
      cell_key: cell.cell_key,
      bins: cell.bins,
      incumbent_seed_id: cell.incumbent_seed_id,
      quality: cell.quality,
      seed_count: cell.seed_count ?? 0,
      history_count: (cell.history ?? []).length,
      created_cycle_id: cell.created_cycle_id,
      last_cycle_id: cell.last_cycle_id,
    }));
  }

  /** The cells themselves — used by the run to report what changed. */
  async getCells(userId: string, missionId: string): Promise<IdeaArchiveCell[]> {
    return (await this.cells()
      .find({ user_id: userId, mission_id: missionId }, { projection: { _id: 0 } })
      .sort({ cell_key: 1 })
      .limit(MAX_COVERAGE_CELLS)
      .toArray()) as unknown as IdeaArchiveCell[];
  }
}
