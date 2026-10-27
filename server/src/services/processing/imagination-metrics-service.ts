/**
 * ITER-9 (Phase 7) — the imagination metrics service.
 *
 * Contract: CONTRACT-iter9-observability.md §A. Every number this module
 * reports is computed from STORED rows and carries its `basis` (the window it
 * was measured over, the `n` behind it and the collections it came from). A
 * metric whose denominator is 0, or whose sample is below its documented
 * minimum, reports `insufficient_data` — never a fabricated rate. Cost of
 * novelty with zero useful candidates is `insufficient_data`, not `0`.
 *
 * READ-ONLY BY CONSTRUCTION: every collection access here is a `find`/`count`;
 * there is no write path in this file at all (the dashboard's one gated write
 * lives in `imagination-experiments.ts`).
 *
 * The privacy metric is an AUDIT, not a constant: the shared-scope artefacts a
 * promotion produced are read back and checked for (a) the private keys the
 * candidate allow-list forbids and (b) markers taken from THIS identity's
 * private stores (rejected hypotheses, changed premises, trace statements and
 * exclusion texts). It reports what it scanned and which markers it checked,
 * so "0" is a measurement with a basis rather than a claim.
 */
import type { Db } from 'mongodb';
import { COGNITIVE_TEAM_COLLECTIONS } from './cognitive-team-collections.js';
import { CREATIVE_BATON_COLLECTIONS } from './creative-baton-collections.js';
import { IMAGINATION_COLLECTIONS } from './imagination-collections.js';
import { comparableText, statementSimilarity } from './idea-archive-service.js';
import { ENVELOPE_VERSION, invariantViolation, verifyEnvelope } from './inheritance-envelope.js';
import { verifyAssignment } from './cognitive-mode-service.js';
import { compareMeasuredValues, type ImprovementTarget, type ValueVerdict } from './imagination-experiments.js';

// ── Documented minimums (a metric below its minimum is `insufficient_data`) ──

/** Outcomes needed before a useful-novelty RATE is reported. */
export const MIN_OUTCOME_SAMPLES = 5;
/** Generated candidates needed before a false-novelty RATE is reported. */
export const MIN_GENERATED_SAMPLES = 5;
/** Cycles needed before a coverage GAIN mean (and a cost mean) is reported. */
export const MIN_CYCLE_SAMPLES = 1;
/** Agents needed before a pairwise divergence is reported. */
export const MIN_DIVERGENCE_AGENTS = 2;
/** Shortest marker worth searching a shared artefact for (avoids noise). */
export const MIN_MARKER_LENGTH = 12;

/** The env knob for the default measurement window (documented in .env.example). */
export const IMAGINATION_METRICS_WINDOW_ENV = 'IMAGINATION_METRICS_WINDOW_DAYS';
export const DEFAULT_METRICS_WINDOW_DAYS = 14;

export function metricsWindowDays(): number {
  const numeric = Number(process.env[IMAGINATION_METRICS_WINDOW_ENV]);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : DEFAULT_METRICS_WINDOW_DAYS;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 500;

/**
 * The private keys a SHARED artefact must never carry, whatever its shape. The
 * compiler's allow-list is the first line of defence; this list is what the
 * audit reads the stored rows back against.
 *
 * It names the fields the baton's own documentation lists as HAVING NO PLACE in
 * the shape — evidence refs, changed premises, bridge paths, parent links, cell
 * keys — plus the journal/reflection/emotional material no shared scope may
 * ever carry. It deliberately does NOT name the baton's own allow-listed
 * fields (a candidate's hypothesis and mechanism, `cue` and the derived
 * attention note): those are the shareable surface.
 */
export const FORBIDDEN_SHARED_KEYS = [
  'statement',
  'evidence_refs',
  'changed_premise',
  'parent_seed_ids',
  'bridge_path',
  'cell_key',
  'raw_reflections',
  'reflection_text',
  'journal_text',
  'emotional_tags',
] as const;

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface MetricWindow {
  /** ISO start of the window (null when the metric is not windowed). */
  from: string | null;
  to: string;
  days: number | null;
}

export interface MetricBasis {
  window: MetricWindow;
  /** The sample the number was computed from. */
  n: number;
  /** The collections it was read from. */
  sources: string[];
  /** The documented minimum this metric needs (null for counts). */
  minimum: number | null;
  /** What exactly was counted — the sentence a reader needs to audit it. */
  measurement: string;
}

export interface Metric<T> {
  status: 'ok' | 'insufficient_data';
  value: T | null;
  basis: MetricBasis;
  /** Why no value is reported (null when status is `ok`). */
  reason: string | null;
}

export interface PrivacyIndicator {
  /** Which scopes the payload's rows live in. */
  scope: 'private' | 'shared' | 'private+shared';
  private_rows: number;
  shared_rows: number;
  raw_reflections_included: false;
  basis: string;
}

export interface ImaginationMetrics {
  user_id: string;
  mission_id: string | null;
  generated_at: string;
  window: MetricWindow;
  minimum_samples: {
    outcomes: number;
    generated: number;
    cycles: number;
    agents: number;
  };
  useful_novelty_rate: Metric<{ rate: number; useful_outcomes: number }>;
  archive_coverage_gain: Metric<{
    mean_new_cells_per_cycle: number;
    last_cycle_new_cells: number | null;
    cells_total: number;
    gap_dimensions: number;
    unoccupied_bins: number;
  }>;
  idea_survival: Metric<{ rate: number; admitted_with_outcome: number; admitted: number }>;
  time_to_next_viable_direction: Metric<{ median_ms: number; samples: number[] }>;
  false_novelty: Metric<{ rate: number; rejected_as_seen: number; generated: number }>;
  agent_divergence: Metric<{
    mean_pairwise_similarity: number;
    comparisons: number;
    agents: number;
  }>;
  /** The same-mode control, when a single-mode first pass was recorded. */
  agent_divergence_same_mode_control: Metric<{
    mean_pairwise_similarity: number;
    comparisons: number;
    agents: number;
  }>;
  privacy_leakage: {
    flagged: number;
    shared_artefacts_scanned: number;
    markers_checked: number;
    keys_checked: string[];
    basis: MetricBasis;
  };
  cost_of_novelty: Metric<{ tokens_per_useful_candidate: number; tokens: number; useful_candidates: number }>;
  personality_stability: {
    violations: number;
    envelopes_checked: number;
    assignments_checked: number;
    by_code: Record<string, number>;
    basis: MetricBasis;
  };
  /** Did value improve versus the preceding window? An explicit verdict. */
  window_comparison: {
    metrics: Array<{
      metric: string;
      baseline: { window: MetricWindow; value: number | null; n: number; measurement: string };
      treatment: { window: MetricWindow; value: number | null; n: number; measurement: string };
      direction: 'higher' | 'lower';
      target: { min_relative_gain: number; min_samples: number; source: string };
      delta: number | null;
      relative_gain: number | null;
      verdict: ValueVerdict;
      reason: string;
      n: { baseline: number; treatment: number; minimum: number };
      basis: string;
    }>;
    verdict: ValueVerdict;
    counts: { improved: number; not_improved: number; equal: number; insufficient_data: number };
    baseline_window: MetricWindow;
    current_window: MetricWindow;
    basis: string;
  };
  privacy: PrivacyIndicator;
  basis: string;
}

export interface ComputeMetricsArgs {
  userId: string;
  missionId?: string | null;
  windowDays?: number;
  now?: () => string;
  /** Overrides for the window-over-window comparison's targets. */
  targets?: Record<string, Partial<ImprovementTarget>>;
}

/** One metric's measured value and the sample behind it. */
interface Measured {
  value: number | null;
  n: number;
  label: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isIso(value: unknown): boolean {
  return Number.isFinite(Date.parse(String(value ?? '')));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Walk a stored document and collect every key name it carries. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      collectKeys(inner, into);
    }
  }
  return into;
}

/** Every string a stored document contains (used for the marker audit). */
function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) collectStrings(inner, into);
  }
  return into;
}

// ── The metrics ─────────────────────────────────────────────────────────────

/**
 * Compute every §7.3 metric for one identity (and optionally one mission).
 * Read-only: nothing here writes a row.
 */
export async function computeImaginationMetrics(
  db: Db,
  args: ComputeMetricsArgs,
): Promise<ImaginationMetrics> {
  const days = args.windowDays && args.windowDays > 0 ? Math.floor(args.windowDays) : metricsWindowDays();
  const now = args.now ?? (() => new Date().toISOString());
  const generatedAt = now();
  const current = await metricsForWindow(db, {
    userId: args.userId,
    missionId: args.missionId,
    days,
    generatedAt,
  });
  // The baseline is the SAME measurement over the preceding window of equal
  // length, so the view answers "did value improve versus baseline" with an
  // explicit verdict, its basis and its sample size — using one rule.
  const baseline = await metricsForWindow(db, {
    userId: args.userId,
    missionId: args.missionId,
    days,
    generatedAt: current.window.from!,
  });
  return { ...current, window_comparison: buildWindowComparison(current, baseline, args.targets) };
}

/** Every metric for ONE window. Read-only: nothing here writes a row. */
async function metricsForWindow(
  db: Db,
  args: { userId: string; missionId?: string | null; days: number; generatedAt: string },
): Promise<Omit<ImaginationMetrics, 'window_comparison'>> {
  const userId = nonEmpty(args.userId);
  if (!userId) throw new Error('computeImaginationMetrics: userId is required');
  const missionId = nonEmpty(args.missionId);
  const days = args.days;
  const generatedAt = args.generatedAt;
  const from = new Date(Date.parse(generatedAt) - days * DAY_MS).toISOString();
  const window: MetricWindow = { from, to: generatedAt, days };
  const scope: Record<string, unknown> = { user_id: userId, ...(missionId ? { mission_id: missionId } : {}) };
  // BOTH bounds: a window is a window. (A lower bound alone would make the
  // baseline window of the window-over-window comparison a superset of the
  // current one, which is how a "comparison" would silently become an identity.)
  const windowed = { ...scope, created_at: { $gte: from, $lte: generatedAt } };

  // ── Source rows ───────────────────────────────────────────────────────────
  const cycles = (await db
    .collection(CREATIVE_BATON_COLLECTIONS.cycles)
    .find({ ...windowed }, { projection: { _id: 0 } })
    .sort({ created_at: 1 })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;
  const outcomesWindowed = (await db
    .collection(CREATIVE_BATON_COLLECTIONS.candidateOutcomes)
    .find({ ...scope, recorded_at: { $gte: from, $lte: generatedAt } }, { projection: { _id: 0 } })
    .sort({ recorded_at: 1 })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;
  const seedsWindowed = (await db
    .collection(IMAGINATION_COLLECTIONS.ideaSeeds)
    .find({ ...windowed }, { projection: { _id: 0 } })
    .sort({ created_at: 1 })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;
  // Admitted/live seed facts for the gap metric: bounded at the TOP of the
  // window (a seed written after this measurement cannot belong to a cycle
  // inside it) but not at the bottom — a cycle's candidates are its own, and
  // the cycle below is already windowed.
  const seedsAll = (await db
    .collection(IMAGINATION_COLLECTIONS.ideaSeeds)
    .find(
      { ...scope, created_at: { $lte: generatedAt } },
      { projection: { _id: 0, seed_id: 1, state: 1, cycle_id: 1, created_at: 1 } },
    )
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;
  const cells = (await db
    .collection(IMAGINATION_COLLECTIONS.ideaArchiveCells)
    .find({ ...scope }, { projection: { _id: 0, cell_key: 1, quality: 1, seed_count: 1, incumbent_seed_id: 1 } })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;

  // ── 1. Useful novelty rate ────────────────────────────────────────────────
  const usefulOutcomes = outcomesWindowed.filter((row) => row.outcome === 'useful_information').length;
  const usefulNoveltyRate: Metric<{ rate: number; useful_outcomes: number }> =
    outcomesWindowed.length >= MIN_OUTCOME_SAMPLES
      ? {
          status: 'ok',
          value: { rate: round(usefulOutcomes / outcomesWindowed.length), useful_outcomes: usefulOutcomes },
          basis: {
            window,
            n: outcomesWindowed.length,
            sources: [CREATIVE_BATON_COLLECTIONS.candidateOutcomes],
            minimum: MIN_OUTCOME_SAMPLES,
            measurement: 'recorded candidate outcomes whose verdict is useful_information, over every recorded outcome',
          },
          reason: null,
        }
      : {
          status: 'insufficient_data',
          value: null,
          basis: {
            window,
            n: outcomesWindowed.length,
            sources: [CREATIVE_BATON_COLLECTIONS.candidateOutcomes],
            minimum: MIN_OUTCOME_SAMPLES,
            measurement: 'recorded candidate outcomes whose verdict is useful_information, over every recorded outcome',
          },
          reason: `only ${outcomesWindowed.length} recorded outcome(s) in the window — a rate needs at least ${MIN_OUTCOME_SAMPLES}`,
        };

  // ── 2. Archive coverage gain ─────────────────────────────────────────────
  const lastCycle = cycles.length > 0 ? cycles[cycles.length - 1] : null;
  const meanNewCells = cycles.length > 0 ? round(mean(cycles.map((row) => Number(row.counts?.new_cells ?? 0)))) : null;
  const gapDimensions = Array.isArray(lastCycle?.coverage?.gaps) ? lastCycle!.coverage.gaps.length : 0;
  const unoccupiedBins = Array.isArray(lastCycle?.coverage?.gaps)
    ? lastCycle!.coverage.gaps.reduce(
        (total: number, gap: any) => total + (Array.isArray(gap?.unoccupied_bins) ? gap.unoccupied_bins.length : 0),
        0,
      )
    : 0;
  const coverageGain: Metric<any> =
    cycles.length >= MIN_CYCLE_SAMPLES
      ? {
          status: 'ok',
          value: {
            mean_new_cells_per_cycle: meanNewCells,
            last_cycle_new_cells: lastCycle ? Number(lastCycle.counts?.new_cells ?? 0) : null,
            cells_total: cells.length,
            gap_dimensions: gapDimensions,
            unoccupied_bins: unoccupiedBins,
          },
          basis: {
            window,
            n: cycles.length,
            sources: [CREATIVE_BATON_COLLECTIONS.cycles, IMAGINATION_COLLECTIONS.ideaArchiveCells],
            minimum: MIN_CYCLE_SAMPLES,
            measurement:
              'mean of each cycle\'s recorded counts.new_cells over the window; cells_total counted live from idea_archive_cells; gaps read from the newest cycle\'s stored coverage view (with its own scan bounds)',
          },
          reason: null,
        }
      : {
          status: 'insufficient_data',
          value: null,
          basis: {
            window,
            n: cycles.length,
            sources: [CREATIVE_BATON_COLLECTIONS.cycles, IMAGINATION_COLLECTIONS.ideaArchiveCells],
            minimum: MIN_CYCLE_SAMPLES,
            measurement: 'mean of each cycle\'s recorded counts.new_cells over the window',
          },
          reason: `no cycle ran in the window — a coverage gain needs at least ${MIN_CYCLE_SAMPLES} recorded cycle`,
        };

  // ── 3. Idea survival (declared as a PROXY) ───────────────────────────────
  const admitted = seedsWindowed.filter((row) => row.state !== 'rejected').length;
  const outcomeSeeds = new Set(outcomesWindowed.map((row) => String(row.seed_id)));
  const admittedWithOutcome = seedsWindowed.filter(
    (row) => row.state !== 'rejected' && outcomeSeeds.has(String(row.seed_id)),
  ).length;
  const ideaSurvival: Metric<any> =
    admitted > 0
      ? {
          status: 'ok',
          value: { rate: round(admittedWithOutcome / admitted), admitted_with_outcome: admittedWithOutcome, admitted },
          basis: {
            window,
            n: admitted,
            sources: [IMAGINATION_COLLECTIONS.ideaSeeds, CREATIVE_BATON_COLLECTIONS.candidateOutcomes],
            minimum: MIN_CYCLE_SAMPLES,
            measurement:
              'PROXY — admitted candidates carrying a recorded outcome over every admitted candidate. It measures that a candidate was picked up and judged, not that it was materially refined',
          },
          reason: null,
        }
      : {
          status: 'insufficient_data',
          value: null,
          basis: {
            window,
            n: 0,
            sources: [IMAGINATION_COLLECTIONS.ideaSeeds, CREATIVE_BATON_COLLECTIONS.candidateOutcomes],
            minimum: MIN_CYCLE_SAMPLES,
            measurement: 'PROXY — admitted candidates carrying a recorded outcome over every admitted candidate',
          },
          reason: 'no admitted candidate exists for this identity/mission — the proxy has no denominator',
        };

  // ── 4. Time to next viable direction ─────────────────────────────────────
  const gapsMs: number[] = [];
  for (const cycle of cycles) {
    const triggeredAt = Date.parse(String(cycle.created_at ?? ''));
    if (!Number.isFinite(triggeredAt)) continue;
    const candidates = seedsAll
      .filter((seed) => seed.state !== 'rejected' && seed.cycle_id === cycle.cycle_id && isIso(seed.created_at))
      .map((seed) => Date.parse(String(seed.created_at)))
      .sort((left, right) => left - right);
    if (candidates.length === 0) continue;
    gapsMs.push(Math.max(0, candidates[0] - triggeredAt));
  }
  const timeToDirection: Metric<{ median_ms: number; samples: number[] }> =
    gapsMs.length > 0
      ? {
          status: 'ok',
          value: { median_ms: median(gapsMs), samples: gapsMs },
          basis: {
            window,
            n: gapsMs.length,
            sources: [CREATIVE_BATON_COLLECTIONS.cycles, IMAGINATION_COLLECTIONS.ideaSeeds],
            minimum: MIN_CYCLE_SAMPLES,
            measurement:
              'median gap between a cycle\'s created_at (the plateau trigger) and the earliest admitted candidate recorded against that cycle_id; cycles with no admitted candidate are excluded from the sample',
          },
          reason: null,
        }
      : {
          status: 'insufficient_data',
          value: null,
          basis: {
            window,
            n: 0,
            sources: [CREATIVE_BATON_COLLECTIONS.cycles, IMAGINATION_COLLECTIONS.ideaSeeds],
            minimum: MIN_CYCLE_SAMPLES,
            measurement: 'median gap between a cycle\'s trigger and its first admitted candidate',
          },
          reason: 'no cycle in the window has both a trigger timestamp and an admitted candidate — no gap can be measured',
        };

  // ── 5. False novelty ─────────────────────────────────────────────────────
  const SEEN_BEFORE = new Set(['duplicate_of', 'paraphrase_of', 'excluded_region']);
  const rejectedAsSeen = seedsWindowed.filter(
    (row) => row.state === 'rejected' && SEEN_BEFORE.has(String(row.rejection?.reason)),
  ).length;
  const falseNovelty: Metric<any> =
    seedsWindowed.length >= MIN_GENERATED_SAMPLES
      ? {
          status: 'ok',
          value: {
            rate: round(rejectedAsSeen / seedsWindowed.length),
            rejected_as_seen: rejectedAsSeen,
            generated: seedsWindowed.length,
          },
          basis: {
            window,
            n: seedsWindowed.length,
            sources: [IMAGINATION_COLLECTIONS.ideaSeeds],
            minimum: MIN_GENERATED_SAMPLES,
            measurement:
              'generated candidates (every stored seed row, admitted or rejected) rejected as duplicate_of / paraphrase_of / excluded_region',
          },
          reason: null,
        }
      : {
          status: 'insufficient_data',
          value: null,
          basis: {
            window,
            n: seedsWindowed.length,
            sources: [IMAGINATION_COLLECTIONS.ideaSeeds],
            minimum: MIN_GENERATED_SAMPLES,
            measurement:
              'generated candidates rejected as duplicate_of / paraphrase_of / excluded_region over every generated candidate',
          },
          reason: `only ${seedsWindowed.length} generated candidate(s) in the window — a rate needs at least ${MIN_GENERATED_SAMPLES}`,
        };

  // ── 6. Agent divergence (+ the same-mode control) ────────────────────────
  const divergences = await divergenceFor(db, scope, window, false);
  const sameModeControl = await divergenceFor(db, scope, window, true);

  // ── 7. Privacy leakage (an audit with a basis, never a constant) ─────────
  const privacyAudit = await auditSharedArtefacts(db, scope, window);

  // ── 8. Cost of novelty ───────────────────────────────────────────────────
  // A spend is RECORDED only when at least one cycle in the window wrote a
  // non-zero `budget.tokens_spent_this_cycle`. A window whose cycles all read 0
  // (or carry no budget at all) has an UNRECORDED spend: reporting
  // `tokens_per_useful_candidate: 0` there would read as "free", which is a
  // claim the ledger does not support — so it is `insufficient_data` with a
  // basis that says exactly that, distinct from the zero-denominator case.
  const tokensSpent = cycles.reduce((total, row) => total + Number(row.budget?.tokens_spent_this_cycle ?? 0), 0);
  const cyclesRecordingTokens = cycles.filter((row) => Number(row.budget?.tokens_spent_this_cycle ?? 0) > 0).length;
  const usefulCandidates = new Set(
    outcomesWindowed.filter((row) => row.outcome === 'useful_information').map((row) => String(row.seed_id)),
  ).size;
  const costOfNovelty: Metric<any> =
    usefulCandidates === 0
      ? {
          status: 'insufficient_data',
          value: null,
          basis: {
            window,
            n: 0,
            sources: [CREATIVE_BATON_COLLECTIONS.cycles, CREATIVE_BATON_COLLECTIONS.candidateOutcomes],
            minimum: 1,
            measurement: 'measured tokens per useful candidate — the denominator is 0, so no cost is reported',
          },
          reason:
            'no candidate has a recorded useful_information outcome in the window — a zero denominator is insufficient data, not a cost of 0',
        }
      : cyclesRecordingTokens === 0
        ? {
            status: 'insufficient_data',
            value: null,
            basis: {
              window,
              n: usefulCandidates,
              sources: [CREATIVE_BATON_COLLECTIONS.cycles, CREATIVE_BATON_COLLECTIONS.candidateOutcomes],
              minimum: 1,
              measurement:
                'measured tokens per useful candidate — no cycle in the window recorded a non-zero budget.tokens_spent_this_cycle, so the spend is UNRECORDED (absent from the usage ledger) rather than 0',
            },
            reason: `${usefulCandidates} useful candidate(s) in the window, but no included cycle recorded a non-zero token count — the spend is UNRECORDED, not zero, so no cost is reported`,
          }
        : {
            status: 'ok',
            value: {
              tokens_per_useful_candidate: round(tokensSpent / usefulCandidates, 2),
              tokens: tokensSpent,
              useful_candidates: usefulCandidates,
            },
            basis: {
              window,
              n: usefulCandidates,
              sources: [CREATIVE_BATON_COLLECTIONS.cycles, CREATIVE_BATON_COLLECTIONS.candidateOutcomes],
              minimum: 1,
              measurement:
                'measured tokens each cycle recorded from the usage ledger (budget.tokens_spent_this_cycle, summed over the window) per DISTINCT candidate whose recorded outcome is useful_information — reported only because at least one included cycle recorded a non-zero spend',
            },
            reason: null,
          };

  // ── 9. Personality stability ─────────────────────────────────────────────
  const stability = await personalityStability(db, scope, window);

  return {
    user_id: userId,
    mission_id: missionId,
    generated_at: generatedAt,
    window,
    minimum_samples: {
      outcomes: MIN_OUTCOME_SAMPLES,
      generated: MIN_GENERATED_SAMPLES,
      cycles: MIN_CYCLE_SAMPLES,
      agents: MIN_DIVERGENCE_AGENTS,
    },
    useful_novelty_rate: usefulNoveltyRate,
    archive_coverage_gain: coverageGain,
    idea_survival: ideaSurvival,
    time_to_next_viable_direction: timeToDirection,
    false_novelty: falseNovelty,
    agent_divergence: divergences,
    agent_divergence_same_mode_control: sameModeControl,
    privacy_leakage: privacyAudit,
    cost_of_novelty: costOfNovelty,
    personality_stability: stability,
    privacy: {
      scope: 'private',
      private_rows: cycles.length + seedsWindowed.length + outcomesWindowed.length + cells.length,
      shared_rows: privacyAudit.shared_artefacts_scanned,
      raw_reflections_included: false,
      basis:
        'computed from identity-private rows (imagination_cycles, idea_seeds, idea_candidate_outcomes, idea_archive_cells) plus the shared-scope artefacts the promotion audit returned; no journal or reflection collection is read by this service at all',
    },
    basis:
      'every metric above carries its own basis; sources: imagination_cycles, idea_seeds, idea_archive_cells, idea_candidate_outcomes, cognitive_portfolios, creative_batons, creative_baton_promotions, inheritance_envelopes, thinking_mode_assignments',
  };
}

/**
 * Window over window: the same metrics, measured over the preceding window of
 * equal length, judged with the same rule and the same named targets the
 * experiment comparison uses. A metric with too small a sample on either side
 * reports `insufficient_data`; the overall verdict is `improved` only when at
 * least one metric improved and none regressed.
 */
function buildWindowComparison(
  current: Omit<ImaginationMetrics, 'window_comparison'>,
  baseline: Omit<ImaginationMetrics, 'window_comparison'>,
  overrides?: Record<string, Partial<ImprovementTarget>>,
): ImaginationMetrics['window_comparison'] {
  const measured = (payload: Omit<ImaginationMetrics, 'window_comparison'>): Record<string, Measured> => ({
    useful_novelty_rate: {
      value: payload.useful_novelty_rate.value?.rate ?? null,
      n: payload.useful_novelty_rate.basis.n,
      label: 'recorded useful outcomes over every recorded outcome',
    },
    false_novelty: {
      value: payload.false_novelty.value?.rate ?? null,
      n: payload.false_novelty.basis.n,
      label: 'generated candidates rejected as duplicates, paraphrases or excluded regions',
    },
    idea_survival: {
      value: payload.idea_survival.value?.rate ?? null,
      n: payload.idea_survival.basis.n,
      label: 'admitted candidates carrying a recorded outcome (proxy)',
    },
    cost_of_novelty: {
      value: payload.cost_of_novelty.value?.tokens_per_useful_candidate ?? null,
      n: payload.cost_of_novelty.basis.n,
      label: 'measured tokens per distinct useful candidate',
    },
    archive_coverage_gain: {
      value: payload.archive_coverage_gain.value?.mean_new_cells_per_cycle ?? null,
      n: payload.archive_coverage_gain.basis.n,
      label: 'mean new archive cells per cycle',
    },
    time_to_next_viable_direction: {
      value: payload.time_to_next_viable_direction.value?.median_ms ?? null,
      n: payload.time_to_next_viable_direction.basis.n,
      label: 'median ms from a cycle trigger to its first admitted candidate',
    },
    agent_divergence: {
      value: payload.agent_divergence.value?.mean_pairwise_similarity ?? null,
      n: payload.agent_divergence.basis.n,
      label: 'mean pairwise statement similarity across agents',
    },
  });

  const before = measured(baseline);
  const after = measured(current);
  const metrics = Object.keys(after).map((metric) => {
    const verdict = compareMeasuredValues({
      metric,
      baseline: { value: before[metric].value, n: before[metric].n },
      treatment: { value: after[metric].value, n: after[metric].n },
      override: overrides?.[metric],
      baselineLabel: 'the previous window',
      treatmentLabel: 'this window',
    });
    return {
      metric,
      baseline: { window: baseline.window, value: before[metric].value, n: before[metric].n, measurement: before[metric].label },
      treatment: { window: current.window, value: after[metric].value, n: after[metric].n, measurement: after[metric].label },
      direction: verdict.direction,
      target: verdict.target,
      delta: verdict.delta,
      relative_gain: verdict.relative_gain,
      verdict: verdict.verdict,
      reason: verdict.reason,
      n: verdict.n,
      basis:
        `window over window: this window ${current.window.from} to ${current.window.to} against the previous window ` +
        `${baseline.window.from} to ${baseline.window.to} (${current.window.days} day(s) each), read from the same collections; ` +
        `target ${verdict.direction} is better by ${verdict.target.min_relative_gain} relative (${verdict.target.source})`,
    };
  });
  const counts = {
    improved: metrics.filter((row) => row.verdict === 'improved').length,
    not_improved: metrics.filter((row) => row.verdict === 'not_improved').length,
    equal: metrics.filter((row) => row.verdict === 'equal').length,
    insufficient_data: metrics.filter((row) => row.verdict === 'insufficient_data').length,
  };
  return {
    metrics,
    // The same roll-up rule the experiment comparison uses: a regression
    // anywhere makes it `not_improved`, "improved" needs at least one
    // improvement and none short of its target, and every judged metric reading
    // equal is `equal` — never smoothed into an improvement.
    verdict:
      counts.improved + counts.not_improved + counts.equal === 0
        ? 'insufficient_data'
        : counts.not_improved > 0
          ? 'not_improved'
          : counts.improved > 0
            ? 'improved'
            : 'equal',
    counts,
    baseline_window: baseline.window,
    current_window: current.window,
    basis:
      'the baseline is the SAME measurement over the preceding window of equal length; the verdict rule, the named targets and the ' +
      'vocabulary (improved / not_improved / insufficient_data) are the ones the experiment comparison uses, and every row states its n',
  };
}

/**
 * The mean pairwise statement similarity across the agents of every first-pass
 * record for this identity (reusing the archive's own similarity metric).
 * `sameMode` selects the CONTROL: records whose agents all took one mode.
 */
async function divergenceFor(
  db: Db,
  scope: Record<string, unknown>,
  window: MetricWindow,
  sameMode: boolean,
): Promise<Metric<{ mean_pairwise_similarity: number; comparisons: number; agents: number }>> {
  const rows = (await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios)
    .find({ ...scope, kind: 'first_pass', status: 'ran' }, { projection: { _id: 0 } })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;

  const basis = {
    window,
    n: 0,
    sources: [COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios],
    minimum: MIN_DIVERGENCE_AGENTS,
    measurement: sameMode
      ? 'mean pairwise statementSimilarity (the archive\'s own metric) across the agents of first-pass records whose agents ALL took one mode — the control'
      : 'mean pairwise statementSimilarity (the archive\'s own metric) across the agents of every recorded independent first pass',
  };

  const similarities: number[] = [];
  let agentsTotal = 0;
  let records = 0;
  for (const record of rows) {
    const results = (Array.isArray(record.results) ? record.results : []).filter(
      (result: any) => result?.status === 'completed' && Array.isArray(result.seeds) && result.seeds.length > 0,
    );
    if (results.length < MIN_DIVERGENCE_AGENTS) continue;
    const modes = new Set(results.map((result: any) => String(result.mode ?? '')));
    if (sameMode && modes.size > 1) continue;
    records += 1;
    agentsTotal += results.length;
    for (let left = 0; left < results.length; left += 1) {
      for (let right = left + 1; right < results.length; right += 1) {
        similarities.push(
          statementSimilarity(
            comparableText(results[left].seeds[0]),
            comparableText(results[right].seeds[0]),
          ),
        );
      }
    }
  }

  basis.n = similarities.length;
  if (similarities.length === 0 || records === 0) {
    return {
      status: 'insufficient_data',
      value: null,
      basis,
      reason: sameMode
        ? 'no recorded first pass ran with every agent on one mode — the control has no sample'
        : `no first pass with at least ${MIN_DIVERGENCE_AGENTS} agents that completed with seeds exists in this scope`,
    };
  }
  return {
    status: 'ok',
    value: {
      mean_pairwise_similarity: round(mean(similarities)),
      comparisons: similarities.length,
      agents: agentsTotal,
    },
    basis,
    reason: null,
  };
}

/**
 * The privacy audit (§A.7): read back every SHARED-scope artefact this scope
 * produced and check it for the private keys the allow-list forbids AND for
 * markers taken from this identity's private stores. The result is the audit
 * count with its basis — never a constant.
 */
async function auditSharedArtefacts(
  db: Db,
  scope: Record<string, unknown>,
  window: MetricWindow,
): Promise<ImaginationMetrics['privacy_leakage']> {
  const sharedBatons = (await db
    .collection(CREATIVE_BATON_COLLECTIONS.creativeBatons)
    .find({ ...scope, shared_id: { $exists: true, $ne: null } }, { projection: { _id: 0 } })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;
  const promotions = (await db
    .collection(CREATIVE_BATON_COLLECTIONS.batonPromotions)
    .find({ ...scope }, { projection: { _id: 0 } })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;

  // Markers: text that lives in PRIVATE stores and must never be reproduced in
  // a shared artefact. Taken from this identity's own rows, so the audit is
  // about real content rather than a fixed word list.
  const markerRows = (await db
    .collection(IMAGINATION_COLLECTIONS.ideaSeeds)
    .find({ ...scope, state: 'rejected' }, { projection: { _id: 0, hypothesis: 1, mechanism: 1 } })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;
  const lineages = (await db
    .collection(IMAGINATION_COLLECTIONS.ideaLineages)
    .find({ ...scope }, { projection: { _id: 0, changed_premise: 1 } })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;
  const traces = (await db
    .collection('salience_traces')
    .find({ ...scope }, { projection: { _id: 0, signals: 1 } })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;

  const markers = new Set<string>();
  for (const row of markerRows) {
    for (const text of [row.hypothesis, row.mechanism]) {
      const value = nonEmpty(text);
      if (value && value.length >= MIN_MARKER_LENGTH) markers.add(value);
    }
  }
  for (const row of lineages) {
    const value = nonEmpty(row.changed_premise);
    if (value && value.length >= MIN_MARKER_LENGTH) markers.add(value);
  }
  for (const row of traces) {
    for (const signal of Array.isArray(row.signals) ? row.signals : []) {
      for (const text of [signal?.statement, signal?.why_operationally_relevant]) {
        const value = nonEmpty(text);
        if (value && value.length >= MIN_MARKER_LENGTH) markers.add(value);
      }
    }
  }

  const artefacts: Array<{ kind: string; row: Record<string, any> }> = [
    ...sharedBatons.map((row) => ({ kind: CREATIVE_BATON_COLLECTIONS.creativeBatons, row })),
    ...promotions.map((row) => ({ kind: CREATIVE_BATON_COLLECTIONS.batonPromotions, row })),
  ];
  let flagged = 0;
  for (const artefact of artefacts) {
    const keys = collectKeys(artefact.row);
    const forbidden = FORBIDDEN_SHARED_KEYS.some((key) => keys.has(key));
    const strings = collectStrings(artefact.row);
    const hit =
      forbidden || strings.some((text) => [...markers].some((marker) => text.includes(marker)));
    if (hit) flagged += 1;
  }

  return {
    flagged,
    shared_artefacts_scanned: artefacts.length,
    markers_checked: markers.size,
    keys_checked: [...FORBIDDEN_SHARED_KEYS],
    basis: {
      window,
      n: artefacts.length,
      sources: [
        CREATIVE_BATON_COLLECTIONS.creativeBatons,
        CREATIVE_BATON_COLLECTIONS.batonPromotions,
        IMAGINATION_COLLECTIONS.ideaSeeds,
        IMAGINATION_COLLECTIONS.ideaLineages,
        'salience_traces',
      ],
      minimum: null,
      measurement:
        `audit over the shared-scope rows (creative_batons carrying a shared_id + creative_baton_promotions): each artefact is scanned for the ${FORBIDDEN_SHARED_KEYS.length} private keys the candidate allow-list forbids and for ${markers.size} marker(s) lifted verbatim from this identity's private stores (rejected hypotheses, changed premises, trace statements). Zero flag(s) is a measurement, not a claim`,
    },
  };
}

/**
 * Personality stability (§A.9): every stored inheritance envelope and mode
 * assignment in this scope is re-verified — the invariant re-check on VALUES
 * first (so a re-hashed weakening is still caught), then the full verifier.
 */
async function personalityStability(
  db: Db,
  scope: Record<string, unknown>,
  window: MetricWindow,
): Promise<ImaginationMetrics['personality_stability']> {
  const envelopes = (await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes)
    .find(
      { parent_identity_id: scope.user_id, ...(scope.mission_id ? { mission_id: scope.mission_id } : {}) },
      { projection: { _id: 0 } },
    )
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;
  const assignments = (await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.modeAssignments)
    .find({ ...scope }, { projection: { _id: 0 } })
    .limit(MAX_ROWS)
    .toArray()) as Array<Record<string, any>>;

  const byCode: Record<string, number> = {};
  const count = (code: string) => {
    byCode[code] = (byCode[code] ?? 0) + 1;
  };
  for (const envelope of envelopes) {
    // Version first (a row that is not this format is refused BY NAME), then
    // the invariant re-check on VALUES — the layer that catches a tamperer who
    // recomputed the policy hash — and only then the full verifier.
    if (nonEmpty(envelope.envelope_version) !== ENVELOPE_VERSION) {
      count('version_unsupported');
      continue;
    }
    const violation = invariantViolation(envelope);
    if (violation) {
      count('invariant_violation');
      continue;
    }
    const integrity = verifyEnvelope(envelope);
    if (!integrity.ok) count(String(integrity.code ?? 'refused'));
  }
  for (const assignment of assignments) {
    const integrity = verifyAssignment(assignment);
    if (!integrity.ok) count(String(integrity.code ?? 'refused'));
  }
  const violations = Object.values(byCode).reduce((total, value) => total + value, 0);

  return {
    violations,
    envelopes_checked: envelopes.length,
    assignments_checked: assignments.length,
    by_code: byCode,
    basis: {
      window,
      n: envelopes.length + assignments.length,
      sources: [COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes, COGNITIVE_TEAM_COLLECTIONS.modeAssignments],
      minimum: null,
      measurement:
        'stored inheritance envelopes and mode assignments re-verified (invariant re-check on values, then the full verifier); an entity is counted once, under the first code that refused it. Expected 0 — a non-zero value is a finding, not a rate',
    },
  };
}
