#!/usr/bin/env node
/**
 * ITER-11, WS-4 — the A/B baseline harness (DoD #8).
 *
 *   node scripts/imagination-baseline.mjs [options]
 *
 * Dependency-free Node (node: builtins only — no server imports, no MongoDB, no
 * model). It measures the four arms of the brief's §7.4 design against the
 * FROZEN CHECKPOINT at `tests/fixtures/imagination-baseline-checkpoint.json`
 * (generated and freshness-gated by
 * `tests/unit/imagination-baseline-fixture.test.ts`):
 *
 *   A  control — dreamer-style retrieval (the pre-engine path), implemented HERE
 *   B  control — mind-wander over the mission graph, implemented HERE
 *   C  treatment — the focused engine, one balanced identity (rows captured from
 *      the real services in the fixture)
 *   D  treatment — the engine plus the heterogeneous team (rows captured from
 *      the real services in the fixture)
 *
 * WHAT IS MEASURED, AND HOW HONESTLY
 *
 * Every number carries a `basis` (rows, formula, source) and a `determination`:
 *
 *   store_measured  — arithmetic over the fixture's own captured rows: the
 *                     archive's rejections, the coverage counts, the recorded
 *                     outcomes, the cost, the timings.
 *   stub_determined — the value depends on the SCRIPTED model's text (the
 *                     comparators' idea text, and every similarity built on it).
 *                     The printed report says so; nothing here is evidence that
 *                     a real model's ideas diverge.
 *   insufficient_data — the metric cannot be measured from this fixture at all:
 *                     no recorded outcomes, no recorded spend, no cycle trigger
 *                     to time from, or fewer than the minimum samples. The
 *                     reason is always printed beside it.
 *
 * The two CONTROL arms are implemented in this file, because the pre-engine
 * path is not a service any more (ITER-4's operator-free comparator). Their
 * comparator is deliberately the documented pre-engine behaviour: retrieval
 * ranks the mission's concepts by graph degree and emits one idea per concept;
 * the wander emits BOTH directions of every walk step — an undeduped wander
 * produces exactly those restatements, which is the pathology the archive was
 * built to reject. Both are marked `stub_determined` and their dedupe is this
 * harness's own re-implementation of the archive's containment rule (labelled
 * as such), never presented as an archive measurement.
 *
 * WHAT IT WRITES
 *
 *   --store <path>   `imagination_experiments`-shaped rows: ONE experiment
 *                    (four arms, their configs and the checkpoint) plus one
 *                    observation per arm and metric, with the SAME derived ids
 *                    the real `registerExperiment`/`recordExperimentObservation`
 *                    produce (sha256 over the same payloads), so the recorded
 *                    baseline can be compared by the real `compareExperiment`
 *                    and re-imported without translation.
 *                    Default: docs/IMAGINATION-BASELINE.json
 *   --grade <path>   an operator's BLIND grades (novelty / coherence /
 *                    testability / information_gain per arm+checkpoint), which
 *                    are recorded as observations. Without them the report says
 *                    `insufficient_data` for every judged metric and writes
 *                    placeholder rows with n = 0.
 *
 * Reproducible: two runs over the same fixture produce the same rows (the
 * report is stamped with the fixture's `frozen_at` unless `--at` overrides it).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// ── The archive's documented rules, re-implemented (and labelled) ───────────

/** The archive's stopword list, copied verbatim (`idea-archive-service.ts`). */
const CONTENT_STOPWORDS = new Set([
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
const PARAPHRASE_THRESHOLD = 0.72;
const MIN_CONTAINMENT_OVERLAP = 2;
const LENGTH_GUARD_RATIO = 0.5;

function contentTokens(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const out = new Set();
  for (const token of normalized.length > 0 ? normalized.split(' ') : []) {
    if (token.length < 3) continue;
    if (CONTENT_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

function jaccard(left, right) {
  const a = contentTokens(left);
  const b = contentTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function containment(left, right) {
  const a = contentTokens(left);
  const b = contentTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return { value: shared / Math.min(a.size, b.size), shared };
}

/** The archive's pair rule: a paraphrase is containment OR Jaccard ≥ 0.72. */
function isParaphrase(left, right) {
  const measured = containment(left, right);
  if (measured.value >= PARAPHRASE_THRESHOLD && measured.shared >= MIN_CONTAINMENT_OVERLAP) return true;
  const longer = Math.max(left.length, right.length);
  const shorter = Math.min(left.length, right.length);
  if (longer > 0 && shorter / longer < LENGTH_GUARD_RATIO) return false;
  return jaccard(left, right) >= PARAPHRASE_THRESHOLD;
}

// ── The two CONTROL comparators (the pre-engine path) ──────────────────────

/** The default descriptor tuple the comparators assign (one cell, by design). */
const CONTROL_BINS = {
  mechanism: 'relocation',
  representation: 'prose',
  violated_assumption: 'stability',
  evidence_family: 'operational_state',
  test_strategy: 'observation_study',
};
const WANDER_BINS = {
  mechanism: 'composition',
  representation: 'graph',
  violated_assumption: 'independence',
  evidence_family: 'external_observation',
  test_strategy: 'simulation',
};

function controlRow(index, statement, mechanism, bins) {
  return {
    seed_id: `control_${String(index + 1).padStart(2, '0')}`,
    agent: 'control',
    operator: 'pre_engine',
    hypothesis: statement,
    mechanism,
    descriptor_bins: { ...bins },
    cell_key: Object.entries(bins)
      .map(([dimension, bin]) => `${dimension}=${bin}`)
      .join('|'),
    novelty_score: 0.5,
    coherence_score: 0.5,
    testability_score: 0.4,
    expected_information_gain: 0.2,
    cheapest_test: 'Ask whether the concept still explains the plateau.',
    quality: 0.48,
    state: 'admitted',
    rejection_reason: null,
    created_at: null,
    privacy_safe: true,
    scripted: true,
  };
}

/**
 * The comparators' task-quality evidence — DECLARED HERE, and labelled as such.
 *
 * The pre-engine path has no cycle service and no archive, so it ran zero
 * cycles for this plateau and produced nothing shared to scan. Both facts are
 * stated as declarations by the file that implements the comparator (there is
 * no store row to read), not as measurements, and each evaluation says so in
 * its basis. A zero-run count satisfies "one cycle per plateau" VACUOUSLY and a
 * scan with nothing to scan flags nothing VACUOUSLY: the task-quality report
 * marks both `vacuous` rather than reading them as evidence of quality.
 */
function controlTaskQualityEvidence() {
  return {
    plateau: {
      window_id: 'frozen_checkpoint_alpha',
      cycles_in_window: 0,
      run_ids: [],
      measured_from:
        'this harness (the comparator is implemented here): the pre-engine path has no cycle service — retrieval and mind-wander emit candidates directly — so ZERO cycle/pass runs exist for this window',
      declared_by: 'server/scripts/imagination-baseline.mjs',
      determination: 'stub_determined',
    },
    taint: {
      shared_artefacts_scanned: 0,
      flagged: 0,
      markers_checked: 0,
      measured_from:
        'this harness: the pre-engine path produces no shared artefact at all (no baton, no promotion), so there is nothing to scan — a VACUOUS clean result, labelled as such',
      declared_by: 'server/scripts/imagination-baseline.mjs',
      determination: 'stub_determined',
    },
  };
}

/** Arm A — dreamer-style retrieval: one idea per concept, ranked by degree. */
function controlArmA(fixture) {
  const concepts = fixture.baseline_material.concepts;
  const rows = concepts.map((concept, index) =>
    controlRow(
      index,
      `Investigate ${concept.name} further: it is central to the mission's graph and may be the plateau.`,
      `A concept with degree ${concept.degree} sits at the centre of the mission's own graph, so it is the most retrievable explanation the pre-engine path offers.`,
      CONTROL_BINS,
    ),
  );
  return {
    label: 'A',
    name: 'control_dreamer_retrieval',
    kind: 'control',
    config: {
      path: 'pre-engine dreamer-style retrieval',
      retrieval: 'concepts ranked by graph degree (prominence)',
      operators: 'none (the pre-engine path had no operator plan)',
      archive: 'none',
    },
    generation: {
      path: 'harness_comparator',
      captured_from: 'this script (controlArmA) over the fixture’s graph',
      determination: 'stub_determined',
      note:
        'one idea per concept with a fixed descriptor tuple; the TEXT is this script’s, so every similarity built on it is ' +
        'stub-determined too (the archive’s rule is re-implemented in this file for this arm and labelled as such)',
    },
    rows,
    coverage: null,
    tokens: 0,
    trigger_at: null,
    outcomes: { recorded: 0, useful_information: 0, mere_variance: 0, unnecessary_cost: 0, decisions: [] },
    rejections: [],
    ...controlTaskQualityEvidence(),
  };
}

/** Arm B — mind-wander: both directions of every walk step, undeduped. */
function controlArmB(fixture) {
  const byId = new Map(fixture.baseline_material.concepts.map((concept) => [concept.id, concept]));
  const rows = [];
  for (const [from, to] of fixture.baseline_material.edges) {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) continue;
    rows.push(
      controlRow(
        rows.length,
        `Explore the connection between ${a.name} and ${b.name}.`,
        `The wander walked the edge ${a.name} → ${b.name}; the connection itself is the hypothesis.`,
        WANDER_BINS,
      ),
    );
    rows.push(
      controlRow(
        rows.length,
        `Explore the connection between ${b.name} and ${a.name}.`,
        `The same edge read backwards: an undeduped wander emits both directions.`,
        WANDER_BINS,
      ),
    );
  }
  return {
    label: 'B',
    name: 'control_mind_wander',
    kind: 'control',
    config: {
      path: 'pre-engine mind-wander over the graph',
      retrieval: 'walk steps from the mission’s edges',
      operators: 'none',
      archive: 'none',
      note: 'both directions of every step are emitted, exactly as an undeduped wander does',
    },
    generation: {
      path: 'harness_comparator',
      captured_from: 'this script (controlArmB) over the fixture’s graph',
      determination: 'stub_determined',
      note: 'the walk text and its restatements are this script’s; the dedupe it is measured against is also this file’s',
    },
    rows,
    coverage: null,
    tokens: 0,
    trigger_at: null,
    outcomes: { recorded: 0, useful_information: 0, mere_variance: 0, unnecessary_cost: 0, decisions: [] },
    rejections: [],
    ...controlTaskQualityEvidence(),
  };
}

/**
 * Score a control arm the way the archive would have: pairwise, in order, so
 * the FIRST statement of a paraphrase pair is admitted and the later one is
 * rejected as `paraphrase_of` — the same discipline (and the same reasons) the
 * real archive reports.
 */
function applyHarnessDedupe(arm) {
  const admitted = [];
  for (const row of arm.rows) {
    let matched = null;
    for (const prior of admitted) {
      if (isParaphrase(row.hypothesis, prior.hypothesis)) {
        matched = prior;
        break;
      }
    }
    if (matched) {
      row.state = 'rejected';
      row.rejection_reason = 'paraphrase_of';
      arm.rejections.push({ seed_id: row.seed_id, reason: 'paraphrase_of' });
      continue;
    }
    row.state = 'admitted';
    row.rejection_reason = null;
    admitted.push(row);
  }
  // The candidate accounting the metrics read: the comparator generated every
  // row it emits (there is no separate rejected-rows list for it), so its
  // declared count IS the row count — declared explicitly rather than inferred,
  // so every arm's `counts` means the same thing.
  arm.counts = { generated: arm.rows.length, admitted: admitted.length, rejected: arm.rejections.length, below_incumbent: 0 };
  return arm;
}

// ── The metrics ───────────────────────────────────────────────────────────

/** Rejection reasons that mean "we have seen this before". */
const SEEN_REASONS = new Set(['duplicate_of', 'paraphrase_of', 'excluded_region']);
const USEFUL = 'useful_information';

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The arm's CANDIDATE ACCOUNTING — the ONE place that decides what "generated",
 * "admitted" and "rejected" mean, so a metric can be traced to what it counts
 * instead of to `rows.length`:
 *
 *   generated — the arm's own `counts.generated` when the capture declares it,
 *               else admitted rows + recorded rejections derived from the rows.
 *               This matters because a TREATMENT arm's `rows` hold only the
 *               seeds it ADMITTED: the archive's rejected candidates are
 *               recorded separately (the fixture's `rejections`), so
 *               `rows.length` is NOT the number of candidates the arm produced
 *               and dividing by it would understate the denominator.
 *   admitted  — rows whose state is `admitted`.
 *   rejected  — recorded rejections, de-duplicated by seed id, so a fixture
 *               that carries BOTH a rejected row and a rejection entry counts
 *               that candidate exactly once.
 */
function candidateAccounting(arm) {
  const rows = Array.isArray(arm.rows) ? arm.rows : [];
  const admitted = rows.filter((row) => row.state === 'admitted');
  const recorded = new Map();
  for (const row of rows) {
    if (row.state === 'admitted') continue;
    recorded.set(String(row.seed_id), String(row.rejection_reason ?? 'rejected'));
  }
  for (const rejection of Array.isArray(arm.rejections) ? arm.rejections : []) {
    const seedId = String(rejection?.seed_id ?? '');
    if (seedId.length === 0 || recorded.has(seedId)) continue;
    recorded.set(seedId, String(rejection?.reason ?? 'rejected'));
  }
  const declared = Number(arm.counts?.generated);
  const derived = admitted.length + recorded.size;
  const generated = Number.isFinite(declared) ? declared : derived;
  return {
    generated,
    generated_source: Number.isFinite(declared)
      ? `counts.generated (${declared}) as the arm's own capture declared it`
      : `derived from the rows: ${admitted.length} admitted + ${recorded.size} recorded rejection(s)`,
    admitted: admitted.length,
    rejected: recorded.size,
    rejections: [...recorded].map(([seed_id, reason]) => ({ seed_id, reason })),
    reconciled: generated === derived,
    reconcile_basis:
      `${generated} generated vs ${admitted.length} admitted row(s) + ${recorded.size} recorded rejection(s) = ${derived}` +
      (generated === derived
        ? ' — the three counts agree'
        : ` — THEY DISAGREE (${generated - derived} candidate(s) unaccounted for); every count below reads what its basis names, and this row says so`),
  };
}

function metric(metricName, value, n, determination, basis, extra = {}) {
  return {
    metric: metricName,
    status: value === null ? 'insufficient_data' : 'ok',
    value,
    n,
    determination,
    basis,
    reason: extra.reason ?? null,
    ...extra.fields,
  };
}

function insufficient(metricName, reason, basis, n = 0, determination = 'insufficient_data') {
  return { metric: metricName, status: 'insufficient_data', value: null, n, determination, basis, reason };
}

/**
 * Every §7.3 metric this fixture can produce for one arm, with its basis and
 * its determination. Nothing is invented: an arm without outcomes, without a
 * recorded spend, without a trigger or without an archive says so.
 */
function metricsFor(arm, fixture) {
  const rows = arm.rows;
  const account = candidateAccounting(arm);
  const admitted = rows.filter((row) => row.state === 'admitted');
  const seen = account.rejections.filter((rejection) => SEEN_REASONS.has(rejection.reason));
  const generated = account.generated;
  const determination = arm.generation.determination;
  const outcomes = arm.outcomes ?? { recorded: 0, useful_information: 0, decisions: [] };
  const metrics = [];

  // generated / admitted / rejected — each count from the accounting above, and
  // a reconciliation row that says whether the three agree.
  metrics.push(
    metric(
      'arm_generated_candidates',
      generated,
      generated,
      determination,
      `${generated} generated candidate(s), ${account.generated_source} = ${account.admitted} admitted + ${account.rejected} rejected`,
    ),
  );
  metrics.push(
    metric(
      'arm_admitted_candidates',
      account.admitted,
      generated,
      determination,
      `${account.admitted} row(s) whose real decision is admitted, of ${generated} generated candidate(s)`,
    ),
  );
  metrics.push(
    metric(
      'arm_rejected_candidates',
      account.rejected,
      generated,
      determination,
      `${account.rejected} recorded rejection(s) (a rejected row and a recorded rejection for the same seed are counted once), of ${generated} generated candidate(s)`,
      { fields: { rejection_reasons: [...new Set(account.rejections.map((rejection) => rejection.reason))].sort() } },
    ),
  );
  metrics.push(
    metric('arm_count_reconciliation', account.reconciled ? 0 : 1, 1, determination, account.reconcile_basis, {
      fields: { generated, admitted: account.admitted, rejected: account.rejected, mismatches: account.reconciled ? 0 : generated - (account.admitted + account.rejected) },
    }),
  );

  // false_novelty = rejected-because-seen / GENERATED (never / rows.length).
  if (generated > 0) {
    metrics.push(
      metric(
        'false_novelty',
        Number((seen.length / generated).toFixed(6)),
        generated,
        determination,
        `${seen.length} rejection(s) with a seen-before reason (${[...SEEN_REASONS].join(', ')}) ÷ ${generated} generated candidate(s) ` +
          `(the denominator is the arm's own generated count — a treatment arm's rows hold only the seeds it ADMITTED, so a row count would be the wrong basis); ` +
          (arm.generation.path === 'harness_comparator'
            ? 'the rejection decisions are this harness’s own dedupe, so the number is stub-determined'
            : 'the rejection decisions are the real archive’s recorded rows'),
        { fields: { rejected_as_seen: seen.length, generated } },
      ),
    );
  } else {
    metrics.push(insufficient('false_novelty', 'the arm generated no candidates', 'no rows to measure'));
  }

  // useful_novelty_rate — needs RECORDED outcomes (min 3, the repo's own minimum).
  if (outcomes.recorded === 0) {
    metrics.push(
      insufficient(
        'useful_novelty_rate',
        'no candidate outcome was ever recorded for this arm — a rate needs recorded verdicts, and judging an idea needs a live model',
        `${outcomes.recorded} recorded outcome(s) in the fixture`,
      ),
    );
  } else if (outcomes.recorded < 3) {
    metrics.push(
      insufficient(
        'useful_novelty_rate',
        `only ${outcomes.recorded} recorded outcome(s) — below the documented minimum of 3`,
        `${outcomes.recorded} recorded outcome(s)`,
        outcomes.recorded,
      ),
    );
  } else {
    metrics.push(
      metric(
        'useful_novelty_rate',
        Number((outcomes.useful_information / outcomes.recorded).toFixed(6)),
        outcomes.recorded,
        'store_measured',
        `${outcomes.useful_information} useful_information ÷ ${outcomes.recorded} recorded outcome(s) (the outcome channel’s own rows)`,
        { fields: { useful_outcomes: outcomes.useful_information, recorded_outcomes: outcomes.recorded } },
      ),
    );
  }

  // idea_survival (a declared PROXY) = admitted candidates carrying an outcome.
  if (outcomes.recorded === 0) {
    metrics.push(
      insufficient('idea_survival', 'no outcome is recorded, so no admitted candidate can “survive”', `0 recorded outcome(s)`),
    );
  } else {
    const survived = admitted.filter((row) => outcomes.decisions.some((decision) => decision.seed_id === row.seed_id)).length;
    metrics.push(
      metric(
        'idea_survival',
        Number((survived / Math.max(1, admitted.length)).toFixed(6)),
        admitted.length,
        'store_measured',
        `${survived} admitted candidate(s) carrying a recorded outcome ÷ ${admitted.length} admitted candidate(s) (the denominator is the admitted count, not the generated one) — PROXY: survival past a test is a different measurement`,
        { fields: { admitted_with_outcome: survived, admitted: admitted.length } },
      ),
    );
  }

  // cost_of_novelty — needs a RECORDED, non-zero spend and a useful candidate.
  const usefulCandidates = new Set(
    outcomes.decisions.filter((decision) => decision.outcome === USEFUL).map((decision) => decision.seed_id),
  ).size;
  if (!Number.isFinite(arm.tokens) || arm.tokens === 0) {
    metrics.push(
      insufficient(
        'cost_of_novelty',
        'no non-zero spend was recorded for this arm: an unrecorded/zero spend is NOT a cost of zero (the metrics view’s own rule)',
        `recorded tokens: ${arm.tokens ?? 'none'}`,
      ),
    );
  } else if (usefulCandidates === 0) {
    metrics.push(
      insufficient(
        'cost_of_novelty',
        'no useful candidate to divide the spend by (the denominator is 0)',
        `${arm.tokens} token(s), 0 distinct useful candidate(s)`,
      ),
    );
  } else {
    metrics.push(
      metric(
        'cost_of_novelty',
        Number((arm.tokens / usefulCandidates).toFixed(6)),
        usefulCandidates,
        'store_measured',
        `${arm.tokens} measured token(s) ÷ ${usefulCandidates} distinct useful candidate(s)`,
      ),
    );
  }

  // time_to_next_viable_direction — trigger → first admitted candidate.
  if (!arm.trigger_at) {
    metrics.push(
      insufficient(
        'time_to_next_viable_direction',
        'the pre-engine path has no cycle trigger to measure the gap from',
        'no trigger timestamp on this arm',
      ),
    );
  } else {
    const firstAdmitted = admitted
      .map((row) => Date.parse(String(row.created_at ?? '')))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right)[0];
    const trigger = Date.parse(String(arm.trigger_at));
    if (!Number.isFinite(firstAdmitted) || !Number.isFinite(trigger)) {
      metrics.push(
        insufficient('time_to_next_viable_direction', 'the arm carries no usable timestamps', 'missing trigger/admission timestamps'),
      );
    } else {
      const gap = Math.max(0, firstAdmitted - trigger);
      metrics.push(
        metric(
          'time_to_next_viable_direction',
          gap,
          admitted.length,
          'store_measured',
          `first admitted candidate at ${new Date(firstAdmitted).toISOString()} − trigger ${new Date(trigger).toISOString()} = ${gap} ms`,
          { fields: { unit: 'ms' } },
        ),
      );
      metrics.push(
        metric(
          'time_to_next_viable_direction_ms',
          gap,
          admitted.length,
          'store_measured',
          `the same gap in milliseconds (the key the experiment comparison’s “lower is better” target uses)`,
          { fields: { unit: 'ms' } },
        ),
      );
    }
  }

  // archive_coverage_gain — needs an archive.
  if (!arm.coverage || !Number.isFinite(arm.coverage.cells_total)) {
    metrics.push(
      insufficient(
        'archive_coverage_gain',
        'the pre-engine path has no quality-diversity archive, so there is no coverage to gain',
        'no coverage rows on this arm',
      ),
    );
  } else {
    const cellsTotal = Number(arm.coverage.cells_total ?? 0);
    metrics.push(
      metric(
        'archive_coverage_gain',
        Number(arm.coverage.new_cells_this_cycle ?? 0),
        Math.max(1, cellsTotal),
        'store_measured',
        `${arm.coverage.new_cells_this_cycle} new cell(s) this cycle out of ${cellsTotal} occupied cell(s) of ${arm.coverage.possible_cells} possible in the ACTIVE space ` +
          `(occupancy ratio ${arm.coverage.occupancy_ratio}); the sample is the archive's own cell rows, which is what the coverage view counts`,
        {
          fields: {
            cells_total: cellsTotal,
            possible_cells: arm.coverage.possible_cells,
            occupancy_ratio: arm.coverage.occupancy_ratio,
          },
        },
      ),
    );
  }

  // agent_divergence — needs ≥2 agents (the same-mode control is a separate arm).
  const agents = new Map();
  for (const row of rows) {
    const agent = String(row.agent ?? 'unknown');
    agents.set(agent, [...(agents.get(agent) ?? []), row]);
  }
  if (agents.size < 2) {
    metrics.push(
      insufficient(
        'agent_divergence',
        `only ${agents.size} agent(s) in this arm — divergence needs at least 2`,
        `${agents.size} distinct agent(s)`,
      ),
    );
  } else {
    const pairs = [];
    const identities = [...agents.keys()].sort();
    for (let i = 0; i < identities.length; i += 1) {
      for (let j = i + 1; j < identities.length; j += 1) {
        const left = agents.get(identities[i]).map((row) => row.hypothesis);
        const right = agents.get(identities[j]).map((row) => row.hypothesis);
        let best = 1;
        for (const a of left) for (const b of right) best = Math.min(best, jaccard(a, b));
        pairs.push(Number(best.toFixed(6)));
      }
    }
    metrics.push(
      metric(
        'agent_divergence',
        Number((pairs.reduce((sum, value) => sum + value, 0) / pairs.length).toFixed(6)),
        pairs.length,
        'stub_determined',
        `closest-pair Jaccard over content tokens for ${pairs.length} agent pair(s): ${JSON.stringify(pairs)} — the TEXT is the ` +
          'scripted model’s, so the magnitude is stub-determined (the plumbing it measures is real)',
        { fields: { comparisons: pairs.length, agents: agents.size } },
      ),
    );
    metrics.push(
      insufficient(
        'agent_divergence_same_mode_control',
        'the same-mode control is not part of this baseline experiment (it lives in the Phase-6 exit-criterion test)',
        'no same-mode control arm in the fixture',
      ),
    );
  }

  return { arm: arm.label, metrics };
}

// ── Task quality (the brief’s “no material task-quality regression”) ────────

/**
 * The ONE documented predicate per success criterion. Each predicate reads the
 * arm's EVIDENCE BLOCK for that criterion (the fixture declares one per
 * treatment arm; the two comparators declare their own in this file, labelled
 * as such) and returns an EVALUATION:
 *
 *   evaluated: false  → the arm carries no usable evidence for this criterion,
 *                       so it is NOT counted as met. A missing evaluation is
 *                       never silently scored as a pass.
 *   vacuous: true     → the criterion holds, but for a degenerate reason (0
 *                       cycles run / 0 shared artefacts to scan). The report
 *                       says so rather than presenting it as a signal.
 *
 * A predicate the harness does not implement is NOT evaluated (`unknown
 * predicate`), which is how a criterion that needs a live model — "judged
 * novelty of the idea text", say — would be reported: as insufficient_data for
 * the whole check, never as met.
 */
const TASK_PREDICATES = {
  /** c1 — “one cycle per plateau”: at most `plateau_cycle_limit` runs in the window. */
  cycles_per_plateau_within_limit(arm, criterion) {
    const block = arm.plateau;
    const cycles = Number(block?.cycles_in_window);
    if (!block || !Number.isFinite(cycles)) {
      return {
        evaluated: false,
        met: false,
        vacuous: false,
        evidence: null,
        basis:
          `arm ${arm.label} carries no plateau block (a run count for the plateau window), so “${criterion.description}” has NO evaluation here — ` +
          'it is not counted as met',
      };
    }
    const limit = Number.isFinite(Number(criterion.plateau_cycle_limit)) ? Number(criterion.plateau_cycle_limit) : 1;
    return {
      evaluated: true,
      met: cycles <= limit,
      vacuous: cycles === 0,
      evidence: {
        cycles_in_window: cycles,
        limit,
        run_ids: block.run_ids ?? [],
        window_id: block.window_id ?? null,
        source: block.measured_from ?? null,
        determination: block.determination ?? null,
      },
      basis:
        `${cycles} run(s) recorded for the plateau window ${block.window_id ?? '(unnamed)'} (${(block.run_ids ?? []).join(', ') || 'none'}) vs the limit of ${limit}` +
        ` — read from ${block.measured_from ?? 'an unnamed source'}` +
        (cycles === 0 ? '; a zero run count satisfies the bound VACUOUSLY (nothing ran), which the report states rather than counting as signal' : ''),
    };
  },
  /**
   * c2 — “no private text crosses”: the taint scan over the arm's shared
   * artefacts reports nothing crossing.
   *
   * The scan returns a FLAG count and (with the arm's own attribution) the
   * number of flags that actually CROSSED: a flag on a forbidden private key, or
   * on a marker reproduced anywhere that is not the packet's own allow-listed
   * candidate material (`candidate_portfolio[i].hypothesis|mechanism|cheapest_test`,
   * whose text IS the packet's payload — the compiler copies it deliberately).
   * Both numbers are reported. When the arm carries no attribution, the raw flag
   * count is used — the CONSERVATIVE reading, never the flattering one.
   */
  no_private_text_in_shared_artefacts(arm, criterion) {
    const block = arm.taint;
    const flagged = Number(block?.flagged);
    const scanned = Number(block?.shared_artefacts_scanned);
    if (!block || !Number.isFinite(flagged) || !Number.isFinite(scanned)) {
      return {
        evaluated: false,
        met: false,
        vacuous: false,
        evidence: null,
        basis:
          `arm ${arm.label} carries no taint block (a scan over its shared artefacts), so “${criterion.description}” has NO evaluation here — ` +
          'it is not counted as met',
      };
    }
    const attributed = Number(block.private_text_crossed);
    const crossed = Number.isFinite(attributed) ? attributed : flagged;
    const flags = Array.isArray(block.flags) ? block.flags : [];
    return {
      evaluated: true,
      met: crossed === 0,
      vacuous: scanned === 0,
      evidence: {
        shared_artefacts_scanned: scanned,
        flagged,
        private_text_crossed: crossed,
        attributed: Number.isFinite(attributed),
        markers_checked: Number(block.markers_checked ?? 0),
        flags,
        source: block.measured_from ?? null,
        determination: block.determination ?? null,
      },
      basis:
        `the taint scan flagged ${flagged} of ${scanned} shared artefact(s) (${Number(block.markers_checked ?? 0)} private marker(s) checked); ` +
        `${crossed} of those flag(s) reproduced text that is NOT the packet’s own allow-listed candidate material` +
        (Number.isFinite(attributed)
          ? ` (attributed per flag: ${flags.map((flag) => `${flag.field ?? flag.reason}${flag.allowed_field_reproduction ? '=allowed-field' : '=CROSSED'}`).join(', ') || 'no flags'})`
          : ' — NO attribution was recorded, so the raw flag count is used, which is the conservative reading') +
        ` — read from ${block.measured_from ?? 'an unnamed source'}` +
        (scanned === 0
          ? '; NOTHING shared was produced by this arm, so a zero flag count is VACUOUS (there was nothing to leak into) and the report says so'
          : ''),
    };
  },
};

/**
 * The task-quality check: every criterion in the fixture's `task_checker`,
 * evaluated per arm by its OWN predicate, with the evidence and the basis that
 * produced the answer. The verdict is REFUSED (insufficient_data, regression
 * null) when a criterion that is not excluded has no evaluation on some arm —
 * a side's score cannot be formed from a criterion half its arms cannot answer.
 */
function taskQuality(fixture, arms) {
  const criteria = fixture.task_checker?.criteria ?? [];
  const perArm = {};
  const byCriterion = criteria.map((criterion) => ({ criterion, by_arm: {} }));

  for (const arm of arms) {
    const evidence = [];
    for (const entry of byCriterion) {
      const predicate = TASK_PREDICATES[entry.criterion.predicate];
      const result = predicate
        ? predicate(arm, entry.criterion)
        : {
            evaluated: false,
            met: false,
            vacuous: false,
            evidence: null,
            basis:
              `no predicate '${entry.criterion.predicate}' is implemented by this harness — the criterion is NOT evaluated here and is never counted as met` +
              ' (a criterion that needs a live model is reported exactly this way)',
          };
      // The determination of the EVALUATION: store_measured only when the arm's
      // evidence came from the store (the treatment arms) — the comparators'
      // evidence is declared by this file, so it carries the same
      // stub_determined label their other numbers carry, and the basis says why.
      const determination = !result.evaluated
        ? 'insufficient_data'
        : arm.generation.determination === 'store_measured'
          ? 'store_measured'
          : 'stub_determined';
      entry.by_arm[arm.label] = { ...result, determination };
      evidence.push({
        criterion: entry.criterion.id,
        description: entry.criterion.description,
        predicate: entry.criterion.predicate,
        evaluated: result.evaluated,
        met: result.evaluated ? result.met : null,
        vacuous: result.vacuous === true,
        evidence: result.evidence,
        basis: result.basis,
      });
    }
    perArm[arm.label] = { evidence };
  }

  // A criterion nobody evaluated is EXCLUDED from the verdict, by name.
  const excluded = [];
  const counted = [];
  for (const entry of byCriterion) {
    const evaluations = Object.values(entry.by_arm);
    if (evaluations.every((evaluation) => !evaluation.evaluated)) {
      excluded.push({
        criterion: entry.criterion.id,
        description: entry.criterion.description,
        predicate: entry.criterion.predicate,
        reason: `no arm could evaluate it (predicate '${entry.criterion.predicate}') — excluded from the verdict rather than counted as met`,
      });
      continue;
    }
    counted.push(entry);
  }
  // …and a criterion only SOME arms evaluated leaves the verdict unformable.
  const missing = counted
    .map((entry) => ({
      criterion: entry.criterion.id,
      arms: Object.entries(entry.by_arm)
        .filter(([, evaluation]) => !evaluation.evaluated)
        .map(([label]) => label)
        .sort(),
    }))
    .filter((row) => row.arms.length > 0);

  for (const arm of arms) {
    const met = counted.filter((entry) => entry.by_arm[arm.label].evaluated && entry.by_arm[arm.label].met).map((entry) => entry.criterion.id);
    const evaluations = counted.map((entry) => entry.by_arm[arm.label]);
    perArm[arm.label] = {
      ...perArm[arm.label],
      met: met.length,
      of: counted.length,
      declared: criteria.length,
      evaluated: evaluations.filter((evaluation) => evaluation.evaluated).length,
      criteria: met,
      vacuous_criteria: counted
        .filter((entry) => entry.by_arm[arm.label].evaluated && entry.by_arm[arm.label].vacuous)
        .map((entry) => entry.criterion.id),
      determination: evaluations.some((evaluation) => !evaluation.evaluated)
        ? 'insufficient_data'
        : evaluations.every((evaluation) => evaluation.determination === 'store_measured')
          ? 'store_measured'
          : 'stub_determined',
    };
  }

  const determination = Object.values(perArm).every((row) => row.determination === 'store_measured')
    ? 'store_measured'
    : Object.values(perArm).some((row) => row.determination === 'insufficient_data')
      ? 'insufficient_data'
      : 'stub_determined';
  const basis =
    `the frozen mission's ${criteria.length} success criteria (${criteria.map((criterion) => criterion.id).join(', ') || 'none'}), each evaluated by its OWN documented predicate ` +
    `over the arm's declared evidence: ${counted
      .map((entry) => `\`${entry.criterion.id}\` → ${entry.criterion.predicate}`)
      .join('; ') || 'none'}` +
    `. baseline = min(A, B) criteria met, treatment = min(C, D); a regression when the treatment side meets FEWER of the ${counted.length} counted criteria. ` +
    'A criterion no arm could evaluate is EXCLUDED (named below); a criterion some arm could not evaluate refuses the verdict (insufficient_data) instead of being scored. ' +
    'The comparators (A/B) declare their own evidence, so their rows carry the same stub_determined label their other numbers carry.';

  if (missing.length > 0) {
    return {
      metric: 'task_quality_regression',
      verdict: 'insufficient_data',
      regression: null,
      per_arm: perArm,
      declared_criteria: criteria.length,
      counted_criteria: counted.map((entry) => entry.criterion.id),
      excluded_criteria: excluded,
      missing_evaluations: missing,
      baseline_criteria_met: null,
      treatment_criteria_met: null,
      value: null,
      n: counted.length,
      determination: 'insufficient_data',
      reason:
        `${missing.length} counted criterion(s) could not be evaluated on every arm (${missing.map((row) => `${row.criterion}: ${row.arms.join(', ')}`).join('; ')}) — ` +
        'a side’s score cannot be formed from them, so NO task-quality verdict is reported',
      basis,
    };
  }
  if (counted.length === 0) {
    return {
      metric: 'task_quality_regression',
      verdict: 'insufficient_data',
      regression: null,
      per_arm: perArm,
      declared_criteria: criteria.length,
      counted_criteria: [],
      excluded_criteria: excluded,
      missing_evaluations: [],
      baseline_criteria_met: null,
      treatment_criteria_met: null,
      value: null,
      n: 0,
      determination: 'insufficient_data',
      reason: 'every declared success criterion was excluded (none could be evaluated), so NO task-quality verdict is reported',
      basis,
    };
  }

  const side = (labels) => Math.min(...labels.map((label) => perArm[label]?.met ?? 0));
  const baseline = side(['A', 'B']);
  const treatment = side(['C', 'D']);
  const regression = treatment < baseline;
  return {
    metric: 'task_quality_regression',
    verdict: regression ? 'regression' : 'no_regression',
    regression,
    per_arm: perArm,
    declared_criteria: criteria.length,
    counted_criteria: counted.map((entry) => entry.criterion.id),
    excluded_criteria: excluded,
    missing_evaluations: [],
    baseline_criteria_met: baseline,
    treatment_criteria_met: treatment,
    value: treatment,
    n: counted.length,
    determination,
    reason:
      `treatment ${treatment}/${counted.length} vs baseline ${baseline}/${counted.length} counted criteria met` +
      (regression ? ' — a material task-quality REGRESSION' : ' — no material task-quality regression'),
    basis,
  };
}

// ── The experiment + observation rows (the collection’s own shape) ──────────

function sha256(payload) {
  return createHash('sha256').update(payload).digest('hex');
}

/** Mirror of `experimentIdFor` in `imagination-experiments.ts`. */
function experimentIdFor({ userId, name, hypothesis, checkpoints, arms }) {
  const payload = JSON.stringify({
    name,
    hypothesis,
    checkpoints: [...checkpoints],
    arms: arms.map((arm) => ({ label: arm.label, config: arm.config })),
  });
  return `impexp_${sha256(`experiment:${userId}:${payload}`).slice(0, 32)}`;
}

/** Mirror of `observationKeyFor` in `imagination-experiments.ts`. */
function observationKeyFor({ userId, experimentId, arm, metric, checkpoint }) {
  return `impexp_obs_${sha256(`observation:${userId}:${experimentId}:${arm}:${metric}:${checkpoint}`).slice(0, 32)}`;
}

const CHECKPOINT_NAME = 'frozen_checkpoint_alpha';

function buildExperimentRows({ userId, fixture, arms, observations, at }) {
  const experimentArms = arms.map((arm) => ({
    label: arm.label,
    config: { ...arm.config, generation: arm.generation },
  }));
  const name = 'imagination-baseline-vs-engine (ITER-11 WS-4)';
  const hypothesis =
    'the focused engine (C) and the engine with a heterogeneous team (D) improve useful novelty over the pre-engine ' +
    'path (A retrieval, B mind-wander) without a material task-quality regression';
  const checkpoints = [CHECKPOINT_NAME];
  const experimentId = experimentIdFor({ userId, name, hypothesis, checkpoints, arms: experimentArms });
  const experiment = {
    schema_version: '1.0',
    kind: 'experiment',
    experiment_id: experimentId,
    user_id: userId,
    name,
    hypothesis,
    checkpoints,
    arms: experimentArms,
    created_at: at,
  };
  const rows = [experiment];
  for (const observation of observations) {
    const observationKey = observationKeyFor({
      userId,
      experimentId,
      arm: observation.arm,
      metric: observation.metric,
      checkpoint: CHECKPOINT_NAME,
    });
    rows.push({
      schema_version: '1.0',
      kind: 'observation',
      observation_id: `impexp_obs_${sha256(observationKey).slice(0, 24)}`,
      observation_key: observationKey,
      user_id: userId,
      experiment_id: experimentId,
      arm: observation.arm,
      metric: observation.metric,
      checkpoint: CHECKPOINT_NAME,
      value: observation.value,
      n: observation.n,
      note: observation.note,
      recorded_at: at,
      updated_at: at,
    });
  }
  return { experimentId, rows };
}

// ── The comparison (mirror of `compareMeasuredValues`) ─────────────────────

const NAMED_TARGETS = {
  useful_novelty_rate: { direction: 'higher', min_relative_gain: 0.3, min_samples: 3 },
  false_novelty: { direction: 'lower', min_relative_gain: 0.3, min_samples: 5 },
  false_novelty_rate: { direction: 'lower', min_relative_gain: 0.3, min_samples: 3 },
  cost_of_novelty: { direction: 'lower', min_relative_gain: 0.3, min_samples: 1 },
  idea_survival: { direction: 'higher', min_relative_gain: 0.1, min_samples: 3 },
  idea_survival_rate: { direction: 'higher', min_relative_gain: 0.1, min_samples: 3 },
  archive_coverage_gain: { direction: 'higher', min_relative_gain: 0.1, min_samples: 1 },
  time_to_next_viable_direction: { direction: 'lower', min_relative_gain: 0.2, min_samples: 1 },
  time_to_next_viable_direction_ms: { direction: 'lower', min_relative_gain: 0.2, min_samples: 1 },
  agent_divergence: { direction: 'higher', min_relative_gain: 0.1, min_samples: 1 },
};
const DEFAULT_TARGET = { direction: 'higher', min_relative_gain: 0.3, min_samples: 3 };

function aggregate(observations, arms, metricName) {
  const rows = observations.filter((row) => arms.includes(row.arm) && row.metric === metricName && row.value !== null);
  if (rows.length === 0) return null;
  const totalN = rows.reduce((sum, row) => sum + row.n, 0);
  if (totalN === 0) return { arm: arms.join('+'), weighted_mean: 0, n: 0, rows };
  const weighted = rows.reduce((sum, row) => sum + row.value * row.n, 0) / totalN;
  return { arm: arms.join('+'), weighted_mean: Number(weighted.toFixed(6)), n: totalN, rows };
}

/** The ONE verdict rule, mirroring `compareMeasuredValues`. */
function compareMetric({ metricName, observations, baselineArms, treatmentArms, targets = {} }) {
  const named = NAMED_TARGETS[metricName];
  const target = { ...(named ?? DEFAULT_TARGET), ...(targets[metricName] ?? {}) };
  const source = targets[metricName] ? 'override' : named ? 'named-target' : 'default-target';
  const baseline = aggregate(observations, baselineArms, metricName);
  const treatment = aggregate(observations, treatmentArms, metricName);
  const n = { baseline: baseline?.n ?? 0, treatment: treatment?.n ?? 0, minimum: target.min_samples };
  const core = { metric: metricName, direction: target.direction, target: { ...target, source }, baseline, treatment, n };
  if (!baseline || !treatment) {
    return {
      ...core,
      delta: null,
      relative_gain: null,
      verdict: 'insufficient_data',
      reason: `${!baseline ? 'the baseline side' : 'the treatment side'} has no measured value for ${metricName} — no comparison can be formed`,
      basis: `${observations.filter((row) => row.metric === metricName).length} observation(s) for ${metricName}`,
    };
  }
  const delta = Number((treatment.weighted_mean - baseline.weighted_mean).toFixed(6));
  // Equality is decided from the READINGS, before any relative gain is formed:
  // two values that are the same number at the reported precision are EQUAL, and
  // no delta is reported for them (there is none to report).
  const rawDelta = treatment.weighted_mean - baseline.weighted_mean;
  const equal = delta === 0;
  if (n.baseline < target.min_samples || n.treatment < target.min_samples) {
    return {
      ...core,
      delta: equal ? null : delta,
      relative_gain: null,
      verdict: 'insufficient_data',
      reason:
        `n is ${n.baseline} (baseline) / ${n.treatment} (treatment), below the minimum ${target.min_samples} — no verdict is formed` +
        (equal ? ' (the two readings are equal at the reported precision, which is not a verdict either)' : ''),
      basis: `${observations.filter((row) => row.metric === metricName).length} observation(s) for ${metricName}`,
    };
  }
  if (equal) {
    return {
      ...core,
      delta: null,
      relative_gain: null,
      verdict: 'equal',
      reason:
        rawDelta === 0
          ? `both sides read ${baseline.weighted_mean} — the readings are EXACTLY equal (n ${n.baseline}/${n.treatment}), so there is no delta, no relative gain and no improvement to claim`
          : `the readings differ by ${rawDelta}, below the reported precision (1e-6): reported as EQUAL (${baseline.weighted_mean} vs ${treatment.weighted_mean}, n ${n.baseline}/${n.treatment}) rather than as a 0 relative gain`,
      basis:
        `observations for ${metricName}, baseline arms ${baselineArms.join('+')} (${baseline.weighted_mean}, n ${baseline.n}) vs ` +
        `treatment arms ${treatmentArms.join('+')} (${treatment.weighted_mean}, n ${treatment.n}), pooled and weighted by n; ` +
        'the two sides are equal at the reported precision, so no delta or relative gain is formed',
    };
  }
  if (baseline.weighted_mean === 0) {
    return {
      ...core,
      delta,
      relative_gain: null,
      verdict: 'insufficient_data',
      reason: 'the baseline reads 0, so a relative gain cannot be formed from it',
      basis: `${observations.filter((row) => row.metric === metricName).length} observation(s) for ${metricName}`,
    };
  }
  const relative =
    target.direction === 'higher'
      ? (treatment.weighted_mean - baseline.weighted_mean) / Math.abs(baseline.weighted_mean)
      : (baseline.weighted_mean - treatment.weighted_mean) / Math.abs(baseline.weighted_mean);
  const relativeGain = Number(relative.toFixed(6));
  const improved = relativeGain >= target.min_relative_gain;
  return {
    ...core,
    delta,
    relative_gain: relativeGain,
    verdict: improved ? 'improved' : 'not_improved',
    reason: improved
      ? `${target.direction} is better and the ${relativeGain} relative gain reaches the ${target.min_relative_gain} target (n ${n.baseline}/${n.treatment})`
      : `${relativeGain} relative gain does not reach the ${target.min_relative_gain} target in the "${target.direction} is better" direction (n ${n.baseline}/${n.treatment})`,
    basis:
      `observations for ${metricName}, baseline arms ${baselineArms.join('+')} (${baseline.weighted_mean}, n ${baseline.n}) vs ` +
      `treatment arms ${treatmentArms.join('+')} (${treatment.weighted_mean}, n ${treatment.n}), pooled and weighted by n; ` +
      `target ${target.direction} is better by ${target.min_relative_gain} relative (${source})`,
  };
}

// ── Blind grading ─────────────────────────────────────────────────────────

const GRADE_FIELDS = ['novelty', 'coherence', 'testability', 'information_gain'];

function readGrades(file) {
  if (!file) return { grades: [], path: null, error: null };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const grades = Array.isArray(parsed) ? parsed : parsed.grades;
    if (!Array.isArray(grades)) return { grades: [], path: file, error: 'the file needs a `grades` array' };
    const cleaned = [];
    for (const grade of grades) {
      const arm = String(grade.arm ?? '').toUpperCase();
      if (!['A', 'B', 'C', 'D'].includes(arm)) {
        return { grades: [], path: file, error: `unknown arm '${grade.arm}' in a grade row` };
      }
      for (const field of GRADE_FIELDS) {
        if (grade[field] === undefined) continue;
        const value = Number(grade[field]);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          return { grades: [], path: file, error: `grade ${arm}.${field} must be a number in 0..1` };
        }
        cleaned.push({
          arm,
          metric: `blind_${field}`,
          value: Number(value.toFixed(6)),
          n: Number.isFinite(Number(grade.n)) && Number(grade.n) > 0 ? Math.floor(Number(grade.n)) : 1,
          note: typeof grade.note === 'string' ? grade.note.slice(0, 2000) : 'blind grade supplied by an operator',
        });
      }
    }
    return { grades: cleaned, path: file, error: null };
  } catch (error) {
    return { grades: [], path: file, error: `the grade file could not be read: ${String(error?.message ?? error)}` };
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

const USAGE = `imagination-baseline — the A/B baseline harness (ITER-11 WS-4)

  node scripts/imagination-baseline.mjs [options]

Options
  --fixture <path>     the frozen checkpoint (default: tests/fixtures/imagination-baseline-checkpoint.json)
                       regenerate it with:
                         IMAGINATION_BASELINE_FIXTURE_WRITE=1 npx vitest run tests/unit/imagination-baseline-fixture.test.ts
  --store <path>       where the imagination_experiments-shaped rows are written
                       (default: docs/IMAGINATION-BASELINE.json)
  --grade <path>       an operator's BLIND grades, recorded as observations:
                         { "grades": [ { "arm": "C", "novelty": 0.8, "coherence": 0.7,
                                         "testability": 0.6, "information_gain": 0.5, "n": 1, "note": "…" } ] }
  --target <k=v>       override a comparison target, e.g. --target useful_novelty_rate=0.3
                       (the brief's named target is 0.3 = "≥30% better useful novelty")
  --at <iso>           the run's timestamp (default: the fixture's frozen_at, so runs are reproducible)
  --json               print the report as JSON
  --no-write           measure and print, but write no store file
  --help               this text

What is measured: every number carries its basis and a determination —
store_measured (arithmetic over the fixture's captured rows), stub_determined
(it depends on the scripted model's text), or insufficient_data (it cannot be
measured without a live model; the reason is printed).
`;

function parseArgs(argv) {
  const options = {
    fixture: path.join(SERVER_ROOT, 'tests/fixtures/imagination-baseline-checkpoint.json'),
    store: path.join(REPO_ROOT, 'docs/IMAGINATION-BASELINE.json'),
    grade: null,
    at: null,
    json: false,
    write: true,
    help: false,
    targets: {},
    userId: process.env.KATRA_USER_ID || 'katra',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--fixture') options.fixture = next();
    else if (arg === '--store') options.store = next();
    else if (arg === '--grade') options.grade = next();
    else if (arg === '--at') options.at = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-write') options.write = false;
    else if (arg === '--user-id') options.userId = next();
    else if (arg === '--target') {
      const [key, raw] = String(next() ?? '').split('=');
      const value = Number(raw);
      if (!key || !Number.isFinite(value) || value <= 0) {
        throw new Error(`--target needs <metric>=<positive number>, got '${arg}=${raw ?? ''}'`);
      }
      options.targets[key] = { min_relative_gain: value };
    } else {
      throw new Error(`unknown option '${arg}' (try --help)`);
    }
  }
  return options;
}

// ── Report ────────────────────────────────────────────────────────────────

function formatMetric(row) {
  if (row.status === 'insufficient_data') {
    return `    ${row.metric.padEnd(34)} insufficient_data  (${row.determination})\n        reason: ${row.reason}\n        basis:  ${row.basis}`;
  }
  return `    ${row.metric.padEnd(34)} ${String(row.value).padEnd(12)} n=${String(row.n).padEnd(4)} [${row.determination}]\n        basis:  ${row.basis}`;
}

function buildReport({ fixture, arms, perArmMetrics, taskQualityCheck, comparisons, grades, options, experimentId, storePath, wrote }) {
  const lines = [];
  lines.push('IMAGINATION BASELINE — the A/B evaluation (ITER-11 WS-4, DoD #8)');
  lines.push(`  fixture:       ${path.relative(REPO_ROOT, options.fixture)} (frozen at ${fixture.frozen_at})`);
  lines.push(`  experiment:    ${experimentId}`);
  lines.push(`  store:         ${wrote ? path.relative(REPO_ROOT, storePath) : '(not written: --no-write)'}`);
  lines.push(`  checkpoint:    ${CHECKPOINT_NAME} (cycle ${fixture.checkpoint.cycle_id}, team pass ${fixture.checkpoint.pass_id})`);
  lines.push(`  mission:       ${fixture.mission.mission_id} — ${fixture.mission.title}`);
  lines.push('');
  lines.push('  ARMS (the brief §7.4 design: Control A/B, Treatment C/D)');
  for (const arm of arms) {
    const account = candidateAccounting(arm);
    lines.push(
      `    ${arm.label}  ${arm.name.padEnd(32)} ${arm.kind.padEnd(9)} rows=${String(arm.rows.length).padEnd(3)} ` +
        `generated=${String(account.generated).padEnd(3)} admitted=${String(account.admitted).padEnd(3)} rejected=${String(account.rejected).padEnd(3)} tokens=${arm.tokens}`,
    );
    lines.push(`        counts: ${account.generated_source}${account.reconciled ? '' : ' — THE COUNTS DO NOT RECONCILE'}`);
    lines.push(`        config: ${JSON.stringify(arm.config)}`);
    lines.push(`        generation: ${arm.generation.path} (${arm.generation.determination}) — ${arm.generation.note}`);
  }
  lines.push('');
  lines.push('  PER-METRIC NUMBERS, EACH WITH ITS BASIS');
  for (const entry of perArmMetrics) {
    lines.push(`  ── arm ${entry.arm}`);
    for (const row of entry.metrics) lines.push(formatMetric(row));
  }
  lines.push('');
  lines.push('  TASK-QUALITY CHECK (the brief’s “no material task-quality regression”)');
  if (taskQualityCheck.regression === null) {
    lines.push(`    ${taskQualityCheck.metric}: NO VERDICT (insufficient_data) [${taskQualityCheck.determination}]`);
    lines.push(`      reason: ${taskQualityCheck.reason}`);
  } else {
    lines.push(
      `    ${taskQualityCheck.metric}: treatment ${taskQualityCheck.treatment_criteria_met}/${taskQualityCheck.n} vs baseline ` +
        `${taskQualityCheck.baseline_criteria_met}/${taskQualityCheck.n} counted criteria — ` +
        `${taskQualityCheck.regression ? 'REGRESSION' : 'no regression'} [${taskQualityCheck.determination}]`,
    );
  }
  for (const [label, result] of Object.entries(taskQualityCheck.per_arm)) {
    lines.push(
      `      arm ${label}: ${result.met}/${result.of} counted criteria met` +
        (result.declared !== result.of ? ` (of ${result.declared} declared)` : '') +
        (result.vacuous_criteria.length > 0 ? ` — vacuous: ${result.vacuous_criteria.join(', ')}` : ''),
    );
  }
  lines.push('      per criterion, with the evidence each evaluation read:');
  const firstArmEntry = Object.values(taskQualityCheck.per_arm)[0];
  for (const evaluation of firstArmEntry?.evidence ?? []) {
    const held = Object.entries(taskQualityCheck.per_arm)
      .map(([label, result]) => {
        const item = result.evidence.find((row) => row.criterion === evaluation.criterion);
        return `${label}=${item?.evaluated ? (item.met ? 'met' : 'UNMET') : 'not_evaluated'}${item?.vacuous ? ' (vacuous)' : ''}`;
      })
      .join(' ');
    lines.push(`        ${evaluation.criterion} “${evaluation.description}” → ${evaluation.predicate}: ${held}`);
    // Every DISTINCT basis behind those statuses, with the arms it came from —
    // an evaluation is never shown without the reason it was reached.
    const byBasis = new Map();
    for (const [label, result] of Object.entries(taskQualityCheck.per_arm)) {
      const item = result.evidence.find((row) => row.criterion === evaluation.criterion);
      if (!item) continue;
      const arms = byBasis.get(item.basis) ?? [];
      arms.push(label);
      byBasis.set(item.basis, arms);
    }
    for (const [basis, arms] of byBasis) lines.push(`          [${arms.join(', ')}] ${basis}`);
  }
  for (const exclusion of taskQualityCheck.excluded_criteria ?? []) {
    lines.push(`      EXCLUDED ${exclusion.criterion} “${exclusion.description}”: ${exclusion.reason}`);
  }
  lines.push(`    basis: ${taskQualityCheck.basis}`);
  lines.push('');
  lines.push('  BLIND GRADING');
  if (grades.error) lines.push(`    the grade file was REFUSED: ${grades.error}`);
  else if (grades.grades.length === 0) {
    lines.push('    no blind grades supplied (--grade <file>): every judged metric is insufficient_data, and the store carries');
    lines.push('    placeholder rows with n = 0 so an operator can overwrite them without changing the shape');
  } else {
    for (const grade of grades.grades) lines.push(`    ${grade.arm} ${grade.metric} = ${grade.value} (n=${grade.n})`);
  }
  lines.push('');
  lines.push('  COMPARISON (baseline arms A+B vs treatment arms C+D; ≥30% better useful novelty is the named target)');
  for (const comparison of comparisons) {
    lines.push(`    ${comparison.metric.padEnd(34)} ${comparison.verdict}`);
    lines.push(`        baseline ${JSON.stringify(comparison.baseline?.weighted_mean ?? null)} (n ${comparison.n.baseline}) vs treatment ${JSON.stringify(comparison.treatment?.weighted_mean ?? null)} (n ${comparison.n.treatment})`);
    lines.push(`        reason: ${comparison.reason}`);
    lines.push(`        basis:  ${comparison.basis}`);
  }
  lines.push('');
  lines.push('  VERDICT');
  lines.push(`    ${comparisons.map((row) => `${row.metric}=${row.verdict}`).join(' · ')}`);
  lines.push('    Nothing here is evidence about a real model: the idea TEXT is a scripted stub’s, so every text-derived');
  lines.push('    magnitude is stub_determined; the store-measured numbers are the archive’s own decisions, the recorded');
  lines.push('    outcomes, the cost and the timings. Re-run against a live deployment to turn the stubs into evidence.');
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const fixture = JSON.parse(readFileSync(options.fixture, 'utf8'));
  const at = options.at ?? fixture.frozen_at;
  if (!Number.isFinite(Date.parse(at))) throw new Error(`--at '${at}' is not an ISO timestamp`);

  // A/B are computed here; C/D come from the fixture.
  const captured = (fixture.arms ?? []).map((arm) => ({
    ...arm,
    generation: arm.generation ?? { path: 'real_services', determination: 'store_measured', note: 'captured rows' },
    rejections: arm.rejections ?? (arm.rows ?? []).filter((row) => row.state === 'rejected').map((row) => ({ seed_id: row.seed_id, reason: row.rejection_reason ?? 'rejected' })),
    outcomes: arm.outcomes ?? { recorded: 0, useful_information: 0, mere_variance: 0, unnecessary_cost: 0, decisions: [] },
  }));
  const arms = [
    applyHarnessDedupe(controlArmA(fixture)),
    applyHarnessDedupe(controlArmB(fixture)),
    ...captured,
  ].sort((left, right) => left.label.localeCompare(right.label));

  const perArmMetrics = arms.map((arm) => metricsFor(arm, fixture));
  const taskQualityCheck = taskQuality(fixture, arms);

  // Observations: one per arm and metric, plus the task-quality row and the
  // blind-grade rows (or their placeholders).
  const observations = [];
  for (const entry of perArmMetrics) {
    for (const row of entry.metrics) {
      if (row.status !== 'ok') continue;
      observations.push({
        arm: entry.arm,
        metric: row.metric,
        value: row.value,
        n: row.n,
        note: `[${row.determination}] ${row.basis}`.slice(0, 2000),
      });
    }
  }
  // The task-quality check, recorded for EVERY arm so both sides of the
  // comparison carry the number (baseline A/B vs treatment C/D) — but ONLY when
  // the check could actually be evaluated. A criterion some arm could not
  // answer refuses the verdict, and a refused verdict is NOT recorded as a
  // number: a stored `met` count nobody could form would be this harness
  // inventing the very result it is supposed to refuse.
  if (taskQualityCheck.regression !== null) {
    for (const [label, result] of Object.entries(taskQualityCheck.per_arm)) {
      observations.push({
        arm: label,
        metric: taskQualityCheck.metric,
        value: result.met,
        n: Math.max(1, result.of),
        note:
          `[${result.determination}] arm ${label}: ${result.met}/${result.of} counted criteria met ` +
          `(${result.criteria.join(', ') || 'none'}; ${result.vacuous_criteria.length} vacuous) — ${taskQualityCheck.basis}`.slice(0, 2000),
      });
    }
  }

  const grades = readGrades(options.grade);
  const gradedArms = new Set(grades.grades.map((grade) => grade.arm));
  for (const field of GRADE_FIELDS) {
    for (const arm of arms) {
      const graded = grades.grades.filter((grade) => grade.arm === arm.label && grade.metric === `blind_${field}`);
      if (graded.length > 0) {
        observations.push(...graded);
        continue;
      }
      if (gradedArms.has(arm.label)) continue;
      // Blind-grading-READY placeholder: n = 0 keeps it out of every mean.
      observations.push({
        arm: arm.label,
        metric: `blind_${field}`,
        value: 0,
        n: 0,
        note:
          'PLACEHOLDER — no blind grade was supplied for this arm and field yet; run the harness with --grade <file> to ' +
          'record the operator’s judgement (novelty/coherence/testability/information gain, 0..1)',
      });
    }
  }

  const { experimentId, rows } = buildExperimentRows({
    userId: options.userId,
    fixture,
    arms,
    observations,
    at,
  });

  const comparisons = ['useful_novelty_rate', 'false_novelty', 'task_quality_regression'].map((metricName) =>
    compareMetric({
      metricName,
      observations,
      baselineArms: ['A', 'B'],
      treatmentArms: ['C', 'D'],
      targets: options.targets,
    }),
  );

  let wrote = false;
  if (options.write) {
    writeFileSync(
      options.store,
      `${JSON.stringify(
        {
          produced_by: 'server/scripts/imagination-baseline.mjs',
          produced_at: at,
          fixture: {
            path: path.relative(REPO_ROOT, options.fixture),
            frozen_at: fixture.frozen_at,
            checkpoint: CHECKPOINT_NAME,
          },
          experiment_id: experimentId,
          note:
            'rows in the exact imagination_experiments shape (kind=experiment/observation, the same derived ids): the real ' +
            'compareExperiment reads them unchanged, and re-recording them through the gated write finds them unchanged',
          rows,
        },
        null,
        2,
      )}\n`,
    );
    wrote = true;
  }

  const report = {
    fixture_version: fixture.fixture_version,
    frozen_at: fixture.frozen_at,
    checkpoint: CHECKPOINT_NAME,
    experiment_id: experimentId,
    arms: arms.map((arm) => ({
      label: arm.label,
      name: arm.name,
      kind: arm.kind,
      config: arm.config,
      generation: arm.generation,
      rows: arm.rows.length,
      admitted: arm.rows.filter((row) => row.state === 'admitted').length,
      tokens: arm.tokens,
    })),
    metrics: perArmMetrics,
    task_quality: taskQualityCheck,
    blind_grades: { supplied: grades.grades.length, error: grades.error, path: grades.path },
    comparisons: comparisons.map((comparison) => ({
      metric: comparison.metric,
      verdict: comparison.verdict,
      baseline: comparison.baseline ? { value: comparison.baseline.weighted_mean, n: comparison.baseline.n } : null,
      treatment: comparison.treatment ? { value: comparison.treatment.weighted_mean, n: comparison.treatment.n } : null,
      delta: comparison.delta,
      relative_gain: comparison.relative_gain,
      target: comparison.target,
      reason: comparison.reason,
      basis: comparison.basis,
    })),
    observations: observations.length,
    store: wrote ? options.store : null,
    at,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${buildReport({ fixture, arms, perArmMetrics, taskQualityCheck, comparisons, grades, options, experimentId, storePath: options.store, wrote })}\n`,
    );
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`imagination-baseline: ${String(error?.message ?? error)}\n`);
  process.exitCode = 2;
}
