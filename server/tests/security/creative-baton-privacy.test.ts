/**
 * Security: the Creative Baton surface (ITER-7, Phase 5).
 *
 * The contract's security additions (`CONTRACT-iter7-creative-baton.md` H/§9),
 * each asserted at the layer that can actually enforce it:
 *
 *   1. an untrusted caller CANNOT promote — promotion writes team state, so it
 *      is not merely caller-pinned but refused outright;
 *   2. an untrusted caller cannot READ another identity's baton unless it was
 *      PROMOTED (a promoted baton is the team artifact; an unpromoted one is
 *      another identity's private portfolio);
 *   3. an untrusted caller cannot RUN another identity's cycle, and the mission
 *      it cannot see is refused before any work;
 *   4. promotion NEVER carries private text — the same taint construction as the
 *      unit suite, asserted at the shared-scope boundary;
 *   5. a TAMPERED promoted baton is refused everywhere it would be used — the
 *      read, the shared work queue and a repeat promotion — instead of being
 *      shared further;
 *   6. the personal kinds stay personal even against an explicit shared request,
 *      and only the gate the promoter holds can write a shared scope.
 *      (The two flags failing closed is asserted in the unit suite, where the
 *      registered surface can be measured.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.REDIS_URL = 'redis://127.0.0.1:6399';

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
import {
  OPERATOR_USER,
  OTHER_USER,
  SCENARIO_MISSION,
  defaultResponder,
  derivedShapedId,
  seedMission,
} from '../helpers/imagination-scenario.js';
import {
  CreativeBatonService,
  compileCreativeBaton,
  creativeBatonPromotionEnabled,
  type CreativeBatonCompileInput,
} from '../../src/services/processing/creative-baton-compiler.js';
import { promoteCreativeBaton } from '../../src/services/processing/creative-baton-promotion.js';
import {
  batonCandidatesToWorkItems,
  recordCandidateOutcome,
} from '../../src/services/processing/imagination-outcome-service.js';
import { runImaginationCycle } from '../../src/services/processing/imagination-cycle-service.js';
import {
  CREATIVE_BATON_COLLECTIONS,
  CREATIVE_BATON_KIND,
  IMAGINATION_CYCLE_KIND,
} from '../../src/services/processing/creative-baton-collections.js';
import {
  CANDIDATE_OUTCOME_KIND,
} from '../../src/services/processing/creative-baton-collections.js';
import {
  CREATIVE_BATON_TOOL_DEFS,
  CREATIVE_BATON_TOOL_NAMES,
  dispatchCreativeBatonTool,
} from '../../src/services/processing/creative-baton-tools.js';
import { PERSONAL_KINDS, resolveWriteScope } from '../../src/services/memory/write-scope-policy.js';
import { COLLECTIONS } from '../../src/services/mission-cognition/collections.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';
import type { CoverageView, IdeaSeed } from '../../src/services/processing/idea-archive-service.js';

const AGENT_A: CallerIdentity = { user_id: OPERATOR_USER, trusted: false };
const AGENT_B: CallerIdentity = { user_id: OTHER_USER, trusted: false };
const OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };

const BATONS = CREATIVE_BATON_COLLECTIONS.creativeBatons;
const PROMOTIONS = CREATIVE_BATON_COLLECTIONS.batonPromotions;
const OUTCOMES = CREATIVE_BATON_COLLECTIONS.candidateOutcomes;
const CYCLES = CREATIVE_BATON_COLLECTIONS.cycles;

let db: FakeDb;
const spies: Array<{ mockRestore: () => void }> = [];

function txt(result: Array<{ type: string; text: string }>): string {
  return result.map((row) => row.text).join('\n');
}

// ── A minimal, realistic baton fixture ──────────────────────────────────────

const DIGEST = `sha256:${'b'.repeat(64)}`;

function coverage(): CoverageView {
  return {
    mission_id: SCENARIO_MISSION,
    user_id: OPERATOR_USER,
    cells_total: 4,
    cells_by_dimension: {
      mechanism: { removal: 4 },
      representation: { prose: 4 },
      violated_assumption: { necessity: 4 },
      evidence_family: { epistemic_ledger: 4 },
      test_strategy: { kill_criterion: 4 },
    },
    new_cells_this_cycle: 4,
    cycle_id: 'cycle_security',
    occupancy: { occupied: 4, possible: 16807, ratio: 0.0002 },
    gaps: [{ dimension: 'mechanism', unoccupied_bins: ['substitution'] }],
    descriptor_dimensions: ['mechanism', 'representation', 'violated_assumption', 'evidence_family', 'test_strategy'],
    coverage_date: '2026-09-25',
    scan: {
      cells_limit: 500,
      cells_scanned: 4,
      cells_truncated: false,
      seeds_dedupe_limit: 200,
      seeds_scanned: 4,
      seeds_truncated: false,
      truncated: false,
    },
  };
}

function seedFixture(index: number, overrides: Partial<IdeaSeed> = {}): IdeaSeed {
  return {
    schema_version: '1.0',
    seed_id: derivedShapedId('seed', index),
    user_id: OPERATOR_USER,
    mission_id: SCENARIO_MISSION,
    mission_version: 1,
    cycle_id: 'cycle_security',
    prng_seed: 3,
    operator: 'assumption_inversion',
    hypothesis: `Security candidate ${index}: the drain is countable once the probe is on the queue.`,
    mechanism: `Instrumentation ${index} turns the unmeasured drain into a row the plateau rule can compare.`,
    descriptor_bins: ['removal', 'prose', 'necessity', 'epistemic_ledger', 'kill_criterion'],
    bins: {
      mechanism: 'removal',
      representation: 'prose',
      violated_assumption: 'necessity',
      evidence_family: 'epistemic_ledger',
      test_strategy: 'kill_criterion',
    },
    cell_key: 'mechanism=removal|representation=prose|violated_assumption=necessity|evidence_family=epistemic_ledger|test_strategy=kill_criterion',
    evidence_refs: [`sig_security_${index}`],
    novelty_score: 0.8,
    coherence_score: 0.7,
    testability_score: 0.6,
    quality: 0.68,
    cheapest_test: `Read the probe after one cycle (candidate ${index}).`,
    expected_information_gain: 0.5,
    parent_seed_ids: [],
    lineage_ref: derivedShapedId('lineage', index),
    rank: index,
    state: 'admitted',
    incumbent: true,
    created_at: '2026-09-25T00:00:00.000Z',
    ...overrides,
  } as IdeaSeed;
}

async function storeBaton(overrides: Partial<CreativeBatonCompileInput> = {}) {
  const input: CreativeBatonCompileInput = {
    userId: OPERATOR_USER,
    missionId: SCENARIO_MISSION,
    cycleId: 'cycle_security',
    trace: {
      trace_id: 'trace_security',
      mission_version: 1,
      problem_state_digest: DIGEST,
      signals: [{ kind: 'tension', intensity: 0.7, confidence: 0.6, valence: -0.2 }],
    },
    seeds: [seedFixture(0), seedFixture(1)],
    exclusions: [],
    coverage: coverage(),
    trigger: { type: 'plateau', evidence: ['plateau:below_minimum_active_candidates'] },
    now: () => '2026-09-25T00:00:00.000Z',
    ...overrides,
  } as CreativeBatonCompileInput;
  return new CreativeBatonService(db.asDb()).compileAndStore(input);
}

beforeEach(() => {
  db = new FakeDb();
  holder.db = db;
  process.env.FOCUSED_IMAGINATION = '1';
  process.env.CREATIVE_BATON_PROMOTION = '1';
  spies.push(
    vi
      .spyOn(llmService, 'extractJson')
      .mockImplementation((async (system: string, prompt: string) => defaultResponder(system, prompt)) as never),
  );
  spies.push(
    vi.spyOn(llmService, 'getServiceStatus').mockReturnValue({
      available: true,
      provider: 'stub',
      model: 'test-model',
      providers: ['stub(ready)'],
    }),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  delete process.env.FOCUSED_IMAGINATION;
  delete process.env.CREATIVE_BATON_PROMOTION;
});

// ── 1. promotion ────────────────────────────────────────────────────────────

describe('creative baton security — an untrusted caller cannot promote', () => {
  it('refuses the tool and the service, writing no shared_id and no audit row', async () => {
    const { baton } = await storeBaton();
    const viaTool = await dispatchCreativeBatonTool('promote_creative_baton', { baton_id: baton.baton_id }, AGENT_A);
    expect(txt(viaTool)).toContain('untrusted_caller');

    const viaService = await promoteCreativeBaton(db.asDb(), {
      userId: OPERATOR_USER,
      batonId: baton.baton_id,
      caller: AGENT_A,
    });
    expect(viaService.promoted).toBe(false);
    expect(viaService.code).toBe('untrusted_caller');
    expect(db.collection(BATONS).docs[0].shared_id).toBeUndefined();
    expect(db.collection(PROMOTIONS).docs).toHaveLength(0);
    // …and it cannot promote ANOTHER identity's baton either.
    const foreign = await promoteCreativeBaton(db.asDb(), {
      userId: OPERATOR_USER,
      batonId: baton.baton_id,
      caller: AGENT_B,
    });
    expect(foreign.promoted).toBe(false);
    expect(db.collection(PROMOTIONS).docs).toHaveLength(0);
  });

  it('keeps the capability flag from exposing anything on its own', async () => {
    const { baton } = await storeBaton();
    // Promotion is not the only thing that fails closed: the whole family is
    // behind FOCUSED_IMAGINATION even with the promotion flag on.
    delete process.env.FOCUSED_IMAGINATION;
    expect(creativeBatonPromotionEnabled()).toBe(true);
    for (const name of CREATIVE_BATON_TOOL_NAMES) {
      await expect(dispatchCreativeBatonTool(name, { baton_id: baton.baton_id }, OPERATOR)).rejects.toThrow(
        `Unknown tool: ${name}`,
      );
    }
    // The promotion tool is also absent when the promotion flag is off.
    process.env.FOCUSED_IMAGINATION = '1';
    delete process.env.CREATIVE_BATON_PROMOTION;
    await expect(
      dispatchCreativeBatonTool('promote_creative_baton', { baton_id: baton.baton_id }, OPERATOR),
    ).rejects.toThrow('Unknown tool: promote_creative_baton');
    expect(db.collection(BATONS).docs[0].shared_id).toBeUndefined();
    expect(db.collection(PROMOTIONS).docs).toHaveLength(0);
    // The registered surface matches: the promotion tool declares its flag.
    const promotionDef = CREATIVE_BATON_TOOL_DEFS.find((tool) => tool.name === 'promote_creative_baton')!;
    expect(promotionDef.requires_promotion_flag).toBe(true);
    expect(
      CREATIVE_BATON_TOOL_DEFS.filter((tool) => tool.requires_promotion_flag).map((tool) => tool.name),
    ).toEqual(['promote_creative_baton']);
  });
});

// ── 2. reads ────────────────────────────────────────────────────────────────

describe('creative baton security — reads never cross identities unless promoted', () => {
  it('an untrusted caller reads its own baton, not another identity’s private one', async () => {
    const { baton } = await storeBaton();
    const own = await dispatchCreativeBatonTool('get_creative_baton', { baton_id: baton.baton_id }, AGENT_A);
    expect(txt(own)).toContain(baton.baton_id);

    const foreign = await dispatchCreativeBatonTool('get_creative_baton', { baton_id: baton.baton_id }, AGENT_B);
    expect(txt(foreign)).toContain('No creative baton visible for you');
    // A mission read is refused even earlier — the TOOL layer will not let an
    // untrusted caller enumerate another identity's mission at all (the service
    // layer's scope rule is asserted in the unit suite; the tool adds the
    // mission-visibility gate on top of it).
    const byMission = await dispatchCreativeBatonTool('get_creative_baton', { mission_id: SCENARIO_MISSION }, AGENT_B);
    expect(txt(byMission)).toContain('Not authorized for mission');

    // A trusted caller sees it (operator scope).
    const operator = await dispatchCreativeBatonTool('get_creative_baton', { baton_id: baton.baton_id }, OPERATOR);
    expect(txt(operator)).toContain(baton.baton_id);
  });

  it('a promoted baton is readable by another identity — and only then', async () => {
    const { baton } = await storeBaton();
    expect(txt(await dispatchCreativeBatonTool('get_creative_baton', { baton_id: baton.baton_id }, AGENT_B))).toContain(
      'No creative baton visible',
    );
    const promotion = await promoteCreativeBaton(db.asDb(), {
      userId: OPERATOR_USER,
      batonId: baton.baton_id,
      caller: OPERATOR,
    });
    expect(promotion.promoted).toBe(true);
    const shared = await dispatchCreativeBatonTool('get_creative_baton', { baton_id: baton.baton_id }, AGENT_B);
    expect(txt(shared)).toContain(baton.baton_id);
    expect(txt(shared)).toContain('shared (`my-team`)');

    // The work-item adapter accepts it from an untrusted caller only BECAUSE it
    // is promoted (the queue is shared state).
    await seedMission(db);
    const adapted = await batonCandidatesToWorkItems(db.asDb(), {
      userId: OTHER_USER,
      batonId: baton.baton_id,
      caller: AGENT_B,
    });
    expect(adapted.promoted).toBe(true);
    expect(adapted.created).toBe(2);
  });

  it('refuses an unpromoted baton to an untrusted adapter caller, and refuses an invisible one', async () => {
    await seedMission(db);
    const { baton } = await storeBaton();
    await expect(
      batonCandidatesToWorkItems(db.asDb(), { userId: OPERATOR_USER, batonId: baton.baton_id, caller: AGENT_A }),
    ).rejects.toThrow(/baton_not_promoted/);
    await expect(
      batonCandidatesToWorkItems(db.asDb(), { userId: OTHER_USER, batonId: baton.baton_id, caller: AGENT_B }),
    ).rejects.toThrow(/no visible creative baton/);
    expect(db.collection(COLLECTIONS.cognitiveWorkItems).docs.filter((row) => row.provenance)).toHaveLength(0);
  });
});

// ── 3. cycles ───────────────────────────────────────────────────────────────

describe('creative baton security — an untrusted caller cannot run another identity’s cycle', () => {
  it('refuses the tool for a mission the caller does not own, and writes nothing', async () => {
    await seedMission(db);
    const refused = await dispatchCreativeBatonTool(
      'run_imagination_cycle',
      { mission_id: SCENARIO_MISSION, force: true },
      AGENT_B,
    );
    expect(txt(refused)).toContain('Not authorized');
    expect(db.collection(CYCLES).docs).toHaveLength(0);
    expect(db.collection(BATONS).docs).toHaveLength(0);
    expect(holder.db.collection('focused_consolidation_runs').docs).toHaveLength(0);

    // The owner may run its own cycle, and the rows are the owner's.
    const owned = await dispatchCreativeBatonTool(
      'run_imagination_cycle',
      { mission_id: SCENARIO_MISSION },
      AGENT_A,
    );
    expect(txt(owned)).toContain('`ran`');
    expect(db.collection(CYCLES).docs.every((row) => row.user_id === OPERATOR_USER)).toBe(true);
    expect(db.collection(BATONS).docs).toHaveLength(1);
    // The owner is untrusted, so the cycle's promotion step is refused and the
    // refusal is recorded rather than silently skipped.
    expect(db.collection(BATONS).docs[0].shared_id).toBeUndefined();
    expect(db.collection(PROMOTIONS).docs).toHaveLength(0);
    expect(db.collection(CYCLES).docs[0].promotion_skipped).toBe('untrusted_caller');
  });

  it('attributes a promoted cycle run to the identity it was asked for, never to the operator', async () => {
    await seedMission(db);
    const result = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      caller: OPERATOR,
      actorId: OPERATOR.user_id,
    });
    expect(result.promoted).toBe(true);
    expect(db.collection(CYCLES).docs[0].user_id).toBe(OPERATOR_USER);
    expect(db.collection(CYCLES).docs[0].actor_id).toBe(OPERATOR.user_id);
    expect(db.collection(BATONS).docs[0].user_id).toBe(OPERATOR_USER);
    expect(db.collection(PROMOTIONS).docs[0]).toMatchObject({
      user_id: OPERATOR_USER,
      promoted_by: OPERATOR.user_id,
      shared_id: 'my-team',
    });
  });
});

// ── 4. no private text crosses ──────────────────────────────────────────────

describe('creative baton security — promotion never carries private text', () => {
  const MARKERS = {
    statement: 'MARKER_SEC_STATEMENT',
    why: 'MARKER_SEC_WHY',
    evidence: 'MARKER_SEC_EVIDENCE',
    premise: 'MARKER_SEC_PREMISE',
    bridge: 'MARKER_SEC_BRIDGE',
    exclusion: 'MARKER_SEC_EXCLUSION',
    detail: 'MARKER_SEC_DETAIL',
  };

  it('keeps every marker out of the shared scope, the audit row and the queue', async () => {
    await seedMission(db);
    const tainted: CreativeBatonCompileInput = {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      cycleId: 'cycle_security',
      trace: {
        trace_id: 'trace_security',
        mission_version: 1,
        problem_state_digest: DIGEST,
        signals: [
          {
            kind: 'tension',
            intensity: 0.7,
            confidence: 0.6,
            valence: -0.2,
            statement: MARKERS.statement,
            why_operationally_relevant: MARKERS.why,
          },
        ],
      },
      seeds: [
        seedFixture(0, {
          evidence_refs: [MARKERS.evidence],
          changed_premise: MARKERS.premise,
          bridge: MARKERS.bridge,
          bridge_path: [MARKERS.bridge, 'node_b'],
        }),
      ],
      exclusions: [{ kind: 'rejected_hypothesis', text: MARKERS.exclusion, ref: 'ent_sec' }],
      coverage: coverage(),
      trigger: { type: 'plateau', evidence: ['plateau:below_minimum_active_candidates'] },
      now: () => '2026-09-25T00:00:00.000Z',
    };
    const { baton } = await new CreativeBatonService(db.asDb()).compileAndStore(tainted);
    // The compiled baton is pure, before any promotion.
    expect(JSON.stringify(baton)).not.toMatch(/MARKER_SEC_(STATEMENT|WHY|EVIDENCE|PREMISE|BRIDGE|EXCLUSION)/);

    await promoteCreativeBaton(db.asDb(), { userId: OPERATOR_USER, batonId: baton.baton_id, caller: OPERATOR });
    await batonCandidatesToWorkItems(db.asDb(), { userId: OPERATOR_USER, batonId: baton.baton_id, caller: AGENT_B });
    db.collection('idea_seeds').docs.push({
      schema_version: '1.0',
      seed_id: baton.candidate_portfolio[0].seed_id,
      user_id: OPERATOR_USER,
      mission_id: SCENARIO_MISSION,
      lineage_ref: baton.candidate_portfolio[0].lineage_ref,
      evidence_refs: [MARKERS.evidence],
      state: 'admitted',
    });
    await recordCandidateOutcome(db.asDb(), {
      userId: OPERATOR_USER,
      seedId: baton.candidate_portfolio[0].seed_id,
      batonId: baton.baton_id,
      outcome: 'mere_variance',
      detail: MARKERS.detail,
    });

    const sharedScope = JSON.stringify({
      batons: db.collection(BATONS).docs.filter((row) => row.shared_id),
      promotions: db.collection(PROMOTIONS).docs,
      workItems: db.collection(COLLECTIONS.cognitiveWorkItems).docs,
      telemetry: db.collection(COLLECTIONS.triggerEvaluations).docs,
    });
    for (const marker of Object.values(MARKERS)) {
      expect(sharedScope, `${marker} crossed the shared boundary`).not.toContain(marker);
    }
    // The caller's own words stay on the private outcome row — that is where the
    // detail marker lives, and nowhere else.
    expect(JSON.stringify(db.collection(OUTCOMES).docs)).toContain(MARKERS.detail);
  });
});

// ── 5. a tampered SHARED baton is refused everywhere it would be used ───────

describe('creative baton security — a tampered promoted baton is refused, never shared further', () => {
  it('keeps a post-promotion tamper out of the shared scope: read, adapter and repeat promotion', async () => {
    await seedMission(db);
    const { baton } = await storeBaton();
    const promotion = await promoteCreativeBaton(db.asDb(), {
      userId: OPERATOR_USER,
      batonId: baton.baton_id,
      caller: OPERATOR,
    });
    expect(promotion.promoted).toBe(true);

    // The row is TEAM-SHARED and was tampered with after the promotion: the
    // `shared_id` records an EARLIER validation, not the current one.
    db.collection(BATONS).docs[0].candidate_portfolio[0].hypothesis = 'MARKER_SEC_TAMPER a claim nobody compiled';
    const rowsBefore = db.collection(COLLECTIONS.cognitiveWorkItems).docs.length;

    // (a) ANOTHER identity's read is refused by name — not served, not hidden
    const read = await dispatchCreativeBatonTool('get_creative_baton', { baton_id: baton.baton_id }, AGENT_B);
    expect(txt(read)).toContain('payload_hash_mismatch');
    expect(txt(read)).not.toContain('MARKER_SEC_TAMPER');

    // (b) the SHARED work queue is untouched by the tampered text
    await expect(
      batonCandidatesToWorkItems(db.asDb(), { userId: OTHER_USER, batonId: baton.baton_id, caller: AGENT_B }),
    ).rejects.toThrow(/payload_hash_mismatch/);
    expect(db.collection(COLLECTIONS.cognitiveWorkItems).docs).toHaveLength(rowsBefore);
    expect(JSON.stringify(db.collection(COLLECTIONS.cognitiveWorkItems).docs)).not.toContain('MARKER_SEC_TAMPER');

    // (c) promoting it again is refused, not reported as an unchanged no-op
    const again = await promoteCreativeBaton(db.asDb(), {
      userId: OPERATOR_USER,
      batonId: baton.baton_id,
      caller: OPERATOR,
    });
    expect(again.promoted).toBe(false);
    expect(again.code).toBe('payload_hash_mismatch');
    expect(db.collection(PROMOTIONS).docs).toHaveLength(1);
  });
});

// ── 6. write scope ──────────────────────────────────────────────────────────

describe('creative baton security — the personal kinds stay personal', () => {
  it('resolves a shared request to null for every ITER-7 personal kind', () => {
    for (const kind of [IMAGINATION_CYCLE_KIND, 'imagination_cycle_states', CANDIDATE_OUTCOME_KIND]) {
      expect(PERSONAL_KINDS, `${kind} must stay a personal kind`).toContain(kind);
      const scope = resolveWriteScope({
        caller: AGENT_A,
        kind,
        requested: { shared_id: 'another-team' },
      });
      expect(scope.shared_id).toBeNull();
      expect(scope.user_id).toBe(AGENT_A.user_id);
    }
    // The baton is the ONE artifact that may carry a shared scope — and the
    // compiler asks for the private opt-out, so it is written without one.
    const compileScope = resolveWriteScope({ caller: AGENT_A, kind: CREATIVE_BATON_KIND, requested: { private: true } });
    expect(compileScope.shared_id).toBeNull();
    const promoteScope = resolveWriteScope({ caller: AGENT_A, kind: CREATIVE_BATON_KIND });
    expect(promoteScope.shared_id).toBe('my-team');
  });

  it('never stamps a shared scope on a cycle row, a state row, an outcome or a seed', async () => {
    await seedMission(db);
    const cycle = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      caller: OPERATOR,
    });
    expect(cycle.promoted).toBe(true);
    const seedId = db.collection(BATONS).docs[0].candidate_portfolio[0].seed_id;
    await recordCandidateOutcome(db.asDb(), { userId: OPERATOR_USER, seedId, outcome: 'useful_information' });
    for (const name of [CYCLES, 'imagination_cycle_states', OUTCOMES, 'idea_seeds', 'idea_lineages', 'imagination_runs']) {
      for (const row of db.collection(name).docs) {
        expect(row, `${name} row must carry no shared scope`).not.toHaveProperty('shared_id');
      }
    }
    // The promoted baton is the exception, and it is the only one.
    expect(db.collection(BATONS).docs.filter((row) => row.shared_id).map((row) => row.shared_id)).toEqual(['my-team']);
    expect(db.collection(PROMOTIONS).docs).toHaveLength(1);
  });
});
