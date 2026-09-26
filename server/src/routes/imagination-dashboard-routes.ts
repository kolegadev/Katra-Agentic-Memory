/**
 * ITER-9 (Phase 7): the read-only imagination dashboard API.
 *
 * Contract: CONTRACT-iter9-observability.md §C. The surface exists so an
 * operator can see WHY a cycle triggered (plateau conditions with evidence +
 * the stop reason), WHAT was generated (admitted candidates), WHAT was rejected
 * (with reasons) and WHETHER value improved versus baseline (a metrics
 * comparison with an explicit verdict, its basis and its sample size).
 *
 * The rules this file obeys, in the same shape `cognition-dashboard-routes.ts`
 * established in Phase 7:
 *
 *   - READ-ONLY. Every GET is a read: no view runs a cycle, promotes a baton,
 *     changes a mode or writes a row. The ONE write in this file is
 *     `POST /experiments/observations` — trusted-gated, flag-gated, caller-owned
 *     and idempotent per {experiment, arm, metric, checkpoint} (the service
 *     refuses anything else before touching a row).
 *   - EMPTY WITH A STATED REASON. A view that has no rows says WHY: the family
 *     flag is off, the cognitive-team flag is off, no mission_id was supplied
 *     for a mission-scoped read, or simply "no data exists yet". A bare empty
 *     list is never returned.
 *   - EVERY NUMBER CARRIES ITS BASIS. Counts name their collections, the metrics
 *     view carries the window, the `n` and the documented minimum behind every
 *     metric, and a metric below its minimum says `insufficient_data` instead of
 *     producing a rate.
 *   - NO PRIVATE TEXT ACROSS IDENTITIES. Traces, seeds, lineages and portfolios
 *     are identity-private: an untrusted caller is pinned to its own identity
 *     and a non-owner read returns NOTHING — no rows, no marker text, and no
 *     error that would reveal existence. The shareable surfaces are the
 *     sanitised baton fields, the coverage view (bins/counts/ids), the
 *     allocation reports and the metrics.
 *   - PRIVACY INDICATORS on every artefact view: `scope` (private | shared |
 *     private+shared), `private_rows` / `shared_rows`, and
 *     `raw_reflections_included: false` — with the basis that explains it.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { get_database } from '../database/connection.js';
import { getCaller } from '../utils/caller-identity.js';
import type { CallerIdentity } from '../utils/caller-identity.js';
import { cognitiveControlMode } from '../services/mission-cognition/index.js';
import { killSwitchActive, schedulerMode } from '../services/mission-cognition/scheduler-mode.js';
import { perIdentityPersonalityEnabled } from '../services/integration/personality-config-service.js';
import { focusedImaginationEnabled } from '../services/processing/focused-consolidation-service.js';
import { creativeBatonPromotionEnabled, batonVisibleTo, verifyStoredBaton } from '../services/processing/creative-baton-compiler.js';
import { cognitiveTeamAllocationEnabled, verifyAssignment } from '../services/processing/cognitive-mode-service.js';
import { invariantViolation, verifyEnvelope } from '../services/processing/inheritance-envelope.js';
import { CREATIVE_BATON_COLLECTIONS } from '../services/processing/creative-baton-collections.js';
import { COGNITIVE_TEAM_COLLECTIONS } from '../services/processing/cognitive-team-collections.js';
import { IMAGINATION_COLLECTIONS } from '../services/processing/imagination-collections.js';
import { FOCUSED_CONSOLIDATION_COLLECTIONS } from '../services/processing/focused-consolidation-collections.js';
import { IdeaArchiveService } from '../services/processing/idea-archive-service.js';
import {
  metricsWindowDays,
  MIN_DIVERGENCE_AGENTS,
  MIN_CYCLE_SAMPLES,
  MIN_GENERATED_SAMPLES,
  MIN_OUTCOME_SAMPLES,
  computeImaginationMetrics,
} from '../services/processing/imagination-metrics-service.js';
import {
  compareExperiment,
  listExperiments,
  listObservations,
  recordExperimentObservation,
} from '../services/processing/imagination-experiments.js';

export const IMAGINATION_FLAG = 'FOCUSED_IMAGINATION';
export const TEAM_FLAG = 'COGNITIVE_TEAM_ALLOCATION';
export const OBSERVATION_WRITE_PATH = '/experiments/observations';

const FLAG_OFF_REASON =
  'FOCUSED_IMAGINATION=off — the imagination views are disabled by flag (no back door). This is the designed default state, not a fault.';
const TEAM_FLAG_OFF_REASON =
  'COGNITIVE_TEAM_ALLOCATION=off — the cognitive-team view is disabled by flag. Modes, envelopes and allocations are not read.';
const MAX_ROWS = 200;

function db(): Db {
  const d = get_database();
  if (!d) throw new Error('MongoDB disconnected');
  return d;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The identity a view is measured for. An untrusted caller is pinned to itself
 * — a supplied `user_id` is IGNORED, never honoured — and a trusted caller may
 * name one. `null` (trusted, no name) means "every identity", which is the
 * convention `cognition-dashboard-routes.ts` uses for trusted reads.
 */
export function scopedIdentity(caller: CallerIdentity, requested: unknown): string | null {
  if (!caller.trusted) return caller.user_id;
  return nonEmpty(requested);
}

function identityFilter(caller: CallerIdentity, requested: unknown): Record<string, unknown> {
  const scoped = scopedIdentity(caller, requested);
  return scoped ? { user_id: scoped } : {};
}

function privacyIndicator(args: { privateRows: number; sharedRows: number; basis: string }) {
  return {
    scope: args.sharedRows === 0 ? 'private' : args.privateRows === 0 ? 'shared' : 'private+shared',
    private_rows: args.privateRows,
    shared_rows: args.sharedRows,
    raw_reflections_included: false,
    basis: args.basis,
  };
}

function flagOff(flag: string, reason: string, extra: Record<string, unknown> = {}) {
  return { plane: 'off', flag: { name: flag, on: false }, reason, ...extra };
}

/** The number-free projection of a seed: what was generated, never its text. */
function seedJson(row: Record<string, any>) {
  return {
    seed_id: row.seed_id,
    mission_id: row.mission_id,
    cycle_id: row.cycle_id ?? null,
    operator: row.operator,
    state: row.state,
    cell_key: row.cell_key,
    bins: row.bins ?? null,
    novelty_score: row.novelty_score,
    coherence_score: row.coherence_score,
    testability_score: row.testability_score,
    expected_information_gain: row.expected_information_gain ?? null,
    quality: row.quality,
    incumbent: Boolean(row.incumbent),
    created_at: row.created_at,
  };
}

function rejectionJson(row: Record<string, any>) {
  return {
    seed_id: row.seed_id,
    operator: row.operator,
    reason: row.rejection?.reason ?? null,
    detail: row.rejection?.detail ?? null,
    duplicate_of: row.rejection?.duplicate_of ?? null,
    at: row.rejection?.at ?? row.created_at ?? null,
  };
}

/** The sanitised baton projection: the compiled packet is already allow-listed. */
function batonJson(row: Record<string, any>) {
  return {
    baton_id: row.baton_id,
    mission_id: row.mission_id,
    cycle_id: row.cycle_id,
    user_id: row.user_id,
    shared_id: row.shared_id ?? null,
    scope: nonEmpty(row.shared_id) ? 'shared' : 'private',
    trigger: row.trigger,
    stop_reason: row.stop_reason ?? null,
    counts: row.counts,
    coverage_summary: row.coverage_summary ?? null,
    coverage_gaps: row.coverage_gaps ?? [],
    excluded_regions: row.excluded_regions ?? [],
    attention_targets: row.attention_targets ?? [],
    candidate_portfolio: row.candidate_portfolio ?? [],
    next_round_budget: row.next_round_budget ?? null,
    privacy: row.privacy ?? { raw_reflections_included: false, shared: false },
    payload_hash: row.payload_hash,
    promotion_id: row.promotion_id ?? null,
    promoted_at: row.promoted_at ?? null,
    promoted_by: row.promoted_by ?? null,
    created_at: row.created_at,
  };
}

export const createImaginationDashboardRoutes = (): Hono => {
  const router = new Hono();

  // ── Overview: what this identity's imagination has been doing ────────────
  router.get('/overview', async (c) => {
    const d = db();
    const caller = getCaller();
    const filter = identityFilter(caller, c.req.query('user_id'));
    const missionId = nonEmpty(c.req.query('mission_id'));
    if (!focusedImaginationEnabled()) {
      return c.json(
        flagOff(IMAGINATION_FLAG, FLAG_OFF_REASON, {
          identity: scopedIdentity(caller, c.req.query('user_id')) ?? 'all',
          missions: [],
          privacy: privacyIndicator({
            privateRows: 0,
            sharedRows: 0,
            basis: 'no row was read: the family flag is off, so nothing at all touches these collections',
          }),
        }),
      );
    }
    const cycles = (await d
      .collection(CREATIVE_BATON_COLLECTIONS.cycles)
      .find({ ...filter, ...(missionId ? { mission_id: missionId } : {}) }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(MAX_ROWS)
      .toArray()) as Array<Record<string, any>>;

    const byMission = new Map<string, Record<string, any>>();
    for (const cycle of cycles) {
      const key = `${cycle.user_id}\u0000${cycle.mission_id}`;
      const row =
        byMission.get(key) ??
        {
          user_id: cycle.user_id,
          mission_id: cycle.mission_id,
          cycles: 0,
          seeded_cycles: 0,
          last_cycle_at: null,
          last_cycle_id: null,
          last_stop_reason: null,
          last_trigger: null,
          admitted_total: 0,
          rejected_total: 0,
          new_cells_total: 0,
          cells_total: 0,
          promoted: 0,
          basis: 'imagination_cycles rows for this mission, newest first (counts are summed over the rows read)',
        };
      row.cycles += 1;
      row.admitted_total += Number(cycle.counts?.seeds_admitted ?? 0);
      row.rejected_total += Number(cycle.counts?.seeds_rejected ?? 0);
      row.new_cells_total += Number(cycle.counts?.new_cells ?? 0);
      if (row.last_cycle_at === null) {
        row.last_cycle_at = cycle.created_at;
        row.last_cycle_id = cycle.cycle_id;
        row.last_stop_reason = cycle.stop_reason ?? null;
        row.last_trigger = cycle.trigger ?? null;
        row.cells_total = Number(cycle.counts?.cells_total ?? 0);
      }
      if (cycle.promoted) row.promoted += 1;
      byMission.set(key, row);
    }
    const missions = [...byMission.values()].sort((left, right) =>
      String(right.last_cycle_at).localeCompare(String(left.last_cycle_at)),
    );
    return c.json({
      plane: 'on',
      flag: { name: IMAGINATION_FLAG, on: true },
      identity: scopedIdentity(caller, c.req.query('user_id')) ?? 'all',
      missions,
      counts: {
        cycles: cycles.length,
        missions: missions.length,
        basis: `imagination_cycles, newest ${MAX_ROWS} kept — summed over the rows this response was built from`,
      },
      privacy: privacyIndicator({
        privateRows: cycles.length,
        sharedRows: 0,
        basis:
          'imagination_cycles is a personal kind: every row is written without a shared_id and read back scoped to its identity',
      }),
      basis:
        'imagination_cycles (cycle ledger) read from stored records; the coverage total is the newest cycle\'s own counts.cells_total',
      reason:
        missions.length === 0
          ? 'no imagination cycle has been recorded for this identity yet — empty because no data exists (the flag is on)'
          : null,
    });
  });

  // ── Cycles list ─────────────────────────────────────────────────────────
  router.get('/cycles', async (c) => {
    const d = db();
    const caller = getCaller();
    if (!focusedImaginationEnabled()) {
      return c.json(flagOff(IMAGINATION_FLAG, FLAG_OFF_REASON, { cycles: [] }));
    }
    const filter = identityFilter(caller, c.req.query('user_id'));
    const missionId = nonEmpty(c.req.query('mission_id'));
    const status = nonEmpty(c.req.query('status'));
    const cycles = (await d
      .collection(CREATIVE_BATON_COLLECTIONS.cycles)
      .find(
        { ...filter, ...(missionId ? { mission_id: missionId } : {}), ...(status ? { status } : {}) },
        { projection: { _id: 0 } },
      )
      .sort({ created_at: -1 })
      .limit(MAX_ROWS)
      .toArray()) as Array<Record<string, any>>;
    return c.json({
      plane: 'on',
      identity: scopedIdentity(caller, c.req.query('user_id')) ?? 'all',
      cycles: cycles.map((cycle) => ({
        cycle_id: cycle.cycle_id,
        user_id: cycle.user_id,
        mission_id: cycle.mission_id,
        mission_version: cycle.mission_version,
        trigger: cycle.trigger,
        forced: Boolean(cycle.forced),
        status: cycle.status,
        stop_reason: cycle.stop_reason,
        counts: cycle.counts,
        novelty: cycle.novelty ?? null,
        baton_id: cycle.baton_id ?? null,
        promoted: Boolean(cycle.promoted),
        promotion_skipped: cycle.promotion_skipped ?? null,
        tokens_spent_this_cycle: cycle.budget?.tokens_spent_this_cycle ?? null,
        created_at: cycle.created_at,
        completed_at: cycle.completed_at ?? null,
        duration_ms: cycle.duration_ms ?? null,
        error: cycle.error ?? null,
      })),
      privacy: privacyIndicator({
        privateRows: cycles.length,
        sharedRows: 0,
        basis: 'imagination_cycles — private per identity; this list never carries a baton payload or a seed statement',
      }),
      basis: `imagination_cycles, newest ${MAX_ROWS}; each row's counts and budget are the numbers the cycle itself recorded`,
      reason:
        cycles.length === 0
          ? 'no cycle matches this query for this identity — empty because no data exists (the flag is on)'
          : null,
    });
  });

  // ── Cycle detail: conditions + evidence, stop reason, rejections ─────────
  router.get('/cycles/:cycleId', async (c) => {
    const d = db();
    const caller = getCaller();
    if (!focusedImaginationEnabled()) {
      return c.json(flagOff(IMAGINATION_FLAG, FLAG_OFF_REASON, { cycle: null, generated: [], rejected: [] }));
    }
    const cycleId = nonEmpty(c.req.param('cycleId'));
    const filter = identityFilter(caller, c.req.query('user_id'));
    const cycle = (await d
      .collection(CREATIVE_BATON_COLLECTIONS.cycles)
      .findOne({ cycle_id: cycleId, ...filter }, { projection: { _id: 0 } })) as unknown as Record<string, any> | null;
    // A cycle the caller may not see is reported exactly like one that does not
    // exist — no error that would leak existence.
    if (!cycle) {
      return c.json({
        plane: 'on',
        cycle: null,
        generated: [],
        rejected: [],
        reason: 'no cycle with this id is visible to this caller (it does not exist, or it belongs to another identity)',
      });
    }
    const seeds = (await d
      .collection(IMAGINATION_COLLECTIONS.ideaSeeds)
      .find(
        { user_id: cycle.user_id, mission_id: cycle.mission_id, cycle_id: cycle.cycle_id },
        { projection: { _id: 0 } },
      )
      .sort({ rank: 1, created_at: 1 })
      .limit(MAX_ROWS)
      .toArray()) as Array<Record<string, any>>;
    const admitted = seeds.filter((row) => row.state !== 'rejected');
    const rejected = seeds.filter((row) => row.state === 'rejected');
    const trace = cycle.trace_id
      ? ((await d
          .collection(FOCUSED_CONSOLIDATION_COLLECTIONS.salienceTraces)
          .findOne({ trace_id: cycle.trace_id, user_id: cycle.user_id }, { projection: { _id: 0, trace_id: 1, calibration: 1, evidence: 1, created_at: 1 } })) as
          | Record<string, any>
          | null)
      : null;
    return c.json({
      plane: 'on',
      cycle: {
        cycle_id: cycle.cycle_id,
        user_id: cycle.user_id,
        mission_id: cycle.mission_id,
        mission_version: cycle.mission_version,
        trigger: cycle.trigger,
        forced: Boolean(cycle.forced),
        actor_id: cycle.actor_id,
        status: cycle.status,
        stop_reason: cycle.stop_reason,
        stop_conditions: cycle.stop_conditions ?? [],
        plateau: cycle.plateau ?? [],
        counts: cycle.counts,
        novelty: cycle.novelty ?? null,
        budget: cycle.budget ?? null,
        coverage: cycle.coverage ?? null,
        trace_id: cycle.trace_id ?? null,
        baton_id: cycle.baton_id ?? null,
        promoted: Boolean(cycle.promoted),
        promotion_id: cycle.promotion_id ?? null,
        promotion_skipped: cycle.promotion_skipped ?? null,
        error: cycle.error ?? null,
        created_at: cycle.created_at,
        completed_at: cycle.completed_at ?? null,
        duration_ms: cycle.duration_ms ?? null,
        privacy_audit: cycle.privacy_audit ?? null,
      },
      // (a) WHY it triggered: the plateau conditions with the numbers that
      // decided each one, and every stop condition with its own evidence.
      conditions: {
        plateau: (cycle.plateau ?? []).map((condition: any) => ({
          name: condition.name,
          met: Boolean(condition.met),
          evidence: condition.evidence ?? {},
        })),
        stop: (cycle.stop_conditions ?? []).map((condition: any) => ({
          name: condition.name,
          met: Boolean(condition.met),
          evidence: condition.evidence ?? {},
        })),
        basis:
          'the plateau and stop evaluations recorded ON the cycle row when it ran (every condition is stored with whether it was met and the numbers that decided it)',
      },
      // (b) WHAT was generated and WHAT was rejected — ids, numbers and
      // reasons; never the seed text (the text stays in the private store).
      generated: { admitted: admitted.map(seedJson), count: admitted.length },
      rejected: { rows: rejected.map(rejectionJson), count: rejected.length },
      reason:
        seeds.length === 0
          ? 'this cycle recorded no seed rows — empty because the cycle stored none (stop reason: ' + String(cycle.stop_reason) + ')'
          : null,
      trace_summary: trace
        ? {
            trace_id: trace.trace_id,
            calibration: trace.calibration ?? null,
            evidence_counts: {
              total_refs: trace.evidence?.total_refs ?? null,
              resolved_refs: trace.evidence?.resolved_refs ?? null,
              unresolved_ref_count: trace.evidence?.unresolved_ref_count ?? null,
              unresolved_evidence_count: trace.evidence?.unresolved_evidence_count ?? null,
            },
            created_at: trace.created_at,
            basis: 'salience_traces counts only — no signal statement is projected here',
          }
        : null,
      tokens: {
        spent_this_cycle: cycle.budget?.tokens_spent_this_cycle ?? null,
        window_ms: cycle.budget?.window_ms ?? null,
        max_tokens: cycle.budget?.max_tokens ?? null,
        tokens_in_window_before: cycle.budget?.tokens_in_window_before ?? null,
        tokens_in_window_after: cycle.budget?.tokens_in_window_after ?? null,
        basis: 'measured tokens from the usage ledger, recorded by the cycle as its window delta (llm-usage-ledger snapshot delta)',
      },
      privacy: privacyIndicator({
        privateRows: seeds.length + 1,
        sharedRows: 0,
        basis:
          'imagination_cycles + idea_seeds, both personal kinds; the seed projection carries ids, bins and scores only — no hypothesis, mechanism or evidence text',
      }),
      basis:
        'imagination_cycles (cycle row, conditions, stop conditions, budget) + idea_seeds (generated/admitted/rejected) + salience_traces (calibration and evidence COUNTS)',
    });
  });

  // ── Traces (own only): signals + calibration + evidence counts ───────────
  router.get('/traces', async (c) => {
    const d = db();
    const caller = getCaller();
    if (!focusedImaginationEnabled()) {
      return c.json(flagOff(IMAGINATION_FLAG, FLAG_OFF_REASON, { traces: [] }));
    }
    const filter = identityFilter(caller, c.req.query('user_id'));
    const missionId = nonEmpty(c.req.query('mission_id'));
    const traces = (await d
      .collection(FOCUSED_CONSOLIDATION_COLLECTIONS.salienceTraces)
      .find({ ...filter, ...(missionId ? { mission_id: missionId } : {}) }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(MAX_ROWS)
      .toArray()) as Array<Record<string, any>>;
    return c.json({
      plane: 'on',
      identity: scopedIdentity(caller, c.req.query('user_id')) ?? 'all',
      traces: traces.map((trace) => ({
        trace_id: trace.trace_id,
        user_id: trace.user_id,
        mission_id: trace.mission_id,
        mission_version: trace.mission_version,
        cycle_id: trace.cycle_id,
        trigger: trace.trigger,
        problem_state_digest: trace.problem_state_digest,
        created_at: trace.created_at,
        // Signal SHAPES and calibration numbers — never `statement` or
        // `why_operationally_relevant`, which are private text.
        signals: (trace.signals ?? []).map((signal: any, index: number) => ({
          index,
          kind: signal.kind,
          intensity: signal.intensity,
          confidence: signal.confidence,
          valence: signal.valence,
          low_confidence: Boolean(signal.low_confidence),
          unresolved_evidence: Boolean(signal.unresolved_evidence),
          evidence_ref_count: Array.isArray(signal.evidence_refs) ? signal.evidence_refs.length : 0,
        })),
        calibration: trace.calibration ?? null,
        evidence: {
          total_refs: trace.evidence?.total_refs ?? null,
          resolved_refs: trace.evidence?.resolved_refs ?? null,
          unresolved_ref_count: trace.evidence?.unresolved_ref_count ?? null,
          unresolved_evidence_count: trace.evidence?.unresolved_evidence_count ?? null,
          resolvable_collections: trace.evidence?.resolvable_collections ?? [],
        },
        // `input_counts` is deliberately NOT projected: it names the private
        // stores the run read (journal_count, reflection_node_count). The counts
        // are no content, but the view's job is signals, calibration and
        // evidence counts — so it carries neither.
        privacy: trace.privacy ?? { raw_reflections_included: false, shared: false },
      })),
      caller_pinned: !caller.trusted,
      privacy: privacyIndicator({
        privateRows: traces.length,
        sharedRows: 0,
        basis:
          'salience_traces is a personal kind (written without a shared_id): an untrusted caller is pinned to its own identity and a non-owner sees no row at all. Signal TEXT is never projected — only kind, calibration numbers and evidence counts',
      }),
      reason:
        traces.length === 0
          ? 'no salience trace is visible to this caller for this query — empty because none was recorded (or it belongs to another identity)'
          : null,
    });
  });

  // ── Archive: coverage + sanitised incumbents ─────────────────────────────
  router.get('/archive', async (c) => {
    const d = db();
    const caller = getCaller();
    if (!focusedImaginationEnabled()) {
      return c.json(flagOff(IMAGINATION_FLAG, FLAG_OFF_REASON, { coverage: null, incumbents: [] }));
    }
    const missionId = nonEmpty(c.req.query('mission_id'));
    const userId = scopedIdentity(caller, c.req.query('user_id')) ?? caller.user_id;
    if (!missionId) {
      return c.json({
        plane: 'on',
        coverage: null,
        incumbents: [],
        reason:
          'mission_id is required: the archive is mission-scoped, so there is no cross-mission coverage to show (empty with stated reason)',
      });
    }
    const archive = new IdeaArchiveService(d);
    const coverage = await archive.coverage(missionId, userId);
    const incumbents = await archive.listIncumbents(missionId, userId, 100);
    return c.json({
      plane: 'on',
      identity: userId,
      mission_id: missionId,
      coverage,
      incumbents: incumbents.map((cell: Record<string, any>) => ({
        cell_key: cell.cell_key,
        bins: cell.bins,
        quality: cell.quality,
        seed_count: cell.seed_count,
        incumbent_seed_id: cell.incumbent_seed_id,
        created_cycle_id: cell.created_cycle_id,
        last_cycle_id: cell.last_cycle_id,
        history_count: cell.history_count ?? 0,
      })),
      privacy: privacyIndicator({
        privateRows: incumbents.length + (coverage?.cells_total ?? 0),
        sharedRows: 0,
        basis:
          'idea_archive_cells is identity-owned and mission-indexed (never shared); the coverage view carries bins, counts, quality and ids ONLY — never a seed statement',
      }),
      basis: `idea_archive_cells read via IdeaArchiveService.coverage/listIncumbents; the coverage view reports its own scan bounds (cells_limit ${coverage.scan?.cells_limit}, seeds_dedupe_limit ${coverage.scan?.seeds_dedupe_limit}, truncated ${coverage.scan?.truncated})`,
      reason:
        coverage.cells_total === 0
          ? 'the archive holds no cell for this identity and mission — empty because nothing has been admitted yet'
          : null,
    });
  });

  // ── Batons + the promotion audit (sanitised) ─────────────────────────────
  router.get('/batons', async (c) => {
    const d = db();
    const caller = getCaller();
    if (!focusedImaginationEnabled()) {
      return c.json(
        flagOff(IMAGINATION_FLAG, FLAG_OFF_REASON, { batons: [], refusals: [], promotions: [], promotion_flag: false }),
      );
    }
    const missionId = nonEmpty(c.req.query('mission_id'));
    const rows = (await d
      .collection(CREATIVE_BATON_COLLECTIONS.creativeBatons)
      .find({ ...(missionId ? { mission_id: missionId } : {}) }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(MAX_ROWS)
      .toArray()) as Array<Record<string, any>>;

    const batons: Array<Record<string, any>> = [];
    const refusals: Array<Record<string, any>> = [];
    for (const row of rows) {
      // A baton the caller may not see is skipped SILENTLY: an untrusted caller
      // must not learn that another identity's private baton exists.
      if (!batonVisibleTo(row as never, caller)) continue;
      const integrity = verifyStoredBaton(row);
      if (!integrity.ok) {
        // The refusal is reported BY NAME (the code), and its free-text reason
        // only to the row's own identity or a trusted caller: a verifier's
        // message can name the field it rejected, which is a field of a row a
        // non-owner may not read.
        const mayReadReason = caller.trusted || row.user_id === caller.user_id;
        refusals.push({
          baton_id: row.baton_id,
          code: integrity.code,
          reason: mayReadReason ? integrity.reason : 'refused by the integrity check (reason withheld from a non-owner read)',
        });
        continue;
      }
      batons.push(batonJson(row));
    }
    const batonIds = batons.map((baton) => baton.baton_id);
    const promotions = (await d
      .collection(CREATIVE_BATON_COLLECTIONS.batonPromotions)
      .find(
        { ...(missionId ? { mission_id: missionId } : {}), ...(batonIds.length > 0 ? { baton_id: { $in: batonIds } } : {}) },
        { projection: { _id: 0 } },
      )
      .sort({ promoted_at: -1 })
      .limit(MAX_ROWS)
      .toArray()) as Array<Record<string, any>>;
    const visiblePromotions = promotions.filter((row) => caller.trusted || batonIds.includes(row.baton_id));
    const shared = batons.filter((baton) => baton.scope === 'shared').length;
    return c.json({
      plane: 'on',
      promotion_flag: creativeBatonPromotionEnabled(),
      batons,
      refusals,
      promotions: visiblePromotions.map((row) => ({
        promotion_id: row.promotion_id,
        baton_id: row.baton_id,
        mission_id: row.mission_id ?? null,
        promoted_by: row.promoted_by,
        promoted_at: row.promoted_at,
        schema_version: row.schema_version ?? null,
        payload_hash: row.payload_hash,
      })),
      privacy: privacyIndicator({
        privateRows: batons.length - shared,
        sharedRows: shared,
        basis:
          'creative_batons is the ONE shareable artefact of this feature: the compiled packet is built from an allow-list (candidate hypothesis/mechanism/bins/scores, attention cues DERIVED from signal kinds, exclusion FINGERPRINTS) and the compiler writes it privately; only a gated promotion stamps a shared_id. A baton the caller may not see is skipped silently',
      }),
      basis:
        'creative_batons + creative_baton_promotions, read back through verifyStoredBaton (version + closed schema + secret scan + payload hash): a tampered row is refused BY NAME rather than rendered',
      reason:
        batons.length === 0 && refusals.length === 0
          ? 'no baton is visible to this caller — empty because none was compiled (or the visible ones belong to another identity)'
          : null,
    });
  });

  // ── Team: modes, envelopes, allocation reports ───────────────────────────
  router.get('/team', async (c) => {
    const d = db();
    const caller = getCaller();
    if (!cognitiveTeamAllocationEnabled()) {
      return c.json(
        flagOff(TEAM_FLAG, TEAM_FLAG_OFF_REASON, { modes: [], envelopes: [], allocations: [], first_pass: [], synthesis: [] }),
      );
    }
    const userId = scopedIdentity(caller, c.req.query('user_id')) ?? caller.user_id;
    const missionId = nonEmpty(c.req.query('mission_id'));
    const missionScope = missionId ? { mission_id: missionId } : {};

    const assignments = (await d
      .collection(COGNITIVE_TEAM_COLLECTIONS.modeAssignments)
      .find({ user_id: userId, ...missionScope }, { projection: { _id: 0 } })
      .sort({ started_at: -1 })
      .limit(MAX_ROWS)
      .toArray()) as Array<Record<string, any>>;
    const envelopeRows = (await d
      .collection(COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes)
      .find({ parent_identity_id: userId, ...missionScope }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(MAX_ROWS)
      .toArray()) as Array<Record<string, any>>;
    const portfolios = (await d
      .collection(COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios)
      .find({ user_id: userId, ...missionScope }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(MAX_ROWS)
      .toArray()) as Array<Record<string, any>>;

    const modes = assignments.map((row) => {
      const integrity = verifyAssignment(row);
      return {
        assignment_id: row.assignment_id,
        mission_id: row.mission_id,
        mode: row.mode,
        status: row.status,
        started_at: row.started_at,
        expires_at: row.expires_at,
        reason: row.reason,
        mode_policy_version: row.mode_policy_version ?? null,
        inheritance_policy: row.inheritance_policy ?? null,
        parent_disposition_version: row.parent_disposition_version ?? null,
        reset_behaviour: row.reset_behaviour ?? null,
        verified: integrity.ok,
        refusal: integrity.ok ? null : { code: integrity.code, reason: integrity.reason },
      };
    });
    const envelopes = envelopeRows.map((row) => {
      const violation = invariantViolation(row);
      const integrity = violation ? null : verifyEnvelope(row);
      return {
        envelope_id: row.envelope_id,
        mission_id: row.mission_id,
        child_label: row.child_label ?? null,
        mode: row.mode ?? null,
        disposition_profile: row.disposition_snapshot?.profile ?? null,
        disposition_version: row.disposition_snapshot?.version ?? null,
        disposition_hash: row.disposition_snapshot?.hash ?? null,
        allowed_dimensions: row.allowed_dimensions ?? [],
        bounds: row.bounds ?? null,
        effective_scoring: row.effective_scoring ?? null,
        mutations: Array.isArray(row.mutations) ? row.mutations.length : 0,
        parent_envelope_id: row.parent_envelope_id ?? null,
        expires_at: row.expires_at ?? null,
        created_at: row.created_at ?? null,
        verified: violation === null && Boolean(integrity?.ok),
        refusal: violation ? { code: 'invariant_violation', reason: violation } : integrity && !integrity.ok ? { code: integrity.code, reason: integrity.reason } : null,
      };
    });
    const value = (kind: string) => portfolios.filter((row) => row.kind === kind);
    const allocationJson = (row: Record<string, any>) => ({
      portfolio_id: row.portfolio_id,
      mission_id: row.mission_id,
      created_at: row.created_at,
      cycle_id: row.cycle_id ?? null,
      allocation_report: row.allocation_report ?? null,
      agents: row.agents ?? [],
      verifier_reservation: row.verifier_reservation ?? null,
      policy_hash: row.policy_hash ?? null,
      counts: row.counts ?? null,
      privacy: row.privacy ?? null,
    });
    return c.json({
      plane: 'on',
      identity: userId,
      modes,
      envelopes,
      allocations: value('allocation').map(allocationJson),
      first_pass: value('first_pass').map((row) => ({
        portfolio_id: row.portfolio_id,
        pass_id: row.pass_id ?? null,
        mission_id: row.mission_id,
        status: row.status,
        counts: row.counts ?? null,
        created_at: row.created_at,
        agents: (row.results ?? []).map((result: any) => ({
          identity: result.identity,
          mode: result.mode,
          status: result.status,
          seeds_admitted: result.seeds_admitted ?? 0,
          seeds_rejected: result.seeds_rejected ?? 0,
          llm_calls: result.llm_calls ?? 0,
          error: result.error ?? null,
        })),
        // The per-agent portfolios carry seed TEXT for their own identity; this
        // view reports the shape (counts, modes, statuses) and leaves the text
        // in its private store.
        basis: 'cognitive_portfolios kind first_pass — per-agent counts and statuses only, no seed text',
      })),
      synthesis: value('synthesis').map((row) => ({
        portfolio_id: row.portfolio_id,
        mission_id: row.mission_id,
        status: row.status ?? null,
        counts: row.counts ?? null,
        promoted: row.promoted ?? false,
        created_at: row.created_at,
        provenance: (row.candidates ?? []).map((candidate: any) => ({
          seed_id: candidate.seed_id,
          agent: candidate.agent ?? null,
          mode: candidate.mode ?? null,
        })),
        exclusions: (row.exclusions ?? []).map((exclusion: any) => ({
          ref: exclusion.ref,
          kind: exclusion.kind,
          reason: exclusion.reason,
          text_hash: exclusion.text_hash,
        })),
        basis: 'cognitive_portfolios kind synthesis — per-candidate provenance and exclusion FINGERPRINTS (ref/kind/reason/text_hash), never the ruled-out text',
      })),
      privacy: privacyIndicator({
        privateRows: assignments.length + envelopeRows.length + portfolios.length,
        sharedRows: 0,
        basis:
          'thinking_mode_assignments, inheritance_envelopes and cognitive_portfolios are all personal kinds: no row of theirs can carry a shared_id, and an envelope carries no private memory (it is an immutable reference to a disposition snapshot)',
      }),
      basis:
        'thinking_mode_assignments (re-verified), inheritance_envelopes (invariant re-check + verifier), cognitive_portfolios (allocation report, first-pass counts, synthesis provenance) — all read from stored records',
      reason:
        assignments.length + envelopeRows.length + portfolios.length === 0
          ? 'no mode, envelope or portfolio is recorded for this identity — empty because the team has not been assembled yet'
          : null,
    });
  });

  // ── Metrics: the §7.3 set, each with its basis ───────────────────────────
  router.get('/metrics', async (c) => {
    const d = db();
    const caller = getCaller();
    if (!focusedImaginationEnabled()) {
      return c.json(flagOff(IMAGINATION_FLAG, FLAG_OFF_REASON, { metrics: null }));
    }
    const userId = scopedIdentity(caller, c.req.query('user_id')) ?? caller.user_id;
    const missionId = nonEmpty(c.req.query('mission_id'));
    const requestedDays = Number(c.req.query('window_days'));
    const metrics = await computeImaginationMetrics(d, {
      userId,
      missionId,
      ...(Number.isFinite(requestedDays) && requestedDays > 0 ? { windowDays: requestedDays } : {}),
    });
    return c.json({
      plane: 'on',
      identity: userId,
      window_days: metricsWindowDays(),
      minimums: {
        outcomes: MIN_OUTCOME_SAMPLES,
        generated: MIN_GENERATED_SAMPLES,
        cycles: MIN_CYCLE_SAMPLES,
        agents: MIN_DIVERGENCE_AGENTS,
      },
      metrics,
      privacy: metrics.privacy,
      comparison: metrics.window_comparison,
      basis:
        'computed read-only from stored rows for ONE identity; every metric inside carries its own basis (window, n, sources) and reports insufficient_data below its documented minimum, and `comparison` states the window-over-window verdict with its n and its threshold',
      reason:
        metrics.useful_novelty_rate.status === 'insufficient_data' &&
        metrics.false_novelty.status === 'insufficient_data' &&
        metrics.cost_of_novelty.status === 'insufficient_data'
          ? 'the window holds too few samples for the rate metrics — the metrics view states insufficient_data rather than fabricating a rate'
          : null,
    });
  });

  // ── Experiments: records + the comparison ────────────────────────────────
  router.get('/experiments', async (c) => {
    const d = db();
    const caller = getCaller();
    if (!focusedImaginationEnabled()) {
      return c.json(flagOff(IMAGINATION_FLAG, FLAG_OFF_REASON, { experiments: [] }));
    }
    const userId = scopedIdentity(caller, c.req.query('user_id')) ?? caller.user_id;
    const experiments = await listExperiments(d, userId);
    const withObservations = [];
    for (const experiment of experiments) {
      const observations = await listObservations(d, userId, experiment.experiment_id);
      withObservations.push({
        ...experiment,
        observations: observations.length,
        metrics_recorded: [...new Set(observations.map((row) => row.metric))].sort(),
        checkpoints_observed: [...new Set(observations.map((row) => row.checkpoint))].sort(),
        latest_at: observations.length > 0 ? observations[observations.length - 1].updated_at : null,
      });
    }
    return c.json({
      plane: 'on',
      identity: userId,
      write_enabled: focusedImaginationEnabled(),
      write_path: `/api/v1/imagination${OBSERVATION_WRITE_PATH} (trusted callers only, idempotent per {experiment, arm, metric, checkpoint})`,
      experiments: withObservations,
      privacy: privacyIndicator({
        privateRows: withObservations.length,
        sharedRows: 0,
        basis:
          'imagination_experiments rows for this identity only (the experiment and its observations); the collection is written without a shared_id and carries no journal or reflection material',
      }),
      basis: 'imagination_experiments, kind=experiment, plus the observation count per experiment for this identity',
      reason:
        withObservations.length === 0
          ? 'no experiment is registered for this identity — empty because none was registered yet (the gated write can register one)'
          : null,
    });
  });

  // The explicit compare route sits before the parameterised one so
  // /experiments/compare is never read as an experiment id.
  router.get('/experiments/compare', async (c) => compareHandler(c));
  router.get('/experiments/:experimentId/compare', async (c) => compareHandler(c, c.req.param('experimentId')));

  async function compareHandler(c: any, pathExperimentId?: string) {
    const d = db();
    const caller = getCaller();
    if (!focusedImaginationEnabled()) {
      return c.json(flagOff(IMAGINATION_FLAG, FLAG_OFF_REASON, { comparison: null }));
    }
    const userId = scopedIdentity(caller, c.req.query('user_id')) ?? caller.user_id;
    const experimentId = nonEmpty(pathExperimentId) ?? nonEmpty(c.req.query('experiment_id'));
    if (!experimentId) {
      return c.json({ plane: 'on', comparison: null, reason: 'experiment_id is required for a comparison' }, 400);
    }
    // `baseline=A,B` pools several control arms (the brief's §7.4 A/B vs C/D).
    const arms = (value: unknown) =>
      String(value ?? '')
        .split(',')
        .map((arm) => nonEmpty(arm))
        .filter((arm): arm is string => arm !== null);
    const baselineQuery = arms(c.req.query('baseline'));
    const treatmentQuery = arms(c.req.query('treatment'));
    const comparison = await compareExperiment(d, userId, experimentId, {
      ...(baselineQuery.length > 0 ? { baselineArms: baselineQuery } : {}),
      ...(treatmentQuery.length > 0 ? { treatmentArms: treatmentQuery } : {}),
    });
    if (!comparison) {
      return c.json({ plane: 'on', comparison: null, reason: `no experiment ${experimentId} is registered for this caller` }, 404);
    }
    return c.json({
      plane: 'on',
      identity: userId,
      comparison,
      basis: comparison.basis,
      privacy: comparison.privacy,
    });
  }

  // ── The ONE write: an experiment observation ─────────────────────────────
  router.post(OBSERVATION_WRITE_PATH, async (c) => {
    const d = db();
    const caller = getCaller();
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await recordExperimentObservation(d, body as never, caller);
    if (!result.recorded) {
      const status = result.code === 'flag_off' || result.code === 'untrusted_caller' ? 403 : 400;
      return c.json({ ...result, error: result.reason }, status as 400 | 403);
    }
    // The write is audited like the custodian control: the operator can see the
    // call, its outcome and what it touched.
    await d.collection('custodian_audit').insertOne({
      audit_id: randomUUID(),
      actor_id: caller.user_id,
      action: 'experiment_observation',
      mission_id: null,
      created_at: new Date().toISOString(),
      detail: {
        outcome: result.unchanged ? 'unchanged' : result.updated ? 'updated' : 'recorded',
        experiment_id: result.experiment_id,
        observation_key: result.observation?.observation_key ?? null,
        arm: result.observation?.arm ?? null,
        metric: result.observation?.metric ?? null,
        checkpoint: result.observation?.checkpoint ?? null,
      },
    });
    return c.json({
      ...result,
      basis:
        'imagination_experiments, written through the one gated path: trusted caller + FOCUSED_IMAGINATION, caller-owned user_id, closed shape, idempotent per {experiment, arm, metric, checkpoint}',
    });
  });

  // ── Rollout: flag and kill-switch state read from THIS process ───────────
  // Always reachable (like /status): the operator has to be able to see that a
  // stage is off. Every value is derived from the environment the running
  // process actually reads — no hardcoded claim about what is enabled.
  router.get('/rollout', async (c) => {
    const flags = [
      {
        name: 'PER_IDENTITY_PERSONALITY',
        env_var: 'PER_IDENTITY_PERSONALITY',
        stage: 'per-identity personality',
        on: perIdentityPersonalityEnabled(),
      },
      {
        name: 'FOCUSED_IMAGINATION',
        env_var: 'FOCUSED_IMAGINATION',
        stage: 'focused imagination',
        on: focusedImaginationEnabled(),
      },
      {
        name: 'CREATIVE_BATON_PROMOTION',
        env_var: 'CREATIVE_BATON_PROMOTION',
        stage: 'baton promotion',
        on: creativeBatonPromotionEnabled(),
      },
      {
        name: 'COGNITIVE_TEAM_ALLOCATION',
        env_var: 'COGNITIVE_TEAM_ALLOCATION',
        stage: 'cognitive team',
        on: cognitiveTeamAllocationEnabled(),
      },
    ];
    const killSwitches = [
      {
        name: 'COGNITIVE_ACTIVATION_KILL_SWITCH',
        env_var: 'COGNITIVE_ACTIVATION_KILL_SWITCH',
        armed: killSwitchActive(),
        forces: 'COGNITIVE_SCHEDULER_MODE -> off (every other cognitive flag is overridden)',
      },
      {
        name: 'COGNITIVE_CONTROL_ENABLED',
        env_var: 'COGNITIVE_CONTROL_ENABLED',
        armed: cognitiveControlMode() === 'off',
        forces: 'the Phase 7 cognitive-control plane and its views read as off',
      },
    ];
    // The stage gates are POLICY (documented in docs/IMAGINATION-ROLLOUT.md);
    // the state beside each one is MEASURED here.
    const stages = [
      {
        stage: 'per-identity personality',
        flag: 'PER_IDENTITY_PERSONALITY',
        gates: ['get_my_personality resolves per identity', 'no cross-identity personality read'],
        watched: ['personality_stability.violations', 'inheritance envelope refusals'],
      },
      {
        stage: 'focused imagination (private)',
        flag: 'FOCUSED_IMAGINATION',
        gates: ['useful_novelty_rate.status = ok', 'false_novelty.rate below the recorded baseline'],
        watched: ['useful_novelty_rate', 'false_novelty', 'cost_of_novelty', 'time_to_next_viable_direction'],
      },
      {
        stage: 'baton promotion (shared)',
        flag: 'CREATIVE_BATON_PROMOTION',
        gates: ['privacy_leakage.flagged = 0 across the shared artefacts', 'no refusal other than flag_off'],
        watched: ['privacy_leakage', 'idea_survival', 'archive_coverage_gain'],
      },
      {
        stage: 'cognitive team allocation',
        flag: 'COGNITIVE_TEAM_ALLOCATION',
        gates: ['agent_divergence above the same-mode control', 'personality_stability.violations = 0'],
        watched: ['agent_divergence vs agent_divergence_same_mode_control', 'personality_stability'],
      },
    ];
    const stateFor = (flag: string) => flags.find((entry) => entry.name === flag)?.on ?? false;
    return c.json({
      plane: cognitiveControlMode(),
      scheduler_mode: schedulerMode(),
      kill_switch_active: killSwitchActive(),
      flags,
      kill_switches: killSwitches,
      stages: stages.map((stage) => ({
        ...stage,
        flag_on: stateFor(stage.flag),
        // A stage is "reachable" when its own flag is on; the metrics gates are
        // read from the metrics view, not invented here.
        state: stateFor(stage.flag) ? 'on' : 'off',
      })),
      rollback: {
        doc: 'docs/IMAGINATION-ROLLOUT.md',
        kill_switch_command:
          "echo 'COGNITIVE_ACTIVATION_KILL_SWITCH=1' >> .env && docker compose up -d --force-recreate --wait server",
        flag_off_command:
          "sed -i.bak 's/^FOCUSED_IMAGINATION=.*/FOCUSED_IMAGINATION=/' .env && docker compose up -d --force-recreate --wait server",
        code_rollback_command: 'git revert --no-edit <ITER-9 commit> && docker compose up -d --build --wait server',
        note: 'the imagination views are read-only, so disabling the flags removes the surface without touching stored data; imagination_experiments is additive and droppable',
      },
      basis:
        'read at request time from the very functions the deployment uses (perIdentityPersonalityEnabled, focusedImaginationEnabled, creativeBatonPromotionEnabled, cognitiveTeamAllocationEnabled, killSwitchActive, cognitiveControlMode, schedulerMode) — never from constants',
    });
  });

  return router;
};
