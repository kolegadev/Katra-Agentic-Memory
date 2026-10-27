/**
 * Independent first pass + synthesis (ITER-8, Phase 6).
 *
 * Contract: CONTRACT-iter8-cognitive-team.md §D. Two roles, one property: no
 * agent sees a peer's ideas while it generates, and whoever merges the result
 * cannot launder what it merges.
 *
 * PLAN — `planFirstPass` turns an allocated team into per-agent GENERATION
 * REQUESTS. A request carries ONLY (contract §D.1): the mission digest (ids,
 * version, title, intent, the trace's problem-state digest and a trace SUMMARY
 * of signal SHAPES, the coverage gaps and the mission's exclusions as
 * FINGERPRINTS), the agent's OWN envelope and mode definition, and the engine
 * settings derived from them. No peer seeds, no peer identities, no peer
 * envelope, and no private memory of any kind: an exclusion is a
 * `{ref, kind, reason, text_hash}` fingerprint and a trace signal is a
 * `{signal_id, kind, intensity, confidence, valence}` shape, never its
 * statement. A request for an agent with no trace, or with an envelope that is
 * missing, expired, tampered with or granted for a different mode, is stored
 * `blocked` with the named reason — never silently generated anyway.
 *
 * RUN — `runFirstPass` executes each ready request through ITER-6's engine
 * (`ImaginationService.run`), which reads the agent's OWN Salience Trace and its
 * OWN archive (both are keyed by `{user_id, mission_id}`, so the isolation is
 * structural, not a filter that could be forgotten). ITER-6 is not
 * reimplemented: the engine, the archive, the operator plan, the dedupe rules
 * and the changed-premise gate are all its own.
 *
 * THE STREAM IS A FUNCTION OF THE MODE. Each agent's generation seed is derived
 * from the pass, the agent's MODE and the envelope's effective scoring — never
 * from the identity's private state (which would make "different modes" and
 * "different identities" indistinguishable when measuring divergence) and never
 * from a peer's content. Two agents holding the same mode therefore derive the
 * SAME stream and, over the same frozen fixture, produce the same portfolio:
 * that is the same-mode control the exit criterion measures against, and it is
 * exactly the convergence the brief's risk table calls "identity collapse across
 * team".
 *
 * SYNTHESIS — `synthesizePortfolios` merges portfolios with their provenance
 * intact: a candidate that several agents produced keeps EVERY source in its
 * `provenance` list (the merge collapses the statement, never the lineage), the
 * exclusions are carried VERBATIM as fingerprints, and an attempt to drop or
 * rewrite one is REFUSED BY NAME (`exclusion_dropped` / `exclusion_rewritten`).
 * A synthesizer cannot ADD one either: an exclusion it supplies that is not on
 * record is IGNORED — it is reported back as `ignored_exclusions` and never
 * reaches the artifact — because an exclusion is the mission's record of what it
 * ruled out, and a merge preserves that record, it does not extend it. The
 * merged artifact appends a `synthesis` lineage record to its own lineage chain.
 * IT CANNOT PROMOTE: the artifact is a private personal-kind row, it carries
 * `promoted: false` and `privacy.shared: false`, and this module has no
 * promotion path — Phase 5 owns promotion.
 */
import type { Db } from 'mongodb';
import type { CallerIdentity } from '../../utils/caller-identity.js';
import { MissionStateService } from '../mission-cognition/mission-state-service.js';
import {
  COGNITIVE_TEAM_COLLECTIONS,
  ensureCognitiveTeamIndexes,
} from './cognitive-team-collections.js';
import { derivedId, hashSeed, sha256Hex, stableStringify } from './imagination-operators.js';
import { COGNITIVE_MODES, isCognitiveMode, modeBinLabels, type CognitiveMode, type EngineMode } from './cognitive-mode-service.js';
import { isExpired } from './cognitive-mode-service.js';
import { readEnvelope, type InheritanceEnvelope } from './inheritance-envelope.js';
import {
  ImaginationService,
  buildImaginationInputs,
  type IdeaSeed,
  type ImaginationResult,
} from './imagination-service.js';
import { IdeaArchiveService, type ExclusionRegion } from './idea-archive-service.js';
import { FocusedConsolidationService } from './focused-consolidation-service.js';
import {
  CognitiveAllocationError,
  getPortfolio,
  portfolioPolicyHash,
  storePortfolio,
  verifyPortfolio,
  type CognitivePortfolio,
} from './cognitive-allocation-service.js';

export class FirstPassError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'FirstPassError';
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.trim() : null;
}

function textHash(text: unknown): string {
  return sha256Hex(String(text ?? '')).slice(0, 16);
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/** One exclusion, as a FINGERPRINT: never the ruled-out text itself. */
export interface PortfolioExclusion {
  /** The id it is anchored to: a ledger entry id, a trace signal id or a seed id. */
  ref: string;
  kind: 'rejected_hypothesis' | 'excluded_region' | 'rejected_seed';
  /** Why it is ruled out — carried verbatim through every synthesis. */
  reason: string;
  /** sha256 prefix of the ruled-out text; the text never leaves its own store. */
  text_hash: string;
}

export interface FirstPassTeamMember {
  identity: string;
  mode: CognitiveMode | string;
  /** The envelope the parent granted this agent (verified before use). */
  envelope_id?: string | null;
  /** The contract's spelling of the same field (`planFirstPass` accepts both). */
  envelopeId?: string | null;
}

export interface FirstPassEnvelopeDigest {
  envelope_id: string;
  child_label: string;
  disposition_profile: string;
  disposition_version: number;
  disposition_hash: string;
  effective_scoring: InheritanceEnvelope['effective_scoring'];
  allowed_dimensions: string[];
  bounds: InheritanceEnvelope['bounds'];
  expires_at: string;
}

export interface TraceShape {
  signal_id: string;
  kind: string;
  intensity: number;
  confidence: number;
  valence: number;
  low_confidence: boolean;
}

export interface FirstPassRequest {
  schema_version: '1.0';
  request_id: string;
  pass_id: string;
  status: 'ready' | 'blocked';
  /** Why the request cannot run, by name (null when ready). */
  blocked_reason: string | null;
  agent: { identity: string; mode: string; mode_label: string; envelope_id: string | null };
  /** The agent's OWN mode definition — the Appendix C entry, verbatim. */
  mode_definition: {
    mode: string;
    attention_bias: string;
    obligation: string;
    approved_dimensions: string[];
    attention_bins: string[];
    engine_mode: EngineMode;
    operator_budget: number;
    reset_behaviour: string;
  };
  /** The agent's OWN envelope digest (null when none was granted). */
  envelope: FirstPassEnvelopeDigest | null;
  /** The public context: ids, versions, shapes and fingerprints — no private text. */
  mission_digest: {
    mission_id: string;
    mission_version: number;
    title: string;
    intent: string;
    trace_id: string | null;
    problem_state_digest: string | null;
    trace_summary: TraceShape[];
    coverage_gaps: Array<{ dimension: string; unoccupied_bins: string[] }>;
    coverage_cells_total: number;
    exclusions: PortfolioExclusion[];
  };
  engine: {
    mode: EngineMode;
    /** Derived from the pass, the mode and the envelope scoring — never a peer. */
    seed: string;
    cycle_id: string;
    /** The run hint recorded on the engine's own ledger row. */
    disposition: string;
  };
}

export interface FirstPassSeedSummary {
  seed_id: string;
  operator: string;
  hypothesis: string;
  mechanism: string;
  descriptor_bins: string[];
  cell_key: string;
  novelty_score: number;
  coherence_score: number;
  testability_score: number;
  expected_information_gain: number;
  quality: number;
  cheapest_test: string;
  lineage_ref: string;
}

export interface FirstPassAgentResult {
  identity: string;
  mode: string;
  engine_mode: EngineMode;
  status: 'completed' | 'failed' | 'reused' | 'blocked';
  cycle_id: string | null;
  run_id: string | null;
  trace_id: string | null;
  problem_state_digest: string | null;
  /** The agent's OWN portfolio — every admitted seed, with its text. */
  seeds: FirstPassSeedSummary[];
  rejections: Array<{ seed_id: string; reason: string; detail: string | null }>;
  exclusions: PortfolioExclusion[];
  seeds_generated: number;
  seeds_admitted: number;
  seeds_rejected: number;
  llm_calls: number;
  error: string | null;
  blocked_reason: string | null;
}

export interface FirstPassRecord {
  schema_version: '1.0';
  portfolio_id: string;
  kind: 'first_pass';
  pass_id: string;
  user_id: string;
  mission_id: string;
  team: Array<{ identity: string; mode: string; envelope_id: string | null }>;
  requests: FirstPassRequest[];
  results: FirstPassAgentResult[];
  status: 'planned' | 'ran';
  counts: {
    agents: number;
    ready: number;
    blocked: number;
    generated: number;
    seeds: number;
  };
  privacy: { private_content_included: false; shared: false };
  policy_hash: string;
  created_at: string;
}

// ── Exclusions as fingerprints ──────────────────────────────────────────────

function fingerprint(region: ExclusionRegion): PortfolioExclusion {
  return {
    ref: String(region.ref),
    kind: region.kind,
    reason:
      region.kind === 'rejected_hypothesis'
        ? 'a hypothesis this mission already ruled out'
        : 'a salience signal below the confidence floor: treated as a ruled-out region',
    text_hash: textHash(region.text),
  };
}

function mergeExclusions(...lists: ReadonlyArray<readonly PortfolioExclusion[]>): PortfolioExclusion[] {
  const byRef = new Map<string, PortfolioExclusion>();
  for (const list of lists) {
    for (const exclusion of list) {
      const existing = byRef.get(exclusion.ref);
      if (!existing) byRef.set(exclusion.ref, { ...exclusion });
    }
  }
  return [...byRef.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

/** The exclusions the archive holds for an identity + mission, as fingerprints. */
async function archiveExclusions(db: Db, identity: string, missionId: string): Promise<PortfolioExclusion[]> {
  const archive = new IdeaArchiveService(db);
  const regions = await archive.exclusions(identity, missionId);
  const seeds = await archive.getSeeds(identity, missionId);
  const rejected = seeds
    .filter((seed) => seed.state === 'rejected')
    .map<PortfolioExclusion>((seed) => ({
      ref: String(seed.seed_id),
      kind: 'rejected_seed',
      reason: String(seed.rejection?.reason ?? 'rejected by the archive'),
      text_hash: textHash(`${seed.hypothesis} ${seed.mechanism}`),
    }));
  return mergeExclusions(regions.map(fingerprint), rejected);
}

// ── Planning ────────────────────────────────────────────────────────────────

export interface PlanFirstPassArgs {
  userId: string;
  missionId: string;
  team: readonly FirstPassTeamMember[];
  /** An explicit window for the pass record (the requests inherit their own). */
  now?: () => string;
  caller?: CallerIdentity;
}

export interface PlanFirstPassResult {
  pass: FirstPassRecord;
  requests: FirstPassRequest[];
  reused: boolean;
}

function firstPassSeed(passId: string, mode: string, envelope: InheritanceEnvelope | null): string {
  const scoring = envelope?.effective_scoring
    ? {
        k: envelope.effective_scoring.relevance_multiplier,
        fetch: envelope.effective_scoring.vector_fetch_limit,
        cap: envelope.effective_scoring.max_single_source_pct,
      }
    : null;
  return `fp_${sha256Hex(stableStringify({ pass_id: passId, mode, scoring })).slice(0, 32)}`;
}

/**
 * Build the per-agent generation requests and store the pass. READ-ONLY with
 * respect to the engine: nothing is generated here (and no model call is made),
 * which is what lets a caller inspect exactly what each agent would be given.
 */
export async function planFirstPass(db: Db, args: PlanFirstPassArgs): Promise<PlanFirstPassResult> {
  const userId = nonEmpty(args.userId);
  const missionId = nonEmpty(args.missionId);
  if (!userId) throw new FirstPassError('userId is required', 'invalid_args');
  if (!missionId) throw new FirstPassError('missionId is required', 'invalid_args');
  if (!Array.isArray(args.team) || args.team.length === 0) {
    throw new FirstPassError('team must be a non-empty list of agents', 'invalid_args');
  }
  if (args.caller && !args.caller.trusted && args.caller.user_id !== userId) {
    throw new FirstPassError(`Caller '${args.caller.user_id}' may not plan a first pass for '${userId}'`, 'forbidden');
  }

  await ensureCognitiveTeamIndexes(db);
  const now = args.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const mission = await new MissionStateService(db).getMissionState(missionId);
  if (!mission) throw new FirstPassError(`mission state not found: ${missionId}`, 'mission_not_found');

  const team = args.team.map((member) => ({
    identity: nonEmpty(member?.identity) ?? '',
    mode: String(member?.mode ?? ''),
    // Both spellings are accepted: the contract writes `envelopeId`, the DTOs
    // this feature persists use `envelope_id`.
    envelope_id: nonEmpty(member?.envelope_id) ?? nonEmpty(member?.envelopeId),
  }));
  for (const member of team) {
    if (!member.identity) throw new FirstPassError('every team member needs an identity', 'invalid_args');
    if (!isCognitiveMode(member.mode)) {
      throw new FirstPassError(`Unknown thinking mode '${member.mode}' for ${member.identity}`, 'unknown_mode');
    }
  }

  const passId = derivedId(
    'cpass',
    {
      mission_id: missionId,
      user_id: userId,
      team: team.map((member) => ({ identity: member.identity, mode: member.mode, envelope_id: member.envelope_id })),
    },
    hashSeed(`first_pass:${userId}:${missionId}`),
  );

  const requests: FirstPassRequest[] = [];
  for (const member of team) {
    const spec = COGNITIVE_MODES[member.mode as CognitiveMode];
    const requestId = derivedId(
      'creq',
      { pass_id: passId, identity: member.identity, mode: member.mode, envelope_id: member.envelope_id },
      hashSeed(`first_pass_request:${passId}`),
    );

    let envelope: InheritanceEnvelope | null = null;
    let blocked: string | null = null;
    if (member.envelope_id) {
      const read = await readEnvelope(db, member.envelope_id, { user_id: userId, trusted: false });
      if (read.refusal) blocked = `envelope_refused:${read.refusal.code}`;
      else if (!read.envelope) blocked = 'envelope_not_found';
      else {
        envelope = read.envelope;
        if (envelope.mission_id !== missionId) blocked = 'envelope_mission_mismatch';
        else if (envelope.mode !== member.mode) blocked = 'envelope_mode_mismatch';
        else if (isExpired({ expires_at: envelope.expires_at, status: 'active' }, Date.parse(createdAt))) {
          blocked = 'envelope_expired';
        }
      }
    }

    const traces = await new FocusedConsolidationService(db).getTraces(member.identity, { missionId, limit: 1 });
    const trace = traces[0] ?? null;
    if (!trace && !blocked) blocked = 'no_salience_trace';

    const coverage = await new IdeaArchiveService(db).coverage(missionId, member.identity);
    const context = trace ? await buildImaginationInputs(db, mission, trace) : null;
    const exclusions = mergeExclusions(
      (context?.exclusions ?? []).map(fingerprint),
      await archiveExclusions(db, member.identity, missionId),
    );

    const traceSummary: TraceShape[] = (trace?.signals ?? []).map((signal, index) => ({
      signal_id: context?.signal_ids[index] ?? '',
      kind: String(signal.kind),
      intensity: Number(signal.intensity),
      confidence: Number(signal.confidence),
      valence: Number(signal.valence),
      low_confidence: signal.low_confidence === true,
    }));

    requests.push({
      schema_version: '1.0',
      request_id: requestId,
      pass_id: passId,
      status: blocked ? 'blocked' : 'ready',
      blocked_reason: blocked,
      agent: {
        identity: member.identity,
        mode: member.mode,
        mode_label: spec.label,
        envelope_id: member.envelope_id,
      },
      mode_definition: {
        mode: spec.mode,
        attention_bias: spec.attention_bias,
        obligation: spec.obligation,
        approved_dimensions: [...spec.approved_dimensions],
        attention_bins: modeBinLabels(spec),
        engine_mode: spec.engine_mode,
        operator_budget: spec.operator_budget,
        reset_behaviour: spec.reset_behaviour,
      },
      envelope: envelope
        ? {
            envelope_id: envelope.envelope_id,
            child_label: envelope.child_label,
            disposition_profile: envelope.disposition_snapshot.profile,
            disposition_version: envelope.disposition_snapshot.version,
            disposition_hash: envelope.disposition_snapshot.hash,
            effective_scoring: envelope.effective_scoring,
            allowed_dimensions: [...envelope.allowed_dimensions],
            bounds: envelope.bounds,
            expires_at: envelope.expires_at,
          }
        : null,
      mission_digest: {
        mission_id: missionId,
        mission_version: Number(mission.version ?? 1),
        title: String(mission.title ?? ''),
        intent: String(mission.intent ?? ''),
        trace_id: trace ? String(trace.trace_id) : null,
        problem_state_digest: trace ? String(trace.problem_state_digest) : null,
        trace_summary: traceSummary,
        coverage_gaps: (coverage.gaps ?? []).map((gap) => ({
          dimension: gap.dimension,
          unoccupied_bins: [...gap.unoccupied_bins],
        })),
        coverage_cells_total: coverage.cells_total,
        exclusions,
      },
      engine: {
        mode: spec.engine_mode,
        seed: firstPassSeed(passId, spec.mode, envelope),
        cycle_id: `${passId}:${spec.mode}`,
        disposition: `mode:${spec.mode} envelope:${member.envelope_id ?? 'none'}`,
      },
    });
  }

  const record: FirstPassRecord = {
    schema_version: '1.0',
    portfolio_id: passId,
    kind: 'first_pass',
    pass_id: passId,
    user_id: userId,
    mission_id: missionId,
    team,
    requests,
    results: [],
    status: 'planned',
    counts: {
      agents: requests.length,
      ready: requests.filter((request) => request.status === 'ready').length,
      blocked: requests.filter((request) => request.status === 'blocked').length,
      generated: 0,
      seeds: 0,
    },
    privacy: { private_content_included: false, shared: false },
    policy_hash: '',
    created_at: createdAt,
  };
  record.policy_hash = portfolioPolicyHash(record as unknown as Record<string, unknown>);
  const stored = await storePortfolio(db, record as unknown as Record<string, any>, userId);
  const canonical = stored.portfolio as unknown as FirstPassRecord;
  return { pass: canonical, requests: canonical.requests ?? requests, reused: stored.reused };
}

// ── Running ─────────────────────────────────────────────────────────────────

export interface RunFirstPassArgs extends PlanFirstPassArgs {
  /** The pass to run; when omitted the pass is planned first. */
  pass?: FirstPassRecord;
}

export interface RunFirstPassResult {
  pass: FirstPassRecord;
  results: FirstPassAgentResult[];
}

function seedSummary(seed: IdeaSeed): FirstPassSeedSummary {
  return {
    seed_id: String(seed.seed_id),
    operator: String(seed.operator),
    hypothesis: String(seed.hypothesis),
    mechanism: String(seed.mechanism),
    descriptor_bins: [...(seed.descriptor_bins ?? [])],
    cell_key: String(seed.cell_key),
    novelty_score: Number(seed.novelty_score),
    coherence_score: Number(seed.coherence_score),
    testability_score: Number(seed.testability_score),
    expected_information_gain: Number(seed.expected_information_gain),
    quality: Number(seed.quality),
    cheapest_test: String(seed.cheapest_test),
    lineage_ref: String(seed.lineage_ref),
  };
}

/**
 * Run one agent's request through ITER-6's engine. The engine reads the agent's
 * OWN trace and archive; the only things this function adds are the mode-derived
 * engine settings the request already carries.
 */
async function runRequest(db: Db, pass: FirstPassRecord, request: FirstPassRequest): Promise<FirstPassAgentResult> {
  const base = {
    identity: request.agent.identity,
    mode: request.agent.mode,
    engine_mode: request.engine.mode,
    cycle_id: request.engine.cycle_id,
    trace_id: request.mission_digest.trace_id,
    problem_state_digest: request.mission_digest.problem_state_digest,
    exclusions: [] as PortfolioExclusion[],
  };
  if (request.status !== 'ready') {
    return {
      ...base,
      status: 'blocked',
      run_id: null,
      seeds: [],
      rejections: [],
      exclusions: await archiveExclusions(db, request.agent.identity, pass.mission_id),
      seeds_generated: 0,
      seeds_admitted: 0,
      seeds_rejected: 0,
      llm_calls: 0,
      error: null,
      blocked_reason: request.blocked_reason,
    };
  }

  const exclusions = mergeExclusions(
    request.mission_digest.exclusions,
    await archiveExclusions(db, request.agent.identity, pass.mission_id),
  );

  let result: ImaginationResult | null = null;
  let error: string | null = null;
  try {
    result = await new ImaginationService(db).run({
      userId: request.agent.identity,
      missionId: pass.mission_id,
      cycleId: request.engine.cycle_id,
      trigger: 'independent_first_pass',
      actorId: request.agent.identity,
      seed: request.engine.seed,
      mode: request.engine.mode,
      disposition: request.engine.disposition,
      // The mode reaches the engine through the two knobs ITER-6 already
      // honours: the plan spread and the operator-family budget of THIS round.
      budget: { max_operators: request.mode_definition.operator_budget },
    });
  } catch (thrown) {
    error = String((thrown as Error)?.message ?? thrown);
  }

  if (!result || result.status === 'failed') {
    return {
      ...base,
      status: 'failed',
      run_id: result?.run_id ?? null,
      seeds: result ? result.seeds.map(seedSummary) : [],
      rejections: (result?.rejections ?? []).map((rejection) => ({
        seed_id: String(rejection.seed_id),
        reason: String(rejection.reason),
        detail: rejection.detail ?? null,
      })),
      exclusions,
      seeds_generated: result?.seeds_generated ?? 0,
      seeds_admitted: result?.seeds_admitted ?? 0,
      seeds_rejected: result?.seeds_rejected ?? 0,
      llm_calls: result?.llm_calls_actual ?? 0,
      error: error ?? result?.error ?? 'the first pass run failed',
      blocked_reason: null,
    };
  }

  return {
    ...base,
    status: result.status === 'completed' ? (result.reused ? 'reused' : 'completed') : 'failed',
    run_id: result.run_id,
    seeds: result.seeds.map(seedSummary),
    rejections: result.rejections.map((rejection) => ({
      seed_id: String(rejection.seed_id),
      reason: String(rejection.reason),
      detail: rejection.detail ?? null,
    })),
    exclusions: mergeExclusions(
      exclusions,
      await archiveExclusions(db, request.agent.identity, pass.mission_id),
    ),
    seeds_generated: result.seeds_generated,
    seeds_admitted: result.seeds_admitted,
    seeds_rejected: result.seeds_rejected,
    llm_calls: result.llm_calls_actual,
    error: null,
    blocked_reason: null,
  };
}

/**
 * Execute every READY request in isolation: one engine run per agent, each one
 * reading only that agent's own trace and archive and writing only that agent's
 * own seeds, lineages, cells and run ledger. Results are recorded on the pass.
 */
export async function runFirstPass(db: Db, args: RunFirstPassArgs): Promise<RunFirstPassResult> {
  const plan = args.pass ?? (await planFirstPass(db, args)).pass;
  const userId = nonEmpty(args.userId) ?? plan.user_id;
  if (args.caller && !args.caller.trusted && args.caller.user_id !== userId) {
    throw new FirstPassError(`Caller '${args.caller.user_id}' may not run a first pass for '${userId}'`, 'forbidden');
  }

  const results: FirstPassAgentResult[] = [];
  for (const request of plan.requests) {
    results.push(await runRequest(db, plan, request));
  }

  const record: FirstPassRecord = {
    ...plan,
    results,
    status: 'ran',
    counts: {
      agents: plan.requests.length,
      ready: plan.requests.filter((request) => request.status === 'ready').length,
      blocked: plan.requests.filter((request) => request.status === 'blocked').length,
      generated: results.filter((result) => result.status === 'completed' || result.status === 'reused').length,
      seeds: results.reduce((total, result) => total + result.seeds.length, 0),
    },
    policy_hash: '',
  };
  record.policy_hash = portfolioPolicyHash(record as unknown as Record<string, unknown>);
  // The results are written onto the SAME pass row: one row per pass, and a
  // re-run of an already-ran pass is idempotent in the engine itself (the
  // cycle key includes the pass), so this update is a restatement, not a second
  // generation.
  const scope = verifyPortfolio(record as unknown as Record<string, unknown>);
  if (!scope.ok) throw new FirstPassError(scope.reason, scope.code!);
  await db
    .collection(COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios)
    .updateOne(
      { portfolio_id: record.portfolio_id },
      { $set: { results: record.results, status: record.status, counts: record.counts, policy_hash: record.policy_hash } },
    );
  return { pass: record, results };
}

/** Read a stored first pass (verified). */
export async function readFirstPass(db: Db, passId: string): Promise<FirstPassRecord | null> {
  const row = await getPortfolio(db, passId);
  return (row as unknown as FirstPassRecord | null) ?? null;
}

// ── Synthesis ───────────────────────────────────────────────────────────────

export interface SynthesisProvenance {
  source_agent: string;
  source_mode: string;
  source_cycle_id: string | null;
  source_seed_id: string;
}

export interface SynthesizedCandidate extends FirstPassSeedSummary {
  /** EVERY agent that produced this candidate. The merge collapses the statement, never the lineage. */
  provenance: SynthesisProvenance[];
  merged_from: number;
}

export interface SynthesisLineageRecord {
  kind: 'synthesis';
  at: string;
  by: string;
  sources: string[];
  note: string;
}

export interface SynthesizedPortfolio {
  schema_version: '1.0';
  portfolio_id: string;
  kind: 'synthesis';
  user_id: string;
  mission_id: string;
  candidates: SynthesizedCandidate[];
  exclusions: PortfolioExclusion[];
  lineage: SynthesisLineageRecord[];
  sources: string[];
  counts: {
    portfolios: number;
    candidates_in: number;
    candidates_out: number;
    merged: number;
    exclusions: number;
    refusals: number;
  };
  promoted: false;
  privacy: { private_content_included: false; shared: false };
  policy_hash: string;
  created_at: string;
}

export interface SynthesizeArgs {
  /** Per-agent first-pass results, or whole first-pass records. */
  portfolios: ReadonlyArray<FirstPassAgentResult | FirstPassRecord>;
  /** The identity the synthesis belongs to; derived from a record when omitted. */
  userId?: string;
  /** The mission; derived from a record when omitted. */
  missionId?: string;
  /**
   * What the synthesizer asserts the exclusions are. When supplied it must
   * preserve every source exclusion VERBATIM: dropping one is refused
   * (`exclusion_dropped`) and rewriting one is refused (`exclusion_rewritten`).
   * An entry that is NOT on record is IGNORED — a synthesizer preserves the
   * mission's exclusions, it cannot add one — and its ref comes back in
   * `SynthesizeResult.ignored_exclusions`.
   */
  exclusions?: readonly PortfolioExclusion[];
  synthesizer?: { identity: string; mode?: string | null };
  caller?: CallerIdentity;
  now?: () => string;
}

export type SynthesisRefusalCode =
  | 'exclusion_dropped'
  | 'exclusion_rewritten';

export interface SynthesizeResult {
  synthesized: boolean;
  code: SynthesisRefusalCode | 'synthesized' | 'no_candidates' | null;
  reason: string;
  portfolio: SynthesizedPortfolio | null;
  refusals: Array<{ ref: string; code: SynthesisRefusalCode; reason: string }>;
  /**
   * Refs of synthesizer-supplied exclusions that are NOT on record: they were
   * ignored (a synthesizer can preserve an exclusion, never add one), and they
   * are named here rather than silently dropped.
   */
  ignored_exclusions: string[];
}

function normalizeStatement(hypothesis: string, mechanism: string): string {
  return `${hypothesis} ${mechanism}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Merge portfolios into one, preserving provenance and exclusion reasons
 * verbatim. The merged artifact CANNOT promote: it is a private personal-kind
 * row carrying `promoted: false`, and no promotion path exists in this module.
 */
export async function synthesizePortfolios(db: Db, args: SynthesizeArgs): Promise<SynthesizeResult> {
  if (!Array.isArray(args.portfolios) || args.portfolios.length === 0) {
    throw new FirstPassError('portfolios must be a non-empty list', 'invalid_args');
  }
  const record = args.portfolios.find(
    (portfolio) => (portfolio as FirstPassRecord).kind === 'first_pass',
  ) as FirstPassRecord | undefined;
  const userId = nonEmpty(args.userId) ?? nonEmpty(record?.user_id);
  const missionId = nonEmpty(args.missionId) ?? nonEmpty(record?.mission_id);
  if (!userId) throw new FirstPassError('userId is required (or pass a stored first-pass record)', 'invalid_args');
  if (!missionId) throw new FirstPassError('missionId is required (or pass a stored first-pass record)', 'invalid_args');
  if (args.caller && !args.caller.trusted && args.caller.user_id !== userId) {
    throw new FirstPassError(`Caller '${args.caller.user_id}' may not synthesize for '${userId}'`, 'forbidden');
  }
  await ensureCognitiveTeamIndexes(db);
  const now = args.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const by = nonEmpty(args.synthesizer?.identity) ?? userId;

  const results: FirstPassAgentResult[] = [];
  for (const portfolio of args.portfolios) {
    if (Array.isArray((portfolio as FirstPassRecord).results) && (portfolio as FirstPassRecord).kind === 'first_pass') {
      results.push(...(portfolio as FirstPassRecord).results);
    } else {
      results.push(portfolio as FirstPassAgentResult);
    }
  }

  // 1. The exclusions: the union of every source, carried VERBATIM.
  const sourceExclusions = mergeExclusions(...results.map((result) => result.exclusions ?? []));
  const refusals: SynthesizeResult['refusals'] = [];
  // A synthesizer can preserve an exclusion, never add one: anything it supplies
  // that is not on record is ignored and named back to it.
  const ignored: string[] = [];
  if (args.exclusions) {
    const provided = new Map(args.exclusions.map((exclusion) => [String(exclusion.ref), exclusion]));
    for (const exclusion of sourceExclusions) {
      const match = provided.get(exclusion.ref);
      if (!match) {
        refusals.push({
          ref: exclusion.ref,
          code: 'exclusion_dropped',
          reason: `the exclusion '${exclusion.ref}' (${exclusion.kind}) is on record and was not carried into the synthesis`,
        });
        continue;
      }
      if (match.kind !== exclusion.kind || match.reason !== exclusion.reason || match.text_hash !== exclusion.text_hash) {
        refusals.push({
          ref: exclusion.ref,
          code: 'exclusion_rewritten',
          reason: `the exclusion '${exclusion.ref}' was rewritten: a synthesizer may carry exclusion reasons verbatim, never restate them`,
        });
      }
    }
    const onRecord = new Set(sourceExclusions.map((exclusion) => exclusion.ref));
    for (const ref of new Set(args.exclusions.map((exclusion) => String(exclusion.ref)))) {
      if (!onRecord.has(ref)) ignored.push(ref);
    }
    ignored.sort((left, right) => left.localeCompare(right));
    if (refusals.length > 0) {
      const code = refusals[0].code;
      return {
        synthesized: false,
        code,
        reason: `${refusals.length} exclusion(s) refused: ${refusals.map((entry) => `${entry.ref} (${entry.code})`).join(', ')}`,
        portfolio: null,
        refusals,
        ignored_exclusions: ignored,
      };
    }
  }

  // 2. The candidates, with provenance intact.
  const merged: SynthesizedCandidate[] = [];
  const index = new Map<string, number>();
  let candidatesIn = 0;
  for (const result of results) {
    for (const seed of result.seeds ?? []) {
      candidatesIn += 1;
      const key = normalizeStatement(seed.hypothesis, seed.mechanism);
      const provenance: SynthesisProvenance = {
        source_agent: result.identity,
        source_mode: result.mode,
        source_cycle_id: result.cycle_id ?? null,
        source_seed_id: seed.seed_id,
      };
      const existing = index.get(key);
      if (existing === undefined) {
        index.set(key, merged.length);
        merged.push({ ...seed, provenance: [provenance], merged_from: 1 });
        continue;
      }
      const head = merged[existing];
      head.provenance = [...head.provenance, provenance].sort((left, right) =>
        left.source_agent.localeCompare(right.source_agent) || left.source_seed_id.localeCompare(right.source_seed_id),
      );
      head.merged_from += 1;
      // The strongest statement keeps the head — the merge never loses a
      // lineage, but it does keep the best-supported candidate.
      if (Number(seed.quality) > Number(head.quality)) {
        const provenanceList = head.provenance;
        merged[existing] = { ...seed, provenance: provenanceList, merged_from: head.merged_from };
      }
    }
  }
  merged.sort(
    (left, right) =>
      Number(right.quality) - Number(left.quality) || left.seed_id.localeCompare(right.seed_id),
  );

  if (merged.length === 0) {
    return {
      synthesized: false,
      code: 'no_candidates',
      reason: 'none of the source portfolios carries an admitted candidate',
      portfolio: null,
      refusals: [],
      ignored_exclusions: ignored,
    };
  }

  const sources = results.map((result) => `${result.identity}:${result.mode}`);
  const portfolioId = derivedId(
    'csynth',
    {
      mission_id: missionId,
      user_id: userId,
      sources,
      seed_ids: merged.map((candidate) => candidate.seed_id),
      exclusions: sourceExclusions.map((exclusion) => exclusion.ref),
    },
    hashSeed(`synthesis:${userId}:${missionId}`),
  );

  const portfolio: SynthesizedPortfolio = {
    schema_version: '1.0',
    portfolio_id: portfolioId,
    kind: 'synthesis',
    user_id: userId,
    mission_id: missionId,
    candidates: merged,
    exclusions: sourceExclusions,
    lineage: [
      {
        kind: 'synthesis',
        at: createdAt,
        by,
        sources,
        note: 'merged portfolios after the independent first pass; provenance and exclusion reasons preserved verbatim; promotion is NOT performed here (Phase 5 owns promotion)',
      },
    ],
    sources,
    counts: {
      portfolios: results.length,
      candidates_in: candidatesIn,
      candidates_out: merged.length,
      merged: merged.reduce((total, candidate) => total + (candidate.merged_from - 1), 0),
      exclusions: sourceExclusions.length,
      refusals: refusals.length,
    },
    promoted: false,
    privacy: { private_content_included: false, shared: false },
    policy_hash: '',
    created_at: createdAt,
  };
  portfolio.policy_hash = portfolioPolicyHash(portfolio as unknown as Record<string, unknown>);
  const stored = await storePortfolio(db, portfolio as unknown as Record<string, any>, userId);
  const ignoredNote =
    ignored.length > 0
      ? `; ${ignored.length} supplied exclusion(s) are not on record and were IGNORED (a synthesizer preserves exclusions, it cannot add one)`
      : '';
  return {
    synthesized: true,
    code: 'synthesized',
    reason: stored.reused
      ? `an identical synthesis is already on record (${portfolioId})${ignoredNote}`
      : `merged ${results.length} portfolio(s) into ${merged.length} candidate(s) with provenance and exclusions intact${ignoredNote}`,
    portfolio: stored.portfolio as unknown as SynthesizedPortfolio,
    refusals: [],
    ignored_exclusions: ignored,
  };
}

/** Re-exported so a consumer can name the allocation error from this module. */
export { CognitiveAllocationError, type CognitivePortfolio };
