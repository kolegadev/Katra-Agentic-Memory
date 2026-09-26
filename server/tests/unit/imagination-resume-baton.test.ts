/**
 * ITER-11, WS-1 (DoD #5) — the controller-side BATON-AWARE RESUME.
 *
 * Contract: `CONTRACT-iter11-dod-closure.md` §WS-1 item 1: when a mission holds
 * an active promoted Creative Baton whose version is still current,
 * `buildResumeReport` carries its attention targets, a sanitised candidate
 * portfolio summary and the candidates already turned into work items; a
 * stale/revoked/tampered baton is reported BY NAME and excluded, and no private
 * content is ever included.
 *
 * Proved to fail against the pre-iteration `resume.ts`: that file never read
 * `creative_batons` at all, so `report.creative_baton` did not exist and every
 * assertion below — inclusion, the four named refusals, the prose-omission
 * count and the work-item join — failed (`TypeError`/`undefined`) rather than
 * passing.
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
  seedScenario,
} from '../helpers/imagination-scenario.js';
import { buildResumeReport } from '../../src/services/mission-cognition/resume.js';
import { runImaginationCycle } from '../../src/services/processing/imagination-cycle-service.js';
import { CREATIVE_BATON_COLLECTIONS } from '../../src/services/processing/creative-baton-collections.js';
import {
  batonCandidatesToWorkItems,
  recordCandidateOutcome,
} from '../../src/services/processing/imagination-outcome-service.js';
import { COLLECTIONS } from '../../src/services/mission-cognition/collections.js';
import type { CallerIdentity } from '../../src/utils/caller-identity.js';

const OWNER: CallerIdentity = { user_id: OPERATOR_USER, trusted: false };
const OPERATOR: CallerIdentity = { user_id: 'operator', trusted: true };

let db: FakeDb;
const spies: Array<{ mockRestore: () => void }> = [];

const batons = () => db.collection(CREATIVE_BATON_COLLECTIONS.creativeBatons).docs as Array<Record<string, any>>;

beforeEach(() => {
  db = new FakeDb();
  holder.db = db;
  process.env.FOCUSED_IMAGINATION = '1';
  process.env.CREATIVE_BATON_PROMOTION = '1';
  const spy = vi.spyOn(llmService, 'extractJson').mockImplementation((async (system: string, prompt: string) =>
    defaultResponder(system, prompt)) as never);
  spies.push(spy);
  spies.push(
    vi.spyOn(llmService, 'getServiceStatus').mockReturnValue({
      available: true,
      provider: 'stub',
      model: 'test-model',
      providers: ['stub(ready)'],
    } as never),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  delete process.env.FOCUSED_IMAGINATION;
  delete process.env.CREATIVE_BATON_PROMOTION;
});

/** A mission with no baton: the resume report must say so, not omit the field. */
async function seedMissionOnly(): Promise<void> {
  await seedScenario(db);
}

/** The full documented path: one cycle on a stalled mission, then promotion. */
async function seedPromotedBaton(): Promise<Record<string, any>> {
  await seedScenario(db);
  const cycle = await runImaginationCycle(db.asDb(), {
    userId: OPERATOR_USER,
    missionId: SCENARIO_MISSION,
    actorId: OPERATOR_USER,
    caller: OPERATOR,
  });
  expect(cycle.status).toBe('ran');
  const baton = batons()[0];
  expect(baton.shared_id).toBeTruthy();
  return baton;
}

describe('resume — the baton-aware section (ITER-11 WS-1)', () => {
  it('reports an ABSENT baton by name and leaves the rest of the reconstruction intact', async () => {
    await seedMissionOnly();
    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);

    expect(report.creative_baton.status).toBe('absent');
    expect(report.creative_baton.code).toBe('no_baton');
    expect(report.creative_baton.reason).toContain('holds no creative baton');
    expect(report.creative_baton.baton_id).toBeNull();
    expect(report.creative_baton.privacy.raw_reflections_included).toBe(false);

    // The pre-existing reconstruction is untouched by the new section.
    expect(report.mission.mission_id).toBe(SCENARIO_MISSION);
    expect(report.next_action.kind).toBe('objective');
    expect(report.reconstruction_source.join(' | ')).toContain('creative_batons');
    expect(report.reconstruction_source.join(' | ')).toContain('NO conversation history');
  });

  it('includes the active promoted baton: targets, sanitised portfolio and queued work items', async () => {
    const baton = await seedPromotedBaton();

    // The controller adapter turns the baton's candidates into work items
    // through the existing funnel (provenance = baton + seed).
    const adapted = await batonCandidatesToWorkItems(db.asDb(), {
      userId: OPERATOR_USER,
      batonId: baton.baton_id,
      caller: OWNER,
    });
    expect(adapted.created).toBeGreaterThan(0);

    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);
    const section = report.creative_baton;
    expect(section.status).toBe('included');
    expect(section.baton_id).toBe(baton.baton_id);
    expect(section.creative_baton_version).toBe('1.0');
    expect(section.promoted).toBe(true);
    expect(section.cycle_id).toBe(baton.cycle_id);

    // (a) attention targets — cue + why, from the baton's own allow-list.
    expect(section.attention_targets.length).toBeGreaterThan(0);
    for (const target of section.attention_targets) {
      expect(target.cue.length).toBeGreaterThan(0);
      expect(target.why_operationally_relevant.length).toBeGreaterThan(0);
    }
    expect(section.attention_targets.map((target) => target.cue)).toEqual(
      baton.attention_targets.map((target: any) => target.cue),
    );

    // (b) the portfolio summary is SANITISED: operational fields only, and the
    //     prose fields are counted as omitted rather than copied.
    expect(section.candidate_portfolio).toHaveLength(baton.candidate_portfolio.length);
    const serialized = JSON.stringify(section);
    for (const candidate of baton.candidate_portfolio as Array<Record<string, any>>) {
      expect(serialized).not.toContain(String(candidate.hypothesis).slice(0, 40));
      expect(serialized).not.toContain(String(candidate.mechanism).slice(0, 40));
    }
    const first = section.candidate_portfolio[0];
    expect(first.seed_id).toBe(baton.candidate_portfolio[0].seed_id);
    expect(first.descriptor_bins).toEqual(baton.candidate_portfolio[0].descriptor_bins);
    expect(first.cheapest_test).toBe(baton.candidate_portfolio[0].cheapest_test);
    expect(first.lineage_ref).toBe(baton.candidate_portfolio[0].lineage_ref);
    expect(first.prose_omitted).toBe(2);
    expect(section.counts.prose_fields_omitted).toBeGreaterThan(0);
    expect(Object.keys(first).sort()).toEqual(
      [
        'cheapest_test',
        'coherence_score',
        'descriptor_bins',
        'expected_information_gain',
        'lineage_ref',
        'novelty_score',
        'prose_omitted',
        'quality',
        'seed_id',
        'work_item_ids',
      ].sort(),
    );

    // (c) the candidates that already became work items, joined by provenance.
    expect(section.work_items.length).toBe(adapted.created);
    expect(section.counts.candidates_with_work_item).toBe(adapted.created);
    const queued = db
      .collection(COLLECTIONS.cognitiveWorkItems)
      .docs.filter((row: any) => row.provenance?.source === 'creative_baton');
    expect(queued.length).toBe(adapted.created);
    for (const item of section.work_items) {
      expect(queued.some((row: any) => row.work_item_id === item.work_item_id)).toBe(true);
      expect(item.source).toBe('creative_baton');
      expect(item.status).toBe('queued');
      // Each work item is joined back to ITS OWN candidate, by seed id.
      const owner = section.candidate_portfolio.find((row) => row.seed_id === item.seed_id);
      expect(owner).toBeTruthy();
      expect(owner!.work_item_ids).toContain(item.work_item_id);
    }
  });

  it('resumes ACROSS A RESTART: a fresh module graph reads the same baton section', async () => {
    const baton = await seedPromotedBaton();
    vi.resetModules();
    const freshResume = await import('../../src/services/mission-cognition/resume.js');
    const report = await freshResume.buildResumeReport(db.asDb(), SCENARIO_MISSION);
    expect(report.creative_baton.status).toBe('included');
    expect(report.creative_baton.baton_id).toBe(baton.baton_id);
    expect(report.creative_baton.counts.superseded_batons).toBe(0);
  });

  it('REFUSES a not-yet-promoted (private) baton by name', async () => {
    await seedScenario(db);
    // A cycle WITHOUT the promotion flag: the baton is compiled privately.
    delete process.env.CREATIVE_BATON_PROMOTION;
    const cycle = await runImaginationCycle(db.asDb(), {
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      actorId: OPERATOR_USER,
      caller: OPERATOR,
    });
    expect(cycle.status).toBe('ran');
    expect(batons()[0].shared_id).toBeFalsy();

    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);
    expect(report.creative_baton.status).toBe('refused');
    expect(report.creative_baton.code).toBe('not_promoted');
    expect(report.creative_baton.reason).toContain('never promoted');
    expect(report.creative_baton.candidate_portfolio).toEqual([]);
    expect(report.creative_baton.baton_id).toBe(batons()[0].baton_id);
  });

  it('REFUSES a STALE baton by name (creative_baton_version is not current)', async () => {
    await seedPromotedBaton();
    batons()[0].creative_baton_version = '0.9';
    // The stored row is also deliberately left un-hashed for the new version:
    // the version check must fire FIRST and name staleness, not integrity.
    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);
    expect(report.creative_baton.status).toBe('refused');
    expect(report.creative_baton.code).toBe('stale_version');
    expect(report.creative_baton.reason).toContain('is not the current 1.0');
    expect(report.creative_baton.attention_targets).toEqual([]);
  });

  it('REFUSES a TAMPERED baton by name (payload hash no longer matches)', async () => {
    const baton = await seedPromotedBaton();
    batons()[0].candidate_portfolio[0].expected_information_gain = 0.99;
    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);
    expect(report.creative_baton.status).toBe('refused');
    expect(report.creative_baton.code).toBe('tampered');
    expect(report.creative_baton.reason).toContain('payload_hash_mismatch');
    expect(report.creative_baton.baton_id).toBe(baton.baton_id);
    expect(report.creative_baton.candidate_portfolio).toEqual([]);
  });

  it('REFUSES an INVALID (schema-broken) baton by name', async () => {
    await seedPromotedBaton();
    // A half of the row that the closed schema refuses: the compiler never wrote
    // this key, so the packet is not the one it compiled (hash or no hash).
    batons()[0].attention_targets = [];
    batons()[0].candidate_portfolio = [];
    delete batons()[0].stop_reason;
    delete batons()[0].payload_hash;
    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);
    expect(report.creative_baton.status).toBe('refused');
    expect(['invalid', 'tampered']).toContain(report.creative_baton.code);
    expect(report.creative_baton.reason.length).toBeGreaterThan(0);
    expect(report.creative_baton.attention_targets).toEqual([]);
  });

  it('REFUSES a REVOKED baton by name (the mission is terminal)', async () => {
    await seedPromotedBaton();
    const mission = db.collection(COLLECTIONS.missionStates).docs[0] as Record<string, any>;
    mission.status = 'cancelled';
    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);
    expect(report.creative_baton.status).toBe('refused');
    expect(report.creative_baton.code).toBe('revoked');
    expect(report.creative_baton.reason).toContain('cancelled');
    expect(report.creative_baton.candidate_portfolio).toEqual([]);
  });

  it('REFUSES a FOREIGN private baton by name (another identity, never promoted)', async () => {
    await seedMissionOnly();
    const { compileCreativeBaton } = await import('../../src/services/processing/creative-baton-compiler.js');
    const { IdeaArchiveService } = await import('../../src/services/processing/idea-archive-service.js');
    const { candidateSeed } = await import('../helpers/imagination-scenario.js');
    const archive = new IdeaArchiveService(db.asDb());
    await archive.admitOrReplace(candidateSeed(0, { mission_id: SCENARIO_MISSION, user_id: OTHER_USER }));
    const seeds = await archive.getSeeds(OTHER_USER, SCENARIO_MISSION);
    const coverage = await archive.coverage(SCENARIO_MISSION, OTHER_USER);
    const foreign = compileCreativeBaton({
      userId: OTHER_USER,
      missionId: SCENARIO_MISSION,
      cycleId: 'cycle_foreign',
      trace: {
        trace_id: 'trace_foreign',
        mission_version: 3,
        problem_state_digest: 'digest_foreign',
        signals: [{ kind: 'tension', intensity: 0.8, confidence: 0.7, valence: 0 }],
      },
      seeds,
      exclusions: [],
      coverage,
      trigger: { type: 'plateau', evidence: ['below_minimum_active_candidates'] },
    });
    db.collection(CREATIVE_BATON_COLLECTIONS.creativeBatons).docs.push({ ...foreign });

    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);
    expect(report.creative_baton.status).toBe('refused');
    expect(report.creative_baton.code).toBe('foreign_identity');
    // The foreign row's own text is NOT quoted back in the refusal reason.
    expect(report.creative_baton.reason).not.toContain('cursor');
    expect(report.creative_baton.candidate_portfolio).toEqual([]);
  });

  it('carries no private content from any private store, and no baton prose', async () => {
    const baton = await seedPromotedBaton();
    await recordCandidateOutcome(db.asDb(), {
      userId: OPERATOR_USER,
      seedId: String(baton.candidate_portfolio[0].seed_id),
      batonId: baton.baton_id,
      outcome: 'useful_information',
      detail: 'separated the two readings',
    });

    // Plant a marker in every private store the engine owns, then resume.
    const markers: string[] = [];
    for (const store of ['reflective_journals', 'reflection_nodes', 'salience_traces', 'idea_seeds', 'focused_consolidation_runs']) {
      const marker = `XPRIVATEX${store.toUpperCase()}XENDX`;
      markers.push(marker);
      db.collection(store).docs.push({ user_id: OPERATOR_USER, text: marker, narrative: marker });
    }
    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);
    const serialized = JSON.stringify(report);
    for (const marker of markers) expect(serialized).not.toContain(marker);
    for (const candidate of baton.candidate_portfolio as Array<Record<string, any>>) {
      expect(serialized).not.toContain(String(candidate.hypothesis).slice(0, 40));
      expect(serialized).not.toContain(String(candidate.mechanism).slice(0, 40));
    }
    expect(report.creative_baton.privacy.raw_reflections_included).toBe(false);
    expect(report.creative_baton.privacy.private_text_included).toBe(false);
    // Non-vacuity: the baton's own ids DO reach the report (the scan above is
    // not passing because nothing was read).
    expect(serialized).toContain(baton.baton_id);
    expect(serialized).toContain(String(baton.candidate_portfolio[0].seed_id));
  });

  it('refuses the SECOND-newest row and counts it as superseded when a newer one exists', async () => {
    const promoted = await seedPromotedBaton();
    // A NEWER, genuinely compiled but un-promoted baton for the same mission:
    // the resume must read the newest row (and refuse it by name) rather than
    // fall back to the older promoted one silently.
    const { compileCreativeBaton } = await import('../../src/services/processing/creative-baton-compiler.js');
    const { IdeaArchiveService } = await import('../../src/services/processing/idea-archive-service.js');
    const archive = new IdeaArchiveService(db.asDb());
    const newer = compileCreativeBaton({
      userId: OPERATOR_USER,
      missionId: SCENARIO_MISSION,
      cycleId: 'cycle_newer_unpromoted',
      trace: {
        trace_id: 'trace_newer_unpromoted',
        mission_version: 3,
        problem_state_digest: 'digest_newer_unpromoted',
        signals: [{ kind: 'tension', intensity: 0.7, confidence: 0.6, valence: -0.1 }],
      },
      seeds: await archive.getSeeds(OPERATOR_USER, SCENARIO_MISSION),
      exclusions: [],
      coverage: await archive.coverage(SCENARIO_MISSION, OPERATOR_USER),
      trigger: { type: 'plateau', evidence: ['below_minimum_active_candidates'] },
      now: () => '2027-01-01T00:00:00.000Z',
    });
    expect(newer.baton_id).not.toBe(promoted.baton_id);
    db.collection(CREATIVE_BATON_COLLECTIONS.creativeBatons).docs.push({ ...newer });

    const report = await buildResumeReport(db.asDb(), SCENARIO_MISSION);
    expect(report.creative_baton.status).toBe('refused');
    expect(report.creative_baton.code).toBe('not_promoted');
    expect(report.creative_baton.baton_id).toBe(newer.baton_id);
    expect(report.creative_baton.counts.rows_scanned).toBe(2);
    expect(report.creative_baton.counts.superseded_batons).toBe(1);
  });
});
