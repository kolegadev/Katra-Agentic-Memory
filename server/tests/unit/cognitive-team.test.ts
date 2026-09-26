/**
 * ITER-8 — the cognitive team: expiring thinking modes, bounded inheritance,
 * portfolio allocation, an independent first pass and synthesis (Phase 6).
 * Contract: CONTRACT-iter8-cognitive-team.md §A–§F.
 *
 * What is proved here, against the REAL services (only `llmService.extractJson`
 * is stubbed — no network, no provider):
 *
 *   A. the catalogue — the brief's Appendix C modes with their attention bias
 *      and obligation VERBATIM, each declaring the approved dimensions it may
 *      bias and never a hard invariant;
 *   B. the mode lifecycle — assign ⇒ active ⇒ expired AT READ (no cron), the
 *      transition recorded once, an explicit expire, an explicit renew, a
 *      required reason, a TTL refused outside its window, and no path that
 *      silently extends a mode;
 *   C. bounded inheritance — the envelope as an immutable reference, approved
 *      dimensions clamped inside their documented ranges with the clamp
 *      recorded, hard invariants / unapproved dimensions / out-of-bounds values
 *      refused BY NAME, and the parent's own configuration byte-identical
 *      afterwards;
 *   D. the taint test — markers in EVERY private store of the parent (journals,
 *      reflections, episodic events, traces, seeds, lineages, beliefs,
 *      procedures) never appear in an envelope, its hash input, a mode
 *      assignment, an allocation report, a first-pass request or a synthesis
 *      output;
 *   E. envelope integrity — a tampered envelope is refused by name, including a
 *      tamperer who recomputed the hash (the invariants are re-checked on the
 *      decoded values);
 *   F. allocation — the five weighted terms reported with their inputs,
 *      missing-bin coverage measurably dominating among otherwise-equal agents,
 *      the convergence and load penalties measurably changing the order, and the
 *      reserved evaluator never among a candidate's generators;
 *   G. the independent first pass — captured requests and captured engine
 *      prompts carry no peer content, blocked requests named;
 *   H. synthesis — provenance per candidate, exclusions verbatim, a dropped or
 *      rewritten exclusion refused by name, a `synthesis` lineage record and no
 *      promotion;
 *   I. the flag — off: all six tools are `Unknown tool`, nothing is written and
 *      no model is called; untrusted callers cannot act for another identity;
 *   J. THE EXIT CRITERION — three same-model agents (same personality profile,
 *      different modes) each run an isolated first pass over the frozen fixture;
 *      measured pairwise statement similarity is LOWER than two same-mode
 *      controls, the modes/envelopes/effective scoring actually differ, and no
 *      private content crossed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

/**
 * REPRODUCIBILITY (ITER-11 refinement). The exit criterion prints operator-plan
 * Jaccards, and those numbers were not reproducible: the trace id the ITER-5
 * ledger mints is a `randomUUID()`, it is hashed into the signal ids and then
 * into each agent's generation seed, so every run drew a different operator plan
 * and printed a different number (0.3333 / 0.3519 / 0.2815 / 0.2778 …). A
 * recorded number nobody can re-derive is not evidence, and the CHANGELOG quotes
 * these ones.
 *
 * The fix is the one `imagination-baseline-fixture.test.ts` already uses: pin
 * `randomUUID` to a counter, RESET before every test, so a run — of this file or
 * of one test inside it — derives the same trace ids, the same seeds and the
 * same plans. The ids keep the v4 shape the schemas validate, and never repeat
 * within a test.
 */
const uuidCounter = vi.hoisted(() => ({ value: 0 }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    randomUUID: () => {
      uuidCounter.value += 1;
      return `00000000-0000-4000-8000-${String(uuidCounter.value).padStart(12, '0')}`;
    },
  };
});

const holder = vi.hoisted(() => ({ db: null as any }));

vi.mock('../../src/database/connection.js', () => ({
  get_database: () => holder.db,
  is_database_connected: () => holder.db !== null,
  connect_to_mongodb: async () => {},
  close_connection: async () => {},
}));

vi.mock('../../src/database/redis-connection.js', () => ({
  get_redis_client: async () => null,
  is_redis_healthy: async () => false,
  close_redis_connection: async () => {},
  get_redis_status: () => ({ connected: false }),
}));

import { FakeDb } from '../helpers/fake-mongo.js';
import { llmService } from '../../src/services/infrastructure/llm-service.js';
import { defaultResponder, focusedOutput, imaginationOutput, seedMission } from '../helpers/imagination-scenario.js';
import { runFocusedConsolidation } from '../../src/services/processing/focused-consolidation-service.js';
import { seedSimilarity, statementSimilarity } from '../../src/services/processing/idea-archive-service.js';
import {
  COGNITIVE_MODES,
  COGNITIVE_MODE_NAMES,
  DEFAULT_MODE_TTL_MS,
  MAX_MODE_TTL_MS,
  MODE_ASSIGNMENT_KIND,
  MIN_MODE_TTL_MS,
  ModeAccessError,
  activeMode,
  assignMode,
  cognitiveTeamAllocationEnabled,
  expireMode,
  listAssignments,
  modeBinLabels,
  renewMode,
  verifyAssignment,
  assignmentGrantHash,
  type ThinkingModeAssignment,
} from '../../src/services/processing/cognitive-mode-service.js';
import {
  APPROVED_DIMENSIONS,
  classifyDimension,
  clampMutation,
  MESSAGE_PRIORITY,
} from '../../src/services/processing/inheritance-policy.js';
import { IMMUTABLE_INVARIANT_ALIASES } from '../../src/services/processing/inheritance-invariants.js';
import {
  applyBoundedMutation,
  boundsFrom,
  baselineFrom,
  createInheritanceEnvelope,
  dispositionHash,
  envelopePayloadForHash,
  envelopePolicyHash,
  listEnvelopes,
  readEnvelope,
  storeEnvelope,
  verifyEnvelope,
  type InheritanceEnvelope,
} from '../../src/services/processing/inheritance-envelope.js';
import {
  ALLOCATION_WEIGHTS,
  CONVERGENCE_PENALTY_PER_DUPLICATE_PICK,
  CONVERGENCE_PENALTY_PER_PEER,
  LOAD_PENALTY_WEIGHT,
  allocatePortfolio,
  getPortfolio,
  listPortfolios,
  verifyPortfolio,
} from '../../src/services/processing/cognitive-allocation-service.js';
import {
  FirstPassError,
  planFirstPass,
  readFirstPass,
  runFirstPass,
  synthesizePortfolios,
  type FirstPassAgentResult,
  type FirstPassRecord,
  type PortfolioExclusion,
} from '../../src/services/processing/independent-first-pass.js';
import { COGNITIVE_TEAM_COLLECTIONS } from '../../src/services/processing/cognitive-team-collections.js';
import {
  COGNITIVE_TEAM_TOOL_DEFS,
  COGNITIVE_TEAM_TOOL_NAMES,
  dispatchCognitiveTeamTool,
} from '../../src/services/processing/cognitive-team-tools.js';
import {
  effectivePersonalityConfig,
  resolvePersonalityConfig,
  sanitizePersonalityPatch,
  updatePersonalityConfig,
} from '../../src/services/integration/personality-config-service.js';
import { maxCyclesPerWindow } from '../../src/services/processing/imagination-cycle-config.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const LEAD: CallerIdentity = { user_id: 'agent-lead', trusted: false };
const OWNER: CallerIdentity = { user_id: 'agent-a', trusted: false };
const OTHER: CallerIdentity = { user_id: 'agent-b', trusted: false };
const OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };

const ASSIGNMENTS = COGNITIVE_TEAM_COLLECTIONS.modeAssignments;
const ENVELOPES = COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes;
const PORTFOLIOS = COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios;
const SETTINGS = 'system_settings';

/** The private stores a marker is planted in for the taint test. */
const PRIVATE_STORES = [
  'reflective_journals',
  'reflection_nodes',
  'episodic_events',
  'salience_traces',
  'idea_seeds',
  'idea_lineages',
  'agent_beliefs',
  'procedural_patterns',
] as const;

let db: FakeDb;
let clock: string;
let prompts: Array<{ system: string; prompt: string }>;
let respond: (system: string, prompt: string) => Record<string, unknown>;

const now = () => clock;

/**
 * A FIXED scenario clock for the team fixtures. The envelope's window is the one
 * input of an independent first pass that would otherwise move with wall time
 * (the pass id, every agent's generation stream and therefore the exit
 * criterion's measured numbers are derived from it), so the fixture pins it: the
 * measurement is reproducible, which is what makes its numbers quotable.
 */
const SCENARIO_NOW = '2026-09-25T09:00:00.000Z';
const scenarioNow = () => SCENARIO_NOW;
const assignments = () => db.collection(ASSIGNMENTS).docs as Array<Record<string, any>>;
const envelopes = () => db.collection(ENVELOPES).docs as Array<Record<string, any>>;
const portfolios = () => db.collection(PORTFOLIOS).docs as Array<Record<string, any>>;

function txt(result: Array<{ type: string; text: string }>): string {
  return result.map((row) => row.text).join('\n');
}

/** The engine prompts captured in this test (the ONLY model calls made). */
function enginePrompts(): string[] {
  return prompts.filter((entry) => entry.system.includes('imagination faculty')).map((entry) => entry.prompt);
}

beforeEach(() => {
  db = new FakeDb();
  holder.db = db;
  clock = '2026-09-25T00:00:00.000Z';
  prompts = [];
  respond = defaultResponder;
  // The uuid stream restarts per test, so the ids — and therefore the seeds and
  // the printed divergence numbers — do not depend on which tests ran before.
  uuidCounter.value = 0;
  vi.spyOn(llmService, 'extractJson').mockImplementation((async (system: string, prompt: string) => {
    prompts.push({ system, prompt });
    return respond(system, prompt);
  }) as never);
  vi.spyOn(llmService, 'getServiceStatus').mockReturnValue({
    available: true,
    provider: 'stub',
    model: 'test-model',
    providers: ['stub(ready)'],
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.COGNITIVE_TEAM_ALLOCATION;
  delete process.env.PER_IDENTITY_PERSONALITY;
});

/**
 * The frozen fixture the cognitive-team suites share: the ITER-7 mission (state,
 * ledger with a rejected hypothesis, work queue, knowledge graph) plus ONE real
 * ITER-5 salience trace per identity — the traces are what make the first pass
 * independent, so each agent's own trace is a real production artifact.
 */
async function buildTeam(
  missionId: string,
  modes: Record<string, string>,
  options: { envelopes?: boolean; run?: boolean } = {},
): Promise<{
  members: Array<{ identity: string; mode: string; envelope_id?: string }>;
  pass: FirstPassRecord;
  results: FirstPassAgentResult[];
}> {
  await seedMission(db, { missionId, ownerId: LEAD.user_id });
  const members: Array<{ identity: string; mode: string; envelope_id?: string }> = [];
  for (const [identity, mode] of Object.entries(modes)) {
    const focused = await runFocusedConsolidation(db.asDb(), {
      userId: identity,
      missionId,
      cycleId: `team_trace:${missionId}:${identity}`,
      actorId: identity,
    });
    if (focused.status !== 'completed') throw new Error(`fixture trace failed for ${identity}: ${focused.error}`);
    if (options.envelopes === false) {
      members.push({ identity, mode });
      continue;
    }
    const created = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: LEAD.user_id,
      missionId,
      childLabel: identity,
      mode,
      caller: LEAD,
      now: scenarioNow,
    });
    members.push({ identity, mode, envelope_id: created.envelope.envelope_id });
  }
  const planned = await planFirstPass(db.asDb(), {
    userId: LEAD.user_id,
    missionId,
    team: members,
    caller: LEAD,
    now: scenarioNow,
  });
  if (options.run === false) return { members, pass: planned.pass, results: [] };
  const ran = await runFirstPass(db.asDb(), {
    userId: LEAD.user_id,
    missionId,
    team: members,
    caller: LEAD,
    now: scenarioNow,
    pass: planned.pass,
  });
  return { members, pass: ran.pass, results: ran.results };
}

/** The normalized statement of one candidate — the unit the similarity metric compares. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function statements(result: FirstPassAgentResult): Set<string> {
  return new Set(result.seeds.map((seed) => normalize(`${seed.hypothesis} ${seed.mechanism}`)));
}

/**
 * The pairwise statement measurements between the portfolios of a group:
 *
 *   jaccard  — |A ∩ B| / |A ∪ B| over the normalized statements: how much of the
 *              approach space two agents actually share.
 *   closest  — for each candidate an agent produced, the similarity of the
 *              CLOSEST candidate a peer produced (`seedSimilarity`, ITER-6's own
 *              metric), averaged: how close the ideas are, not just how many.
 */
function pairwiseMeasurements(group: FirstPassAgentResult[]): {
  jaccard: number[];
  closest: number[];
  jaccard_mean: number;
  closest_mean: number;
  /** Share of each agent's statements that NO peer produced, averaged. */
  unique_share: number;
} {
  const jaccard: number[] = [];
  const closest: number[] = [];
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const left = statements(group[i]);
      const right = statements(group[j]);
      const shared = [...left].filter((entry) => right.has(entry)).length;
      const union = new Set([...left, ...right]).size;
      jaccard.push(Number((shared / Math.max(1, union)).toFixed(4)));
      const perCandidate = group[i].seeds.map((seed) =>
        Math.max(0, ...group[j].seeds.map((peer) => seedSimilarity(seed, peer))),
      );
      closest.push(
        Number(
          (perCandidate.reduce((total, value) => total + value, 0) / Math.max(1, perCandidate.length)).toFixed(4),
        ),
      );
    }
  }
  const unique: number[] = [];
  for (let i = 0; i < group.length; i += 1) {
    const peers = new Set(
      group
        .filter((_entry, index) => index !== i)
        .flatMap((entry) => [...statements(entry)]),
    );
    const own = [...statements(group[i])];
    unique.push(own.filter((entry) => !peers.has(entry)).length / Math.max(1, own.length));
  }
  const mean = (values: number[]): number =>
    Number((values.reduce((total, value) => total + value, 0) / Math.max(1, values.length)).toFixed(4));
  return {
    jaccard,
    closest,
    jaccard_mean: mean(jaccard),
    closest_mean: mean(closest),
    unique_share: mean(unique),
  };
}

/** The measurements of several frozen checkpoints, aggregated. */
function aggregate(checkpoints: FirstPassAgentResult[][]): {
  jaccard: number[];
  closest: number[];
  jaccard_mean: number;
  closest_mean: number;
  unique_share: number;
  per_checkpoint: number[];
} {
  const measured = checkpoints.map((group) => pairwiseMeasurements(group));
  const mean = (values: number[]): number =>
    Number((values.reduce((total, value) => total + value, 0) / Math.max(1, values.length)).toFixed(4));
  return {
    jaccard: measured.flatMap((entry) => entry.jaccard),
    closest: measured.flatMap((entry) => entry.closest),
    jaccard_mean: mean(measured.flatMap((entry) => entry.jaccard)),
    closest_mean: mean(measured.flatMap((entry) => entry.closest)),
    unique_share: mean(measured.map((entry) => entry.unique_share)),
    per_checkpoint: measured.map((entry) => entry.jaccard_mean),
  };
}

// ── A. the catalogue ────────────────────────────────────────────────────────

describe('cognitive team — the Appendix C mode catalogue', () => {
  it('records the eight modes with attention bias and obligation VERBATIM', () => {
    expect(COGNITIVE_MODE_NAMES).toEqual([
      'philosopher',
      'technician',
      'strategist',
      'creative',
      'analyst',
      'critic',
      'verifier',
      'synthesizer',
    ]);
    const expected = [
      ['philosopher', 'Assumptions, meanings, category errors, first principles', 'Return clarified premises and implications, not only abstractions.'],
      ['technician', 'Mechanisms, interfaces, failure modes, reproducibility', 'Return executable tests or concrete implementation deltas.'],
      ['strategist', 'Dependencies, sequencing, leverage, opportunity cost', 'Return portfolio and decision consequences.'],
      ['creative', 'Remote analogies, inversion, representation shifts', 'Return diverse seeds with explicit bridges and cheap tests.'],
      ['analyst', 'Evidence quality, decomposition, quantitative structure', 'Return calibrated confidence and competing explanations.'],
      ['critic', 'Hidden assumptions, counterexamples, adversarial cases', 'Attack ideas without silently replacing the objective.'],
      ['verifier', 'Formal checks, experiments, source/proof validation', 'Independent evaluation; may not grade its own generated seed.'],
      ['synthesizer', 'Complementarity and compression across portfolios', 'Preserve lineage, disagreements and exclusion reasons.'],
    ];
    for (const [mode, bias, obligation] of expected) {
      const spec = COGNITIVE_MODES[mode as keyof typeof COGNITIVE_MODES];
      expect(spec.attention_bias, `${mode} attention bias`).toBe(bias);
      expect(spec.obligation, `${mode} obligation`).toBe(obligation);
    }
  });

  it('every mode declares approved dimensions from the closed vocabulary and NEVER a hard invariant', () => {
    const invariants = new Set(Object.keys(IMMUTABLE_INVARIANT_ALIASES));
    for (const name of COGNITIVE_MODE_NAMES) {
      const spec = COGNITIVE_MODES[name];
      expect(spec.approved_dimensions.length, `${name} declares no approved dimension`).toBeGreaterThan(0);
      for (const dimension of spec.approved_dimensions) {
        expect(APPROVED_DIMENSIONS as readonly string[]).toContain(dimension);
        expect(invariants.has(dimension), `${name} claims to bias the invariant ${dimension}`).toBe(false);
        expect(classifyDimension(dimension).kind).toBe('approved');
      }
      // The mode's default bias may only touch the dimensions it declares.
      for (const dimension of Object.keys(spec.default_bias)) {
        expect(spec.approved_dimensions as readonly string[]).toContain(dimension);
      }
      expect(spec.attention_bins.length).toBeGreaterThan(0);
      expect(modeBinLabels(spec).length).toBeGreaterThan(0);
      expect(['explore', 'exploit', 'balanced']).toContain(spec.engine_mode);
      expect(spec.operator_budget).toBeGreaterThan(0);
      expect(spec.reset_behaviour).toBe('return_to_parent_disposition');
    }
  });

  it('refuses an unknown mode BY NAME and requires a reason', async () => {
    await expect(
      assignMode(db.asDb(), { userId: OWNER.user_id, missionId: 'm1', mode: 'oracle', reason: 'because' }),
    ).rejects.toThrow(/Unknown thinking mode 'oracle'/);
    await expect(
      assignMode(db.asDb(), { userId: OWNER.user_id, missionId: 'm1', mode: 'critic', reason: '   ' }),
    ).rejects.toThrow(/reason is required/);
    expect(assignments()).toHaveLength(0);
  });
});

// ── B. the mode lifecycle ───────────────────────────────────────────────────

describe('cognitive team — modes are expiring assignments', () => {
  it('assign ⇒ active ⇒ expired AT READ, and the transition is recorded exactly once', async () => {
    const assignment = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: 'mission_modes',
      mode: 'analyst',
      reason: 'the mission needs calibrated confidence',
      ttlMs: 60_000,
      actorId: OWNER.user_id,
      caller: OWNER,
      now,
    });
    expect(assignment.status).toBe('active');
    expect(Date.parse(assignment.expires_at) - Date.parse(assignment.started_at)).toBe(60_000);
    expect(assignment.policy_version).toBe('1.0');
    expect(assignment.inheritance_policy).toBe('bounded_mission_scoped');
    expect(assignment.reset_behaviour).toBe('return_to_parent_disposition');
    // No cron anywhere: the row is still `active` on disk until a read computes it.
    expect(assignments()[0].status).toBe('active');
    expect(assignments()[0].expiry).toBeNull();

    const before = await activeMode(db.asDb(), { userId: OWNER.user_id, missionId: 'mission_modes', caller: OWNER, now });
    expect(before.active).toBe(true);
    expect(before.expired_now).toBe(false);
    expect(before.mode?.mode).toBe('analyst');

    clock = '2026-09-25T00:02:00.000Z';
    const after = await activeMode(db.asDb(), { userId: OWNER.user_id, missionId: 'mission_modes', caller: OWNER, now });
    expect(after.active).toBe(false);
    expect(after.expired_now).toBe(true);
    expect(after.assignment?.status).toBe('expired');
    expect(after.assignment?.expiry?.reason).toBe('ttl_elapsed');
    const recordedOnce = JSON.stringify(assignments()[0].expiry);

    clock = '2026-09-25T00:10:00.000Z';
    const again = await activeMode(db.asDb(), { userId: OWNER.user_id, missionId: 'mission_modes', caller: OWNER, now });
    expect(again.expired_now).toBe(false);
    expect(JSON.stringify(assignments()[0].expiry)).toBe(recordedOnce);
    // The grant is untouched by the expiry: only the window closed.
    expect(verifyAssignment(assignments()[0]).ok).toBe(true);
  });

  it('refuses a TTL outside the documented window instead of silently clamping it', async () => {
    await expect(
      assignMode(db.asDb(), { userId: OWNER.user_id, missionId: 'm', mode: 'analyst', reason: 'r', ttlMs: MIN_MODE_TTL_MS - 1 }),
    ).rejects.toThrow(/outside the documented window/);
    await expect(
      assignMode(db.asDb(), { userId: OWNER.user_id, missionId: 'm', mode: 'analyst', reason: 'r', ttlMs: MAX_MODE_TTL_MS + 1 }),
    ).rejects.toThrow(/outside the documented window/);
    const assignment = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: 'm',
      mode: 'analyst',
      reason: 'r',
      caller: OWNER,
      now,
    });
    expect(assignment.ttl_ms).toBe(DEFAULT_MODE_TTL_MS);
  });

  it('explicit expire works once; explicit renew moves the window; an expired mode cannot be renewed', async () => {
    const assignment = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: 'mission_lifecycle',
      mode: 'creative',
      reason: 'explore the space',
      ttlMs: 120_000,
      actorId: OWNER.user_id,
      caller: OWNER,
      now,
    });
    const original = assignment.expires_at;

    clock = '2026-09-25T00:01:00.000Z';
    const renewed = await renewMode(db.asDb(), {
      assignmentId: assignment.assignment_id,
      reason: 'the exploration needs another window',
      actorId: OWNER.user_id,
      caller: OWNER,
      now,
    });
    expect(renewed.renewed).toBe(true);
    expect(Date.parse(renewed.assignment!.expires_at)).toBeGreaterThan(Date.parse(original));
    expect(renewed.assignment!.renewals).toHaveLength(1);
    expect(renewed.assignment!.renewals[0].reason).toBe('the exploration needs another window');

    await expect(
      renewMode(db.asDb(), { assignmentId: assignment.assignment_id, reason: '   ', caller: OWNER, now }),
    ).rejects.toThrow(/reason is required/);

    clock = '2026-09-25T00:05:00.000Z';
    const expired = await expireMode(db.asDb(), {
      assignmentId: assignment.assignment_id,
      reason: 'the mission moved on',
      actorId: OWNER.user_id,
      caller: OWNER,
      now,
    });
    expect(expired.expired).toBe(true);
    expect(expired.assignment?.expiry?.by).toBe(OWNER.user_id);
    const second = await expireMode(db.asDb(), {
      assignmentId: assignment.assignment_id,
      reason: 'again',
      caller: OWNER,
      now,
    });
    expect(second.expired).toBe(false);
    expect(second.code).toBe('already_expired');
    expect(assignments()[0].expiry.reason).toBe('the mission moved on');

    const revive = await renewMode(db.asDb(), {
      assignmentId: assignment.assignment_id,
      reason: 'please come back',
      caller: OWNER,
      now,
    });
    expect(revive.renewed).toBe(false);
    expect(revive.code).toBe('mode_expired');
    expect(assignments()[0].expires_at).toBe(renewed.assignment!.expires_at);
  });

  it('no path silently extends a mode: reads never move the window', async () => {
    const assignment = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: 'mission_stable',
      mode: 'critic',
      reason: 'attack the accepted frame',
      ttlMs: 300_000,
      caller: OWNER,
      now,
    });
    for (const at of ['2026-09-25T00:01:00.000Z', '2026-09-25T00:02:00.000Z', '2026-09-25T00:03:00.000Z']) {
      clock = at;
      const read = await activeMode(db.asDb(), { userId: OWNER.user_id, missionId: 'mission_stable', caller: OWNER, now });
      expect(read.assignment?.expires_at).toBe(assignment.expires_at);
    }
    expect(assignments()[0].expires_at).toBe(assignment.expires_at);
    expect(assignments()[0].renewals).toHaveLength(0);
  });

  it('pins assignment and reads to the caller, and lets the mission owner read a mission-scoped mode', async () => {
    await assignMode(db.asDb(), { userId: OWNER.user_id, missionId: 'mission_pin', mode: 'verifier', reason: 'r', caller: OWNER, now });
    await expect(
      assignMode(db.asDb(), { userId: OWNER.user_id, missionId: 'mission_pin', mode: 'critic', reason: 'r', caller: OTHER, now }),
    ).rejects.toThrow(ModeAccessError);
    await expect(
      activeMode(db.asDb(), { userId: OWNER.user_id, missionId: 'mission_pin', caller: OTHER, now }),
    ).rejects.toThrow(ModeAccessError);
    const trusted = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: 'mission_pin',
      mode: 'critic',
      reason: 'acting for',
      caller: OPERATOR,
      now,
    });
    expect(trusted.user_id).toBe(OWNER.user_id);
    const listed = await listAssignments(db.asDb(), { userId: OWNER.user_id, caller: OWNER });
    expect(listed).toHaveLength(2);
  });
});

// ── C. bounded inheritance ──────────────────────────────────────────────────

describe('cognitive team — inheritance is bounded', () => {
  async function configured(): Promise<void> {
    const patch = sanitizePersonalityPatch({ personality: 'balanced', source_weights: { vector_search: 6 }, scoring: {} });
    if (!patch.ok) throw new Error(patch.error);
    await updatePersonalityConfig(db.asDb(), OWNER.user_id, patch.patch, OPERATOR);
  }

  it('an envelope is an IMMUTABLE REFERENCE built from an allow-list (no private field at all)', async () => {
    await configured();
    const created = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: 'mission_envelope',
      childLabel: 'agent-child',
      mode: 'creative',
      caller: OWNER,
      now,
    });
    const envelope = created.envelope as unknown as Record<string, unknown>;
    expect(verifyEnvelope(envelope)).toEqual({ ok: true, code: null, reason: 'verified' });
    expect(Object.keys(envelope).sort()).toEqual(
      [
        'allowed_dimensions',
        'baseline',
        'bounds',
        'child_label',
        'created_at',
        'disposition_snapshot',
        'effective_scoring',
        'envelope_id',
        'envelope_version',
        'expires_at',
        'mission_id',
        'mode',
        'mutations',
        'parent_envelope_id',
        'parent_identity_id',
        'policy_hash',
        'privacy',
        'root_envelope_id',
        'schema_version',
      ].sort(),
    );
    expect(envelope.privacy).toEqual({ private_content_included: false, shared: false });
    expect(envelope.bounds).toMatchObject({
      message_priority: MESSAGE_PRIORITY,
      privacy_policy: 'immutable',
      floors: { working_memory: 0.1, vector_search: 0.15 },
    });
    // The disposition snapshot is a hash over an allow-listed subset — the
    // identity, the origin and the timestamps are NOT in it.
    const resolved = await resolvePersonalityConfig(db.asDb(), OWNER.user_id);
    expect(envelope.disposition_snapshot).toEqual({
      profile: resolved.profile,
      version: resolved.version,
      hash: dispositionHash(resolved),
    });
    expect(JSON.stringify(envelope)).not.toContain(OWNER.user_id === 'agent-a' ? 'not-a-marker' : 'nothing');
    expect(envelope.allowed_dimensions).toEqual(['vector_fetch_limit', 'k']);
    // The mode's default bias was applied through the same bounded path.
    expect((envelope.mutations as Array<Record<string, unknown>>).length).toBe(2);
    for (const mutation of envelope.mutations as Array<Record<string, unknown>>) {
      expect(mutation.source).toBe('mode_default_bias');
      expect(mutation.clamped).toBe(false);
      expect((envelope.allowed_dimensions as string[]).includes(String(mutation.dimension))).toBe(true);
    }
    expect(created.refusals).toEqual([]);
  });

  it('approved dimensions CLAMP inside their documented ranges and record the clamp', async () => {
    await configured();
    const { envelope } = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: 'mission_clamp',
      childLabel: 'agent-clamped',
      caller: OWNER,
      now,
    });
    const baseline = envelope.baseline;
    const k = applyBoundedMutation(envelope, { dimension: 'k', value: baseline.k * 10 });
    expect(k.ok).toBe(true);
    if (!k.ok) return;
    expect(k.mutation.clamped).toBe(true);
    expect(k.mutation.applied).toBe(Number((baseline.k * 1.25).toFixed(6)));
    expect(k.envelope.effective_scoring.relevance_multiplier).toBe(k.mutation.applied);

    const fetch = applyBoundedMutation(k.envelope, { dimension: 'vector_fetch_limit', value: 999 });
    expect(fetch.ok).toBe(true);
    if (!fetch.ok) return;
    expect(fetch.mutation.applied).toBe(20);
    expect(fetch.envelope.effective_scoring.vector_fetch_limit).toBe(20);
    expect(fetch.envelope.mutations).toHaveLength(2);
    expect(fetch.envelope.parent_envelope_id).toBe(k.envelope.envelope_id);
    expect(fetch.envelope.root_envelope_id).toBe(envelope.envelope_id);

    const tightened = applyBoundedMutation(fetch.envelope, { dimension: 'cap_pct', value: 0.1, actorId: 'operator' });
    expect(tightened.ok).toBe(true);
    if (!tightened.ok) return;
    expect(tightened.mutation.applied).toBe(0.1);
    expect(tightened.mutation.source).toBe('caller');
    expect(verifyEnvelope(tightened.envelope as unknown as Record<string, unknown>).ok).toBe(true);
    // A derived envelope never moves the window.
    expect(tightened.envelope.expires_at).toBe(envelope.expires_at);
    // The source envelope is unchanged: no mutation was written into it.
    expect(envelope.mutations).toHaveLength(0);
    expect(envelope.effective_scoring.relevance_multiplier).toBe(baseline.k);
  });

  it('refuses hard invariants, unapproved dimensions and out-of-bounds values BY NAME', async () => {
    await configured();
    const { envelope } = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: 'mission_refuse',
      childLabel: 'agent-refused',
      caller: OWNER,
      now,
    });

    for (const dimension of ['message_priority', 'agent_message', 'agent_message_weight', 'budget_floors', 'floors', 'working_memory_floor', 'vector_search_floor', 'privacy_policy', 'privacy', 'max_single_source_pct_bounds']) {
      const refused = applyBoundedMutation(envelope, { dimension, value: 15 });
      expect(refused.ok, `${dimension} should be refused`).toBe(false);
      if (refused.ok) continue;
      expect(refused.code).toBe('immutable_invariant');
      expect(refused.reason).toContain('immutable invariant');
    }

    for (const dimension of ['unknown_dimension', 'half_life_days', 'max_context_tokens', 'weights', 'profile']) {
      const refused = applyBoundedMutation(envelope, { dimension, value: 1 });
      expect(refused.ok, `${dimension} should be refused`).toBe(false);
      if (refused.ok) continue;
      expect(refused.code).toBe('dimension_not_approved');
    }

    // A mode narrows the approved set: this envelope carries no mode, so every
    // approved dimension is open; a mode-scoped one closes the rest.
    const scoped = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: 'mission_refuse',
      childLabel: 'agent-verifier',
      mode: 'verifier',
      caller: OWNER,
      now,
    });
    const notForVerifier = applyBoundedMutation(scoped.envelope, { dimension: 'k', value: scoped.envelope.baseline.k });
    expect(notForVerifier.ok).toBe(false);
    if (!notForVerifier.ok) expect(notForVerifier.code).toBe('dimension_not_approved');

    // Out of bounds: a non-finite value, and an attempt to WIDEN the cap.
    const nan = applyBoundedMutation(envelope, { dimension: 'k', value: Number.NaN });
    expect(nan.ok).toBe(false);
    if (!nan.ok) expect(nan.code).toBe('out_of_bounds');
    const widen = applyBoundedMutation(envelope, { dimension: 'cap_pct', value: 0.95 });
    expect(widen.ok).toBe(false);
    if (!widen.ok) {
      expect(widen.code).toBe('out_of_bounds');
      expect(widen.reason).toContain('immutable invariant');
    }
    const nonNumber = applyBoundedMutation(envelope, { dimension: 'k', value: '2' as unknown as number });
    expect(nonNumber.ok).toBe(false);
    if (!nonNumber.ok) expect(nonNumber.code).toBe('out_of_bounds');

    // Nothing was applied by any of the refusals.
    expect(envelope.mutations).toHaveLength(0);
    const stored = envelopes();
    expect(stored.filter((row) => row.envelope_id === envelope.envelope_id)).toHaveLength(1);
  });

  it("leaves the parent's own configuration BYTE-identical", async () => {
    await configured();
    const before = JSON.stringify(db.collection(SETTINGS).docs);
    const resolvedBefore = JSON.stringify(await resolvePersonalityConfig(db.asDb(), OWNER.user_id));
    const effectiveBefore = JSON.stringify(effectivePersonalityConfig(await resolvePersonalityConfig(db.asDb(), OWNER.user_id)));

    const { envelope } = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: 'mission_untouched',
      childLabel: 'agent-child',
      mutations: [{ dimension: 'k', value: 0.001 }],
      caller: OWNER,
      now,
    });
    const derived = applyBoundedMutation(envelope, { dimension: 'vector_fetch_limit', value: 1 });
    expect(derived.ok).toBe(true);
    if (derived.ok) await storeEnvelope(db.asDb(), derived.envelope, OWNER.user_id);

    expect(JSON.stringify(db.collection(SETTINGS).docs)).toBe(before);
    expect(JSON.stringify(await resolvePersonalityConfig(db.asDb(), OWNER.user_id))).toBe(resolvedBefore);
    expect(JSON.stringify(effectivePersonalityConfig(await resolvePersonalityConfig(db.asDb(), OWNER.user_id)))).toBe(
      effectiveBefore,
    );
    expect(envelopes().length).toBe(2);
  });

  it('refuses a TAMPERED envelope by name — including one whose hash was recomputed', async () => {
    await configured();
    const { envelope } = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: 'mission_tamper',
      childLabel: 'agent-child',
      mode: 'analyst',
      caller: OWNER,
      now,
    });
    const stored = () => envelopes().find((row) => row.envelope_id === envelope.envelope_id)!;

    // 1. a mutated value: the policy hash no longer matches.
    stored().effective_scoring.relevance_multiplier = 99;
    const mismatch = verifyEnvelope(stored());
    expect(mismatch.code).toBe('policy_hash_mismatch');

    // 2. a smuggled key: the CLOSED schema refuses it even though the hash was
    //    not recomputed.
    delete stored().effective_scoring;
    const broken = verifyEnvelope(stored());
    expect(['schema_invalid', 'policy_hash_mismatch']).toContain(broken.code);

    // 3. a tamperer who RECOMPUTES the hash: the invariants are re-checked on
    //    the decoded values, so a weakened ceiling is still refused.
    const forged: InheritanceEnvelope = JSON.parse(JSON.stringify(envelope));
    (forged.effective_scoring as unknown as Record<string, unknown>).agent_message_weight = 1;
    (forged as unknown as Record<string, unknown>).policy_hash = envelopePolicyHash(forged as unknown as Record<string, unknown>);
    const rehashed = verifyEnvelope(forged as unknown as Record<string, unknown>);
    // The CLOSED schema pins the agent-message weight, so this one never even
    // reaches the invariant check.
    expect(rehashed).toMatchObject({ ok: false, code: 'schema_invalid' });

    const widened: InheritanceEnvelope = JSON.parse(JSON.stringify(envelope));
    widened.bounds.caps.max_single_source_pct = 1;
    widened.effective_scoring.max_single_source_pct = 1;
    (widened as unknown as Record<string, unknown>).policy_hash = envelopePolicyHash(widened as unknown as Record<string, unknown>);
    const capTamper = verifyEnvelope(widened as unknown as Record<string, unknown>);
    expect(capTamper.ok).toBe(false);
    expect(capTamper.code).toBe('invariant_violation');

    const rebanded: InheritanceEnvelope = JSON.parse(JSON.stringify(envelope));
    rebanded.bounds.caps.k_floor = 0.0001;
    rebanded.bounds.caps.k_ceiling = 1000;
    (rebanded as unknown as Record<string, unknown>).policy_hash = envelopePolicyHash(rebanded as unknown as Record<string, unknown>);
    const band = verifyEnvelope(rebanded as unknown as Record<string, unknown>);
    expect(band.ok).toBe(false);
    expect(band.code).toBe('invariant_violation');

    const raisedFetch: InheritanceEnvelope = JSON.parse(JSON.stringify(envelope));
    raisedFetch.bounds.caps.vector_fetch_limit_max = 500;
    (raisedFetch as unknown as Record<string, unknown>).policy_hash = envelopePolicyHash(raisedFetch as unknown as Record<string, unknown>);
    expect(verifyEnvelope(raisedFetch as unknown as Record<string, unknown>).code).toBe('invariant_violation');

    const mismatchedFloors: InheritanceEnvelope = JSON.parse(JSON.stringify(envelope));
    mismatchedFloors.effective_scoring.vector_search_floor = 0.2;
    (mismatchedFloors as unknown as Record<string, unknown>).policy_hash = envelopePolicyHash(
      mismatchedFloors as unknown as Record<string, unknown>,
    );
    const floors = verifyEnvelope(mismatchedFloors as unknown as Record<string, unknown>);
    expect(floors.ok).toBe(false);
    expect(floors.code).toBe('invariant_violation');

    const lowered: InheritanceEnvelope = JSON.parse(JSON.stringify(envelope));
    lowered.bounds.floors.vector_search = 0;
    lowered.effective_scoring.vector_search_floor = 0;
    (lowered as unknown as Record<string, unknown>).policy_hash = envelopePolicyHash(lowered as unknown as Record<string, unknown>);
    // A floor at zero is not even shaped like a floor: the CLOSED schema refuses it.
    expect(verifyEnvelope(lowered as unknown as Record<string, unknown>).code).toBe('schema_invalid');

    // 4. a read FOR USE refuses it rather than serving it: restore the deleted
    //    field and change a value instead, so the refusal is the HASH mismatch.
    stored().effective_scoring = (envelope as unknown as Record<string, any>).effective_scoring;
    stored().effective_scoring.relevance_multiplier = 3;
    const read = await readEnvelope(db.asDb(), envelope.envelope_id, OWNER);
    expect(read.envelope).toBeNull();
    // (the row was left carrying a missing field by the step above, so the
    // refusal is the closed schema's — both are named refusals, and the hash
    // mismatch is asserted on its own further down)
    expect(read.refusal?.code).toBe('policy_hash_mismatch');
    const listed = await listEnvelopes(db.asDb(), { parentUserId: OWNER.user_id, caller: OWNER });
    expect(listed.envelopes).toHaveLength(0);
    expect(listed.refusals[0].code).toBe('policy_hash_mismatch');
    expect(verifyEnvelope(envelopePayloadForHash(envelope as unknown as Record<string, unknown>)).code).toBe('schema_invalid');
  });

  it('the clamp helper is the documented arithmetic (k ±25%, fetch 1..20, cap tightened only)', async () => {
    const baseline = { k: 2, vector_fetch_limit: 5, cap_pct: 0.4 };
    expect(clampMutation('k', 100, baseline)).toMatchObject({ ok: true, clamp: { applied: 2.5, min: 1.5, max: 2.5 } });
    expect(clampMutation('k', 0.001, baseline)).toMatchObject({ ok: true, clamp: { applied: 1.5 } });
    expect(clampMutation('vector_fetch_limit', 3.4, baseline)).toMatchObject({ ok: true, clamp: { applied: 3 } });
    expect(clampMutation('vector_fetch_limit', 0, baseline)).toMatchObject({ ok: true, clamp: { applied: 1 } });
    expect(clampMutation('cap_pct', 0.2, baseline)).toMatchObject({ ok: true, clamp: { applied: 0.2 } });
    expect(clampMutation('cap_pct', 0.01, baseline)).toMatchObject({ ok: true, clamp: { applied: 0.05, clamped: true } });
    expect(clampMutation('cap_pct', 0.5, baseline)).toMatchObject({ ok: false, code: 'out_of_bounds' });
    // The bounds the envelope publishes come from the parent's own effective
    // configuration (regression guard: the two must not drift apart).
    await db.collection(SETTINGS).docs.push({ key: `personality_config:${OWNER.user_id}`, personality: 'legacy', version: 2 });
    const resolved = await resolvePersonalityConfig(db.asDb(), OWNER.user_id);
    expect(boundsFrom(resolved)).toEqual({
      message_priority: MESSAGE_PRIORITY,
      floors: boundsFrom(resolved).floors,
      caps: {
        max_single_source_pct: Math.min(1, baselineFrom(resolved).cap_pct),
        k_floor: Number((baselineFrom(resolved).k * 0.75).toFixed(6)),
        k_ceiling: Number((baselineFrom(resolved).k * 1.25).toFixed(6)),
        vector_fetch_limit_max: 20,
      },
      privacy_policy: 'immutable',
    });
  });
});

// ── D. the taint test ───────────────────────────────────────────────────────

describe('cognitive team — no private memory crosses', () => {
  it('markers in every private store never appear in an envelope, a mode assignment, an allocation report, a first-pass request or a synthesis output', async () => {
    const missionId = 'mission_taint';
    await seedMission(db, { missionId, ownerId: OWNER.user_id });
    const markers: string[] = [];
    for (const store of PRIVATE_STORES) {
      const marker = `TAINTMARK${store.toUpperCase().replace(/[^A-Z]/g, '')}END`;
      markers.push(marker);
      db.collection(store).docs.push({
        user_id: OWNER.user_id,
        mission_id: missionId,
        text: `private reflection: ${marker}`,
        statement: `a private statement ${marker}`,
        content: `private content ${marker}`,
        created_at: clock,
      });
    }
    // A trace with a marker in its signal STATEMENT: the agent's own generation
    // may read it (that is ITER-5/6's private path), but nothing this iteration
    // produces may carry it.
    const focused = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      cycleId: 'taint_trace',
      actorId: OWNER.user_id,
    });
    expect(focused.status).toBe('completed');
    const traceDoc = db
      .collection('salience_traces')
      .docs.find((row) => row.trace_id === focused.trace_id)!;
    traceDoc.signals[0].statement = `the trace says ${markers[3]}`;
    traceDoc.signals[0].why_operationally_relevant = `because ${markers[3]}`;

    const assignment = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      mode: 'creative',
      reason: `bridge the gap ${markers[0]}`,
      caller: OWNER,
      now,
    });
    const { envelope } = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId,
      childLabel: 'agent-child',
      mode: 'creative',
      caller: OWNER,
    });
    const allocation = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      candidates: [
        { identity: OWNER.user_id, mode: 'creative' },
        { identity: 'agent-peer', mode: 'verifier' },
      ],
      caller: OWNER,
    });
    const planned = await planFirstPass(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      team: [{ identity: OWNER.user_id, mode: 'creative', envelope_id: envelope.envelope_id }],
      caller: OWNER,
    });
    const ran = await runFirstPass(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      team: [{ identity: OWNER.user_id, mode: 'creative', envelope_id: envelope.envelope_id }],
      caller: OWNER,
      pass: planned.pass,
    });
    const synthesis = await synthesizePortfolios(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      portfolios: ran.results,
      caller: OWNER,
    });

    // The mode assignment carries the caller's reason verbatim — that is the
    // caller's own text, and it is private to the assignment. What must never
    // cross is the PRIVATE MEMORY: journals, reflections, traces, seeds,
    // beliefs.
    const surfaces: Array<[string, string]> = [
      ['envelope', JSON.stringify(envelope)],
      ['envelope hash input', JSON.stringify(envelopePayloadForHash(envelope as unknown as Record<string, unknown>))],
      ['mode assignment', JSON.stringify({ ...assignment, reason: 'redacted: caller-supplied' })],
      ['allocation report', JSON.stringify(allocation.portfolio)],
      ['first-pass request', JSON.stringify(planned.requests)],
      ['first-pass record', JSON.stringify(ran.pass)],
      ['synthesis', JSON.stringify(synthesis.portfolio)],
    ];
    for (const [label, surface] of surfaces) {
      for (const [index, marker] of markers.entries()) {
        // The assignment's reason is the CALLER's text (store index 0 is a
        // journal marker, not a reason), and the trace marker is index 3.
        expect(surface, `${label} leaked the ${PRIVATE_STORES[index]} marker`).not.toContain(marker);
      }
    }

    // The trace's marker DID reach the agent's own generation prompt — that is
    // ITER-5/6's private path, and it proves the taint scan is not vacuous.
    const enginePromptText = enginePrompts().join('\n');
    expect(enginePromptText).toContain(markers[3]);

    // …and the tool surfaces carry none of them either.
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    const toolOutputs = [
      txt(await dispatchCognitiveTeamTool('create_inheritance_envelope', {
        mission_id: missionId,
        child_label: 'agent-tool',
        mode: 'creative',
        user_id: OWNER.user_id,
      }, OWNER)),
      txt(await dispatchCognitiveTeamTool('allocate_cognitive_portfolio', {
        mission_id: missionId,
        candidates: [{ identity: OWNER.user_id, mode: 'creative' }],
        user_id: OWNER.user_id,
      }, OWNER)),
      txt(await dispatchCognitiveTeamTool('plan_independent_first_pass', {
        mission_id: missionId,
        team: [{ identity: OWNER.user_id, mode: 'creative' }],
        user_id: OWNER.user_id,
      }, OWNER)),
    ].join('\n');
    for (const marker of markers) expect(toolOutputs).not.toContain(marker);
  });

  it('an exclusion travels as a fingerprint: same ref, same reason, hash of the text', async () => {
    const missionId = 'mission_fingerprint';
    await seedMission(db, { missionId, ownerId: OWNER.user_id });
    await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      cycleId: 'fingerprint_trace',
      actorId: OWNER.user_id,
    });
    const planned = await planFirstPass(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      team: [{ identity: OWNER.user_id, mode: 'analyst' }],
      caller: OWNER,
    });
    const exclusions = planned.requests[0].mission_digest.exclusions;
    expect(exclusions.length).toBeGreaterThan(0);
    for (const exclusion of exclusions) {
      expect(Object.keys(exclusion).sort()).toEqual(['kind', 'reason', 'ref', 'text_hash']);
      expect(exclusion.text_hash).toMatch(/^[0-9a-f]{16}$/);
    }
    // The ruled-out hypothesis the fixture rejects is on the list, as a
    // fingerprint — and the text it fingerprints is nowhere in the request.
    expect(exclusions.some((entry) => entry.kind === 'rejected_hypothesis')).toBe(true);
    expect(JSON.stringify(planned.requests)).not.toContain('nightly compaction');
  });
});

// ── F. allocation ───────────────────────────────────────────────────────────

describe('cognitive team — portfolio allocation', () => {
  const mission = 'mission_allocation';

  it('reports the five weighted terms with their inputs, and is deterministic', async () => {
    await seedMission(db, { missionId: mission, ownerId: OWNER.user_id });
    const args = {
      userId: OWNER.user_id,
      missionId: mission,
      candidates: [
        { identity: OWNER.user_id, mode: 'creative' },
        { identity: 'agent-verifier', mode: 'verifier' },
      ],
      caller: OWNER,
    };
    const first = await allocatePortfolio(db.asDb(), args);
    const second = await allocatePortfolio(db.asDb(), args);
    expect(second.reused).toBe(true);
    expect(second.portfolio.portfolio_id).toBe(first.portfolio.portfolio_id);

    const portfolio = first.portfolio;
    expect(portfolio.weights).toEqual(ALLOCATION_WEIGHTS);
    expect(Object.values(ALLOCATION_WEIGHTS).reduce((total, value) => total + value, 0)).toBeCloseTo(1, 6);
    for (const row of portfolio.allocation_report) {
      expect(Object.keys(row.components).sort()).toEqual([
        'availability',
        'emotional_proximity',
        'missing_approach_coverage',
        'recent_success',
        'task_skill_fit',
      ]);
      for (const component of Object.values(row.components)) {
        expect(typeof component.source).toBe('string');
        expect(component.source.length).toBeGreaterThan(0);
        expect(component.value).toBeGreaterThanOrEqual(0);
        expect(component.value).toBeLessThanOrEqual(1);
        expect(component.weighted).toBeCloseTo(component.value * Number((component.detail as Record<string, unknown>).weight), 6);
      }
      // static = Σ weighted − convergence(peers) − load
      const weighted = Object.values(row.components).reduce((total, component) => total + component.weighted, 0);
      expect(row.static_score).toBeCloseTo(
        weighted - row.penalties.convergence.peer_component - row.penalties.load.value,
        6,
      );
      expect(row.penalties.convergence.value).toBeCloseTo(
        row.penalties.convergence.peer_component + row.penalties.convergence.duplicate_pick_component,
        6,
      );
    }
    // The coverage term really came from the archive's gaps.
    const coverageRows = portfolio.allocation_report.filter(
      (row) => row.components.missing_approach_coverage.source === 'idea_archive_cells coverage gaps',
    );
    expect(coverageRows.length).toBeGreaterThan(0);
    expect(portfolio.coverage_source.source).toBe('archive');
  });

  it('missing-bin coverage measurably DOMINATES the order among otherwise-equal agents', async () => {
    await seedMission(db, { missionId: mission, ownerId: OWNER.user_id });
    const bins = ['representation=graph', 'mechanism=reversal'];
    const { portfolio } = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId: mission,
      candidates: [
        { identity: 'agent-nocover', mode: 'analyst' },
        { identity: 'agent-covers', mode: 'creative' },
      ],
      missingBins: bins,
      caller: OWNER,
    });
    const covers = portfolio.allocation_report.find((row) => row.identity === 'agent-covers')!;
    const noCover = portfolio.allocation_report.find((row) => row.identity === 'agent-nocover')!;
    expect(covers.components.missing_approach_coverage.value).toBe(1);
    expect(noCover.components.missing_approach_coverage.value).toBe(0);
    expect(covers.selection_rank).toBe(1);
    expect(covers.selection_score - noCover.selection_score).toBeCloseTo(0.2, 6);
    // …and it is what the portfolio was built to cover.
    expect(portfolio.counts.bins_covered).toBe(2);
    expect([...portfolio.agents[0].covered_bins].sort()).toEqual([...bins].sort());
  });

  it('the convergence penalty DEMOTES a duplicate pick and the load penalty DEMOTES a loaded agent', async () => {
    await seedMission(db, { missionId: mission, ownerId: OWNER.user_id });
    const { portfolio } = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId: mission,
      candidates: [
        { identity: 'agent-lone', mode: 'analyst' },
        { identity: 'agent-loaded', mode: 'analyst', recent_cycles: maxCyclesPerWindow() },
        { identity: 'agent-twin-a', mode: 'creative' },
        { identity: 'agent-twin-b', mode: 'creative' },
        { identity: 'agent-other', mode: 'strategist' },
      ],
      missingBins: [],
      maxAgents: 3,
      caller: OWNER,
    });
    const report = new Map(portfolio.allocation_report.map((row) => [row.identity, row]));
    const lone = report.get('agent-lone')!;
    const loaded = report.get('agent-loaded')!;
    const twinA = report.get('agent-twin-a')!;
    const twinB = report.get('agent-twin-b')!;
    const other = report.get('agent-other')!;

    // The peers of a shared mode each pay the static peer penalty …
    expect(other.penalties.convergence.same_mode_peers).toBe(0);
    expect(other.penalties.convergence.peer_component).toBe(0);
    expect(twinA.penalties.convergence.same_mode_peers).toBe(1);
    expect(twinA.penalties.convergence.peer_component).toBe(CONVERGENCE_PENALTY_PER_PEER);
    expect(other.static_score - twinA.static_score).toBeCloseTo(CONVERGENCE_PENALTY_PER_PEER, 6);

    // The load penalty is the measured window load — the same static terms as
    // `agent-lone` minus the load.
    expect(loaded.penalties.load.value).toBeCloseTo(LOAD_PENALTY_WEIGHT, 6);
    expect(loaded.penalties.load.cycles_in_window).toBe(maxCyclesPerWindow());
    expect(loaded.penalties.load.max_cycles).toBe(maxCyclesPerWindow());
    expect(lone.static_score - loaded.static_score).toBeCloseTo(LOAD_PENALTY_WEIGHT, 6);

    // … and the order the portfolio actually came out in follows them.
    expect(other.selection_rank).toBe(1);
    expect(lone.selected).toBe(true);
    expect(loaded.selected).toBe(false);
    expect(lone.selection_rank!).toBeLessThan(loaded.selection_rank ?? Number.POSITIVE_INFINITY);

    // The SECOND pick of a mode pays the duplicate-pick penalty on top, which
    // is what keeps a same-mode pair out of the portfolio.
    expect(twinA.selected).toBe(true);
    expect(twinB.selected).toBe(false);
    expect(twinB.penalties.convergence.same_mode_selected).toBe(1);
    expect(twinB.penalties.convergence.duplicate_pick_component).toBe(CONVERGENCE_PENALTY_PER_DUPLICATE_PICK);
    expect(twinA.selection_score - twinB.selection_score).toBeCloseTo(CONVERGENCE_PENALTY_PER_DUPLICATE_PICK, 6);
    expect(twinB.selection_score).toBeLessThan(twinB.static_score);

    // A caller can move one term and see the order change.
    const flipped = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId: mission,
      candidates: [
        { identity: 'agent-lone', mode: 'analyst' },
        { identity: 'agent-loaded', mode: 'analyst', recent_cycles: maxCyclesPerWindow() },
      ],
      missingBins: [],
      maxAgents: 1,
      caller: OWNER,
      now: () => '2026-09-25T01:00:00.000Z',
    });
    expect(flipped.portfolio.agents.map((agent) => agent.identity)).toEqual(['agent-lone']);

    // … and a caller-supplied term can move it the other way.
    const weighted = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId: mission,
      candidates: [
        { identity: 'agent-lone', mode: 'analyst', task_skill_fit: 0.2, emotional_proximity: 0.2, availability: 0.2 },
        { identity: 'agent-loaded', mode: 'analyst', task_skill_fit: 1, emotional_proximity: 1, availability: 1 },
      ],
      missingBins: [],
      maxAgents: 1,
      caller: OWNER,
      now: () => '2026-09-25T02:00:00.000Z',
    });
    expect(weighted.portfolio.agents.map((agent) => agent.identity)).toEqual(['agent-loaded']);
  });

  it('reserves a verifier/critic that did NOT generate the candidate it will evaluate', async () => {
    await seedMission(db, { missionId: mission, ownerId: OWNER.user_id });
    const { portfolio } = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId: mission,
      candidates: [
        { identity: 'agent-creative', mode: 'creative' },
        { identity: 'agent-analyst', mode: 'analyst' },
        { identity: 'agent-verifier', mode: 'verifier' },
        { identity: 'agent-critic', mode: 'critic' },
      ],
      missingBins: [],
      caller: OWNER,
    });
    const reservation = portfolio.verifier_reservation;
    expect(reservation).toBeTruthy();
    expect(reservation!.reason).toBe('independent evaluator');
    expect(reservation!.independent).toBe(true);
    expect(['verifier', 'critic']).toContain(reservation!.mode);
    const generators = portfolio.agents.filter((agent) => agent.role === 'generator').map((agent) => agent.identity);
    expect(generators).not.toContain(reservation!.identity);
    expect(reservation!.evaluates.sort()).toEqual([...generators].sort());
    const evaluator = portfolio.agents.find((agent) => agent.role === 'evaluator');
    expect(evaluator?.identity).toBe(reservation!.identity);
    expect(portfolio.verifier_refusal).toBeNull();

    // With no evaluator-mode candidate at all, the portfolio says so by name.
    const withoutVerifier = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId: mission,
      candidates: [
        { identity: 'agent-creative', mode: 'creative' },
        { identity: 'agent-analyst', mode: 'analyst' },
      ],
      missingBins: [],
      caller: OWNER,
      now: () => '2026-09-25T02:00:00.000Z',
    });
    expect(withoutVerifier.portfolio.verifier_reservation).toBeNull();
    expect(withoutVerifier.portfolio.verifier_refusal).toContain('no verifier/critic candidate');
  });

  it('records the portfolio privately, verifies it on read, and refuses a tampered row', async () => {
    await seedMission(db, { missionId: mission, ownerId: OWNER.user_id });
    const { portfolio } = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId: mission,
      candidates: [{ identity: OWNER.user_id, mode: 'creative' }],
      missingBins: [],
      caller: OWNER,
    });
    const stored = portfolios().find((row) => row.portfolio_id === portfolio.portfolio_id)!;
    expect(stored.shared_id).toBeUndefined();
    expect(verifyPortfolio(stored).ok).toBe(true);
    stored.weights = { emotional_proximity: 1 } as never;
    expect(verifyPortfolio(stored).code).toBe('policy_hash_mismatch');
    const listed = await listPortfolios(db.asDb(), { userId: OWNER.user_id, missionId: mission, caller: OWNER });
    expect(listed.portfolios).toHaveLength(0);
    expect(listed.refusals[0].code).toBe('policy_hash_mismatch');
    await expect(getPortfolio(db.asDb(), portfolio.portfolio_id)).rejects.toThrow(/does not match the recomputed/);
  });
});

// ── G. the independent first pass ───────────────────────────────────────────

describe('cognitive team — the independent first pass', () => {
  it('each request carries only the mission digest, the agent\'s OWN envelope/mode and the public context', async () => {
    const missionId = 'mission_first_pass';
    const built = await buildTeam(
      missionId,
      { 'agent-philosopher': 'philosopher', 'agent-technician': 'technician' },
      { run: false },
    );
    const requests = built.pass.requests;
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(Object.keys(request).sort()).toEqual(
        [
          'agent',
          'blocked_reason',
          'engine',
          'envelope',
          'mission_digest',
          'mode_definition',
          'pass_id',
          'request_id',
          'schema_version',
          'status',
        ].sort(),
      );
      expect(request.agent.identity).toBe(request.envelope ? request.agent.identity : request.agent.identity);
      expect(request.mode_definition.attention_bias).toBe(COGNITIVE_MODES[request.agent.mode as 'philosopher'].attention_bias);
      // The envelope digest is the agent's OWN and carries no parent identity.
      expect(request.envelope?.disposition_profile).toBe('balanced');
      expect(JSON.stringify(request.envelope)).not.toContain(LEAD.user_id);
      // The public context: shapes, bins and fingerprints.
      for (const shape of request.mission_digest.trace_summary) {
        expect(Object.keys(shape).sort()).toEqual([
          'confidence',
          'intensity',
          'kind',
          'low_confidence',
          'signal_id',
          'valence',
        ]);
      }
      for (const exclusion of request.mission_digest.exclusions) {
        expect(Object.keys(exclusion).sort()).toEqual(['kind', 'reason', 'ref', 'text_hash']);
      }
      // No peer appears anywhere in the request.
      const peer = request.agent.identity === 'agent-philosopher' ? 'agent-technician' : 'agent-philosopher';
      expect(JSON.stringify(request)).not.toContain(peer);
    }
    // The pass is stored, verified and readable; nothing was generated yet.
    expect(built.pass.status).toBe('planned');
    expect(built.pass.results).toEqual([]);
    expect(enginePrompts()).toHaveLength(0);
    const storedPass = await readFirstPass(db.asDb(), built.pass.pass_id);
    expect(storedPass?.pass_id).toBe(built.pass.pass_id);
    expect(storedPass?.privacy).toEqual({ private_content_included: false, shared: false });
    expect(portfolios().find((row) => row.portfolio_id === built.pass.pass_id)!.shared_id).toBeUndefined();
  });

  it('captured engine prompts contain no PEER content, and each agent generated from its own archive', async () => {
    const missionId = 'mission_prompts';
    const built = await buildTeam(missionId, {
      'agent-philosopher': 'philosopher',
      'agent-technician': 'technician',
      'agent-strategist': 'strategist',
    });
    expect(built.results.every((result) => result.status === 'completed')).toBe(true);
    const promptText = enginePrompts();
    expect(promptText.length).toBeGreaterThanOrEqual(3);
    const identities = ['agent-philosopher', 'agent-technician', 'agent-strategist'];
    for (const identity of identities) {
      expect(promptText.join('\n')).not.toContain(identity);
    }
    expect(promptText.join('\n')).not.toContain(LEAD.user_id);
    // Every seed each agent generated is its own: no agent's seed id appears in
    // another agent's stored rows.
    const seedsPerAgent = seedOwners();
    for (const [identity, seedIds] of seedsPerAgent) {
      const peers = identities.filter((other) => other !== identity);
      for (const peer of peers) {
        const peerSeeds = seedsPerAgent.get(peer) ?? new Set<string>();
        for (const seedId of seedIds) expect(peerSeeds.has(seedId)).toBe(false);
      }
    }
    // Each agent's own prompts are distinct from its peers' — the mode is what
    // differentiates the team.
    const promptsByRequest = built.pass.requests.map(
      (request) => enginePrompts().filter((prompt) => prompt.includes(request.mission_digest.trace_id ?? '@')).length,
    );
    expect(promptsByRequest.every((count) => count >= 1)).toBe(true);
  });

  it('names a blocked request instead of generating anyway', async () => {
    const missionId = 'mission_blocked';
    await seedMission(db, { missionId, ownerId: LEAD.user_id });
    const created = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: LEAD.user_id,
      missionId,
      childLabel: 'agent-child',
      mode: 'creative',
      caller: LEAD,
    });
    // No trace for this identity ⇒ blocked, by name.
    const planned = await planFirstPass(db.asDb(), {
      userId: LEAD.user_id,
      missionId,
      team: [
        { identity: 'agent-nobody', mode: 'creative' },
        { identity: 'agent-mismatch', mode: 'critic', envelope_id: created.envelope.envelope_id },
      ],
      caller: LEAD,
    });
    const byIdentity = new Map(planned.requests.map((request) => [request.agent.identity, request]));
    expect(byIdentity.get('agent-nobody')!.status).toBe('blocked');
    expect(byIdentity.get('agent-nobody')!.blocked_reason).toBe('no_salience_trace');
    expect(byIdentity.get('agent-mismatch')!.blocked_reason).toBe('envelope_mode_mismatch');

    const ran = await runFirstPass(db.asDb(), {
      userId: LEAD.user_id,
      missionId,
      team: [
        { identity: 'agent-nobody', mode: 'creative' },
        { identity: 'agent-mismatch', mode: 'critic', envelope_id: created.envelope.envelope_id },
      ],
      caller: LEAD,
      pass: planned.pass,
    });
    expect(ran.results.every((result) => result.status === 'blocked')).toBe(true);
    expect(ran.pass.counts.blocked).toBe(2);
    expect(ran.pass.counts.generated).toBe(0);
    expect(enginePrompts()).toHaveLength(0);

    // An expired envelope blocks the request too.
    clock = '2026-10-05T00:00:00.000Z';
    const expired = await planFirstPass(db.asDb(), {
      userId: LEAD.user_id,
      missionId,
      team: [{ identity: 'agent-mismatch', mode: 'creative', envelope_id: created.envelope.envelope_id }],
      caller: LEAD,
      now,
    });
    expect(expired.requests[0].blocked_reason).toBe('envelope_expired');

    await expect(
      planFirstPass(db.asDb(), { userId: LEAD.user_id, missionId, team: [], caller: LEAD }),
    ).rejects.toThrow(FirstPassError);
  });

  it('the mode reaches the engine through the plan spread and the operator budget', async () => {
    const missionId = 'mission_spread';
    const built = await buildTeam(missionId, { 'agent-strategist': 'strategist', 'agent-philosopher': 'philosopher' });
    const byMode = new Map(built.results.map((result) => [result.mode, result]));
    expect(byMode.get('strategist')!.engine_mode).toBe('exploit');
    expect(byMode.get('philosopher')!.engine_mode).toBe('explore');
    const requestOf = (identity: string) => built.pass.requests.find((request) => request.agent.identity === identity)!;
    expect(requestOf('agent-strategist').mode_definition.operator_budget).toBe(
      COGNITIVE_MODES.strategist.operator_budget,
    );
    // The engine recorded the mode's settings on its own run rows.
    const runs = db.collection('imagination_runs').docs as Array<Record<string, any>>;
    const dispositions = runs.map((row) => String(row.disposition ?? ''));
    expect(dispositions.some((value) => value.includes('mode:strategist'))).toBe(true);
    expect(dispositions.some((value) => value.includes('mode:philosopher'))).toBe(true);
  });
});

// ── H. synthesis ────────────────────────────────────────────────────────────

describe('cognitive team — synthesis preserves provenance and exclusions', () => {
  it('merges with per-candidate provenance, carries exclusions verbatim, appends a lineage record and cannot promote', async () => {
    const missionId = 'mission_synthesis';
    const built = await buildTeam(missionId, {
      'agent-philosopher': 'philosopher',
      'agent-philosopher-b': 'philosopher',
      'agent-technician': 'technician',
    });
    const result = await synthesizePortfolios(db.asDb(), {
      userId: LEAD.user_id,
      missionId,
      portfolios: built.results,
      synthesizer: { identity: 'agent-synth', mode: 'synthesizer' },
      caller: LEAD,
    });
    expect(result.synthesized).toBe(true);
    const portfolio = result.portfolio!;
    expect(portfolio.promoted).toBe(false);
    expect(portfolio.privacy).toEqual({ private_content_included: false, shared: false });
    expect(portfolio.lineage).toHaveLength(1);
    expect(portfolio.lineage[0].kind).toBe('synthesis');
    expect(portfolio.lineage[0].by).toBe('agent-synth');
    expect(portfolio.lineage[0].sources).toHaveLength(3);

    // Provenance per candidate: every source agent that produced it is kept.
    const sourcesSeen = new Set<string>();
    for (const candidate of portfolio.candidates) {
      expect(candidate.provenance.length).toBeGreaterThan(0);
      for (const entry of candidate.provenance) {
        expect(entry.source_agent).toBeTruthy();
        expect(entry.source_mode).toBeTruthy();
        expect(entry.source_seed_id).toBe(candidate.seed_id === entry.source_seed_id ? entry.source_seed_id : entry.source_seed_id);
        sourcesSeen.add(entry.source_agent);
      }
      expect(candidate.merged_from).toBe(candidate.provenance.length);
    }
    expect(sourcesSeen.size).toBe(3);
    // The two same-mode agents produced identical statements: the merge
    // collapses the statement, never the lineage.
    const merged = portfolio.candidates.filter((candidate) => candidate.merged_from > 1);
    expect(merged.length).toBeGreaterThan(0);
    expect(portfolio.counts.merged).toBeGreaterThan(0);
    expect(portfolio.counts.candidates_in).toBeGreaterThan(portfolio.counts.candidates_out);

    // Exclusions verbatim, and the stored row is private and un-promoted.
    const sourceExclusions = built.results.flatMap((entry) => entry.exclusions);
    const byRef = new Map(portfolio.exclusions.map((exclusion) => [exclusion.ref, exclusion]));
    for (const exclusion of sourceExclusions) {
      expect(byRef.get(exclusion.ref)).toEqual(exclusion);
    }
    const stored = portfolios().find((row) => row.portfolio_id === portfolio.portfolio_id)!;
    expect(stored.shared_id).toBeUndefined();
    expect(stored.promoted).toBe(false);
    expect(verifyPortfolio(stored).ok).toBe(true);
  });

  it('REFUSES an attempt to drop or rewrite an exclusion', async () => {
    const missionId = 'mission_synth_refusal';
    const built = await buildTeam(missionId, { 'agent-analyst': 'analyst' });
    const source = built.results[0];
    expect(source.exclusions.length).toBeGreaterThan(0);
    const intact = source.exclusions;

    const dropped = await synthesizePortfolios(db.asDb(), {
      userId: LEAD.user_id,
      missionId,
      portfolios: [source],
      exclusions: intact.slice(1) as PortfolioExclusion[],
      caller: LEAD,
    });
    expect(dropped.synthesized).toBe(false);
    expect(dropped.code).toBe('exclusion_dropped');
    expect(dropped.refusals[0].ref).toBe(intact[0].ref);
    expect(dropped.portfolio).toBeNull();

    const rewritten = await synthesizePortfolios(db.asDb(), {
      userId: LEAD.user_id,
      missionId,
      portfolios: [source],
      exclusions: intact.map((exclusion, index) =>
        index === 0 ? { ...exclusion, reason: 'it no longer applies' } : exclusion,
      ),
      caller: LEAD,
    });
    expect(rewritten.synthesized).toBe(false);
    expect(rewritten.code).toBe('exclusion_rewritten');
    expect(rewritten.refusals[0].reason).toContain('verbatim');

    // Nothing was written by either refusal.
    const stored = portfolios().filter((row) => row.kind === 'synthesis');
    expect(stored).toHaveLength(0);

    // Carrying them verbatim succeeds, and the exclusions come back byte-identical.
    const ok = await synthesizePortfolios(db.asDb(), {
      userId: LEAD.user_id,
      missionId,
      portfolios: [source],
      exclusions: intact,
      caller: LEAD,
    });
    expect(ok.synthesized).toBe(true);
    expect(ok.portfolio!.exclusions).toEqual(intact);
  });

  it('a synthesizer cannot promote, and the surface it returns is a private row', async () => {
    const missionId = 'mission_synth_private';
    const built = await buildTeam(missionId, { 'agent-technician': 'technician' });
    const result = await synthesizePortfolios(db.asDb(), {
      userId: LEAD.user_id,
      missionId,
      portfolios: built.results,
      caller: LEAD,
    });
    const stored = portfolios().find((row) => row.portfolio_id === result.portfolio!.portfolio_id)!;
    expect('shared_id' in stored).toBe(false);
    expect(JSON.stringify(stored)).not.toContain('my-team');
  });
});

// ── I. the flag and the surface ─────────────────────────────────────────────

describe('cognitive team — the flag gates the whole family', () => {
  it('with COGNITIVE_TEAM_ALLOCATION off every tool is `Unknown tool`, and nothing is written', async () => {
    expect(cognitiveTeamAllocationEnabled()).toBe(false);
    for (const tool of COGNITIVE_TEAM_TOOL_NAMES) {
      await expect(dispatchCognitiveTeamTool(tool, {}, OWNER)).rejects.toThrow(`Unknown tool: ${tool}`);
    }
    await expect(dispatchCognitiveTeamTool('assign_thinking_mode', {}, OWNER)).rejects.toThrow('Unknown tool');
    expect(assignments()).toHaveLength(0);
    expect(envelopes()).toHaveLength(0);
    expect(portfolios()).toHaveLength(0);
    expect(enginePrompts()).toHaveLength(0);
    expect(db.collection(PORTFOLIOS).docs).toEqual([]);
  });

  it('with the flag on the six tools answer, and a bad payload is refused readably', async () => {
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    expect(cognitiveTeamAllocationEnabled()).toBe(true);
    expect(COGNITIVE_TEAM_TOOL_NAMES).toHaveLength(6);
    const missionId = 'mission_tools';
    await seedMission(db, { missionId, ownerId: OWNER.user_id });

    const assigned = txt(
      await dispatchCognitiveTeamTool(
        'assign_thinking_mode',
        { mission_id: missionId, mode: 'analyst', reason: 'calibrate', user_id: OWNER.user_id },
        OWNER,
      ),
    );
    expect(assigned).toContain('Thinking mode assigned');
    expect(assigned).toContain('Attention bias (verbatim)');
    expect(assigned).toContain(COGNITIVE_MODES.analyst.obligation);
    expect(assigned).toContain('expires');

    const active = txt(
      await dispatchCognitiveTeamTool('get_active_mode', { mission_id: missionId, user_id: OWNER.user_id }, OWNER),
    );
    expect(active).toContain('Active thinking mode');
    expect(active).toContain('no cron');

    const envelope = txt(
      await dispatchCognitiveTeamTool(
        'create_inheritance_envelope',
        {
          mission_id: missionId,
          child_label: 'agent-child',
          mode: 'analyst',
          mutations: [{ dimension: 'message_priority', value: 1 }, { dimension: 'k', value: 99 }],
          user_id: OWNER.user_id,
        },
        OWNER,
      ),
    );
    expect(envelope).toContain('Inheritance envelope created');
    expect(envelope).toContain('message_priority 10');
    expect(envelope).toContain('Refused mutations (1)');
    expect(envelope).toContain('immutable_invariant');
    expect(envelope).toContain('CLAMPED');

    const allocation = txt(
      await dispatchCognitiveTeamTool(
        'allocate_cognitive_portfolio',
        {
          mission_id: missionId,
          candidates: [
            { identity: OWNER.user_id, mode: 'analyst' },
            { identity: 'agent-verifier', mode: 'verifier' },
          ],
          user_id: OWNER.user_id,
        },
        OWNER,
      ),
    );
    expect(allocation).toContain('Portfolio allocated');
    expect(allocation).toContain('Independent evaluator');
    expect(allocation).toContain('Allocation report');

    const planned = txt(
      await dispatchCognitiveTeamTool(
        'plan_independent_first_pass',
        { mission_id: missionId, team: [{ identity: OWNER.user_id, mode: 'analyst' }], user_id: OWNER.user_id },
        OWNER,
      ),
    );
    expect(planned).toContain('Planned');
    expect(planned).toContain('Requests');

    const invalid = txt(
      await dispatchCognitiveTeamTool('assign_thinking_mode', { mission_id: missionId }, OWNER),
    );
    expect(invalid).toContain('❌ Invalid arguments for assign_thinking_mode');
    const unknown = await dispatchCognitiveTeamTool('no_such_tool', {}, OWNER).catch((error) => String(error));
    expect(String(unknown)).toContain('Unknown tool');
  });

  it('an untrusted caller cannot act for another identity through the tools', async () => {
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    const missionId = 'mission_tool_pinning';
    await seedMission(db, { missionId, ownerId: OWNER.user_id });
    const impersonate = txt(
      await dispatchCognitiveTeamTool(
        'assign_thinking_mode',
        { mission_id: missionId, mode: 'critic', reason: 'for someone else', user_id: 'agent-victim' },
        OTHER,
      ),
    );
    expect(impersonate).toContain('Not authorized');
    expect(assignments()).toHaveLength(0);

    await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      mode: 'analyst',
      reason: 'the mission wants calibration',
      caller: OWNER,
      now,
    });
    const readOther = txt(
      await dispatchCognitiveTeamTool('get_active_mode', { mission_id: missionId, user_id: OWNER.user_id }, OTHER),
    );
    expect(readOther).toContain('Not authorized');
    expect(readOther).not.toContain('the mission wants calibration');
    // …and an untrusted caller reading ITS OWN mode is served, not refused.
    const readSelf = txt(
      await dispatchCognitiveTeamTool('get_active_mode', { mission_id: missionId, user_id: OTHER.user_id }, OTHER),
    );
    expect(readSelf).toContain('No thinking mode recorded for agent-b');

    const allocateOther = txt(
      await dispatchCognitiveTeamTool(
        'allocate_cognitive_portfolio',
        { mission_id: missionId, candidates: [{ identity: OWNER.user_id, mode: 'analyst' }], user_id: OWNER.user_id },
        OTHER,
      ),
    );
    expect(allocateOther).toContain('Not authorized');
    expect(portfolios()).toHaveLength(0);
  });

  it('pins service-level reads and writes as well as the transport', async () => {
    await expect(
      listAssignments(db.asDb(), { userId: OWNER.user_id, caller: OTHER }),
    ).rejects.toThrow(ModeAccessError);
    await expect(
      createInheritanceEnvelope(db.asDb(), {
        parentUserId: OWNER.user_id,
        missionId: 'm',
        childLabel: 'child',
        caller: OTHER,
      }),
    ).rejects.toThrow(/may not create an inheritance envelope/);
    await expect(
      listEnvelopes(db.asDb(), { parentUserId: OWNER.user_id, caller: OTHER }),
    ).rejects.toThrow(/may not list/);
    await expect(
      allocatePortfolio(db.asDb(), {
        userId: OWNER.user_id,
        missionId: 'm',
        candidates: [{ identity: OWNER.user_id, mode: 'analyst' }],
        caller: OTHER,
      }),
    ).rejects.toThrow(/may not allocate/);
    await expect(
      synthesizePortfolios(db.asDb(), {
        userId: OWNER.user_id,
        missionId: 'm',
        portfolios: [{ identity: OWNER.user_id, mode: 'analyst', engine_mode: 'balanced', status: 'completed', cycle_id: null, run_id: null, trace_id: null, problem_state_digest: null, seeds: [], rejections: [], exclusions: [], seeds_generated: 0, seeds_admitted: 0, seeds_rejected: 0, llm_calls: 0, error: null, blocked_reason: null } as FirstPassAgentResult],
        caller: OTHER,
      }),
    ).rejects.toThrow(/may not synthesize/);
  });
});

// ── J. THE EXIT CRITERION ───────────────────────────────────────────────────

describe('exit criterion — same model, different modes', () => {
  it('three agents in different modes show measurably LOWER idea similarity than the same-mode control', async () => {
    // The brief's §7.4 experiment design, on the frozen fixture: the SAME mission
    // content (state, ledger, work queue, graph and one real ITER-5 trace per
    // identity) is replayed at several frozen checkpoints, so the candidate
    // inventory and the evidence are identical across conditions and a single
    // lucky operator draw cannot decide the result. Every agent holds the SAME
    // personality profile (the deployment default, `balanced`) and differs only
    // in its MODE — one from each of the catalogue's three engine spreads:
    // `philosopher` (explore, six operator families), `analyst` (balanced,
    // three) and `strategist` (exploit, two).
    const CHECKPOINTS = ['alpha', 'beta', 'gamma'];
    const TREATMENT_MODES = {
      'agent-philosopher': 'philosopher',
      'agent-analyst': 'analyst',
      'agent-strategist': 'strategist',
    };
    const CONTROL_EXPLORE_MODES = {
      'agent-phi-a': 'philosopher',
      'agent-phi-b': 'philosopher',
      'agent-phi-c': 'philosopher',
    };
    const CONTROL_BALANCED_MODES = {
      'agent-ana-a': 'analyst',
      'agent-ana-b': 'analyst',
      'agent-ana-c': 'analyst',
    };
    // ITER-11 (WS-4 item 5, the reviewer's de-artifacting finding): a SECOND
    // same-mode control at a DIFFERENT frozen checkpoint — i.e. the same three
    // identities and the same mode under a different trace id, a different cycle
    // id and therefore a different PRNG seed. If the treatment's divergence were
    // seed noise, this control would drift away from the first one; if the
    // collapse is what a single mode does, the two controls are identical.
    const CONTROL_SEEDED_MODES = {
      'agent-ana-a': 'analyst',
      'agent-ana-b': 'analyst',
      'agent-ana-c': 'analyst',
    };

    const treatment: FirstPassAgentResult[][] = [];
    const controlExplore: FirstPassAgentResult[][] = [];
    const controlBalanced: FirstPassAgentResult[][] = [];
    const controlSeeded: FirstPassAgentResult[][] = [];
    for (const checkpoint of CHECKPOINTS) {
      treatment.push((await buildTeam(`exit_treatment_${checkpoint}`, TREATMENT_MODES)).results);
      controlExplore.push((await buildTeam(`exit_control_explore_${checkpoint}`, CONTROL_EXPLORE_MODES)).results);
      controlBalanced.push((await buildTeam(`exit_control_balanced_${checkpoint}`, CONTROL_BALANCED_MODES)).results);
      // A different family of checkpoint names (and therefore a different seed
      // stream) for the same-mode control.
      controlSeeded.push((await buildTeam(`exit_seeded_control_${checkpoint}`, CONTROL_SEEDED_MODES)).results);
    }

    // (a) the modes — and the dispositions they resolve to — actually differed.
    expect(new Set(Object.values(TREATMENT_MODES)).size).toBe(3);
    for (const group of treatment) {
      for (const result of group) {
        expect(['completed', 'reused']).toContain(result.status);
        expect(result.seeds.length).toBeGreaterThan(0);
      }
    }
    const planning = await buildTeam('exit_treatment_planning', TREATMENT_MODES, { run: false });
    const envelopesSeen = new Set<string>();
    const scoringSeen = new Set<string>();
    const profileSeen = new Set<string>();
    for (const request of planning.pass.requests) {
      envelopesSeen.add(request.envelope!.envelope_id);
      scoringSeen.add(JSON.stringify(request.envelope!.effective_scoring));
      profileSeen.add(request.envelope!.disposition_profile);
    }
    expect(envelopesSeen.size).toBe(3);
    expect(scoringSeen.size).toBe(3);
    expect(profileSeen).toEqual(new Set(['balanced']));
    // The parent's own configuration is the source of every bound, and none of
    // the runs above modified it.
    const parent = await resolvePersonalityConfig(db.asDb(), LEAD.user_id);
    const parentScoring = effectivePersonalityConfig(parent).scoring as Record<string, unknown>;
    for (const request of planning.pass.requests) {
      expect(request.envelope!.bounds.caps.max_single_source_pct).toBeLessThanOrEqual(
        Number(parentScoring.max_single_source_pct),
      );
      expect(request.envelope!.bounds.message_priority).toBe(MESSAGE_PRIORITY);
    }

    // (b) the measurement.
    const measured = aggregate(treatment);
    const controlA = aggregate(controlExplore);
    const controlB = aggregate(controlBalanced);
    const controlSeed = aggregate(controlSeeded);

    /**
     * ITER-11 (WS-4 item 5): divergence of the OPERATOR PLAN, reported beside
     * the statement similarity. For each agent the plan is the set of operators
     * it actually ran; two agents "agree" on the plan when their operator sets
     * are equal. This number does NOT depend on the model's prose at all — it is
     * the mechanism the modes are supposed to move — so it is the honest
     * counterweight to the statement-level magnitudes, which are
     * stub-determined.
     */
    const operatorPlans = (group: FirstPassAgentResult[]): Set<string>[] =>
      group.map((result) => new Set(result.seeds.map((seed) => seed.operator)));
    const planDivergence = (checkpoints: FirstPassAgentResult[][]): { mean_plan_jaccard: number; unique_operator_share: number } => {
      const jaccards: number[] = [];
      const unique: number[] = [];
      for (const group of checkpoints) {
        const plans = operatorPlans(group);
        for (let i = 0; i < plans.length; i += 1) {
          for (let j = i + 1; j < plans.length; j += 1) {
            const shared = [...plans[i]].filter((operator) => plans[j].has(operator)).length;
            const union = new Set([...plans[i], ...plans[j]]).size;
            jaccards.push(shared / Math.max(1, union));
          }
          const peers = new Set(plans.filter((_entry, index) => index !== i).flatMap((plan) => [...plan]));
          unique.push([...plans[i]].filter((operator) => !peers.has(operator)).length / Math.max(1, plans[i].size));
        }
      }
      const mean = (values: number[]): number =>
        Number((values.reduce((total, value) => total + value, 0) / Math.max(1, values.length)).toFixed(4));
      return { mean_plan_jaccard: mean(jaccards), unique_operator_share: mean(unique) };
    };
    const treatmentPlan = planDivergence(treatment);
    const controlAPlan = planDivergence(controlExplore);
    const controlBPlan = planDivergence(controlBalanced);
    const controlSeedPlan = planDivergence(controlSeeded);

    // eslint-disable-next-line no-console
    console.log(
      [
        'EXIT CRITERION — pairwise statement similarity between agent portfolios',
        '  STATEMENT-LEVEL MAGNITUDES ARE STUB-DETERMINED: the model is a scripted stub whose',
        '  text depends only on the operator family, so these numbers show the PLUMBING (modes ⇒',
        '  different operators ⇒ different text) and are NOT evidence that a real model diverges.',
        `  treatment (philosopher/analyst/strategist, ${CHECKPOINTS.length} frozen checkpoints):`,
        `    jaccard ${JSON.stringify(measured.jaccard)} mean ${measured.jaccard_mean}`,
        `    closest ${JSON.stringify(measured.closest)} mean ${measured.closest_mean}`,
        `    mean per checkpoint ${JSON.stringify(measured.per_checkpoint)}`,
        `    unique-to-one-agent share ${measured.unique_share}`,
        `    OPERATOR PLAN divergence: jaccard ${treatmentPlan.mean_plan_jaccard} · operators unique to one agent ${treatmentPlan.unique_operator_share}`,
        `    portfolio sizes ${JSON.stringify(treatment.flat().map((result) => result.seeds.length))}`,
        `  control A (all philosopher): jaccard mean ${controlA.jaccard_mean} ${JSON.stringify(controlA.jaccard)} · closest mean ${controlA.closest_mean} · unique share ${controlA.unique_share} · plan jaccard ${controlAPlan.mean_plan_jaccard}`,
        `  control B (all analyst):     jaccard mean ${controlB.jaccard_mean} ${JSON.stringify(controlB.jaccard)} · closest mean ${controlB.closest_mean} · unique share ${controlB.unique_share} · plan jaccard ${controlBPlan.mean_plan_jaccard}`,
        `  control C (all analyst, SEED VARIED): jaccard mean ${controlSeed.jaccard_mean} ${JSON.stringify(controlSeed.jaccard)} · closest mean ${controlSeed.closest_mean} · unique share ${controlSeed.unique_share} · plan jaccard ${controlSeedPlan.mean_plan_jaccard}`,
        '  REPRODUCIBLE: the trace ids come from the pinned stream (the `node:crypto` mock at the top of this',
        '  file), so every number above is the same on every run — whole file or `-t` filtered. The CHANGELOG',
        '  quotes THESE numbers; run this test to re-derive them.',
      ].join('\n'),
    );

    expect(measured.jaccard_mean).toBeLessThan(controlA.jaccard_mean);
    expect(measured.jaccard_mean).toBeLessThan(controlB.jaccard_mean);
    expect(measured.closest_mean).toBeLessThan(controlA.closest_mean);
    expect(measured.closest_mean).toBeLessThan(controlB.closest_mean);
    // The control is the collapse the design prevents: one mode, one stream, one
    // portfolio — every agent produced exactly what its peers produced.
    for (const entry of controlA.jaccard) expect(entry).toBe(1);
    for (const entry of controlB.jaccard) expect(entry).toBe(1);
    expect(controlA.unique_share).toBe(0);
    expect(controlB.unique_share).toBe(0);
    expect(measured.unique_share).toBeGreaterThan(0);
    expect(measured.jaccard_mean).toBeLessThan(1);

    // (b2) THE SEED IS NOT THE EXPLANATION. The second same-mode control runs
    //      the same identities and mode under different checkpoints (different
    //      trace ids, cycle ids and PRNG seeds) and collapses EXACTLY as the
    //      first one did — so the treatment's divergence is not seed noise. Its
    //      portfolios are also statement-for-statement identical to control B's,
    //      which is the stub's own signature: with one mode the seed changes
    //      nothing.
    expect(controlSeed.jaccard).toEqual(controlB.jaccard);
    expect(controlSeed.closest).toEqual(controlB.closest);
    expect(controlSeed.unique_share).toEqual(controlB.unique_share);
    expect(controlSeed.jaccard.every((entry) => entry === 1)).toBe(true);
    // …and SEED VARIATION ALONE leaves the portfolios nearly identical: the two
    // same-mode controls pooled together (six analyst agents across six
    // checkpoints, six different seeds) still agree far more than the three-mode
    // treatment does. (Not exactly 1.0: the identity-seeded bridge walk can find
    // a path for one agent and not its peer, which changes which operators RUN —
    // an operator-plan effect, not a text effect.)
    const crossControl = pairwiseMeasurements([...controlBalanced.flat(), ...controlSeeded.flat()]);
    // eslint-disable-next-line no-console
    console.log(
      `  cross-control (same mode, SEED VARIED, pooled): jaccard mean ${crossControl.jaccard_mean} ${JSON.stringify(crossControl.jaccard)} · closest mean ${crossControl.closest_mean}`,
    );
    expect(crossControl.jaccard_mean).toBeGreaterThan(measured.jaccard_mean);
    expect(crossControl.jaccard_mean).toBeGreaterThanOrEqual(0.8);

    // (b3) THE OPERATOR PLAN carries the divergence independently of the text:
    //      same-mode agents run plans that largely coincide (their modes fix the
    //      spread), while the three-mode treatment's plans diverge far more —
    //      and this number owes nothing to the stub's prose.
    expect(treatmentPlan.mean_plan_jaccard).toBeLessThan(controlAPlan.mean_plan_jaccard);
    expect(treatmentPlan.mean_plan_jaccard).toBeLessThan(controlBPlan.mean_plan_jaccard);
    expect(treatmentPlan.mean_plan_jaccard).toBeLessThan(controlSeedPlan.mean_plan_jaccard);
    expect(treatmentPlan.mean_plan_jaccard).toBeLessThan(1);
    expect(treatmentPlan.unique_operator_share).toBeGreaterThan(0);

    // (b3b) REPRODUCIBILITY — the ids every number above rests on come from the
    //      PINNED uuid stream (see the `node:crypto` mock at the top of this
    //      file), not from a real `randomUUID`. Without the pin the plan numbers
    //      moved run to run (0.3519, 0.2815, 0.3519, 0.2778 across four runs of
    //      the unchanged code, and 0.3333 in the reviewer's run), which is why
    //      the CHANGELOG's ITER-8 entry could not reproduce its own figure: the
    //      trace id is hashed into the signal ids and then into each agent's
    //      generation seed. The assertion is on the MECHANISM rather than on the
    //      digits, so a legitimate fixture change does not fail it for the wrong
    //      reason — a real `randomUUID` does.
    const traceIds = (db.collection('salience_traces').docs as Array<Record<string, any>>).map((row) => String(row.trace_id));
    expect(traceIds.length).toBeGreaterThan(0);
    for (const traceId of traceIds) {
      expect(traceId, `unpinned trace id ${traceId} — the divergence numbers would not reproduce`).toMatch(
        /^00000000-0000-4000-8000-\d{12}$/,
      );
    }

    // (c) no private content crossed: markers in every private store, planted
    //     once the generation is done, are absent from every surface the runs
    //     produced (the same construction as the taint suite). What the scan
    //     proves is not vacuous: the agents' OWN trace text did reach their own
    //     generation (asserted by the taint suite) — it is PEER content and the
    //     private stores that must not cross into these artifacts.
    const markers = PRIVATE_STORES.map((store) => `XTAINTX${store.toUpperCase()}XENDX`);
    for (const [index, store] of PRIVATE_STORES.entries()) {
      db.collection(store).docs.push({ user_id: LEAD.user_id, text: markers[index], created_at: clock });
    }
    const surfaces = [JSON.stringify(planning.pass.requests), JSON.stringify(treatment), JSON.stringify(portfolios())].join('\n');
    for (const marker of markers) expect(surfaces).not.toContain(marker);

    // (d) each agent's request carried no peer data.
    for (const request of planning.pass.requests) {
      const peers = Object.keys(TREATMENT_MODES).filter((identity) => identity !== request.agent.identity);
      const serialized = JSON.stringify(request);
      for (const peer of peers) expect(serialized).not.toContain(peer);
      expect(serialized).not.toContain(LEAD.user_id);
      expect(request.status).toBe('ready');
    }
  }, 120000);
});

// ── K. the refinements a verifier asked for ─────────────────────────────────

/**
 * Each of these tests was written to FAIL against the sources as they stood
 * before this round of fixes (the exact failures are reported with the
 * refinement): the duplicate-pick penalty was inert at selection time, a stale
 * read could shorten a live mode, the portfolio id moved with the candidate list
 * order, the reason/TTL bounds lived only in the MCP schema, `assignMode` never
 * looked at mission status, a prototype key was refused as the invariant
 * `undefined`, `get_active_mode` silently pinned an untrusted caller that named
 * another identity while the text implied a mission-owner read, and a
 * synthesizer-supplied exclusion that was not on record was neither carried nor
 * named.
 */
describe('cognitive team — the refinement fixes', () => {
  it('measures the duplicate-pick penalty AT SELECTION TIME, on the selected set', async () => {
    const missionId = 'mission_selection_time_penalty';
    await seedMission(db, { missionId, ownerId: OWNER.user_id });
    // Three candidates whose STATIC scores are equal by construction: the two
    // analysts each pay the static peer penalty (−0.2) and are compensated by a
    // task-skill-fit they agree on, so nothing but the duplicate-pick cost can
    // separate bravo from charlie. `agent-alpha` covers the mission's one
    // missing bin, so it is selected first by the coverage pass — leaving bravo
    // (the SECOND analyst) against charlie (a different mode) for the last slot.
    const { portfolio } = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      candidates: [
        { identity: 'agent-alpha', mode: 'analyst', covered_bins: ['representation=graph'], task_skill_fit: 1 },
        { identity: 'agent-bravo', mode: 'analyst', task_skill_fit: 1 },
        { identity: 'agent-charlie', mode: 'creative', covered_bins: ['test_strategy=ab_test'], task_skill_fit: 0.2 },
      ],
      missingBins: ['representation=graph'],
      maxAgents: 2,
      caller: OWNER,
      now: () => '2026-09-25T03:00:00.000Z',
    });

    // The SELECTED SET is the assertion: the second analyst loses to the
    // different-mode candidate. (Before the fix the comparison read a
    // `duplicatePicks` field that was only written after a win, so bravo and
    // charlie tied and the identity tie-break seated bravo.)
    expect(portfolio.agents.map((agent) => agent.identity)).toEqual(['agent-alpha', 'agent-charlie']);

    const report = new Map(portfolio.allocation_report.map((row) => [row.identity, row]));
    const bravo = report.get('agent-bravo')!;
    const charlie = report.get('agent-charlie')!;
    expect(bravo.static_score).toBeCloseTo(charlie.static_score, 6);
    expect(bravo.selected).toBe(false);
    expect(charlie.selected).toBe(true);
    // … and the margin by which the second analyst lost is EXACTLY the
    // documented duplicate-pick penalty.
    expect(charlie.selection_score - bravo.selection_score).toBeCloseTo(CONVERGENCE_PENALTY_PER_DUPLICATE_PICK, 6);
    expect(bravo.penalties.convergence.duplicate_pick_component).toBe(CONVERGENCE_PENALTY_PER_DUPLICATE_PICK);
    expect(bravo.penalties.convergence.same_mode_selected).toBe(1);
  });

  it('cannot shorten a LIVE mode: a renewal that lands mid-read survives the stale expiry write', async () => {
    const missionId = 'mission_stale_read';
    const assignment = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      mode: 'analyst',
      reason: 'the mission needs calibrated confidence',
      ttlMs: 60_000,
      caller: OWNER,
      now: () => '2026-09-25T00:00:00.000Z',
    });
    expect(assignment.expires_at).toBe('2026-09-25T00:01:00.000Z');

    // INTERLEAVE: this read starts with a clock (00:02:00) that says the
    // assignment lapsed, so it will compute `expired` and prepare its guarded
    // write. The renewal was ISSUED while the mode was still live (00:00:30 <
    // its 00:01:00 expiry) but its write lands after the read has already
    // snapshotted the lapsed row — the slow-renewal interleave. The wrapper
    // fires once, so the renewal's own updateOne is not re-entered.
    const collection = db.collection(ASSIGNMENTS);
    const originalUpdateOne = collection.updateOne.bind(collection);
    let interleaved = false;
    const wrapped = async (filter: Record<string, any>, update: Record<string, any>, opts?: any) => {
      if (!interleaved) {
        interleaved = true;
        await renewMode(db.asDb(), {
          assignmentId: assignment.assignment_id,
          reason: 'the exploration needs another window',
          ttlMs: 300_000,
          caller: OWNER,
          now: () => '2026-09-25T00:00:30.000Z',
        });
      }
      return originalUpdateOne(filter, update, opts);
    };
    (collection as unknown as { updateOne: unknown }).updateOne = wrapped;

    const read = await activeMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      caller: OWNER,
      now: () => '2026-09-25T00:02:00.000Z',
    });
    expect(interleaved).toBe(true);

    // The renewal WON: the stored window is the renewed one (max(00:00:30,
    // 00:01:00) + 300s), the row is still ACTIVE and no expiry was recorded by
    // the stale read.
    const stored = assignments()[0];
    const renewedExpiresAt = String(stored.expires_at);
    expect(stored.renewals).toHaveLength(1);
    expect(renewedExpiresAt).toBe('2026-09-25T00:06:00.000Z');
    expect(stored.status).toBe('active');
    expect(stored.expiry).toBeNull();
    expect(read.active).toBe(true);
    expect(read.assignment?.expires_at).toBe(renewedExpiresAt);
    expect(read.expired_now).toBe(false);
    expect(read.expiries_recorded).toBe(0);

    // … and the read-computed expiry still fires once the window has really
    // passed, so pinning the guard did not switch expiry off.
    const later = await activeMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      caller: OWNER,
      now: () => '2026-09-25T00:09:00.000Z',
    });
    expect(later.active).toBe(false);
    expect(later.expired_now).toBe(true);
    expect(assignments()[0].status).toBe('expired');
    expect(assignments()[0].expiry.reason).toBe('ttl_elapsed');
  });

  it('derives the portfolio id from the candidate SET: a shuffled list reuses the row', async () => {
    const missionId = 'mission_shuffled_candidates';
    await seedMission(db, { missionId, ownerId: OWNER.user_id });
    const candidates = [
      { identity: 'agent-xavier', mode: 'analyst' },
      { identity: 'agent-yolanda', mode: 'creative' },
      { identity: 'agent-zeke', mode: 'technician' },
    ];
    const now = () => '2026-09-25T04:00:00.000Z';
    const forward = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      candidates,
      missingBins: [],
      caller: OWNER,
      now,
    });
    expect(forward.reused).toBe(false);

    const shuffled = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      candidates: [candidates[2], candidates[0], candidates[1]],
      missingBins: [],
      caller: OWNER,
      now,
    });
    expect(shuffled.reused).toBe(true);
    expect(shuffled.portfolio.portfolio_id).toBe(forward.portfolio.portfolio_id);
    // Identical CONTENT — the id is a function of which candidates were
    // allocated, not of the order they arrived in.
    expect(JSON.stringify(shuffled.portfolio)).toBe(JSON.stringify(forward.portfolio));
    expect(shuffled.portfolio.agents.map((agent) => agent.identity)).toEqual(
      forward.portfolio.agents.map((agent) => agent.identity),
    );
    // ONE row: the shuffled call did not write a second, identical portfolio.
    expect(portfolios().filter((row) => row.kind === 'allocation')).toHaveLength(1);
  });

  it('enforces the reason and TTL bounds in the SERVICE, not only in the MCP schema', async () => {
    const missionId = 'mission_service_bounds';
    // A 1 MB reason: the MCP schema caps it at 500, and the service refuses it
    // rather than storing it verbatim.
    await expect(
      assignMode(db.asDb(), {
        userId: OWNER.user_id,
        missionId,
        mode: 'analyst',
        reason: 'x'.repeat(1024 * 1024),
        caller: OWNER,
        now,
      }),
    ).rejects.toMatchObject({ code: 'reason_too_long' });
    await expect(
      assignMode(db.asDb(), { userId: OWNER.user_id, missionId, mode: 'analyst', reason: 'x'.repeat(501), caller: OWNER, now }),
    ).rejects.toMatchObject({ code: 'reason_too_long' });
    expect(assignments()).toHaveLength(0);

    // The exact cap the tool's own schema states (500) is accepted, so the
    // service and the schema agree on the boundary.
    const atCap = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      mode: 'analyst',
      reason: 'x'.repeat(500),
      caller: OWNER,
      now,
    });
    expect(atCap.reason).toHaveLength(500);
    await expect(
      renewMode(db.asDb(), { assignmentId: atCap.assignment_id, reason: 'y'.repeat(501), caller: OWNER, now }),
    ).rejects.toMatchObject({ code: 'reason_too_long' });
    await expect(
      expireMode(db.asDb(), { assignmentId: atCap.assignment_id, reason: 'z'.repeat(501), caller: OWNER, now }),
    ).rejects.toMatchObject({ code: 'reason_too_long' });
    expect(assignments()[0].renewals).toHaveLength(0);
    expect(assignments()[0].status).toBe('active');

    // A numeric STRING is not a TTL: the tool's `z.number().int()` refuses it, so
    // the service does too instead of coercing it with Number().
    await expect(
      assignMode(db.asDb(), {
        userId: OWNER.user_id,
        missionId,
        mode: 'critic',
        reason: 'a string is not a window',
        ttlMs: '60000' as unknown as number,
        caller: OWNER,
        now,
      }),
    ).rejects.toMatchObject({ code: 'ttl_out_of_range' });
    // A NUMBER inside the window still works.
    const critic = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId,
      mode: 'critic',
      reason: 'attack the accepted frame',
      ttlMs: 60_000,
      caller: OWNER,
      now,
    });
    expect(critic.ttl_ms).toBe(60_000);
    expect(assignments()).toHaveLength(2);
  });

  it('refuses a mode on a mission that is not runnable, by name and before any write', async () => {
    const cancelledMission = 'mission_cancelled';
    await seedMission(db, { missionId: cancelledMission, ownerId: OWNER.user_id, status: 'cancelled' });
    await expect(
      assignMode(db.asDb(), {
        userId: OWNER.user_id,
        missionId: cancelledMission,
        mode: 'analyst',
        reason: 'the mission still needs calibration',
        caller: OWNER,
        now,
      }),
    ).rejects.toMatchObject({ code: 'mission_not_runnable' });
    expect(assignments()).toHaveLength(0);

    const completedMission = 'mission_completed';
    await seedMission(db, { missionId: completedMission, ownerId: OWNER.user_id, status: 'completed' });
    await expect(
      assignMode(db.asDb(), { userId: OWNER.user_id, missionId: completedMission, mode: 'analyst', reason: 'r', caller: OWNER, now }),
    ).rejects.toMatchObject({ code: 'mission_not_runnable' });

    // The tool reports the NAMED refusal instead of quietly granting the mode.
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    const viaTool = txt(
      await dispatchCognitiveTeamTool(
        'assign_thinking_mode',
        { mission_id: cancelledMission, mode: 'analyst', reason: 'r', user_id: OWNER.user_id },
        OWNER,
      ),
    );
    expect(viaTool).toContain('mission_not_runnable');
    expect(assignments()).toHaveLength(0);

    // A live mission is unaffected: assigning and renewing still work.
    const liveMission = 'mission_live';
    await seedMission(db, { missionId: liveMission, ownerId: OWNER.user_id, status: 'active' });
    const live = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: liveMission,
      mode: 'analyst',
      reason: 'calibrate the estimate',
      ttlMs: 60_000,
      caller: OWNER,
      now,
    });
    const renewed = await renewMode(db.asDb(), {
      assignmentId: live.assignment_id,
      reason: 'a second window',
      caller: OWNER,
      now,
    });
    expect(renewed.renewed).toBe(true);
  });

  it('classifies prototype keys as UNAPPROVED dimensions, never as an invariant named `undefined`', async () => {
    // The alias map is a plain object literal, so `__proto__`, `constructor`,
    // `toString`, … resolve through the prototype chain. The unguarded lookup
    // took that truthy object for an invariant and refused it as the invariant
    // `'undefined'`.
    for (const dimension of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(classifyDimension(dimension), dimension).toEqual({ kind: 'unapproved' });
    }
    // The real aliases still resolve to their invariant.
    for (const alias of ['agent_message_weight', 'privacy', 'max_single_source_pct_bounds']) {
      const classification = classifyDimension(alias);
      expect(classification.kind, alias).toBe('immutable');
    }

    const { envelope } = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: 'mission_proto_keys',
      childLabel: 'agent-proto',
      caller: OWNER,
      now,
    });
    for (const dimension of ['__proto__', 'constructor']) {
      const refused = applyBoundedMutation(envelope, { dimension, value: 1 });
      expect(refused.ok, dimension).toBe(false);
      if (refused.ok) continue;
      // Fail closed, with the RIGHT name: not in the approved vocabulary.
      expect(refused.code).toBe('dimension_not_approved');
      expect(refused.reason).toContain('is not an approved dimension');
      expect(refused.reason).not.toContain('undefined');
    }
  });

  it('refuses (by name) an untrusted caller naming another identity in get_active_mode', async () => {
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    const missionId = 'mission_pinned_read';
    await seedMission(db, { missionId, ownerId: OWNER.user_id });
    // Assigned through the TOOL, so the window is measured against the real
    // clock the read below will use.
    const assigned = txt(
      await dispatchCognitiveTeamTool(
        'assign_thinking_mode',
        { mission_id: missionId, mode: 'analyst', reason: 'the mission wants calibration', user_id: OWNER.user_id },
        OWNER,
      ),
    );
    expect(assigned).toContain('Thinking mode assigned');

    // OWNER owns this mission. Naming another identity used to be silently
    // answered with OWNER's OWN mode; the pinning is now stated and refused.
    const named = txt(
      await dispatchCognitiveTeamTool('get_active_mode', { mission_id: missionId, user_id: 'agent-victim' }, OWNER),
    );
    expect(named).toContain('Not authorized');
    expect(named).toContain('PINNED to its own identity');
    expect(named).not.toContain('the mission wants calibration');
    expect(named).not.toContain('No thinking mode recorded for agent-victim');

    // The caller's own read is still served …
    const own = txt(
      await dispatchCognitiveTeamTool('get_active_mode', { mission_id: missionId, user_id: OWNER.user_id }, OWNER),
    );
    expect(own).toContain('Active thinking mode');
    expect(own).toContain('the mission wants calibration');
    // … and a TRUSTED caller may name any identity.
    const trusted = txt(
      await dispatchCognitiveTeamTool('get_active_mode', { mission_id: missionId, user_id: OWNER.user_id }, OPERATOR),
    );
    expect(trusted).toContain('Active thinking mode for agent-a');

    // The tool TEXT states the pinning instead of implying a mission-owner read.
    const description = COGNITIVE_TEAM_TOOL_DEFS.find((tool) => tool.name === 'get_active_mode')!.description;
    expect(description).toContain('PINNED to its own identity');
    expect(description).toContain('under its own identity');
  });

  it('IGNORES a synthesizer-supplied exclusion that is not on record, and names it back', async () => {
    const missionId = 'mission_synth_cannot_add';
    const built = await buildTeam(missionId, { 'agent-analyst': 'analyst' });
    const source = built.results[0];
    expect(source.exclusions.length).toBeGreaterThan(0);
    const invented: PortfolioExclusion = {
      ref: 'invented-exclusion',
      kind: 'rejected_hypothesis',
      reason: 'a synthesizer cannot add this',
      text_hash: '0123456789abcdef',
    };

    const result = await synthesizePortfolios(db.asDb(), {
      userId: LEAD.user_id,
      missionId,
      portfolios: [source],
      exclusions: [...source.exclusions, invented],
      caller: LEAD,
    });
    expect(result.synthesized).toBe(true);
    // The artifact carries the mission's OWN exclusions, byte-identical …
    expect(result.portfolio!.exclusions).toEqual(source.exclusions);
    // … and the invented one is ignored AND named back, never silently dropped.
    expect(result.ignored_exclusions).toEqual([invented.ref]);
    expect(JSON.stringify(result.portfolio)).not.toContain(invented.reason);

    // The tool says the same thing: the description documents it and the output
    // lists what it ignored.
    process.env.COGNITIVE_TEAM_ALLOCATION = '1';
    const description = COGNITIVE_TEAM_TOOL_DEFS.find((tool) => tool.name === 'synthesize_portfolios')!.description;
    expect(description).toContain('CANNOT ADD');
    expect(description).toMatch(/NOT on record is IGNORED/);
    const viaTool = txt(
      await dispatchCognitiveTeamTool(
        'synthesize_portfolios',
        {
          mission_id: missionId,
          pass_id: built.pass.pass_id,
          exclusions: [...source.exclusions, invented].map((exclusion) => ({
            ref: exclusion.ref,
            kind: exclusion.kind,
            reason: exclusion.reason,
            text_hash: exclusion.text_hash,
          })),
          user_id: LEAD.user_id,
        },
        LEAD,
      ),
    );
    expect(viaTool).toContain('Ignored (1)');
    expect(viaTool).toContain(invented.ref);
  });
});

// ── the isolation helper (declarations hoist, so it reads where it is used) ──

/** Every stored seed id, grouped by owner (the isolation check). */
function seedOwners(): Map<string, Set<string>> {
  const rows = db.collection('idea_seeds').docs as Array<Record<string, any>>;
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const owner = String(row.user_id);
    if (!map.has(owner)) map.set(owner, new Set());
    map.get(owner)!.add(String(row.seed_id));
  }
  return map;
}
