/**
 * Security: the cognitive-team surface (ITER-8, Phase 6).
 *
 * The contract's security additions (`CONTRACT-iter8-cognitive-team.md` §F/§9),
 * each asserted at the layer that can actually enforce it:
 *
 *   1. an untrusted caller CANNOT assign a thinking mode for another identity —
 *      neither through the tool nor through the service;
 *   2. an untrusted caller cannot READ another identity's assignment (even by
 *      naming it), and cannot read another identity's inheritance envelope;
 *   3. an untrusted caller cannot allocate a portfolio for another identity, and
 *      cannot allocate at all for a mission it neither owns nor shares;
 *   4. an untrusted caller cannot read another identity's synthesis or first
 *      pass, and a mission it cannot see is refused before any work;
 *   5. mode/envelope/portfolio documents carry NO `shared_id` — even against an
 *      explicit shared request — because every one of them is a personal kind;
 *   6. the same taint construction as the unit suite, asserted at the boundary
 *      the artifacts are handed over: markers in the parent's private stores
 *      never appear in an envelope, a mode assignment, an allocation report, a
 *      first-pass request or a synthesis output (and never in a tool's output);
 *   7. a TAMPERED envelope is refused everywhere it would be used instead of
 *      being handed to a first pass.
 *      (The flag failing closed is asserted in the unit suite, where the
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
import { defaultResponder, seedMission } from '../helpers/imagination-scenario.js';
import { runFocusedConsolidation } from '../../src/services/processing/focused-consolidation-service.js';
import {
  ModeAccessError,
  activeMode,
  assignMode,
  verifyAssignment,
} from '../../src/services/processing/cognitive-mode-service.js';
import {
  createInheritanceEnvelope,
  readEnvelope,
  storeEnvelope,
  applyBoundedMutation,
  envelopePolicyHash,
} from '../../src/services/processing/inheritance-envelope.js';
import {
  allocatePortfolio,
  listPortfolios,
  storePortfolio,
} from '../../src/services/processing/cognitive-allocation-service.js';
import { planFirstPass, runFirstPass, synthesizePortfolios } from '../../src/services/processing/independent-first-pass.js';
import { COGNITIVE_TEAM_COLLECTIONS, MODE_ASSIGNMENT_KIND, INHERITANCE_ENVELOPE_KIND, COGNITIVE_PORTFOLIO_KIND } from '../../src/services/processing/cognitive-team-collections.js';
import { dispatchCognitiveTeamTool } from '../../src/services/processing/cognitive-team-tools.js';
import { PERSONAL_KINDS, resolveWriteScope, stripSharedId } from '../../src/services/memory/write-scope-policy.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const OWNER: CallerIdentity = { user_id: 'agent-a', trusted: false };
const OTHER: CallerIdentity = { user_id: 'agent-b', trusted: false };
const OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };

const ASSIGNMENTS = COGNITIVE_TEAM_COLLECTIONS.modeAssignments;
const ENVELOPES = COGNITIVE_TEAM_COLLECTIONS.inheritanceEnvelopes;
const PORTFOLIOS = COGNITIVE_TEAM_COLLECTIONS.cognitivePortfolios;

const MISSION = 'mission_cognitive_team_security';

function txt(result: Array<{ type: string; text: string }>): string {
  return result.map((row) => row.text).join('\n');
}

let db: FakeDb;
const prompts: string[] = [];

beforeEach(async () => {
  process.env.COGNITIVE_TEAM_ALLOCATION = '1';
  db = new FakeDb();
  holder.db = db;
  prompts.length = 0;
  vi.spyOn(llmService, 'extractJson').mockImplementation((async (system: string, prompt: string) => {
    prompts.push(prompt);
    return defaultResponder(system, prompt);
  }) as never);
  vi.spyOn(llmService, 'getServiceStatus').mockReturnValue({
    available: true,
    provider: 'stub',
    model: 'test-model',
    providers: ['stub(ready)'],
  } as never);
  await seedMission(db, { missionId: MISSION, ownerId: OWNER.user_id });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.COGNITIVE_TEAM_ALLOCATION;
});

describe('cognitive team — identity separation', () => {
  it('an untrusted caller cannot assign a mode for another identity (tool and service)', async () => {
    const tool = txt(
      await dispatchCognitiveTeamTool(
        'assign_thinking_mode',
        { mission_id: MISSION, mode: 'critic', reason: 'for the other one', user_id: OWNER.user_id },
        OTHER,
      ),
    );
    expect(tool).toContain('Not authorized');
    expect(db.collection(ASSIGNMENTS).docs).toHaveLength(0);

    await expect(
      assignMode(db.asDb(), {
        userId: OWNER.user_id,
        missionId: MISSION,
        mode: 'critic',
        reason: 'for the other one',
        caller: OTHER,
      }),
    ).rejects.toThrow(ModeAccessError);

    // A trusted caller may act for another identity, and records who acted.
    const trusted = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      mode: 'critic',
      reason: 'the operator asked for it',
      actorId: OPERATOR.user_id,
      caller: OPERATOR,
    });
    expect(trusted.actor_id).toBe(OPERATOR.user_id);
    expect(trusted.user_id).toBe(OWNER.user_id);
  });

  it('an untrusted caller cannot read another identity\'s assignment or envelope', async () => {
    await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      mode: 'analyst',
      reason: 'calibration',
      caller: OWNER,
      now: () => '2026-09-25T00:00:00.000Z',
    });
    const { envelope } = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: MISSION,
      childLabel: 'agent-b',
      mode: 'analyst',
      caller: OWNER,
    });

    const read = txt(
      await dispatchCognitiveTeamTool('get_active_mode', { mission_id: MISSION, user_id: OWNER.user_id }, OTHER),
    );
    expect(read).toContain('Not authorized');
    expect(read).not.toContain('calibration');

    await expect(
      activeMode(db.asDb(), { userId: OWNER.user_id, missionId: MISSION, caller: OTHER }),
    ).rejects.toThrow(ModeAccessError);

    const envelopeRead = await readEnvelope(db.asDb(), envelope.envelope_id, OTHER);
    expect(envelopeRead.envelope).toBeNull();
    expect(envelopeRead.refusal).toBeNull();
    const toolEnvelope = txt(
      await dispatchCognitiveTeamTool(
        'create_inheritance_envelope',
        { mission_id: MISSION, envelope_id: envelope.envelope_id, user_id: OWNER.user_id },
        OTHER,
      ),
    );
    expect(toolEnvelope).toContain('Not authorized');
    // The owner still sees its own envelope.
    expect((await readEnvelope(db.asDb(), envelope.envelope_id, OWNER)).envelope?.envelope_id).toBe(envelope.envelope_id);
  });

  it('an untrusted caller cannot allocate for another identity or an unseen mission', async () => {
    const forAnother = txt(
      await dispatchCognitiveTeamTool(
        'allocate_cognitive_portfolio',
        { mission_id: MISSION, candidates: [{ identity: OWNER.user_id, mode: 'analyst' }], user_id: OWNER.user_id },
        OTHER,
      ),
    );
    expect(forAnother).toContain('Not authorized');
    expect(db.collection(PORTFOLIOS).docs).toHaveLength(0);

    await expect(
      allocatePortfolio(db.asDb(), {
        userId: OWNER.user_id,
        missionId: MISSION,
        candidates: [{ identity: OWNER.user_id, mode: 'analyst' }],
        caller: OTHER,
      }),
    ).rejects.toThrow(/may not allocate/);

    // A mission that does not exist is refused before any work.
    const unseen = txt(
      await dispatchCognitiveTeamTool(
        'plan_independent_first_pass',
        { mission_id: 'mission_someone_else', team: [{ identity: OTHER.user_id, mode: 'analyst' }] },
        OTHER,
      ),
    );
    expect(unseen).toContain('Not authorized');
    expect(prompts).toHaveLength(0);
  });

  it('an untrusted caller cannot read another identity\'s first pass or synthesis', async () => {
    await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      cycleId: 'security_trace',
      actorId: OWNER.user_id,
    });
    const planned = await planFirstPass(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      team: [{ identity: OWNER.user_id, mode: 'creative' }],
      caller: OWNER,
    });
    const ran = await runFirstPass(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      team: [{ identity: OWNER.user_id, mode: 'creative' }],
      caller: OWNER,
      pass: planned.pass,
    });
    const synthesis = await synthesizePortfolios(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      portfolios: ran.results,
      caller: OWNER,
    });
    expect(synthesis.synthesized).toBe(true);

    const readPass = txt(
      await dispatchCognitiveTeamTool(
        'synthesize_portfolios',
        { mission_id: MISSION, pass_id: ran.pass.pass_id, user_id: OWNER.user_id },
        OTHER,
      ),
    );
    expect(readPass).toContain('Not authorized');
    await expect(
      listPortfolios(db.asDb(), { userId: OWNER.user_id, missionId: MISSION, kind: 'allocation', caller: OTHER }),
    ).rejects.toThrow(/may not read/);
    await expect(
      synthesizePortfolios(db.asDb(), {
        userId: OWNER.user_id,
        missionId: MISSION,
        portfolios: ran.results,
        caller: OTHER,
      }),
    ).rejects.toThrow(/may not synthesize/);
  });
});

describe('cognitive team — the personal kinds stay personal', () => {
  it('a mode, an envelope and a portfolio can never carry a shared_id, even against an explicit shared request', async () => {
    for (const kind of [MODE_ASSIGNMENT_KIND, INHERITANCE_ENVELOPE_KIND, COGNITIVE_PORTFOLIO_KIND]) {
      expect(PERSONAL_KINDS).toContain(kind);
      const resolved = resolveWriteScope({
        caller: { user_id: OWNER.user_id, trusted: true },
        kind,
        requested: { shared_id: 'my-team', user_id: OWNER.user_id },
      });
      expect(resolved.shared_id).toBeNull();
      expect(resolved.user_id).toBe(OWNER.user_id);
      expect(stripSharedId({ shared_id: 'my-team', keep: 1 })).toEqual({ keep: 1 });
    }

    await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      mode: 'strategist',
      reason: 'the mission needs a portfolio view',
      caller: OWNER,
    });
    const { envelope } = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: MISSION,
      childLabel: 'agent-child',
      mode: 'strategist',
      caller: OWNER,
    });
    const allocation = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      candidates: [{ identity: OWNER.user_id, mode: 'strategist' }],
      missingBins: [],
      caller: OWNER,
    });

    expect(db.collection(ASSIGNMENTS).docs[0].shared_id).toBeUndefined();
    expect(db.collection(ENVELOPES).docs[0].shared_id).toBeUndefined();
    expect(
      db.collection(PORTFOLIOS).docs.find((row) => row.portfolio_id === allocation.portfolio.portfolio_id)!.shared_id,
    ).toBeUndefined();
    expect(JSON.stringify(db.collection(PORTFOLIOS).docs)).not.toContain('my-team');
    // The stored rows are the ones the services verify.
    expect(verifyAssignment(db.collection(ASSIGNMENTS).docs[0])).toMatchObject({ ok: true });
    expect(envelope.privacy).toEqual({ private_content_included: false, shared: false });
  });
});

describe('cognitive team — no private memory crosses the boundary', () => {
  it('markers in every private store never reach an envelope, an assignment, a report, a request or a synthesis', async () => {
    const markers: string[] = [];
    for (const store of ['reflective_journals', 'reflection_nodes', 'episodic_events', 'salience_traces', 'idea_seeds', 'agent_beliefs']) {
      const marker = `SECRET${store.toUpperCase()}MARK`;
      markers.push(marker);
      db.collection(store).docs.push({ user_id: OWNER.user_id, mission_id: MISSION, text: marker, statement: marker });
    }
    const focused = await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      cycleId: 'taint_trace',
      actorId: OWNER.user_id,
    });
    expect(focused.status).toBe('completed');
    const traceRow = db.collection('salience_traces').docs.find((row) => row.trace_id === focused.trace_id)!;
    traceRow.signals[0].statement = `the trace says SECRETSALIENCETRACESMARK`;

    const assignment = await assignMode(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      mode: 'verifier',
      reason: 'independent evaluation',
      caller: OWNER,
    });
    const created = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: MISSION,
      childLabel: 'agent-child',
      mode: 'verifier',
      caller: OWNER,
    });
    const allocation = await allocatePortfolio(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      candidates: [
        { identity: OWNER.user_id, mode: 'verifier' },
        { identity: 'agent-peer', mode: 'creative' },
      ],
      caller: OWNER,
    });
    const planned = await planFirstPass(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      team: [{ identity: OWNER.user_id, mode: 'verifier', envelope_id: created.envelope.envelope_id }],
      caller: OWNER,
    });
    const ran = await runFirstPass(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      team: [{ identity: OWNER.user_id, mode: 'verifier', envelope_id: created.envelope.envelope_id }],
      caller: OWNER,
      pass: planned.pass,
    });
    const synthesis = await synthesizePortfolios(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      portfolios: ran.results,
      caller: OWNER,
    });

    const surfaces: Array<[string, string]> = [
      ['envelope', JSON.stringify(created.envelope)],
      ['mode assignment', JSON.stringify(assignment)],
      ['allocation report', JSON.stringify(allocation.portfolio)],
      ['first-pass request', JSON.stringify(planned.requests)],
      ['first-pass record', JSON.stringify(ran.pass)],
      ['synthesis', JSON.stringify(synthesis.portfolio)],
      ['the whole store', JSON.stringify(db.collection(PORTFOLIOS).docs)],
    ];
    for (const [label, surface] of surfaces) {
      for (const marker of markers) expect(surface, `${label} leaked ${marker}`).not.toContain(marker);
    }

    // The agent's OWN private trace did reach its own generation (proving the
    // scan is not vacuous) — and it reached nothing else.
    expect(prompts.join('\n')).toContain('SECRETSALIENCETRACESMARK');

    // Through the tool surface as well.
    const out = [
      txt(await dispatchCognitiveTeamTool('get_active_mode', { mission_id: MISSION }, OWNER)),
      txt(await dispatchCognitiveTeamTool('create_inheritance_envelope', { mission_id: MISSION, envelope_id: created.envelope.envelope_id }, OWNER)),
      txt(
        await dispatchCognitiveTeamTool(
          'allocate_cognitive_portfolio',
          { mission_id: MISSION, candidates: [{ identity: OWNER.user_id, mode: 'verifier' }] },
          OWNER,
        ),
      ),
      txt(await dispatchCognitiveTeamTool('synthesize_portfolios', { mission_id: MISSION, pass_id: ran.pass.pass_id }, OWNER)),
    ].join('\n');
    for (const marker of markers) expect(out).not.toContain(marker);
  });
});

describe('cognitive team — a tampered envelope is refused where it would be used', () => {
  it('a first pass refuses an envelope whose payload was modified after it was created', async () => {
    await runFocusedConsolidation(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      cycleId: 'tamper_trace',
      actorId: OWNER.user_id,
    });
    const { envelope } = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: MISSION,
      childLabel: 'agent-child',
      mode: 'creative',
      caller: OWNER,
    });
    const stored = db.collection(ENVELOPES).docs.find((row) => row.envelope_id === envelope.envelope_id)!;
    stored.effective_scoring.vector_fetch_limit = 3;

    const read = await readEnvelope(db.asDb(), envelope.envelope_id, OWNER);
    expect(read.envelope).toBeNull();
    expect(read.refusal?.code).toBe('policy_hash_mismatch');

    const planned = await planFirstPass(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      team: [{ identity: OWNER.user_id, mode: 'creative', envelope_id: envelope.envelope_id }],
      caller: OWNER,
    });
    expect(planned.requests[0].status).toBe('blocked');
    expect(planned.requests[0].blocked_reason).toBe('envelope_refused:policy_hash_mismatch');

    const ran = await runFirstPass(db.asDb(), {
      userId: OWNER.user_id,
      missionId: MISSION,
      team: [{ identity: OWNER.user_id, mode: 'creative', envelope_id: envelope.envelope_id }],
      caller: OWNER,
      pass: planned.pass,
    });
    expect(ran.results[0].status).toBe('blocked');
    // No generation happened: a blocked request makes zero model calls.
    expect(ran.results[0].llm_calls).toBe(0);
    expect(ran.results[0].seeds).toHaveLength(0);
    expect(prompts.some((prompt) => prompt.includes('OPERATOR FAMILIES TO RUN'))).toBe(false);

    // A derived envelope that was tampered with is refused too, and a store
    // refuses a forged one outright.
    const clean = await createInheritanceEnvelope(db.asDb(), {
      parentUserId: OWNER.user_id,
      missionId: MISSION,
      childLabel: 'agent-child-2',
      caller: OWNER,
      now: () => '2026-09-25T00:00:00.000Z',
    });
    const derived = applyBoundedMutation(clean.envelope, { dimension: 'k', value: clean.envelope.baseline.k * 1.1 });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    const forged = JSON.parse(JSON.stringify(derived.envelope));
    forged.mutations[0].applied = 99;
    await expect(storeEnvelope(db.asDb(), forged, OWNER.user_id)).rejects.toThrow(/does not match the recomputed/);
  });
});
